/** Eager turn state for one immutable native incarnation. Optional readers may
 * decorate its history; they cannot choose a turn or release its input. */
import { createHash } from 'node:crypto'
import { createNativeGenerations, type NativeGeneration, type NativeGenerationOwner,
  type NativeGenerationSource, type NativeGenerationView } from './nativeGenerations.js'
import { EMPTY_NATIVE_CONTENT, nativeGenerationContent, type NativeGenerationContent } from './nativeGenerationContent.js'

export interface NativeTurn {
  readonly owner: NativeGenerationOwner
  readonly generation: NativeGeneration
  readonly content: NativeGenerationContent
  /** Idempotent presentation identity. It never grants a physical effect. */
  readonly version: string
}
export interface NativeTurnState {
  readonly owner: NativeGenerationOwner
  readonly selection: NativeGenerationView['selection']
  readonly turns: readonly NativeTurn[]
  /** The first reconstructed state is always quiet, including terminal facts. */
  readonly recovered: boolean
  readonly cancelRequested: boolean
}
export interface NativeTurnControlDeps {
  owner: NativeGenerationOwner
  /** Includes binding and any durable explicit rearm relation. A new PID alone
   * must never make this true for a cancelled incarnation's replacement. */
  current(): boolean
  read(owner: NativeGenerationOwner): Promise<NativeGenerationSource>
  /** Core ports are synchronous and idempotent. Each use of state is fenced by
   * verify; deferred consumers must obtain a new permit after their own waits. */
  publish(state: NativeTurnState, verify: () => void): void
  revoke(owner: NativeGenerationOwner): void
  held(owner: NativeGenerationOwner, reason: string): void
  /** A monotonic clock; wall-clock corrections cannot extend an inspection. */
  now?(): number
  readWaitMs?: number
  retryMs?: number
}
const scope = (owner: NativeGenerationOwner) => JSON.stringify([owner.agentId, owner.sessionId, owner.processKey])
function unavailable(reason: string): never { throw Error(`Waiting for native turn control: ${reason}.`) }

export function createNativeTurnControl({ owner, current, read, publish, revoke, held,
  now = () => performance.now(), readWaitMs = 5000, retryMs = 1000,
}: NativeTurnControlDeps) {
  if (!Number.isFinite(readWaitMs) || readWaitMs <= 0 || readWaitMs > 5000
    || !Number.isFinite(retryMs) || retryMs <= 0 || retryMs > 60_000) unavailable('the retry or read deadline is invalid')
  const original = Object.freeze({ ...owner }), identity = scope(original)
  let revision = 0, closed = false, pending = true, cancelled = false, published = false, dirty = false
  let running: Promise<void> | undefined, retry: ReturnType<typeof setTimeout> | undefined
  type Inspection = { view: NativeGenerationView; turns: readonly NativeTurn[]; verify(): void }
  let reading: { version: number; result: Promise<Inspection>; check(): void; reject(error: Error): void } | undefined
  const live = () => !closed && current()
  const check = (version: number) => { if (!live() || version !== revision) unavailable('the original control revision changed') }
  const hold = (reason: string) => {
    if (!live()) return
    try { held(original, reason) } catch (error) { console.warn('[native-turn] hold notification failed', error) }
  }
  const revokeEffects = () => {
    try { revoke(original) } catch { hold('The original native effects could not be revoked at their consumer.') }
  }
  const invalidate = () => {
    revision++
    reading?.reject(Error('Waiting for native turn control: the original control revision changed.'))
    revokeEffects()
  }
  const inspect = async (version: number): Promise<Inspection> => {
    check(version)
    if (reading) {
      if (reading.version !== version) unavailable('the previous native generation read has not settled')
      reading.check()
      return reading.result
    }
    const deadline = now() + readWaitMs
    let resolve!: (value: Inspection) => void, reject!: (error: unknown) => void
    const result = new Promise<Inspection>((yes, no) => { resolve = yes; reject = no })
    const expire = () => {
      const error = Error('Waiting for native turn control: the native generation read deadline expired.')
      reject(error)
      if (reading?.result === result && live() && version === revision) { invalidate(); hold(error.message) }
      return error
    }
    const checkRead = () => {
      check(version)
      if (now() >= deadline) throw expire()
    }
    const timer = setTimeout(expire, readWaitMs)
    reading = { version, result, check: checkRead, reject: error => { clearTimeout(timer); reject(error) } }
    // Every reader, including permits, shares this actual I/O slot. Waiters can
    // leave on revocation or timeout, but only I/O settlement releases the slot.
    const settle = () => { clearTimeout(timer); reading = undefined; if (dirty) schedule() }
    void (async () => {
      const source = await read(original)
      checkRead()
      if (scope(source.owner) !== identity) unavailable('the source belongs to another owner')
      // Copy native content before the scalar projection's await as well.
      const content = nativeGenerationContent(source)
      const view = await createNativeGenerations({ owner: original, current: () => live() && version === revision,
        read: async () => source }).inspect()
      const verify = () => { checkRead(); view.verify(); checkRead() }
      verify()
      if (view.selection === 'cancelled' && !cancelled) { cancelled = true; revokeEffects() }
      const turns = Object.freeze(view.generations.map(generation => {
        const fields = { owner: original, generation, content: content.get(generation.id) ?? EMPTY_NATIVE_CONTENT }
        return Object.freeze({ ...fields, version: createHash('sha256').update(JSON.stringify(fields)).digest('hex') })
      }))
      verify()
      return { view, turns, verify }
    })().then(value => { settle(); resolve(value) }, error => { settle(); reject(error) })
    return result
  }
  const schedule = () => {
    if (!live() || pending || retry || reading) return
    retry = setTimeout(() => { retry = undefined; void refresh() }, retryMs)
  }
  const refresh = (): Promise<void> => {
    if (!live() || pending) return Promise.resolve()
    dirty = true
    if (running) return running
    const version = revision
    dirty = false
    running = (async () => {
      try {
        const state = await inspect(version)
        state.verify()
        publish(Object.freeze({ owner: original, selection: cancelled ? 'cancelled' : state.view.selection, turns: state.turns,
          recovered: !published, cancelRequested: cancelled }), state.verify)
        state.verify()
        published = true
      } catch (error) {
        if (live() && version === revision) hold(error instanceof Error ? error.message : String(error))
        dirty = true
      } finally {
        running = undefined
        if (dirty) schedule()
      }
    })()
    return running
  }
  const observe = (source: NativeGenerationSource, admissionPending: boolean): void => {
    if (!live()) return
    invalidate()
    pending = true
    if (scope(source.owner) !== identity) unavailable('the notification belongs to another owner')
    source.verify()
    pending = admissionPending
    if (retry) { clearTimeout(retry); retry = undefined }
    if (pending) { hold('Native hook admission is still pending.'); return }
    void refresh()
  }
  /** Call after optional preparation, immediately before a scoped effect. The
   * returned verifier is checked again at its actual dispatch, after any waits.
   * Presentation recovery never invokes this method or repeats one-shot work. */
  const permit = async (generationId: string, purpose: 'running' | 'terminal' | 'recap') => {
    if (pending || cancelled) unavailable('admission or Cancel holds this incarnation')
    const version = revision, state = await inspect(version)
    const turn = state.turns.find(candidate => candidate.generation.id === generationId)
    if (!turn) unavailable('the requested generation has no effect authority')
    if (purpose === 'running' ? !turn.generation.running : !turn.generation.terminal) unavailable('the generation is not in the requested state')
    if (purpose === 'recap' && (turn.generation.terminal !== 'completed' || turn.content.response.state !== 'available')) {
      unavailable('this generation has no unambiguous completed response')
    }
    const verify = () => {
      state.verify()
      if (cancelled) unavailable('Cancel holds this incarnation')
    }
    verify()
    return Object.freeze({ turn, verify })
  }
  return {
    observe, refresh, permit,
    /** This is immediate local revocation, not confirmation that Cancel was
     * saved or dispatched. Only the durable Cancel port can supply that proof. */
    cancel: () => { if (live()) { cancelled = true; invalidate(); hold('Waiting for the saved native cancellation result.'); } },
    close: () => { if (!closed) { closed = true; invalidate(); if (retry) clearTimeout(retry); retry = undefined } },
  }
}
