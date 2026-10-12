/**
 * What the person lets agents do with Harness (docs/design/2026-10-11-agent-client.md), kept by the daemon in its data
 * folder: `agent-settings.json`. Settings ▸ Agents writes it through the daemon (`/api/agent-settings`), `harness
 * settings` from a terminal, and the daemon and the CLI read it: the daemon when it starts an agent (whether its
 * instructions say how to start others, and whether one another agent started says so in its pull requests),
 * `harness new` when an agent runs it (whether it may).
 *
 * Agents may start agents unless the person turns it off: some want every agent to work alone, under their eye.
 * A file that is missing or that cannot be read is the defaults, never a refusal to work.
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface AgentSettings {
  /** Agents may start, wait for and close harnesses of their own, and are told how as they start. */
  agentsStartAgents: boolean
  /** A harness another agent started adds a line to the pull requests it opens (lib/agentAttribution.ts). Read at
   *  each launch of one, so a harness running when it is turned off keeps its line until it restarts. */
  pullRequestLine: boolean
  /** Agents in the same tab may message each other (`harness send`, messages/service.ts). It replaced each tab's own
   *  switch, a chat icon beside its × that was easy to hit by mistake (owner, 2026-10-12). */
  agentMessages: boolean
}

export const AGENT_SETTINGS_DEFAULTS: AgentSettings = { agentsStartAgents: true, pullRequestLine: true, agentMessages: true }

/** Each setting's name in `harness settings`, and its key. */
export const AGENT_SETTING_NAMES: Record<string, keyof AgentSettings> = { 'agents-start-agents': 'agentsStartAgents', 'pull-request-line': 'pullRequestLine', 'agent-messages': 'agentMessages' }

export const agentSettingsPath = (dataDir: string): string => join(dataDir, 'agent-settings.json')

export function readAgentSettings(dataDir: string): AgentSettings {
  try {
    const saved = JSON.parse(readFileSync(agentSettingsPath(dataDir), 'utf8')) as Record<string, unknown>
    return Object.fromEntries(Object.entries(AGENT_SETTINGS_DEFAULTS)
      .map(([key, fallback]) => [key, typeof saved[key] === 'boolean' ? saved[key] : fallback])) as unknown as AgentSettings
  } catch {
    return { ...AGENT_SETTINGS_DEFAULTS }
  }
}

/**
 * Applies [patch] (only the keys it knows, only booleans) and says what the settings are now; null when the patch
 * holds nothing it can apply. Written whole and renamed into place, so a reader never sees half a file.
 */
export function writeAgentSettings(dataDir: string, patch: unknown): AgentSettings | null {
  if (!patch || typeof patch !== 'object') return null
  const known = Object.entries(patch as Record<string, unknown>).filter(([key, value]) => key in AGENT_SETTINGS_DEFAULTS && typeof value === 'boolean')
  if (!known.length) return null
  const next = { ...readAgentSettings(dataDir), ...Object.fromEntries(known) } as AgentSettings
  const path = agentSettingsPath(dataDir)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ version: 1, ...next })}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
  return next
}

/** `/api/agent-settings` for the daemon whose data folder is [dataDir]: the settings, or a write's result. */
export function agentSettingsRoutes(dataDir: string): { read: () => Promise<{ status: number; body: Record<string, unknown> }>; write: (body: unknown) => Promise<{ status: number; body: Record<string, unknown> }> } {
  return {
    read: async () => ({ status: 200, body: { ...readAgentSettings(dataDir) } }),
    write: async (body) => {
      const next = writeAgentSettings(dataDir, body)
      return next ? { status: 200, body: { ...next } } : { status: 400, body: { error: { code: 'BAD_REQUEST', message: 'Nothing to change: send {"agentsStartAgents": true|false}, {"pullRequestLine": true|false} or {"agentMessages": true|false}.' } } }
    },
  }
}
