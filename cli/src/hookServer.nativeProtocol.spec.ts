/** Versioned ingress on private HTTP, Registry and catalog roots. Kernel identity
 * and fsync scheduling are injected; no daemon, real engine or tmux is contacted. */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nativeHookAcknowledgement } from './engines/kit/nativeHookClientProtocol.js'
import { nativeHookOutboxShard } from './engines/kit/nativeHookOutbox.js'
import type { HookServerHandlers } from './hookServer.js'
import type { NativeGenerationSource } from './core/turns/nativeGenerations.js'

const fault = vi.hoisted(() => ({ unavailable: false, afterRetain: undefined as (() => void) | undefined,
  afterFinish: undefined as (() => void) | undefined, afterGeneration: undefined as (() => void) | undefined,
  afterClaim: undefined as (() => void) | undefined, afterSourceConfirmation: undefined as (() => void) | undefined,
  limitedStages: false, journalBytes: undefined as number | undefined,
  journals: [] as Array<ReturnType<typeof import('./engines/kit/nativeHookJournal.js')['createNativeHookJournal']>>,
  pools: [] as Array<ReturnType<typeof import('./engines/kit/nativeHookStaging.js')['createNativeHookStagePool']>>,
}))
vi.mock('./engines/kit/nativeHookStaging.js', async original => {
  const actual = await original<typeof import('./engines/kit/nativeHookStaging.js')>()
  return { ...actual, createNativeHookStagePool: (options: Parameters<typeof actual.createNativeHookStagePool>[0]) => {
    const pool = actual.createNativeHookStagePool({ ...options, ...(fault.limitedStages ? { maxGenerations: 4, terminalGenerations: 3 } : {}) })
    fault.pools.push(pool); return pool
  } }
})
vi.mock('./core/turns/nativeGenerationSource.js', async original => {
  const actual = await original<typeof import('./core/turns/nativeGenerationSource.js')>()
  return { ...actual, createNativeGenerationSource: (options: Parameters<typeof actual.createNativeGenerationSource>[0]) => {
    const source = actual.createNativeGenerationSource(options)
    return { read: async () => { const result = await source.read(); fault.afterSourceConfirmation?.(); return result } }
  } }
})
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
    const journal = actual.createNativeHookJournal({ ...args[0], ...(fault.journalBytes ? { maxBytes: fault.journalBytes } : {}) })
    fault.journals.push(journal)
    return { ...journal, retain: async (...input: Parameters<typeof journal.retain>) => {
      const delivery = await journal.retain(...input); fault.afterRetain?.(); return delivery
    }, recordGeneration: async (...input: Parameters<typeof journal.recordGeneration>) => {
      await journal.recordGeneration(...input); fault.afterGeneration?.()
    }, claim: async (...input: Parameters<typeof journal.claim>) => {
      const claim = await journal.claim(...input)
      fault.afterClaim?.()
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
const nativeEvidence = JSON.stringify([5100, 1, '12345', 'fixture-engine', '/fixture/engine', null, null])
const origin = { version: 1, boot, callerPid: 5101, ancestry: [
  { pid: 5101, parentPid: 5100, birth: '12346', identityV1: digest('caller') },
  { pid: 5100, parentPid: 1, birth: '12345', identityV1: digest(nativeEvidence) },
] }
let key = `${boot}\u0000codex\u00005100\u000012345`
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
  live = true; fault.unavailable = false; fault.afterRetain = undefined; fault.afterFinish = undefined; fault.afterGeneration = undefined
  fault.afterClaim = undefined; fault.afterSourceConfirmation = undefined; fault.limitedStages = false; fault.pools = []; fault.journalBytes = undefined; fault.journals = []
  key = `${boot}\u0000codex\u00005100\u000012345`
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

function cursorBody(extra: Record<string, unknown> = {}) {
  if (registry.byAgent(agentId)?.engine !== 'cursor') {
    registry.removeAgent(agentId)
    agentId = registry.openProcessAgent({ engine: 'cursor', tmuxPane: '%1', cwd: root,
      processIdentity: { pid: 5100, startMarker: 'fixture-start', executable: '<cursor>' } })!.entry.agentId
    key = `${boot}\u0000cursor\u00005100\u000012345`
  }
  return body({ engine: 'cursor', transcriptPath: undefined, generationId: 'generation-one', hookEvent: 'stop', status: 'completed', ...extra })
}

it('retains a native Stop before binding and restores its source before releasing attach', async () => {
  const raw = JSON.stringify(cursorBody()), sources: Array<{ source: NativeGenerationSource; pending: boolean }> = []
  const held = vi.fn(), legacyStop = vi.fn(), restored = vi.fn()
  let f: Awaited<ReturnType<typeof fixture>>
  const registered = vi.fn((entry: Parameters<HookServerHandlers['onRegistered']>[0]) => {
    expect(f.started.recoveryReady(entry)).toBe(false)
  })
  f = await fixture({ onAdmissionStop: held, onTurnStop: legacyStop, onRegistered: registered,
    onNativeGenerations: (_entry, source, pending) => sources.push({ source, pending }),
    onNativeRecoveryReady: () => {
      const latest = sources.at(-1)!
      expect(latest.pending).toBe(false); expect(() => latest.source.verify()).not.toThrow()
      expect(latest.source.facts).toMatchObject([{ generationId: 'generation-one', kind: 'stopped', status: 'completed' }])
      restored()
    },
  })
  f.started.startRecovery()
  await f.settle(raw)
  await vi.waitFor(() => expect(restored).toHaveBeenCalled(), { timeout: 3_000 })
  const events = records().map(record => record.event.kind)
  expect(events.indexOf('generation')).toBeGreaterThan(events.indexOf('intake'))
  expect(events.indexOf('generation')).toBeLessThan(events.indexOf('claim'))
  expect(registered).toHaveBeenCalledOnce(); expect(legacyStop).not.toHaveBeenCalled(); expect(held).not.toHaveBeenCalled()
  expect(sources.at(-1)!.source.owner).toEqual({ agentId, sessionId, processKey: key })
  await close()
  const recovered: NativeGenerationSource[] = []
  const restart = await fixture({ onNativeGenerations: (_entry, source) => recovered.push(source) })
  restart.started.startRecovery()
  await vi.waitFor(() => expect(restart.started.recoveryReady(registry.byAgent(agentId)!)).toBe(true), { timeout: 5_000 })
  expect(recovered.at(-1)!.facts).toEqual(sources.at(-1)!.source.facts)
  expect(restart.registered).not.toHaveBeenCalled(); expect(restart.stopped).not.toHaveBeenCalled()
}, 25_000)

it('holds native generation input before effects if eager generation control is absent', async () => {
  const raw = JSON.stringify(cursorBody()), f = await fixture()
  expect(await f.post(raw)).toMatchObject({ status: 202, body: { retry: true, detail: 'Native generation control is unavailable.' } })
  expect(f.resolved).not.toHaveBeenCalled(); expect(f.registered).not.toHaveBeenCalled()
  expect(records()).toEqual([])
  expect(await f.post(raw, {}, '/api/hook/session-start')).toMatchObject({ status: 400 })
})

it('restores an empty cancellation barrier before releasing attach after restart', async () => {
  const raw = JSON.stringify(cursorBody({ generationId: undefined, hookEvent: 'sessionStart' }))
  const first = await fixture({ onNativeGenerations() {} })
  await first.settle(raw)
  const journal = fault.journals[0], before = await journal.snapshot()
  expect(before.generations.size).toBe(0)
  const request = { requestId: 'fixture-empty-cancellation', nonce: 'fixture-empty-cancel-nonce', agentId,
    conversationId: sessionId, frontier: before.frontier }
  await journal.recordCancellation(request)
  await close()
  const sources: NativeGenerationSource[] = []
  const restarted = await fixture({ onNativeGenerations: (_row, source) => { sources.push(source) } })
  restarted.started.startRecovery()
  await vi.waitFor(() => {
    expect(sources.length).toBeGreaterThan(0)
    expect(sources.at(-1)!.facts).toEqual([])
    expect(sources.at(-1)!.cancellations).toEqual([request])
    expect(restarted.started.recoveryReady(registry.byAgent(agentId)!)).toBe(true)
  }, { timeout: 5000 })
  expect(restarted.registered).not.toHaveBeenCalled()
  expect(restarted.stopped).not.toHaveBeenCalled()
}, 20_000)

it('reads fresh native authority without replaying notifications or changing readiness', async () => {
  const raw = JSON.stringify(cursorBody()), observed = vi.fn(), recovered = vi.fn()
  let revision = 1
  const reader = vi.fn(async () => {
    const captured = revision
    return { key, evidence: nativeEvidence, verify() { if (captured !== revision) throw Error('fixture old proof expired') } }
  })
  const f = await fixture({ onNativeGenerations: observed, onNativeRecoveryReady: recovered, readNativeHookOwner: reader })
  await f.settle(raw)
  await vi.waitFor(() => expect(observed.mock.calls.some(call => !call[2])).toBe(true))
  f.started.startRecovery()
  const before: NativeGenerationSource = observed.mock.calls.at(-1)![1]
  expect(f.started.recoveryReady(registry.byAgent(agentId)!)).toBe(true)
  observed.mockClear(); recovered.mockClear(); reader.mockClear()
  revision++
  expect(() => before.verify()).toThrow('old proof expired')
  const owner = { ...before.owner }, reading = f.started.readNativeGenerations(owner)
  owner.sessionId = 'caller changed after starting the read'
  await expect(reading).resolves.toMatchObject({ owner: before.owner, facts: before.facts })
  const fresh = await reading
  expect(fresh.owner).toEqual(before.owner)
  expect(fresh.facts).toEqual(before.facts)
  expect(() => fresh.verify()).not.toThrow()
  expect(reader).toHaveBeenCalledTimes(2)
  expect(observed).not.toHaveBeenCalled(); expect(recovered).not.toHaveBeenCalled()
  expect(f.started.recoveryReady(registry.byAgent(agentId)!)).toBe(true)
}, 20_000)

it.each(['unconfirmed', 'pending', 'process changed', 'binding changed'] as const)(
  'withholds fresh generation authority while %s', async problem => {
    const raw = JSON.stringify(cursorBody()), observed = vi.fn()
    const f = await fixture({ onNativeGenerations: observed })
    await f.settle(raw)
    await vi.waitFor(() => expect(observed.mock.calls.some(call => !call[2])).toBe(true))
    const owner = { agentId, sessionId, processKey: key }
    if (problem === 'unconfirmed') fault.unavailable = true
    else if (problem === 'pending') {
      fault.afterGeneration = () => { fault.unavailable = true }
      await f.post(JSON.stringify(cursorBody({ hookEvent: 'preToolUse', generationId: 'generation-two' })),
        { 'x-harness-hook-delivery-id': 'fixture-pending-generation-02' })
      fault.afterGeneration = undefined; fault.unavailable = false
    } else if (problem === 'process changed') fault.afterSourceConfirmation = () => { live = false }
    else fault.afterSourceConfirmation = () => { registry.byAgent(agentId)!.sessionId = 'rebound-conversation' }
    observed.mockClear()
    const result = await f.started.readNativeGenerations(owner).then(source => ({ source, error: undefined }), error => ({ source: undefined, error }))
    expect(result.source).toBeUndefined()
    expect(String(result.error)).toContain(problem === 'unconfirmed' ? 'confirmation unavailable'
      : problem === 'pending' ? 'admission is still pending' : problem === 'process changed' ? 'original engine unavailable' : 'binding changed')
    expect(observed).not.toHaveBeenCalled()
  }, 20_000,
)

it('does not allocate or notify for a foreign generation read and revokes returned authority on close', async () => {
  const raw = JSON.stringify(cursorBody()), observed = vi.fn(), f = await fixture({ onNativeGenerations: observed })
  await f.settle(raw)
  const owner = { agentId, sessionId, processKey: key }, count = records().length
  for (const changed of [{ agentId: 'foreign-agent' }, { sessionId: 'foreign-session' }, { processKey: 'foreign-process' }]) {
    await expect(f.started.readNativeGenerations({ ...owner, ...changed })).rejects.toThrow('native generation')
  }
  expect(records()).toHaveLength(count)
  const source = await f.started.readNativeGenerations(owner)
  await close()
  expect(() => source.verify()).toThrow()
  await expect(f.started.readNativeGenerations(owner)).rejects.toThrow('binding is unavailable')
}, 15_000)

it('retains the exact native response with its generation while legacy response fields are refused', async () => {
  const responseText = 'First line\nSecond line é📘'
  const raw = JSON.stringify(cursorBody({ hookEvent: 'afterAgentResponse', responseText }))
  const observed = vi.fn(), f = await fixture({ onNativeGenerations: observed })
  await f.settle(raw)
  expect(records().find(record => record.event.kind === 'intake').event.intake.payload)
    .toMatchObject({ generationId: 'generation-one', responseText })
  expect(records().find(record => record.event.kind === 'generation').event.fact.kind).toBe('activity')
  expect(await f.post(raw, {}, '/api/hook/session-start')).toMatchObject({ status: 400 })
  expect(await f.post(JSON.stringify(cursorBody({ hookEvent: 'afterAgentResponse', responseText: 'é'.repeat(65537) })))).toMatchObject({ status: 400 })
}, 15000)

it('keeps an interrupted generation write pending and reconstructs it from its original intake', async () => {
  const raw = JSON.stringify(cursorBody()), observed = vi.fn(), f = await fixture({ onNativeGenerations: observed })
  fault.afterRetain = () => { fault.unavailable = true }
  expect(await f.post(raw)).toMatchObject({ status: 202, body: { retry: true } })
  expect(f.registered).not.toHaveBeenCalled(); expect(observed).not.toHaveBeenCalled()
  expect(records().some(record => record.event.kind === 'intake')).toBe(true)
  fault.unavailable = false; fault.afterRetain = undefined
  await close()
  const restarted = await fixture({ onNativeGenerations: observed })
  restarted.started.startRecovery()
  await restarted.settle(raw)
  expect(records().filter(record => record.event.kind === 'generation')).toHaveLength(1)
  await vi.waitFor(() => expect(observed).toHaveBeenCalled(), { timeout: 5_000 })
  expect(restarted.registered).toHaveBeenCalledOnce()
}, 25_000)

it('preserves an interrupted Stop intake when later activity makes its generation running', async () => {
  const raw = JSON.stringify(cursorBody()), sources: NativeGenerationSource[] = []
  // The direct terminal path requires an already-bound original conversation.
  // An unbound fixture would bypass that path even if its retry guard vanished.
  registry.register({ engine: 'cursor', sessionId, tmuxPane: '%1', cwd: root })
  expect(registry.bySession(sessionId)?.agentId).toBe(agentId)
  const f = await fixture({ onNativeGenerations: (_entry, source, pending) => { if (!pending) sources.push(source) } })
  fault.afterRetain = () => { fault.unavailable = true }
  expect(await f.post(raw)).toMatchObject({ status: 202, body: { retry: true } })
  fault.unavailable = false; fault.afterRetain = undefined
  const activity = JSON.stringify(cursorBody({ hookEvent: 'preToolUse' })), activityId = 'fixture-later-activity'
  expect(await f.post(activity, { 'x-harness-hook-delivery-id': activityId })).toMatchObject({ status: 200, body: { outcome: 'owned' } })
  await vi.waitFor(() => expect(records().filter(record => record.event.kind === 'generation'))
    .toMatchObject([{ event: { fact: { kind: 'activity' } } }]), { timeout: 5_000 })
  expect(f.registered).not.toHaveBeenCalled()
  expect(records().filter(record => record.event.kind === 'claim')).toHaveLength(0)
  await f.settle(raw)
  await vi.waitFor(async () => expect((await f.post(activity, { 'x-harness-hook-delivery-id': activityId })).body.outcome)
    .toBe('complete'), { timeout: 8_000 })
  const stopped = records().find(record => record.event.kind === 'generation' && record.event.fact.kind === 'stopped').event.fact
  expect(stopped.source.identityV1).toBeUndefined()
  expect(records().filter(record => record.event.kind === 'intake')).toHaveLength(2)
  expect(records().filter(record => record.event.kind === 'result')).toHaveLength(2)
  expect(records().filter(record => record.event.kind === 'claim')).toHaveLength(2)
  expect(f.registered).toHaveBeenCalledTimes(2)
  await vi.waitFor(() => expect(sources.at(-1)!.facts.map(fact => fact.kind).sort()).toEqual(['activity', 'stopped']), { timeout: 5_000 })
  expect(f.stopped).not.toHaveBeenCalled()
}, 30_000)

it('holds completed receipts with ordinary and direct evidence in different original namespaces', async () => {
  const raw = JSON.stringify(cursorBody()), f = await fixture({ onNativeGenerations() {} })
  await f.settle(raw); await close()
  const { openNativeHookStorage } = await import('./engines/kit/nativeHookStorage.js')
  const { nativeHookGeneration } = await import('./engines/kit/nativeHookGeneration.js')
  const { nativeHookWireIdentity } = await import('./engines/kit/nativeHookClientProtocol.js')
  const store = await openNativeHookStorage(directory(), { prepare() { throw Error('fixture must not prepare a host binary') }, invalidate() {} })
  try {
    const candidate = origin.ancestry[0]
    const journal = await store.effects(`${boot}\u0000cursor\u0000${candidate.pid}\u0000${candidate.birth}`)
    await journal.recordGeneration(nativeHookGeneration({ ...delivery, agentId, conversationId: sessionId,
      wire: nativeHookWireIdentity('/api/hook/session-start', raw), payload: cursorBody() }, candidate.identityV1)!)
  } finally { await store.close() }
  const restart = await fixture()
  expect(await restart.post(raw)).toMatchObject({ status: 202, body: { retry: true, detail: expect.stringContaining('ambiguous original namespaces') } })
  expect(restart.resolved).not.toHaveBeenCalled(); expect(restart.registered).not.toHaveBeenCalled()
}, 20_000)

it('revokes the restored source when its conversation or complete frontier changes', async () => {
  const raw = JSON.stringify(cursorBody()), sources: NativeGenerationSource[] = []
  const f = await fixture({ onNativeGenerations: (_entry, source, pending) => { if (!pending) sources.push(source) } })
  await f.settle(raw)
  const original = sources.at(-1)!
  expect(() => original.verify()).not.toThrow()
  // A new native activity observation invalidates even a previously completed
  // generation's view; existence of its old leaf is not a complete frontier.
  const other = JSON.stringify(cursorBody({ hookEvent: 'preToolUse', generationId: 'generation-two' }))
  await f.post(other, { 'x-harness-hook-delivery-id': 'fixture-generation-successor' })
  expect(() => original.verify()).toThrow()
  await vi.waitFor(() => expect(sources.at(-1)!.facts).toHaveLength(2), { timeout: 5_000 })
  const latest = sources.at(-1)!
  registry.byAgent(agentId)!.sessionId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
  expect(() => latest.verify()).toThrow('binding changed')
}, 20_000)

it('rechecks the original native process proof at the generation effect boundary', async () => {
  const raw = JSON.stringify(cursorBody()), sources: NativeGenerationSource[] = []
  const f = await fixture({ onNativeGenerations: (_entry, source, pending) => { if (!pending) sources.push(source) } })
  await f.settle(raw)
  await vi.waitFor(() => expect(sources.length).toBeGreaterThan(0), { timeout: 5_000 })
  const source = sources.at(-1)!
  expect(() => source.verify()).not.toThrow()
  live = false
  expect(() => source.verify()).toThrow('fixture process exited')
}, 15_000)

it('holds a native observation that lost its original retained registration', async () => {
  const raw = JSON.stringify(cursorBody()), f = await fixture({ onNativeGenerations() {} })
  await f.settle(raw); await close()
  const { openNativeHookStorage } = await import('./engines/kit/nativeHookStorage.js')
  const { nativeHookGeneration } = await import('./engines/kit/nativeHookGeneration.js')
  const { nativeHookWireIdentity } = await import('./engines/kit/nativeHookClientProtocol.js')
  const store = await openNativeHookStorage(directory(), { prepare() { throw Error('fixture must not prepare a host binary') }, invalidate() {} })
  try {
    const journal = await store.effects(key)
    await journal.recordGeneration(nativeHookGeneration({ id: 'fixture-orphan-observation', firedAt: 2_000, agentId,
      conversationId: sessionId, wire: nativeHookWireIdentity('/api/hook/session-start', raw), payload: cursorBody() })!)
  } finally { await store.close() }
  const held = vi.fn(), restored = vi.fn(), restart = await fixture({ onNativeGenerations: restored, onAdmissionHeld: held })
  restart.started.startRecovery()
  await vi.waitFor(() => expect(held.mock.calls.some(call => String(call[1]).includes('original registration evidence'))).toBe(true), { timeout: 5_000 })
  expect(restart.started.recoveryReady(registry.byAgent(agentId)!)).toBe(false)
  expect(restored).not.toHaveBeenCalled(); expect(restart.registered).not.toHaveBeenCalled()
}, 20_000)

it('keeps a recovered generation barrier held when the core source consumer fails', async () => {
  const raw = JSON.stringify(cursorBody()), held = vi.fn(), f = await fixture({ onNativeGenerations() { throw Error('fixture control unavailable') }, onAdmissionHeld: held })
  await f.post(raw)
  await vi.waitFor(() => expect(records().some(record => record.event.kind === 'result')).toBe(true), { timeout: 5_000 })
  expect(f.started.recoveryReady(registry.byAgent(agentId)!)).toBe(false)
  await vi.waitFor(() => expect(held.mock.calls.some(call => String(call[1]).includes('fixture control unavailable'))).toBe(true), { timeout: 5_000 })
}, 20_000)

it.each(['before claim', 'after claim'])('holds binding when both generation copies disappear %s', async point => {
  const raw = JSON.stringify(cursorBody()), held = vi.fn(), f = await fixture({ onNativeGenerations() {}, onAdmissionHeld: held })
  const remove = vi.fn(() => {
    for (const name of readdirSync(directory()).filter(name => /^\.native-hook-effects-\d{3}\.history$/.test(name))) {
      const history = join(directory(), name)
      for (const file of readdirSync(history)) {
        if (JSON.parse(readFileSync(join(history, file), 'utf8')).event.kind !== 'generation') continue
        unlinkSync(join(history, file)); unlinkSync(join(history + '.witnesses', file))
      }
    }
  })
  if (point === 'before claim') fault.afterGeneration = remove
  else fault.afterClaim = remove
  const response = await f.post(raw)
  expect(response.body.outcome).not.toBe('complete')
  await vi.waitFor(() => expect(held.mock.calls.some(call => typeof call[1] === 'string')).toBe(true), { timeout: 5_000 })
  expect(remove).toHaveBeenCalledOnce()
  expect(f.registered).not.toHaveBeenCalled()
  expect(registry.byAgent(agentId)!.sessionId).not.toBe(sessionId)
  expect(records().filter(record => record.event.kind === 'claim')).toHaveLength(point === 'before claim' ? 0 : 1)
  expect(records().filter(record => record.event.kind === 'result')).toHaveLength(0)
}, 20_000)

it('reprobes native birth after source confirmation before publishing generation control', async () => {
  const raw = JSON.stringify(cursorBody()), observed = vi.fn(), held = vi.fn()
  const f = await fixture({ onNativeGenerations: observed, onAdmissionHeld: held,
    readNativeHookOwner: async () => {
      if (!live) throw Error('fixture kernel birth changed')
      // Production verify checks the budget; it cannot observe a kernel change.
      return { key, evidence: nativeEvidence, verify() {} }
    },
  })
  fault.afterSourceConfirmation = () => { live = false }
  await f.post(raw)
  await vi.waitFor(() => expect(held.mock.calls.some(call => String(call[1]).includes('fixture kernel birth changed'))).toBe(true), { timeout: 5_000 })
  expect(observed).not.toHaveBeenCalled()
  expect(f.started.recoveryReady(registry.byAgent(agentId)!)).toBe(false)
}, 15_000)

it.each(['normal staging', 'journal bytes'])('owns a matching native Stop at %s exhaustion without a new registration obligation', async capacity => {
  fault.limitedStages = capacity === 'normal staging'
  fault.journalBytes = capacity === 'journal bytes' ? 135_000 : undefined
  const raw = JSON.stringify(cursorBody({ hookEvent: 'preToolUse' })), sources: NativeGenerationSource[] = []
  const f = await fixture({ onNativeGenerations: (_entry, source, pending) => { if (!pending) sources.push(source) } })
  await f.settle(raw)
  await vi.waitFor(() => expect(sources.length).toBeGreaterThan(0), { timeout: 5_000 })
  let full = false
  if (capacity === 'normal staging') {
    const pool = fault.pools[0]
    for (let index = 0; index < 8; index++) {
      try { await (await pool.acquire()).close() } catch (error) {
        expect(String(error)).toContain('generation capacity'); full = true; break
      }
    }
  } else {
    for (let index = 0; index < 8 && !full; index++) {
      const metadata = JSON.stringify(cursorBody({ generationId: undefined, hookEvent: 'beforeSubmitPrompt', title: `metadata ${index}` }))
      const id = `fixture-capacity-metadata-${index}`
      await vi.waitFor(async () => {
        const reply = await f.post(metadata, { 'x-harness-hook-delivery-id': id })
        full = reply.status === 202 && String(reply.body.detail).includes('capacity')
        expect(full || reply.body.outcome === 'complete').toBe(true)
      }, { timeout: 8_000, interval: 100 })
    }
  }
  expect(full).toBe(true)
  // Closing the running generation releases its reservation, so check that an
  // unrelated Stop cannot spend it while it is still owed to this generation.
  const unstarted = JSON.stringify(cursorBody({ generationId: 'never-started' }))
  expect(await f.post(unstarted, { 'x-harness-hook-delivery-id': 'fixture-unreserved-generation-stop' })).toMatchObject({ status: 202 })
  expect(records().filter(record => record.event.kind === 'generation')).toHaveLength(1)
  const intakesBefore = records().filter(record => record.event.kind === 'intake').length
  const registrationsBefore = f.registered.mock.calls.length
  const stop = JSON.stringify(cursorBody()), id = 'fixture-reserved-generation-stop'
  const response = await f.post(stop, { 'x-harness-hook-delivery-id': id })
  const expected = nativeHookAcknowledgement({ ...delivery, id }, { name: 'registration', path: '/api/hook/session-start', body: stop }, 'owned')
  expect(response).toEqual({ status: 200, body: expected })
  expect(records().filter(record => record.event.kind === 'intake')).toHaveLength(intakesBefore)
  expect(records().filter(record => record.event.kind === 'generation')).toHaveLength(2)
  expect(sources.at(-1)!.facts.map(fact => fact.kind)).toEqual(['activity', 'stopped'])
  expect(f.stopped).not.toHaveBeenCalled(); expect(f.registered).toHaveBeenCalledTimes(registrationsBefore)
  await close(); registry.removeAgent(agentId); live = false
  const restart = await fixture()
  expect(await restart.post(stop, { 'x-harness-hook-delivery-id': id })).toEqual({ status: 200, body: expected })
  expect(restart.resolved).not.toHaveBeenCalled(); expect(restart.registered).not.toHaveBeenCalled()
  expect(await restart.post(stop + ' ', { 'x-harness-hook-delivery-id': id })).toMatchObject({ status: 409 })
}, 45_000)
afterEach(async () => {
  fault.unavailable = false
  await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.doUnmock('./engines/kit/nativeHookStorage.js'); vi.resetModules()
  rmSync(root, { recursive: true, force: true })
})
async function fixture(overrides: Partial<HookServerHandlers> = {}, capacity = 65_536, requestedPort = 0) {
  const { startHookServer } = await import('./hookServer.js'), { readHookCredential } = await import('./lib/hookAuth.js')
  const registered = vi.fn(), stopped = vi.fn(), capture = vi.fn(async () => { throw Error('live ancestry cannot replace original origin') })
  const resolved = vi.fn(async () => live ? registry.byAgent(agentId) ?? null : null)
  const started = await startHookServer(requestedPort, { onRegistered: registered, onSessionEnd() {}, onTurnStop: stopped,
    captureNativeHookCaller: capture, resolveHookAgent: resolved,
    readNativeHookOwner: async (_row, expected) => {
      if (!live || expected && expected.key !== key) throw Error('fixture original engine unavailable')
      return { key, evidence: nativeEvidence, verify() { if (!live) throw Error('fixture process exited') } }
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

it('starts retained client replay only after readiness and recovers a held registration across core restart', async () => {
  const first = await fixture({ hookAdmissionBlocked: () => true }), raw = JSON.stringify(body())
  const { openNativeHookStorage } = await import('./engines/kit/nativeHookStorage.js')
  const helpers = { prepare: () => { throw Error('fixture cannot prepare a host binary') }, invalidate() {} }
  mkdirSync(directory(), { mode: 0o700, recursive: true })
  const client = await openNativeHookStorage(directory(), helpers), shard = nativeHookOutboxShard(delivery.id)
  try {
    await (await client.outbox(shard)).retain({ ...delivery, port: first.started.port,
      phases: [{ name: 'registration', path: '/api/hook/session-start', body: body() }] })
    expect(await first.post(raw)).toEqual({ status: 200, body: receipt(raw, 'owned') })
  } finally { await client.close() }
  const port = first.started.port
  await close()
  const transport = await import('./engines/kit/nativeHookTransport.js'), send = transport.sendNativeHookRequest
  const replies: { elapsed: number; result: unknown; budget: number | undefined }[] = [], requestedBudgets: number[] = []
  vi.spyOn(transport, 'sendNativeHookRequest').mockImplementation(async (...args) => {
    const began = performance.now(), result = await send(...args)
    replies.push({ elapsed: performance.now() - began, result, budget: args[3] }); return result
  })
  const replay = await import('./engines/kit/nativeHookReplay.js'), createReplay = replay.createNativeHookReplay
  let completed = false
  vi.spyOn(replay, 'createNativeHookReplay').mockImplementation(deps => createReplay({ ...deps, send(...args) {
    requestedBudgets.push(args[2]); return deps.send(...args)
  }, onHeld(...args) {
    deps.onHeld(...args)
    if (args[0] === shard && args[1] === delivery.id && args[2] === undefined) completed = true
  } }))
  const restarted = await fixture({}, 65_536, port), observer = await openNativeHookStorage(directory(), helpers)
  const responses: unknown[] = []
  restarted.started.server.on('request', (request, response) => {
    const began = performance.now()
    response.once('finish', () => responses.push({ event: 'finish', elapsed: performance.now() - began, status: response.statusCode }))
    response.once('close', () => responses.push({ event: 'close', elapsed: performance.now() - began, status: response.statusCode }))
  })
  try {
    const snapshot = async () => {
      const read = (await observer.readOutbox(shard))!
      try { return await read.snapshot() } finally { await read.close() }
    }
    expect((await snapshot()).deliveries.get(delivery.id)!.phases[0].acknowledged).toBe(false)
    expect(restarted.registered).not.toHaveBeenCalled()
    restarted.started.startRecovery()
    await vi.waitFor(async () => {
      // Observe real replay completion without becoming a competing disk writer.
      // Presence alone would let the final observer confirm an ACK whose writer
      // expired; completion proves the retry itself confirmed it within budget.
      expect(completed, JSON.stringify({
        registrations: restarted.registered.mock.calls.length,
        holds: vi.mocked(console.warn).mock.calls.slice(-8),
        replies, responses,
      })).toBe(true)
      expect(restarted.registered).toHaveBeenCalledOnce()
    }, { timeout: 12_000, interval: 200 })
    expect(replies.map(reply => reply.budget)).toEqual(requestedBudgets)
    expect((await snapshot()).deliveries.get(delivery.id)!.phases[0].acknowledged).toBe(true)
    expect(records().filter(record => record.event.kind === 'intake')).toHaveLength(1)
    expect(restarted.capture).not.toHaveBeenCalled()
  } finally { await observer.close() }
}, 25_000)

it('completes four productive replay shards under the original bounded attempt deadlines', async () => {
  const first = await fixture({ hookAdmissionBlocked: () => true }), raw = JSON.stringify(body())
  const { openNativeHookStorage } = await import('./engines/kit/nativeHookStorage.js')
  const helpers = { prepare: () => { throw Error('fixture cannot prepare a host binary') }, invalidate() {} }
  const deliveries = new Map<number, { id: string; firedAt: number }>()
  for (let index = 0; deliveries.size < 4; index++) {
    const id = `fixture-four-shards-${index}`, shard = nativeHookOutboxShard(id)
    if (shard < 4 && !deliveries.has(shard)) deliveries.set(shard, { id, firedAt: 1000 + index })
  }
  mkdirSync(directory(), { mode: 0o700, recursive: true })
  const client = await openNativeHookStorage(directory(), helpers)
  try {
    for (const [shard, retained] of deliveries) {
      await (await client.outbox(shard)).retain({ ...retained, port: first.started.port,
        phases: [{ name: 'registration', path: '/api/hook/session-start', body: body() }] })
      expect(await first.post(raw, { 'x-harness-hook-delivery-id': retained.id, 'x-harness-hook-fired-at': String(retained.firedAt) }))
        .toEqual({ status: 200, body: nativeHookAcknowledgement(retained, { name: 'registration', path: '/api/hook/session-start', body: raw }, 'owned') })
    }
  } finally { await client.close() }
  const port = first.started.port
  await close()
  const replay = await import('./engines/kit/nativeHookReplay.js'), createReplay = replay.createNativeHookReplay
  const completed = new Set<number>(), holds: string[] = [], stages: { shard: number; step: string; elapsedMs: number }[] = []
  vi.spyOn(replay, 'createNativeHookReplay').mockImplementation(deps => createReplay({ ...deps, onHeld(...args) {
    deps.onHeld(...args)
    // A retry may confirm an ACK whose original writer expired just after
    // publication. A freshly confirmed outbox with no pending delivery is also
    // completion; the independent snapshot below verifies every expected ID.
    if (deliveries.has(args[0]) && args[2] === undefined) completed.add(args[0])
    if (args[2]) holds.push(args[2])
  }, async readOutbox(shard, current) {
    const began = performance.now(), outbox = await deps.readOutbox(shard, current)
    if (!outbox) return outbox
    stages.push({ shard, step: 'open', elapsedMs: Math.round(performance.now() - began) })
    return { ...outbox, async snapshot() {
      const began = performance.now()
      try { return await outbox.snapshot() }
      finally { stages.push({ shard, step: 'snapshot', elapsedMs: Math.round(performance.now() - began) }) }
    }, async acknowledge(...args) {
      const began = performance.now()
      try { return await outbox.acknowledge(...args) }
      finally { stages.push({ shard, step: 'acknowledge', elapsedMs: Math.round(performance.now() - began) }) }
    } }
  } }))
  const restarted = await fixture({}, 65_536, port)
  const began = performance.now(), cpu = process.cpuUsage(), rss = process.memoryUsage().rss
  let last = began, maxLoopDelayMs = 0
  const monitor = setInterval(() => { const now = performance.now(); maxLoopDelayMs = Math.max(maxLoopDelayMs, now - last - 50); last = now }, 50)
  try {
    restarted.started.startRecovery()
    await vi.waitFor(() => expect(completed.size, JSON.stringify({ completed: completed.size, holds: holds.slice(-12), stages })).toBe(4),
      { timeout: 35_000, interval: 100 })
    expect(restarted.registered).toHaveBeenCalledTimes(4)
  } finally {
    clearInterval(monitor)
    const usage = process.cpuUsage(cpu)
    console.info('[native replay workload]', JSON.stringify({ shards: 4, completed: completed.size,
      elapsedMs: Math.round(performance.now() - began), maxLoopDelayMs: Math.round(maxLoopDelayMs),
      userCpuMs: Math.round(usage.user / 1000), systemCpuMs: Math.round(usage.system / 1000),
      rssDeltaBytes: process.memoryUsage().rss - rss, holds: holds.length, stages }))
  }
  const observer = await openNativeHookStorage(directory(), helpers)
  try {
    for (const [shard, retained] of deliveries) {
      const read = (await observer.readOutbox(shard))!
      try { expect((await read.snapshot()).deliveries.get(retained.id)!.phases[0].acknowledged).toBe(true) }
      finally { await read.close() }
    }
  } finally { await observer.close() }
  expect(records().filter(record => record.event.kind === 'intake')).toHaveLength(4)
}, 65_000)

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
