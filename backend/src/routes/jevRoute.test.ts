// POST /api/route/jev — ⌘B's Jev decisions on Harness's own key.
//
// Pinned here: that the route spends the key only on Jev (the model is ours, not the caller's), that
// it fails closed without a key, that one account cannot spend without bound, and that what comes back
// is only answers to the questions that were asked.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const authenticateAccessToken = vi.hoisted(() => vi.fn())
vi.mock('../lib/ssoAuth.js', async (importActual) => ({
  ...(await importActual<typeof import('../lib/ssoAuth.js')>()),
  authenticateAccessToken,
}))

import { jevRouteRoutes, jevRateLimitAllows, parseJevAnswers, resetJevRateLimits, JEV_ROUTE_PATH, type JevBody } from './jevRoute.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { registerAuthMiddleware, shouldSkipAuth } from '../middlewares/authMiddleware.js'
import { env } from '../config/env.js'

const body = (over: Partial<JevBody> = {}): JevBody => ({
  state: { message: 'fix the login redirect' },
  questions: {
    target: { type: 'choice', instructions: 'Which session?', criteria: { s0: 'auth work', new: 'None of them' } },
    topic: { type: 'choice', instructions: 'Does it name a subject?', criteria: { yes: 'Yes', no: 'No' } },
  },
  ...over,
})

async function build(): Promise<FastifyInstance> {
  const app = Fastify()
  app.setErrorHandler(errorHandler)
  registerAuthMiddleware(app, authenticateAccessToken)
  await app.register(jevRouteRoutes)
  await app.ready()
  return app
}

const post = (app: FastifyInstance, payload: unknown, auth = true) =>
  app.inject({ method: 'POST', url: JEV_ROUTE_PATH, payload: payload as object, headers: auth ? { authorization: 'Bearer sso-token' } : {} })

const jevSays = (answer: unknown, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } }))

const good = {
  answers: {
    target: { choice: 's0', probabilities: { s0: 0.9, new: 0.1 } },
    topic: { choice: 'yes', probabilities: { yes: 0.97, no: 0.03 } },
  },
  usage: { cost: 0.00017, input_tokens: 4000 },
}

describe('POST /api/route/jev', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetJevRateLimits()
    authenticateAccessToken.mockReset()
    authenticateAccessToken.mockResolvedValue({ sub: 'u1', email: 'a@b.c', role: 'user', autonomousEnv: 'prod' })
    env.JEV_OPENROUTER_API_KEY = 'or-key'
  })

  it('is gated by the ordinary SSO middleware', async () => {
    expect(shouldSkipAuth(JEV_ROUTE_PATH)).toBe(false)
    const app = await build()
    expect((await post(app, body(), false)).statusCode).toBe(401)
  })

  it("asks Jev with Harness's key and returns only the answers", async () => {
    const spy = jevSays(good)
    const app = await build()
    const res = await post(app, body())
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ answers: good.answers })
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer or-key')
    expect(headers['X-Title']).toBe('Harness router')
    const sent = JSON.parse(init.body as string)
    expect(sent).toEqual({ model: 'typesafe/jev-1.13', ...body() })
  })

  it('never lets a caller pick the model', async () => {
    const spy = jevSays(good)
    const app = await build()
    expect((await post(app, { ...body(), model: 'openai/gpt-5-pro' })).statusCode).toBe(200)
    expect(JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string).model).toBe('typesafe/jev-1.13')
  })

  it('fails closed with no key', async () => {
    env.JEV_OPENROUTER_API_KEY = undefined
    const spy = jevSays(good)
    const app = await build()
    const res = await post(app, body())
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('JEV_NOT_CONFIGURED')
    expect(spy).not.toHaveBeenCalled()
  })

  it('names running out of credit apart from other failures', async () => {
    const app = await build()
    jevSays({ error: 'no credit' }, 402)
    expect((await post(app, body())).json().error.code).toBe('JEV_CREDITS')
    vi.restoreAllMocks()
    jevSays({ error: 'busy' }, 429)
    expect((await post(app, body())).json().error.code).toBe('JEV_BUSY')
    vi.restoreAllMocks()
    jevSays({ error: 'boom' }, 500)
    expect((await post(app, body())).statusCode).toBe(502)
    vi.restoreAllMocks()
    jevSays('not json')
    expect((await post(app, body())).statusCode).toBe(502)
    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down') as never)
    expect((await post(app, body())).json().error.code).toBe('JEV_UNAVAILABLE')
  })

  it('refuses decisions bigger than the router builds', async () => {
    const spy = jevSays(good)
    const app = await build()
    expect((await post(app, body({ state: { message: 'x'.repeat(20_001) } }))).statusCode).toBe(400)
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`s${i}`, 'option']))
    expect((await post(app, body({ questions: { target: { type: 'choice', instructions: 'Which?', criteria: many } } }))).statusCode).toBe(400)
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`q${i}`, body().questions.topic]))
    expect((await post(app, body({ questions: nine }))).statusCode).toBe(400)
    expect((await post(app, { state: { message: 'hi' }, questions: {} })).statusCode).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('caps each account per minute', async () => {
    jevSays(good)
    const app = await build()
    for (let i = 0; i < 30; i++) expect((await post(app, body())).statusCode).toBe(200)
    expect((await post(app, body())).statusCode).toBe(429)
  })
})

describe('jevRateLimitAllows', () => {
  beforeEach(() => resetJevRateLimits())

  it('allows 30 a minute and 1,000 a day per account', () => {
    let now = 0
    let allowed = 0
    // Thirty a minute for an hour is 1,800 asks; the day stops it at 1,000.
    for (let minute = 0; minute < 60; minute++, now += 60_000) {
      for (let i = 0; i < 31; i++) if (jevRateLimitAllows('u1', now)) allowed++
    }
    expect(allowed).toBe(1_000)
    expect(jevRateLimitAllows('u2', now)).toBe(true)
    expect(jevRateLimitAllows('u1', now + 24 * 60 * 60_000)).toBe(true)
  })
})

describe('parseJevAnswers', () => {
  const { questions } = body()

  it('keeps only answers to questions asked, with options offered', () => {
    expect(parseJevAnswers({
      answers: {
        target: { choice: 's0', probabilities: { s0: 0.8, new: 0.2, s9: 0.5 } },
        topic: { choice: 'maybe', probabilities: { maybe: 1 } },
        extra: { choice: 'x', probabilities: { x: 1 } },
      },
    }, questions)).toEqual({ target: { choice: 's0', probabilities: { s0: 0.8, new: 0.2 } } })
  })

  it('is null when nothing usable came back', () => {
    expect(parseJevAnswers(null, questions)).toBeNull()
    expect(parseJevAnswers({ answers: 'no' }, questions)).toBeNull()
    expect(parseJevAnswers({ answers: { target: { choice: 's0' } } }, questions)).toBeNull()
  })
})
