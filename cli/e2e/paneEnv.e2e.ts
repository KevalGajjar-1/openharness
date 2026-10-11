/**
 * What a pane is started with, end to end: never harnessd's own variables. The master gives the core and
 * each service the `HARNESSD_*` they run by, the service token among them. The tmux server the core
 * started copied them into every pane it made, so every agent, terminal tile and hook had them all (found
 * 2026-10-11: `env` in an agent's pane listed every one). The core now takes them out of its
 * environment before it starts anything (lib/harnessdEnv.ts), and a tmux server an earlier boot started
 * with them is told to forget them as the core takes it over (TmuxBackend `unsetServerEnvironment`).
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const exec = promisify(execFile)
type Engine = 'claude' | 'codex'
type Row = Record<string, any>

/** What an earlier boot's master gave its core, as an owner's machine showed them in a pane: made-up values. */
const EARLIER_BOOT = {
  HARNESSD_SERVICE_TOKEN: 'earlier-boot-token', HARNESSD_SERVICES: 'search,viewers', HARNESSD_SERVICE_PROCESSES: 'search,viewers',
  HARNESSD_SUPERVISED: '1', HARNESSD_WATCHDOG_MS: '30000', HARNESSD_RESTARTS: '0', HARNESSD_JUDGES_SUPERSEDED: '1',
}

const row = async (client: LocalClient, agentId: string): Promise<Row | undefined> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents.find((agent) => agent.id === agentId)
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId

async function create(d: IsolatedDaemon, client: LocalClient, engine: Engine | 'terminal', folder: string): Promise<Row> {
  const cwd = join(d.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, ...(engine === 'terminal' ? {} : { bypassPermission: true }) }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to start`, async () => {
    const agent = await row(client, created.agent.id)
    if (engine === 'terminal') return agent?.tmuxPane ? agent : null
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}

/** The `HARNESSD_*` names an agent's engine has, asked as an agent reads its environment (fakeEngine `!env`). */
async function engineHas(client: LocalClient, agentId: string): Promise<string> {
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, 'turn_ended (!env)')
  client.send('message', { agentId, content: '!env HARNESSD_' })
  await ended
  const { sessionId } = (await row(client, agentId))!
  return until('the !env answer in the thread', async () => {
    const page = await client.request<{ events?: Array<{ type: string; payload: Record<string, any> }> }>('session_get', { sessionId, limit: 200 }, 30_000)
    const answer = (page.events ?? []).filter((event) => event.type === 'text_delta').map((event) => String(event.payload.content))
      .find((text) => text.startsWith('env HARNESSD_: '))
    return answer?.slice('env HARNESSD_: '.length) ?? null
  }, 15_000, 250)
}

/** The `HARNESSD_*` names in the environment of the shell a pane runs, written to a file by that shell. */
async function shellHas(d: IsolatedDaemon, pane: string, name: string): Promise<string[]> {
  const file = join(d.root, `${name}.env`)
  await d.tmux.run('send-keys', '-t', pane, `env > ${file}.tmp && mv ${file}.tmp ${file}`, 'Enter')
  await until(`${name}'s shell to write its environment`, () => existsSync(file) || null, 20_000, 100)
  return names(readFileSync(file, 'utf8'))
}
const names = (env: string): string[] => env.split('\n').map((line) => line.split('=')[0]).filter((name) => name.startsWith('HARNESSD_')).sort()

describe('a pane\'s environment', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  const created = async (): Promise<IsolatedDaemon> => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    return d
  }

  /** Every kind of pane the daemon makes: Claude Code, Codex and a terminal tile, each without harnessd's variables. */
  const expectNoneIn = async (d: IsolatedDaemon, client: LocalClient): Promise<void> => {
    for (const engine of ['claude', 'codex'] as const) {
      const agent = await create(d, client, engine, `pane-${engine}`)
      expect(await engineHas(client, agent.id), engine).toBe('(none)')
    }
    const tile = await create(d, client, 'terminal', 'pane-terminal')
    expect(await shellHas(d, tile.tmuxPane, 'terminal')).toEqual([])
  }

  it('has none of harnessd\'s variables when the daemon started the tmux server, under a master that gave the core them', async () => {
    const d = await created()
    await d.start()
    // Under a master, as on every machine: the core was given the token, and its services connected with it.
    expect(d.log()).toMatch(/\[harnessd\] core started/)
    const client = await LocalClient.connect(d)
    await expectNoneIn(d, client)
    client.close()
  }, 300_000)

  it('has none of them when the tmux server was started before the daemon, by an earlier boot that gave it them', async () => {
    const d = await created()
    // The server as an earlier core left it: started from an environment with that boot's HARNESSD_*, and a
    // pane of that boot's still in it, which keeps what it was started with.
    const earlier = join(d.root, 'earlier.env')
    await exec('tmux', ['-S', d.tmux.socket, 'new-session', '-d', '-s', 'earlier-boot', '/bin/sh', '-c', `env > ${earlier}; sleep 600`],
      { env: { ...d.env, ...EARLIER_BOOT }, timeout: 10_000 })
    await until('the earlier boot\'s pane to write its environment', () => existsSync(earlier) || null, 10_000, 50)
    expect(names(readFileSync(earlier, 'utf8'))).toEqual(Object.keys(EARLIER_BOOT).sort())
    await d.start()
    expect(d.log()).toContain(`[terminal] tmux: removed ${Object.keys(EARLIER_BOOT).sort().join(', ')} from the environment new panes start with`)
    const client = await LocalClient.connect(d)
    await expectNoneIn(d, client)
    client.close()
  }, 300_000)
})
