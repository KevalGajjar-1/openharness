/** Immutable hook intake and effect order for one native process incarnation.
 * An acknowledged input can be recovered; a claimed effect cannot be guessed at.
 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, type BigIntStats } from 'node:fs'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { secureStateDirectory } from '../../lib/secureState.js'
import { inspectHookFile, runHookPreparation } from './nativeHookFiles.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { NativePaths, verifyNativePathFacts } from './nativePaths.js'

export class NativeHookJournalHeld extends Error {
  constructor(detail: string) { super(`Native hook delivery is held: ${detail}`); this.name = 'NativeHookJournalHeld' }
}
function held(detail: string): never { throw new NativeHookJournalHeld(detail) }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const identity = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.mode}:${info.uid}`
const stamp = (info: BigIntStats) => `${identity(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const idPattern = /^[a-zA-Z0-9_-]{16,96}$/
const hashPattern = /^[a-f0-9]{64}$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const MAX_RESULT_BYTES = 16_384
// A complete synchronous fence checks both copies. Keep its operation count
// below NativeEvidenceBudget's limit, including reserved terminal records.
const MAX_PROCESS_RECORDS = 4_096
// Reserve both copies of a bounded claim and result before owning an intake.
const TERMINAL_BYTES = 2 * (MAX_RESULT_BYTES + 4_096)

export interface NativeHookIntake {
  id: string
  fingerprint: string
  /** Ownership is fenced separately from the process-wide order key. */
  agentId: string
  conversationId: string
  firedAt?: number
  payload: Record<string, unknown>
}
type Event = { kind: 'intake'; intake: NativeHookIntake }
  | { kind: 'claim'; id: string; token: string; agentId: string; predecessor: string | null }
  | { kind: 'result'; id: string; token: string; value: Record<string, unknown> }
type RecordValue = { version: 1; processKey: string; index: number; previous: string | null; event: Event }
type Read = ReturnType<typeof read>
export interface NativeHookDelivery {
  intake: NativeHookIntake
  result?: Record<string, unknown>
  resultToken?: string
  verify(): void
}
export interface NativeHookClaim {
  readonly id: string
  readonly token: string
  /** Call again inside the registry commit, after asynchronous preparation. */
  verify(): void
  finish(value: Record<string, unknown>): Promise<void>
}
interface Snapshot {
  deliveries: Map<string, NativeHookDelivery>
  active?: { id: string; token: string; agentId: string; verify(): void }
  previous: string | null
  lastResult: string | null
  bytes: number
  length: number
  verify(): void
  verifyRecords(): void
  verifyAuthority(): void
  confirm(): Promise<void>
}

/** Reading a journal is observation, never permission to chmod a foreign file. */
function read(file: string): { text: string; file: string; version: string; verify(): void } | undefined {
  const paths = new NativePaths(new NativeEvidenceBudget(250))
  const location = paths.resolveSync(file, true), facts = paths.snapshot()
  if (!location) return undefined
  if (lstatSync(file).isSymbolicLink()) held('aliased journal record')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  let text: string, expected: string
  try {
    const info = fstatSync(fd, { bigint: true })
    if (!info.isFile() || info.dev !== location.info.dev || info.ino !== location.info.ino
      || info.size > 1024 * 1024 || (info.mode & 0o777n) !== 0o600n
      || (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid()))) held('unsafe journal record')
    expected = stamp(info)
    const buffer = Buffer.alloc(Number(info.size))
    let offset = 0
    for (let calls = 0; offset < buffer.length; calls++) {
      if (calls >= 64) held('journal read exceeds its operation limit')
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (!count) held('journal record was truncated')
      offset += count
    }
    if (stamp(fstatSync(fd, { bigint: true })) !== expected) held('journal record changed during its read')
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } finally { closeSync(fd) }
  const verify = () => {
    verifyNativePathFacts(facts)
    if (stamp(lstatSync(file, { bigint: true })) !== expected) held('journal record changed')
  }
  verify()
  return { text, file, version: expected, verify }
}

function validIntake(value: unknown): value is NativeHookIntake {
  if (!object(value)) return false
  return typeof value.id === 'string' && idPattern.test(value.id)
    && typeof value.fingerprint === 'string' && hashPattern.test(value.fingerprint)
    && typeof value.agentId === 'string' && value.agentId.length > 0 && value.agentId.length <= 200
    && typeof value.conversationId === 'string' && value.conversationId.length <= 200
    && (value.firedAt === undefined || Number.isSafeInteger(value.firedAt) && Number(value.firedAt) > 0)
    && object(value.payload) && Buffer.byteLength(JSON.stringify(value)) <= 300_000
}

/** A directory walk yields regularly and proves its complete, unchanged boundary. */
async function entries(path: string, limit: number): Promise<{ names: string[]; inspected: number; verify(): void }> {
  const paths = new NativePaths(new NativeEvidenceBudget(250)), location = paths.resolveSync(path)!, facts = paths.snapshot()
  const route = new Map<string, string>()
  for (let part = location.path;; part = dirname(part)) {
    route.set(part, stamp(lstatSync(part, { bigint: true })))
    if (part === dirname(part)) break
  }
  const verifyRoute = () => {
    verifyNativePathFacts(facts)
    for (const [part, expected] of route) if (stamp(lstatSync(part, { bigint: true })) !== expected) held('journal directory ancestor changed')
  }
  const before = stamp(lstatSync(path, { bigint: true }))
  const iterator = opendirSync(location.path, { bufferSize: 32 })
  const names: string[] = []
  let began = performance.now(), inspected = 0
  const verify = () => { if (stamp(lstatSync(path, { bigint: true })) !== before) held('journal directory changed during recovery') }
  try {
    verify(); verifyRoute()
    for (;;) {
      const entry = iterator.readSync()
      if (!entry) break
      if (++inspected > limit + 64) held('journal directory exceeds its entry limit')
      // An interrupted exclusive publication can leave its private staging file.
      // It carries no authority and is never removed by recovery.
      if (entry.isFile() && /^\.harness-hook-[a-f0-9-]{36}\.tmp$/.test(entry.name)) {
        read(join(path, entry.name))
        continue
      }
      if (names.length >= limit) held('journal record capacity is exhausted')
      if (!entry.isFile() || !/^\d{8}\.json$/.test(entry.name)) held('unrecognized journal entry')
      names.push(entry.name)
      if (names.length % 64 === 0 || performance.now() - began >= 20) {
        await new Promise<void>(done => setImmediate(done)); began = performance.now(); verify()
      }
    }
  } finally { iterator.closeSync() }
  verify(); verifyRoute()
  // An iterator redirected at an older directory must not report its shorter
  // prefix as a complete frontier, even if path metadata appeared unchanged.
  const next = join(path, `${String(names.length).padStart(8, '0')}.json`)
  if (read(next)) held('journal enumeration omitted a later record')
  return { names: names.sort(), inspected, verify }
}

/** The caller supplies boot + native process birth as processKey, never agentId.
 * Each record has a second immutable witness outside its history directory. A
 * lost receipt or replaced directory holds instead of making an old ID new.
 */
export function createNativeHookJournal({ directory, processKey, current = () => true,
  maxRecords = MAX_PROCESS_RECORDS, maxBytes = 256 * 1024 * 1024, pendingCapacity = 64,
}: { directory: string; processKey: string; current?: () => boolean; maxRecords?: number; maxBytes?: number; pendingCapacity?: number }) {
  const witnesses = `${directory}.witnesses`, authorityFile = `${directory}.authority`
  const bootstrapFile = `${directory}.bootstrap`, sealFile = `${directory}.seal`
  maxRecords = Math.min(MAX_PROCESS_RECORDS, maxRecords)
  let closed = false
  const check = () => { if (closed || !current()) held('the original process owner changed') }
  const publish = async (file: string, text: string, verify: () => void, exclusive: boolean) => {
    await runHookPreparation([file], async attempt => {
      verify(); check()
      await inspectHookFile(file, 0o600).replace(text, attempt, exclusive)
    }, { retainConflicts: true, current: () => { check(); verify(); return true } })
  }
  const confirm = async (records: readonly Exclude<Read, undefined>[], verify: () => void, owner = verify) => {
    verify()
    for (const record of records) {
      record.verify()
      await publish(record.file, record.text, () => { owner(); record.verify() }, false)
    }
    verify()
  }
  const directories = () => {
    for (const path of [directory, witnesses]) {
      const info = lstatSync(path, { bigint: true })
      if (!info.isDirectory() || (info.mode & 0o777n) !== 0o700n
        || typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) held('unsafe journal directory')
    }
    return { history: identity(lstatSync(directory, { bigint: true })), witnesses: identity(lstatSync(witnesses, { bigint: true })) }
  }
  const authority = async () => {
    check()
    let bootstrap = read(bootstrapFile)
    let saved = read(authorityFile)
    let sealed = read(sealFile)
    if (!bootstrap) {
      // The independent bootstrap must precede every namespace side effect.
      // Existing state with a lost bootstrap is never a fresh namespace.
      const absentPaths = [directory, witnesses, authorityFile, sealFile].map(path => {
        const routes = new NativePaths(new NativeEvidenceBudget(250))
        if (routes.resolveSync(path, true)) held('the journal bootstrap is missing')
        return routes.snapshot()
      })
      const verifyAbsent = () => { for (const facts of absentPaths) verifyNativePathFacts(facts) }
      await publish(bootstrapFile, JSON.stringify({ version: 1, processKey, token: randomUUID(), directory, witnesses }), verifyAbsent, true)
      bootstrap = read(bootstrapFile)
    }
    if (!bootstrap) held('journal bootstrap could not be confirmed')
    const initial = JSON.parse(bootstrap.text)
    if (initial.version !== 1 || initial.processKey !== processKey || typeof initial.token !== 'string'
      || !idPattern.test(initial.token) || initial.directory !== directory || initial.witnesses !== witnesses) held('journal bootstrap changed')
    const bootstrapHash = digest(bootstrap.text)
    const verifyBootstrap = () => { check(); bootstrap!.verify() }
    if (!saved) {
      if (sealed) held('the journal authority is missing')
      await confirm([bootstrap], verifyBootstrap)
      // Only the unfinished initialization reservation may adopt empty private
      // directories. It can never reinterpret a populated history as empty.
      for (const path of [directory, witnesses]) {
        let exists = false
        try {
          const info = lstatSync(path, { bigint: true })
          if (!info.isDirectory() || (info.mode & 0o777n) !== 0o700n
            || typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) held('unsafe journal directory')
          exists = true
        } catch (error) { if (!absent(error)) throw error }
        if (exists && (await entries(path, maxRecords)).inspected !== 0) held('unfinished initialization has journal history')
        verifyBootstrap(); secureStateDirectory(path)
      }
      const expected = directories()
      await publish(authorityFile, JSON.stringify({ version: 1, processKey, bootstrap: bootstrapHash, ...expected }), () => {
        verifyBootstrap()
        if (JSON.stringify(directories()) !== JSON.stringify(expected)) held('journal ownership changed')
      }, true)
      saved = read(authorityFile)
    }
    if (!saved) held('journal authority could not be confirmed')
    const value = JSON.parse(saved.text)
    const verifyAuthority = () => {
      verifyBootstrap(); saved!.verify()
      if (value.version !== 1 || value.processKey !== processKey || value.bootstrap !== bootstrapHash || JSON.stringify(directories())
        !== JSON.stringify({ history: value.history, witnesses: value.witnesses })) held('journal namespace changed')
    }
    verifyAuthority()
    const seal = JSON.stringify({ version: 1, processKey, bootstrap: bootstrapHash, authority: digest(saved.text),
      history: value.history, witnesses: value.witnesses })
    if (!sealed) {
      const history = await entries(directory, maxRecords), outside = await entries(witnesses, maxRecords)
      if (history.inspected || outside.inspected) held('the journal initialization seal is missing')
      await confirm([bootstrap, saved], verifyAuthority)
      await publish(sealFile, seal, () => { verifyAuthority(); history.verify(); outside.verify() }, true)
      sealed = read(sealFile)
    }
    if (!sealed || sealed.text !== seal) held('journal initialization seal changed')
    const verify = () => { verifyAuthority(); sealed!.verify() }
    verify()
    return { verify, records: [bootstrap, saved, sealed] }
  }
  const snapshot = async (repairAllowed = true): Promise<Snapshot> => {
    const owned = await authority(), verifyAuthority = owned.verify
    const history = await entries(directory, maxRecords), outside = await entries(witnesses, maxRecords)
    const repair = repairAllowed && outside.names.length === history.names.length + 1
      && history.names.every((name, index) => outside.names[index] === name)
    if (!repair && JSON.stringify(history.names) !== JSON.stringify(outside.names)) held('a journal record or witness is missing')
    const deliveries = new Map<string, NativeHookDelivery>()
    let active: { id: string; token: string; agentId: string; verify(): void } | undefined
    let previous: string | null = null, lastResult: string | null = null, bytes = 0, began = performance.now()
    const versions: Array<{ file: string; version: string }> = []
    let tail: Exclude<Read, undefined>[] = owned.records
    let mirror: Exclude<Read, undefined> | undefined
    for (const [index, name] of outside.names.entries()) {
      if (name !== `${String(index).padStart(8, '0')}.json`) held('journal history has a gap')
      let record = read(join(directory, name))
      const witness = read(join(witnesses, name))
      if (!record && repair && index === history.names.length && witness) { mirror = witness; record = witness }
      if (!record || !witness || record.text !== witness.text) held('journal witness disagrees with its record')
      bytes += Buffer.byteLength(record.text) * 2
      if (bytes > maxBytes) held('journal byte capacity is exhausted')
      const value: RecordValue = JSON.parse(record.text)
      if (value.version !== 1 || value.processKey !== processKey || value.index !== index || value.previous !== previous
        || !object(value.event)) held('invalid journal chain')
      const event = value.event
      versions.push({ file: record.file, version: record.version }, { file: witness.file, version: witness.version })
      const verify = () => { record.verify(); witness.verify() }
      if (event.kind === 'intake') {
        if (!validIntake(event.intake) || deliveries.has(event.intake.id)) held('invalid or repeated journal intake')
        deliveries.set(event.intake.id, { intake: event.intake, verify })
      } else if (event.kind === 'claim') {
        const delivery = deliveries.get(event.id)
        if (active || !delivery || delivery.result || event.agentId !== delivery.intake.agentId
          || typeof event.token !== 'string' || !idPattern.test(event.token) || event.predecessor !== lastResult) held('invalid hook effect order')
        active = { id: event.id, token: event.token, agentId: event.agentId, verify }
      } else if (event.kind === 'result') {
        const delivery = deliveries.get(event.id)
        if (!active || !delivery || active.id !== event.id || active.token !== event.token || !object(event.value)
          || Buffer.byteLength(JSON.stringify(event.value)) > MAX_RESULT_BYTES) held('unowned hook result')
        const before = delivery.verify
        delivery.result = event.value; delivery.resultToken = event.token; delivery.verify = () => { before(); verify() }
        active = undefined; lastResult = digest(record.text)
      } else held('unknown hook journal event')
      previous = digest(record.text); tail = [...owned.records, record, witness]
      if (index % 64 === 63 || performance.now() - began >= 20) {
        await new Promise<void>(done => setImmediate(done)); began = performance.now()
        verifyAuthority(); history.verify(); outside.verify()
      }
    }
    const verifyRecords = () => {
      verifyAuthority()
      // Deduplicate ancestor checks through namespace authority; each immutable
      // leaf version consumed by the chain must still be the version inspected.
      const budget = new NativeEvidenceBudget(250)
      for (const record of versions) {
        budget.step()
        if (stamp(lstatSync(record.file, { bigint: true })) !== record.version) held('journal record changed after recovery')
      }
    }
    const verify = () => { history.verify(); outside.verify(); verifyRecords() }
    verify()
    if (mirror) {
      // The outside slot already chose the event. Completing its exact mirror
      // grants no execution right, including when that event is an effect claim.
      await confirm([...owned.records, mirror], verify, verifyAuthority)
      await publish(join(directory, outside.names.at(-1)!), mirror.text, verifyAuthority, true)
      verifyRecords()
      return snapshot(false)
    }
    return { deliveries, active, previous, lastResult, bytes, length: history.names.length, verify, verifyRecords, verifyAuthority,
      confirm: () => confirm(tail, verify, verifyAuthority) }
  }
  const append = async (before: Snapshot, event: Event) => {
    before.verify()
    if (before.length >= maxRecords) held('journal record capacity is exhausted')
    const text = JSON.stringify({ version: 1, processKey, index: before.length, previous: before.previous, event } satisfies RecordValue)
    if (Buffer.byteLength(text) * 2 + before.bytes > maxBytes) held('journal byte capacity is exhausted')
    const name = `${String(before.length).padStart(8, '0')}.json`
    // The outside publication exclusively selects this log position across cores.
    // A failed sync never transfers that publisher's execution right to a retry.
    await publish(join(witnesses, name), text, before.verifyAuthority, true)
    // A recovery reader may already have completed the mirror. Only the original
    // exclusive outside publisher can reach this return and own a new claim.
    const existing = read(join(directory, name))
    if (existing && existing.text !== text) held('journal publication changed')
    await publish(join(directory, name), text, () => { before.verifyAuthority(); existing?.verify() }, !existing)
    const record = read(join(directory, name)), witness = read(join(witnesses, name))
    if (!record || !witness || record.text !== text || witness.text !== text) held('journal publication changed')
    before.verifyRecords()
    return () => { before.verifyRecords(); record.verify(); witness.verify() }
  }
  return {
    snapshot,
    async retain(input: NativeHookIntake): Promise<NativeHookDelivery> {
      const intake = structuredClone(input)
      if (!validIntake(intake)) held('invalid native delivery')
      const before = await snapshot(), known = before.deliveries.get(intake.id)
      if (known) {
        if (known.intake.fingerprint !== intake.fingerprint) held('HOOK_DELIVERY_CONFLICT')
        if (known.intake.agentId !== intake.agentId) held('the native process has a different agent owner')
        await before.confirm(); known.verify(); return known
      }
      const pending = [...before.deliveries.values()].filter(item => !item.result).length
      if (pending >= pendingCapacity) held('too many pending native hooks')
      if (before.length + pending * 2 - Number(!!before.active) + 3 > maxRecords) held('journal record capacity cannot retain terminal outcomes')
      if (before.bytes + (pending + 1) * TERMINAL_BYTES + 2 * Buffer.byteLength(JSON.stringify(intake)) + 4096 > maxBytes) held('journal byte capacity cannot retain terminal outcomes')
      await before.confirm()
      const verify = await append(before, { kind: 'intake', intake })
      return { intake, verify }
    },
    async claim(id: string, agentId: string, inspected?: { previous: string | null }): Promise<NativeHookClaim> {
      const before = await snapshot(), delivery = before.deliveries.get(id)
      if (!delivery || delivery.result || delivery.intake.agentId !== agentId) held('this delivery cannot dispatch')
      if (before.active) held('an earlier native hook effect is unconfirmed')
      if (inspected && inspected.previous !== before.previous) held('native hook order changed after inspection')
      const pending = [...before.deliveries.values()].filter(item => !item.result).length
      if (before.length + pending * 2 > maxRecords || before.bytes + pending * TERMINAL_BYTES > maxBytes) held('journal capacity cannot retain terminal outcomes')
      await before.confirm()
      delivery.verify()
      const token = randomUUID()
      const verifyClaim = await append(before, { kind: 'claim', id, agentId, token, predecessor: before.lastResult })
      let finished = false, terminal: string | undefined
      const verifyOwner = () => { check(); delivery.verify(); verifyClaim() }
      const verify = () => {
        verifyOwner()
        if (finished) held('the hook effect already completed')
        if (terminal !== undefined) held('the hook effect is completing')
      }
      return { id, token, verify, async finish(value) {
        const captured = structuredClone(value), proposed = JSON.stringify(captured)
        if (!object(captured) || Buffer.byteLength(proposed) > MAX_RESULT_BYTES) held('hook result exceeds its byte limit')
        verifyOwner()
        if (terminal !== undefined && terminal !== proposed) held('the original hook result cannot change')
        // Dispatch permission ends before any terminal publication or await. A
        // retry retains only permission to confirm this exact original result.
        terminal = proposed
        if (finished) return
        const latest = await snapshot()
        const completed = latest.deliveries.get(id)
        if (completed?.resultToken === token && JSON.stringify(completed.result) === proposed) {
          await latest.confirm(); verifyOwner(); finished = true; return
        }
        if (latest.active?.id !== id || latest.active.token !== token) held('the hook effect claim changed')
        verifyOwner()
        await append(latest, { kind: 'result', id, token, value: captured })
        finished = true
      } }
    },
    close(): void { closed = true },
  }
}
