/**
 * Which experiments are on as the core starts (core/api.ts `EXPERIMENTS`): one whose saved state is in the
 * data folder is asked for at once, so that what it does on its own (a saved project's queued work) goes on
 * after a restart, as it did when it ran in the core's process; so is one whose Settings ▸ Agents switch is on
 * (Agent Messages, on by default). One with neither waits for its first request: off, it has no process. Read
 * once, at start, and bounded: a name or a folder listing, and the one small settings file.
 */
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readAgentSettings, type AgentSettings } from '../lib/agentSettings.js'
import type { BackendNotice } from './api.js'

type Experiments = Readonly<Record<string, { state: readonly string[]; setting?: keyof AgentSettings }>>

/** Whether any of `state` is in `dataDir`: a path under it, or `dir/*.ext` for a file of that kind in that folder. */
export function stateIsThere(dataDir: string, state: readonly string[]): boolean {
  return state.some((entry) => {
    const star = entry.lastIndexOf('/*')
    if (star < 0) return existsSync(join(dataDir, entry))
    const suffix = entry.slice(star + 2)
    try {
      return readdirSync(join(dataDir, entry.slice(0, star))).some((name) => name.endsWith(suffix))
    } catch {
      return false
    }
  })
}

/** Ask for each experiment that runs in its own process and has saved state here, or whose Settings ▸ Agents switch
 *  is on (Agent Messages, on by default: its agents hear of `harness send` only from its process). */
export function wakeExperiments(options: {
  dataDir: string
  experiments: Experiments
  outOfProcess: ReadonlySet<string>
  want: (service: string) => void
}): string[] {
  const settings = readAgentSettings(options.dataDir)
  const woken = Object.entries(options.experiments)
    .filter(([name, experiment]) => options.outOfProcess.has(name)
      && (stateIsThere(options.dataDir, experiment.state) || (experiment.setting !== undefined && settings[experiment.setting])))
    .map(([name]) => name)
  for (const name of woken) options.want(name)
  return woken
}

/**
 * A Settings ▸ Agents change, written by the core. An experiment whose switch it leaves on is asked for at once, so it
 * acts now (Agent Messages' agents get its note) rather than at its first request or the next start: on one machine
 * neither came, and no agent heard of `harness send` (a fresh Mac, 2026-10-12). Asking again for one already running
 * changes nothing. A tab's own switch, which older windows still write, decides nothing and wakes nothing.
 */
export async function writeAgentSettingsAndWake<T extends { status: number; body: Record<string, unknown> }>(
  write: () => Promise<T>, experiments: Experiments, want: (service: string) => void,
): Promise<T> {
  const result = await write()
  if (result.status >= 200 && result.status < 300) {
    for (const [name, experiment] of Object.entries(experiments)) if (experiment.setting && result.body[experiment.setting] === true) want(name)
  }
  return result
}

/**
 * The account's notices the backend announces (`desk_changed`, …), for the experiments that hear them: each
 * listener in this process (`core.account.onNotice`), guarded, and each experiment's process (`tell`). Agent
 * Messages reads its tabs again at `desk_changed`.
 */
export function createAccountNotices(tell: (notice: BackendNotice) => void, log: (line: string) => void = (line) => console.warn(line)) {
  const listeners = new Set<(notice: BackendNotice) => void>()
  return {
    onNotice(listener: (notice: BackendNotice) => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notice(notice: BackendNotice): void {
      for (const listener of listeners) {
        try { listener(notice) } catch (error) { log(`[experiments] a notice's listener failed · ${error instanceof Error ? error.message : String(error)}`) }
      }
      tell(notice)
    },
  }
}

/**
 * What the core does for the experiments as a whole: ask the master for one (`want`), and hand the account's
 * notices to the listeners here and to each experiment in its own process.
 */
export function createExperimentHooks(deps: {
  want: (service: string) => void
  notify: (service: string, frame: { type: string; payload: Record<string, unknown> }) => boolean
  outOfProcess: ReadonlySet<string>
  experiments: Iterable<string>
  log?: (line: string) => void
}) {
  const notices = createAccountNotices((notice) => {
    for (const name of deps.experiments) if (deps.outOfProcess.has(name)) deps.notify(name, { type: 'service_event', payload: { kind: 'notice', notice } })
  }, deps.log)
  return {
    want: deps.want,
    onNotice: notices.onNotice,
    notice: notices.notice,
  }
}
