import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const authenticateAccessToken = vi.hoisted(() => vi.fn())
vi.mock('../lib/ssoAuth.js', async (importActual) => ({
  ...(await importActual<typeof import('../lib/ssoAuth.js')>()),
  authenticateAccessToken,
}))

import { communityTranslateRoutes, COMMUNITY_TRANSLATE_PATH, resetTranslateRateLimits } from './communityTranslate.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { registerAuthMiddleware, shouldSkipAuth } from '../middlewares/authMiddleware.js'
import { env } from '../config/env.js'

async function build(): Promise<FastifyInstance> {
  const app = Fastify()
  app.setErrorHandler(errorHandler)
  registerAuthMiddleware(app, authenticateAccessToken)
  await app.register(communityTranslateRoutes)
  await app.ready()
  return app
}

const draft = { title: 'Trò chơi rắn', description: '', conversation: [{ role: 'user', text: 'làm game rắn' }] }
const post = (app: FastifyInstance, payload: unknown = draft, auth = true) =>
  app.inject({ method: 'POST', url: COMMUNITY_TRANSLATE_PATH, payload: payload as object, headers: auth ? { authorization: 'Bearer sso-token' } : {} })
const llmSays = (content: string) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ model: 'test-model', choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } }))

describe('POST /api/community/translate', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetTranslateRateLimits()
    authenticateAccessToken.mockReset()
    authenticateAccessToken.mockResolvedValue({ sub: 'u1', email: 'a@b.c', role: 'user', autonomousEnv: 'prod' })
    env.CURSOR_LLM_BASE_URL = 'https://llm.example/v1'
    env.CURSOR_LLM_API_KEY = 'llm-key'
  })

  it('needs a signed-in account: it spends credit', async () => {
    expect(shouldSkipAuth(COMMUNITY_TRANSLATE_PATH)).toBe(false)
    expect((await post(await build(), draft, false)).statusCode).toBe(401)
  })

  it('answers the draft in English', async () => {
    llmSays('{"items":[{"i":0,"en":"Snake game"},{"i":2,"en":"make a snake game"}]}')
    const res = await post(await build())
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ title: 'Snake game', description: '', conversation: [{ role: 'user', text: 'make a snake game' }], translated: true })
  })

  it('fails closed without a configured model, and on a failed call', async () => {
    env.CURSOR_LLM_API_KEY = undefined
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect((await post(await build())).statusCode).toBe(503)
    expect(fetchSpy).not.toHaveBeenCalled()
    env.CURSOR_LLM_API_KEY = 'llm-key'
    fetchSpy.mockRejectedValue(new Error('upstream down'))
    expect((await post(await build())).json().error.code).toBe('TRANSLATION_FAILED')
  })

  it('refuses what is not a draft, and a draft too long to translate', async () => {
    const app = await build()
    expect((await post(app, { ...draft, files: [] })).statusCode).toBe(400)
    const conversation = Array.from({ length: 8 }, () => ({ role: 'user', text: 'x'.repeat(11_000) }))
    expect((await post(app, { ...draft, conversation })).json().error.code).toBe('TOO_LONG')
  })

  it('limits each account', async () => {
    llmSays('{"items":[{"i":0,"same":true},{"i":2,"same":true}]}')
    const app = await build()
    for (let i = 0; i < 10; i++) expect((await post(app)).statusCode).toBe(200)
    expect((await post(app)).statusCode).toBe(429)
  })
})
