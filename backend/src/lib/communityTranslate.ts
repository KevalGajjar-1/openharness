/**
 * A Hub draft's words in English: its title, description and the people's and agent's turns.
 *
 * Tool turns stay as they are (logs and file contents, not prose). Items go to the model in batches,
 * a few at a time; an item already in English comes back marked `same`, so the model never rewrites
 * it and the author is never told something was translated when it was not.
 */
import { communityLimits } from './communityContract.js'
import { callHarnessLlm, replyJson } from './harnessLlm.js'

export type TranslationRole = 'user' | 'assistant' | 'tool'
export interface TranslationTexts {
  title: string
  description: string
  conversation: { role: TranslationRole; text: string }[]
}
export interface Translation extends TranslationTexts {
  /** False when every item was already English: the draft is unchanged. */
  translated: boolean
}

export const translationLimits = {
  /** What one request may carry: about what Desktop sends (its session tail is 60,000 characters). */
  totalChars: 80_000,
  /** Small batches, mostly all at once: the whole answer has to beat the ingress's 60-second wait. */
  batchChars: 5_000,
  concurrency: 16,
  callTimeoutMs: 25_000,
  deadlineMs: 50_000,
} as const

/** The draft is longer than one request may translate. */
export class TranslationTooLong extends Error {}

type Ask = (prompt: string, timeoutMs: number) => Promise<{ text: string }>
interface Item { text: string; max: number }

/** The words to translate, in a fixed order: title, description, then each non-tool turn. */
function itemsOf(texts: TranslationTexts): Item[] {
  return [
    { text: texts.title, max: 100 },
    { text: texts.description, max: 300 },
    ...texts.conversation.map(turn => ({ text: turn.role === 'tool' ? '' : turn.text, max: communityLimits.turnChars })),
  ]
}

/** Indexes of the items worth asking about, packed into batches of at most `batchChars` (a longer item goes alone). */
export function batchesOf(items: { text: string }[], batchChars: number = translationLimits.batchChars): number[][] {
  const batches: number[][] = []
  let current: number[] = [], size = 0
  items.forEach((item, index) => {
    if (!item.text.trim()) return
    if (current.length && size + item.text.length > batchChars) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(index)
    size += item.text.length
  })
  if (current.length) batches.push(current)
  return batches
}

export function translationPrompt(items: { i: number; text: string }[]): string {
  return (
    `Translate each item below into English. They are the title, description and conversation of a public\n` +
    `page showing what someone built with an AI coding agent.\n\n` +
    `- An item already in English: answer {"i":<n>,"same":true}, never a rewrite of it.\n` +
    `- Any other item: answer {"i":<n>,"en":"<the English text>"}.\n` +
    `- Translate only the human language. Keep code, code blocks, inline code, commands, file names, paths,\n` +
    `  URLs, numbers and Markdown exactly as they are, and keep the line breaks.\n` +
    `- Translate faithfully: never summarise, add to, explain, or answer what an item says.\n\n` +
    `Respond with ONLY this JSON, no prose, no markdown fence, one entry per item:\n` +
    `{"items":[...]}\n\n` +
    `Items:\n${JSON.stringify(items)}`
  )
}

/** Each asked item's English, or null for one already in English; null overall unless every item is answered. */
export function parseTranslation(raw: string, asked: number[]): Map<number, string | null> | null {
  const rows = (replyJson(raw) as { items?: unknown } | null)?.items
  if (!Array.isArray(rows)) return null
  const answers = new Map<number, string | null>()
  for (const row of rows) {
    const entry = row as { i?: unknown; en?: unknown; same?: unknown } | null
    if (typeof entry?.i !== 'number' || !asked.includes(entry.i)) continue
    if (entry.same === true) answers.set(entry.i, null)
    else if (typeof entry.en === 'string' && entry.en.trim()) answers.set(entry.i, entry.en)
  }
  return asked.every(index => answers.has(index)) ? answers : null
}

async function translateBatch(items: Item[], asked: number[], ask: Ask, deadline: number): Promise<Map<number, string | null>> {
  const prompt = translationPrompt(asked.map(i => ({ i, text: items[i].text })))
  // One retry, while time remains: a reply that drops an item or breaks its JSON is usually fine the second time.
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const answers = parseTranslation((await ask(prompt, Math.min(translationLimits.callTimeoutMs, remaining))).text, asked)
    if (answers) return answers
  }
  throw new Error('The translation came back incomplete.')
}

/** Runs [work] over [inputs] at most [limit] at a time, keeping their order. */
async function mapLimited<T, R>(inputs: T[], limit: number, work: (input: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(inputs.length)
  let next = 0
  const worker = async () => {
    while (next < inputs.length) {
      const index = next++
      results[index] = await work(inputs[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker))
  return results
}

export async function translateDraft(texts: TranslationTexts, ask: Ask = callHarnessLlm): Promise<Translation> {
  const items = itemsOf(texts)
  if (items.reduce((sum, item) => sum + item.text.length, 0) > translationLimits.totalChars) throw new TranslationTooLong()
  const answers = new Map<number, string | null>(), deadline = Date.now() + translationLimits.deadlineMs
  const results = await mapLimited(batchesOf(items), translationLimits.concurrency, asked => translateBatch(items, asked, ask, deadline))
  for (const batch of results) for (const [index, english] of batch) answers.set(index, english)
  const english = items.map((item, index) => {
    const answer = answers.get(index)
    return answer ? answer.slice(0, item.max) : item.text
  })
  return {
    title: english[0],
    description: english[1],
    conversation: texts.conversation.map((turn, index) => ({ role: turn.role, text: turn.role === 'tool' ? turn.text : english[index + 2] })),
    translated: english.some((text, index) => text !== items[index].text),
  }
}
