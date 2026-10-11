import { describe, expect, it, vi } from 'vitest'
import { CLOUD_DOWN, type CloudPort } from '../api.js'
import type { CloudHarness } from '../../lib/cloudAgents.js'
import { createCloudAgents } from './cloud.js'

const harness = (over: Partial<CloudHarness> = {}): CloudHarness => ({
  agentId: 'cloud_1', agent: 'devin-cloud', name: 'fix it', state: 'working', activity: null, repository: 'acme/api', branch: null,
  links: [], messages: 1, createdAt: '2026-10-11T10:00:00.000Z', updatedAt: '2026-10-11T10:00:00.000Z', ...over,
})

function setup(port: CloudPort | null = null) {
  const clients = { send: vi.fn(), sendCommander: vi.fn(), sendLocal: vi.fn() }
  const openQuestions = new Map<string, Record<string, unknown>>()
  const deviceInput = { setUserAction: vi.fn() }
  const cloud = createCloudAgents({ port: () => port, clients, openQuestions, deviceInput, log: () => {} })
  return { cloud, clients, openQuestions, deviceInput }
}

const port = (): CloudPort & { [K in keyof CloudPort]: ReturnType<typeof vi.fn> } => ({
  create: vi.fn(async () => ({ ok: true as const, agent: { id: 'cloud_2' } })),
  deliver: vi.fn(async () => ({ ok: true as const })),
  answer: vi.fn(async () => ({ ok: true as const })),
  stop: vi.fn(async () => ({ ok: true as const, detail: 'Fo keeps working on its own.' })),
})

describe('agents a service owns', () => {
  it('lists what the service publishes and tells every client what changed', () => {
    const { cloud, clients } = setup()
    cloud.doors.publish([harness(), { agentId: 'not-cloud' }, null] as never)
    expect(cloud.owns('cloud_1')).toBe(true)
    expect(cloud.frames()).toMatchObject([{ id: 'cloud_1', location: 'cloud', engine: 'devin-cloud', terminal: { available: false } }])
    expect(clients.send).toHaveBeenCalledWith({ type: 'agent_synced', payload: { agent: expect.objectContaining({ id: 'cloud_1' }) } })
    expect(clients.sendCommander).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_synced' }))
    // The same list again changes nothing, and is told to nobody.
    clients.send.mockClear()
    cloud.doors.publish([harness()])
    expect(clients.send).not.toHaveBeenCalled()
    // A stopped one leaves the dial's wheel; a gone one leaves every list.
    cloud.doors.publish([harness({ state: 'stopped' })])
    expect(clients.sendCommander).toHaveBeenLastCalledWith({ type: 'agent_deleted', payload: { agentId: 'cloud_1' } })
    cloud.doors.publish('nonsense' as never)
    expect(clients.send).toHaveBeenLastCalledWith({ type: 'agent_deleted', payload: { agentId: 'cloud_1' } })
    expect(cloud.owns('cloud_1')).toBe(false)
  })

  it('shows its questions where questions show, and closes them', () => {
    const { cloud, clients, openQuestions, deviceInput } = setup()
    cloud.doors.publish([harness()])
    cloud.doors.ask('cloud_none', 'cloud_q_1', { text: 'Which?', choices: [] })
    cloud.doors.ask('cloud_1', 'q_1', { text: 'Which?', choices: [] })
    expect(clients.sendLocal).not.toHaveBeenCalled()
    cloud.doors.ask('cloud_1', 'cloud_q_1', { text: 'Which branch?', choices: ['main', '', 3, 'dev'] as never })
    const asked = { type: 'commander_question', agentId: 'cloud_1', dbSessionId: 'cloud_1',
      payload: { requestId: 'cloud_q_1', questions: [{ key: 'answer', q: 'Which branch?', options: ['main', 'dev'], multi: false, canText: true }], notification: { id: 'cloud_q_1', kind: 'needsYou' } } }
    expect(clients.sendLocal).toHaveBeenCalledWith(asked)
    expect(clients.sendCommander).toHaveBeenCalledWith(asked)
    expect(openQuestions.get('cloud_1')).toEqual(asked)
    expect(deviceInput.setUserAction).toHaveBeenCalledWith('cloud_1', true)
    cloud.doors.ask('cloud_1', 'cloud_q_2', { text: 'Sure?', choices: 'x' as never })
    expect(clients.sendLocal).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ questions: [expect.objectContaining({ options: [] })] }) }))
    cloud.doors.unask('cloud_1', 'cloud_q_9')
    cloud.doors.unask('cloud_1', 'cloud_q_1')
    expect(clients.sendLocal).toHaveBeenLastCalledWith({ type: 'commander_question_close', agentId: 'cloud_1', dbSessionId: 'cloud_1', payload: { requestId: 'cloud_q_1' } })
    expect(openQuestions.has('cloud_1')).toBe(false)
    expect(deviceInput.setUserAction).toHaveBeenLastCalledWith('cloud_1', false)
  })

  it('hands New Harness, words, an answer and Stop for its agents to the service, and nothing else', async () => {
    const service = port()
    const { cloud } = setup(service)
    cloud.doors.publish([harness()])
    expect(cloud.create({ engine: 'claude' })).toBeNull()
    expect(await cloud.create({ engine: 'fo', prompt: 'x' })).toEqual({ agent: { id: 'cloud_2' } })
    service.create.mockResolvedValueOnce({ ok: false, error: 'NOT_CONNECTED', detail: 'Connect Fo' })
    expect(await cloud.create({ engine: 'fo' })).toEqual({ error: 'NOT_CONNECTED', detail: 'Connect Fo' })
    service.create.mockResolvedValueOnce({ ok: false, error: 'X' })
    expect(await cloud.create({ engine: 'fo' })).toEqual({ error: 'X' })

    expect(cloud.deliver('a1', 'hi')).toBeNull()
    expect(await cloud.deliver('cloud_1', 'hi')).toEqual({ ok: true })
    expect(service.deliver).toHaveBeenCalledWith('cloud_1', 'hi')

    expect(cloud.answer({ requestId: 'q_pane' })).toBeNull()
    expect(cloud.answer({})).toBeNull()
    cloud.doors.ask('cloud_1', 'cloud_q_1', { text: 'Which?', choices: [] })
    expect(await cloud.answer({ requestId: 'cloud_q_1', answers: { answer: 'main', other: 3 } })).toEqual({ ok: true })
    expect(service.answer).toHaveBeenCalledWith('cloud_1', 'cloud_q_1', { answer: 'main' })
    service.answer.mockResolvedValueOnce({ ok: false, error: 'STALE_QUESTION', detail: 'gone' }).mockResolvedValueOnce({ ok: false, error: 'BUSY' })
    expect(await cloud.answer({ requestId: 'cloud_q_1', answers: 'x' })).toEqual({ ok: false, error: 'STALE_QUESTION', detail: 'gone' })
    expect(await cloud.answer({ requestId: 'cloud_q_1' })).toEqual({ ok: false, error: 'ANSWER_FAILED', detail: '' })

    expect(cloud.stop('a1')).toBeNull()
    expect(await cloud.stop('cloud_1')).toEqual({ deleted: true, detail: 'Fo keeps working on its own.' })
    service.stop.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: 'CLOUD_FAILED', detail: 'down' }).mockResolvedValueOnce({ ok: false, error: 'X' })
    expect(await cloud.stop('cloud_1')).toEqual({ deleted: true })
    expect(await cloud.stop('cloud_1')).toEqual({ error: 'CLOUD_FAILED', detail: 'down' })
    expect(await cloud.stop('cloud_1')).toEqual({ error: 'X' })
  })

  it('refuses with a reason while the service is off', async () => {
    const { cloud } = setup(null)
    cloud.doors.publish([harness()])
    expect(await cloud.create({ engine: 'devin-cloud' })).toEqual({ error: 'SERVICE_UNAVAILABLE', detail: CLOUD_DOWN.detail })
    expect(await cloud.deliver('cloud_1', 'x')).toEqual(CLOUD_DOWN)
    cloud.doors.ask('cloud_1', 'cloud_q_1', { text: 'Which?', choices: [] })
    expect(await cloud.answer({ requestId: 'cloud_q_1' })).toEqual({ ok: false, error: 'ANSWER_FAILED', detail: CLOUD_DOWN.detail })
    expect(await cloud.stop('cloud_1')).toEqual({ error: 'SERVICE_UNAVAILABLE', detail: CLOUD_DOWN.detail })
  })

  it('logs a question by default', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const cloud = createCloudAgents({ port: () => null, clients: { send: vi.fn(), sendCommander: vi.fn(), sendLocal: vi.fn() }, openQuestions: new Map(), deviceInput: { setUserAction: vi.fn() } })
    cloud.doors.publish([harness()])
    cloud.doors.ask('cloud_1', 'cloud_q_1', { text: 'Which?', choices: [] })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[cloud] cloud_1 asking'))
    log.mockRestore()
  })
})
