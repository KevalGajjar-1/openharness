/** Fixed reservations shared by the daemon and short-lived hook clients.
 * Allocation is permanent: full or damaged storage holds, never evicts receipts. */
import { createHash } from 'node:crypto'
import { lstatSync, opendirSync, type BigIntStats } from 'node:fs'
import { dirname, join } from 'node:path'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { NativePaths, verifyNativePathFacts } from './nativePaths.js'
import { createNativeHookJournal, inspectNativeHookJournalAuthority, NativeHookJournalHeld,
  type NativeHookJournalBoundary } from './nativeHookJournal.js'
import { createNativeHookOutbox, NATIVE_HOOK_OUTBOX_SHARDS } from './nativeHookOutbox.js'
import { nativeHookMetadata as metadata, type createNativeHookStagePool } from './nativeHookStaging.js'

export const NATIVE_HOOK_STORAGE_LIMITS = Object.freeze({
  processes: 256, outboxes: NATIVE_HOOK_OUTBOX_SHARDS,
  effectBytes: 1024 * 1024, outboxBytes: 8 * 1024 * 1024,
  records: 4096, retainedIntakes: 382_208, contentBytes: 512 * 1024 * 1024,
})
type Kind = 'effects' | 'outbox'
type Metadata = NonNullable<ReturnType<typeof metadata.read>>
type Pair = { record: Metadata; mirror?: Metadata; verify(): void }
type Allocation = { kind: Kind; index: number; key: string; pair: Pair; seal?: Pair }
type Pool = Pick<ReturnType<typeof createNativeHookStagePool>, 'acquire'>
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const hashPattern = /^[a-f0-9]{64}$/
const identity = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.mode}:${info.uid}:${info.birthtimeNs}`
const stamp = (info: BigIntStats) => `${identity(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
function held(detail: string): never { throw new NativeHookJournalHeld(`catalog: ${detail}`) }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const count = (kind: Kind) => kind === 'effects' ? NATIVE_HOOK_STORAGE_LIMITS.processes : NATIVE_HOOK_STORAGE_LIMITS.outboxes
let activeOperations = 0

/** The caller supplies an already-private data root and its retained local
 * writer proof. This factory neither creates that root nor owns its lifetime. */
export function createNativeHookCatalog({ root, verifyRoot, pool, operationTimeoutMs = 4500 }: {
  root: string; verifyRoot(root: string): void; pool: Pool; operationTimeoutMs?: number
}) {
  if (!Number.isFinite(operationTimeoutMs) || operationTimeoutMs <= 0 || operationTimeoutMs > 4500) held('invalid operation deadline')
  const paths = new NativePaths(new NativeEvidenceBudget()), location = paths.resolveSync(root)!, facts = paths.snapshot()
  if (!location.info.isDirectory() || (location.info.mode & 0o777n) !== 0o700n
    || typeof process.getuid === 'function' && location.info.uid !== BigInt(process.getuid())) held('the storage root is not private')
  const expectedRoot = identity(location.info), canonical = location.path
  let closed = false
  const operations = new Set<Promise<unknown>>()
  const journalOperations = new Set<Promise<unknown>>()
  const checkRoot = () => {
    if (closed) held('the catalog is closed')
    verifyRoot(root); verifyNativePathFacts(facts)
    if (identity(lstatSync(canonical, { bigint: true })) !== expectedRoot) held('the storage root changed')
  }
  const run = async <T>(work: (check: () => void) => Promise<T>): Promise<T> => {
    checkRoot()
    if (activeOperations >= 16) held('actual catalog operation slots are occupied')
    activeOperations++
    const deadline = performance.now() + operationTimeoutMs
    let expired = false, timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      checkRoot()
      if (expired || performance.now() >= deadline) held('the catalog operation expired')
    }
    const actual = Promise.resolve().then(() => { check(); return work(check) })
      .then(value => { check(); return value })
      .finally(() => { activeOperations--; operations.delete(actual); clearTimeout(timer) })
    operations.add(actual)
    return await Promise.race([actual, new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true; reject(new NativeHookJournalHeld('catalog: disk confirmation exceeded its deadline'))
      }, operationTimeoutMs)
    })])
  }
  const base = (kind: Kind, index: number) => join(canonical, `.native-hook-${kind}-${String(index).padStart(3, '0')}`)
  const history = (kind: Kind, index: number) => `${base(kind, index)}.history`
  const versionFile = join(canonical, '.native-hook-catalog')
  const versionText = JSON.stringify([1, expectedRoot, 256, 16, 1024 * 1024, 8 * 1024 * 1024, 4096])
  const exists = (file: string) => {
    try { lstatSync(file); return true } catch (error) { if (!missing(error)) throw error; return false }
  }
  const pair = (file: string, verify = checkRoot): Pair | undefined => {
    verify()
    const route = metadata.routeStamps(canonical)
    // These fixed names are direct children of the already pinned root. Fence
    // that route around the pair, rather than multiplying the same ancestry
    // walk into each leaf's two stamp checks and every enclosing authority.
    const record = metadata.read(`${file}.witness`, () => {}), mirror = metadata.read(file, () => {})
    route(); verify()
    if (!record) { if (mirror) held('an allocation witness is missing'); return }
    if (mirror && mirror.text !== record.text) held('allocation mirrors disagree')
    const result = { record, mirror, verify: () => { verify(); record.verify(); mirror?.verify(); checkRoot() } }
    result.verify()
    return result
  }
  const confirm = async (file: string, text: string, verify: () => void, retainedVerify = checkRoot): Promise<Pair> => {
    verify()
    metadata.publish(`${file}.witness`, text, verify)
    const outside = metadata.read(`${file}.witness`, () => {})!
    const fence = () => { verify(); outside.verify() }
    // The outside intent is durable before creating its mirror or a journal.
    await metadata.syncDirectory(canonical, fence)
    metadata.publish(file, text, fence)
    const inside = metadata.read(file, () => {})!
    const complete = () => { fence(); inside.verify() }
    await metadata.syncParents(canonical, complete)
    complete()
    // Rebind to the original authority, not the previous confirmation closure.
    // Retaining that closure would recursively multiply every later read fence.
    const retained = pair(file, retainedVerify)
    if (!retained?.mirror || retained.record.text !== text) held('confirmed metadata changed')
    complete(); retained.verify()
    return retained
  }
  const journalAbsent = (kind: Kind, index: number) => {
    for (const suffix of ['', '.witnesses', '.bootstrap', '.authority', '.seal']) {
      if (exists(history(kind, index) + suffix)) held('a journal has no allocation authority')
    }
  }
  const inspectAllocation = (kind: Kind, index: number, verify: () => void): Allocation | undefined => {
    const route = metadata.routeStamps(canonical)
    const saved = pair(`${base(kind, index)}.allocation`, verify), seal = pair(`${base(kind, index)}.seal`, verify)
    if (!saved) {
      if (seal) held('an allocation seal has no reservation')
      journalAbsent(kind, index)
      route()
      return
    }
    const value: unknown = JSON.parse(saved.record.text)
    if (!Array.isArray(value) || value.length !== 4 || value[0] !== 1 || value[1] !== kind || value[2] !== index
      || typeof value[3] !== 'string' || !hashPattern.test(value[3]) || JSON.stringify(value) !== saved.record.text) held('invalid allocation reservation')
    if (seal) {
      const value: unknown = JSON.parse(seal.record.text)
      if (!Array.isArray(value) || value.length !== 3 || value[0] !== 1 || value[1] !== hash(saved.record.text)
        || typeof value[2] !== 'string' || !hashPattern.test(value[2]) || JSON.stringify(value) !== seal.record.text) held('invalid allocation seal')
    }
    route()
    return { kind, index, key: value[3], pair: saved, seal }
  }
  const scan = async (verify: () => void) => {
    verify()
    const frontier = stamp(lstatSync(canonical, { bigint: true }))
    const unchanged = () => {
      verify()
      if (stamp(lstatSync(canonical, { bigint: true })) !== frontier) held('the allocation catalog changed during its scan')
    }
    const allocations: Allocation[] = [], keys = new Set<string>()
    let inspected = 0, began = performance.now()
    for (const kind of ['effects', 'outbox'] as const) for (let index = 0; index < count(kind); index++) {
      verify()
      const allocation = inspectAllocation(kind, index, verify)
      if (allocation) {
        const key = `${kind}:${allocation.key}`
        if (keys.has(key)) held('a process has multiple allocations')
        keys.add(key); allocations.push(allocation)
      }
      if (++inspected % 64 === 0 || performance.now() - began >= 20) {
        await new Promise<void>(done => setImmediate(done)); began = performance.now(); unchanged()
      }
    }
    // A scan must represent one complete allocation view. Its temporary root
    // stamp ends at exclusive publication; retained journal proofs use identity
    // only, so unrelated namespaces do not revoke an existing owner.
    const fence = () => { verify(); allocations.forEach(item => { item.pair.verify(); item.seal?.verify() }) }
    unchanged(); fence()
    return { allocations, verify: () => { fence(); unchanged() }, verifyRecords: fence }
  }
  const initialize = async (check: () => void) => {
    check()
    const saved = pair(versionFile)
    if (saved && saved.record.text !== versionText) held('the catalog format or root changed')
    let verifyEmpty = () => {}
    if (!saved) {
      if ((await scan(check)).allocations.length) held('the catalog authority is missing')
      // Staging may start only after the catalog exists. Losing its independent
      // boundary cannot turn retained writer generations into a fresh pool.
      const ancestors = metadata.routeStamps(dirname(canonical))
      let emptyFrontier: string | undefined
      verifyEmpty = () => {
        check()
        ancestors()
        const frontier = stamp(lstatSync(canonical, { bigint: true }))
        if (frontier === emptyFrontier) return
        const route = metadata.routeStamps(canonical), budget = new NativeEvidenceBudget()
        // A previous draft's hash-named journal is retained evidence too. It
        // cannot disappear from authority merely because today's fixed-name
        // allocation scan does not recognize its format.
        const entries = opendirSync(canonical, { bufferSize: 2 })
        try {
          for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
            budget.step()
            if (![versionFile, versionFile + '.witness'].includes(join(canonical, entry.name))) held('unallocated storage remains before catalog initialization')
          }
        } finally { entries.closeSync() }
        for (const kind of ['effects', 'outbox'] as const) for (let index = 0; index < count(kind); index++) {
          budget.step()
          for (const suffix of ['.allocation', '.allocation.witness', '.seal', '.seal.witness']) {
            if (exists(base(kind, index) + suffix)) held('the catalog authority is missing')
          }
          journalAbsent(kind, index)
        }
        for (let lane = 0; lane < 8; lane++) {
          for (const suffix of ['', '.witnesses', '.bootstrap', '.authority', '.seal', ...Array.from({ length: 8 }, (_, i) => `.init-${i}`)]) {
            if (exists(join(canonical, `.native-hook-stage-${lane}${suffix}`))) held('the catalog authority is missing before staging')
          }
        }
        route(); ancestors(); check(); emptyFrontier = frontier
      }
    }
    return confirm(versionFile, versionText, () => { check(); verifyEmpty() })
  }
  let initializing: ReturnType<typeof initialize> | undefined
  const version = async (check: () => void) => {
    const actual = initializing ??= initialize(check)
    try { const result = await actual; check(); return result } finally { if (initializing === actual) initializing = undefined }
  }
  const allocate = async (kind: Kind, key: string, check: () => void, fixed?: number): Promise<Allocation> => {
    if (!key || key.length > 512) held('invalid process key')
    const control = await version(check), hashed = hash(key)
    const verify = () => { checkRoot(); control.verify() }
    const current = () => { check(); verify() }
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await scan(current)
      let selected = before.allocations.find(item => item.kind === kind && item.key === hashed)
      if (selected && fixed !== undefined && selected.index !== fixed) held('an outbox changed its fixed allocation')
      if (!selected) {
        const occupied = new Set(before.allocations.filter(item => item.kind === kind).map(item => item.index))
        const start = fixed ?? Number.parseInt(hashed.slice(0, 8), 16) % count(kind)
        const index = Array.from({ length: fixed === undefined ? count(kind) : 1 }, (_, step) => (start + step) % count(kind))
          .find(candidate => !occupied.has(candidate))
        if (index === undefined) held(`${kind} namespace capacity is exhausted`)
        const file = `${base(kind, index)}.allocation`, text = JSON.stringify([1, kind, index, hashed])
        before.verify()
        try { metadata.publish(`${file}.witness`, text, before.verifyRecords, true) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          // Another process chose this exact slot. Re-read its immutable key
          // before deciding whether this is our reservation or a collision.
          const winner = inspectAllocation(kind, index, current)
          if (!winner) held('the winning allocation disappeared')
          if (winner.key !== hashed) continue
        }
        selected = inspectAllocation(kind, index, current)
        if (!selected || selected.key !== hashed) held('the allocation changed before confirmation')
      }
      const saved = await confirm(`${base(kind, selected.index)}.allocation`, selected.pair.record.text, () => {
        current(); selected!.pair.verify()
      }, verify)
      return { ...selected, pair: saved }
    }
    return held('allocation contention requires a retry')
  }
  const boundary = (allocation: Allocation, current: () => boolean): NativeHookJournalBoundary => {
    const directory = history(allocation.kind, allocation.index), file = `${base(allocation.kind, allocation.index)}.seal`
    let authorized: { pair: Pair; authority: ReturnType<typeof inspectNativeHookJournalAuthority> } | undefined
    const baseVerify = () => {
      checkRoot(); allocation.pair.verify()
      if (!current()) held('the original journal owner changed')
    }
    const verify = () => {
      baseVerify()
      if (authorized) { authorized.pair.verify(); authorized.authority.verify(); return }
      const sealed = pair(file, () => { checkRoot(); allocation.pair.verify() })
      if (sealed) {
        const authority = inspectNativeHookJournalAuthority(directory)
        if (sealed.record.text !== JSON.stringify([1, hash(allocation.pair.record.text), authority.fingerprint])) held('the allocated journal changed')
        // Pin existing authority before the journal gets a chance to initialize
        // anything. Missing/replaced established history is never a bootstrap.
        authorized = { pair: sealed, authority }
      }
    }
    return {
      verify,
      authorize(proof, empty, checkOwner) {
        return run(async check => {
          checkOwner(); verify(); proof.verify()
          const expected = JSON.stringify([1, hash(allocation.pair.record.text), proof.fingerprint])
          let verifyEmpty = () => {}
          if (!authorized) { verifyEmpty = await empty(); check(); verify(); proof.verify() }
          if (authorized && authorized.pair.record.text !== expected) held('the journal seal changed')
          const prior = authorized
          const saved = await confirm(file, expected, () => { checkOwner(); check(); baseVerify(); prior?.pair.verify(); proof.verify(); verifyEmpty() }, baseVerify)
          checkOwner(); check(); authorized = { pair: saved, authority: proof }
          verify()
        })
      },
      acquireStage: (purpose, current) => pool.acquire(() => { verify(); return current() }, { purpose }),
      track(actual) {
        journalOperations.add(actual)
        void actual.then(() => journalOperations.delete(actual), () => journalOperations.delete(actual))
      },
    }
  }
  return {
    async effects(processKey: string, current: () => boolean = () => true) {
      const allocation = await run(check => allocate('effects', processKey, () => {
        check(); if (!current()) held('the original journal owner changed')
      }))
      return createNativeHookJournal({ directory: history('effects', allocation.index), processKey, current,
        maxBytes: NATIVE_HOOK_STORAGE_LIMITS.effectBytes, maxRecords: NATIVE_HOOK_STORAGE_LIMITS.records,
        boundary: boundary(allocation, current) })
    },
    async outbox(shard: number, current: () => boolean = () => true) {
      if (!Number.isSafeInteger(shard) || shard < 0 || shard >= NATIVE_HOOK_STORAGE_LIMITS.outboxes) held('invalid outbox shard')
      const allocation = await run(check => allocate('outbox', `native-hook-client:v1:shard:${shard}`, () => {
        check(); if (!current()) held('the original journal owner changed')
      }, shard))
      return createNativeHookOutbox({ directory: history('outbox', shard), shard, current,
        maxBytes: NATIVE_HOOK_STORAGE_LIMITS.outboxBytes, maxRecords: NATIVE_HOOK_STORAGE_LIMITS.records,
        boundary: boundary(allocation, current) })
    },
    async close(): Promise<void> {
      closed = true
      // Reply timeout cannot release a descriptor or its capacity while fsync
      // is still using it. Storage composition closes its writer proof after this.
      await Promise.allSettled([...operations, ...journalOperations])
    },
  }
}
