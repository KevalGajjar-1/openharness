/**
 * A per-account fixed-window limiter, process-local by design: it spreads a route's budget, it is not
 * the budget (the provider's own credit limit is).
 */
export interface WindowLimiter {
  /** Counts one request for [key] and says whether it is within the window's allowance. */
  allows(key: string, now?: number): boolean
  /** Test seam. */
  reset(): void
}

export function createWindowLimiter(windowMs: number, max: number): WindowLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>()
  return {
    allows(key, now = Date.now()) {
      const bucket = buckets.get(key)
      if (!bucket || now >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + windowMs })
        return true
      }
      if (bucket.count >= max) return false
      bucket.count++
      return true
    },
    reset: () => buckets.clear(),
  }
}
