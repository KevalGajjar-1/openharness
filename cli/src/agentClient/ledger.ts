/**
 * Who started which harness (docs/design/2026-10-11-agent-client.md, "Who started it"): one line per harness an
 * agent started with `harness new`, appended by the CLI to the data folder of the daemon that owns the agent's
 * pane. A harness with no line was started by the person.
 *
 * Read by `harness ps` (who started each), by `new` and `stop` (limits, and which harnesses an agent may stop),
 * and by Agent Messages, which lets a harness and the harnesses it started message each other without a tab.
 * Like Agent Messages it is a collaboration scope, not a sandbox: any process of this user can write the file.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface LedgerMember { machineId: string; agentId: string }
export interface Started {
  at: number
  /** The harness that ran `harness new`. */
  by: LedgerMember & { name: string; engine: string }
  /** The harness it started. */
  child: LedgerMember & { name: string }
  /** 1 for a harness a person's harness started, 2 for one that harness started. */
  depth: number
}

/** The file, in the daemon's data folder. */
export const ledgerPath = (dataDir: string): string => join(dataDir, 'agent-client', 'started.jsonl')

/** Kept lines: the file is rewritten to its newest lines once it passes the size below. */
export const KEEP = 5_000
const COMPACT_BYTES = 2 * 1024 * 1024

const member = (v: unknown): v is LedgerMember => {
  const m = v as Record<string, unknown> | null
  return !!m && typeof m.machineId === 'string' && !!m.machineId && typeof m.agentId === 'string' && !!m.agentId
}

export function parseStarted(line: string): Started | null {
  let v: Record<string, unknown>
  try { v = JSON.parse(line) } catch { return null }
  if (!v || typeof v !== 'object' || typeof v.at !== 'number' || !member(v.by) || !member(v.child)
    || typeof v.depth !== 'number' || v.depth < 1) return null
  const by = v.by as unknown as Record<string, unknown>, child = v.child as unknown as Record<string, unknown>
  return {
    at: v.at,
    by: { machineId: by.machineId as string, agentId: by.agentId as string, name: String(by.name ?? ''), engine: String(by.engine ?? '') },
    child: { machineId: child.machineId as string, agentId: child.agentId as string, name: String(child.name ?? '') },
    depth: v.depth,
  }
}

const same = (a: LedgerMember, b: LedgerMember): boolean => a.machineId === b.machineId && a.agentId === b.agentId

export class Ledger {
  private cache: { mtimeMs: number; size: number; rows: Started[] } | null = null
  constructor(readonly path: string) {}

  /** Every line, oldest first; an unreadable file is an empty one. Read again only when the file changed. */
  all(): Started[] {
    let stat: { mtimeMs: number; size: number }
    try { stat = statSync(this.path) } catch { return [] }
    if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) return this.cache.rows
    let text = ''
    try { text = readFileSync(this.path, 'utf8') } catch { return [] }
    const rows = text.split('\n').flatMap((line) => { const row = line ? parseStarted(line) : null; return row ? [row] : [] })
    this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, rows }
    return rows
  }

  append(row: Started): void {
    mkdirSync(dirname(this.path), { recursive: true })
    // One short line with O_APPEND: two agents starting harnesses at once never interleave.
    appendFileSync(this.path, `${JSON.stringify(row)}\n`, { mode: 0o600 })
    try {
      if (statSync(this.path).size > COMPACT_BYTES) {
        const kept = this.all().slice(-KEEP)
        const tmp = `${this.path}.${process.pid}.tmp`
        writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })
        renameSync(tmp, this.path)
      }
    } catch { /* a file that stays long is only slower to read */ }
  }

  /** The line that says who started [m], or null when the person did. */
  parentOf(m: LedgerMember): Started | null {
    return this.all().findLast((row) => same(row.child, m)) ?? null
  }

  /** The harnesses [m] started, newest last. */
  childrenOf(m: LedgerMember): Started[] {
    return this.all().filter((row) => same(row.by, m))
  }

  /** 0 for a harness the person started. */
  depthOf(m: LedgerMember): number {
    return this.parentOf(m)?.depth ?? 0
  }

  /** Whether one of the two started the other. */
  linked(a: LedgerMember, b: LedgerMember): boolean {
    return this.all().some((row) => (same(row.by, a) && same(row.child, b)) || (same(row.by, b) && same(row.child, a)))
  }

  /** The harnesses [m] may message without a tab: its parent and its children. */
  links(m: LedgerMember): LedgerMember[] {
    const out: LedgerMember[] = []
    for (const row of this.all()) {
      const other = same(row.by, m) ? row.child : same(row.child, m) ? row.by : null
      if (other && !out.some((o) => same(o, other))) out.push({ machineId: other.machineId, agentId: other.agentId })
    }
    return out
  }
}
