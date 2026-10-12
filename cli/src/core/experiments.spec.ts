import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeAgentSettings } from '../lib/agentSettings.js'
import { EXPERIMENTS } from './api.js'
import { createAccountNotices, createExperimentHooks, stateIsThere, wakeExperiments, writeAgentSettingsAndWake } from './experiments.js'

describe('the experiments on as the core starts', () => {
  let dataDir: string
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'experiments-')) })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))
  /** Agent Messages as core/api.ts declares it: on by its Settings ▸ Agents switch, or by its saved state. */
  const experiments = { messages: { state: ['agent-messages'], setting: 'agentMessages' as const }, orchestrator: { state: ['orchestrator/*.json'] } }

  it('finds saved state by path, or by a file of its kind in its folder', () => {
    expect(stateIsThere(dataDir, ['agent-messages'])).toBe(false)
    expect(stateIsThere(dataDir, ['orchestrator/*.json'])).toBe(false)
    mkdirSync(join(dataDir, 'orchestrator'))
    // A folder made by a look, with no project in it, is not a project.
    writeFileSync(join(dataDir, 'orchestrator', 'notes.txt'), '')
    expect(stateIsThere(dataDir, ['orchestrator/*.json'])).toBe(false)
    writeFileSync(join(dataDir, 'orchestrator', `${'a'.repeat(32)}.json`), '{}')
    expect(stateIsThere(dataDir, ['orchestrator/*.json'])).toBe(true)
    mkdirSync(join(dataDir, 'agent-messages'))
    expect(stateIsThere(dataDir, ['nothing', 'agent-messages'])).toBe(true)
    expect(stateIsThere(dataDir, [])).toBe(false)
  })

  it('asks for each experiment in its own process that has saved state, and for no other', () => {
    mkdirSync(join(dataDir, 'orchestrator'))
    writeFileSync(join(dataDir, 'orchestrator', 'p.json'), '{}')
    writeFileSync(join(dataDir, 'harness-shares.json'), '[]')
    const want = vi.fn()
    const woken = wakeExperiments({
      dataDir,
      experiments: { orchestrator: { state: ['orchestrator/*.json'] }, sharing: { state: ['harness-shares.json'] }, messages: { state: ['agent-messages'] } },
      // Share runs in the core's process here: it is started there, not asked for.
      outOfProcess: new Set(['orchestrator', 'messages']),
      want,
    })
    expect(woken).toEqual(['orchestrator'])
    expect(want.mock.calls).toEqual([['orchestrator']])
  })

  it('asks for an experiment whose Settings ▸ Agents switch is on, with no saved state, and not once it is off', () => {
    // Agent Messages is on by default: its agents hear of `harness send` only from its process, which nothing else
    // starts on a machine where no one has sent yet (owner, 2026-10-12).
    const wake = (outOfProcess = new Set(['messages', 'orchestrator'])) => {
      const want = vi.fn()
      return { woken: wakeExperiments({ dataDir, experiments, outOfProcess, want }), want }
    }
    const first = wake()
    expect(first.woken).toEqual(['messages'])
    expect(first.want.mock.calls).toEqual([['messages']])
    // As core/api.ts declares the experiments: on a fresh data folder, Agent Messages alone.
    const outOfProcess = new Set(Object.keys(EXPERIMENTS))
    expect(wakeExperiments({ dataDir, experiments: EXPERIMENTS, outOfProcess, want: vi.fn() })).toEqual(['messages'])
    // In the core's process it is started there, not asked for.
    expect(wake(new Set()).woken).toEqual([])
    writeAgentSettings(dataDir, { agentMessages: false })
    const off = wake()
    expect(off.woken).toEqual([])
    expect(off.want).not.toHaveBeenCalled()
    // Off, its saved state still wakes it: what waits there is held, then failed, rather than left behind.
    mkdirSync(join(dataDir, 'agent-messages'))
    expect(wake().woken).toEqual(['messages'])
  })

  it('hands the account\'s notices to each listener here, guarded, and to the experiments\' processes', () => {
    const tell = vi.fn()
    const log = vi.fn()
    const notices = createAccountNotices(tell, log)
    const heard = vi.fn()
    const stop = notices.onNotice(heard)
    notices.onNotice(() => { throw new Error('boom') })
    notices.onNotice(() => { throw 'odd' })
    notices.notice({ type: 'desk_changed', revision: 3 })
    stop()
    notices.notice({ type: 'desk_changed', revision: 4 })
    expect(heard.mock.calls).toEqual([[{ type: 'desk_changed', revision: 3 }]])
    expect(tell).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('odd'))
  })

  it('logs to the console when given no log of its own', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const notices = createAccountNotices(() => {})
      notices.onNotice(() => { throw new Error('boom') })
      notices.notice({ type: 'desk_changed', revision: 1 })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'))
    } finally {
      warn.mockRestore()
    }
  })

  it('asks for an experiment, and tells each experiment in its own process the account\'s notices', () => {
    const order: string[] = []
    const notify = vi.fn(() => true)
    const hooks = createExperimentHooks({
      want: (service) => order.push(`want ${service}`), notify, outOfProcess: new Set(['messages']), experiments: ['orchestrator', 'messages'],
    })
    hooks.want('messages')
    hooks.want('orchestrator')
    expect(order).toEqual(['want messages', 'want orchestrator'])
    const heard = vi.fn()
    hooks.onNotice(heard)
    hooks.notice({ type: 'desk_changed', revision: 5 })
    expect(heard).toHaveBeenCalledWith({ type: 'desk_changed', revision: 5 })
    expect(notify.mock.calls).toEqual([['messages', { type: 'service_event', payload: { kind: 'notice', notice: { type: 'desk_changed', revision: 5 } } }]])
    createExperimentHooks({ want: vi.fn(), notify, outOfProcess: new Set(), experiments: [] }).want('x')
  })

  it('asks for an experiment once a Settings ▸ Agents write leaves its switch on, and not when off or refused', async () => {
    // On one machine nothing else starts it: no agent heard of `harness send` (a fresh Mac, 2026-10-12).
    const want = vi.fn()
    const settings = (body: Record<string, unknown>, status = 200) => async () => ({ status, body })
    const on = { agentsStartAgents: true, pullRequestLine: true, agentMessages: true }
    const answer = await writeAgentSettingsAndWake(settings(on), experiments, want)
    expect(answer).toEqual({ status: 200, body: on })
    expect(want.mock.calls).toEqual([['messages']])
    // Another switch written, this one left on: asked for again, which changes nothing for one already running.
    await writeAgentSettingsAndWake(settings({ ...on, pullRequestLine: false }), experiments, want)
    expect(want).toHaveBeenCalledTimes(2)
    await writeAgentSettingsAndWake(settings({ ...on, agentMessages: false }), experiments, want)
    await writeAgentSettingsAndWake(settings({ error: { code: 'BAD_REQUEST' } }, 400), experiments, want)
    await writeAgentSettingsAndWake(settings(on, 199), experiments, want)
    expect(want).toHaveBeenCalledTimes(2)
  })
})
