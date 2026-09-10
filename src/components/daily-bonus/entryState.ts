/**
 * entryState - the small pure pieces DailyBonusEntry decides with: the
 * per-day "seen" mark, the per-tab "nothing to show" memo, the local Chicago
 * date hint, the paths the sheet never opens on, and the rule for raising it.
 * Kept out of the component file so they can be tested without React and so
 * the component module exports only a component (fast refresh).
 */
import type { DailyBonusStatus } from '../../services/DailyBonusService';

const SEEN_PREFIX = 'ca_daily_bonus_seen:';
const QUIET_PREFIX = 'ca_daily_bonus_quiet:';
/** Retry a failed entry read after this long; three tries, then wait for a signal. */
export const RETRY_DELAY_MS = 15_000;
export const MAX_RETRIES = 3;
/** setTimeout overflows past this and fires at once; clamp long waits. */
export const MAX_TIMER_MS = 2_147_483_647;

function seenKey(userId: string, today: string): string {
  return `${SEEN_PREFIX}${userId}:${today}`;
}

export function wasSeenToday(userId: string, today: string): boolean {
  try {
    return localStorage.getItem(seenKey(userId, today)) === '1';
  } catch {
    return false;
  }
}

export function markSeenToday(userId: string, today: string): void {
  try {
    localStorage.setItem(seenKey(userId, today), '1');
    // Yesterday's marks are dead weight; one key per player per day never
    // accumulates past a handful.
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(`${SEEN_PREFIX}${userId}:`) && key !== seenKey(userId, today)) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    /* storage unavailable */
  }
}

/**
 * The server said today has nothing to raise the sheet for (every tile
 * claimed, or nothing open to this account). Remembered per tab until the
 * midnight it reported, so the next host mount skips the read.
 */
export function quietUntil(userId: string): number | null {
  try {
    const raw = sessionStorage.getItem(`${QUIET_PREFIX}${userId}`);
    if (!raw) return null;
    const until = Number(raw);
    return Number.isFinite(until) && until > Date.now() ? until : null;
  } catch {
    return null;
  }
}

export function markQuiet(userId: string, resetAt: string): void {
  try {
    const until = Date.parse(resetAt);
    if (!Number.isFinite(until)) return;
    sessionStorage.setItem(`${QUIET_PREFIX}${userId}`, String(until));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Today's date in Chicago, as the server would name it, from this device's
 * clock. Only a hint: it lets a dismissed day skip the read entirely. The
 * server's `today` is the truth the sheet acts on.
 */
export function chicagoToday(now: number = Date.now()): string | null {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(now));
  } catch {
    return null;
  }
}

export function isQuietPath(pathname: string): boolean {
  return (
    pathname.startsWith('/table') ||
    pathname.startsWith('/bonuses') ||
    pathname.startsWith('/multi-table') ||
    (pathname.startsWith('/tournaments/') && pathname.endsWith('/play'))
  );
}

/**
 * Whether a status answer should raise the sheet for this account: one popup
 * per Chicago day (Dan, 2026-09-09), and only while a tile is still there to
 * claim. `shown_today` is the server's mark, set the first time the sheet is
 * put in front of the player from ANY device; the local mark is the same
 * fact for the moments the server write is still in flight.
 */
export function shouldOpenSheet(status: DailyBonusStatus, userId: string): boolean {
  return (
    status.eligible &&
    status.unclaimed > 0 &&
    !status.shown_today &&
    !wasSeenToday(userId, status.today)
  );
}
