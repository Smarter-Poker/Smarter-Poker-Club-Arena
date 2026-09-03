/**
 * Per-player, PER-TABLE action rate limiter.
 *
 * Extracted from `server/src/index.ts` in Phase U3.2 (2026-04-23).
 *
 * Bible V8 §9.3: Rate limiting — 1 action per 250ms per player, per table.
 *
 * History:
 *  - Raised from 100ms → 250ms (BUG 025): 100ms was too tight for human input;
 *    legitimate double-taps (50–150ms) tripped the limiter and surfaced a 429
 *    toast mid-hand.
 *  - 2026-08-19 (Dan bug list item 13, "Server error (429) must never happen on
 *    a live game"): the key was the bare userId, so the window was shared
 *    across every table a player was sitting at. Multi-tabling is normal play -
 *    a player who folds at table A and calls at table B within 250ms was rate
 *    limiting themselves against their own other table, and the second action
 *    was REJECTED, not queued. Keying by user AND table keeps the anti-spam
 *    property where it belongs (4 actions/sec at any one table) while making
 *    cross-table play impossible to throttle.
 */

const actionRateLimiter: Map<string, number> = new Map();
const RATE_LIMIT_MS = 250;

/**
 * @param userId  the authenticated player
 * @param tableId the table the action is for. Actions at different tables
 *                never contend; omit only where no table applies.
 * @returns true when the action may proceed, false when it is rate limited.
 */
export function checkRateLimit(userId: string, tableId?: string): boolean {
  const key = tableId ? `${userId}:${tableId}` : userId;
  const now = Date.now();
  const lastAction = actionRateLimiter.get(key) ?? 0;
  if (now - lastAction < RATE_LIMIT_MS) {
    return false; // Rate limited
  }
  actionRateLimiter.set(key, now);
  // Clean up old entries every 1000 checks to prevent memory leak
  if (actionRateLimiter.size > 1000) {
    const cutoff = now - 60000; // Remove entries older than 60s
    for (const [k, ts] of actionRateLimiter) {
      if (ts < cutoff) actionRateLimiter.delete(k);
    }
  }
  return true;
}

/** Test-only: forget every window so cases cannot bleed into each other. */
export function __resetRateLimiterForTests(): void {
  actionRateLimiter.clear();
}
