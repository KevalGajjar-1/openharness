import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newAgentPayload, newCommand, NewUsageError, parseNewArgs, resolveNewMachine, trustAsked, type NewCommandDeps, type NewSocket } from './newCommand.js'

const env = { cwd: '/work/repo', home: '/home/me' }

describe('harness new: the words', () => {
  it('asks nothing: claude, here, on this machine', () => {
    expect(parseNewArgs([], env)).toEqual({
      agent: 'claude', machine: null, cwd: '/work/repo', projectName: null, mode: 'auto', modeGiven: false, prompt: null, name: null, json: false,
    })
  })

  it('reads agent, @machine and a folder in any order', () => {
    const typed = parseNewArgs(['codex', '@mini', '~/code/auth'], env)
    expect(typed).toMatchObject({ agent: 'codex', machine: 'mini', cwd: '~/code/auth', projectName: null })
    expect(parseNewArgs(['~/code/auth', '@mini', 'codex'], env)).toEqual(typed)
    // On this machine ~ and relative paths are resolved here, from where it was run.
    expect(parseNewArgs(['codex', '~/code/auth'], env).cwd).toBe('/home/me/code/auth')
    expect(parseNewArgs(['codex', './api'], env).cwd).toBe('/work/repo/api')
    expect(parseNewArgs(['.'], env)).toMatchObject({ agent: 'claude', cwd: '/work/repo' })
  })

  it('takes a second word, or --new, as a new project', () => {
    expect(parseNewArgs(['codex', 'my-game'], env)).toMatchObject({ agent: 'codex', cwd: null, projectName: 'my-game' })
    expect(parseNewArgs(['codex', '--new'], env)).toMatchObject({ cwd: null, projectName: '' })
    expect(parseNewArgs(['--new', 'my game', 'codex'], env)).toMatchObject({ agent: 'codex', projectName: 'my game' })
    // Another machine has no "here": with nothing named it is a new project there.
    expect(parseNewArgs(['codex', '@mini'], env)).toMatchObject({ machine: 'mini', cwd: null, projectName: '' })
  })

  it('takes the task after --, or as --task, with nothing to quote', () => {
    expect(parseNewArgs(['codex', '--', 'fix', 'the', 'flaky', 'login', 'test'], env)).toMatchObject({ agent: 'codex', prompt: 'fix the flaky login test', cwd: '/work/repo' })
    expect(parseNewArgs(['--task', 'write the README'], env).prompt).toBe('write the README')
    // Words after -- are never read as an agent, a machine or a folder.
    expect(parseNewArgs(['--', '@mini', '~/x'], env)).toMatchObject({ agent: 'claude', machine: null, prompt: '@mini ~/x' })
  })

  it('reads a path the shell already expanded as the other machine\'s home', () => {
    // `harness new codex @mini ~/code/auth`, unquoted: zsh hands over /home/me/code/auth.
    expect(parseNewArgs(['codex', '@mini', '/home/me/code/auth'], env).cwd).toBe('~/code/auth')
    expect(parseNewArgs(['codex', '@mini', '/home/me'], env).cwd).toBe('~')
    expect(parseNewArgs(['codex', '@mini', '/srv/app'], env).cwd).toBe('/srv/app')
    // On this machine an absolute path is just that.
    expect(parseNewArgs(['codex', '/home/me/code/auth'], env).cwd).toBe('/home/me/code/auth')
  })

  it('says what is wrong instead of guessing', () => {
    for (const argv of [['a', 'b', 'c'], ['@'], ['@a', '@b'], ['/x', '/y'], ['codex', 'game', '/x'], ['--mode', 'yolo'], ['--prompt'], ['--wat'], ['-x'], ['codex', '..'], ['codex', '@mini', './rel']]) {
      // `codex ..` is a folder, not an error; every other row must throw.
      if (argv.join(' ') === 'codex ..') { expect(parseNewArgs(argv, env).cwd).toBe('/work'); continue }
      expect(() => parseNewArgs(argv, env), argv.join(' ')).toThrow(NewUsageError)
    }
    expect(() => parseNewArgs(['codex', '!!!'], env)).toThrow(/no usable folder name/)
  })

  it('sends what the app sends', () => {
    const here = newAgentPayload(parseNewArgs(['codex', '--plan', '--prompt', 'fix the tests'], env), '/work/repo')
    expect(here).toMatchObject({ engine: 'codex', cwd: '/work/repo', permissionMode: 'plan', bypassPermission: false, prompt: 'fix the tests' })
    expect(here).not.toHaveProperty('projectSource')
    expect(typeof here.creationId).toBe('string')
    const fresh = newAgentPayload(parseNewArgs(['claude', 'My Game'], env), null)
    expect(fresh).toMatchObject({ engine: 'claude', projectSource: 'new', projectName: 'My-Game', permissionMode: 'auto', bypassPermission: true })
    expect(fresh).not.toHaveProperty('cwd')
    expect(newAgentPayload(parseNewArgs(['acme/blender', '.'], env), '/work/repo', 'codex')).toMatchObject({ engine: 'codex', dsh: 'acme/blender' })
  })

  it('only sends a permission mode to the engines that take one', () => {
    // The engines with no PERMISSION_MODES row cannot be handed the default `auto`: the daemon refuses
    // a mode the engine has no contract for (INVALID_PERMISSION_MODE), which made `harness new hermes`
    // — and pi, amp, muse, kilo, grok, devin, commandcode, agy, copilot — impossible to run at all.
    for (const agent of ['hermes', 'pi', 'amp', 'muse', 'kilo', 'grok', 'devin', 'commandcode', 'agy', 'copilot']) {
      const payload = newAgentPayload(parseNewArgs([agent], env), '/work/repo')
      expect(payload, agent).toMatchObject({ engine: agent, bypassPermission: false })
      expect(payload, agent).not.toHaveProperty('permissionMode')
    }
    // An engine that has the mode still gets it, and the store harness is judged on the engine it runs on.
    expect(newAgentPayload(parseNewArgs(['opencode'], env), '/work/repo')).toMatchObject({ permissionMode: 'auto', bypassPermission: true })
    expect(newAgentPayload(parseNewArgs(['acme/blender'], env), '/work/repo', 'hermes')).not.toHaveProperty('permissionMode')
    // A mode the person typed stays theirs to get wrong: the daemon refuses it, it is not silently swapped.
    expect(newAgentPayload(parseNewArgs(['hermes', '--mode', 'ask'], env), '/work/repo')).toMatchObject({ engine: 'hermes', permissionMode: 'ask', bypassPermission: false })
    expect(newAgentPayload(parseNewArgs(['hermes', '--plan'], env), '/work/repo')).toMatchObject({ engine: 'hermes', permissionMode: 'plan', bypassPermission: false })
  })

  it('finds the machine by id, name or an unambiguous start of one', () => {
    const machines = [
      { machineId: 'm1', label: 'Mac mini', status: 'online', current: false },
      { machineId: 'm2', label: 'MacBook Pro', status: 'online', current: true },
    ]
    expect(resolveNewMachine('m1', machines).label).toBe('Mac mini')
    expect(resolveNewMachine('mac mini', machines).machineId).toBe('m1')
    expect(resolveNewMachine('macb', machines).machineId).toBe('m2')
    expect(() => resolveNewMachine('mac', machines)).toThrow(/could be Mac mini or MacBook Pro/)
    expect(() => resolveNewMachine('linux', machines)).toThrow(/No machine called/)
  })
})

class FakeSocket extends EventEmitter implements NewSocket {
  sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  constructor(private answer: (frame: { type: string; payload: Record<string, unknown> }) => Record<string, unknown> | null) {
    super()
  }
  // Opens once somebody is listening for it, as a real socket opens after it is constructed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string, listener: (...args: any[]) => void): this {
    super.on(event, listener)
    if (event === 'open') queueMicrotask(() => this.emit('open'))
    return this
  }
  send(data: string): void {
    const frame = JSON.parse(data) as { type: string; payload: Record<string, unknown> }
    this.sent.push(frame)
    queueMicrotask(() => {
      if (frame.type === 'machine_select') { this.emit('message', JSON.stringify({ type: 'connected', payload: {} })); return }
      const payload = this.answer(frame)
      if (payload) this.emit('message', JSON.stringify({ type: `${frame.type}_result`, payload: { ...payload, requestId: frame.payload.requestId } }))
    })
  }
  close(): void {}
}

function deps(argv: string[], socket: FakeSocket, over: Partial<NewCommandDeps> = {}): NewCommandDeps & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    argv, cwd: env.cwd, home: env.home, port: 1, localMachineId: 'm2',
    daemonRunning: () => true,
    listMachines: async () => [
      { machineId: 'm1', label: 'Mac mini', status: 'online', current: false },
      { machineId: 'm2', label: 'MacBook Pro', status: 'online', current: true },
    ],
    connect: () => socket,
    output: (line) => out.push(line), error: (line) => err.push(line),
    // Never the engines' settings of whoever runs the tests.
    env: { HOME: '/nonexistent/home', CODEX_HOME: '/nonexistent/codex' },
    timeoutMs: 200, out, err, ...over,
  }
}

describe('harness new: the daemon', () => {
  it('selects this machine, creates here and says where', async () => {
    const socket = new FakeSocket((frame) => frame.type === 'agent_create'
      ? { state: 'created', agent: { id: 'a1', name: 'Codex harness 9-19 10:02', cwd: '/work/repo' } } : null)
    const d = deps(['codex'], socket)
    expect(await newCommand(d)).toBe(0)
    expect(socket.sent.map((frame) => frame.type)).toEqual(['machine_select', 'agent_create'])
    // A tool, not a window: a window would turn the question watcher on and count as someone looking.
    expect(socket.sent[0]!.payload).toEqual({ machineId: 'm2', localProtocolVersion: 1, tool: true })
    expect(socket.sent[1]!.payload).toMatchObject({ engine: 'codex', cwd: '/work/repo' })
    expect(d.out[0]).toBe('Created Codex harness 9-19 10:02 on this computer in /work/repo.')
  })

  it('asks another machine where its home is before using ~', async () => {
    const socket = new FakeSocket((frame) => frame.type === 'fs_list_dir' ? { path: '/Users/mini', entries: [] }
      : frame.type === 'agent_create' ? { state: 'created', agent: { id: 'a2', name: 'auth' } } : null)
    const d = deps(['codex', '@mini', '~/code/auth', '--json'], socket)
    expect(await newCommand(d)).toBe(0)
    expect(socket.sent[0]!.payload.machineId).toBe('m1')
    expect(socket.sent.map((frame) => frame.type)).toEqual(['machine_select', 'fs_list_dir', 'agent_create'])
    expect(socket.sent[2]!.payload.cwd).toBe('/Users/mini/code/auth')
    expect(JSON.parse(d.out[0]!)).toMatchObject({ ok: true, machineId: 'm1', agent: { id: 'a2' } })
  })

  it('reads a store harness\'s engine off the machine, and will not create one that is not installed', async () => {
    const catalog = [{ id: 'acme/blender', engine: 'codex', installed: true }, { id: 'acme/typst', engine: 'claude', installed: false }]
    const socket = new FakeSocket((frame) => frame.type === 'dsh_list' ? { dsh: catalog }
      : frame.type === 'agent_create' ? { state: 'created', agent: { id: 'a3', name: 'Blender' } } : null)
    expect(await newCommand(deps(['acme/blender'], socket))).toBe(0)
    expect(socket.sent[2]!.payload).toMatchObject({ engine: 'codex', dsh: 'acme/blender' })
    const refused = deps(['acme/typst'], new FakeSocket((frame) => frame.type === 'dsh_list' ? { dsh: catalog } : null))
    expect(await newCommand(refused)).toBe(1)
    expect(refused.err[0]).toBe('Install it first: harness dsh install acme/typst')
  })

  it('says a launch the machine refused or could not confirm failed, never "Created"', async () => {
    const failed = deps(['codex'], new FakeSocket((frame) => frame.type === 'agent_create'
      ? { creationId: 'c1', state: 'failed', failure: { code: 'SPAWN_FAILED', detail: 'no codex' } } : null))
    expect(await newCommand(failed)).toBe(1)
    expect(failed.err[0]).toBe('The agent could not be started. (no codex)')
    expect(failed.out).toEqual([])
    const unknownCode = deps(['codex', '--json'], new FakeSocket((frame) => frame.type === 'agent_create'
      ? { creationId: 'c1', state: 'failed', failure: { code: 'ODD' } } : null))
    expect(await newCommand(unknownCode)).toBe(1)
    expect(JSON.parse(unknownCode.out[0]!)).toEqual({ ok: false, error: 'ODD' })
    const bare = deps(['codex'], new FakeSocket((frame) => frame.type === 'agent_create' ? { creationId: 'c1', state: 'failed' } : null))
    expect(await newCommand(bare)).toBe(1)
    expect(bare.err[0]).toBe('The harness could not be started.')
    const unconfirmed = deps(['codex'], new FakeSocket((frame) => frame.type === 'agent_create' || frame.type === 'agent_create_status'
      ? { creationId: 'c1', state: 'unconfirmed' } : null), { sleep: async () => {} })
    expect(await newCommand(unconfirmed)).toBe(1)
    expect(unconfirmed.err[0]).toMatch(/could not confirm .*\(unconfirmed\).*harness ps/)
  })

  it('asks after a launch the machine holds until it is made, by its creation id', async () => {
    let asks = 0
    const socket = new FakeSocket((frame) => {
      if (frame.type === 'agent_create') return { creationId: frame.payload.creationId, state: 'pending' }
      if (frame.type === 'agent_create_status') return ++asks < 3 ? { creationId: frame.payload.creationId, state: 'pending' } : { state: 'created', agent: { id: 'h1', name: 'held' } }
      return null
    })
    const slept: number[] = []
    const d = deps(['codex'], socket, { sleep: async (ms) => { slept.push(ms) } })
    expect(await newCommand(d)).toBe(0)
    expect(d.out[0]).toBe('Created held on this computer in /work/repo.')
    const create = socket.sent.find((f) => f.type === 'agent_create')!
    expect(socket.sent.filter((f) => f.type === 'agent_create_status').every((f) => f.payload.creationId === create.payload.creationId)).toBe(true)
    expect(slept).toEqual([2_000, 2_000, 2_000])
  })

  it('says what a held launch waits for and, given up on, cancels it so it never starts later', async () => {
    const held = (detail: string) => ({ state: 'pending', held: { service: 'native', detail } })
    let asks = 0
    const socket = new FakeSocket((frame) => {
      if (frame.type === 'agent_create') return { creationId: frame.payload.creationId, ...held('Installing the required engine.') }
      if (frame.type === 'agent_create_status') return ++asks < 5 ? held('Installing the required engine.') : held('Waiting to confirm the selected executable’s permission flags.')
      if (frame.type === 'agent_create_cancel') return { creationId: frame.payload.creationId, state: 'cancelled' }
      return null
    })
    const d = deps(['opencode', '--', 'fix it'], socket, { sleep: async () => {} })
    expect(await newCommand(d)).toBe(1)
    // Each reason once, as it changes, then why it stopped.
    expect(d.err).toEqual([
      'Installing the required engine.',
      'Waiting to confirm the selected executable’s permission flags.',
      'Harness did not start the harness within a minute: Waiting to confirm the selected executable’s permission flags. '
        + 'The request is cancelled, so it will not start later.',
    ])
    expect(asks).toBe(30)
    const create = socket.sent.find((f) => f.type === 'agent_create')!
    expect(socket.sent.filter((f) => f.type === 'agent_create_cancel').map((f) => f.payload.creationId)).toEqual([create.payload.creationId])
    expect(d.out).toEqual([])
  })

  it('takes what became of a launch it could no longer cancel, and says so when it cannot cancel at all', async () => {
    const answer = (cancel: Record<string, unknown> | null) => new FakeSocket((frame) =>
      frame.type === 'agent_create' || frame.type === 'agent_create_status' ? { state: 'pending' }
        : frame.type === 'agent_create_cancel' ? cancel : null)
    const started = deps(['codex'], answer({ state: 'created', agent: { id: 'h2', name: 'late' } }), { sleep: async () => {} })
    expect(await newCommand(started)).toBe(0)
    expect(started.out[0]).toBe('Created late on this computer in /work/repo.')
    expect(started.err).toEqual([])
    const refused = deps(['codex'], answer({ state: 'failed', failure: { code: 'ENGINE_CANNOT_RUN', detail: 'Codex is installed but cannot run: env: node: No such file or directory' } }), { sleep: async () => {} })
    expect(await newCommand(refused)).toBe(1)
    expect(refused.err).toEqual(['Codex is installed but cannot run: env: node: No such file or directory'])
    // Claimed just before the cancel: starting now, not later, and not cancelled.
    const claimed = deps(['codex'], answer({ state: 'unconfirmed' }), { sleep: async () => {} })
    expect(await newCommand(claimed)).toBe(1)
    expect(claimed.err).toEqual(['Harness could not confirm the harness started (unconfirmed). Check with `harness ps` before starting another.'])
    const held = deps(['codex', 'my-game'], answer({ state: 'failed', failure: { code: 'NATIVE_LAUNCH_HELD', detail: 'Waiting to confirm native engine locations.' } }), { sleep: async () => {} })
    expect(await newCommand(held)).toBe(1)
    expect(held.err).toEqual(['The agent\'s engine was not ready to start. (Waiting to confirm native engine locations.)'])
    // A daemon with no cancel (or no answer): the request is still saved, and that is said plainly.
    const older = deps(['codex', '--json'], answer(null), { sleep: async () => {} })
    expect(await newCommand(older)).toBe(1)
    expect(JSON.parse(older.out[0]!)).toEqual({ ok: false, error: 'Harness did not start the harness within a minute. '
      + 'It is still saved and may start later by itself: check with `harness ps` before starting another.' })
    expect(older.err).toEqual([])
  })

  it('says why the machine refused an engine that cannot run, in the machine\'s words', async () => {
    const d = deps(['codex'], new FakeSocket((frame) => frame.type === 'agent_create' ? { creationId: 'c1', state: 'failed',
      failure: { code: 'ENGINE_CANNOT_RUN', detail: 'Codex is installed but cannot run: /usr/bin/env: ‘node’: No such file or directory' } } : null))
    expect(await newCommand(d)).toBe(1)
    expect(d.err).toEqual(['Codex is installed but cannot run: /usr/bin/env: ‘node’: No such file or directory'])
  })

  it('reads the folder off the harness the machine made', async () => {
    const socket = new FakeSocket((frame) => frame.type === 'agent_create'
      ? { state: 'created', agent: { id: 'a1', name: 'fixer', project: { cwd: '/work/repo/.worktrees/x' } } } : null)
    const d = deps(['codex'], socket)
    expect(await newCommand(d)).toBe(0)
    expect(d.out[0]).toBe('Created fixer on this computer in /work/repo/.worktrees/x.')
  })

  it('run by an agent: checks its limits, heads its task with who sent it, records it, and says how to follow it', async () => {
    const created: Array<[string, Record<string, unknown>]> = []
    let warning: string | null = null
    const origin = {
      check: async () => {},
      prompt: (text: string, machineId: string) => `[from lead on ${machineId}]\n\n${text}`,
      created: async (machineId: string, agent: Record<string, unknown>) => { created.push([machineId, agent]); return warning },
      next: (agent: Record<string, unknown>) => `Read it: harness show ${String(agent.name)}`,
    }
    const socket = new FakeSocket((frame) => frame.type === 'agent_create' ? { state: 'created', agent: { id: 'a9', name: 'reviewer' } } : null)
    const d = deps(['codex', '--name', 'reviewer', '--', 'review', 'it'], socket, { origin: async () => origin })
    expect(await newCommand(d)).toBe(0)
    expect(socket.sent[1]!.payload.prompt).toBe('[from lead on m2]\n\nreview it')
    // The machine records that an agent started it: the pull requests it opens say so (lib/agentAttribution.ts).
    expect(socket.sent[1]!.payload.startedBy).toBe('agent')
    expect(created).toEqual([['m2', { id: 'a9', name: 'reviewer' }]])
    expect(d.out[1]).toBe('Read it: harness show reviewer')
    // No task: nothing to head.
    const quiet = new FakeSocket((frame) => frame.type === 'agent_create' ? { state: 'created', agent: { id: 'b1', name: 'idle' } } : null)
    expect(await newCommand(deps(['codex'], quiet, { origin: async () => origin }))).toBe(0)
    expect(quiet.sent[1]!.payload.prompt).toBeUndefined()
    // Over a limit: refused before anything is asked of the machine.
    const refused = new FakeSocket(() => null)
    const over = deps(['codex', '--', 'go'], refused, { origin: async () => ({ ...origin, check: async () => { throw new Error('You have 8 harnesses running.') } }) })
    expect(await newCommand(over)).toBe(1)
    expect(over.err[0]).toBe('You have 8 harnesses running.')
    expect(refused.sent).toEqual([])
    // A record another machine could not keep: said, and the harness is still made.
    warning = 'its limits start from zero'
    const far = deps(['codex', '--', 'go'], new FakeSocket((frame) => frame.type === 'agent_create' ? { state: 'created', agent: { id: 'f1', name: 'far' } } : null), { origin: async () => origin })
    expect(await newCommand(far)).toBe(0)
    expect(far.err).toEqual(['its limits start from zero'])
    // A person at a terminal: no origin, the old words.
    const atTerminal = new FakeSocket((frame) => frame.type === 'agent_create' ? { state: 'created', agent: { id: 'c1', name: 'x' } } : null)
    const person = deps(['codex'], atTerminal, { origin: async () => null })
    expect(await newCommand(person)).toBe(0)
    expect(person.out[1]).toBe('Open it in Harness with ⌘O.')
    expect(atTerminal.sent[1]!.payload).not.toHaveProperty('startedBy')
  })

  it('turns the machine\'s refusal into words, and a usage slip into the usage', async () => {
    const socket = new FakeSocket((frame) => frame.type === 'agent_create' ? { error: 'INVALID_CWD', detail: '/nope' } : null)
    const d = deps(['codex', '/nope'], socket)
    expect(await newCommand(d)).toBe(1)
    expect(d.err[0]).toBe('That folder does not exist on the machine. (/nope)')
    const help = deps(['--help'], socket)
    expect(await newCommand(help)).toBe(0)
    expect(help.out.join('\n')).toContain('Usage: harness new')
    expect(help.err).toEqual([])
    const slip = deps(['a', 'b', 'c'], socket)
    expect(await newCommand(slip)).toBe(2)
    expect(slip.err.join('\n')).toContain('Usage: harness new')
    const stopped = deps(['codex'], socket, { daemonRunning: () => false })
    expect(await newCommand(stopped)).toBe(1)
    expect(stopped.err[0]).toMatch(/harness start/)
  })
})

/** A computer's folders and its engines' settings under a throwaway root: Claude Code's `.claude.json` in its home and
 *  Codex's config.toml in its CODEX_HOME, as each has them once it has run. */
function computer() {
  const root = mkdtempSync(join(tmpdir(), 'new-trust-'))
  const home = join(root, 'home'), codex = join(root, 'codex')
  mkdirSync(join(home, 'harnesses'), { recursive: true })
  mkdirSync(codex)
  const claudeTrusts = (...folders: string[]) => writeFileSync(join(home, '.claude.json'),
    JSON.stringify({ projects: Object.fromEntries(folders.map((folder) => [folder, { hasTrustDialogAccepted: true }])) }))
  const codexTrusts = (...folders: string[]) => writeFileSync(join(codex, 'config.toml'),
    folders.map((folder) => `[projects.${JSON.stringify(folder)}]\ntrust_level = "trusted"\n`).join('\n'))
  claudeTrusts()
  codexTrusts()
  const folder = (name: string, ...files: string[]) => {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    for (const file of files) writeFileSync(join(dir, file), '')
    return dir
  }
  return { root, home, env: { HOME: home, CODEX_HOME: codex }, claudeTrusts, codexTrusts, folder }
}

/** An agent starting harnesses, as agentClient/commands.ts `agentOrigin` is to `harness new`. */
const agentStarting = () => {
  const created: string[] = []
  return {
    created,
    origin: {
      check: async () => {},
      prompt: (text: string) => text,
      created: async (_machineId: string, agent: Record<string, unknown>) => { created.push(String(agent.id)); return null },
      next: () => 'Read it: harness show it',
    },
  }
}

const creating = (agent: Record<string, unknown>) => new FakeSocket((frame) => frame.type === 'agent_create' ? { state: 'created', agent } : null)

describe('harness new: a folder the engine would ask about', () => {
  it('reads whether Claude Code or Codex will ask the person to trust a folder before it starts', async () => {
    const c = computer()
    const scratch = c.folder('scratch')
    const work = c.folder('work', 'README.md')
    for (const engine of ['claude', 'codex']) {
      expect(await trustAsked(engine, scratch, c.home, c.env)).toBe('empty')
      expect(await trustAsked(engine, work, c.home, c.env)).toBe('content')
      // Empty and directly inside the projects root: Harness answers for it as the engine starts.
      expect(await trustAsked(engine, c.folder('home/harnesses/review'), c.home, c.env)).toBeNull()
    }
    // Further down, it is the engine's question again.
    expect(await trustAsked('claude', c.folder('home/harnesses/review/deeper'), c.home, c.env)).toBe('empty')
    // Nothing to ask: an engine with no such question, a store harness's name, a folder that is not there (the machine says).
    expect(await trustAsked('opencode', scratch, c.home, c.env)).toBeNull()
    expect(await trustAsked('owner/kit', scratch, c.home, c.env)).toBeNull()
    expect(await trustAsked('claude', join(c.root, 'missing'), c.home, c.env)).toBeNull()
  })

  it('takes the trust an engine has: by the path typed or the one it resolves to, from above, and by the repository', async () => {
    const c = computer()
    // macOS's /tmp is /private/tmp: a folder reached through a link, trusted as it resolves, or as it was typed.
    const real = c.folder('real-scratch')
    const typed = join(c.root, 'typed-scratch')
    symlinkSync(real, typed)
    c.claudeTrusts(realpathSync(real))
    c.codexTrusts(typed)
    expect(await trustAsked('claude', typed, c.home, c.env)).toBeNull()
    expect(await trustAsked('codex', typed, c.home, c.env)).toBeNull()
    // Claude Code's trust covers every folder below; Codex's is the folder's own, or its repository's.
    c.claudeTrusts(realpathSync(c.root))
    expect(await trustAsked('claude', c.folder('anywhere/below'), c.home, c.env)).toBeNull()
    expect(await trustAsked('codex', c.folder('anywhere/else'), c.home, c.env)).toBe('empty')
    const repo = c.folder('repo/.git').replace(/\/\.git$/, '')
    const src = c.folder('repo/src', 'a.ts')
    const worktree = c.folder('wt', 'a.ts')
    writeFileSync(join(worktree, '.git'), `gitdir: ${realpathSync(repo)}/.git/worktrees/wt\n`)
    const relative = c.folder('wt2', 'a.ts')
    writeFileSync(join(relative, '.git'), 'gitdir: ../repo/.git/worktrees/wt2\n')
    const submodule = c.folder('sub', 'a.ts')
    writeFileSync(join(submodule, '.git'), 'gitdir: ../repo/.git/modules/sub\n')
    for (const folder of [src, worktree, relative, submodule]) expect(await trustAsked('codex', folder, c.home, c.env)).toBe('content')
    c.codexTrusts(realpathSync(repo))
    for (const folder of [src, worktree, relative]) expect(await trustAsked('codex', folder, c.home, c.env)).toBeNull()
    expect(await trustAsked('codex', submodule, c.home, c.env)).toBe('content')
  })

  it('refuses an agent an empty folder of its own, in words it can act on, before anything is started', async () => {
    // A Codex harness asked for a second opinion from Claude Code made `mktemp -d /tmp/shell-opinion.XXXX` and started
    // Claude Code there, which stopped on its trust question (a clean VM, CLI 0.3.75, 2026-10-11).
    const c = computer()
    const scratch = c.folder('shell-opinion.e0ynGN')
    const { origin, created } = agentStarting()
    const socket = new FakeSocket(() => null)
    const shell = deps(['claude', scratch, '--name', 'opinion', '--', 'a second opinion'], socket, { origin: async () => origin, env: c.env, home: c.home })
    expect(await newCommand(shell)).toBe(1)
    expect(shell.err).toEqual([`Claude Code would ask the person to trust ${scratch} before it starts, and it is empty: for scratch or new work `
      + 'give a project name instead — harness new claude opinion --name opinion -- …  (Harness makes ~/harnesses/opinion, which needs no '
      + 'approval). Nothing was started.'])
    expect(socket.sent.map((frame) => frame.type)).toEqual(['machine_select'])
    expect(created).toEqual([])
    // Through `harness mcp`: its tool, by the name it gave.
    const viaMcp = deps(['codex', scratch, '--name', 'Second opinion', '--', 'a second opinion'], new FakeSocket(() => null),
      { origin: async () => origin, env: { ...c.env, HARNESS_VIA_MCP: '1' }, home: c.home })
    expect(await newCommand(viaMcp)).toBe(1)
    expect(viaMcp.err).toEqual([`Codex would ask the person to trust ${scratch} before it starts, and it is empty: for scratch or new work `
      + 'give a project name instead — harness_start (project: "Second-opinion", …)  (Harness makes ~/harnesses/Second-opinion, which '
      + 'needs no approval). Nothing was started.'])
    // Unnamed, and asked for JSON.
    const json = deps(['codex', scratch, '--json', '--', 'go'], new FakeSocket(() => null), { origin: async () => origin, env: c.env, home: c.home })
    expect(await newCommand(json)).toBe(1)
    expect(JSON.parse(json.out[0]!)).toEqual({ ok: false, error: expect.stringContaining('— harness new codex review -- …  (Harness makes ~/harnesses/review,') })
    // Trusted already, it starts.
    c.claudeTrusts(realpathSync(scratch))
    const trusted = deps(['claude', scratch, '--', 'go'], creating({ id: 'a1', name: 'opinion' }), { origin: async () => origin, env: c.env, home: c.home })
    expect(await newCommand(trusted)).toBe(0)
    expect(trusted.out).toEqual([`Created opinion on this computer in ${scratch}.`, 'Read it: harness show it'])
  })

  it('starts an agent\'s harness in a folder with content, and says it will wait for the person to trust it', async () => {
    const c = computer()
    const work = c.folder('work', 'README.md')
    const { origin, created } = agentStarting()
    const shell = deps(['codex', work, '--name', 'reviewer', '--', 'review it'], creating({ id: 'a1', name: 'reviewer' }), { origin: async () => origin, env: c.env, home: c.home })
    expect(await newCommand(shell)).toBe(0)
    expect(shell.out).toEqual([
      `Created reviewer on this computer in ${work}.`,
      `Codex will ask the person to trust ${work} before it starts, so it waits for them until they answer (harness wait exits 3). `
        + 'For new work, a project name avoids this: harness new codex reviewer --name reviewer -- …',
      'Read it: harness show it',
    ])
    expect(created).toEqual(['a1'])
    const viaMcp = deps(['claude', work, '--name', 'reviewer', '--', 'review it'], creating({ id: 'a2', name: 'reviewer' }),
      { origin: async () => origin, env: { ...c.env, HARNESS_VIA_MCP: '1' }, home: c.home })
    expect(await newCommand(viaMcp)).toBe(0)
    expect(viaMcp.out[1]).toBe(`Claude Code will ask the person to trust ${work} before it starts, so it waits for them until they answer `
      + '(harness_wait says needs-input). For new work, a project name avoids this: harness_start (project: "reviewer", …)')
    const json = deps(['codex', work, '--json', '--', 'go'], creating({ id: 'a3', name: 'x' }), { origin: async () => origin, env: c.env, home: c.home })
    expect(await newCommand(json)).toBe(0)
    expect(JSON.parse(json.out[0]!)).toMatchObject({ ok: true, agent: { id: 'a3' }, note: expect.stringContaining('Codex will ask the person to trust') })
    // Trusted: nothing to say.
    c.codexTrusts(realpathSync(work))
    const trusted = deps(['codex', work, '--', 'go'], creating({ id: 'a4', name: 'x' }), { origin: async () => origin, env: c.env, home: c.home })
    expect(await newCommand(trusted)).toBe(0)
    expect(trusted.out).toEqual([`Created x on this computer in ${work}.`, 'Read it: harness show it'])
  })

  it('leaves the person at a terminal, another machine, and a store harness\'s empty folder as they were', async () => {
    const c = computer()
    const scratch = c.folder('scratch')
    const work = c.folder('work', 'README.md')
    const { origin } = agentStarting()
    // The person is there to answer the question.
    const person = deps(['claude', scratch], creating({ id: 'p1', name: 'mine' }), { origin: async () => null, env: c.env, home: c.home })
    expect(await newCommand(person)).toBe(0)
    expect(person.out).toEqual([`Created mine on this computer in ${scratch}.`, 'Open it in Harness with ⌘O.'])
    // Another machine's folders and settings are not here to read.
    const far = deps(['claude', '@mini', scratch], creating({ id: 'f1', name: 'far' }), { origin: async () => origin, env: c.env, home: c.home })
    expect(await newCommand(far)).toBe(0)
    expect(far.out).toEqual([`Created far on Mac mini in ${scratch}.`, 'Read it: harness show it'])
    // A store harness lays its template into an empty folder, which is then trusted; one with content is still asked about.
    const store = (folder: string) => new FakeSocket((frame) => frame.type === 'dsh_list' ? { dsh: [{ id: 'owner/kit', engine: 'claude', installed: true }] }
      : frame.type === 'agent_create' ? { state: 'created', agent: { id: 's1', name: 'kit' } } : null)
    const empty = deps(['owner/kit', scratch], store(scratch), { origin: async () => origin, env: c.env, home: c.home })
    expect(await newCommand(empty)).toBe(0)
    expect(empty.out).toEqual([`Created kit on this computer in ${scratch}.`, 'Read it: harness show it'])
    const full = deps(['owner/kit', work], store(work), { origin: async () => origin, env: c.env, home: c.home })
    expect(await newCommand(full)).toBe(0)
    expect(full.out[1]).toBe(`Claude Code will ask the person to trust ${work} before it starts, so it waits for them until they answer `
      + '(harness wait exits 3). For new work, a project name avoids this: harness new owner/kit review -- …')
  })
})
