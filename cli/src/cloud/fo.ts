/**
 * Fo (Wajo), a personal agent that runs errands, through its MCP server's Fo profile
 * (https://mcp.api.wajo.ai/fo): `ask_fo` sends the person's words and answers at once or with
 * `status: "working"`, and `get_fo_reply` waits up to 40 s for the reply (wajo.ai/docs/mcp-tools.md).
 *
 * Wajo publishes what the tools do but not their parameters' names, so they are read from `tools/list` on
 * first use and filled by what they mean: the person's words, the conversation, the pending reply. A reply
 * that lists choices waits on the person, with those choices; one that only ends with a question is a turn
 * ended, as Claude Code's is. Fo cannot be stopped from here: it keeps working on its own.
 */
import { CLOUD_AGENTS } from '../lib/cloudAgents.js'
import type { McpClient, McpTool } from './mcp.js'
import { CloudError, type CloudAdapter, type CloudUpdate, type Remote } from './types.js'

const NAME = CLOUD_AGENTS.fo.name
const WORDS = ['message', 'request', 'text', 'prompt', 'query', 'content', 'task', 'input']
const REPLY = ['reply', 'text', 'message', 'response', 'answer', 'content', 'result']

const props = (tool: McpTool | undefined): Record<string, { type?: string }> => tool?.inputSchema?.properties ?? {}
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** The parameter that takes the person's words: one named for them, else the first required string. */
export function wordsParam(tool: McpTool | undefined): string {
  const names = Object.keys(props(tool))
  return names.find((name) => WORDS.includes(name.toLowerCase()))
    ?? (tool?.inputSchema?.required ?? []).find((name) => props(tool)[name]?.type === 'string')
    ?? 'message'
}

/** A reply as Fo gave it: whether it is still working, its words, and every id it named. */
export function readReply(result: Record<string, unknown>): { working: boolean; text: string | null; ids: Record<string, string>; progress: string | null } {
  const ids: Record<string, string> = {}
  for (const [key, value] of Object.entries(result)) if (/id$/i.test(key) && str(value)) ids[key] = str(value)!
  const conversation = result.conversation as Record<string, unknown> | undefined
  if (conversation && str(conversation.id)) ids.conversation_id ??= str(conversation.id)!
  const status = str(result.status)?.toLowerCase() ?? ''
  const working = ['working', 'pending', 'in_progress', 'running'].includes(status)
  // While working, what it says is progress, not its reply: only an explicit `reply` is one.
  const text = working ? str(result.reply) : REPLY.map((key) => str(result[key])).find(Boolean) ?? null
  return { working, text,
    ids, progress: str(result.progress) ?? str(result.activity) ?? (working ? str(result.message) ?? str(result.text) : null) }
}

/**
 * A reply that offers choices: the paragraph that asks, and the choices it lists (up to six). Only choices make
 * it a question. Fo chats, and most of its replies end with one ("Did that trip ever get a destination?"):
 * as questions they lit its pane amber after every turn (2026-10-11), where a Claude Code turn that ends
 * with a question in its words is simply over.
 */
export function questionIn(text: string): { text: string; choices: string[] } | null {
  const paragraphs = text.trim().split(/\n\s*\n/)
  const choices = text.split('\n').map((line) => /^\s*(?:\d+[.)]|[-•])\s+(.{1,60})\s*$/.exec(line)?.[1]?.trim()).filter((choice): choice is string => !!choice).slice(0, 6)
  if (choices.length < 2) return null
  const asking = paragraphs.find((paragraph) => /\?\s*$/.test(paragraph.trim()))
  return { text: (asking ?? paragraphs[0]).trim().slice(0, 500), choices }
}

/** A refusal Fo asks to be retried: its conversation is still finishing the run that just replied (2026-10-11:
 *  an answer sent a second after Fo's question was refused "session busy with another run, retry"). */
const BUSY = /session busy|busy with another run|retry/i

export function foAdapter(client: () => Promise<McpClient>, now: () => Date = () => new Date(),
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): CloudAdapter {
  let schema: Promise<Map<string, McpTool>> | null = null
  /** A reply Fo gave at once, kept for the next look. */
  const ready = new Map<string, string>()

  const tools = (): Promise<Map<string, McpTool>> => {
    schema ??= client().then((mcp) => mcp.tools()).then((list) => new Map(list.map((tool) => [tool.name, tool])))
      .catch((error) => { schema = null; throw error })
    return schema
  }

  /** `ask_fo`, with the conversation named when there is one to continue, and a fresh one asked for when not:
   *  by default Fo continues the person's current conversation, which a new harness must not land in. */
  const ask = async (text: string, conversation: string | null): Promise<{ remote: Remote; reply: ReturnType<typeof readReply> }> => {
    const known = await tools()
    const askTool = known.get('ask_fo')
    if (!askTool) throw new CloudError('CLOUD_FAILED', `${NAME}'s MCP server has no ask_fo. Connect https://mcp.api.wajo.ai/fo.`)
    const args: Record<string, unknown> = { [wordsParam(askTool)]: text }
    const conversationParam = Object.keys(props(askTool)).find((name) => /conversation/i.test(name) && props(askTool)[name]?.type === 'string')
    const freshParam = Object.keys(props(askTool)).find((name) => /^new/i.test(name) && props(askTool)[name]?.type === 'boolean')
    if (conversation && conversationParam) args[conversationParam] = conversation
    else if (!conversation && freshParam) args[freshParam] = true
    let reply: ReturnType<typeof readReply> | null = null
    // Retried while Fo says its conversation is busy, for up to half a minute; then the person is told.
    for (let attempt = 0; !reply; attempt++) {
      try {
        reply = readReply(await (await client()).call('ask_fo', args, 60_000))
      } catch (error) {
        if (!(error instanceof CloudError) || !BUSY.test(error.message) || attempt >= 9) {
          throw error instanceof CloudError && BUSY.test(error.message) ? new CloudError('BUSY', `${NAME} is still working. Send it again in a moment.`) : error
        }
        await pause(3_000)
      }
    }
    const id = reply.ids.conversation_id ?? reply.ids.conversationId ?? conversation ?? 'current'
    const pending = Object.fromEntries(Object.entries(reply.ids).filter(([key]) => !/conversation/i.test(key)))
    if (!reply.working && reply.text) ready.set(id, reply.text)
    return { remote: { id, ...(reply.working ? { run: JSON.stringify(pending) } : {}) }, reply }
  }

  const answered = (text: string): CloudUpdate => {
    const question = questionIn(text)
    return { messages: [{ id: `fo-${now().getTime()}`, text, at: now().toISOString() }], state: question ? 'needs_input' : 'idle',
      question, activity: null, remote: { run: undefined } }
  }

  return {
    id: 'fo',
    async start(request) {
      const { remote, reply } = await ask(request.task, null)
      return { remote, links: [], update: reply.working ? { messages: [], state: 'working', activity: reply.progress } : undefined }
    },
    async send(remote, text) {
      const { remote: next } = await ask(text, remote.id === 'current' ? null : remote.id)
      return { ...next, run: next.run }
    },
    async poll(remote, signal) {
      const waiting = ready.get(remote.id)
      if (waiting) { ready.delete(remote.id); return answered(waiting) }
      if (!remote.run) return { messages: [] }
      const replyTool = (await tools()).get('get_fo_reply')
      const known: Record<string, string> = { ...JSON.parse(remote.run) as Record<string, string>, conversation_id: remote.id, conversationId: remote.id }
      const args = Object.fromEntries(Object.keys(props(replyTool)).flatMap((name) => (known[name] ? [[name, known[name]]] : [])))
      const reply = readReply(await (await client()).call('get_fo_reply', args, 60_000, signal))
      if (reply.working || !reply.text) return { messages: [], state: 'working', activity: reply.progress, waited: true }
      return answered(reply.text)
    },
    answered: (remote) => ready.has(remote.id),
  }
}
