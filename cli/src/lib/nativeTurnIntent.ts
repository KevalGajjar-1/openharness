/** Durable admission state belongs to the agent, even when recovery changes its
 * process. The process journal remains the only authority for physical Cancel. */
import { createHash } from 'node:crypto'
import { validNativeGenerationCancellation, type NativeGenerationCancellation } from '../engines/kit/nativeGenerationCancellation.js'
import type { RegisteredSession } from './registry.js'

export interface NativeTurnIntent {
  readonly version: 1
  readonly cancel: {
    /** Null retains Cancel when no native owner was proven at request entry.
     * It grants no interrupt authority and can never be filled in by recovery. */
    readonly processKey: string | null
    readonly target: string
    readonly request: NativeGenerationCancellation
  }
  readonly rearm?: {
    readonly requestId: string
    readonly agentId: string
    readonly operation: 'restart' | 'resume'
    readonly target: string
    readonly launchToken: string
    readonly replacement?: { readonly processKey: string; readonly sessionId: string }
  }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string) => Object.keys(value).sort().join(',') === keys
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
const processKey = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
const token = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,96}$/.test(value)
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

/** No caller may normalize unknown control data into an uncancelled agent.
 * Archives can have a new row ID: preserve the original Cancel owner verbatim. */
export function parseNativeTurnIntent(value: unknown): NativeTurnIntent | null {
  if (!object(value) || value.version !== 1 || !exact(value, value.rearm === undefined ? 'cancel,version' : 'cancel,rearm,version')) return null
  const cancel = value.cancel
  if (!object(cancel) || !exact(cancel, 'processKey,request,target') || cancel.processKey !== null && !processKey(cancel.processKey)
    || !digest(cancel.target) || !validNativeGenerationCancellation(cancel.request)) return null
  if (cancel.processKey === null && cancel.request.frontier.index !== -1) return null
  const rearm = value.rearm
  if (rearm !== undefined) {
    if (!object(rearm) || !exact(rearm, rearm.replacement === undefined
      ? 'agentId,launchToken,operation,requestId,target' : 'agentId,launchToken,operation,replacement,requestId,target')
      || !token(rearm.requestId) || !identifier(rearm.agentId) || (rearm.operation !== 'restart' && rearm.operation !== 'resume')
      || !digest(rearm.target) || !token(rearm.launchToken)) return null
    if (rearm.replacement !== undefined && (!object(rearm.replacement) || !exact(rearm.replacement, 'processKey,sessionId')
      || !processKey(rearm.replacement.processKey) || rearm.replacement.processKey === cancel.processKey
      || !identifier(rearm.replacement.sessionId))) return null
  }
  const copied = structuredClone(value) as unknown as NativeTurnIntent
  Object.freeze(copied.cancel.request.frontier); Object.freeze(copied.cancel.request); Object.freeze(copied.cancel)
  if (copied.rearm) { if (copied.rearm.replacement) Object.freeze(copied.rearm.replacement); Object.freeze(copied.rearm) }
  return Object.freeze(copied)
}

/** Persistent fields only: transient holds and observation counters cannot
 * change the identity of the original durable launch/cancellation target. */
export function nativeTurnTarget(row: RegisteredSession): string {
  return createHash('sha256').update(JSON.stringify([row.agentId, row.registeredAt, row.engine, row.sessionId, row.boundAt,
    row.active, row.processIdentity && [row.processIdentity.pid, row.processIdentity.executable, row.processIdentity.startMarker, row.processIdentity.startTicks ?? null],
    row.runtimes.map(route => [route.backend, route.paneId]), row.primaryRuntimeKey, row.tmuxPane ?? null, row.cwd,
    row.transcriptPath, row.codexHome ?? null, row.hermesHome ?? null])).digest('hex')
}

export function nativeTurnAdmitted(intent: NativeTurnIntent | undefined, owner: { agentId: string; sessionId: string; processKey: string }): boolean {
  if (!intent) return true
  return intent.rearm?.agentId === owner.agentId && intent.rearm.replacement?.processKey === owner.processKey
    && intent.rearm.replacement.sessionId === owner.sessionId
}

/** A proof supplied by a caller can confirm native facts, but cannot skip the
 * durable reservation or replace its original Cancel/launch identity. */
export function nativeTurnTransition(row: RegisteredSession, next: NativeTurnIntent): boolean {
  const previous = row.nativeControl
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const cancel = () => !next.rearm && next.cancel.target === nativeTurnTarget(row)
    && next.cancel.request.agentId === row.agentId && next.cancel.request.conversationId === row.sessionId
  if (!previous) return cancel()
  // Compare fields independently of caller property order.
  const originalCancel = (value: NativeTurnIntent['cancel']) => [value.processKey, value.target, value.request.requestId,
    value.request.nonce, value.request.agentId, value.request.conversationId, value.request.frontier.index, value.request.frontier.digest]
  if (!same(originalCancel(previous.cancel), originalCancel(next.cancel))) {
    // A newly admitted replacement may itself be cancelled. An unknown owner
    // never becomes known by filling in the old request after recovery.
    return !!previous.rearm?.replacement && cancel()
      && next.cancel.request.requestId !== previous.cancel.request.requestId
      && (next.cancel.processKey === null || next.cancel.processKey === previous.rearm.replacement.processKey)
  }
  const reserved = previous.rearm, proposed = next.rearm
  if (!reserved) return !proposed || !proposed.replacement && proposed.agentId === row.agentId
    && proposed.target === nativeTurnTarget(row)
  if (!proposed || !same([reserved.requestId, reserved.agentId, reserved.operation, reserved.target, reserved.launchToken],
    [proposed.requestId, proposed.agentId, proposed.operation, proposed.target, proposed.launchToken])) return false
  if (reserved.replacement) return same([reserved.replacement.processKey, reserved.replacement.sessionId],
    proposed.replacement && [proposed.replacement.processKey, proposed.replacement.sessionId])
  return !proposed.replacement || proposed.agentId === row.agentId && proposed.replacement.sessionId === row.sessionId
}
