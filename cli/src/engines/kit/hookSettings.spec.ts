import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { env } from '../../config/env.js'
import { hooks as claude } from '../claude/hookContract.js'
import { hooks as codex } from '../codex/hookContract.js'
import { defaultHookHome, installHookSettings } from './hookSettings.js'
import { HOOK_SCRIPT } from './notifyHooks.js'
import type { HookPreparationProof } from './nativeHookFiles.js'

// What every case writes and logs is engines/hookInstallers.golden.spec.ts; these are the kit's own edges.
let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hook-settings-')) })
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

it('finds an engine\'s home in the person\'s home or in a daemon setting', () => {
  expect(defaultHookHome(claude.settings)).toBe(join(homedir(), '.claude'))
  expect(defaultHookHome(codex.settings)).toBe(env.CODEX_HOME)
})

it.each(['claude', 'codex'] as const)('publishes one current %s proof after both native and Agent Messages blocks', async engine => {
  const settings = engine === 'claude' ? claude.settings : codex.settings
  const home = join(root, engine), proofs: HookPreparationProof[] = []
  expect(await installHookSettings(engine, settings, 19473, home, { onPrepared: proof => { proofs.push(proof) } })).toBe(true)
  expect(proofs).toHaveLength(1)
  expect(proofs[0]!.current()).toBe(true)
  const content = JSON.parse(readFileSync(join(home, settings.file), 'utf8'))
  expect(content.hooks[settings.inbox!.event].some((block: { hooks: { command: string }[] }) => block.hooks.some(hook => hook.command.includes('inbox-hook.mjs')))).toBe(true)
})

it('names a home literally in its log lines, whatever characters the path holds', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  // `$&` and `$1` mean something to String.replace with a string replacement, and {port} to the templates.
  const home = join(root, 'a$&b$1{port}{file}')
  const file = join(home, 'settings.json')
  await installHookSettings('claude', { ...claude.settings, messages: { ...claude.settings.messages, installed: '{file}|{script}|{port}' } }, 19473, home)
  expect(log.mock.calls[0]).toEqual([`${file}|${HOOK_SCRIPT}|19473`])
  expect(JSON.parse(readFileSync(file, 'utf8')).hooks.Stop[0].hooks[0].command).toContain('--port 19473')
})

it('reports a held malformed file even when an engine declares no malformed-file lines', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const home = join(root, 'codex')
  mkdirSync(home)
  writeFileSync(join(home, 'hooks.json'), '{not-json')
  const { malformed: _, ...messages } = codex.settings.messages
  expect(await installHookSettings('codex', { ...codex.settings, messages }, 19473, home)).toBe(false)
  expect(error).toHaveBeenCalledWith(codex.settings.messages.failed, expect.any(SyntaxError))
  expect(readFileSync(join(home, 'hooks.json'), 'utf8')).toBe('{not-json')
})
