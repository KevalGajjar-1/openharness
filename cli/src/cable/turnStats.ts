export interface TurnStatsFields { testsPassed?: number; testsFailed?: number; commits?: number; tokensIn?: number; tokensOut?: number }

type Counts = { passed: number; failed: number }

const num = (s: string | undefined) => (s ? Number(s) : 0)
const count = (line: string, word: string) => num(new RegExp(`(\\d+) ${word}`).exec(line)?.[1])

/** The last test summary in `tail` (vitest, jest, pytest, cargo, mocha, go).
 * Each format reports its match position and the latest position wins, so a
 * summary from an earlier command never beats the one printed last. */
export function parseTestSummary(tail: string): Counts | null {
  let best: { at: number } & Counts | null = null
  const hit = (at: number, passed: number, failed: number) => {
    if (!best || at >= best.at) best = { at, passed, failed }
  }
  for (const m of tail.matchAll(/^[ \t]*Tests:?[ \t]+([^\n]*)/gm)) {
    if (/\d+ (passed|failed)/.test(m[1])) hit(m.index, count(m[1], 'passed'), count(m[1], 'failed'))
  }
  for (const m of tail.matchAll(/^[^\n]*\b\d+ (?:passed|failed)\b[^\n]* in [\d.]+s[^\n]*/gm)) {
    hit(m.index, count(m[0], 'passed'), count(m[0], 'failed'))
  }
  // cargo prints one line per test binary (unit, integration, doc-tests): they add up to one run.
  let cargo = null as ({ at: number } & Counts) | null
  for (const m of tail.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)) {
    cargo = { at: m.index, passed: (cargo?.passed ?? 0) + num(m[1]), failed: (cargo?.failed ?? 0) + num(m[2]) }
  }
  if (cargo) hit(cargo.at, cargo.passed, cargo.failed)
  for (const m of tail.matchAll(/(\d+) passing[^\n]*(?:\n\s*(\d+) failing)?/g)) {
    hit(m.index, num(m[1]), num(m[2]))
  }
  let passed = 0, failed = 0, last = -1
  for (const m of tail.matchAll(/^[ \t]*(ok|FAIL)[ \t]*\t\S+(?:\t|$)/gm)) {
    if (m[1] === 'ok') passed++
    else failed++
    last = m.index
  }
  if (last >= 0) hit(last, passed, failed)
  return best ? { passed: (best as Counts).passed, failed: (best as Counts).failed } : null
}

/** True when `command` runs `git commit` (not `--dry-run`), alone or after `cd …`, `git add …`, `VAR=value`
 * words or git's global options. Only the first line of each `&&`/`||`/`;` part is read, so a heredoc body or
 * a multi-line message is never mistaken for a command. */
export function isGitCommit(command: string): boolean {
  return command.split(/&&|\|\||;/).some((seg) => {
    const line = (seg.split('\n').find((l) => l.trim()) ?? '').slice(0, 1000)
    const words = line.trim().replace(/^\(\s*/, '').replace(/^(?:\w+=\S*\s+)+/, '')
    const m = /^git((?:\s+(?:-[cC]\s+\S+|--[\w-]+(?:=\S*)?|-(?![cC]\s)[\w-]+))*)\s+commit(?:\s|$)(.*)/.exec(words)
    return !!m && !/(?:^|\s)--dry-run(?:\s|$)/.test(m[2].replace(/(["']).*?\1/g, ''))
  })
}

/** A command that runs tests: only its output is read for a summary, so `cat ci.log` counts for nothing. */
const TEST_COMMAND = /\b(test|tests|vitest|jest|pytest|mocha|ctest|run\.sh)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?\S*test/i

interface Acc { tests?: Counts; commits: number }

/** Per-agent accumulator for one turn's shell results. */
export class TurnStats {
  private readonly agents = new Map<string, Acc>()

  private acc(agentId: string): Acc {
    let a = this.agents.get(agentId)
    if (!a) this.agents.set(agentId, a = { commits: 0 })
    return a
  }

  toolResult(agentId: string, command: string | undefined, isError: boolean, outputTail: string): void {
    if (command === undefined) return
    const a = this.acc(agentId)
    if (!isError && isGitCommit(command) && !/nothing to commit/.test(outputTail)) a.commits++
    const tests = TEST_COMMAND.test(command) ? parseTestSummary(outputTail) : null
    if (tests) a.tests = tests
  }

  /** Returns the turn's stats and clears them. Unset fields are omitted. */
  take(agentId: string): TurnStatsFields {
    const a = this.agents.get(agentId)
    this.agents.delete(agentId)
    const out: TurnStatsFields = {}
    if (a?.tests) { out.testsPassed = a.tests.passed; out.testsFailed = a.tests.failed }
    if (a?.commits) out.commits = a.commits
    return out
  }
}
