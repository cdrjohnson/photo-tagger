// Retry policy for Dropbox API calls (pure — unit tested).
const E2E = typeof window !== 'undefined' && !!(window as any).__PT_E2E__
/** Exponential backoff with full jitter: ~1s, 2s, 4s … capped at 60s (shortened in the test harness). */
export function backoffMs(attempt: number, base = E2E ? 20 : 1000, cap = E2E ? 200 : 60_000) {
  const top = Math.min(cap, base * 2 ** Math.min(attempt, 16))
  return Math.round(top / 2 + Math.random() * (top / 2))
}
/** Errors worth retrying later: rate limits, server errors, network trouble, Dropbox's write-contention 409s. */
export function isTransientDropboxError(e: any): boolean {
  const st = Number(e?.status ?? 0), msg = String(e?.message ?? e ?? '')
  if (/missing_scope|not_found|too_many_tags|invalid_access_token|expired_access_token|app folder|not support/i.test(msg)) return false
  if (st === 0 || st === 429 || st >= 500) return true
  if (st === 409 && /too_many_write_operations|too_many_requests|internal_error/i.test(msg)) return true
  return false
}
