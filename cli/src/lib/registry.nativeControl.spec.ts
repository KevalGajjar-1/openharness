import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nativeTurnAdmitted, nativeTurnTarget, type NativeTurnIntent } from './nativeTurnIntent.js'
import { StoppedAgentStore } from './stoppedAgents.js'
import { createKeepAbandonedConversation } from './keepAbandonedConversation.js'
import type { RegisteredSession } from './registry.js'

const fault = vi.hoisted(() => ({ file: '', rename: false, directory: false, renamed: false, inspect: undefined as (() => void) | undefined,
  opening: undefined as ((path: string) => void) | undefined, opened: undefined as ((path: string) => void) | undefined }))
vi.mock('fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, openSync: (...args: Parameters<typeof actual.openSync>) => {
    fault.opening?.(String(args[0]))
    const fd = actual.openSync(...args)
    fault.opened?.(String(args[0]))
    return fd
  }, lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
    const result = actual.lstatSync(...args)
    if (String(args[0]) === fault.file) fault.inspect?.()
    return result
  }, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    if (String(args[1]) === fault.file && fault.rename) throw Error('fixture rename failed')
    const result = actual.renameSync(...args)
    if (String(args[1]) === fault.file) fault.renamed = true
    return result
  }, fsyncSync: (fd: number) => {
    if (fault.directory && fault.renamed && actual.fstatSync(fd).isDirectory()) throw Error('fixture directory sync failed')
    actual.fsyncSync(fd)
  } }
})
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))

let root: string, data: string, file: string, row: RegisteredSession, registry: typeof import('./registry.js')['registry']
const input = () => ({ agentId: 'original-agent', engine: 'cursor' as const, tmuxPane: '%1', cwd: root,
  processIdentity: { pid: 42, startMarker: 'fixture-start', executable: '<cursor>' } })
const rows = () => JSON.parse(readFileSync(file, 'utf8')) as RegisteredSession[]
const cancellation = (): NativeTurnIntent => ({ version: 1, cancel: { processKey: 'boot\0cursor\0birth', target: nativeTurnTarget(row),
  request: { requestId: 'original-cancel-request', nonce: 'original-cancel-nonce', agentId: row.agentId, conversationId: row.sessionId, frontier: { index: -1, digest: null } } } })
const commit = () => registry.commitNativeControl(row, cancellation(), () => {})
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'registry-native-control-'))); data = join(root, 'data'); file = join(data, 'registry.json')
  fault.file = file; fault.rename = false; fault.directory = false; fault.renamed = false
  mkdirSync(data, { mode: 0o700 }); writeFileSync(join(data, 'engine-homes.json'), '{}', { mode: 0o600 })
  for (const [key, value] of Object.entries({ HOME: root, ADAPTER_DATA_DIR: data, ADAPTER_RUNTIME_DIR: join(root, 'runtime'),
    CURSOR_HOME: join(root, 'cursor'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude') })) vi.stubEnv(key, value)
  vi.resetModules(); ({ registry } = await import('./registry.js'))
  registry.load()
  registry.openProcessAgent(input())
  row = registry.register({ ...input(), sessionId: 'original-session' })!.entry
})
afterEach(() => { fault.rename = false; fault.directory = false; fault.inspect = undefined; fault.opening = fault.opened = undefined
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); rmSync(root, { recursive: true, force: true }) })

it('commits the original cancellation inside a discovery batch before granting any durable proof', async () => {
  const proposed = cancellation()
  let fenced = false
  await registry.transaction(async () => {
    const saved = registry.commitNativeControl(row, proposed, () => { fenced ||= existsSync(`${file}.lock`) })
    expect(fenced).toBe(true)
    expect(rows()[0]).toMatchObject({ schemaVersion: 3, nativeControl: proposed })
    expect(registry.readNativeControl(saved).intent).toEqual(proposed)
    await Promise.resolve()
  })
  expect(row.nativeControl).toBeUndefined()
  expect(registry.byAgent(row.agentId)?.nativeControl).toEqual(proposed)
  expect(proposed.cancel).not.toBe(registry.byAgent(row.agentId)?.nativeControl?.cancel)
})

it('keeps cancellation across registration, load and an automatic process identity change', () => {
  const saved = commit(), expected = saved.nativeControl
  registry.register({ ...input(), sessionId: row.sessionId, title: 'A later observation' })
  registry.load()
  expect(registry.byAgent(row.agentId)?.nativeControl).toEqual(expected)
  registry.updateProcessIdentity(row.agentId, { ...input().processIdentity, pid: 43 })
  const current = registry.byAgent(row.agentId)!
  expect(registry.readNativeControl(current).intent).toEqual(expected)
  expect(nativeTurnAdmitted(current.nativeControl, { agentId: row.agentId, sessionId: row.sessionId, processKey: 'replacement' })).toBe(false)
})

it('preserves the original association in stopped storage and an abandoned-conversation clone', () => {
  const saved = commit(), store = new StoppedAgentStore(join(data, 'stopped-agents'))
  store.save(saved)
  expect(store.get(row.agentId)?.nativeControl).toEqual(saved.nativeControl)
  const publish = vi.fn(async () => {})
  createKeepAbandonedConversation({ stoppedAgents: store, publishStoppedAgent: publish })(saved)
  const archived = store.list().find(candidate => candidate.agentId !== row.agentId)!
  expect(archived.schemaVersion).toBe(3)
  expect(archived.nativeControl).toEqual(saved.nativeControl)
  expect(archived.nativeControl!.cancel.request.agentId).toBe(row.agentId)
  expect(nativeTurnAdmitted(archived.nativeControl, { agentId: archived.agentId, sessionId: archived.sessionId, processKey: 'new' })).toBe(false)
})

it('does not turn a new process in the pane into an uncancelled replacement agent', () => {
  const saved = commit(), bytes = readFileSync(file, 'utf8')
  expect(registry.openProcessAgent({ ...input(), agentId: 'automatic-successor', processIdentity: { ...input().processIdentity, pid: 43 } })).toBeNull()
  expect(registry.byAgent(row.agentId)).toBe(saved)
  expect(registry.byAgent('automatic-successor')).toBeUndefined()
  expect(readFileSync(file, 'utf8')).toBe(bytes)
})

it('refuses another agent stealing the cancelled conversation', () => {
  commit()
  const other = { ...input(), agentId: 'other', tmuxPane: '%2', processIdentity: { ...input().processIdentity, pid: 44 } }
  registry.openProcessAgent(other)
  const bytes = readFileSync(file, 'utf8')
  expect(() => registry.register({ ...other, sessionId: row.sessionId })).toThrow('native cancellation')
  expect(readFileSync(file, 'utf8')).toBe(bytes)
})

it('holds a peer ownership collision at merge instead of evicting the cancelled row', async () => {
  const peer = new (registry.constructor as new () => typeof registry)()
  peer.load()
  commit()
  const bytes = readFileSync(file, 'utf8')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  peer.openProcessAgent({ ...input(), agentId: 'automatic-successor', processIdentity: { ...input().processIdentity, pid: 43 } })
  expect(readFileSync(file, 'utf8')).toBe(bytes)
  expect(console.error).toHaveBeenCalled()
})

it('does not let a stale peer remove a row after its durable cancellation changed', () => {
  const peer = new (registry.constructor as new () => typeof registry)()
  peer.load(); commit()
  const bytes = readFileSync(file, 'utf8')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  peer.removeAgent(row.agentId)
  expect(readFileSync(file, 'utf8')).toBe(bytes)
  expect(console.error).toHaveBeenCalled()
  // A fresh view can remove the exact row that its archive preserves.
  peer.load(); peer.removeAgent(row.agentId)
  expect(rows()).toEqual([])
})

it.each(['rename', 'fence'] as const)('publishes no control when %s fails before the write', failure => {
  const before = readFileSync(file, 'utf8')
  fault.rename = failure === 'rename'
  expect(() => registry.commitNativeControl(row, cancellation(), () => { if (failure === 'fence') throw Error('native evidence changed') })).toThrow()
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(registry.byAgent(row.agentId)?.nativeControl).toBeUndefined()
})

it('never rolls an uncertain Cancel back during an unrelated save, then confirms only the original request', () => {
  const proposed = cancellation()
  fault.directory = true; fault.renamed = false
  expect(() => registry.commitNativeControl(row, proposed, () => {})).toThrow('directory sync')
  expect(registry.byAgent(row.agentId)?.nativeControl).toBeUndefined()
  expect(rows()[0].nativeControl).toEqual(proposed)
  expect(() => registry.readNativeControl(row)).toThrow('durable registry confirmation')
  const written = readFileSync(file, 'utf8')
  fault.directory = false
  vi.spyOn(console, 'error').mockImplementation(() => {})
  registry.flush()
  registry.markOpened(row.agentId); registry.touchTranscript(row.sessionId, Date.now() + 10)
  expect(readFileSync(file, 'utf8')).toBe(written)
  expect(console.error).toHaveBeenCalled()
  expect(() => registry.commitNativeControl(row, { ...proposed, cancel: { ...proposed.cancel, request: { ...proposed.cancel.request, nonce: 'different-cancel-nonce' } } }, () => {})).toThrow('still needs durable confirmation')
  const saved = registry.commitNativeControl(row, proposed, () => {})
  expect(registry.readNativeControl(saved).intent).toEqual(proposed)
  expect(readFileSync(file, 'utf8')).toBe(written)
})

it('rechecks the captured owner after the external commit fence returns inside the lock', () => {
  const before = readFileSync(file, 'utf8')
  expect(() => registry.commitNativeControl(row, cancellation(), () => {
    if (existsSync(`${file}.lock`)) row.sessionId = 'replacement'
  })).toThrow('original native control owner changed')
  expect(readFileSync(file, 'utf8')).toBe(before)
})

it('refuses a direct confirmed replacement without its original durable reservation', () => {
  const next = { ...cancellation(), rearm: { requestId: 'original-rearm-request', agentId: row.agentId,
    operation: 'restart' as const, target: nativeTurnTarget(row), launchToken: 'original-launch-token',
    replacement: { processKey: 'replacement', sessionId: row.sessionId } } }
  const before = readFileSync(file, 'utf8')
  expect(() => registry.commitNativeControl(row, next, () => {})).toThrow('transition is invalid')
  expect(readFileSync(file, 'utf8')).toBe(before)
})

it('requires a recovered enabling image to confirm file and directory durability before admission', () => {
  const cancelled = commit()
  const reserved = registry.commitNativeControl(cancelled, { ...cancelled.nativeControl!, rearm: {
    requestId: 'original-rearm-request', agentId: row.agentId, operation: 'restart', target: nativeTurnTarget(cancelled), launchToken: 'original-launch-token',
  } }, () => {})
  registry.updateProcessIdentity(row.agentId, { ...input().processIdentity, pid: 43 })
  const candidate = registry.byAgent(row.agentId)!
  const next: NativeTurnIntent = { ...reserved.nativeControl!, rearm: { ...reserved.nativeControl!.rearm!,
    replacement: { processKey: 'replacement-native-process', sessionId: row.sessionId } } }
  fault.directory = true; fault.renamed = false
  expect(() => registry.commitNativeControl(candidate, next, () => {})).toThrow('directory sync')
  const peer = new (registry.constructor as new () => typeof registry)()
  peer.load()
  expect(() => peer.readNativeControl(peer.byAgent(row.agentId)!)).toThrow('directory sync')
  fault.directory = false
  const proof = peer.readNativeControl(peer.byAgent(row.agentId)!)
  expect(nativeTurnAdmitted(proof.intent, { agentId: row.agentId, sessionId: row.sessionId, processKey: 'replacement-native-process' })).toBe(true)
  proof.verify()
})

it.each(['file', 'directory'] as const)('never syncs a substitute %s descriptor after a temporary route change', kind => {
  const cancelled = commit()
  const reserved = registry.commitNativeControl(cancelled, { ...cancelled.nativeControl!, rearm: {
    requestId: 'original-rearm-request', agentId: row.agentId, operation: 'restart', target: nativeTurnTarget(cancelled), launchToken: 'original-launch-token',
  } }, () => {})
  const ready = registry.commitNativeControl(reserved, { ...reserved.nativeControl!, rearm: { ...reserved.nativeControl!.rearm!,
    replacement: { processKey: 'replacement-native-process', sessionId: row.sessionId } } }, () => {})
  const path = kind === 'file' ? file : data, bytes = readFileSync(file)
  let reads = 0, swapped = false
  fault.opening = candidate => {
    if (candidate !== path || (kind === 'file' && ++reads !== 2)) return
    fault.opening = undefined
    renameSync(path, path + '.original')
    if (kind === 'directory') mkdirSync(data, { mode: 0o700 })
    writeFileSync(file, bytes, { mode: 0o600 }); swapped = true
  }
  fault.opened = candidate => {
    if (candidate !== path || !swapped) return
    fault.opened = undefined
    renameSync(path, path + '.substitute'); renameSync(path + '.original', path)
  }
  expect(() => registry.readNativeControl(ready)).toThrow('changed before durability confirmation')
  expect(swapped).toBe(true)
  expect(readFileSync(file)).toEqual(bytes)
})

it('does not adopt a peer change as confirmation of an uncertain control write', () => {
  fault.directory = true; fault.renamed = false
  expect(commit).toThrow('directory sync')
  fault.directory = false
  const peer = rows(); peer[0].nativeControl = { ...cancellation(), cancel: { ...cancellation().cancel, request: { ...cancellation().cancel.request, nonce: 'peer-cancel-nonce' } } }
  writeFileSync(file, JSON.stringify(peer))
  const bytes = readFileSync(file, 'utf8')
  expect(commit).toThrow('still needs durable confirmation')
  expect(readFileSync(file, 'utf8')).toBe(bytes)
  expect(registry.byAgent(row.agentId)?.nativeControl).toBeUndefined()
})

it.each(['file', 'binding', 'control', 'missing'] as const)('revokes the original durable proof after %s changes', change => {
  const saved = commit(), proof = registry.readNativeControl(saved)
  if (change === 'file') { const bytes = readFileSync(file); renameSync(file, file + '.old'); writeFileSync(file, bytes, { mode: 0o600 }) }
  if (change === 'binding') saved.sessionId = 'replacement'
  if (change === 'control') saved.nativeControl = { ...cancellation(), cancel: { ...cancellation().cancel, processKey: 'replacement' } }
  if (change === 'missing') registry.removeAgent(saved.agentId)
  expect(proof.verify).toThrow()
})

it('checks the retained file after all private-state inspection at the final dispatch boundary', () => {
  const saved = commit(), proof = registry.readNativeControl(saved)
  const uid = process.getuid!()
  let checks = 0
  // Replace after the file's owner check has read its metadata. Earlier route
  // reads must not accidentally catch a fault intended for the last boundary.
  vi.spyOn(process, 'getuid').mockImplementation(() => {
    if (++checks === 2) {
      const bytes = readFileSync(file); renameSync(file, file + '.replaced'); writeFileSync(file, bytes, { mode: 0o600 })
    }
    return uid
  })
  expect(proof.verify).toThrow()
})

it.each(['row', 'binding', 'control', 'shape', 'oversized', 'file-mode', 'directory-mode'] as const)('holds unavailable or changed durable %s without modifying its bytes', change => {
  const saved = commit(), values = rows()
  if (change === 'row') values.splice(0)
  if (change === 'binding') values[0].sessionId = 'peer'
  if (change === 'control') values[0].nativeControl = { ...cancellation(), cancel: { ...cancellation().cancel, processKey: 'peer' } }
  if (change === 'shape') (values[0] as unknown as { nativeControl: unknown }).nativeControl = { version: 99 }
  writeFileSync(file, change === 'oversized' ? ' '.repeat(1024 * 1024 + 1) : JSON.stringify(values))
  if (change === 'file-mode') chmodSync(file, 0o666)
  if (change === 'directory-mode') chmodSync(data, 0o777)
  const bytes = readFileSync(file, 'utf8')
  expect(() => registry.readNativeControl(saved)).toThrow()
  expect(readFileSync(file, 'utf8')).toBe(bytes)
})

it.each([undefined, null, { version: 9 }, { version: 1, cancel: {}, rearm: {} }])('never normalizes malformed saved control to absence %#', nativeControl => {
  const values = rows(); Object.assign(values[0], { schemaVersion: 3, nativeControl })
  writeFileSync(file, JSON.stringify(values))
  const bytes = readFileSync(file, 'utf8')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  registry.load(); registry.flush()
  expect(registry.byAgent(row.agentId)).toBeUndefined()
  registry.openProcessAgent(input())
  expect(readFileSync(file, 'utf8')).toBe(bytes)
})

it.each(['neighbour', 'truncated'] as const)('preserves control-bearing bytes when %s data is corrupt', change => {
  commit()
  const values = rows()
  const bytes = change === 'neighbour' ? JSON.stringify([...values, { schemaVersion: 2, agentId: 'malformed-neighbour' }])
    : JSON.stringify(values).slice(0, -1)
  writeFileSync(file, bytes)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  registry.load(); registry.openProcessAgent(input()); registry.flush()
  expect(readFileSync(file, 'utf8')).toBe(bytes)
})

it.each(['[', '', '{"incomplete":'])('a fresh daemon never replaces truncated state that lost its control marker: %j', bytes => {
  commit(); writeFileSync(file, bytes)
  const peer = new (registry.constructor as new () => typeof registry)()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  peer.load()
  expect(peer.openProcessAgent(input())).toBeNull()
  peer.flush()
  expect(readFileSync(file, 'utf8')).toBe(bytes)
})
