/**
 * Why this shell cannot reach the daemon, in words for the person or the agent that asked.
 *
 * A sandbox keeps a command from the daemon's socket and port, and even from the signal that asks whether its
 * process is alive (EPERM). Codex runs an agent's commands in one on macOS. Harness told such an agent "Harness is
 * not running here. Start it with `harness start`": it ran `harness start`, which crashed on the spawn lock, then
 * asked the person "May I start the Harness adapter?" while Harness was running all along (a fresh Mac, 2026-10-12).
 */

export const NOT_RUNNING = 'Harness is not running here. Start it with `harness start`.'
export const SANDBOXED = 'Harness is running, but a sandbox keeps this shell from reaching it (Codex runs commands in one). '
  + 'Run this harness command outside the sandbox. Harness needs no starting.'

export interface SandboxEvidence {
  /** What failed: a connection's or a file's error. */
  error?: unknown
  /** The daemon's pid, as its pid file names it. */
  pid?: number | null
  env?: NodeJS.ProcessEnv
  signal?: (pid: number, signal: 0) => void
}

/** Whether a sandbox, not a stopped daemon, is what this shell runs into. */
export function sandboxed({ error, pid = null, env = process.env, signal = (p, s) => { process.kill(p, s) } }: SandboxEvidence = {}): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EPERM' || code === 'EACCES') return true
  // Codex marks every command it runs in its sandbox.
  if (env.CODEX_SANDBOX) return true
  if (pid === null) return false
  try { signal(pid, 0); return false } catch (failure) { return (failure as NodeJS.ErrnoException).code === 'EPERM' }
}

/** What to say when the daemon cannot be reached. */
export function unreachableText(evidence: SandboxEvidence = {}): string {
  return sandboxed(evidence) ? SANDBOXED : NOT_RUNNING
}
