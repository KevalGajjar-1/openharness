/** Capacity evidence uses real metadata but no host services or binaries. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createNativeHookStagePool } from './nativeHookStaging.js'

// This measures bounded recovery/final-fence CPU and filesystem reads. Actual
// flush lifetime and crash behavior are covered separately with OS processes.
const opened = vi.hoisted(() => new Set<string>())
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs,
  fsync: (_fd: number, done: (error: Error | null) => void) => queueMicrotask(() => done(null)),
  opendirSync: (path: string, options: Parameters<typeof fs.opendirSync>[1]) => { opened.add(path); return fs.opendirSync(path, options) },
} })
let root: string | undefined
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

it('recovers the last available generation and measures its complete final fence', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hook-staging-capacity-')))
  const writer = { boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', pid: 8100, birth: '12345' }
  const makePool = () => createNativeHookStagePool({ root: root!, writer, dead: async () => false })
  const first = await makePool().acquire(); await first.close()
  const directory = join(root, '.native-hook-stage-0'), witnesses = directory + '.witnesses'
  const initial = JSON.parse(readlinkSync(join(witnesses, '00000000.claim')))
  const seed = (history: string, liveLast = false) => {
    for (let generation = 1; generation < 8_191; generation++) {
      const prefix = String(generation).padStart(8, '0')
      const text = JSON.stringify([...initial.slice(0, 4), randomUUID()])
      const released = JSON.stringify([1, createHash('sha256').update(text).digest('hex')])
      for (const parent of [history, history + '.witnesses']) {
        symlinkSync(text, join(parent, prefix + '.claim'))
        if (!liveLast || generation < 8_190) symlinkSync(released, join(parent, prefix + '.release'))
      }
    }
  }
  seed(directory)
  let lastPulse = performance.now(), maxGapMs = 0, pulses = 0
  const pulse = setInterval(() => {
    const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - lastPulse); lastPulse = now; pulses++
  }, 1)
  const began = performance.now()
  try {
    const lease = await makePool().acquire()
    const recoveryMs = performance.now() - began, fenceStart = performance.now()
    lease.verify()
    const fenceMs = performance.now() - fenceStart, stage = lease.stage(join(root, 'receipt'))
    expect(stage.path).toContain('.native-hook-stage-0/00008191.')
    expect(pulses).toBeGreaterThan(1)
    await stage.finish(); await lease.close()
    process.stdout.write(JSON.stringify({ generations: 8_192, recoveryMs, fenceMs, maxGapMs }) + '\n')
  } finally { clearInterval(pulse) }
  // A full lane and another long, live history cannot starve a later free lane.
  const busy = await makePool().acquire(); await busy.close()
  const busyDirectory = join(root, '.native-hook-stage-1'); seed(busyDirectory, true)
  const before = [directory, busyDirectory].map(path => readdirSync(path).sort())
  opened.clear()
  const beganFreeLane = performance.now(), free = await makePool().acquire()
  const freeLaneAfterFullAndLiveMs = performance.now() - beganFreeLane
  const freeStage = free.stage(join(root, 'next'))
  expect(freeStage.path).toContain('.native-hook-stage-2/')
  expect([...opened]).not.toContain(directory)
  expect([...opened]).not.toContain(busyDirectory)
  expect([directory, busyDirectory].map(path => readdirSync(path).sort())).toEqual(before)
  process.stdout.write(JSON.stringify({ freeLaneAfterFullAndLiveMs }) + '\n')
  await freeStage.finish(); await free.close()
}, 30_000)
