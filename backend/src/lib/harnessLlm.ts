/**
 * Harness's own calls to the LLM behind CURSOR_LLM_* (an OpenAI-compatible endpoint), with plain `fetch`.
 *
 * Shared by Harness routes (agent routing, Hub translation). routes/cursor.ts keeps its own copy, and
 * knowingly so: that file belongs to the Cursor app and documents its self-containment as a decision,
 * so a Harness deploy must not change its behaviour.
 */
import { env } from '../config/env.js'

/** Routes that spend this credit fail CLOSED without it: an absent credential is never "answer some other way". */
export const harnessLlmConfigured = (): boolean => !!env.CURSOR_LLM_BASE_URL && !!env.CURSOR_LLM_API_KEY

export async function callHarnessLlm(prompt: string, timeoutMs: number): Promise<{ text: string; model: string }> {
  const model = env.CURSOR_LLM_MODEL
  const res = await fetch(`${env.CURSOR_LLM_BASE_URL!.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CURSOR_LLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`LLM HTTP ${res.status}: ${detail.slice(0, 200)}`)
  }
  const data = (await res.json()) as { model?: string; choices?: Array<{ message?: { content?: string } }> }
  return { text: (data.choices?.[0]?.message?.content ?? '').trim(), model: data.model || model }
}

/**
 * The JSON object a reply carries, or null.
 *
 * "Respond with only JSON" is a request, not a guarantee: a fence or a sentence of preamble is normal
 * from the model this runs on, so the object is taken from between the first `{` and the last `}`.
 */
export function replyJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fenced ? fenced[1] : raw).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}
