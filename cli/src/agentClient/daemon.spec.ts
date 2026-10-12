import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { openDaemon, type ClientSocket } from './daemon.js'
import { NOT_RUNNING, SANDBOXED } from '../lib/unreachable.js'

/** A socket whose connection fails with [code], as Codex's sandbox refuses the daemon's (2026-10-12). */
function failing(code: string): ClientSocket {
  const socket = new EventEmitter() as unknown as ClientSocket
  setImmediate(() => (socket as unknown as EventEmitter).emit('error', Object.assign(new Error(code), { code })))
  return socket
}

describe('a line to the daemon that cannot open', () => {
  const where = { port: 18473, dataDir: '/nowhere', machineId: 'm1' }

  it('says a sandbox keeps it out when the connection was not permitted, and never to start Harness', async () => {
    await expect(openDaemon(where, 'm1', () => failing('EPERM'))).rejects.toMatchObject({ code: 'DAEMON_UNREACHABLE', message: SANDBOXED })
  })

  it('says to start Harness when nothing answers', async () => {
    const saved = process.env.CODEX_SANDBOX
    delete process.env.CODEX_SANDBOX
    try {
      const error = await openDaemon(where, 'm1', () => failing('ECONNREFUSED')).catch((e: unknown) => e)
      expect([NOT_RUNNING, SANDBOXED]).toContain((error as Error).message)
      expect(error).toMatchObject({ code: 'DAEMON_UNREACHABLE' })
    } finally { if (saved !== undefined) process.env.CODEX_SANDBOX = saved }
  })
})
