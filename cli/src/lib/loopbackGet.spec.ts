import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { loopbackGet } from './loopbackGet.js'

/** The replay of a caught sign-in: the program's status, or why it could not be reached. */
let server: http.Server | null = null
afterEach(() => new Promise<void>((done) => { if (server) server.close(() => done()); else done(); server = null }))

function listen(handler: http.RequestListener): Promise<number> {
  server = http.createServer(handler)
  return new Promise((done) => server!.listen(0, '127.0.0.1', () => done((server!.address() as AddressInfo).port)))
}

describe('loopbackGet', () => {
  it('answers with the program\'s status, query and all', async () => {
    let seen = ''
    const port = await listen((request, response) => { seen = request.url ?? ''; response.writeHead(302, { location: 'https://x.test/done' }).end() })
    expect(await loopbackGet(`http://127.0.0.1:${port}/callback?code=c&state=s`)).toBe(302)
    expect(seen).toBe('/callback?code=c&state=s')
  })

  it('fails when nothing listens, or nothing answers in time', async () => {
    const port = await listen(() => { /* never answers */ })
    await expect(loopbackGet(`http://127.0.0.1:${port}/callback`, 50)).rejects.toThrow('did not answer')
    server!.closeAllConnections()
    await new Promise<void>((done) => server!.close(() => done()))
    server = null
    await expect(loopbackGet(`http://127.0.0.1:${port}/callback`)).rejects.toThrow()
  })
})
