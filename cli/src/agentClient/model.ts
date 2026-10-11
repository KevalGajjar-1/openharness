/**
 * What the agent verbs show, as pure functions of what the daemon answers (docs/design/2026-10-11-agent-client.md):
 * a harness's row in `harness ps`, which harness a name means, and its last turn from a page of its transcript.
 */
import { engineName } from '../messages/model.js'
import type { Ledger, LedgerMember } from './ledger.js'

/** The part of the daemon's `AgentFrame` (lib/agentFrame.ts) the verbs read. */
export interface Frame {
  id: string
  sessionId?: string
  name?: string
  title?: string | null
  engine?: string
  status?: string
  activity?: { state?: string } | null
  tmuxPane?: string | null
  project?: { cwd?: string; root?: string; branch?: string | null; worktree?: boolean } | null
  createdAt?: string
  updatedAt?: string
}

/** The harness running the verb: an agent in its own pane. Null for a person at a terminal. */
export interface Caller extends LedgerMember { name: string; engine: string }

export type State = 'working' | 'idle' | 'needs-input' | 'stopped' | 'offline' | 'unknown'

export interface Row {
  name: string
  id: string
  agent: string
  machine: string
  state: State
  folder: string | null
  branch: string | null
  /** 'person', 'you' (the caller), or the name of the harness that started it. */
  startedBy: string
  /** The caller started it: it may send it work and close it. */
  yours: boolean
  /** This is the caller's own harness. */
  self: boolean
  lastActive: string | null
  /** The person's last asks and the last turns' summaries, newest first, when the daemon has them. */
  asks?: string[]
  about?: string
}

/** How long a stopped harness stays one to list: what ⌘B offers (desktop task_route.dart `stoppedSessionsWithin`). */
export const STOPPED_WITHIN_MS = 7 * 24 * 60 * 60_000

export const isAgent = (frame: Frame): boolean => !!frame.id && frame.engine !== 'terminal'

export function stateOf(frame: Frame): State {
  if (frame.status === 'stopped') return 'stopped'
  if (frame.status === 'offline') return 'offline'
  const state = frame.activity?.state
  return state === 'working' ? 'working' : state === 'idle' ? 'idle' : 'unknown'
}

/**
 * The harness on [pane] in [frames] (stopped ones included), when it is an agent: who is calling. Null only for a
 * person: a terminal's pane, or one Harness does not know. Matching live harnesses only made an agent the person,
 * with the person's right to close anything, whenever the daemon listed it offline for a moment or had just
 * stopped it (found by e2e/agentClient.e2e.ts). A live harness on the pane comes first: tmux numbers panes anew
 * after its server restarts, so a stopped harness's pane may now be someone else's.
 */
export function callerOf(frames: Frame[], pane: string | undefined, machineId: string): Caller | null {
  if (!pane) return null
  const on = frames.filter((f) => f.tmuxPane === pane)
  const frame = on.find((f) => f.status === 'active') ?? on.filter(isAgent).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0]
  if (!frame || !isAgent(frame)) return null
  return { machineId, agentId: frame.id, name: frame.name || frame.id.slice(0, 8), engine: frame.engine ?? '' }
}

export interface RowContext {
  machineId: string
  machine: string
  caller: Caller | null
  ledger: Ledger
  now: number
  /** Include stopped harnesses (within a week). */
  all: boolean
}

export function rowsOf(frames: Frame[], ctx: RowContext): Row[] {
  const rows: Row[] = []
  for (const frame of frames) {
    if (!isAgent(frame)) continue
    const state = stateOf(frame)
    const last = frame.updatedAt ? Date.parse(frame.updatedAt) : NaN
    if (state === 'stopped' && (!ctx.all || !(ctx.now - last < STOPPED_WITHIN_MS))) continue
    const member = { machineId: ctx.machineId, agentId: frame.id }
    const you = ctx.caller?.agentId === frame.id && ctx.caller.machineId === ctx.machineId
    const parent = ctx.ledger.parentOf(member)
    const yours = !!ctx.caller && !!parent && parent.by.machineId === ctx.caller.machineId && parent.by.agentId === ctx.caller.agentId
    rows.push({
      name: frame.name || frame.id.slice(0, 8),
      id: frame.id,
      agent: engineName(frame.engine ?? ''),
      machine: ctx.machine,
      state,
      folder: frame.project?.worktree && frame.project.root ? frame.project.root : frame.project?.cwd ?? null,
      branch: frame.project?.branch ?? null,
      startedBy: yours ? 'you' : parent ? parent.by.name || parent.by.agentId.slice(0, 8) : 'person',
      yours,
      self: you,
      lastActive: Number.isFinite(last) ? new Date(last).toISOString() : null,
    })
  }
  // Working first, then by last activity: what an agent choosing where work goes looks at first.
  const rank = (r: Row): number => (r.state === 'working' || r.state === 'needs-input' ? 0 : r.state === 'idle' || r.state === 'unknown' ? 1 : 2)
  return rows.sort((a, b) => rank(a) - rank(b) || (b.lastActive ?? '').localeCompare(a.lastActive ?? ''))
}

/** The rows [name] means: a whole name, else a name's start, else an id's start (six characters or more). */
export function matching<T extends { name: string; id: string }>(name: string, rows: T[]): T[] {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return []
  const exact = rows.filter((r) => r.name.toLowerCase() === wanted || r.id.toLowerCase() === wanted)
  if (exact.length) return exact
  const prefix = rows.filter((r) => r.name.toLowerCase().startsWith(wanted))
  if (prefix.length) return prefix
  return wanted.length >= 6 ? rows.filter((r) => r.id.toLowerCase().startsWith(wanted)) : []
}

/** One transcript event as the daemon's history reader answers it (`session_get`). */
export interface HistoryEvent { type?: string; payload?: Record<string, unknown> }

export interface LastTurn {
  ask: string | null
  answer: string
  tools: number
  /** The turn ended (`done`), so a harness that is not working has finished it. */
  finished: boolean
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * The last turn in [events], oldest first: the last ask, and the answer, which is the text after the turn's last
 * tool call (the narration before it is the working, not the result). Null when the page holds no ask.
 */
export function lastTurn(events: HistoryEvent[]): LastTurn | null {
  let start = -1
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === 'user_message') { start = i; break }
  if (start < 0) return null
  const turn = events.slice(start + 1)
  let lastTool = -1, tools = 0
  turn.forEach((e, i) => { if (e.type === 'tool_start') tools++; if (e.type === 'tool_end') lastTool = i })
  const said = (from: number) => turn.slice(from).filter((e) => e.type === 'text_delta').map((e) => text(e.payload?.content)).join('').trim()
  const done = turn.find((e) => e.type === 'done')
  const answer = said(lastTool + 1) || said(0) || text(done?.payload?.result).trim()
  return { ask: text(events[start].payload?.content).trim() || null, answer, tools, finished: !!done }
}

export const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value)
