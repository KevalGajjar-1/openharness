/**
 * Cursor Cloud, through Cursor's Cloud Agents API v1 (public beta, cursor.com/docs/cloud-agent/api): an
 * agent per harness on a GitHub repository, and a run per message (`POST /v1/agents` makes the first,
 * `POST /v1/agents/{id}/runs` each follow-up; one at a time, `409 agent_busy` otherwise). A run is read
 * by its status; its `result` is what the agent said. Stop cancels the run in flight.
 */
import { CLOUD_AGENTS, type CloudState } from '../lib/cloudAgents.js'
import { refusal, type Bridge } from './bridge.js'
import type { CloudAdapter, CloudLink, CloudUpdate } from './types.js'

const NAME = CLOUD_AGENTS['cursor-cloud'].name
type Json = Record<string, unknown>
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

export function cursorState(status: unknown): CloudState {
  switch (status) {
    case 'CREATING': return 'starting'
    case 'RUNNING': return 'working'
    case 'FINISHED': return 'idle'
    case 'CANCELLED': return 'stopped'
    case 'ERROR': case 'EXPIRED': return 'failed'
    default: return 'working'
  }
}

/** What a run said: its result as text, or the text a result object carries. */
export function runResult(run: Json): string | null {
  const result = run.result
  if (str(result)) return str(result)
  const value = (result && typeof result === 'object' ? result : {}) as Json
  return str(value.text) ?? str(value.summary) ?? str(value.message) ?? str(value.output) ?? null
}

export function cursorLinks(agent: Json, run: Json): CloudLink[] {
  const links: CloudLink[] = []
  if (str(agent.url)) links.push({ label: 'Agent', url: str(agent.url)! })
  const git = (run.git && typeof run.git === 'object' ? run.git : {}) as Json
  const pr = str(git.prUrl) ?? str(git.pullRequestUrl) ?? str((agent.repos as Json[] | undefined)?.[0]?.prUrl)
  if (pr) links.push({ label: `Pull request #${/\/pull\/(\d+)/.exec(pr)?.[1] ?? ''}`.replace(/ #$/, ''), url: pr })
  return links
}

export function cursorAdapter(bridge: Bridge, code: () => Promise<string>): CloudAdapter {
  const call = async (method: string, path: string, body?: unknown): Promise<Json> => {
    const answer = await bridge.api(await code(), method, path, body)
    if (answer.status >= 300) throw refusal(NAME, answer.status, answer.json)
    return answer.json
  }
  const runOf = (answer: Json): Json => (answer.run && typeof answer.run === 'object' ? answer.run as Json : answer)

  return {
    id: 'cursor-cloud',
    async start(request) {
      const answer = await call('POST', '/v1/agents', {
        prompt: { text: request.task },
        ...(request.repository ? { repos: [{ url: `https://github.com/${request.repository}` }] } : {}),
        ...(request.options.model ? { model: { id: request.options.model } } : {}),
        autoCreatePR: true,
      })
      const agent = (answer.agent && typeof answer.agent === 'object' ? answer.agent : answer) as Json
      const run = runOf(answer)
      const id = str(agent.id)
      if (!id) throw refusal(NAME, 502, { detail: 'No agent was made.' })
      return { remote: { id, ...(str(run.id) ? { run: str(run.id)! } : {}) }, links: cursorLinks(agent, run), update: { messages: [], state: cursorState(run.status ?? 'CREATING') } }
    },
    async send(remote, text) {
      const run = runOf(await call('POST', `/v1/agents/${encodeURIComponent(remote.id)}/runs`, { prompt: { text } }))
      return str(run.id) ? { run: str(run.id)! } : {}
    },
    async poll(remote): Promise<CloudUpdate> {
      if (!remote.run) return { messages: [] }
      const agentPath = `/v1/agents/${encodeURIComponent(remote.id)}`
      const run = await call('GET', `${agentPath}/runs/${encodeURIComponent(remote.run)}`)
      const state = cursorState(run.status)
      const said = runResult(run)
      // A run's result is read once, when it ends: the cursor remembers the run already told.
      const told = remote.cursor === remote.run
      const messages = state !== 'working' && state !== 'starting' && said && !told ? [{ id: `${remote.run}-result`, text: said, at: str(run.updatedAt) ?? new Date().toISOString() }] : []
      const git = (run.git && typeof run.git === 'object' ? run.git : {}) as Json
      return {
        messages,
        state,
        branch: str(git.branch) ?? str(git.branchName) ?? undefined,
        links: state === 'working' ? undefined : cursorLinks(await call('GET', agentPath), run),
        remote: state === 'working' || state === 'starting' ? {} : { cursor: remote.run },
      }
    },
    async stop(remote) {
      if (remote.run) await call('POST', `/v1/agents/${encodeURIComponent(remote.id)}/runs/${encodeURIComponent(remote.run)}/cancel`)
    },
  }
}
