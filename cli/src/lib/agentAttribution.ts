/**
 * A harness another agent started says so in the pull requests it opens: one line beside the engine's own
 * ("🤖 Generated with Claude Code"), so every reader of the pull request, and their agents, sees it was made in
 * Harness (docs/design/2026-10-11-agent-client.md, "Pull requests"). A harness a person started is not marked.
 *
 * Who started a harness is its row's (`startedBy`, sent by `harness new` when an agent runs it); how each engine is
 * told is its launch contract's (`EngineLaunch.attribution`, engines/launches.ts `attributionArgs`). The person turns
 * it off for a computer with `harness settings pull-request-line off` (lib/agentSettings.ts), read at each launch, so
 * a relaunch follows it too.
 */
import { env } from '../config/env.js'
import { attributionArgs, type AttributionPlace } from '../engines/launches.js'
import { readAgentSettings } from './agentSettings.js'

/** The line: short and plain, as the engines' own are, and linked to Harness's site. */
export const AGENT_ATTRIBUTION_LINE = '🤝 Started by another agent in [Harness](https://harness.autonomous.ai) — agents that run agents.'

/** Who started a harness, as `agent_create` takes it and its row keeps it: another agent; absent, the person. */
export type StartedBy = 'agent'

/** A launch's argv for the line: for a harness another agent started, while the person has it on; else none. */
export function startedByAgentArgs(engine: string, startedBy: StartedBy | null | undefined, place: AttributionPlace,
  dataDir: string = env.ADAPTER_DATA_DIR): string[] {
  return startedBy === 'agent' && readAgentSettings(dataDir).pullRequestLine ? attributionArgs(engine, AGENT_ATTRIBUTION_LINE, place) : []
}
