/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SIT-OUT DEADLINE — how long a cash player actually has
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28, binding: "A USER CAN ONLY SIT OUT FOR 5 MINUTES BEFORE
 * GETTING BOOTED IN A CASH GAME... AND AS LONG AS THEY WANT IN A MTT, SPIN OR
 * HEADS UP (BUT THEY WILL BE BLINDED OFF)."
 *
 * The rule has been enforced server-side since the sit-out clock was made to
 * survive a restart (`table_seats.sit_out_at`, migration 20260828210000), and
 * until 2026-08-29 NOTHING on any client showed it. The three surfaces that know
 * a player is sitting out — the seat badge, the spectator footer and SitOutModal
 * — all rendered static text. A cash player had no way to know they were thirty
 * seconds from losing their seat and having their stack cashed out.
 *
 * `SitOutModal` even received `sitOutSince` and dropped it: an earlier fix had
 * removed a countdown that was a LIE (hard-wired to 300, never updated, on a
 * deadline that genuinely did not exist at the time). The deadline exists now,
 * so the readout is owed.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM
 *
 * The real rule is "2 orbits or 5 minutes, whichever comes FIRST", and the orbit
 * half is engine state a client cannot see. So this reports the time half only,
 * and every caller must present it as an upper bound rather than a promise —
 * "up to", never "exactly". A player evicted early by the orbit rule must not be
 * able to point at a countdown that said they had two minutes left.
 *
 * MIRROR: `DisconnectEngine.SITOUT_MAX_MS`. Pinned by
 * tests/unit/sitOutDeadlineMirror.test.ts, for the same reason
 * cashBuyInMirror.test.ts exists — server/tsconfig.json sets `rootDir: ./src`,
 * so the engine cannot import this file and a copy is the only option.
 */

/** Mirror of DisconnectEngine.SITOUT_MAX_MS. */
export const SITOUT_MAX_MS = 5 * 60 * 1000;

/** Mirror of DisconnectEngine.SITOUT_MAX_ORBITS. Reported, never counted here. */
export const SITOUT_MAX_ORBITS = 2;

/**
 * Milliseconds remaining before a cash seat may be reclaimed, or `null` when no
 * deadline applies.
 *
 * `null` — not zero, and not a large number — for every case where the player is
 * NOT on a clock: tournaments, spins and heads-up (Dan: "as long as they want"),
 * an unknown start time, and a table type we cannot identify. A caller that
 * renders a countdown must skip it on `null` rather than substituting a
 * fallback; inventing a deadline is the bug this file's history is made of.
 */
export function sitOutMsRemaining(params: {
  /** Epoch ms when sit-out began. `table_seats.sit_out_at`, or null if unknown. */
  sitOutSince: number | null | undefined;
  /** False for cash. Tournaments, spins and heads-up sit out indefinitely. */
  isTournament: boolean;
  /** Defaults to now; injectable so a test does not need fake timers. */
  now?: number;
}): number | null {
  const { sitOutSince, isTournament } = params;
  if (isTournament) return null;
  if (!sitOutSince || !Number.isFinite(sitOutSince)) return null;
  const now = params.now ?? Date.now();
  const elapsed = now - sitOutSince;
  /* A clock that started in the future is a clock we do not understand — a
     clock-skewed device, or a stamp written by something else. Say nothing
     rather than show a number that will jump. */
  if (elapsed < 0) return null;
  return Math.max(0, SITOUT_MAX_MS - elapsed);
}

/**
 * `m:ss`, floored, never negative. Seconds are what a player under a deadline
 * reads, so 65s is "1:05" and 5s is "0:05" rather than a bare number.
 */
export function formatSitOutRemaining(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The label the seat badge and the modal both show.
 *
 * One function so the two surfaces cannot word the same rule differently, and
 * so the "up to" hedge above cannot be dropped from one of them. Title Case,
 * because everything a player reads in this product is (Dan 2026-08-20) — and
 * no em dashes.
 */
export function sitOutBadgeLabel(msRemaining: number | null): string {
  if (msRemaining === null) return 'Sitting Out';
  if (msRemaining <= 0) return 'Sitting Out. Seat At Risk';
  return `Sitting Out ${formatSitOutRemaining(msRemaining)}`;
}

/** Under a minute left: the point at which a seat is worth shouting about. */
export const SITOUT_URGENT_MS = 60 * 1000;

export function isSitOutUrgent(msRemaining: number | null): boolean {
  return msRemaining !== null && msRemaining <= SITOUT_URGENT_MS;
}
