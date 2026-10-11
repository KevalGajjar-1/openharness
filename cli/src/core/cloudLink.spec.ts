import { describe, expect, it, vi } from 'vitest'
import { CLOUD_DOWN } from './api.js'
import { createCloudLink } from './cloudLink.js'

describe('cloud agents in their own process, as the core reaches them', () => {
  it('asks the process for each call, named as the port\'s members', async () => {
    const call = vi.fn(async (type: string) => (type === 'create' ? { ok: true, agent: { id: 'cloud_1' } } : { ok: true, detail: 'done' }))
    const port = createCloudLink(call)
    expect(await port.create({ engine: 'fo' })).toEqual({ ok: true, agent: { id: 'cloud_1' } })
    expect(await port.deliver('cloud_1', 'hi')).toEqual({ ok: true, detail: 'done' })
    expect(await port.answer('cloud_1', 'cloud_q_1', { answer: 'main' })).toEqual({ ok: true, detail: 'done' })
    expect(await port.stop('cloud_1')).toEqual({ ok: true, detail: 'done' })
    expect(call.mock.calls).toEqual([
      ['create', { engine: 'fo' }], ['deliver', { agentId: 'cloud_1', text: 'hi' }],
      ['answer', { agentId: 'cloud_1', requestId: 'cloud_q_1', answers: { answer: 'main' } }], ['stop', { agentId: 'cloud_1' }],
    ])
  })

  it('carries a refusal through, and reads no answer as the fallback', async () => {
    const answers: Record<string, unknown>[] = [{ ok: false, error: 'NOT_CONNECTED', detail: 'Connect Fo' }, { ok: false, error: 'X' }, { error: 'SERVICE_UNAVAILABLE' }, { ok: true }, { ok: true, agent: 'nope' }]
    const port = createCloudLink(async () => answers.shift()!)
    expect(await port.create({})).toEqual({ ok: false, error: 'NOT_CONNECTED', detail: 'Connect Fo' })
    expect(await port.deliver('a', 'b')).toEqual({ ok: false, error: 'X' })
    expect(await port.stop('a')).toEqual(CLOUD_DOWN)
    expect(await port.stop('a')).toEqual({ ok: true })
    expect(await port.create({})).toEqual(CLOUD_DOWN)
  })
})
