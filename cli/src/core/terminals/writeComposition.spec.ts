import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { TerminalBackendCoordinator } from '../../lib/terminalBackendCoordinator.js'
import { TmuxBackend } from '../../lib/tmuxBackend.js'
import { assumeTmuxVersion, resetTmuxVersionCache } from '../../lib/tmuxVersion.js'
import { inlineSubmission } from '../../testing/inlineSubmission.js'
import { readInlineScreen } from '../../testing/inlineScreen.js'
import { createInput, messageWriter, type InputDeps } from '../input.js'
import { createTerminalControl } from './control.js'
import { createTerminalWriter } from './writer.js'

// These are the only process functions the composed path may use. No fixture
// command can reach a host tmux server, engine home or daemon.
const native = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<object>(), ...native }))
vi.mock('child_process', async importOriginal => ({ ...await importOriginal<object>(), ...native }))
const held = <T = void>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve() }
const pane = '────────────\n❯\n────────────\n  ? for shortcuts'
const runtime = { backend: 'tmux' as const, paneId: '%1' }
const record = (): RegisteredSession => ({
  schemaVersion: 2, active: true, agentId: 'agent', sessionId: 'session', boundAt: 1, engine: 'claude', transcriptPath: null,
  projectDir: 'work', cwd: '/work', runtimes: [runtime], primaryRuntimeKey: 'tmux:%1', tmuxPane: '%1',
  source: null, title: null, model: null, cliVersion: null,
  processIdentity: { pid: 42, executable: 'claude', startMarker: 'fixture-start' },
  registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
})
beforeEach(() => { vi.useFakeTimers(); assumeTmuxVersion({ major: 3, minor: 7 }) })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); resetTmuxVersionCache() })

function setup(options: { now?: () => number } = {}) {
  const row = record(), calls: string[] = [], callbacks = new Map<string, () => void>()
  let pause = '', onCommand = (_command: string) => {}
  const complete = (command: string, done: () => void) => {
    onCommand(command)
    if (pause === command) callbacks.set(command, done)
    else queueMicrotask(done)
  }
  native.execFile.mockImplementation((file: string, args: string[], _options: unknown, done: (error: null, out: string, err: string) => void) => {
    expect(file).toBe('tmux')
    const command = args[0] === 'send-keys' ? args.at(-1)! : args[0]
    calls.push(command)
    complete(command, () => done(null, '', ''))
    return { kill: vi.fn() }
  })
  native.spawn.mockImplementation((file: string, args: string[]) => {
    expect(file).toBe('tmux'); expect(args[0]).toBe('load-buffer')
    const child = Object.assign(new EventEmitter(), { stdin: Object.assign(new EventEmitter(), {
      end: () => complete('load-buffer', () => child.emit('close', 0)),
    }), kill: vi.fn() })
    return child
  })
  const backend = new TmuxBackend()
  // The process/pane readings are fixed; all control, lease routing, paste, key
  // and Enter implementations run unchanged down to execFile/spawn above.
  vi.spyOn(backend, 'validate').mockResolvedValue({ state: 'alive' })
  const capture = vi.spyOn(backend, 'capture').mockResolvedValue({ state: 'succeeded', value: pane })
  const coordinator = new TerminalBackendCoordinator([backend], ['tmux'])
  const terminal = createTerminalControl({ resolve: () => row, terminals: coordinator, writer: createTerminalWriter(options) })
  const readScreen = vi.fn(readInlineScreen), promptTyped = vi.fn(), notifications = vi.fn()
  const deps: InputDeps = { resolve: () => row, byAgent: () => row, terminal, readScreen, promptTyped, submission: inlineSubmission,
    deliveries: { settled: vi.fn(), canWrite: () => true },
    device: () => ({ delivery: notifications, inputDispatched: vi.fn(), inputStatus: vi.fn(), agentGone: vi.fn() }),
    clients: { send: vi.fn(), sendCommander: vi.fn() }, agentIdFor: () => row.agentId, commandcode: () => undefined, emit: vi.fn() }
  const input = createInput(deps)
  const write = () => input.deviceInput.legacyWrite(row.agentId, ticket => messageWriter(deps)(row.agentId, 'hello', undefined, ticket))
  const cancel = () => input.deviceInput.interruptWrite(row.agentId,
    ticket => terminal.keyTerminalAction('session', 'C-c', ticket.allowed, ticket))
  return { row, calls, terminal, input, deps, readScreen, promptTyped, capture, write, cancel, notifications,
    pause: (command: string) => { pause = command }, finish: (command: string) => { callbacks.get(command)!(); callbacks.delete(command) },
    onCommand: (callback: typeof onCommand) => { onCommand = callback } }
}

it.each(['before paste', 'before Enter'] as const)('interrupts a message stalled in its worker %s and never resumes its old write', async phase => {
  const run = setup(), screen = held<Awaited<ReturnType<InputDeps['readScreen']>>>()
  if (phase === 'before paste') run.readScreen.mockImplementationOnce(() => screen.promise)
  else run.readScreen.mockImplementationOnce(readInlineScreen).mockImplementationOnce(() => screen.promise)
  const original = run.write(), cancelled = expect(original).rejects.toThrow('cancelled before completion')
  await flush()
  expect(run.calls).toEqual(phase === 'before paste' ? [] : ['paste-buffer'])
  await expect(run.cancel()).resolves.toMatchObject({ dispatch: 'executed' }); await cancelled
  screen.resolve(await readInlineScreen(run.row, pane)); await flush()
  expect(run.calls).toEqual(phase === 'before paste' ? ['C-c'] : ['paste-buffer', 'C-c'])
  expect(run.promptTyped).toHaveBeenCalledTimes(phase === 'before paste' ? 0 : 1)
})

it('waits for an actual paste to settle before C-c, while revoking its caller immediately', async () => {
  const run = setup(); run.pause('paste-buffer')
  const original = run.write(), cancelled = expect(original).rejects.toThrow('cancelled before completion')
  await flush(); expect(run.calls).toEqual(['paste-buffer'])
  const cancel = run.cancel(); await cancelled; await flush()
  expect(run.calls).toEqual(['paste-buffer'])
  run.finish('paste-buffer'); await cancel; await flush()
  expect(run.calls).toEqual(['paste-buffer', 'C-c'])
})

it('preserves first-conversation binding between paste and Enter, but never grants a later rotation', async () => {
  const run = setup()
  Object.assign(run.row, { sessionId: '', boundAt: null, launch: { state: 'ready' } })
  const ticket = run.terminal.writeTicket('session')
  run.onCommand(command => {
    if (command === 'paste-buffer') Object.assign(run.row, { sessionId: 'first', boundAt: 2, launch: undefined })
  })
  await expect(run.write()).resolves.toMatchObject({ dispatch: 'executed' })
  expect(run.calls).toEqual(['paste-buffer', 'Enter'])
  expect(ticket.allowed()).toBe(true)
  Object.assign(run.row, { sessionId: 'second', boundAt: 3 })
  expect(ticket.allowed()).toBe(false)
  const count = run.calls.length
  await expect(ticket.dispatch(async () => { run.calls.push('stale') })).rejects.toThrow('terminal control revoked')
  expect(run.calls).toHaveLength(count)
})

it.each(['conversation', 'runtime'] as const)('refuses a literal when its %s changes during buffer loading', async change => {
  const run = setup(); run.pause('load-buffer')
  const typed = run.terminal.typeTerminal('agent', 'filter'); await flush()
  if (change === 'conversation') run.row.sessionId = 'replacement'
  else run.row.runtimes = [{ backend: 'tmux', paneId: '%2' }]
  run.finish('load-buffer'); await expect(typed).resolves.toBe(false)
  expect(run.calls).toEqual(['delete-buffer'])
})

it('cannot use or release a replaced pinned scope after its delayed literal resumes', async () => {
  const run = setup(), releaseA = run.terminal.pinTerminalControl('session')!
  run.pause('load-buffer')
  const typed = run.terminal.typeTerminal('agent', 'filter'); await flush()
  releaseA(); const releaseB = run.terminal.pinTerminalControl('agent')!
  run.finish('load-buffer'); await expect(typed).resolves.toBe(false)
  releaseA()
  expect(run.terminal.pinnedControls.has('agent')).toBe(true)
  await expect(run.terminal.keyTerminal('session', 'Enter')).resolves.toBe(true)
  expect(run.calls).toEqual(['delete-buffer', 'Enter'])
  releaseB()
})

it('cannot regain a pinned sequence ticket after Cancel', async () => {
  const run = setup(), release = run.terminal.pinTerminalControl('session')!
  await run.cancel()
  await expect(run.terminal.typeTerminal('agent', 'filter')).resolves.toBe(false)
  await expect(run.terminal.keyTerminal('session', 'Enter')).resolves.toBe(false)
  expect(run.calls).toEqual(['C-c'])
  release()
})

it('checks the interrupt deadline after the final native proof immediately before spawn', async () => {
  let clock = 0, checks = 0
  const run = setup({ now: () => clock })
  await expect(run.input.deviceInput.interruptWrite('agent', ticket => run.terminal.keyTerminalAction('session', 'C-c',
    () => { if (++checks === 3) clock = 5000; return true }, ticket))).rejects.toThrow('deadline expired')
  expect(checks).toBe(3)
  expect(run.calls).toEqual([])
})

it('retains original authority for echo cleanup on an externally started Cursor turn', async () => {
  const run = setup(), capture = held<{ state: 'succeeded'; value: string }>()
  run.row.engine = 'cursor'
  run.capture.mockImplementationOnce(() => capture.promise)
  run.input.input.onTurnStarted('agent', 'hello'); await flush()
  await run.cancel()
  capture.resolve({ state: 'succeeded', value: '⠰ Working\n\n→ hello\nAuto' }); await flush()
  expect(run.calls).toEqual(['C-c'])
  run.input.input.forget('agent')
})

it('retains a queued message ticket across Cancel instead of obtaining a new one on drain', async () => {
  const run = setup(), release = run.input.input.acquireControl('agent', { forAnswer: true })!
  run.input.input.submit('agent', 'hello')
  await run.cancel(); release(); await flush()
  expect(run.calls).toEqual(['C-c'])
  expect(run.promptTyped).not.toHaveBeenCalled()
  run.input.input.forget('agent')
})

it.each(['cancelDelivery', 'forget'] as const)('revokes a device message during its worker read through %s', async action => {
  const run = setup(), screen = held<Awaited<ReturnType<InputDeps['readScreen']>>>()
  run.readScreen.mockImplementationOnce(readInlineScreen).mockImplementationOnce(() => screen.promise)
  run.input.deviceInput.submit('agent', 'hello', 'delivery'); await flush()
  expect(run.readScreen).toHaveBeenCalledTimes(2)
  if (action === 'cancelDelivery') expect(run.input.deviceInput.cancelDelivery('delivery')).toBe(true)
  else run.input.deviceInput.forget('agent')
  expect(run.notifications).toHaveBeenLastCalledWith(expect.objectContaining({ deliveryId: 'delivery', state: 'rejected' }))
  const count = run.notifications.mock.calls.length
  screen.resolve(await readInlineScreen(run.row, pane)); await flush()
  expect(run.calls).toEqual([])
  expect(run.promptTyped).not.toHaveBeenCalled()
  expect(run.notifications).toHaveBeenCalledTimes(count)
})

it.each(['inactive', 'runtime', 'hold', 'revision', 'unbound', 'first-bind-runtime'] as const)(
  'cannot launder a changed %s through an initial launch while its buffer loads', async change => {
    const run = setup()
    Object.assign(run.row, { sessionId: '', boundAt: null, launch: { state: 'ready' } })
    run.pause('load-buffer')
    const typed = run.write(); await flush()
    if (change === 'inactive') run.row.active = false
    else if (change === 'runtime') run.row.runtimes = [{ backend: 'tmux', paneId: '%2' }]
    else if (change === 'hold') run.row.identityHold = 'fixture hold'
    else if (change === 'revision') run.row.evidenceRevision = 2
    else if (change === 'unbound') run.row.sessionId = 'not-bound'
    else Object.assign(run.row, { sessionId: 'first', boundAt: 2, runtimes: [{ backend: 'tmux', paneId: '%2' }] })
    run.finish('load-buffer')
    // Assert the physical boundary before awaiting the result: deliberately
    // broken authority may enter the later worker retry loop instead of settle.
    await flush()
    expect(run.calls).toEqual(['delete-buffer'])
    await expect(typed).resolves.toMatchObject({ dispatch: 'not_started' })
  },
)

it('releases cancelled preparation that rejects, so subsequent device and legacy input can proceed', async () => {
  const run = setup(), screen = held<Awaited<ReturnType<InputDeps['readScreen']>>>()
  run.readScreen.mockImplementationOnce(readInlineScreen).mockImplementationOnce(() => screen.promise)
  run.input.deviceInput.submit('agent', 'old', 'old'); await flush()
  expect(run.input.deviceInput.cancelDelivery('old')).toBe(true)
  const count = run.notifications.mock.calls.length
  screen.reject(Error('worker disconnected')); await flush()
  expect(run.calls).toEqual([])
  expect(run.notifications).toHaveBeenCalledTimes(count)
  run.input.deviceInput.submit('agent', 'next', 'next'); await flush()
  expect(run.calls).toEqual(['paste-buffer', 'Enter'])
  run.input.deviceInput.onTurnStarted('agent', 'next')
  await run.input.deviceInput.legacyWrite('agent', ticket => run.terminal.keyTerminalAction('agent', 'Escape', ticket.allowed, ticket))
  expect(run.calls).toEqual(['paste-buffer', 'Enter', 'Escape'])
  run.input.deviceInput.forget('agent')
})
