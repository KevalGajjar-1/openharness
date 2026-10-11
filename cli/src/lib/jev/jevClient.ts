/**
 * Jev 1.13, asked through OpenRouter's Decisions API: how ⌘B's router decides where a task goes
 * (lib/routeDecide.ts, docs/design/2026-10-09-auto-router.md). The only Jev in Harness.
 *
 * One POST answers several typed questions at once — which session, which project, which agent — in
 * about 0.6 s, for about $0.0002 on a desk of thirty sessions (measured 2026-10-10).
 *
 * A person with an OpenRouter key of their own asks with it: OPENROUTER_API_KEY, the account `ori login`
 * saved, or the credentials file at ~/.config/typesafe/credentials (or $TYPESAFE_CREDENTIALS). It is read
 * when a decision is asked for and never logged. Everyone else asks on Harness's key, through the backend
 * (backend/src/routes/jevRoute.ts), signed in as themselves: the owner chose to pay for these decisions
 * (2026-10-11), and the key cannot ship here because this code is public.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AuthSessionManager, readAuthSession } from '../authSession.js'
import { resolveOpenRouterKey } from '../openrouter.js'
import { routeApiBase } from '../routeApi.js'

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'
const MODEL = 'typesafe/jev-1.13'
const TIMEOUT_MS = 8_000
const MAX_REPLY_BYTES = 128_000

export interface JevChoice { type: 'choice'; instructions: string; criteria: Record<string, string> }
export interface JevChoiceAnswer { choice: string; probabilities: Record<string, number> }
export type JevDecide = (state: unknown, questions: Record<string, JevChoice>, signal?: AbortSignal) => Promise<Record<string, JevChoiceAnswer>>

/** Why Jev did not answer, in words the router can log and the person can act on. */
export class JevUnavailable extends Error {
  constructor(readonly code: 'NO_KEY' | 'AUTH' | 'CREDITS' | 'BUSY' | 'UNAVAILABLE' | 'INVALID', message: string) { super(message) }
}

/** Where Harness's own key answers: the backend's route, and this person's sign-in for it. */
export interface HostedJev { url: string; headers: Record<string, string> }

export const HOSTED_JEV_PATH = '/api/route/jev'

/** Harness's Jev, as this signed-in person; null when signed out or the sign-in cannot be refreshed. */
export async function hostedJev(): Promise<HostedJev | null> {
  const session = readAuthSession()
  if (!session) return null
  try {
    const token = await new AuthSessionManager(routeApiBase()).accessToken()
    return { url: `${routeApiBase()}${HOSTED_JEV_PATH}`, headers: { authorization: `Bearer ${token}`, 'x-autonomous-env': session.autonomousEnv } }
  } catch {
    return null
  }
}

/** The key, or null when this computer has none. */
export async function resolveJevKey(environment: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const known = await resolveOpenRouterKey()
  if (known) return known
  const path = environment.TYPESAFE_CREDENTIALS || join(homedir(), '.config', 'typesafe', 'credentials')
  try {
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      const match = /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/.exec(line)
      const value = match?.[1].replace(/^(['"])(.*)\1$/, '$2')
      if (value) return value
    }
  } catch { /* no file */ }
  return null
}

/** What a reply's answers say: each one that is a choice with probabilities. */
function readAnswers(answers: unknown): Record<string, JevChoiceAnswer> {
  if (!answers || typeof answers !== 'object') throw new JevUnavailable('INVALID', 'Jev gave no answers')
  const out: Record<string, JevChoiceAnswer> = {}
  for (const [id, raw] of Object.entries(answers as Record<string, unknown>)) {
    const answer = raw as { choice?: unknown; probabilities?: unknown } | null
    if (typeof answer?.choice !== 'string' || !answer.probabilities || typeof answer.probabilities !== 'object') continue
    out[id] = { choice: answer.choice, probabilities: answer.probabilities as Record<string, number> }
  }
  return out
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length > MAX_REPLY_BYTES) throw new JevUnavailable('INVALID', 'Jev answered too much')
  try { return JSON.parse(text) } catch { throw new JevUnavailable('INVALID', 'Jev answered something that is not JSON') }
}

/** Why the backend did not answer, from its status and its error code. */
async function hostedRefusal(response: Response): Promise<JevUnavailable> {
  let code: unknown
  try { code = ((await response.json()) as { error?: { code?: unknown } } | null)?.error?.code } catch { /* no body */ }
  if (response.status === 401 || response.status === 403) return new JevUnavailable('AUTH', 'Harness could not confirm your sign-in')
  if (response.status === 429) return new JevUnavailable('BUSY', 'too many ⌘B decisions, try again in a minute')
  if (code === 'JEV_CREDITS') return new JevUnavailable('CREDITS', "Harness's Jev credit has run out")
  if (code === 'JEV_BUSY') return new JevUnavailable('BUSY', 'Jev is busy')
  // An older backend, before the route: the CLI self-updates on its own schedule and can arrive first.
  if (response.status === 404) return new JevUnavailable('UNAVAILABLE', "Harness's server cannot decide yet")
  return new JevUnavailable('UNAVAILABLE', `Harness's server answered ${response.status}`)
}

export function createJevDecide(options: {
  key?: () => Promise<string | null>
  /** Harness's key, for a computer with none of its own. */
  hosted?: () => Promise<HostedJev | null>
  fetch?: typeof fetch
  /** What each answer cost, as OpenRouter reports it (USD) — what a person's own key is charged. */
  onCost?: (usd: number, inputTokens: number) => void
} = {}): JevDecide {
  return async (state, questions, signal) => {
    const key = await (options.key ?? resolveJevKey)()
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout
    if (!key) {
      const hosted = await (options.hosted ?? hostedJev)()
      if (!hosted) throw new JevUnavailable('NO_KEY', 'sign in to Harness to use ⌘B')
      const response = await (options.fetch ?? fetch)(hosted.url, {
        method: 'POST',
        signal: abort,
        headers: { ...hosted.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, questions }),
      })
      if (!response.ok) throw await hostedRefusal(response)
      return readAnswers(((await readJson(response)) as { data?: { answers?: unknown } } | null)?.data?.answers)
    }
    const response = await (options.fetch ?? fetch)(ENDPOINT, {
      method: 'POST',
      signal: abort,
      headers: {
        Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
        'HTTP-Referer': 'https://harness.autonomous.ai', 'X-Title': 'Harness router',
      },
      body: JSON.stringify({ model: MODEL, state, questions }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 401 || response.status === 403) throw new JevUnavailable('AUTH', 'OpenRouter refused the key')
      if (response.status === 402) throw new JevUnavailable('CREDITS', 'the OpenRouter account is out of credit')
      if (response.status === 429) throw new JevUnavailable('BUSY', 'OpenRouter is busy')
      throw new JevUnavailable('UNAVAILABLE', `OpenRouter answered ${response.status}`)
    }
    const parsed = await readJson(response)
    const answers = readAnswers((parsed as { answers?: unknown } | null)?.answers)
    const usage = (parsed as { usage?: { cost?: unknown; input_tokens?: unknown } }).usage
    if (typeof usage?.cost === 'number') options.onCost?.(usage.cost, typeof usage.input_tokens === 'number' ? usage.input_tokens : 0)
    return answers
  }
}
