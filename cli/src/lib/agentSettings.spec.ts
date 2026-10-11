import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_SETTING_NAMES, agentSettingsPath, readAgentSettings, writeAgentSettings } from './agentSettings.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agent-settings-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('what the person lets agents do', () => {
  it('lets agents start agents until the person turns it off', () => {
    expect(readAgentSettings(dir)).toEqual({ agentsStartAgents: true, pullRequestLine: true })
    expect(writeAgentSettings(dir, { agentsStartAgents: false })).toEqual({ agentsStartAgents: false, pullRequestLine: true })
    expect(readAgentSettings(dir)).toEqual({ agentsStartAgents: false, pullRequestLine: true })
    expect(JSON.parse(readFileSync(agentSettingsPath(dir), 'utf8'))).toEqual({ version: 1, agentsStartAgents: false, pullRequestLine: true })
    expect(statSync(agentSettingsPath(dir)).mode & 0o777).toBe(0o600)
    expect(AGENT_SETTING_NAMES['agents-start-agents']).toBe('agentsStartAgents')
  })

  it('adds a line to the pull requests of a harness another agent started until the person turns it off', () => {
    expect(writeAgentSettings(dir, { pullRequestLine: false })).toEqual({ agentsStartAgents: true, pullRequestLine: false })
    expect(readAgentSettings(dir).pullRequestLine).toBe(false)
    // A file written before the setting existed: the default for it, and the other kept.
    writeFileSync(agentSettingsPath(dir), '{"version":1,"agentsStartAgents":false}')
    expect(readAgentSettings(dir)).toEqual({ agentsStartAgents: false, pullRequestLine: true })
    expect(AGENT_SETTING_NAMES['pull-request-line']).toBe('pullRequestLine')
  })

  it('applies only booleans it knows, and reads a broken file as the defaults', () => {
    expect(writeAgentSettings(dir, null)).toBeNull()
    expect(writeAgentSettings(dir, 'off')).toBeNull()
    expect(writeAgentSettings(dir, { agentsStartAgents: 'no', other: true })).toBeNull()
    expect(writeAgentSettings(dir, { agentsStartAgents: false, other: true })).toEqual({ agentsStartAgents: false, pullRequestLine: true })
    writeFileSync(agentSettingsPath(dir), '{"agentsStartAgents": "nope", "pullRequestLine": 0}')
    expect(readAgentSettings(dir)).toEqual({ agentsStartAgents: true, pullRequestLine: true })
    writeFileSync(agentSettingsPath(dir), 'not json')
    expect(readAgentSettings(dir)).toEqual({ agentsStartAgents: true, pullRequestLine: true })
  })
})
