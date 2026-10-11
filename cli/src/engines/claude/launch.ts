import type { EngineLaunch } from '../facets/launch.js'

// The existing CLI contracts: auto still runs Claude Code's safety checks; full is explicit.
const permissionModes = {
  auto: ['--permission-mode', 'auto'],
  acceptEdits: ['--permission-mode', 'acceptEdits'],
  plan: ['--permission-mode', 'plan'],
  ask: [],
  full: ['--dangerously-skip-permissions'],
}
export const launch: EngineLaunch = {
  permissionModes, bypassPermission: permissionModes.auto,
  firstPromptArgs: [], resumeArgs: ['--resume'], forkArgs: { lead: ['--resume'], after: ['--fork-session'] },
  instructionFiles: ['CLAUDE.md'],
  contextArgs: { args: ['--append-system-prompt', 'Read the harness context at {file} before working.'], quote: 'json' },
  // Claude Code reads CLAUDE.md, and AGENTS.md only through an import line in it.
  instructionFile: 'CLAUDE.md',
  instructionImport: { file: 'AGENTS.md', line: '@AGENTS.md' },
  /**
   * Claude Code asks "do you trust this folder?" the first time it opens a project, and keeps the answer as
   * `projects[<path>].hasTrustDialogAccepted` in `.claude.json`: in CLAUDE_CONFIG_DIR, else the home folder
   * itself (its own rule, 2.1.290). A yes covers the folders below. Copied from the former lib/claudeTrust.ts.
   */
  trust: {
    home: { variable: 'CLAUDE_CONFIG_DIR', otherwise: 'home' }, file: '.claude.json',
    format: 'json', projects: 'projects', accepted: 'hasTrustDialogAccepted', entry: { allowedTools: [] },
  },
  /**
   * Claude Code's `attribution.pr`: the text it adds to a pull request it opens. Set, it replaces Claude Code's own
   * line, so the value keeps that line first (2.1.296 `rro`: `pr: h.pr ?? <own line>`). `--settings` overrides the
   * person's user, project and local settings key by key (lodash `mergeWith`), so their `attribution.commit` stays.
   * `attribution: false`, a `pr` of "" and the older `includeCoAuthoredBy: false` each hide the line: nothing is added
   * then, and the last would otherwise bring the commit trailer back (setting `pr` ends it).
   */
  attribution: {
    kind: 'setting',
    home: { variable: 'CLAUDE_CONFIG_DIR', otherwise: { folder: '.claude' } }, file: 'settings.json',
    folder: ['.claude/settings.json', '.claude/settings.local.json'],
    key: 'attribution', field: 'pr', legacy: { key: 'includeCoAuthoredBy', until: ['commit', 'pr'] },
    own: '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    args: ['--settings', '{settings}'],
  },
}
