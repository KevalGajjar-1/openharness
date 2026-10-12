import { describe, expect, it } from 'vitest'
import { NOT_RUNNING, SANDBOXED, sandboxed, unreachableText } from './unreachable.js'

const errno = (code: string) => Object.assign(new Error(code), { code })
const refused = (code: string) => () => { throw errno(code) }

/** A sandbox (Codex's on macOS) kept a running Harness out of reach, and an agent was told to start it (2026-10-12). */
describe('a daemon this shell cannot reach', () => {
  it('is out of a sandbox\'s reach when the connection or the file was not permitted', () => {
    expect(sandboxed({ error: errno('EPERM'), env: {} })).toBe(true)
    expect(sandboxed({ error: errno('EACCES'), env: {} })).toBe(true)
    expect(sandboxed({ error: errno('ECONNREFUSED'), env: {} })).toBe(false)
    expect(sandboxed({ error: 'not an error', env: {} })).toBe(false)
  })

  it('is in a sandbox when Codex says so, or when even asking whether its process lives is not permitted', () => {
    expect(sandboxed({ env: { CODEX_SANDBOX: 'seatbelt' } })).toBe(true)
    expect(sandboxed({ env: {}, pid: 42, signal: refused('EPERM') })).toBe(true)
    // No such process: stopped, as before.
    expect(sandboxed({ env: {}, pid: 42, signal: refused('ESRCH') })).toBe(false)
    expect(sandboxed({ env: {}, pid: 42, signal: () => {} })).toBe(false)
    expect(sandboxed({ env: {}, pid: null })).toBe(false)
    // Asked of this process itself, which is alive and may be signalled.
    expect(sandboxed({ env: {}, pid: process.pid })).toBe(false)
  })

  it('is told to run its command outside the sandbox, never to start Harness', () => {
    expect(unreachableText({ error: errno('EPERM'), env: {} })).toBe(SANDBOXED)
    expect(SANDBOXED).not.toMatch(/harness start/)
    expect(unreachableText({ error: errno('ECONNREFUSED'), env: {} })).toBe(NOT_RUNNING)
    expect(NOT_RUNNING).toMatch(/harness start/)
    expect(unreachableText({ env: { ...process.env, CODEX_SANDBOX: '' } })).toBe(NOT_RUNNING)
  })
})
