/** Stopped work is durable history, separate from the registry of live terminal routes. */
import { closeSync, constants, fsyncSync, lstatSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { env } from '../config/env.js'
import { isTerminalEngine } from '../engines/types.js'
import { atomicWriteJson, projectDisplayName, strictPersistedRow, withRegistryFileLock, type RegisteredSession } from './registry.js'
import { readPrivateStateFile, secureStateDirectory } from './secureState.js'
import { sameProcessIdentity } from './terminalRuntime.js'
import { inspectNativeControlFile } from './nativeControlFile.js'
import { nativeTurnTarget, nativeTurnTransition, parseNativeTurnIntent, type NativeTurnIntent } from './nativeTurnIntent.js'

const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/
const CATALOG_CACHE_RECORDS = 2048
const CATALOG_CACHE_BYTES = 4 * 1024 * 1024
const CATALOG_CACHE_MS = 30_000

/** Durable receipt/Registry evidence can read disk. The final current check
 * must only check the retained local owner, revocation and deadline. */
export interface SavedNativeControlFence { verify(): void; current(): void }

function catalogFingerprint(stat: BigIntStats): string {
  // ctime catches in-place edits even if a writer restores mtime. Inode/device
  // distinguish atomic replacements; mode/owner/type changes must miss too.
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs,
    stat.mode, stat.uid, stat.gid, stat.nlink].join(':')
}

export class StoppedAgentStore {
  private readonly catalogCache = new Map<string, { fingerprint: string; bytes: number; at: number; session: RegisteredSession }>()
  private catalogCacheBytes = 0
  private readonly uncertain = new Map<string, { before: string; bytes: string; candidate: RegisteredSession; verifyDirectory(): void }>()

  constructor(private readonly directory = join(env.ADAPTER_DATA_DIR, 'stopped-agents')) {}

  get(agentId: string): RegisteredSession | null {
    if (!SAFE_ID.test(agentId)) return null
    try {
      secureStateDirectory(this.directory, false)
      const raw = JSON.parse(readPrivateStateFile(join(this.directory, `${agentId}.json`), 1024 * 1024))
      if (raw.version !== 1) throw Error('Unknown saved state')
      const session = strictPersistedRow(raw.session)
      if (!session || session.agentId !== agentId) throw Error('Invalid saved state')
      return session
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('Could not read the saved stopped harness.')
    }
  }

  /** The id of every saved record, readable or not (`list()` skips an unreadable one). No folder yet → none; any other error throws. */
  ids(): string[] {
    try {
      return readdirSync(this.directory).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  list(): RegisteredSession[] {
    try {
      secureStateDirectory(this.directory, false)
      const ids = readdirSync(this.directory).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5))
      const present = new Set(ids)
      for (const id of this.catalogCache.keys()) if (!present.has(id)) this.forgetCatalogRecord(id)
      return ids.flatMap(id => {
        try {
          const saved = this.catalogRecord(id)
          return saved ? [saved] : []
        } catch {
          this.forgetCatalogRecord(id)
          // One unreadable record must not hide the other saved harnesses.
          return []
        }
      })
    } catch (error) {
      this.catalogCache.clear()
      this.catalogCacheBytes = 0
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  /** Status snapshots repeatedly enumerate the same saved metadata. Recheck
   * every file's identity on every read, but only reopen/parse changed files.
   * Actions still use get(), which always performs a fresh guarded read. */
  private catalogRecord(agentId: string): RegisteredSession | null {
    if (!SAFE_ID.test(agentId)) return null
    const file = join(this.directory, `${agentId}.json`)
    const before = lstatSync(file, { bigint: true })
    const fingerprint = catalogFingerprint(before)
    const cached = this.catalogCache.get(agentId)
    const now = Date.now()
    // Some mounted filesystems have coarse timestamps. Bound reuse even when
    // their metadata cannot distinguish two writes; no background timer is needed.
    if (cached?.fingerprint === fingerprint && now >= cached.at && now - cached.at < CATALOG_CACHE_MS) {
      return structuredClone(cached.session)
    }
    this.forgetCatalogRecord(agentId)
    const session = this.get(agentId)
    const bytes = Number(before.size)
    if (session && this.catalogCache.size < CATALOG_CACHE_RECORDS
      && this.catalogCacheBytes + bytes <= CATALOG_CACHE_BYTES
      && catalogFingerprint(lstatSync(file, { bigint: true })) === fingerprint) {
      this.catalogCache.set(agentId, { fingerprint, bytes, at: now, session: structuredClone(session) })
      this.catalogCacheBytes += bytes
    }
    return session
  }

  private forgetCatalogRecord(agentId: string): void {
    const cached = this.catalogCache.get(agentId)
    if (!cached) return
    this.catalogCacheBytes -= cached.bytes
    this.catalogCache.delete(agentId)
  }

  private write<T>(apply: () => T): T {
    secureStateDirectory(dirname(this.directory))
    return withRegistryFileLock(apply, this.directory)
  }

  /** Ordinary snapshots cannot erase or replace an archived control reservation.
   * Control changes require the original saved row's explicit strict transition. */
  save(session: RegisteredSession): void {
    this.write(() => this.saveUnlocked(session))
  }

  private saveUnlocked(session: RegisteredSession): void {
    if (!SAFE_ID.test(session.agentId)) throw new Error('Invalid stopped harness identity.')
    if (this.uncertain.has(session.agentId)) throw Error('Waiting for the original saved native control publication.')
    // An exited engine leaves its pane as a shell. Stopping that shell must keep
    // the conversation saved before releaseEngine cleared its binding/profile.
    const previous = this.get(session.agentId)
    if (previous?.nativeControl && JSON.stringify(previous.nativeControl) !== JSON.stringify(session.nativeControl)) {
      throw Error('Waiting to preserve the original saved native cancellation.')
    }
    if (isTerminalEngine(session.engine) && previous) return
    // A temporarily unbound observation of the SAME process cannot erase a known conversation.
    // A replacement process must earn its own binding; never carry history across PID reuse.
    if (!session.sessionId && previous?.sessionId && previous.engine === session.engine
      && session.registeredAt === previous.registeredAt
      && (session.codexHome ?? null) === (previous.codexHome ?? null)
      && (!session.hermesHome || session.hermesHome === previous.hermesHome)
      && sameProcessIdentity(session.processIdentity, previous.processIdentity)
      && session.processIdentity!.executable === previous.processIdentity!.executable) {
      session = { ...session, sessionId: previous.sessionId, transcriptPath: previous.transcriptPath,
        hermesHome: previous.hermesHome, boundAt: previous.boundAt, source: previous.source }
    }
    // With optional readers absent, Stop can capture a path the live row has not learned.
    // Hooks during its checkpoint and the final forget both save that pathless row. They
    // must not erase the captured path, or Close succeeds but Resume loses the conversation.
    if (session.sessionId && !session.transcriptPath && previous?.transcriptPath
      && session.sessionId === previous.sessionId && session.engine === previous.engine
      && session.registeredAt === previous.registeredAt
      && (session.codexHome ?? null) === (previous.codexHome ?? null)
      && (session.hermesHome ?? null) === (previous.hermesHome ?? null)
      && sameProcessIdentity(session.processIdentity, previous.processIdentity)
      && session.processIdentity!.executable === previous.processIdentity!.executable) {
      session = { ...session, transcriptPath: previous.transcriptPath }
    }
    secureStateDirectory(dirname(this.directory))
    secureStateDirectory(this.directory)
    const snapshot = {
      ...session,
      active: false,
      launch: { state: 'ready' },
      defaultName: projectDisplayName(session),
      touchedAt: Date.now(),
    }
    // A later Resume is an explicit new visit, never an instruction to close it again.
    delete snapshot.closePlan
    // A hold describes this daemon's current observation, never durable conversation evidence.
    delete snapshot.admissionHold
    delete snapshot.identityHold
    delete snapshot.interpretationHold
    delete snapshot.evidenceRevision
    // A snapshot without a tmux pane omits the legacy alias just like registry persistence.
    if (!snapshot.tmuxPane) delete (snapshot as Partial<RegisteredSession>).tmuxPane
    const retained = previous ? this.inspectControl(previous) : undefined
    atomicWriteJson(join(this.directory, `${session.agentId}.json`), { version: 1, session: snapshot }, false, () => {
      retained?.verify()
    })
    this.forgetCatalogRecord(session.agentId)
  }

  /** Correct one field of an archive in place — the folder a Claude row drifted out of (cwdRepair.ts).
   *  Not `save`: that recomputes the name and stamps `touchedAt`, and a repair must not reorder the
   *  catalog or rename anything. Nothing else on the row changes. */
  patch(agentId: string, patch: Partial<Pick<RegisteredSession, 'cwd'>>): boolean {
    return this.write(() => this.patchUnlocked(agentId, patch))
  }

  private patchUnlocked(agentId: string, patch: Partial<Pick<RegisteredSession, 'cwd'>>): boolean {
    if (this.uncertain.has(agentId)) throw Error('Waiting for the original saved native control publication.')
    const saved = this.get(agentId)
    if (!saved) return false
    const retained = this.inspectControl(saved)
    secureStateDirectory(dirname(this.directory))
    secureStateDirectory(this.directory)
    atomicWriteJson(join(this.directory, `${agentId}.json`), { version: 1, session: { ...saved, ...patch } }, false, retained.verify)
    this.forgetCatalogRecord(agentId)
    return true
  }

  /** Reserve before tmux allocation. A crash between allocation and registry persistence
   * must not permit a second process under a new request/receipt ID. */
  beginResume(agentId: string): string | null {
    return this.write(() => this.beginResumeUnlocked(agentId))
  }

  private beginResumeUnlocked(agentId: string): string | null {
    if (!SAFE_ID.test(agentId)) throw new Error('Invalid saved harness identity.')
    secureStateDirectory(dirname(this.directory))
    secureStateDirectory(this.directory)
    const file = join(this.directory, `${agentId}.resume`)
    let fd: number
    try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null; throw error }
    const token = randomUUID()
    try { writeFileSync(fd, JSON.stringify({ token })); fsyncSync(fd) } finally { closeSync(fd) }
    this.syncDirectory()
    return token
  }

  /**
   * When the reservation for this agent was taken, or null if there is none.
   *
   * The reservation's whole job is to outlive a crash, so the caller needs to know how long it has
   * been held: one taken by an operation that cannot still be running is protecting nothing, and a
   * harness whose reservation is never released can never be resumed again.
   */
  resumeReservedAt(agentId: string): number | null {
    if (!SAFE_ID.test(agentId)) return null
    try { return statSync(join(this.directory, `${agentId}.resume`)).mtimeMs } catch { return null }
  }

  /**
   * Clear only a verified outcome. Unknown allocation/readiness keeps its reservation.
   *
   * `token` asks for the reservation to be cleared only if it is still the caller's own, which can
   * only be answered by parsing the marker. Without one the caller is clearing it unconditionally,
   * so the CONTENTS are not parsed — a reservation left behind by a crash can be half-written, and
   * refusing to clear THAT is refusing exactly the case a takeover exists for. The file is still
   * opened the same guarded way either way, so a symlink or anything else unsafe in its place
   * fails closed rather than being unlinked on trust.
   */
  finishResume(agentId: string, token?: string, authority?: SavedNativeControlFence): void {
    this.write(() => this.finishResumeUnlocked(agentId, token, authority))
  }

  private finishResumeUnlocked(agentId: string, token?: string, authority?: SavedNativeControlFence): void {
    if (!SAFE_ID.test(agentId)) return
    const file = join(this.directory, `${agentId}.resume`)
    let marker: ReturnType<typeof inspectNativeControlFile>
    try {
      secureStateDirectory(this.directory, false)
      marker = inspectNativeControlFile(file, this.directory)
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (token !== undefined && JSON.parse(marker.content!).token !== token) return
    const saved = this.get(agentId)
    if (this.uncertain.has(agentId) || saved?.nativeControl && !authority) {
      throw Error('Waiting to confirm the exact native resume handoff before clearing its reservation.')
    }
    const retained = saved ? this.inspectControl(saved) : undefined
    authority?.verify()
    retained?.verify(); marker.verify()
    authority?.current()
    unlinkSync(file)
    this.syncDirectory()
  }

  private syncDirectory(): void {
    const fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }

  /** Permanent deletion is separate from Stop, which always retains this record. */
  remove(agentId: string): void {
    this.write(() => this.removeUnlocked(agentId))
  }

  private removeUnlocked(agentId: string): void {
    if (!SAFE_ID.test(agentId)) throw new Error('Invalid stopped harness identity.')
    if (!this.get(agentId)) return
    unlinkSync(join(this.directory, `${agentId}.json`))
    this.forgetCatalogRecord(agentId)
    this.syncDirectory()
  }

  /**
   * Sets a record aside because another harness owns its conversation now (core/agents/conversationOwners.ts).
   * Moved into `superseded/`, never deleted, so a wrong owner can be put back by hand; a reservation it left
   * goes with it, since nothing can resume a record that is not listed. Null when there is no such record.
   */
  supersede(agentId: string): RegisteredSession | null {
    return this.write(() => this.supersedeUnlocked(agentId))
  }

  private supersedeUnlocked(agentId: string): RegisteredSession | null {
    if (!SAFE_ID.test(agentId)) return null
    const saved = this.get(agentId)
    if (!saved) return null
    if (saved.nativeControl || this.uncertain.has(agentId)) throw Error('A native cancellation cannot be superseded automatically.')
    const aside = join(this.directory, 'superseded')
    secureStateDirectory(aside)
    renameSync(join(this.directory, `${agentId}.json`), join(aside, `${agentId}.json`))
    this.forgetCatalogRecord(agentId)
    this.finishResumeUnlocked(agentId)
    this.syncDirectory()
    return saved
  }

  /** Fresh saved-row authority. Catalog caches and age-based .resume takeover
   * never grant native rearm permission. Every recovered image is synced. */
  readNativeControl(input: RegisteredSession): { intent: NativeTurnIntent | undefined; verify(): void } {
    if (this.uncertain.has(input.agentId)) throw Error('Waiting for the original saved native control publication.')
    const proof = this.inspectControl(input)
    proof.confirm(() => {})
    return proof
  }

  private inspectControl(input: RegisteredSession) {
    if (!SAFE_ID.test(input.agentId)) throw Error('Invalid stopped harness identity.')
    const original = structuredClone(input), file = join(this.directory, `${original.agentId}.json`)
    const retained = inspectNativeControlFile(file, this.directory)
    const raw = JSON.parse(retained.content!), saved = raw.version === 1 && strictPersistedRow(raw.session)
    if (!saved || nativeTurnTarget(saved) !== nativeTurnTarget(original)
      || JSON.stringify(saved.nativeControl) !== JSON.stringify(original.nativeControl)) {
      throw Error('The original saved native control owner changed.')
    }
    retained.verify()
    return { ...retained, intent: saved.nativeControl, saved }
  }

  commitNativeControl(input: RegisteredSession, value: NativeTurnIntent, authority: SavedNativeControlFence): RegisteredSession {
    const original = structuredClone(input), next = parseNativeTurnIntent(value)
    if (!next || !nativeTurnTransition(original, next)) throw Error('Invalid saved native control transition.')
    return this.write(() => {
      const file = join(this.directory, `${original.agentId}.json`)
      if (!SAFE_ID.test(original.agentId)) throw Error('Invalid stopped harness identity.')
      let pending = this.uncertain.get(original.agentId)
      const retained = inspectNativeControlFile(file, this.directory)
      if (pending) {
        pending.verifyDirectory()
        if (nativeTurnTarget(pending.candidate) !== nativeTurnTarget(original)
          || JSON.stringify(pending.candidate.nativeControl) !== JSON.stringify(next)
          || retained.content !== pending.before && retained.content !== pending.bytes) {
          throw Error('Waiting for the exact original saved native control publication.')
        }
      } else {
        // A retry in a new core may see its prior publication. The exact request
        // still has to confirm that image before obtaining launch authority.
        const raw = JSON.parse(retained.content!), saved = raw.version === 1 && strictPersistedRow(raw.session)
        if (!saved || nativeTurnTarget(saved) !== nativeTurnTarget(original)
          || JSON.stringify(saved.nativeControl) !== JSON.stringify(original.nativeControl)
            && JSON.stringify(saved.nativeControl) !== JSON.stringify(next)) throw Error('The original saved native control owner changed.')
        if (this.uncertain.size >= 256) throw Error('Waiting for saved native control confirmation capacity.')
        const candidate = { ...saved, schemaVersion: 3 as const, nativeControl: next }
        pending = { before: retained.content!, candidate, bytes: JSON.stringify({ version: 1, session: candidate }, null, 2),
          verifyDirectory: retained.verifyDirectory }
        this.uncertain.set(original.agentId, pending)
      }
      const beforeCommit = () => { authority.verify(); pending.verifyDirectory(); retained.verify(); authority.current() }
      beforeCommit()
      if (retained.content !== pending.bytes) atomicWriteJson(file, { version: 1, session: pending.candidate }, false, beforeCommit)
      pending.verifyDirectory()
      const committed = this.inspectControl(pending.candidate)
      committed.confirm(() => { authority.verify(); pending.verifyDirectory(); authority.current() })
      committed.verify(); pending.verifyDirectory(); authority.current()
      this.uncertain.delete(original.agentId); this.forgetCatalogRecord(original.agentId)
      return structuredClone(committed.saved)
    })
  }

  /** Suppress archives whose identity or conversation is already running. */
  available(live: readonly RegisteredSession[]): RegisteredSession[] {
    const ids = new Set(live.map(session => session.agentId))
    const conversations = new Set(live.filter(session => session.sessionId).map(session =>
      `${session.engine}\0${session.codexHome ?? ''}\0${session.sessionId}`))
    return this.list().filter(session => !ids.has(session.agentId)
      && (!session.sessionId || !conversations.has(`${session.engine}\0${session.codexHome ?? ''}\0${session.sessionId}`)))
  }
}

export const stoppedAgents = new StoppedAgentStore()
