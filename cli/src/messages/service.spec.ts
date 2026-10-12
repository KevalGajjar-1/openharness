import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendNotice, TurnDelivery } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { PaneInbox } from './inbox.js'
import { deliveryKey, FYI_REASON } from './mailbox.js'
import { header, LIMITS, LONG_TEXT, longAdvice, MessageError, parseMessage, type Message } from './model.js'
import type { Rpc } from './rpc.js'
import { REMOTE_STATUS_MS, startAgentMessages, SWEEP_AFTER_MS, TICK_MS } from './service.js'
import { MessageStore } from './store.js'
import { Ledger, ledgerPath } from '../agentClient/ledger.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'agent-messages-')) })
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })

const OWNER_LOCAL = { local: true, owner: true }
const OWNER_REMOTE = { local: false, owner: true }
const session = (agentId: string, pane: string, engine = 'claude', cwd = `/work/${agentId}`) =>
  ({ agentId, sessionId: `s-${agentId}`, engine, cwd, tmuxPane: pane, active: true, title: agentId }) as unknown as RegisteredSession

interface Setup {
  tabs?: Array<{ id: string; name: string; enabled: boolean; panes: Array<{ machineId: string; agentId: string }> }>
  agents?: RegisteredSession[]
  rpc?: Rpc
  backendStatus?: number
}

function setup(over: Setup = {}) {
  let clock = 1_000_000
  const agents = over.agents ?? [session('lead', '%1', 'codex'), session('api', '%2'), session('web', '%3')]
  const tabs = over.tabs ?? [{ id: 'app', name: 'app', enabled: true, panes: [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm1', agentId: 'api' }, { machineId: 'm2', agentId: 'phone' }] }]
  const directory = { revision: 4, machines: [{ machineId: 'm1', name: 'studio' }, { machineId: 'm2', name: 'laptop' }], tabs }
  const delivered: Array<[string, string, string]> = []
  const windows: Array<Record<string, unknown>> = []
  const deliveryListeners = new Set<(event: TurnDelivery) => void>()
  const noticeListeners = new Set<(notice: BackendNotice) => void>()
  const backend = vi.fn(async () => ({ status: over.backendStatus ?? 200, body: { success: true, data: directory } }))
  const rpcCalls: Array<[string, Record<string, unknown>]> = []
  const rpc: Rpc = over.rpc ?? (async (target, payload) => {
    rpcCalls.push([target.machineId, payload])
    if (payload.action === 'who') return { agents: [{ agentId: 'phone', name: 'phone', engine: 'claude', project: 'app' }] }
    if (payload.action === 'deliver') return { statuses: [{ messageId: (payload.message as { id: string }).id, agentId: 'phone', state: 'queued' }] }
    return { statuses: [] }
  })
  const changed = vi.fn()
  const core = fakeCore({
    dataDir: root,
    daemon: { machineId: () => 'm1', port: 18473 },
    agents: {
      live: () => agents,
      displayName: (s) => (s as unknown as { title: string }).title,
      terminalAvailable: () => true,
    },
    turns: {
      deliver: (agentId, text, id) => { delivered.push([agentId, text, id]) },
      onDelivery: (listener) => { deliveryListeners.add(listener); return () => deliveryListeners.delete(listener) },
    },
    account: {
      backend,
      onNotice: (listener) => { noticeListeners.add(listener); return () => noticeListeners.delete(listener) },
    },
    clients: { windows: (frame) => { windows.push(frame) } },
  })
  const service = startAgentMessages(core, { stateDir: join(root, 'state'), inboxRoot: join(root, 'inbox-root'), rpc: over.rpc ? over.rpc : rpc, now: () => clock, changed })
  const ask = (payload: Record<string, unknown>, asker = OWNER_LOCAL) => service.requests.agent_messages!(payload, asker)
  return {
    service, ask, delivered, windows, backend, rpcCalls, agents, tabs, directory, changed,
    inbox: new PaneInbox(join(root, 'inbox-root')),
    tick: (ms: number) => { clock += ms },
    deliveryEvent: (event: TurnDelivery) => { for (const l of deliveryListeners) l(event) },
    notice: (notice: BackendNotice) => { for (const l of noticeListeners) l(notice) },
  }
}

describe('harness send', () => {
  it('sends from the pane\'s harness to a teammate on this machine, typed into it when idle, with the roster note first', async () => {
    const t = setup()
    const reply = await t.ask({ action: 'send', pane: '%1', to: ['api'], text: 'Is the cleanup fix in?' })
    expect(reply).toMatchObject({ tab: 'app', recipients: [{ name: 'api', state: 'queued' }] })
    const id = reply.id as string
    expect(id).toMatch(/^m[0-9a-z]{7}$/)
    expect(t.delivered).toHaveLength(1)
    const [agentId, text, deliveryId] = t.delivered[0]
    expect(agentId).toBe('api')
    expect(deliveryId).toBe(`team:msg:${deliveryKey(id, 'api')}:1`)
    expect(text).toContain('[Harness] Agent Messages are on in tab "app". Teammates:')
    expect(text).toContain('lead')
    expect(text).toContain('phone')
    expect(text).toContain(`[${id} from lead · Codex · studio]\nIs the cleanup fix in?`)
    expect(t.service.canWrite(deliveryId)).toBe(true)
    // The core typed it: delivered, and the windows hear of it.
    t.deliveryEvent({ deliveryId, sessionId: 'api', state: 'started' })
    const history = await t.ask({ action: 'history', tabId: 'app' })
    expect(history.messages).toEqual([expect.objectContaining({ id, statuses: expect.arrayContaining([
      expect.objectContaining({ machineId: 'm1', agentId: 'api', state: 'delivered', via: 'prompt' }),
    ]) })])
    expect(t.windows.at(-1)).toMatchObject({ type: 'messages_changed', payload: { tabId: 'app', messageId: id, to: [{ agentId: 'api', state: 'delivered' }] } })
    // The note rode with the message: the next one comes without it.
    const second = await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'thanks' })
    expect(t.delivered.at(-1)![1]).toBe(`[${second.id} from lead · Codex · studio]\nthanks`)
  })

  it('hands a teammate on another machine to that machine, and asks later what became of it', async () => {
    const t = setup()
    const reply = await t.ask({ action: 'send', pane: '%1', to: ['phone'], text: 'ping' })
    expect(reply.recipients).toEqual([{ name: 'phone', state: 'queued' }])
    expect(t.rpcCalls.map(([machine, p]) => [machine, p.action])).toEqual([['m2', 'who'], ['m2', 'deliver']])
    expect(t.rpcCalls[1][1].message).toMatchObject({ id: reply.id, from: { agentId: 'lead', machine: 'studio' }, to: [{ machineId: 'm2', agentId: 'phone', name: 'phone' }] })
    t.tick(REMOTE_STATUS_MS)
  })

  it('without a recipient lists who is here; and says plainly what is wrong with a send', async () => {
    const t = setup()
    const roster = await t.ask({ action: 'send', pane: '%1' })
    expect(roster.roster).toContain('Teammates:')
    expect(roster.roster).toMatch(/api\s+Claude Code · studio · api/)
    expect(roster.roster).toMatch(/phone\s+Claude Code · laptop · app/)
    const fail = async (payload: Record<string, unknown>, asker = OWNER_LOCAL) => (await t.ask(payload, asker)).error
    expect(await fail({ action: 'send', pane: 'nope', to: 'api', text: 'x' })).toBe('NOT_A_HARNESS')
    expect(await fail({ action: 'send', pane: '%99', to: 'api', text: 'x' })).toBe('NOT_A_HARNESS')
    expect(await fail({ action: 'send', pane: '%1', text: 'x' })).toBe('USAGE')
    expect(await fail({ action: 'send', pane: '%1', to: 'api', text: '  ' })).toBe('USAGE')
    expect(await fail({ action: 'send', pane: '%1', to: 'api', text: 'x'.repeat(LIMITS.text + 1) })).toBe('TOO_LONG')
    expect(await fail({ action: 'send', pane: '%1', to: 'nobody', text: 'x' })).toBe('UNKNOWN_RECIPIENT')
    // A unique start of a name is enough.
    expect((await t.ask({ action: 'send', pane: '%1', to: 'ph', text: 'x' })).recipients).toEqual([{ name: 'phone', state: 'queued' }])
    expect(await fail({ action: 'send', pane: '%1', to: 'api', text: 'x' }, OWNER_REMOTE)).toBe('LOCAL_ONLY')
    expect(await fail({ action: 'send', pane: '%1', to: 'api', text: 'x' }, { local: true, owner: false })).toBe('OWNER_REQUIRED')
    expect(await fail({ action: 'nonsense' })).toBe('UNKNOWN_ACTION')
    // Sent to the same teammate twice in one message: once.
    const twice = await t.ask({ action: 'send', pane: '%1', to: 'api,API', text: 'once' })
    expect(twice.recipients).toHaveLength(1)
    // Its last messages come back with the roster, as the sender and as the recipient see them.
    const lead = await t.ask({ action: 'send', pane: '%1' })
    expect((lead.recent as Array<Record<string, unknown>>).at(-1)).toMatchObject({ id: twice.id, to: ['api'], text: 'once', state: 'queued' })
    const api = await t.ask({ action: 'send', pane: '%2' })
    expect((api.recent as Array<Record<string, unknown>>).at(-1)).toMatchObject({ id: twice.id, from: 'lead', state: 'queued' })
  })

  it('gives an agent that reads its messages itself every one still waiting, whole and once, then its last few', async () => {
    // A Codex lead running since before Agent Messages never ran the hook and, always working, was never typed to: it
    // read `harness send` alone, which gave only its last five, each still "queued" (2026-10-12).
    const t = setup()
    const ids: string[] = []
    for (let i = 1; i <= 7; i++) {
      const sent = await t.ask({ action: 'send', pane: '%1', to: 'api', text: `finding ${i}\nwith its details` })
      ids.push(String(sent.id))
      // api is working: each typed attempt goes back to the hook, which never runs.
      t.deliveryEvent({ deliveryId: t.delivered.at(-1)![2], sessionId: 'api', state: 'rejected', reason: 'team_waiting_idle' })
    }
    const first = (await t.ask({ action: 'send', pane: '%2' })).recent as Array<Record<string, unknown>>
    const unread = first.filter((m) => m.unread === true)
    expect(unread.map((m) => m.id)).toEqual(ids)
    expect(unread.every((m) => m.state === 'delivered' && m.text === `finding ${ids.indexOf(String(m.id)) + 1}\nwith its details`)).toBe(true)
    const history = await t.ask({ action: 'history', tabId: 'app' }) as { messages: Array<{ statuses: Array<Record<string, unknown>> }> }
    expect(history.messages.flatMap((m) => m.statuses).filter((s) => s.agentId === 'api').every((s) => s.state === 'delivered' && s.via === 'read')).toBe(true)
    // Read once: the next look gives nothing new, and its last five as before.
    const again = (await t.ask({ action: 'send', pane: '%2' })).recent as Array<Record<string, unknown>>
    expect(again.filter((m) => m.unread)).toEqual([])
    expect(again.map((m) => m.id)).toEqual(ids.slice(-5))
    // The sender sees them delivered.
    const lead = (await t.ask({ action: 'send', pane: '%1' })).recent as Array<Record<string, unknown>>
    expect(lead.every((m) => m.state === 'delivered')).toBe(true)
  })

  it('sends news that never starts a turn of an idle teammate, marked as news where it is read', async () => {
    const t = setup()
    const sent = await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'quiet window 04:19–04:22Z', fyi: true })
    expect(sent.recipients).toEqual([{ name: 'api', state: 'queued', reason: FYI_REASON }])
    expect(t.delivered).toEqual([])
    const read = (await t.ask({ action: 'send', pane: '%2' })).recent as Array<Record<string, unknown>>
    expect(read.find((m) => m.id === sent.id)).toMatchObject({ unread: true, state: 'delivered', text: 'quiet window 04:19–04:22Z' })
    const history = await t.ask({ action: 'history', tabId: 'app' }) as { messages: Array<Record<string, unknown>> }
    expect(history.messages.find((m) => m.id === sent.id)).toMatchObject({ fyi: true })
    expect(header({ ...(history.messages[0] as unknown as Message), fyi: true })).toMatch(/ · FYI\]$/)
    expect(header({ ...(history.messages[0] as unknown as Message), fyi: undefined })).not.toMatch(/FYI/)
    // Only `true` is news on the wire.
    expect(parseMessage({ ...history.messages[0], fyi: 'yes' })).not.toHaveProperty('fyi')
  })

  it('sends a long message, and tells its sender what it costs the teammates who read it', async () => {
    const t = setup()
    expect(await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'x'.repeat(LONG_TEXT) })).not.toHaveProperty('advice')
    const long = await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'x'.repeat(LONG_TEXT + 1) })
    expect(long.recipients).toHaveLength(1)
    expect(long.advice).toBe(longAdvice(LONG_TEXT + 1))
    expect(long.advice).toMatch(/leave the rest in the repo/)
  })

  it('tells two teammates with the same start apart only by more of the name', async () => {
    const t = setup({
      agents: [session('lead', '%1'), session('api-a', '%2'), session('api-b', '%3')],
      tabs: [{ id: 'app', name: 'app', enabled: true, panes: ['lead', 'api-a', 'api-b'].map((agentId) => ({ machineId: 'm1', agentId })) }],
    })
    expect((await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })).error).toBe('AMBIGUOUS_RECIPIENT')
    expect((await t.ask({ action: 'send', pane: '%1', to: 'api-b', text: 'x' })).recipients).toEqual([{ name: 'api-b', state: 'queued' }])
  })

  it('tells apart teammates that share a title, the sender included, by the start of their ids', async () => {
    // Two Codex agents titled themselves after the same task, and the roster named the teammate as the agent itself
    // (a fresh Mac, 2026-10-12).
    const titled = (agentId: string, pane: string) => ({ ...session(agentId, pane, 'codex'), title: 'Ask teammate to create notes' }) as unknown as RegisteredSession
    const t = setup({
      agents: [titled('efedc3c7-lead', '%1'), titled('07934321-one', '%2'), titled('11112222-two', '%3')],
      tabs: [{ id: 'app', name: 'app', enabled: true, panes: ['efedc3c7-lead', '07934321-one', '11112222-two'].map((agentId) => ({ machineId: 'm1', agentId })) }],
    })
    const roster = String((await t.ask({ action: 'send', pane: '%1' })).roster)
    expect(roster).toContain('Ask teammate to create notes (07934321)')
    expect(roster).toContain('Ask teammate to create notes (11112222)')
    expect((await t.ask({ action: 'send', pane: '%1', to: 'Ask teammate to create notes', text: 'x' })).error).toBe('AMBIGUOUS_RECIPIENT')
    expect((await t.ask({ action: 'send', pane: '%1', to: 'Ask teammate to create notes (07934321)', text: 'x' })).recipients)
      .toEqual([{ name: 'Ask teammate to create notes (07934321)', state: 'queued' }])
    expect((await t.ask({ action: 'send', pane: '%1', to: '11112222', text: 'x' })).recipients)
      .toEqual([{ name: 'Ask teammate to create notes (11112222)', state: 'queued' }])
    // Its header names the sender as its teammates' roster does, so a reply finds it.
    const history = await t.ask({ action: 'history' }) as { messages: Array<{ from: { name: string } }> }
    expect(history.messages.map((m) => m.from.name)).toEqual(['Ask teammate to create notes (efedc3c7)', 'Ask teammate to create notes (efedc3c7)'])
    // A title no one else has stays as it is.
    const plain = setup()
    expect(String((await plain.ask({ action: 'send', pane: '%1' })).roster)).toMatch(/^ {2}api {2}/m)
  })

  it('takes the whole name of a teammate whose engine cut its title short', async () => {
    // Codex titles its terminal with the folder cut to fit; an agent wrote the folder out and was told no one had
    // that name (a fresh Mac, 2026-10-12).
    const t = setup({
      agents: [session('lead', '%1'), { ...session('cx', '%2', 'codex'), title: 'claude-code-2026-10-1...' } as unknown as RegisteredSession,
        { ...session('dots', '%3', 'codex'), title: '...' } as unknown as RegisteredSession],
      tabs: [{ id: 'app', name: 'app', enabled: true, panes: ['lead', 'cx', 'dots'].map((agentId) => ({ machineId: 'm1', agentId })) }],
    })
    expect((await t.ask({ action: 'send', pane: '%1', to: 'claude-code-2026-10-12-02-15', text: 'x' })).recipients)
      .toEqual([{ name: 'claude-code-2026-10-1...', state: 'queued' }])
    expect((await t.ask({ action: 'send', pane: '%1', to: 'claude-code-2026-10-1…', text: 'x' })).recipients)
      .toEqual([{ name: 'claude-code-2026-10-1...', state: 'queued' }])
    // A title that is nothing but an ellipsis is no stem for every name.
    expect((await t.ask({ action: 'send', pane: '%1', to: 'zzz', text: 'x' })).error).toBe('UNKNOWN_RECIPIENT')
  })

  it('names in the note only a tab the person named; the windows label any other themselves', async () => {
    // The note said tab "New Tab" for a tab the window showed as "code" (a fresh Mac, 2026-10-12).
    const pair = [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm1', agentId: 'api' }]
    const roster = async (tabs: Array<Record<string, unknown>>) =>
      String((await setup({ tabs: tabs as unknown as Setup['tabs'] }).ask({ action: 'send', pane: '%1' })).roster).split('\n')[0]
    expect(await roster([{ id: 'a', name: 'claude-code-2026-10-12-02-15', named: false, enabled: true, panes: pair }]))
      .toBe('[Harness] Agent Messages are on in this tab. Teammates:')
    expect(await roster([{ id: 'a', name: 'app', named: true, enabled: true, panes: pair }])).toBe('[Harness] Agent Messages are on in tab "app". Teammates:')
    expect(await roster([{ id: 'a', name: 'app', named: true, enabled: true, panes: pair }, { id: 'b', name: 'web', named: true, enabled: true, panes: pair }]))
      .toBe('[Harness] Agent Messages are on in tabs "app", "web". Teammates:')
    expect(await roster([{ id: 'a', name: 'app', named: true, enabled: true, panes: pair }, { id: 'b', name: 'New Tab', named: false, enabled: true, panes: pair }]))
      .toBe('[Harness] Agent Messages are on in tab "app" and this one. Teammates:')
    // A backend from before `named`: only the window's own default name is no name.
    expect(await roster([{ id: 'a', name: 'New Tab', enabled: true, panes: pair }])).toBe('[Harness] Agent Messages are on in this tab. Teammates:')
    expect(await roster([{ id: 'a', name: 'app', enabled: true, panes: pair }])).toBe('[Harness] Agent Messages are on in tab "app". Teammates:')
  })

  it('refuses in a tab with Agent Messages off, and when the directory cannot be read', async () => {
    const off = setup({ tabs: [{ id: 'app', name: 'app', enabled: false, panes: [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm1', agentId: 'api' }] }] })
    expect(await off.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })).toMatchObject({ error: 'MESSAGES_OFF' })
    const down = setup({ backendStatus: 500 })
    expect(await down.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })).toMatchObject({ error: 'DIRECTORY_UNAVAILABLE' })
  })

  it('sends nothing when the tab turns Agent Messages off while it asks another machine for names', async () => {
    let t: ReturnType<typeof setup>
    t = setup({ rpc: async (_target, payload) => {
      if (payload.action === 'who') {
        t.tabs[0].enabled = false
        t.notice({ type: 'desk_changed', revision: 5 })
        await new Promise((settle) => setTimeout(settle, 0))
        return { agents: [{ agentId: 'phone', name: 'phone', engine: 'claude' }] }
      }
      return { statuses: [] }
    } })
    expect(await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })).toEqual({ error: 'MESSAGES_OFF', detail: 'api is no longer in a tab with you that has Agent Messages on. Nothing was sent.' })
    expect(t.delivered).toEqual([])
    expect((await t.ask({ action: 'history' })).messages).toEqual([])
  })

  it('limits how often one harness sends, and tells the windows', async () => {
    const t = setup()
    for (let i = 0; i < LIMITS.perSender; i++) await t.ask({ action: 'send', pane: '%1', to: 'api', text: `n${i}` })
    expect(await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'one more' })).toMatchObject({ error: 'RATE_LIMITED' })
    expect(t.windows.some((w) => (w.payload as Record<string, unknown>).limited)).toBe(true)
    t.tick(LIMITS.window)
    expect((await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'later' })).recipients).toBeDefined()
  })

  it('keeps a message for a machine that is away, and hands it over once it is back', async () => {
    vi.useFakeTimers()
    let away = true
    const calls: string[] = []
    const t = setup({ rpc: async (target, payload) => {
      calls.push(String(payload.action))
      if (payload.action === 'who') return { agents: [{ agentId: 'phone', name: 'phone', engine: 'claude' }] }
      if (away) throw new MessageError(payload.action === 'deliver' && calls.length > 4 ? 'NO_PEER_LINK' : 'DISCONNECTED', 'away')
      if (payload.action === 'deliver') return { statuses: [{ messageId: (payload.message as { id: string }).id, agentId: 'phone', state: 'delivered', via: 'hook' }] }
      return { statuses: [] }
    } })
    t.service.start()
    const reply = await t.ask({ action: 'send', pane: '%1', to: 'phone', text: 'when you are back' })
    expect(reply.recipients).toEqual([{ name: 'phone', state: 'queued', reason: 'that machine is away: it is handed over once it is back' }])
    away = false
    t.tick(60_000)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    const history = await t.ask({ action: 'history' })
    expect((history.messages as Array<{ statuses: unknown[] }>)[0].statuses).toEqual([expect.objectContaining({ machineId: 'm2', agentId: 'phone', state: 'delivered', via: 'hook' })])
    t.service.stop()
  })

  it('keeps how another machine\'s agent got a message, read with `harness send` too, and nothing else', async () => {
    vi.useFakeTimers()
    let via: unknown = 'read'
    const t = setup({ rpc: async (target, payload) => {
      if (payload.action === 'who') return { agents: [{ agentId: 'phone', name: 'phone', engine: 'claude' }] }
      if (payload.action === 'deliver') return { statuses: [{ messageId: (payload.message as { id: string }).id, agentId: 'phone', state: 'queued' }] }
      return { statuses: (payload.ids as string[]).map((messageId) => ({ messageId, agentId: 'phone', state: 'delivered', via })) }
    } })
    t.service.start()
    await t.ask({ action: 'send', pane: '%1', to: 'phone', text: 'when you have a minute' })
    t.tick(60_000)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    const statuses = async () => ((await t.ask({ action: 'history' })).messages as Array<{ statuses: unknown[] }>).at(-1)!.statuses
    expect(await statuses()).toEqual([expect.objectContaining({ machineId: 'm2', agentId: 'phone', state: 'delivered', via: 'read' })])
    via = 'typed'
    await t.ask({ action: 'send', pane: '%1', to: 'phone', text: 'and another' })
    t.tick(60_000)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(await statuses()).toEqual([expect.not.objectContaining({ via: expect.anything() })])
    t.service.stop()
  })
})

describe('a harness and the harnesses it started', () => {
  // Agent Messages off means off (owner, 2026-10-11): being started by a harness is no way to message it. Since #1180
  // the two messaged each other with no tab at all, and the owner found agents talking before turning any tab on.
  const start = (by: string, child: string, childMachine = 'm1') => new Ledger(ledgerPath(root)).append({
    at: 1, depth: 1, by: { machineId: 'm1', agentId: by, name: by, engine: 'codex' }, child: { machineId: childMachine, agentId: child, name: child },
  })

  it('may not message each other where no tab has Agent Messages on, either way', async () => {
    const t = setup({ tabs: [{ id: 'app', name: 'app', enabled: false, panes: [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm1', agentId: 'web' }] }] })
    start('lead', 'web')
    expect(await t.ask({ action: 'send', pane: '%1', to: 'web', text: 'Also check the footer.' })).toMatchObject({ error: 'MESSAGES_OFF' })
    expect(await t.ask({ action: 'send', pane: '%3', to: 'lead', text: 'Done: 3 fixes.' })).toMatchObject({ error: 'MESSAGES_OFF' })
    // Nor does `harness send` alone list them.
    expect(await t.ask({ action: 'send', pane: '%1' })).toMatchObject({ error: 'MESSAGES_OFF' })
    const none = setup({ tabs: [] })
    expect(await none.ask({ action: 'send', pane: '%1', to: 'web', text: 'x' })).toMatchObject({ error: 'MESSAGES_OFF' })
    expect(t.delivered).toEqual([])
    expect(none.delivered).toEqual([])
  })

  it('are refused as any other recipient outside the sender\'s tabs, and listed only as tab teammates', async () => {
    // lead and api share a tab with Agent Messages on; web, which lead started, is in none.
    const t = setup()
    start('lead', 'web')
    start('lead', 'api')
    const refused = await t.ask({ action: 'send', pane: '%1', to: 'web', text: 'x' })
    expect(refused).toEqual({ error: 'UNKNOWN_RECIPIENT', detail: 'No teammate named "web" in this tab. Teammates: api, phone.' })
    expect(await t.ask({ action: 'send', pane: '%3', to: 'lead', text: 'x' })).toMatchObject({ error: 'MESSAGES_OFF' })
    const roster = await t.ask({ action: 'send', pane: '%1' })
    expect(roster.roster).toContain('Teammates:')
    expect(roster.roster).not.toMatch(/\bweb\b/)
    expect(roster.roster).not.toContain('started you')
    // A child in the tab is a teammate like any other: reached through the tab, and logged there.
    const both = await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'sync' })
    expect(both).toMatchObject({ tab: 'app', recipients: [{ name: 'api', state: 'queued' }] })
    expect(t.delivered.map(([agentId]) => agentId)).toEqual(['api'])
  })

  it('a message an older version queued between them under no tab is never delivered, read directory or not', async () => {
    vi.useFakeTimers()
    // Queued by 0.3.75 under its `started` log: one waiting in web's inbox for its hook, and one to api, which shares
    // a tab with Agent Messages on with lead now.
    const store = new MessageStore(join(root, 'state'))
    const old = (id: string, to: string) => ({ id, tabId: 'started', at: 1, text: 'Also check the footer.',
      from: { machineId: 'm1', agentId: 'lead', name: 'lead', engine: 'codex', machine: 'studio' }, to: [{ machineId: 'm1', agentId: to, name: to }] })
    const queue = (id: string, to: string, pane: string) => {
      store.record(old(id, to))
      store.status({ messageId: id, machineId: 'm1', agentId: to, state: 'queued', at: 1 })
      store.state.local.push({ key: deliveryKey(id, to), messageId: id, agentId: to, pane, session: `s-${to}`, state: 'queued', tries: 0, nextTryAt: 0, at: 1 })
      new PaneInbox(join(root, 'inbox-root')).put(pane, deliveryKey(id, to), { session: `s-${to}`, text: 'Also check the footer.' })
    }
    queue('m0000old', 'web', '%3')
    queue('m0000ol2', 'api', '%2')
    store.save()
    start('lead', 'web')
    // The directory cannot be read: they are failed all the same, before a hook can take them.
    const t = setup({ backendStatus: 500 })
    expect(t.inbox.waiting('%3', deliveryKey('m0000old', 'web'))).toBe(true)
    t.service.start()
    expect(t.inbox.waiting('%3', deliveryKey('m0000old', 'web'))).toBe(false)
    expect(t.inbox.waiting('%2', deliveryKey('m0000ol2', 'api'))).toBe(false)
    await vi.advanceTimersByTimeAsync(TICK_MS * 2)
    expect(t.delivered).toEqual([])
    const history = await t.ask({ action: 'history', tabId: 'started' })
    expect((history.messages as Array<{ statuses: unknown[] }>).map((m) => m.statuses)).toEqual([
      [expect.objectContaining({ machineId: 'm1', agentId: 'web', state: 'failed', reason: 'it was sent outside any tab with Agent Messages on' })],
      [expect.objectContaining({ machineId: 'm1', agentId: 'api', state: 'failed', reason: 'it was sent outside any tab with Agent Messages on' })],
    ])
    t.service.stop()
  })

  it('a hand-over an older machine logged under `started` is failed even between two in a tab with Agent Messages on', async () => {
    const t = setup()
    const answer = await t.ask({ action: 'deliver', message: { id: 'm00000cc', tabId: 'started', text: 'hi', at: 5,
      from: { machineId: 'm2', agentId: 'phone', name: 'phone', engine: 'claude', machine: 'laptop' }, to: [{ machineId: 'm1', agentId: 'api', name: 'api' }] } }, OWNER_REMOTE)
    expect(answer.statuses).toEqual([expect.objectContaining({ agentId: 'api', state: 'failed', reason: 'it was sent outside any tab with Agent Messages on' })])
    expect(t.delivered).toEqual([])
  })

  it('reach a tab teammate by the start of its id, for a harness whose name is a sentence', async () => {
    const titled = { ...session('abcdef99-1', '%3'), title: 'so we have built it, then' } as unknown as RegisteredSession
    const t = setup({ agents: [session('lead', '%1', 'codex'), titled],
      tabs: [{ id: 'app', name: 'app', enabled: true, panes: [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm1', agentId: 'abcdef99-1' }] }] })
    expect((await t.ask({ action: 'send', pane: '%1', to: 'abcdef', text: 'x' })).recipients).toEqual([{ name: 'so we have built it, then', state: 'queued' }])
    // Too short to be an id's start.
    expect((await t.ask({ action: 'send', pane: '%1', to: 'abcde', text: 'x' })).error).toBe('UNKNOWN_RECIPIENT')
  })

  it('keep the record of a harness another machine started here, from that machine only', async () => {
    const t = setup()
    const row = { at: 5, depth: 2, by: { machineId: 'm2', agentId: 'phone', name: 'phone', engine: 'claude' }, child: { machineId: 'm1', agentId: 'web', name: 'web' } }
    expect(await t.ask({ action: 'started', row }, OWNER_REMOTE)).toEqual({ recorded: true })
    expect(new Ledger(ledgerPath(root)).parentOf({ machineId: 'm1', agentId: 'web' })).toMatchObject({ depth: 2, by: { machineId: 'm2' } })
    expect((await t.ask({ action: 'started', row }, OWNER_LOCAL)).error).toBe('REMOTE_ONLY')
    expect((await t.ask({ action: 'started', row: { ...row, child: { ...row.child, machineId: 'm3' } } }, OWNER_REMOTE)).error).toBe('INVALID_RECORD')
    expect((await t.ask({ action: 'started', row: { ...row, by: { ...row.by, machineId: 'm1' } } }, OWNER_REMOTE)).error).toBe('INVALID_RECORD')
    expect((await t.ask({ action: 'started' }, OWNER_REMOTE)).error).toBe('INVALID_RECORD')
    expect((await t.ask({ action: 'started', row: { ...row, child: { ...row.child, agentId: 'nobody' } } }, OWNER_REMOTE)).error).toBe('UNKNOWN_HARNESS')
    // The record lets neither message the other: phone is no teammate of web's.
    const delivered = await t.ask({ action: 'deliver', message: { id: 'm00000bb', tabId: 'started', text: 'hi', at: 5,
      from: { machineId: 'm2', agentId: 'phone', name: 'phone', engine: 'claude', machine: 'laptop' }, to: [{ machineId: 'm1', agentId: 'web', name: 'web' }] } }, OWNER_REMOTE)
    expect(delivered.statuses).toEqual([expect.objectContaining({ agentId: 'web', state: 'failed' })])
    expect(t.delivered).toEqual([])
  })

  it('stay apart across machines: another machine checks against its own tabs', async () => {
    const t = setup({ tabs: [] })
    start('lead', 'phone', 'm2')
    expect((await t.ask({ action: 'send', pane: '%1', to: 'phone', text: 'x' })).error).toBe('MESSAGES_OFF')
  })
})

describe('from the owner\'s other machines', () => {
  const incoming = (to = 'api', from = { machineId: 'm2', agentId: 'phone' }) => ({
    id: 'm00000aa', tabId: 'app', text: 'from the phone', at: 5,
    from: { ...from, name: 'phone', engine: 'claude', machine: 'laptop' },
    to: [{ machineId: 'm1', agentId: to, name: to }],
  })

  it('delivers a message for one of this machine\'s agents that shares an on tab with the sender, once', async () => {
    const t = setup()
    const answer = await t.ask({ action: 'deliver', message: incoming() }, OWNER_REMOTE)
    expect(answer.statuses).toEqual([expect.objectContaining({ messageId: 'm00000aa', machineId: 'm1', agentId: 'api', state: 'queued' })])
    expect(t.delivered).toHaveLength(1)
    // Handed over again after a lost reply: the same delivery, not a second.
    await t.ask({ action: 'deliver', message: incoming() }, OWNER_REMOTE)
    expect(t.delivered).toHaveLength(1)
    t.deliveryEvent({ deliveryId: t.delivered[0][2], sessionId: 'api', state: 'delivered' })
    expect(await t.ask({ action: 'status', ids: ['m00000aa', 'unknown'] }, OWNER_REMOTE)).toEqual({ statuses: [expect.objectContaining({ state: 'delivered', via: 'prompt' })] })
  })

  it('takes a hand-over only from another machine, never naming this one as the sender, and not while the directory is unknown', async () => {
    const t = setup()
    expect(await t.ask({ action: 'deliver', message: incoming() }, OWNER_LOCAL)).toMatchObject({ error: 'REMOTE_ONLY' })
    expect(await t.ask({ action: 'status', ids: [] }, OWNER_LOCAL)).toMatchObject({ error: 'REMOTE_ONLY' })
    expect(await t.ask({ action: 'who', agentIds: [] }, OWNER_LOCAL)).toMatchObject({ error: 'REMOTE_ONLY' })
    expect(await t.ask({ action: 'deliver', message: incoming('api', { machineId: 'm1', agentId: 'lead' }) }, OWNER_REMOTE)).toMatchObject({ error: 'NOT_FROM_THERE' })
    expect(t.delivered).toHaveLength(0)
    const down = setup({ backendStatus: 500 })
    expect(await down.ask({ action: 'deliver', message: incoming() }, OWNER_REMOTE)).toMatchObject({ error: 'DIRECTORY_UNAVAILABLE' })
  })

  it('refuses a hand-over once too many messages wait on this machine', async () => {
    const t = setup()
    for (let i = 0; i < LIMITS.waiting; i++) {
      const m = { ...incoming(), id: `m${String(i).padStart(7, '0')}` }
      await t.ask({ action: 'deliver', message: m }, OWNER_REMOTE)
      t.deliveryEvent({ deliveryId: t.delivered.at(-1)![2], sessionId: 'api', state: 'rejected', reason: 'team_waiting_idle' })
    }
    expect(await t.ask({ action: 'deliver', message: { ...incoming(), id: 'mzzzzzzz' } }, OWNER_REMOTE)).toMatchObject({ error: 'MAILBOX_FULL' })
    // Five hundred deliveries, each saved to disk: about five seconds on a busy machine.
  }, 30_000)

  it('refuses a message for an agent outside the sender\'s tabs, and one that is not a message', async () => {
    const t = setup()
    const answer = await t.ask({ action: 'deliver', message: incoming('web') }, OWNER_REMOTE)
    expect(answer.statuses).toEqual([expect.objectContaining({ agentId: 'web', state: 'failed' })])
    expect(t.delivered).toHaveLength(0)
    expect(await t.ask({ action: 'deliver', message: { id: 'x' } }, OWNER_REMOTE)).toMatchObject({ error: 'INVALID_MESSAGE' })
  })

  it('names its agents for another machine, and only those it has', async () => {
    const t = setup()
    expect(await t.ask({ action: 'who', agentIds: ['api', 'ghost', 3] }, OWNER_REMOTE)).toEqual({ agents: [{ agentId: 'api', name: 'api', engine: 'claude', project: 'api' }] })
    expect(await t.ask({ action: 'who' }, OWNER_REMOTE)).toEqual({ agents: [] })
    expect(await t.ask({ action: 'status' }, OWNER_REMOTE)).toEqual({ statuses: [] })
  })
})

describe('the roster note and the directory', () => {
  it('puts the note in each agent\'s inbox once the tab has a teammate, and takes it back when the tab turns off', async () => {
    vi.useFakeTimers()
    const t = setup()
    t.service.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    const waiting = (pane: string) => {
      const dir = t.inbox.paneDir(pane)!
      try { return require('node:fs').readdirSync(dir) as string[] } catch { return [] }
    }
    expect(waiting('%1').some((n) => n.startsWith('0note-'))).toBe(true)
    expect(waiting('%2').some((n) => n.startsWith('0note-'))).toBe(true)
    // Web is in no tab with Agent Messages on: nothing.
    expect(waiting('%3')).toEqual([])
    // The hook took lead's note: it is not put again.
    const note = waiting('%1').find((n) => n.startsWith('0note-'))!.replace(/\.json$/, '')
    require('node:fs').mkdirSync(join(root, 'inbox-root', 'claimed'), { recursive: true })
    require('node:fs').renameSync(join(t.inbox.paneDir('%1')!, `${note}.json`), join(root, 'inbox-root', 'claimed', `1-${note}.json`))
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(waiting('%1')).toEqual([])
    // Turned off: the notes go.
    t.tabs[0].enabled = false
    t.notice({ type: 'desk_changed', revision: 5 })
    await vi.advanceTimersByTimeAsync(0)
    expect(waiting('%2')).toEqual([])
    t.service.stop()
  })

  it('keeps the notes it put in the store, withdraws a gone harness\'s, and sweeps old files nothing waits on', async () => {
    vi.useFakeTimers()
    const t = setup()
    t.service.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    const fs = require('node:fs') as typeof import('node:fs')
    const state = () => JSON.parse(fs.readFileSync(join(root, 'state', 'state.json'), 'utf8'))
    expect(Object.keys(state().notes).sort()).toEqual(['api', 'lead'])
    // api's harness is gone: its note goes with it.
    t.agents.splice(1, 1)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(Object.keys(state().notes)).toEqual(['lead'])
    expect(t.inbox.paneDir('%2') && fs.existsSync(t.inbox.paneDir('%2')!)).toBe(false)
    t.service.stop()
    // A file nothing here waits on, from a service long gone: swept at the next start once it is old.
    t.inbox.put('%7', 'm0000999-aaaa', { session: 'gone', text: 'stale' })
    const old = (Date.now() - SWEEP_AFTER_MS - 1000) / 1000
    fs.utimesSync(join(t.inbox.paneDir('%7')!, 'm0000999-aaaa.json'), old, old)
    t.inbox.put('%8', 'fresh', { session: 'other daemon', text: 'fresh' })
    const again = startAgentMessages(fakeCore({ dataDir: root, daemon: { machineId: () => 'm1', port: 18473 }, agents: { live: () => t.agents, displayName: (s) => (s as unknown as { title: string }).title, terminalAvailable: () => true }, account: { backend: t.backend } }),
      { stateDir: join(root, 'state'), inboxRoot: join(root, 'inbox-root'), now: () => Date.now() })
    again.start()
    expect(t.inbox.waiting('%7', 'm0000999-aaaa')).toBe(false)
    expect(t.inbox.waiting('%8', 'fresh')).toBe(true)
    again.reconnected?.()
    again.stop()
  })

  it('fails a waiting delivery once its tab turns Agent Messages off', async () => {
    const t = setup()
    const reply = await t.ask({ action: 'send', pane: '%1', to: 'api', text: 'x' })
    t.deliveryEvent({ deliveryId: t.delivered[0][2], sessionId: 'api', state: 'rejected', reason: 'team_waiting_idle' })
    t.tabs[0].enabled = false
    t.notice({ type: 'desk_changed', revision: 6 })
    await new Promise((settle) => setTimeout(settle, 0))
    const history = await t.ask({ action: 'history', limit: 10 })
    expect((history.messages as Array<{ id: string; statuses: Array<{ state: string; reason?: string }> }>).find((m) => m.id === reply.id)!.statuses[0])
      .toMatchObject({ state: 'failed', reason: 'Agent Messages were turned off in this tab' })
  })

  it('answers a failure it did not expect without saying more', async () => {
    const t = setup()
    const broken = startAgentMessages(fakeCore({ dataDir: root, agents: { live: () => { throw new Error('boom') } } }), { stateDir: join(root, 's2'), inboxRoot: join(root, 'i2') })
    expect(await broken.requests.agent_messages!({ action: 'send', pane: '%1', to: 'a', text: 'b' }, OWNER_LOCAL)).toEqual({ error: 'MESSAGES_UNAVAILABLE', detail: expect.any(String) })
    broken.stop()
    t.service.stop()
  })
})
