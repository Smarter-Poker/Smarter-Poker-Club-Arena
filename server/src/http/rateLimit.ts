/**
 * Per-user action rate limiter.
 *
 * Extracted from `server/src/index.ts` in Phase U3.2 (2026-04-23).
 *
 * Bible V8 §9.3: Rate limiting — 1 action per 250ms per player.
 *
 * History: Raised from 100ms → 250ms (BUG 025): 100ms was too tight for human
 * input — legitimate double-taps (50–150ms) tripped the limiter and surfaced
 * a 429 toast mid-hand. 250ms = 4 actions/sec max, still aggressive enough to
 * block bot abuse but will not reject normal human clicks or pre-action /
 * real-action transitions.
 */

const actionRateLimiter: Map<string, number> = new Map();
const RATE_LIMIT_MS = 250;

export function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const lastAction = actionRateLimiter.get(userId) ?? 0;
  if (now - lastAction < RATE_LIMIT_MS) {
    return false; // Rate limited
  }
  actionRateLimiter.set(userId, now);
  // Clean up old entries every 1000 checks to prevent memory leak
  if (actionRateLimiter.size > 1000) {
    const cutoff = now - 60000; // Remove entries older than 60s
    for (const [uid, ts] of actionRateLimiter) {
      if (ts < cutoff) actionRateLimiter.delete(uid);
    }
  }
  return true;
}
