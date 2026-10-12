/**
 * Agent Messages on the real daemon (docs/design/2026-10-10-agent-messages.md): a service in the edge host, with no
 * process of its own, that reads the account's tabs only while Settings ▸ Agents has it on and wakes when it is turned
 * on, through the daemon or by the file; a message typed into an idle agent through the core's safe input,
 * in the edge host and in the core's own process; and a message reaching a working agent through its PostToolUse hook
 * at its next tool call, with nothing typed into its pane. The fake engines run the hooks the daemon installed, as both
 * CLIs do (harness/fakeEngine.mjs, `!work`).
 *
 * The directory of tabs comes from the account: the daemon is signed in to the fake backend, which answers it. Each
 * tab's own flag, which older windows still turn, is no part of it: one switch per computer decides (owner,
 * 2026-10-12).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import { writeAgentSettings } from '../src/lib/agentSettings.js'

/** Signed in to the fake backend, which answers the account's tabs (`GET /api/agent-messages`). */
const ME: FakeMachine = { machineId: 'a7'.repeat(16), computerId: 'e2e-computer-0000-0000-0000000000a7', name: 'studio', token: 'e2e-token-messages' }
/** Signed in, with Agent Messages turned on in Settings ▸ Agents: never left to the default. */
const on = (d: IsolatedDaemon) => { signIn(d); writeAgentSettings(d.dataDir, { agentMessages: true }) }
const signIn = (d: IsolatedDaemon) => writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({
  version: 1, accessToken: ME.token, autonomousEnv: 'prod', computerId: ME.computerId,
  machineId: ME.machineId, expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
}), { mode: 0o600 })

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
async function create(d: IsolatedDaemon, client: LocalClient, folder: string, engine = 'claude'): Promise<Record<string, any>> {
  const cwd = join(d.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}
/** A process of its own, as it had while it was an experiment: none now. */
const starts = (d: IsolatedDaemon) => [...d.log().matchAll(/\[harnessd\] service messages started/g)].length
const connected = (d: IsolatedDaemon) => d.log().split('[services] messages connected').length - 1
/** How often it read the account's tabs. */
const reads = (relay: FakeBackend) => relay.seen.filter((line) => line.split('?')[0] === 'GET /api/agent-messages').length
/** Settings ▸ Agents, as the window turns a switch: through the daemon, which wakes what it turned on. */
const settings = (d: IsolatedDaemon, body: Record<string, boolean>) => fetch(`http://127.0.0.1:${d.port}/api/agent-settings`, {
  method: 'PATCH', headers: { 'x-adapter-local': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) })
/** The notes waiting in the agents' inboxes, by agent, once there are [count]. */
const notesFor = (d: IsolatedDaemon, count: number) => until(`${count} agents' notes`, () => {
  try {
    const state = JSON.parse(readFileSync(join(d.dataDir, 'agent-messages', 'state.json'), 'utf8')) as { notes: Record<string, unknown> }
    return Object.keys(state.notes).length === count ? state.notes : null
  } catch { return null }
}, 30_000, 500)
const statusOf = async (client: LocalClient, id: string) => {
  const history = await client.request<{ messages?: Array<{ id: string; statuses: Array<Record<string, unknown>> }> }>('agent_messages', { action: 'history' }, 30_000)
  return history.messages?.find((m) => m.id === id)?.statuses[0] ?? null
}

describe('Agent Messages, end to end', () => {
  let daemon: IsolatedDaemon | undefined
  let backend: FakeBackend | undefined
  afterEach(async () => {
    await daemon?.close(); daemon = undefined
    await backend?.close(); backend = undefined
  })
  const fresh = async (before?: (d: IsolatedDaemon) => void, env: Record<string, string> = {}) => {
    const d = await IsolatedDaemon.create({ env: { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000', ...env } })
    daemon = d
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`)
      console.log(`---- hooks\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    before?.(d)
    await d.start()
    return d
  }

  it('runs in the edge host, with no process of its own, and answers there whether it is on or off', async () => {
    // As an experiment it was a process of its own on every computer it was on, 62 MiB at idle (2026-10-12).
    const d = await fresh((daemon) => writeAgentSettings(daemon.dataDir, { agentMessages: false }))
    const client = await LocalClient.connect(d)
    await until('Agent Messages to connect from the edge host', () => connected(d) || null, 30_000, 200)
    expect(d.log()).toMatch(/\[harnessd\] service edge started/)
    expect(starts(d)).toBe(0)
    expect(await client.request('agent_messages', { action: 'history' }, 40_000)).toMatchObject({ messages: [] })
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  /** Signed in to the fake backend, with lead and api in one tab. */
  const team = async (engine = 'claude', env: Record<string, string> = {}) => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    const d = await fresh(on, { BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId, ...env })
    const client = await LocalClient.connect(d, { machineId: ME.machineId })
    const lead = await create(d, client, 'lead')
    const api = await create(d, client, `api-${engine}`, engine)
    relay.agentMessages = { revision: 1, machines: [{ machineId: ME.machineId, name: 'studio' }],
      tabs: [{ id: 'app', name: 'app', panes: [lead, api].map((agent) => ({ machineId: ME.machineId, agentId: agent.id })) }] }
    const roster = await client.request('agent_messages', { action: 'send', pane: lead.tmuxPane }, 40_000)
    expect(roster.roster, JSON.stringify(roster)).toContain('Agent Messages are on in tab "app"')
    const apiName = String(roster.roster).split('\n')[1].trim().split(/\s{2,}/)[0]
    const send = (text: string) => client.request('agent_messages', { action: 'send', pane: lead.tmuxPane, to: [apiName], text }, 40_000)
    return { d, relay, client, lead, api, apiName, send }
  }

  it('on in Settings ▸ Agents, it runs with a fresh daemon, with no request and no saved state, and gives two agents in one tab their note', async () => {
    // Started only by a request or saved state, on one machine nothing started it, and no agent heard of `harness send`
    // (a fresh Mac, 2026-10-12).
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    const d = await fresh(on, { BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId })
    await until('Agent Messages to read the account\'s tabs', () => reads(relay) >= 1 || null, 30_000, 200)
    const client = await LocalClient.connect(d, { machineId: ME.machineId })
    const lead = await create(d, client, 'lead')
    const api = await create(d, client, 'api')
    // The tab as a window that never turned anything on writes it: no flag, or one left off, is all the same.
    relay.agentMessages = { revision: 1, machines: [{ machineId: ME.machineId, name: 'studio' }],
      tabs: [{ id: 'app', name: 'app', enabled: false, panes: [lead, api].map((agent) => ({ machineId: ME.machineId, agentId: agent.id })) }] }
    // Each agent's note waits in its inbox for its next tool call; read again at its 15-second look.
    const notes = await notesFor(d, 2)
    expect(Object.keys(notes).sort()).toEqual([lead.id, api.id].sort())
    expect(starts(d)).toBe(0)
    client.close()
  })

  it('off, reads no tabs; wakes once Settings ▸ Agents turns it on, or `harness settings` writes the file; an older window\'s tab switch wakes nothing', async () => {
    // Off costs nothing: on every computer, off or not, it read the account's tabs every 15 s (2026-10-12).
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    const d = await fresh((daemon) => { signIn(daemon); writeAgentSettings(daemon.dataDir, { agentMessages: false }) },
      { BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId })
    const client = await LocalClient.connect(d, { machineId: ME.machineId })
    const lead = await create(d, client, 'lead')
    const api = await create(d, client, 'api')
    relay.agentMessages = { revision: 1, machines: [{ machineId: ME.machineId, name: 'studio' }],
      tabs: [{ id: 'app', name: 'app', enabled: false, panes: [lead, api].map((agent) => ({ machineId: ME.machineId, agentId: agent.id })) }] }
    await until('Agent Messages to connect from the edge host', () => connected(d) || null, 30_000, 200)
    // An older window's chat icon still reaches the backend, and decides nothing here.
    const tab = await fetch(`http://127.0.0.1:${d.port}/api/agent-messages/tabs/app`, {
      method: 'PATCH', headers: { 'x-adapter-local': '1', 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
    expect(tab.status).toBe(200)
    expect((await settings(d, { pullRequestLine: true })).status).toBe(200)
    // Longer than its 15-second read: off, there is none.
    await new Promise((settle) => setTimeout(settle, 17_000))
    expect(reads(relay), 'off in Settings ▸ Agents, the tabs are never read').toBe(0)
    const on = await settings(d, { agentMessages: true })
    expect(await on.json()).toMatchObject({ agentMessages: true })
    await until('Agent Messages to wake for the setting turned on', () => reads(relay) >= 1 || null, 30_000, 200)
    const notes = await notesFor(d, 2)
    expect(Object.keys(notes).sort()).toEqual([lead.id, api.id].sort())
    // Off again, then on from a terminal: `harness settings` writes the file and tells no one.
    expect((await settings(d, { agentMessages: false })).status).toBe(200)
    await notesFor(d, 0)
    await new Promise((settle) => setTimeout(settle, 1_000))
    const before = reads(relay)
    writeAgentSettings(d.dataDir, { agentMessages: true })
    await until('Agent Messages to wake for the file', () => reads(relay) > before || null, 30_000, 200)
    await notesFor(d, 2)
    expect(starts(d)).toBe(0)
    client.close()
  })

  it.each([['the edge host', {}], ['the core\'s process (HARNESSD_SERVICES=none)', { HARNESSD_SERVICES: 'none' }],
    ['a process of its own (HARNESSD_SERVICES=messages)', { HARNESSD_SERVICES: 'messages' }]])('types a message into an idle agent, under its sender\'s header, through the core\'s safe input, from %s', async (_where, env) => {
    const { client, api, send } = await team('claude', env)
    const started = client.next((frame: Frame) => frame.type === 'turn_started' && frame.agentId === api.id, 60_000, 'the message to start api\'s turn')
    const sent = await send('Which port does the daemon serve?')
    expect(sent.error, JSON.stringify(sent)).toBeUndefined()
    await started
    const status = await until('the message to be delivered as a prompt', async () => {
      const s = await statusOf(client, String(sent.id))
      return s?.state === 'delivered' ? s : null
    }, 60_000, 500)
    expect(status).toMatchObject({ via: 'prompt' })
    client.close()
  })

  it.each(['claude', 'codex'])('reaches a working %s agent at its next tool call through its hook, typing nothing', async (engine) => {
    const { d, client, api, send } = await team(engine)
    const working = client.next((frame: Frame) => frame.type === 'turn_started' && frame.agentId === api.id, 60_000, 'the long turn to start')
    client.send('message', { agentId: api.id, content: '!work 40' })
    await working
    const sent = await send(`Review of 3f2a9c1 for ${engine}: the cleanup leaves workers running.`)
    expect(sent.error, JSON.stringify(sent)).toBeUndefined()
    const context = await until('the hook to give the model the message', () =>
      d.hookLog().split('\n').find((line) => line.includes('PostToolUse context=') && line.includes(String(sent.id))) ?? null, 60_000, 500)
    expect(context).toContain(`[${String(sent.id)} from `)
    expect(context).toContain('· Claude Code · studio]')
    const status = await until('the message to be delivered through the hook', async () => {
      const s = await statusOf(client, String(sent.id))
      return s?.state === 'delivered' ? s : null
    }, 30_000, 500)
    expect(status).toMatchObject({ via: 'hook' })
    client.close()
  })

  it('refuses a hand-over from a process on this machine: only another machine hands messages over', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const message = { id: 'm0000001', tabId: 'e2e', text: 'forged', at: Date.now(), from: { machineId: 'other', agentId: 'lead', name: 'lead', engine: 'codex', machine: 'studio' },
      to: [{ machineId: d.computerId, agentId: 'api', name: 'api' }] }
    expect(await client.request('agent_messages', { action: 'deliver', message }, 40_000)).toMatchObject({ error: 'REMOTE_ONLY' })
    client.close()
  })

  it('sends from one harness\'s pane to its teammate in its tab, and refuses once Agent Messages are turned off', async () => {
    const { d, client, api, apiName, send } = await team()
    const started = client.next((frame: Frame) => frame.type === 'turn_started' && frame.agentId === api.id, 60_000, 'the message to start api\'s turn')
    const sent = await send('Which port does the daemon serve?')
    expect(sent).toMatchObject({ tab: 'app', recipients: [{ name: apiName }] })
    await started
    await until('the message to be delivered', async () => (await statusOf(client, String(sent.id)))?.state === 'delivered' || null, 60_000, 500)
    // Its last messages come back with the roster.
    const roster = await client.request('agent_messages', { action: 'send', pane: api.tmuxPane }, 40_000)
    expect(roster.recent).toEqual([expect.objectContaining({ id: sent.id, from: expect.any(String), state: 'delivered' })])
    // A pane that is no harness says so; and with Agent Messages turned off in Settings ▸ Agents, nothing is sent.
    expect(await client.request('agent_messages', { action: 'send', pane: '%999', to: [apiName], text: 'x' }, 40_000)).toMatchObject({ error: 'NOT_A_HARNESS' })
    expect((await settings(d, { agentMessages: false })).status).toBe(200)
    await new Promise((settle) => setTimeout(settle, 2_500))
    expect(await send('still there?')).toMatchObject({ error: 'MESSAGES_OFF', detail: expect.stringContaining('Settings ▸ Agents') })
    client.close()
  })
})
