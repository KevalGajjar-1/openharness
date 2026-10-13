import { describe, expect, it, vi } from 'vitest'
import { ALONE_STOP_DEADLINE_MS, stopDeadline } from './stopDeadline.js'

function stop(supervised: boolean) {
  const timers: Array<{ fn: () => void; ms: number }> = []
  const exit = vi.fn()
  const log = vi.fn()
  const deadline = stopDeadline({ supervised, exit, log, setTimer: (fn, ms) => timers.push({ fn, ms }) })
  return { timers, exit, log, deadline }
}

describe('a core\'s stop', () => {
  it('keeps the master\'s grace on itself when it runs alone, and names the step it gave up on', () => {
    const { timers, exit, log, deadline } = stop(false)
    expect(timers.map(({ ms }) => ms)).toEqual([ALONE_STOP_DEADLINE_MS])
    expect(ALONE_STOP_DEADLINE_MS).toBe(2_500)
    deadline.at('the gateway')
    expect(exit).not.toHaveBeenCalled()
    timers[0].fn()
    expect(log).toHaveBeenCalledWith(`[cli] the stop is still on the gateway after ${ALONE_STOP_DEADLINE_MS} ms — leaving without it`)
    expect(exit).toHaveBeenCalledOnce()
  })

  it('names the first steps when nothing was marked yet', () => {
    const { timers, log } = stop(false)
    timers[0].fn()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('still on the first steps'))
  })

  it('leaves the deadline to the master that runs it', () => {
    const { timers, deadline, exit } = stop(true)
    deadline.at('the backend')
    expect(timers).toEqual([])
    expect(exit).not.toHaveBeenCalled()
  })

  it('uses a real timer by default', () => {
    vi.useFakeTimers()
    try {
      const exit = vi.fn()
      stopDeadline({ supervised: false, exit, log: () => {} })
      vi.advanceTimersByTime(ALONE_STOP_DEADLINE_MS - 1)
      expect(exit).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(exit).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
})
