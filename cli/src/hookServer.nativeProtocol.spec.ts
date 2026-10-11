/** Versioned ingress on private HTTP, Registry and catalog roots. Kernel identity
 * and fsync scheduling are injected; no daemon, real engine or tmux is contacted. */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nativeHookAcknowledgement } from './engines/kit/nativeHookClientProtocol.js'
import type { HookServerHandlers } from './hookServer.js'

const fault = vi.hoisted(() => ({ unavailable: false, afterRetain: undefined as (() => void) | undefined,
  afterFinish: undefined as (() => void) | undefined }))
vi.mock('node:fs', async original => ({ ...await original<object>(),
  fsync: (_fd: number, done: (error: Error | null) => void) => queueMicrotask(() => done(fault.unavailable ? Error('fixture confirmation unavailable') : null)),
}))
vi.mock('./engines/kit/nativeHookWriter.js', async original => ({ ...await original<object>(),
  nativeHookWriterDead: async () => false,
  captureNativeHookWriter: async (root: string) => (await import('./testing/nativeHookWriterFixture.js')).fixtureNativeHookWriter(root),
}))
vi.mock('./engines/kit/nativeHookJournal.js', async original => {
  const actual = await original<typeof import('./engines/kit/nativeHookJournal.js')>()
  return { ...actual, createNativeHookJournal: (...args: Parameters<typeof actual.createNativeHookJournal>) => {
    const journal = actual.createNativeHookJournal(...args)
    return { ...journal, retain: async (...input: Parameters<typeof journal.retain>) => {
      const delivery = await journal.retain(...input); fault.afterRetain?.(); return delivery
    }, claim: async (...input: Parameters<typeof journal.claim>) => {
      const claim = await journal.claim(...input)
      return { ...claim, finish: async (...result: Parameters<typeof claim.finish>) => { await claim.finish(...result); fault.afterFinish?.() } }
    } }
  } }
})
vi.mock('./lib/bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./lib/processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))
const sessionId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', boot = 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const delivery = { id: 'fixture-versioned-delivery-01', firedAt: 1_000 }
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const origin = { version: 1, boot, callerPid: 5101, ancestry: [
  { pid: 5101, parentPid: 5100, birth: '12346', identityV1: digest('caller') },
  { pid: 5100, parentPid: 1, birth: '12345', identityV1: digest('engine') },
] }
const key = `${boot}\u0000codex\u00005100\u000012345`
let root: string, agentId: string, server: Server | undefined, live: boolean
let registry: typeof import('./lib/registry.js')['registry']
const directory = () => join(root, 'data', 'native-hook-deliveries')
const records = () => readdirSync(directory()).filter(name => /^\.native-hook-effects-\d{3}\.history$/.test(name))
  .flatMap(name => readdirSync(join(directory(), name)).sort().map(file => JSON.parse(readFileSync(join(directory(), name, file), 'utf8'))))
const body = (extra: Record<string, unknown> = {}) => ({ engine: 'codex', sessionId, tmuxPane: '%1', cwd: root,
  transcriptPath: join(root, 'codex', 'sessions', `rollout-${sessionId}.jsonl`), hookEvent: 'SessionStart', callerPid: 5101,
  nativeOrigin: structuredClone(origin), ...extra })
const receipt = (raw: string, outcome: 'owned' | 'complete') => nativeHookAcknowledgement(delivery,
  { name: 'registration', path: '/api/hook/session-start', body: raw }, outcome)
async function close() {
  if (server) await new Promise<void>((done, fail) => server!.close(error => error ? fail(error) : done()))
  server = undefined
}
beforeEach(async () => {
  live = true; fault.unavailable = false; fault.afterRetain = undefined; fault.afterFinish = undefined
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-protocol-http-')))
  for (const [name, value] of Object.entries({ HOME: join(root, 'home'), ADAPTER_DATA_DIR: join(root, 'data'),
    ADAPTER_RUNTIME_DIR: join(root, 'runtime'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude') })) {
    mkdirSync(value, { recursive: true, mode: 0o700 }); vi.stubEnv(name, value)
  }
  mkdirSync(join(root, 'codex', 'sessions'), { mode: 0o700 })
  writeFileSync(body().transcriptPath, JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: root, source: 'cli' } }) + '\n')
  writeFileSync(join(root, 'data', 'engine-homes.json'), '{}')
  vi.resetModules()
  ;({ registry } = await import('./lib/registry.js'))
  agentId = registry.openProcessAgent({ engine: 'codex', tmuxPane: '%1', cwd: root,
    processIdentity: { pid: 5100, startMarker: 'fixture-start', executable: '<codex>' } })!.entry.agentId
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  fault.unavailable = false
  await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.doUnmock('./engines/kit/nativeHookStorage.js'); vi.resetModules()
  rmSync(root, { recursive: true, force: true })
})
async function fixture(overrides: Partial<HookServerHandlers> = {}, capacity = 65_536) {
  const { startHookServer } = await import('./hookServer.js'), { readHookCredential } = await import('./lib/hookAuth.js')
  const registered = vi.fn(), stopped = vi.fn(), capture = vi.fn(async () => { throw Error('live ancestry cannot replace original origin') })
  const resolved = vi.fn(async () => live ? registry.byAgent(agentId) ?? null : null)
  const started = await startHookServer(0, { onRegistered: registered, onSessionEnd() {}, onTurnStop: stopped,
    captureNativeHookCaller: capture, resolveHookAgent: resolved,
    readNativeHookOwner: async (_row, expected) => {
      if (!live || expected && expected.key !== key) throw Error('fixture original engine unavailable')
      return { key, evidence: 'fixture-precise-native-process', verify() { if (!live) throw Error('fixture process exited') } }
    }, ...overrides,
  }, { deferNativeRecovery: true, admissionReceiptCapacity: capacity })
  server = started.server
  const post = async (raw: string = JSON.stringify(body()), headers: Record<string, string | null> = {}, path = '/api/native-hook/v1/session-start') => {
    const sent: Record<string, string | null> = { 'content-type': 'application/json', 'x-harness-hook-token': readHookCredential(join(root, 'data'))!,
      'x-harness-hook-delivery-id': delivery.id, 'x-harness-hook-fired-at': String(delivery.firedAt), ...headers }
    const response = await fetch(`http://127.0.0.1:${started.port}${path}`, { method: 'POST',
      headers: Object.fromEntries(Object.entries(sent).filter((entry): entry is [string, string] => entry[1] !== null)), body: raw })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const settle = async (raw = JSON.stringify(body())) => {
    let last: Awaited<ReturnType<typeof post>> | undefined
    await vi.waitFor(async () => {
      last = await post(raw)
      expect(last).toEqual({ status: 200, body: receipt(raw, 'complete') })
    }, { timeout: 8_000, interval: 100 })
    return last!
  }
  return { post, settle, registered, stopped, resolved, capture, started }
}

it('confirms exact retained wire identity and recovers a lost completed reply after engine exit and row removal', async () => {
  const f = await fixture(), raw = JSON.stringify(body())
  await f.settle(raw)
  expect(f.registered).toHaveBeenCalledOnce(); expect(f.capture).not.toHaveBeenCalled()
  const retained = records().find(record => record.event.kind === 'intake').event.intake
  expect(retained.wire).toEqual({ version: 1, path: '/api/native-hook/v1/session-start', bodySha256: digest(raw) })
  await close(); registry.removeAgent(agentId); live = false
  const restarted = await fixture()
  expect(await restarted.post(raw)).toEqual({ status: 200, body: receipt(raw, 'complete') })
  expect(restarted.resolved).not.toHaveBeenCalled(); expect(restarted.capture).not.toHaveBeenCalled()
  expect(restarted.registered).not.toHaveBeenCalled()
  expect(await restarted.post(raw + ' ')).toMatchObject({ status: 409, body: { error: 'HOOK_DELIVERY_CONFLICT' } })
  expect(records().filter(record => record.event.kind === 'intake')).toHaveLength(1)
}, 20_000)

it('acknowledges owned pending intake at full memory capacity but rejects changed bytes before that shortcut', async () => {
  const f = await fixture({ hookAdmissionBlocked: () => true }), raw = JSON.stringify(body())
  expect(await f.post(raw)).toEqual({ status: 200, body: receipt(raw, 'owned') })
  await close()
  const full = await fixture({ hookAdmissionBlocked: () => true }, 0)
  expect(await full.post(raw)).toEqual({ status: 200, body: receipt(raw, 'owned') })
  expect(await full.post(JSON.stringify(body({ title: 'changed' })))).toMatchObject({ status: 409 })
  expect(full.registered).not.toHaveBeenCalled()
  expect(records().filter(record => record.event.kind === 'intake')).toHaveLength(1)
}, 20_000)

it('never upgrades a metadata-less legacy completion into a versioned receipt', async () => {
  const f = await fixture(), raw = JSON.stringify(body())
  await vi.waitFor(async () => expect(await f.post(raw, {}, '/api/hook/session-start')).toMatchObject({ status: 200, body: { ok: true } }), { timeout: 8_000 })
  await close(); live = false
  const restarted = await fixture()
  expect(await restarted.post(raw)).toMatchObject({ status: 409, body: { error: 'HOOK_DELIVERY_CONFLICT' } })
  expect(restarted.resolved).not.toHaveBeenCalled()
}, 20_000)

it.each(['id', 'time', 'origin', 'caller', 'metadata'])('refuses invalid %s without legacy fallback or durable intake', async invalid => {
  const f = await fixture(), input = body(), headers: Record<string, string | null> = {}
  if (invalid === 'id') headers['x-harness-hook-delivery-id'] = null
  if (invalid === 'time') headers['x-harness-hook-fired-at'] = '1e3'
  if (invalid === 'origin') delete (input as Partial<typeof input>).nativeOrigin
  if (invalid === 'caller') input.callerPid++
  if (invalid === 'metadata') Object.assign(input, { wire: { version: 1, bodySha256: digest('forged') } })
  expect(await f.post(JSON.stringify(input), headers)).toMatchObject({ status: 400 })
  expect(f.registered).not.toHaveBeenCalled(); expect(f.resolved).not.toHaveBeenCalled(); expect(f.capture).not.toHaveBeenCalled()
})

it('does not issue a receipt for an early ignored registration or unavailable disk confirmation', async () => {
  const f = await fixture()
  expect(await f.post(JSON.stringify(body({ tmuxPane: undefined })))).toMatchObject({ status: 202, body: { retry: true } })
  fault.unavailable = true
  expect(await f.post()).toMatchObject({ status: 202, body: { retry: true } })
  expect(f.registered).not.toHaveBeenCalled()
})

it('returns a conclusive receipt for a durably rejected registration, including after restart', async () => {
  const f = await fixture(), raw = JSON.stringify(body({ sessionId: undefined }))
  await f.settle(raw)
  expect(f.registered).not.toHaveBeenCalled()
  expect(records().find(record => record.event.kind === 'result').event.value).toMatchObject({ status: 400, accepted: false })
  await close(); live = false
  const restarted = await fixture()
  expect(await restarted.post(raw)).toEqual({ status: 200, body: receipt(raw, 'complete') })
}, 20_000)

it('acknowledges the first durable rejection without requiring another delivery attempt', async () => {
  vi.doMock('./engines/kit/nativeHookStorage.js', async original => ({ ...await original<object>(),
    openNativeHookStorage: (await import('./testing/nativeHookAdmissionStorageFixture.js')).fixtureNativeHookAdmissionStorage,
  }))
  const f = await fixture(), raw = JSON.stringify(body({ sessionId: undefined }))
  expect(await f.post(raw)).toEqual({ status: 200, body: receipt(raw, 'complete') })
  expect(f.registered).not.toHaveBeenCalled()
})

it('rejects a UTF-8 BOM rather than collapsing it into the plain body receipt', async () => {
  const f = await fixture()
  expect(await f.post('\ufeff' + JSON.stringify(body()))).toMatchObject({ status: 400 })
  expect(f.resolved).not.toHaveBeenCalled(); expect(f.registered).not.toHaveBeenCalled()
})

it.each(['intake', 'terminal'])('withholds an ACK when its confirmed %s disappears before the reply', async kind => {
  // Keep HTTP and the real immutable journal while making the publication point
  // deterministic and earlier than the pending-response timer. Catalog authority
  // and lost-seal lookup races are exercised above and by the catalog tests.
  vi.doMock('./engines/kit/nativeHookStorage.js', async original => ({ ...await original<object>(),
    openNativeHookStorage: (await import('./testing/nativeHookAdmissionStorageFixture.js')).fixtureNativeHookAdmissionStorage,
  }))
  const history = () => join(directory(), digest(key)), removed = vi.fn(() => {
    const names = readdirSync(history()).sort(), name = kind === 'intake' ? names[0] : names.at(-1)!
    unlinkSync(join(history(), name))
    // One surviving terminal witness can be repaired and confirmed legitimately.
    // Removing both outcome copies leaves an unconfirmed claim, never completion.
    if (kind === 'terminal') unlinkSync(join(history() + '.witnesses', name))
  })
  if (kind === 'intake') fault.afterRetain = removed
  else fault.afterFinish = removed
  const f = await fixture(kind === 'intake' ? { hookAdmissionBlocked: () => true } : {})
  expect(await f.post()).toMatchObject({ status: 202, body: { pending: false, retry: true } })
  expect(removed).toHaveBeenCalledOnce()
  expect(f.registered).toHaveBeenCalledTimes(kind === 'intake' ? 0 : 1)
})

it('refuses a legacy same-ID conflict before the full-memory retained-intake shortcut', async () => {
  const f = await fixture({ hookAdmissionBlocked: () => true }), raw = JSON.stringify(body()), path = '/api/hook/session-start'
  expect(await f.post(raw, {}, path)).toMatchObject({ status: 200, body: { pending: true } })
  await close()
  const full = await fixture({ hookAdmissionBlocked: () => true }, 0)
  expect(await full.post(JSON.stringify(body({ title: 'changed' })), {}, path))
    .toMatchObject({ status: 409, body: { error: 'HOOK_DELIVERY_CONFLICT' } })
  expect(full.registered).not.toHaveBeenCalled()
}, 20_000)

it('keeps unsupported Stop/event routes and linked registration free of effects', async () => {
  const f = await fixture()
  for (const endpoint of ['turn-stop', 'session-end', 'turn-start', 'tool-start']) {
    expect(await f.post(undefined, {}, '/api/native-hook/v1/' + endpoint)).toMatchObject({ status: 404 })
  }
  expect(await f.post(JSON.stringify(body({ engine: 'cursor', hookEvent: 'stop' })))).toMatchObject({ status: 202 })
  expect(f.resolved).not.toHaveBeenCalled(); expect(f.registered).not.toHaveBeenCalled(); expect(f.stopped).not.toHaveBeenCalled()
  expect(readdirSync(directory())).toEqual([])
})
