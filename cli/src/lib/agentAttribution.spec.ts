import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_ATTRIBUTION_LINE, startedByAgentArgs } from './agentAttribution.js'
import { writeAgentSettings } from './agentSettings.js'

let dataDir = ''
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'agent-attribution-')) })
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

/** A Claude Code launch that reads no settings: nothing the person set, so Claude Code's own line and ours. */
const place = { cwd: null, read: () => null }
const claudeArgs = ['--settings', JSON.stringify({ attribution: { pr: `🤖 Generated with [Claude Code](https://claude.com/claude-code)\n${AGENT_ATTRIBUTION_LINE}` } })]

describe('the pull request line of a harness another agent started', () => {
  it('is the line the owner chose', () => {
    expect(AGENT_ATTRIBUTION_LINE).toBe('🤝 Started by another agent in [Harness](https://harness.autonomous.ai) — agents that run agents.')
  })

  it('is given to a harness another agent started, and not to the person\'s', () => {
    expect(startedByAgentArgs('claude', 'agent', place, dataDir)).toEqual(claudeArgs)
    expect(startedByAgentArgs('claude', null, place, dataDir)).toEqual([])
    expect(startedByAgentArgs('claude', undefined, place, dataDir)).toEqual([])
  })

  it('is not given once the person turned it off, and nothing is read for it; on again, it is', () => {
    writeAgentSettings(dataDir, { pullRequestLine: false })
    expect(startedByAgentArgs('claude', 'agent', { cwd: '/w', read: () => { throw new Error('read nothing') } }, dataDir)).toEqual([])
    // Turning agents starting agents off is another setting: the line follows its own.
    writeAgentSettings(dataDir, { pullRequestLine: true, agentsStartAgents: false })
    expect(startedByAgentArgs('claude', 'agent', place, dataDir)).toEqual(claudeArgs)
  })
})
