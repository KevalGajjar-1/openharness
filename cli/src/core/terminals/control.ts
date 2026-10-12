/**
 * Terminal control: reading a pane and typing, submitting and sending keys to it, through a control
 * lease: a short one that lapses after 15 s of quiet, or one pinned for as long as a caller holds the
 * pane (a question being answered, a sequence of keys). A pinned lease that stops validating is not
 * quietly replaced: every later action on that pane fails until it is unpinned, so a sequence never
 * continues in a pane that changed under it.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 2: docs/design/2026-10-03-harnessd.md).
 */
import type { RegisteredSession } from '../../lib/registry.js'
import type { TerminalBackendCoordinator } from '../../lib/terminalBackendCoordinator.js'
import { TERMINAL_LEASE_REFUSED, TerminalWriteHeld, terminalActionNotStarted, type SubmitOptions, type TerminalActionResult, type TerminalWrite } from '../../lib/terminalTypes.js'
import { paneReadIdentity } from '../transcripts/readIdentity.js'
import { launchBound } from '../engines/sessionBinding.js'
import { createTerminalWriter, type TerminalWriter } from './writer.js'

export type TerminalControlBackend = Pick<TerminalBackendCoordinator,
  'acquireLease' | 'validateLease' | 'capture' | 'captureLease' | 'submitText' | 'submitTextLease'
  | 'submitTextForLease' | 'typeLiteralLease' | 'sendLegacyKeyLease' | 'validate'>

export interface TerminalControlDeps {
  /** The agent a target names: its agent id, session id or pane. */
  resolve: (target: string) => RegisteredSession | undefined
  terminals: TerminalControlBackend
  writer?: TerminalWriter
}

export function createTerminalControl({ resolve, terminals, writer = createTerminalWriter() }: TerminalControlDeps) {
  const terminalSession = (target: string): RegisteredSession | undefined => resolve(target)
  const controlLeases = new Map<string, { lease: Awaited<ReturnType<typeof terminals.acquireLease>> & { state: 'succeeded' }; expiresAt: number }>()
  const pinnedControls = new Set<string>()
  const invalidControls = new Set<string>()
  const pinnedWrites = new Map<string, TerminalWrite>()
  const writeFor = (agentId: string): TerminalWrite => pinnedWrites.get(agentId) ?? writer.ticket(agentId)
  // Retain the original owner through queueing, worker reads and retries. A launch
  // may bind its first conversation once; that allowance cannot follow a rotation.
  const writeTicket = (target: string): TerminalWrite => {
    let original = terminalSession(target)
    original = original && structuredClone(original)
    const write = writeFor(original?.agentId ?? target)
    const allowed = () => {
      if (!original || !write.allowed()) return false
      const current = resolve(original.agentId)
      if (paneReadIdentity(original) !== paneReadIdentity(current)) {
        if (!current || typeof current.boundAt !== 'number' || !current.sessionId || launchBound(original, current) !== current) return false
        // Only first-binding fields may change. launchBound alone also accepts
        // an unbound row and would launder a changed route or identity hold.
        const beforeBinding = { ...current, sessionId: original.sessionId, boundAt: original.boundAt,
          transcriptPath: original.transcriptPath, processIdentity: original.processIdentity }
        if (paneReadIdentity(beforeBinding) !== paneReadIdentity(original)) return false
        original = structuredClone(current)
      }
      return write.allowed()
    }
    return { allowed, dispatch: operation => write.dispatch(() => {
      if (!allowed()) throw new TerminalWriteHeld('terminal control revoked')
      return operation()
    }) }
  }
  const CONTROL_LEASE_IDLE_MS = 15_000
  const leasedTerminal = async (session: RegisteredSession): Promise<Extract<Awaited<ReturnType<typeof terminals.acquireLease>>, { state: 'succeeded' }> | null> => {
    const pin = pinnedWrites.get(session.agentId), pinned = !!pin
    if (pinned && invalidControls.has(session.agentId)) return null
    const current = controlLeases.get(session.agentId)
    if (current && (pinned || current.expiresAt > Date.now())) {
      if (!await terminals.validateLease(current.lease.value, session)) {
        if (controlLeases.get(session.agentId) === current) controlLeases.delete(session.agentId)
        if (pin && pinnedWrites.get(session.agentId) === pin) invalidControls.add(session.agentId)
        return null
      }
      current.expiresAt = Date.now() + CONTROL_LEASE_IDLE_MS
      return current.lease
    }
    controlLeases.delete(session.agentId)
    const acquired = await terminals.acquireLease(session)
    if (acquired.state !== 'succeeded') return null
    const value = { lease: acquired, expiresAt: Date.now() + CONTROL_LEASE_IDLE_MS }
    if (!controlLeases.has(session.agentId) && pinnedWrites.get(session.agentId) === pin) controlLeases.set(session.agentId, value)
    return acquired
  }
  const pinTerminalControl = (target: string): (() => void) | null => {
    const session = terminalSession(target)
    if (!session || pinnedControls.has(session.agentId)) return null
    const agentId = session.agentId, original = writer.ticket(agentId)
    const allowed = () => pinnedWrites.get(agentId) === write && original.allowed()
    const write: TerminalWrite = { allowed, dispatch: operation => original.dispatch(() => {
      if (!allowed()) throw new TerminalWriteHeld('terminal control revoked')
      return operation()
    }) }
    pinnedControls.add(agentId)
    pinnedWrites.set(agentId, write)
    invalidControls.delete(agentId)
    return () => {
      if (pinnedWrites.get(agentId) !== write) return
      pinnedControls.delete(agentId)
      pinnedWrites.delete(agentId)
      invalidControls.delete(agentId)
      controlLeases.delete(agentId)
    }
  }
  const invalidateTerminalControl = (agentId: string): void => {
    controlLeases.delete(agentId)
    if (pinnedControls.has(agentId)) invalidControls.add(agentId)
  }
  const captureTerminal = async (target: string, historyLines?: number): Promise<string | null> => {
    const session = terminalSession(target)
    if (!session) return null
    // Registry rows (including their runtime/process objects) can change in place while tmux reads.
    // Copy the identity before yielding so no caller interprets an old pane as the new conversation.
    const agentId = session.agentId, identity = paneReadIdentity(session)
    const current = () => paneReadIdentity(resolve(agentId)) === identity
    const pinned = pinnedControls.has(session.agentId)
    if (pinned && invalidControls.has(session.agentId)) return null
    let activeLease = controlLeases.get(session.agentId)
    if (activeLease && !pinned && activeLease.expiresAt <= Date.now()) {
      controlLeases.delete(session.agentId)
      activeLease = undefined
    }
    const leased = activeLease || pinned ? await leasedTerminal(session) : null
    if ((activeLease || pinned) && !leased) return null
    if (!current()) return null
    const result = leased
      ? await terminals.captureLease(leased.value, { historyLines })
      : await terminals.capture(session, { historyLines })
    return result.state === 'succeeded' && current() ? result.value : null
  }
  const terminalActionSucceeded = (result: Awaited<ReturnType<typeof terminals.submitText>>): boolean =>
    result.state === 'succeeded'
  const submitTerminalAction = async (target: string, text: string, options?: SubmitOptions): Promise<TerminalActionResult> => {
    const session = terminalSession(target)
    if (!session) return terminalActionNotStarted('terminal agent is unavailable')
    const original = structuredClone(session)
    const pin = pinnedWrites.get(original.agentId)
    const write = writeTicket(original.agentId), previous = options
    options = { ...previous, allowed: () => (!previous?.allowed || previous.allowed()) && write.allowed(),
      dispatch: previous?.dispatch ?? write.dispatch }
    const lease = await leasedTerminal(original)
    if (!lease) return terminalActionNotStarted(TERMINAL_LEASE_REFUSED)
    if (options?.allowed && !options.allowed()) return terminalActionNotStarted('terminal control revoked')
    const result = pinnedControls.has(session.agentId)
      ? await terminals.submitTextLease(lease.value, text, options)
      : await terminals.submitTextForLease(original, lease.value, text, options)
    if (result.state !== 'succeeded' && pin && pinnedWrites.get(original.agentId) === pin) invalidateTerminalControl(original.agentId)
    return result
  }
  const submitTerminal = async (target: string, text: string, options?: SubmitOptions): Promise<boolean> => {
    return terminalActionSucceeded(await submitTerminalAction(target, text, options))
  }
  const typeTerminal = async (target: string, text: string): Promise<boolean> => {
    const session = terminalSession(target)
    if (!session) return false
    const original = structuredClone(session), identity = paneReadIdentity(original), ticket = writeFor(original.agentId)
    const pin = pinnedWrites.get(original.agentId)
    const current = () => paneReadIdentity(resolve(original.agentId)) === identity && ticket.allowed()
    const write = { allowed: current, dispatch: ticket.dispatch }
    const lease = await leasedTerminal(original)
    if (!lease) return false
    if (!write.allowed()) return false
    const succeeded = terminalActionSucceeded(await terminals.typeLiteralLease(lease.value, text, write))
    if (!succeeded && pin && pinnedWrites.get(original.agentId) === pin) invalidateTerminalControl(original.agentId)
    return succeeded
  }
  const keyTerminalAction = async (target: string, key: string, allowed?: () => boolean, write?: TerminalWrite): Promise<TerminalActionResult> => {
    const session = terminalSession(target)
    if (!session) return terminalActionNotStarted('terminal session is unavailable')
    const ticket = write ?? writeFor(session.agentId)
    const original = structuredClone(session), identity = paneReadIdentity(original)
    const pin = pinnedWrites.get(original.agentId)
    // A native verifier can perform synchronous filesystem reads. Check the cheap
    // original owner and interrupt deadline again after it, at the spawn boundary.
    const current = () => (!allowed || allowed()) && paneReadIdentity(resolve(original.agentId)) === identity && ticket.allowed()
    const lease = await leasedTerminal(original)
    if (!lease) return terminalActionNotStarted(TERMINAL_LEASE_REFUSED)
    if (!current()) return terminalActionNotStarted('terminal control revoked')
    const result = await terminals.sendLegacyKeyLease(lease.value, key, { allowed: current, dispatch: ticket.dispatch })
    if (result.state !== 'succeeded' && pin && pinnedWrites.get(original.agentId) === pin) invalidateTerminalControl(original.agentId)
    return result
  }
  const keyTerminal = async (target: string, key: string, allowed?: () => boolean): Promise<boolean> => {
    return terminalActionSucceeded(await keyTerminalAction(target, key, allowed))
  }
  const validateTerminal = async (session: RegisteredSession): Promise<boolean> =>
    (await terminals.validate(session)).state === 'alive'
  /**
   * Whether a session's terminal is known to be gone: the agent is dormant, tmux has no such pane, or
   * another process is in it. Not the same question as `validateTerminal`, which is the one to ask before
   * writing to a pane: a probe that could not answer (it timed out, or the process table could not be
   * read) is no reason to write, and no evidence either that the terminal is gone.
   */
  const terminalGone = async (session: RegisteredSession): Promise<boolean> =>
    (await terminals.validate(session)).state === 'gone'
  return {
    pinnedControls, pinTerminalControl, invalidateTerminalControl, captureTerminal, submitTerminalAction,
    submitTerminal, typeTerminal, keyTerminalAction, keyTerminal, validateTerminal, terminalGone,
    writer, writeTicket,
  }
}

export type TerminalControl = ReturnType<typeof createTerminalControl>
