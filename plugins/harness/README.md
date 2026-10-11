# Harness plugin for Claude Code and Codex

Lets a coding agent use [Harness](https://harness.autonomous.ai/agents): start Claude Code, Codex and other agents
as harnesses the person can watch, wait for them, read their answers, message them and close them.

It holds two things:

- `skills/harness/SKILL.md`: the `harness` skill, in the [Agent Skills](https://agentskills.io) format. When to use
  Harness instead of your own sub-agents, the commands, and the rules.
- `.mcp.json`: Harness's MCP server, `harness mcp` over stdio.

Both need the Harness CLI on the agent's `PATH`:

```
curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash
harness start
```

## Install

Claude Code:

```
/plugin marketplace add autonomous-ai/openharness
/plugin install harness@openharness
```

Codex:

```
codex plugin marketplace add autonomous-ai/openharness
codex plugin add harness@openharness
```

The marketplace is [`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json) at the root of this
repository; Codex reads the same file. Any other agent that reads `SKILL.md` can take the skill alone: copy
`skills/harness/` into its skills folder (`~/.agents/skills/` for Codex, `~/.claude/skills/` for Claude Code).

## Changing it

The skill describes commands agents run as written, so change it with the CLI (`cli/src/agentClient/`,
`cli/src/lib/newCommand.ts`) and with the pages that say the same: `website/public/agents/index.html` and
`website/public/llms.txt`. Check the plugin with `claude plugin validate .` from the repository root.

The plugin has no `version`, so an install tracks the commit it came from and `claude plugin update` picks up
changes on `main`.
