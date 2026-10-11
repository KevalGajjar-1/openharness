/**
 * Harness for agents on the real daemon (docs/design/2026-10-11-agent-client.md): an agent, from its own pane, runs
 * the `harness` verbs as it would through its shell tool. It lists the harnesses, starts one with a task, waits for
 * it, reads its answer, messages it without any tab having Agent Messages on, and closes it; it may not close one it
 * did not start. The fake engines answer by echoing (harness/fakeEngine.mjs).
 *
 * Signed in to the fake backend, which answers the account's tabs: none has Agent Messages on.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'

const ME: FakeMachine = { machineId: 'b8'.repeat(16), computerId: 'e2e-computer-0000-0000-0000000000b8', name: 'studio', token: 'e2e-token-agent-client' }
const signIn = (d: IsolatedDaemon) => writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({
  version: 1, accessToken: ME.token, autonomousEnv: 'prod', computerId: ME.computerId,
  machineId: ME.machineId, expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
}), { mode: 0o600 })

/** `harness <args>` from [pane], as an agent's shell tool runs it: not a terminal, so plain text. */
function harness(d: IsolatedDaemon, pane: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: pane }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => done({ code: code ?? -1, out, err }))
  })
}

describe('Harness for agents, end to end', () => {
  let daemon: IsolatedDaemon | undefined
  let backend: FakeBackend | undefined
  afterEach(async () => {
    await daemon?.close(); daemon = undefined
    await backend?.close(); backend = undefined
  })

  it('an agent sees, starts, waits for, reads, messages and closes a harness of its own', async () => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    relay.agentMessages = { revision: 1, machines: [{ machineId: ME.machineId, name: 'studio' }], tabs: [] }
    const d = await IsolatedDaemon.create({ env: {
      BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
    } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    signIn(d)
    await d.start()
    const client = await LocalClient.connect(d, { machineId: ME.machineId })

    const leadDir = join(d.projectsDir, 'lead')
    mkdirSync(leadDir, { recursive: true })
    const made = await client.request('agent_create', { engine: 'claude', cwd: leadDir, bypassPermission: true, name: 'lead' }, 90_000)
    expect(made.error, JSON.stringify(made)).toBeUndefined()
    const lead = await until('lead to bind its conversation', async () => {
      const row = ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents).find((a) => a.id === made.agent.id)
      return row?.sessionId && row.status === 'active' ? row : null
    }, 60_000, 500)
    const run = (...args: string[]) => harness(d, String(lead.tmuxPane), args)

    // It sees itself.
    const ps = await run('ps')
    expect(ps.code, ps.err).toBe(0)
    expect(ps.out).toMatch(/^You are "lead" \(/)
    expect(ps.out).toMatch(/\nlead +Claude Code +\w+ +person \(you\)/)

    // It starts a harness with a task, which reads who sent it.
    const kidDir = join(d.projectsDir, 'kid')
    mkdirSync(kidDir, { recursive: true })
    const started = await run('new', 'claude', kidDir, '--name', 'kid', '--', 'hello kid')
    expect(started.code, started.err).toBe(0)
    expect(started.out).toContain('Created kid on this computer')
    expect(started.out).toContain('Read it: harness show kid · wait for it: harness wait kid')
    const ledger = readFileSync(join(d.dataDir, 'agent-client', 'started.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(ledger).toEqual([expect.objectContaining({ depth: 1, by: expect.objectContaining({ agentId: lead.id, name: 'lead' }), child: expect.objectContaining({ name: 'kid' }) })])

    // It waits for it, then reads its answer.
    const waited = await run('wait', 'kid', '--timeout', '2m')
    expect(waited.code, waited.out + waited.err).toBe(0)
    expect(waited.out.trim()).toBe('kid: idle · read it: harness show kid')
    const shown = await run('show', 'kid')
    expect(shown.code, shown.err).toBe(0)
    expect(shown.out).toContain('kid · Claude Code · ')
    expect(shown.out).toContain('· idle · started by you')
    expect(shown.out).toContain('asked: [from lead · Claude Code · ')
    expect(shown.out).toContain('the harness that started you. It reads your answer itself; to ask it something while you work: harness send lead "…"]')
    expect(shown.out).toContain('hello kid')
    expect((await run('ps')).out).toMatch(/\nkid +Claude Code +\w+ +you /)

    // No tab has Agent Messages on, and still the two message each other.
    const sent = await run('send', 'kid', 'Also check the footer.')
    expect(sent.code, sent.out + sent.err).toBe(0)
    expect(sent.out).toMatch(/→ kid: (queued|delivered)/)
    const kid = ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents).find((a) => a.name === 'kid')!
    const back = await harness(d, String(kid.tmuxPane), ['send', 'lead', 'Footer checked.'])
    expect(back.code, back.out + back.err).toBe(0)

    // It closes what it started, and only that; the harness it started may not close it.
    const own = await run('close', 'lead')
    expect(own.code).toBe(1)
    expect(own.err).toContain('That is your own harness.')
    const fromKid = await harness(d, String(kid.tmuxPane), ['close', 'lead'])
    expect(fromKid.code, fromKid.out).toBe(1)
    expect(fromKid.err).toContain('You did not start lead')
    await run('wait', 'kid', '--timeout', '2m')
    const closed = await run('close', 'kid')
    expect(closed.code, closed.err).toBe(0)
    expect(closed.out.trim()).toBe('Closed kid. Its conversation is kept.')
    const after = await run('ps', '--all', '--json')
    expect(JSON.parse(after.out).harnesses).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'kid', state: 'stopped', startedBy: 'you' })]))
    client.close()
  })
})
