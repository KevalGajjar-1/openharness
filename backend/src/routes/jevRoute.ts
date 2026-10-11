/**
 * ⌘B's Jev decisions on Harness's own OpenRouter key.
 *
 *   POST /api/route/jev   SSO access token, { state, questions } → { answers }
 *
 * WHY. ⌘B asks Jev 1.13 (OpenRouter's Decisions API) where a typed task goes. The CLI used to need the
 * person's own OpenRouter key, so for nearly everyone ⌘B said "no OpenRouter key" and sent nothing. A
 * decision costs about $0.00017 (docs/design/2026-10-09-auto-router.md), so the owner chose to pay for
 * them (2026-10-11). The key cannot ship in the CLI: this repository is public and the CLI runs on every
 * user's computer. It stays here. A person with a key of their own still uses it directly
 * (cli/src/lib/jev/jevClient.ts); this route is for everyone else.
 *
 * WHAT IS FIXED HERE. The model and the endpoint: a caller sends the decision, never a model name, so
 * this key buys Jev routing and nothing else. The size of a decision is bounded to what the router builds
 * (a message and up to four questions of 41 options, lib/routeDecide.ts), which is what bounds its price.
 *
 * WHAT IS NOT KEPT. The message and the session descriptions are relayed and dropped. The log carries the
 * account, the time, the cost and the token count, never the words. Every request is OpenRouter-titled
 * "Harness router": an unnamed app burned $60 on 2026-10-10 before anyone could tell which one it was.
 *
 * THE BUDGET is the key's credit limit on OpenRouter. The per-account caps below only keep one account
 * (or one runaway client) from spending everyone's share: a person presses ⌘B, a loop does not.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { env } from '../config/env.js'
import { validateBody } from '../middlewares/validation.js'
import { sendSuccess, sendError } from '../utils/response.js'
import { logger } from '../utils/logger.js'

export const JEV_ROUTE_PATH = '/api/route/jev'

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'
const MODEL = 'typesafe/jev-1.13'
/** The CLI waits 8 s for Jev directly; one hop more, and it still gives up first. */
const TIMEOUT_MS = 7_000
const MAX_REPLY_CHARS = 128_000

/** A message is at most 16,000 characters in the CLI (services/router.ts MAX_TEXT). */
const MAX_STATE_CHARS = 20_000
const MAX_QUESTIONS = 8
const MAX_OPTIONS = 64
const MAX_OPTION_CHARS = 1_000
const MAX_INSTRUCTION_CHARS = 4_000

/** Per account: a burst of quick ⌘B presses passes, a client in a loop does not get far. */
const MINUTE_MS = 60_000
const PER_MINUTE = 30
const DAY_MS = 24 * 60 * 60_000
const PER_DAY = 1_000

const minuteBuckets = new Map<string, { count: number; resetAt: number }>()
const dayBuckets = new Map<string, { count: number; resetAt: number }>()

function take(buckets: Map<string, { count: number; resetAt: number }>, userId: string, windowMs: number, max: number, now: number): boolean {
  const bucket = buckets.get(userId)
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(userId, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (bucket.count >= max) return false
  bucket.count++
  return true
}

/** Process-local by design, like agentRoute's limiter: the key's credit limit is the real ceiling. */
export function jevRateLimitAllows(userId: string, now = Date.now()): boolean {
  const day = dayBuckets.get(userId)
  if (day && now < day.resetAt && day.count >= PER_DAY) return false
  if (!take(minuteBuckets, userId, MINUTE_MS, PER_MINUTE, now)) return false
  return take(dayBuckets, userId, DAY_MS, PER_DAY, now)
}

/** Test seam. */
export function resetJevRateLimits(): void {
  minuteBuckets.clear()
  dayBuckets.clear()
}

const choiceSchema = z.object({
  type: z.literal('choice'),
  instructions: z.string().min(1).max(MAX_INSTRUCTION_CHARS),
  criteria: z
    .record(z.string().min(1).max(64), z.string().max(MAX_OPTION_CHARS))
    .refine((criteria) => {
      const count = Object.keys(criteria).length
      return count >= 2 && count <= MAX_OPTIONS
    }, `between 2 and ${MAX_OPTIONS} options`),
})

const jevBodySchema = z.object({
  state: z
    .record(z.string().max(64), z.string())
    .refine((state) => JSON.stringify(state).length <= MAX_STATE_CHARS, 'state is too long'),
  questions: z
    .record(z.string().min(1).max(64), choiceSchema)
    .refine((questions) => {
      const count = Object.keys(questions).length
      return count >= 1 && count <= MAX_QUESTIONS
    }, `between 1 and ${MAX_QUESTIONS} questions`),
})

export type JevBody = z.infer<typeof jevBodySchema>

export interface JevAnswer {
  choice: string
  probabilities: Record<string, number>
}

/**
 * Jev's answers, kept only where they answer a question that was asked with one of its own options.
 * Null when nothing usable came back.
 */
export function parseJevAnswers(raw: unknown, questions: JevBody['questions']): Record<string, JevAnswer> | null {
  const answers = (raw as { answers?: unknown } | null)?.answers
  if (!answers || typeof answers !== 'object') return null
  const out: Record<string, JevAnswer> = {}
  for (const [id, value] of Object.entries(answers as Record<string, unknown>)) {
    const question = questions[id]
    const answer = value as { choice?: unknown; probabilities?: unknown } | null
    if (!question || typeof answer?.choice !== 'string' || !(answer.choice in question.criteria)) continue
    if (!answer.probabilities || typeof answer.probabilities !== 'object') continue
    const probabilities: Record<string, number> = {}
    for (const [option, p] of Object.entries(answer.probabilities as Record<string, unknown>)) {
      if (option in question.criteria && typeof p === 'number' && Number.isFinite(p)) probabilities[option] = p
    }
    out[id] = { choice: answer.choice, probabilities }
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * ORDINARY SSO GATING, as /api/route/agents: the daemon signs in as a person and presents that access
 * token; the middleware puts the account on `request.user`, which the caps count.
 */
export async function jevRouteRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: JevBody }>(JEV_ROUTE_PATH, { preHandler: [validateBody(jevBodySchema)] }, async (req, reply) => {
    // Fail CLOSED: an absent key must never read as "decide some other way" on a path that spends credit.
    if (!env.JEV_OPENROUTER_API_KEY) {
      logger.error('jev-route: JEV_OPENROUTER_API_KEY not configured — refusing')
      sendError(reply, 'Jev is not set up on this server', 'JEV_NOT_CONFIGURED', 503)
      return
    }
    const userId = req.user?.sub ?? ''
    if (!jevRateLimitAllows(userId)) {
      sendError(reply, 'Too many ⌘B decisions; try again in a minute', 'RATE_LIMITED', 429)
      return
    }

    const started = Date.now()
    const { state, questions } = req.body
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${env.JEV_OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://harness.autonomous.ai',
          'X-Title': 'Harness router',
        },
        body: JSON.stringify({ model: MODEL, state, questions }),
      })
      if (!res.ok) {
        await res.body?.cancel()
        logger.error('jev-route: OpenRouter refused', { userId, status: res.status, ms: Date.now() - started })
        // Out of credit is the one the owner must act on, and the CLI tells the person it is ours.
        if (res.status === 402) sendError(reply, 'Harness is out of Jev credit', 'JEV_CREDITS', 503)
        else if (res.status === 429) sendError(reply, 'Jev is busy', 'JEV_BUSY', 503)
        else sendError(reply, 'Jev did not answer', 'JEV_UNAVAILABLE', 502)
        return
      }
      const text = await res.text()
      let parsed: unknown = null
      if (text.length <= MAX_REPLY_CHARS) {
        try { parsed = JSON.parse(text) } catch { /* reported below */ }
      }
      const answers = parseJevAnswers(parsed, questions)
      if (!answers) {
        logger.error('jev-route: unusable answer', { userId, chars: text.length, ms: Date.now() - started })
        sendError(reply, 'Jev did not answer', 'JEV_UNAVAILABLE', 502)
        return
      }
      const usage = (parsed as { usage?: { cost?: unknown; input_tokens?: unknown } }).usage
      logger.info('jev-route', {
        userId,
        ms: Date.now() - started,
        questions: Object.keys(questions).length,
        cost: typeof usage?.cost === 'number' ? usage.cost : undefined,
        tokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined,
      })
      sendSuccess(reply, { answers })
    } catch (err) {
      logger.error('jev-route failed', { userId, ms: Date.now() - started, error: err instanceof Error ? err.name : String(err) })
      sendError(reply, 'Jev did not answer', 'JEV_UNAVAILABLE', 502)
    }
  })
}
