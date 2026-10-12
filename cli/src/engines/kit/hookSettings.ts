/**
 * The one installer of the engines' declared hook settings (facets/hooks.ts `HookSettings`): Harness's block
 * merged into the settings file an engine reads its hooks from, every other block left as it was.
 *
 * It runs eagerly before launch. Unknown files are held, foreign commands are
 * preserved, and hook and approval destinations are inspected before publication.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { env } from '../../config/env.js'
import { HARNESS_AGENT_VERBS, type HookSettings } from '../facets/hooks.js'
import { prepareReviewed } from './hookReview.js'
import { managedNodePath } from '../../lib/nodeRuntime.js'
import { isMessagesBlock, messagesCommand, writeMessagesHook } from './messagesHook.js'
import { command, HOOK_SCRIPT, isOurs, foreignHookBlocks, type Settings } from './notifyHooks.js'
import { HookPreparationHeld, inspectHookFile, runHookPreparation, type HookPreparationAttempt } from './nativeHookFiles.js'
import type { NativeHookOptions } from './nativeLocations.js'

/** The engines whose hooks run the notify.mjs command. */
export type HookEngine = Parameters<typeof command>[1]

/** The home an engine's settings are in when core names none. */
export function defaultHookHome(settings: HookSettings): string {
  return 'setting' in settings.home ? env[settings.home.setting] : join(homedir(), settings.home.inHome)
}

export async function installHookSettings(engine: HookEngine, settings: HookSettings, port: number, home: string = defaultHookHome(settings), options: NativeHookOptions = {}): Promise<boolean> {
  const files = [join(home, settings.file), ...(settings.reviewed ? [join(home, settings.reviewed.file)] : [])]
  const cmd = command(port, engine, settings.commandNamesHome ? home : undefined, undefined, options.environment)
  // A startup refresh and a launch share the entire installation. Releasing the
  // reservation between notify and Messages let each revoke the other's second
  // stage, so a healthy launch could be held by the daemon's own refresh.
  try {
    return await runHookPreparation(files, async attempt => {
      await installNotifyHooks(engine, settings, port, home, options, attempt)
      const required = files.map(file => inspectHookFile(file))
      const verifyRequired = () => { attempt.verify(); for (const file of required) file.verify() }
      if (settings.inbox || settings.allow) await installMessagesBlock(settings, home, attempt, verifyRequired)
      return true
    }, { ...options, identity: JSON.stringify([engine, settings, port, home, cmd, env.HARNESS_AGENT_MESSAGES_DIR]) })
  } catch (err) {
    console.error(settings.messages.failed.replace(/\{(file|script|port)\}/g, (_, name: string) =>
      name === 'file' ? files[0] : name === 'script' ? HOOK_SCRIPT : String(port)), err)
    return false
  }
}

/**
 * Agent Messages' block (kit/messagesHook.ts) in the engine's settings: exactly one, in its event, running the
 * current command, every other block as it was; its script beside the inboxes; and for Codex, the block
 * recorded as reviewed like Harness's others. Harness's allowance goes in the same write where it is a list in
 * the same file, or in its own rules file. It shares their reservation and deadline. An optional failure is
 * harmless only while the required hooks remain exactly as confirmed; an uncertain partial write holds launch.
 * A message can still reach an idle agent, typed, and a command not allowed asks, as before.
 */
async function installMessagesBlock(settings: HookSettings, home: string, attempt: HookPreparationAttempt, verifyRequired: () => void): Promise<void> {
  const file = join(home, settings.file)
  const root = env.HARNESS_AGENT_MESSAGES_DIR
  const inboxCommand = messagesCommand(root)
  const { inbox, allow } = settings
  let blockChanged = inbox !== undefined
  try {
    verifyRequired()
    const observed = inspectHookFile(file)
    const current = (observed.content === null ? {} : JSON.parse(observed.content)) as Settings
    if (!current || typeof current !== 'object' || Array.isArray(current) || !current.hooks || typeof current.hooks !== 'object'
      || Array.isArray(current.hooks) || (inbox && current.hooks[inbox.event] !== undefined && !Array.isArray(current.hooks[inbox.event]))) {
      throw new HookPreparationHeld('the hook settings do not have the declared object shape')
    }
    let allowed = false
    if (allow && 'list' in allow) for (const rule of harnessRules(allow.rules)) allowed = withRule(current, allow.list, rule, allow.unless) || allowed
    if (inbox) {
      const blocks = current.hooks[inbox.event] ?? []
      const ours = blocks.filter(isMessagesBlock)
      blockChanged = ours.length !== 1 || ours[0].matcher !== undefined || ours[0].hooks?.length !== 1
        || ours[0].hooks[0]?.command !== inboxCommand || ours[0].hooks[0]?.timeout !== settings.timeout
      current.hooks[inbox.event] = [...foreignHookBlocks(blocks, isMessagesBlock), { hooks: [{ type: 'command', command: inboxCommand, timeout: settings.timeout }] }]
    }
    const changed = allowed || blockChanged
    const next = changed ? JSON.stringify(current, null, 2) + '\n' : observed.content!
    const reviewed = settings.reviewed ? prepareReviewed(settings.reviewed, home, file, JSON.parse(next) as Settings) : null
    reviewed?.verify()
    const published = await observed.replace(next, attempt)
    const approval = await reviewed?.commit(attempt)
    published.verify(); approval?.verify()
    if (inbox) writeMessagesHook(root)
  } catch (err) {
    const reason = err instanceof Error ? err.message : err
    if (blockChanged) console.warn(`[hooks] Agent Messages' hook not installed in ${file} (messages reach its agents once they are idle):`, reason)
    else {
      // The hook was already in place and only the allowance was refused (a read-only file): its script is
      // still kept current, and the log names what failed rather than calling the hook missing.
      console.warn(`[hooks] could not allow Harness's agent commands in ${file} (the engine asks before each one):`, reason)
      if (inbox) try { writeMessagesHook(root) } catch { /* the hook runs nothing it cannot find; messages wait for idle */ }
    }
    verifyRequired()
  }
  if (allow && 'file' in allow) {
    // Each path written as a Starlark string's contents: the file's rules are `prefix_rule(pattern=["…"])`.
    try { writeRulesFile(join(home, allow.file), harnessRules(allow.rules, (path) => JSON.stringify(path).slice(1, -1)).join('\n')) } catch (err) {
      console.warn(`[hooks] could not allow Harness's agent commands in ${join(home, allow.file)} (the engine asks before each one):`, err instanceof Error ? err.message : err)
    }
  }
}

/**
 * The declared rules as this computer has them (facets/hooks.ts HarnessAllowance): its paths in place of
 * `{launcher}`, `{node}` and `{cli}`, one rule for each agent verb in place of `{verb}`, and every verb as one
 * Starlark list in place of `{verbs}`.
 */
function harnessRules(rules: readonly string[], quote: (path: string) => string = (path) => path): string[] {
  const paths: Record<string, string> = {
    launcher: join(env.HARNESS_BIN_DIR, 'harness'), node: managedNodePath(), cli: join(env.ADAPTER_CLI_DIR, 'cli.js'),
  }
  const verbs = `[${HARNESS_AGENT_VERBS.map((verb) => JSON.stringify(verb)).join(', ')}]`
  return rules.flatMap((rule) => rule.includes('{verb}') ? HARNESS_AGENT_VERBS.map((verb) => rule.split('{verb}').join(verb)) : [rule])
    .map((rule) => rule.replace(/\{(launcher|node|cli|verbs)\}/g, (_, name: string) => name === 'verbs' ? verbs : quote(paths[name])))
}

/**
 * Add `rule` to the list at `[table, list]` (`permissions.allow`), creating what is missing and keeping every
 * other rule. A shape Harness does not know is left as it is: the person's rules are never rewritten to fit.
 * Not where the person put the same rule in one of the `unless` lists (`deny`, `ask`): the engine ranks theirs
 * first anyway, and an allow beside it would only read as Harness overruling them.
 */
function withRule(settings: Settings, [table, list]: readonly [string, string], rule: string, unless: readonly string[] = []): boolean {
  const at = settings[table] ?? {}
  if (!at || typeof at !== 'object' || Array.isArray(at)) return false
  const lists = at as Record<string, unknown>
  const rules = lists[list] ?? []
  if (!Array.isArray(rules) || rules.includes(rule)) return false
  if (unless.some((name) => Array.isArray(lists[name]) && (lists[name] as unknown[]).includes(rule))) return false
  settings[table] = { ...at, [list]: [...rules, rule] }
  return true
}

/** The head of Harness's rules file: what it is for, and that Harness keeps it. */
const RULES_HEADER = `# Written by Harness, which rewrites it: do not edit. Its agent commands (harness ${HARNESS_AGENT_VERBS.join(', ')})\n`
  + "# need Harness's daemon, which Codex's sandbox cannot reach, so they run outside it without asking. What each\n"
  + '# may do is for Harness to decide: Settings > Agents, and an agent gives work to and closes only what it started.\n'

/** A rules file Harness owns whole: written atomically, and only when it does not already say exactly this. */
function writeRulesFile(file: string, rules: string): void {
  const text = `${RULES_HEADER}${rules}\n`
  try { if (readFileSync(file, 'utf8') === text) return } catch { /* not written yet */ }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, file)
}

async function installNotifyHooks(engine: HookEngine, settings: HookSettings, port: number, home: string, options: NativeHookOptions, attempt: HookPreparationAttempt): Promise<boolean> {
  const file = join(home, settings.file)
  const cmd = command(port, engine, settings.commandNamesHome ? home : undefined, undefined, options.environment)
  const say = (line: string): string => line.replace(/\{(file|script|port)\}/g, (_, name: string) =>
    name === 'file' ? file : name === 'script' ? HOOK_SCRIPT : String(port))
  const { messages } = settings
  const observed = inspectHookFile(file)
  const current = (observed.content === null ? {} : JSON.parse(observed.content)) as Settings
  if (!current || typeof current !== 'object' || Array.isArray(current)
    || (current.hooks !== undefined && (!current.hooks || typeof current.hooks !== 'object' || Array.isArray(current.hooks)))) {
    throw new HookPreparationHeld('the hook settings do not have the declared object shape')
  }
  current.hooks ??= {}
  let changed = false
  let updated = false // true when an EXISTING block's command changed (path/port drift)

  for (const { event, matcher } of settings.events) {
    if (current.hooks[event] !== undefined && !Array.isArray(current.hooks[event])) throw new HookPreparationHeld('a hook event is not a list')
    const blocks = current.hooks[event] ?? []
    // Collapse any duplicate "ours" blocks (e.g. from an earlier path) down to a single one, and keep every
    // non-ours block untouched.
    const foreign = foreignHookBlocks(blocks)
    const ours = blocks.filter(isOurs)
    if (ours.length !== 1) changed = true // none yet, or duplicates to drop
    const existing = ours[0]
    if (existing) {
      // A prior block with a different command (moved checkout / dev↔dist / changed port / interpreter) is
      // overwritten in place by the canonical one below.
      const existingCmd = settings.upToDate.command === 'first-ours'
        ? existing.hooks?.find((h) => isOurs({ hooks: [h] }))?.command
        : existing.hooks?.[0]?.command
      if (existingCmd !== cmd) { changed = true; updated = true }
      if (settings.upToDate.matcher && existing.matcher !== matcher) changed = true
    }
    current.hooks[event] = [...foreign, { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd, timeout: settings.timeout }] }]
  }

  const next = changed ? JSON.stringify(current, null, 2) + '\n' : observed.content!
  const reviewed = settings.reviewed ? prepareReviewed(settings.reviewed, home, file, JSON.parse(next) as Settings) : null
  reviewed?.verify()
  if (!changed) {
    const published = await observed.replace(next, attempt)
    console.log(say(messages.current))
    // Installed by an earlier start, or by a release before the engine asked: recorded now, as the file has it.
    const approval = await reviewed?.commit(attempt)
    published.verify(); approval?.verify()
    return true
  }

  const published = await observed.replace(next, attempt)
  console.log(say(updated && messages.updated ? messages.updated : messages.installed))
  console.log(say(messages.after))
  const approval = await reviewed?.commit(attempt)
  published.verify(); approval?.verify()
  return true
}
