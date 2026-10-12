/**
 * Engines as clean computers have them (fresh macOS 26 and Ubuntu 24.04 VMs, signed out, 2026-10-11), started from a
 * terminal with `harness new`:
 *
 *  - OpenCode 1.19.0 prints its help to standard error. Read from standard output alone, its permission flag was never
 *    confirmed and every launch of it held for good.
 *  - Codex installed by Harness with its own Node is a `#!/usr/bin/env node` script, and such a computer has no `node`
 *    on its PATH. Its probe failed, so every launch held; its pane would have failed the same way.
 *  - A Codex that cannot run at all is refused at once, with its own reason, instead of being held and said only to be
 *    unconfirmed after a minute.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

let daemon: IsolatedDaemon | undefined
afterEach(async () => { await daemon?.close(); daemon = undefined })

/** `harness <args>` from a terminal, not a pane. */
function harness(d: IsolatedDaemon, args: string[]): Promise<{ code: number; out: string; err: string; ms: number }> {
  const began = Date.now()
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => done({ code: code ?? -1, out, err, ms: Date.now() - began }))
  })
}

async function boot(prepare: (d: IsolatedDaemon) => void = () => {}): Promise<IsolatedDaemon> {
  const d = daemon = await IsolatedDaemon.create()
  onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
  prepare(d)
  await d.start()
  return d
}

const project = (d: IsolatedDaemon, name: string) => { const dir = join(d.projectsDir, name); mkdirSync(dir, { recursive: true }); return dir }

it('starts an OpenCode that prints its help to standard error, with its permission flag', async () => {
  const d = await boot((d) => {
    const binary = join(d.root, 'bin', 'opencode'), launches = join(d.root, 'launches.jsonl')
    d.env.OPENCODE_PATH = binary
    d.env.OPENCODE_DATA_DIR = join(d.root, 'opencode', 'data')
    d.env.OPENCODE_PLUGIN_DIR = join(d.root, 'opencode', 'plugin')
    // OpenCode 1.19.0 as measured: `--help` writes 4,285 bytes to standard error, none to standard output, exits 0.
    writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.19.0'); process.exit(0) }
if (args.includes('--help')) { console.error('opencode [project]\\n\\nOptions:\\n      --auto     approve every action\\n      --prompt   prompt to use'); process.exit(0) }
fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ args }) + '\\n');
process.title = ('opencode --session ses_' + process.pid).padEnd(160);
console.log('fixture-opencode-ready');
setInterval(() => {}, 1000);
`, { mode: 0o755 })
  })
  const started = await harness(d, ['new', 'opencode', project(d, 'stderr-help'), '--name', 'helpful', '--', 'hello'])
  expect(started.code, started.out + started.err).toBe(0)
  expect(started.out).toContain('Created helpful on this computer')
  const launch = await until('OpenCode to start', () => {
    const lines = existsSync(join(d.root, 'launches.jsonl')) ? readFileSync(join(d.root, 'launches.jsonl'), 'utf8').trim().split('\n') : []
    return lines[0] ? JSON.parse(lines[0]) as { args: string[] } : null
  }, 30_000, 100)
  expect(launch.args).toContain('--auto')
})

it('runs a Codex that npm installed as a Node script on a computer with no Node of its own', async (context) => {
  // The login shell's PATH below names system folders only; a computer that has a node there is not this case.
  const system = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
  if (system.some((dir) => existsSync(join(dir, 'node')))) context.skip()
  const d = await boot((d) => {
    const bin = join(d.root, 'bin')
    // What `npm install -g @openai/codex` leaves in ~/.local/bin: a script that asks env for a node.
    const engine = pathToFileURL(join(CLI_ROOT, 'e2e', 'harness', 'fakeEngine.mjs')).href
    const wrapper = readFileSync(join(bin, 'codex'), 'utf8').split('\n').slice(1).join('\n')
    expect(wrapper).toContain(engine)
    writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node\n${wrapper}`, { mode: 0o755 })
    // After the system's own startup files, as a person's own .zshrc or .bash_profile would: no node anywhere.
    const path = `export PATH=${[bin, ...system].join(':')}\n`
    writeFileSync(join(d.env.HOME!, '.zshrc'), path)
    writeFileSync(join(d.env.HOME!, '.bash_profile'), path)
  })
  const started = await harness(d, ['new', 'codex', project(d, 'no-node'), '--name', 'nodeless', '--', 'hello'])
  expect(started.code, started.out + started.err).toBe(0)
  expect(started.out).toContain('Created nodeless on this computer')
  // Its pane ran it too: the engine started and bound its conversation.
  const client = await LocalClient.connect(d)
  try {
    await until('Codex to bind its conversation in its pane', async () => {
      const row = ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents).find((a) => a.name === 'nodeless')
      return row?.sessionId && row.status === 'active' ? row : null
    }, 60_000, 500)
  } finally { client.close() }
})

it('refuses at once, with its own reason, a Codex that cannot run, and saves nothing to start later', async () => {
  const d = await boot((d) => {
    writeFileSync(join(d.root, 'bin', 'codex'), `#!${process.execPath}
console.error("node:internal/modules/cjs/loader:1228\\n  throw err;\\n\\nError: Cannot find module '@openai/codex-linux-x64'\\n\\nNode.js v22.20.0");
process.exit(1);
`, { mode: 0o755 })
  })
  const refused = await harness(d, ['new', 'codex', project(d, 'broken'), '--', 'hello'])
  expect(refused.code, refused.out + refused.err).toBe(1)
  expect(refused.err.trim()).toBe('Codex is installed but cannot run: Error: Cannot find module \'@openai/codex-linux-x64\'')
  // Refused, not held for a minute and then called unconfirmed.
  expect(refused.ms).toBeLessThan(30_000)
  const client = await LocalClient.connect(d)
  try {
    expect((await client.request<{ agents: unknown[] }>('agents_list', { includeStopped: true }, 30_000)).agents).toEqual([])
  } finally { client.close() }
})

it('says what a launch still held after a minute waits for, and cancels it so it never starts later', async () => {
  let fixed = ''
  const d = await boot((d) => {
    fixed = join(d.root, 'codex-answers')
    // A Codex whose help never comes: each probe meets its deadline, and the launch is held, asked again every two seconds.
    const wrapper = readFileSync(join(d.root, 'bin', 'codex'), 'utf8').split('\n')
    writeFileSync(join(d.root, 'bin', 'codex'), [wrapper[0],
      `if (process.argv.includes('--help') && !require('node:fs').existsSync(${JSON.stringify(fixed)})) setInterval(() => {}, 1000)`,
      `else ${wrapper.slice(1).join('\n')}`].join('\n'), { mode: 0o755 })
  })
  const held = await harness(d, ['new', 'codex', project(d, 'held'), '--name', 'later', '--', 'hello'])
  expect(held.code, held.out + held.err).toBe(1)
  expect(held.err).toContain('Waiting to confirm the selected executable’s permission flags.')
  expect(held.err.trim().split('\n').at(-1)).toBe('Harness did not start the harness within a minute: '
    + 'Waiting to confirm the selected executable’s permission flags. The request is cancelled, so it will not start later.')
  // Once Codex answers, the cancelled request still does not start.
  writeFileSync(fixed, '')
  await new Promise((done) => setTimeout(done, 8_000))
  const client = await LocalClient.connect(d)
  try {
    expect((await client.request<{ agents: unknown[] }>('agents_list', { includeStopped: true }, 30_000)).agents).toEqual([])
  } finally { client.close() }
}, 180_000)
