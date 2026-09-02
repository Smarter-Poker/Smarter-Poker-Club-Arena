export type ChallengeResetTier = 'daily' | 'weekly' | 'monthly';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Returns the exact UTC boundary that ends the current mission cycle. */
export function getChallengeResetAt(tier: ChallengeResetTier, nowMs = Date.now()): Date {
  const now = new Date(nowMs);

  if (tier === 'daily') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  }

  if (tier === 'weekly') {
    const daysToMonday = (8 - now.getUTCDay()) % 7 || 7;
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToMonday)
    );
  }

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export function msUntilChallengeReset(tier: ChallengeResetTier, nowMs = Date.now()): number {
  return Math.max(0, getChallengeResetAt(tier, nowMs).getTime() - nowMs);
}

/**
 * Keeps long cycles compact, then adds seconds inside the final hour so the
 * deadline never appears frozen when a player is racing the reset.
 */
export function formatChallengeCountdown(ms: number): string {
  if (ms <= 0) return 'Resetting';

  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  const seconds = Math.floor((ms % MINUTE) / SECOND);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

export function getUtcDateKey(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}
