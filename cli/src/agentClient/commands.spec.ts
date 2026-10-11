import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addressOf, agentOrigin, closeCommand, EXIT, parseDuration, psCommand, showCommand, spawnRefusal, SPAWN_LIMITS, waitCommand, type ClientDeps } from './commands.js'
import { AgentClientError, type Daemon, type Where } from './daemon.js'
import { Ledger, ledgerPath } from './ledger.js'
import type { Frame } from './model.js'

const NOW = Date.parse('2026-10-11T12:00:00Z')

const frame = (id: string, over: Partial<Frame> = {}): Frame => ({
  id, sessionId: `s-${id}`, name: id, engine: 'codex', status: 'active', activity: { state: 'idle' }, tmuxPane: `%${id}`,
  project: { cwd: `/work/${id}`, branch: 'main' }, createdAt: '2026-10-11T10:00:00Z', updatedAt: '2026-10-11T11:59:00Z', ...over,
})

type Handler = (payload: Record<string, unknown>) => Record<string, unknown>

/** A daemon answering from a table; `screens` scripts what each inspect sees, one look at a time. */
class FakeDaemon implements Daemon {
  requests: Array<{ type: string; payload: Record<string, unknown> }> = []
  closed = false
  frames: Frame[] = []
  screens = new Map<string, string[]>()
  pages = new Map<string, Record<string, unknown>[]>()
  extra: Record<string, Handler> = {}
  constructor(readonly machineId = 'm') {}
  async request(type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.requests.push({ type, payload })
    if (this.extra[type]) return this.extra[type](payload)
    switch (type) {
      case 'agents_list': return { agents: this.frames.filter((f) => payload.includeStopped || f.status !== 'stopped') }
      case 'agent_recent': return { agentId: payload.agentId, events: [{ kind: 'summary', text: `${String(payload.agentId)} text`, recap: `${String(payload.agentId)} recap` }], asks: [`ask of ${String(payload.agentId)}`] }
      case 'agent_close': {
        if (payload.mode === 'inspect') {
          const seen = this.screens.get(String(payload.agentId)) ?? []
          return { activity: seen.length > 1 ? seen.shift() : seen[0] ?? 'idle' }
        }
        return { closed: true }
      }
      case 'session_get': {
        const pages = this.pages.get(String(payload.sessionId)) ?? []
        const index = payload.before ? Number(payload.before) : 0
        return pages[index] ?? { events: [], hasMore: false }
      }
      default: return { error: 'UNKNOWN' }
    }
  }
  close(): void { this.closed = true }
}

let dir: string
let where: Where
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-client-'))
  writeFileSync(join(dir, 'machine-name'), 'studio\n')
  where = { port: 1, dataDir: dir, machineId: 'm' }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function harness(daemon: FakeDaemon, over: Partial<ClientDeps> & { others?: Record<string, FakeDaemon> } = {}) {
  const out: string[] = [], err: string[] = []
  let clock = NOW
  const deps: ClientDeps = {
    pane: '%lead', where: () => where,
    open: async (_w, machineId) => {
      if (!machineId || machineId === 'm') return daemon
      const other = over.others?.[machineId]
      if (!other) throw new AgentClientError('NO_PEER_LINK', 'not linked')
      return other
    },
    ledger: (d) => new Ledger(ledgerPath(d)),
    out: (l) => out.push(l), err: (l) => err.push(l),
    now: () => clock, sleep: async (ms) => { clock += ms }, intervalMs: 1_000,
    ...over,
  }
  return { deps, out, err, ledger: new Ledger(ledgerPath(dir)), advance: (ms: number) => { clock += ms } }
}

const started = (ledger: Ledger, by: string, child: string, childMachine = 'm', at = NOW) => ledger.append({
  at, depth: 1, by: { machineId: 'm', agentId: by, name: by, engine: 'claude' }, child: { machineId: childMachine, agentId: child, name: child },
})

const ev = (type: string, payload: Record<string, unknown> = {}) => ({ type, payload })

describe('harness ps', () => {
  it('lists the harnesses here: who you are, state, who started each, and what each is about', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('kid', { activity: { state: 'working' } }), frame('sh', { engine: 'terminal' })]
    const h = harness(d)
    started(h.ledger, 'lead', 'kid')
    expect(await psCommand([], h.deps)).toBe(EXIT.ok)
    const text = h.out.join('\n')
    expect(text).toMatch(/^You are "lead" \(lead\)\.\nNAME +AGENT +STATE +STARTED BY +ACTIVE +FOLDER/)
    expect(text).toMatch(/kid +Codex +working +you +1m +\/work\/kid \(main\)\n  kid recap/)
    expect(text).toMatch(/lead +Claude Code +idle +person \(you\)/)
    expect(text).not.toContain('sh ')
    expect(d.closed).toBe(true)
  })

  it('prints JSON for programs, and asks for stopped ones with --all', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead'), frame('old', { status: 'stopped' })]
    d.extra.agent_recent = (p) => (p.agentId === 'lead' ? { error: 'NOPE' } : { events: [{ kind: 'x', text: '' }, { kind: 'y' }], asks: ['  first   ask ', 3] })
    const h = harness(d, { pane: undefined })
    expect(await psCommand(['--all', '--json'], h.deps)).toBe(EXIT.ok)
    const parsed = JSON.parse(h.out[0])
    expect(parsed.you).toBeNull()
    expect(parsed.machine).toBe('studio')
    expect(parsed.harnesses.map((r: { name: string }) => r.name)).toEqual(['lead', 'old'])
    expect(d.requests[0]).toMatchObject({ type: 'agents_list', payload: { includeStopped: true } })
    // A stopped harness is not asked what it is about.
    expect(d.requests.filter((r) => r.type === 'agent_recent').map((r) => r.payload.agentId)).toEqual(['lead'])
  })

  it('says what it shows when there is nothing, uses the asks when there is no summary, and survives a summary that does not come', async () => {
    const empty = harness(new FakeDaemon())
    expect(await psCommand([], empty.deps)).toBe(EXIT.ok)
    expect(empty.out).toEqual(['No harnesses on this machine.'])
    const d = new FakeDaemon()
    d.frames = [frame('a'), frame('b')]
    d.extra.agent_recent = (p) => { if (p.agentId === 'b') throw new Error('slow'); return { events: [], asks: ['the ask'] } }
    const h = harness(d)
    expect(await psCommand([], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n')).toContain('  asked: the ask')
  })

  it('refuses names and unknown options with the usage, and prints the usage for --help', async () => {
    const h = harness(new FakeDaemon())
    expect(await psCommand(['kid'], h.deps)).toBe(EXIT.usage)
    expect(h.err[0]).toBe('harness ps takes no names. To read one: harness show kid')
    expect(await psCommand(['--bogus'], h.deps)).toBe(EXIT.usage)
    expect(h.err).toContain('Unknown option --bogus.')
    expect(await psCommand(['--help'], h.deps)).toBe(EXIT.ok)
    expect(h.out.at(-1)).toMatch(/^Usage: harness ps/)
  })

  it('says when the daemon cannot be reached or cannot list, in words or JSON', async () => {
    const down = harness(new FakeDaemon(), { open: async () => { throw new AgentClientError('DAEMON_UNREACHABLE', 'Harness is not running here.') } })
    expect(await psCommand([], down.deps)).toBe(EXIT.failed)
    expect(down.err).toEqual(['Harness is not running here.'])
    const d = new FakeDaemon()
    d.extra.agents_list = () => ({ error: 'BUSY' })
    const h = harness(d)
    expect(await psCommand(['--json'], h.deps)).toBe(EXIT.failed)
    expect(JSON.parse(h.out[0])).toEqual({ error: 'BUSY', detail: 'Harness could not list its harnesses. Try again.' })
    expect(d.closed).toBe(true)
    const odd = harness(new FakeDaemon(), { open: async () => { throw 'string' } })
    expect(await psCommand([], odd.deps)).toBe(EXIT.failed)
    expect(odd.err).toEqual(['string'])
  })
})

describe('harness show', () => {
  it('shows the state and the last turn, reading back a page at a time until it finds the ask', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead'), frame('reviewer')]
    d.pages.set('s-reviewer', [
      { events: [ev('tool_start'), ev('tool_end'), ev('text_delta', { content: 'Two bugs.' }), ev('done')], hasMore: true, oldestCursor: '1' },
      { events: [ev('user_message', { content: 'review 3f2a' })], hasMore: false },
    ])
    const h = harness(d)
    started(h.ledger, 'lead', 'reviewer')
    expect(await showCommand(['rev'], h.deps)).toBe(EXIT.ok)
    expect(h.out).toEqual([
      'reviewer · Codex · studio · idle · started by you',
      'folder: /work/reviewer (main)',
      'asked: review 3f2a',
      'answer (after 1 tool calls):',
      'Two bugs.',
    ])
    expect(d.requests.filter((r) => r.type === 'session_get').map((r) => r.payload)).toEqual([
      { sessionId: 's-reviewer', limit: 80 }, { sessionId: 's-reviewer', limit: 80, before: '1' },
    ])
  })

  it('clips a long answer and says how to read the rest; says when it waits for the person', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead'), frame('long')]
    d.screens.set('long', ['needs_input'])
    d.pages.set('s-long', [{ events: [ev('user_message', { content: 'go' }), ev('text_delta', { content: 'x'.repeat(50) })], hasMore: false }])
    const h = harness(d)
    expect(await showCommand(['long', '--chars', '10'], h.deps)).toBe(EXIT.ok)
    expect(h.out[0]).toBe('long · Codex · studio · needs-input · started by person')
    expect(h.out).toContain('xxxxxxxxx…')
    expect(h.out).toContain('… 40 more characters: harness show long --chars 50')
    expect(h.out.at(-1)).toMatch(/waiting for the person/)
    const json = harness(d)
    expect(await showCommand(['long', '--json', '--chars=5'], json.deps)).toBe(EXIT.ok)
    expect(JSON.parse(json.out.join('\n'))).toMatchObject({ name: 'long', state: 'needs-input', answer: 'xxxx…', truncated: true, ask: 'go' })
  })

  it('says when there is no turn yet, or no transcript to read', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('fresh', { sessionId: '' }), frame('broken'), frame('stopped', { status: 'stopped' })]
    d.extra.session_get = () => ({ error: 'ENGINE_UNAVAILABLE' })
    const h = harness(d, { pane: undefined })
    expect(await showCommand(['fresh'], h.deps)).toBe(EXIT.ok)
    expect(await showCommand(['broken'], h.deps)).toBe(EXIT.ok)
    expect(await showCommand(['stopped'], h.deps)).toBe(EXIT.ok)
    expect(h.out.filter((l) => l === 'No turn yet.')).toHaveLength(3)
    expect(h.out).toContain('stopped · Codex · studio · stopped · started by person')
    // The screen could not be read: the listed state stands.
    d.extra.agent_close = () => { throw new Error('gone') }
    const again = harness(d, { pane: undefined })
    expect(await showCommand(['fresh'], again.deps)).toBe(EXIT.ok)
    expect(again.out[0]).toContain('· idle ·')
  })

  it('stops reading back after four pages', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('chatty')]
    d.pages.set('s-chatty', Array.from({ length: 6 }, (_, i) => ({ events: [ev('tool_start')], hasMore: true, oldestCursor: String(i + 1) })))
    const h = harness(d, { pane: undefined })
    expect(await showCommand(['chatty'], h.deps)).toBe(EXIT.ok)
    expect(d.requests.filter((r) => r.type === 'session_get')).toHaveLength(4)
    expect(h.out).toContain('No turn yet.')
  })

  it('refuses no name, two names, a bad --chars, and says which harnesses a name could mean', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('review-a'), frame('review-b'), frame('solo', { status: 'stopped' }), frame('solo2', { name: 'solo', status: 'stopped' })]
    const h = harness(d, { pane: undefined })
    expect(await showCommand([], h.deps)).toBe(EXIT.usage)
    expect(h.err[0]).toBe('Name the harness to show.')
    expect(await showCommand(['a', 'b'], h.deps)).toBe(EXIT.usage)
    expect(await showCommand(['a', '--chars', 'x'], h.deps)).toBe(EXIT.usage)
    expect(await showCommand(['a', '--chars'], h.deps)).toBe(EXIT.usage)
    expect(h.err).toContain('--chars needs a value.')
    expect(await showCommand(['review'], h.deps)).toBe(EXIT.failed)
    expect(h.err.at(-1)).toBe('"review" could be review-a (review-a, idle), review-b (review-b, idle). Use more of the name, or the id.')
    expect(await showCommand(['solo'], h.deps)).toBe(EXIT.failed)
    expect(await showCommand(['nobody'], h.deps)).toBe(EXIT.failed)
    expect(h.err.at(-1)).toBe('No harness named "nobody" on this machine. `harness ps` lists them.')
  })

  it('prefers a live harness over a stopped one of the same name', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('old', { name: 'fixer', status: 'stopped' }), frame('new', { name: 'fixer' })]
    const h = harness(d, { pane: undefined })
    expect(await showCommand(['fixer', '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out.join('\n')).id).toBe('new')
  })

  it('finds a harness the caller started by the name it was started with, after its engine retitled it', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead'), frame('kid', { name: 'Fix the login test' })]
    const h = harness(d)
    started(h.ledger, 'lead', 'kid')
    h.ledger.append({ ...h.ledger.all()[0], child: { machineId: 'm', agentId: 'kid', name: 'Claude harness 10-11 8:38' } })
    expect(await showCommand(['Claude harness 10-11 8:38', '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({ id: 'kid', name: 'Fix the login test', startedBy: 'you' })
  })

  it('finds a harness the caller started on another machine', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead')]
    const mini = new FakeDaemon('mini')
    mini.frames = [frame('gpu-job')]
    const h = harness(d, { others: { mini } })
    started(h.ledger, 'lead', 'gpu-job', 'mini')
    expect(await showCommand(['gpu', '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({ name: 'gpu-job', machine: 'mini', startedBy: 'you' })
    expect(mini.closed).toBe(true)
    mini.frames = []
    const gone = harness(d, { others: { mini } })
    expect(await showCommand(['gpu-job'], gone.deps)).toBe(EXIT.failed)
    expect(gone.err[0]).toBe('gpu-job is no longer on its machine.')
  })
})

describe('harness wait', () => {
  it('waits while it works, then says it is idle', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead'), frame('kid')]
    d.screens.set('kid', ['working', 'working', 'idle'])
    const h = harness(d)
    expect(await waitCommand(['kid'], h.deps)).toBe(EXIT.ok)
    expect(h.out).toEqual(['kid: idle · read it: harness show kid'])
    expect(d.requests.filter((r) => r.type === 'agent_close').every((r) => r.payload.mode === 'inspect')).toBe(true)
  })

  it('returns at once for a harness that already finished its turn', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('done')]
    d.pages.set('s-done', [{ events: [ev('user_message', { content: 'x' }), ev('done')], hasMore: false }])
    const h = harness(d)
    expect(await waitCommand(['done', '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out.join('\n'))).toEqual({ harnesses: [{ name: 'done', id: 'done', state: 'idle' }] })
  })

  it('does not take a harness that has not begun its task for one that finished', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('new', { createdAt: new Date(NOW - 5_000).toISOString(), sessionId: '' })]
    d.screens.set('new', ['idle', 'idle', 'working', 'idle'])
    const h = harness(d)
    expect(await waitCommand(['new'], h.deps)).toBe(EXIT.ok)
    expect(d.requests.filter((r) => r.type === 'agent_close')).toHaveLength(4)
  })

  it('gives up on a harness with nothing asked of it, once it is past starting', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('blank', { createdAt: '2026-10-11T09:00:00Z' })]
    const h = harness(d)
    expect(await waitCommand(['blank'], h.deps)).toBe(EXIT.ok)
    expect(d.requests.filter((r) => r.type === 'agent_close')).toHaveLength(3)
    // Without a start time it is taken as old.
    const e = new FakeDaemon()
    e.frames = [frame('blank', { createdAt: undefined })]
    expect(await waitCommand(['blank'], harness(e).deps)).toBe(EXIT.ok)
  })

  it('stops for the person, a stop, a harness that went, or the clock', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('asks'), frame('busy')]
    d.screens.set('asks', ['needs_input'])
    d.screens.set('busy', ['working'])
    const h = harness(d)
    expect(await waitCommand(['asks'], h.deps)).toBe(EXIT.needsInput)
    expect(h.out[0]).toMatch(/asks: needs-input · it waits for the person/)
    const t = harness(d)
    expect(await waitCommand(['busy', '--timeout', '10s'], t.deps)).toBe(EXIT.timeout)
    expect(t.out[0]).toBe('busy: timeout · still working; wait again or read it: harness show busy')
    const s = new FakeDaemon()
    s.frames = [frame('x')]
    s.screens.set('x', ['working'])
    let n = 0
    s.extra.agents_list = () => ({ agents: n++ < 2 ? s.frames : [{ ...s.frames[0], status: 'stopped' }] })
    const st = harness(s)
    expect(await waitCommand(['x'], st.deps)).toBe(EXIT.stopped)
    expect(st.out[0]).toBe('x: stopped · it was stopped')
    let m = 0
    s.extra.agents_list = () => ({ agents: m++ < 2 ? s.frames : [] })
    const g = harness(s)
    expect(await waitCommand(['x'], g.deps)).toBe(EXIT.stopped)
    expect(g.out[0]).toBe('x: gone · it is gone')
  })

  it('waits for all of several, or the first with --any; a name twice is one harness', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a'), frame('b')]
    d.screens.set('a', ['working', 'idle'])
    d.screens.set('b', ['working', 'working', 'working', 'idle'])
    const all = harness(d)
    expect(await waitCommand(['a,b', 'a'], all.deps)).toBe(EXIT.ok)
    expect(all.out).toEqual(['a: idle · read it: harness show a', 'b: idle · read it: harness show b'])
    d.screens.set('a', ['working', 'idle'])
    d.screens.set('b', ['working'])
    const any = harness(d)
    expect(await waitCommand(['a,b', '--any'], any.deps)).toBe(EXIT.ok)
    expect(any.out).toEqual(['a: idle · read it: harness show a'])
  })

  it('keeps waiting through a slow answer, a screen it cannot read, and an unknown state', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('k', { activity: { state: 'working' } })]
    let looks = 0
    d.extra.agent_close = () => {
      looks++
      if (looks === 1) throw new AgentClientError('TIMEOUT', 'slow')
      if (looks === 2) return { activity: 'unknown' }
      if (looks === 3) return { activity: 'working' }
      return { activity: 'draft' }
    }
    const h = harness(d)
    expect(await waitCommand(['k', '--timeout', '0'], h.deps)).toBe(EXIT.ok)
    expect(looks).toBe(4)
  })

  it('passes on a failure it cannot wait through', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('k')]
    let first = true
    d.extra.agents_list = () => { if (first) { first = false; return { agents: d.frames } } throw new AgentClientError('DISCONNECTED', 'The connection to Harness closed.') }
    const h = harness(d)
    expect(await waitCommand(['k'], h.deps)).toBe(EXIT.failed)
    expect(h.err).toEqual(['The connection to Harness closed.'])
  })

  it('refuses no name and a time it cannot read', async () => {
    const h = harness(new FakeDaemon())
    expect(await waitCommand([], h.deps)).toBe(EXIT.usage)
    expect(await waitCommand([','], h.deps)).toBe(EXIT.usage)
    expect(await waitCommand(['a', '--timeout', 'soon'], h.deps)).toBe(EXIT.usage)
    expect(h.err).toContain('"soon" is not a time: use 90s, 30m or 2h.')
    expect(parseDuration('90s')).toBe(90_000)
    expect(parseDuration('30')).toBe(1_800_000)
    expect(parseDuration('2h')).toBe(7_200_000)
  })

  it('waits on a harness the caller started on another machine', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead')]
    const mini = new FakeDaemon('mini')
    mini.frames = [frame('far')]
    mini.screens.set('far', ['working', 'idle'])
    const h = harness(d, { others: { mini } })
    started(h.ledger, 'lead', 'far', 'mini')
    expect(await waitCommand(['far'], h.deps)).toBe(EXIT.ok)
    expect(mini.closed).toBe(true)
  })
})

describe('harness close', () => {
  it('closes a harness the agent started, once it is idle', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead'), frame('kid')]
    const h = harness(d)
    started(h.ledger, 'lead', 'kid')
    expect(await closeCommand(['kid'], h.deps)).toBe(EXIT.ok)
    expect(h.out).toEqual(['Closed kid. Its conversation is kept.'])
    expect(d.requests.at(-1)).toMatchObject({ type: 'agent_close', payload: { agentId: 'kid', sessionId: 's-kid', mode: 'idle' } })
    const now = harness(d)
    expect(await closeCommand(['kid', '--now', '--json'], now.deps)).toBe(EXIT.ok)
    expect(JSON.parse(now.out[0])).toEqual({ name: 'kid', id: 'kid', closed: true })
    expect(d.requests.at(-1)?.payload.mode).toBe('now')
  })

  it('refuses an agent a harness it did not start, and its own; the person closes anything', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead'), frame('theirs')]
    const h = harness(d)
    expect(await closeCommand(['theirs'], h.deps)).toBe(EXIT.failed)
    expect(h.err[0]).toBe('You did not start theirs, so you may not close it. Only the person can.')
    expect(await closeCommand(['lead'], h.deps)).toBe(EXIT.failed)
    expect(h.err[1]).toBe('That is your own harness. The person closes it.')
    const person = harness(d, { pane: undefined })
    expect(await closeCommand(['theirs'], person.deps)).toBe(EXIT.ok)
    // An agent the daemon has stopped, or lists offline, is still that agent: never the person.
    d.frames = [frame('lead', { status: 'stopped' }), frame('theirs')]
    const stopped = harness(d)
    expect(await closeCommand(['theirs'], stopped.deps)).toBe(EXIT.failed)
    expect(stopped.err[0]).toMatch(/^You did not start theirs/)
    // A pane Harness made whose harness it has forgotten: what is left of an agent, never the person.
    d.frames = [frame('theirs')]
    const left = harness(d, { pane: '%gone', where: () => ({ ...where, harnessPane: true }) })
    expect(await closeCommand(['theirs'], left.deps)).toBe(EXIT.failed)
    expect(left.err[0]).toBe('This pane\'s harness is no longer running, so nothing here may close or start harnesses. Only the person can.')
    // A person's terminal in Harness, or a pane of their own tmux, is the person.
    d.frames = [frame('theirs'), frame('sh', { engine: 'terminal', tmuxPane: '%sh' })]
    expect(await closeCommand(['theirs'], harness(d, { pane: '%sh', where: () => ({ ...where, harnessPane: true }) }).deps)).toBe(EXIT.ok)
    expect(await closeCommand(['theirs'], harness(d, { pane: '%own' }).deps)).toBe(EXIT.ok)
  })

  it('says what to do when it is working or changed, and passes on any other refusal', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('k')]
    const replies: Array<Record<string, unknown>> = [
      { error: 'SESSION_NOT_IDLE', activity: 'working' }, { error: 'SESSION_NOT_IDLE', activity: 'needs_input' },
      { error: 'AGENT_CHANGED' }, { error: 'CLOSE_FAILED', detail: 'disk full' }, { error: 'CLOSE_FAILED' },
    ]
    d.extra.agent_close = () => replies.shift()!
    const h = harness(d, { pane: undefined })
    for (let i = 0; i < 5; i++) expect(await closeCommand(['k'], h.deps)).toBe(EXIT.failed)
    expect(h.err).toEqual([
      'k is working. Wait for it (harness wait k), or close it anyway with --now.',
      'k is waiting for the person. Wait for it (harness wait k), or close it anyway with --now.',
      'k changed while closing. Check it with harness show k, then try again.',
      'disk full',
      'Could not close k.',
    ])
  })

  it('closes one harness at a time, by name', async () => {
    const h = harness(new FakeDaemon())
    expect(await closeCommand([], h.deps)).toBe(EXIT.usage)
    expect(await closeCommand(['a', 'b'], h.deps)).toBe(EXIT.usage)
    expect(h.err).toContain('Close one harness at a time.')
  })
})

describe('harness new, run by an agent', () => {
  it('is nothing outside a harness pane, or in a person\'s terminal, or when the daemon is away', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('sh', { engine: 'terminal', tmuxPane: '%9' })]
    expect(await agentOrigin(harness(d, { pane: undefined }).deps)).toBeNull()
    expect(await agentOrigin(harness(d, { pane: '%9' }).deps)).toBeNull()
    expect(await agentOrigin(harness(d, { open: async () => { throw new Error('down') } }).deps)).toBeNull()
  })

  it('refuses from what is left of an agent whose harness is gone', async () => {
    const origin = (await agentOrigin(harness(new FakeDaemon(), { pane: '%gone', where: () => ({ ...where, harnessPane: true }) }).deps))!
    expect(() => origin.check()).toThrow(/no longer running/)
    expect(origin.prompt('x', 'm')).toBe('x')
    origin.created('m', {})
    expect(origin.next({})).toBe('')
  })

  it('heads the task with who sent it, records what it started, and says how to follow it', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    const h = harness(d)
    const origin = (await agentOrigin(h.deps))!
    expect(d.closed).toBe(true)
    expect(() => origin.check()).not.toThrow()
    expect(origin.prompt('review it', 'm')).toBe('[from lead · Claude Code · studio, the harness that started you. It reads your answer itself; to ask it something while you work: harness send lead "…"]\n\nreview it')
    expect(origin.prompt('train it', 'mini')).toBe('[from lead · Claude Code · studio, the harness that started you. It reads your answer itself.]\n\ntrain it')
    // A task longer than a first message holds: the whole of it in a file, its start in the message.
    const long = `Review all of it. ${'x'.repeat(3_000)}`
    const sent = origin.prompt(long, 'm')
    expect(sent.length).toBeLessThanOrEqual(2_000)
    const file = /All of it is in (\S+): read the whole file/.exec(sent)![1]
    expect(readFileSync(file, 'utf8')).toBe(long)
    expect(sent).toContain('It begins:\n\nReview all of it. xxx')
    expect(() => origin.prompt(long, 'mini')).toThrow(/another machine holds at most/)
    origin.created('m', { id: 'kid', name: 'reviewer' })
    origin.created('m', { name: 'no id' })
    expect(h.ledger.all()).toEqual([{ at: NOW, depth: 1, by: { machineId: 'm', agentId: 'lead', name: 'lead', engine: 'claude' }, child: { machineId: 'm', agentId: 'kid', name: 'reviewer' } }])
    origin.created('m', { id: 'kid2', name: 7 })
    expect(h.ledger.all()[1].child.name).toBe('')
    expect(origin.next({ id: 'kid', name: 'reviewer' })).toBe('Read it: harness show reviewer · wait for it: harness wait reviewer · message it: harness send reviewer "…"')
    // A name that is a sentence, or Harness's own stand-in: the id's start instead.
    expect(origin.next({ id: 'abcdef123456', name: 'Claude harness 10-11 8:38' })).toContain('harness show abcdef12 ·')
    expect(origin.next({ id: 'abcdef123456', name: 'code review' })).toContain('harness show "code review" ·')
    expect(addressOf({ machineId: 'm', agentId: 'abcdef123456', name: 'so we have built harness web,', engine: 'claude' })).toBe('abcdef12')
    expect(addressOf({ machineId: 'm', agentId: 'abcdef123456', name: 'x'.repeat(41), engine: 'claude' })).toBe('abcdef12')
  })

  it('refuses past the limits: depth, live harnesses per harness and per machine, and starts in ten minutes', async () => {
    const l = new Ledger(ledgerPath(dir))
    const lead = { machineId: 'm', agentId: 'lead', name: 'lead', engine: 'claude' }
    const frames = [frame('lead')]
    expect(spawnRefusal(lead, frames, l, 'm', NOW)).toBeNull()
    // Depth.
    l.append({ at: NOW, depth: SPAWN_LIMITS.depth, by: { ...lead, agentId: 'up' }, child: { machineId: 'm', agentId: 'deep', name: 'deep' } })
    expect(spawnRefusal({ ...lead, agentId: 'deep' }, frames, l, 'm', NOW)).toMatch(/this far down/)
    // Live per harness: here, listed; elsewhere, started in the last day.
    for (let i = 0; i < SPAWN_LIMITS.livePerHarness - 1; i++) {
      started(l, 'lead', `k${i}`, 'm', NOW - 3_600_000)
      frames.push(frame(`k${i}`))
    }
    started(l, 'lead', 'far', 'mini', NOW - 3_600_000)
    expect(spawnRefusal(lead, frames, l, 'm', NOW)).toBe('You have 8 harnesses running. Close one you are done with first (harness close <name>).')
    expect(spawnRefusal(lead, frames, l, 'm', NOW + 2 * 86_400_000)).toBeNull()
    // Per machine.
    const crowd = new Ledger(ledgerPath(mkdtempSync(join(dir, 'crowd-'))))
    const busy: Frame[] = []
    for (let i = 0; i < SPAWN_LIMITS.livePerMachine; i++) {
      crowd.append({ at: 0, depth: 1, by: { ...lead, agentId: `p${i}` }, child: { machineId: 'm', agentId: `c${i}`, name: `c${i}` } })
      busy.push(frame(`c${i}`))
    }
    expect(spawnRefusal(lead, busy, crowd, 'm', NOW)).toMatch(/^Agents have 40 harnesses running on this machine/)
    // Starts in ten minutes, live or not.
    const quick = new Ledger(ledgerPath(mkdtempSync(join(dir, 'quick-'))))
    for (let i = 0; i < SPAWN_LIMITS.perWindow; i++) started(quick, 'lead', `q${i}`, 'm', NOW - 60_000)
    expect(spawnRefusal(lead, [], quick, 'm', NOW)).toBe('You started 20 harnesses in 10 minutes. Wait, or work with the ones you have.')
    // The origin says so as a refusal.
    const d = new FakeDaemon()
    d.frames = [frame('lead')]
    const origin = (await agentOrigin(harness(d, { ledger: () => quick }).deps))!
    expect(() => origin.check()).toThrow(AgentClientError)
  })
})
