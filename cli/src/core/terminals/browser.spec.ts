import { describe, expect, it, vi } from 'vitest'
import { CALLBACK_FOR_MS, createBrowser, type BrowserDeps } from './browser.js'

/** A page opened from a harness's pane goes to the phone that typed there last; the sign-in it returns from
 *  is replayed to the program waiting on this computer, and nothing else is. */
const CLAUDE = 'https://claude.com/cai/oauth/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A35391%2Fcallback&state=s1'

function setup(over: Partial<BrowserDeps> = {}) {
  let now = 1_000
  const deps: BrowserDeps = {
    agentOfPane: vi.fn((pane: string) => (pane === '%7' ? 'a1' : undefined)),
    sendTo: vi.fn(() => true),
    isLocal: vi.fn((connId: string) => connId.startsWith('local:')),
    // A phone's key: `phone-1` reconnects as `phone-1b`.
    who: (connId: string) => connId.replace(/b$/, ''),
    replay: vi.fn(async () => 200),
    now: () => now,
    log: vi.fn(),
    ...over,
  }
  const browser = createBrowser(deps)
  return { deps, browser, later: (ms: number) => { now += ms } }
}

describe('browser_open', () => {
  it('goes to the phone that typed last, sealed to it', () => {
    const { deps, browser } = setup()
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    expect(browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: true })
    expect(deps.sendTo).toHaveBeenCalledWith('phone-1', 'browser_open', { agentId: 'a1', url: CLAUDE })
  })

  it('stays on this computer when the person typed here, from a desktop, or nobody typed yet', () => {
    const { deps, browser } = setup()
    expect(browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: false })
    browser.typed('a1', { connId: 'local:w', kind: 'phone' })
    expect(browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: false })
    browser.typed('a1', { connId: 'remote-desk', kind: 'desktop' })
    expect(browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: false })
    browser.typed('a1', { connId: 'remote-old', kind: null })
    expect(browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: false })
    expect(deps.sendTo).not.toHaveBeenCalled()
  })

  it('stays here for a pane no harness owns, a page that is not one, or a phone gone', () => {
    const { browser } = setup({ sendTo: vi.fn(() => false) })
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    expect(browser.open({ pane: '%9', url: CLAUDE })).toEqual({ handled: false })
    expect(browser.open({ url: CLAUDE })).toEqual({ handled: false })
    expect(browser.open({ pane: '%7', url: 'not a url' })).toEqual({ handled: false })
    expect(browser.open({ pane: '%7' })).toEqual({ handled: false })
    expect(browser.open({ pane: '%7', url: 'file:///etc/passwd' })).toEqual({ handled: false })
    expect(browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: false })
  })
})

describe('browser_callback', () => {
  it('replays the caught redirect to the waiting program, once', async () => {
    const { deps, browser } = setup()
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    browser.open({ pane: '%7', url: CLAUDE })
    const caught = 'http://localhost:35391/callback?code=c1&state=s1'
    // Back from the browser the phone is on a new connection: it is the same phone.
    expect(await browser.callback({ url: caught }, 'phone-1b')).toEqual({ ok: true, status: 200 })
    expect(deps.replay).toHaveBeenCalledWith('http://127.0.0.1:35391/callback?code=c1&state=s1')
    expect(await browser.callback({ url: caught }, 'phone-1')).toEqual({ error: 'NOT_EXPECTED' })
  })

  it('says when the program refused it or could not be reached', async () => {
    const { browser, deps } = setup({ replay: vi.fn().mockResolvedValueOnce(400).mockRejectedValueOnce(new Error('ECONNREFUSED')).mockRejectedValueOnce('gone') })
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    browser.open({ pane: '%7', url: CLAUDE })
    browser.open({ pane: '%7', url: CLAUDE })
    expect(await browser.callback({ url: 'http://127.0.0.1:35391/callback?code=x' }, 'phone-1')).toEqual({ ok: false, status: 400 })
    expect(await browser.callback({ url: 'http://127.0.0.1:35391/callback?code=x' }, 'phone-1')).toEqual({ error: 'NOT_DELIVERED' })
    browser.open({ pane: '%7', url: CLAUDE })
    expect(await browser.callback({ url: 'http://127.0.0.1:35391/callback?code=x' }, 'phone-1')).toEqual({ error: 'NOT_DELIVERED' })
    // The log says what happened and where, never the code.
    expect(deps.log).toHaveBeenCalledWith('[browser] sign-in not handed to the program on port 35391: ECONNREFUSED')
    expect(deps.log).toHaveBeenCalledWith('[browser] sign-in not handed to the program on port 35391: gone')
    expect(JSON.stringify(vi.mocked(deps.log).mock.calls)).not.toContain('code=')
    expect(await browser.callback({ url: 'http://localhost/callback?code=x' }, 'phone-1')).toEqual({ error: 'NOT_EXPECTED' })
    expect(deps.log).toHaveBeenLastCalledWith('[browser] a sign-in on port ? was refused: no page sent to that phone waits there')
  })

  it('refuses any other port, path, scheme, host or phone, and a redirect left too long', async () => {
    const { deps, browser, later } = setup()
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    browser.open({ pane: '%7', url: CLAUDE })
    // A page that returns nowhere on this computer leaves nothing to replay.
    browser.open({ pane: '%7', url: 'https://github.com/login/device' })
    browser.open({ pane: '%7', url: 'https://x.test/a?redirect_uri=https%3A%2F%2Fx.test%2Fcb' })
    browser.open({ pane: '%7', url: 'https://x.test/a?redirect_uri=http%3A%2F%2Flocalhost%2Fcb' })
    browser.open({ pane: '%7', url: 'https://x.test/a?redirect_uri=%25' })
    for (const url of [
      'http://localhost:22/callback?code=c',
      'http://localhost:35391/admin?code=c',
      'https://localhost:35391/callback?code=c',
      'http://example.com:35391/callback?code=c',
      'nonsense',
    ]) expect(await browser.callback({ url }, 'phone-1')).toEqual(url === 'nonsense' ? { error: 'BAD_URL' } : { error: 'NOT_EXPECTED' })
    expect(await browser.callback({}, 'phone-1')).toEqual({ error: 'BAD_URL' })
    expect(await browser.callback({ url: 'http://localhost:35391/callback?code=c' }, 'phone-2')).toEqual({ error: 'NOT_EXPECTED' })
    later(CALLBACK_FOR_MS + 1)
    expect(await browser.callback({ url: 'http://localhost:35391/callback?code=c' }, 'phone-1')).toEqual({ error: 'NOT_EXPECTED' })
    expect(deps.replay).not.toHaveBeenCalled()
  })
})
