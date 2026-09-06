import { serverNow } from '../utils/serverClock';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SIT-OUT DEADLINE — how long a cash player actually has
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28, binding: "A USER CAN ONLY SIT OUT FOR 5 MINUTES BEFORE
 * GETTING BOOTED IN A CASH GAME... AND AS LONG AS THEY WANT IN A MTT, SPIN OR
 * HEADS UP (BUT THEY WILL BE BLINDED OFF)."
 *
 * WHAT IS ACTUALLY IMPLEMENTED, stated plainly because an earlier version of
 * this file repeated Dan's three categories as though all three were wired:
 * the ONLY discriminator on either side of the wire is tournament-ness
 * (`tournament_id` set, or `game_type === 'tournament'`). MTTs are exempt.
 * SPINS are exempt because a spin IS a tournament. A HEADS-UP CASH table is
 * not exempt and gets the five-minute clock like any other cash table — there
 * is no heads-up table type in this codebase, only a heads-up blind rule
 * inside HandController. Client and server agree with each other, so nothing
 * is broken; the gap is between the product rule and both of them, and it is
 * Dan's to close.
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
 * How far ahead of us a server stamp may be before we stop believing the
 * device's clock at all. Two minutes: comfortably past any plausible write
 * latency or timezone-free skew, comfortably short of a deadline worth showing.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 2 * 60 * 1000;

/**
 * Milliseconds remaining before a cash seat may be reclaimed, or `null` when no
 * deadline applies.
 *
 * `null` — not zero, and not a large number — for every case where the player is
 * NOT on a clock: tournament tables (spins included),
 * an unknown start time, and a table type we cannot identify. A caller that
 * renders a countdown must skip it on `null` rather than substituting a
 * fallback; inventing a deadline is the bug this file's history is made of.
 */
export function sitOutMsRemaining(params: {
  /** Epoch ms when sit-out began. `table_seats.sit_out_at`, or null if unknown. */
  sitOutSince: number | null | undefined;
  /** False for cash. A tournament table (a spin is one) sits out indefinitely. */
  isTournament: boolean;
  /** Defaults to now; injectable so a test does not need fake timers. */
  now?: number;
}): number | null {
  const { sitOutSince, isTournament } = params;
  if (isTournament) return null;
  if (!sitOutSince || !Number.isFinite(sitOutSince)) return null;
  const now = params.now ?? serverNow();
  const elapsed = now - sitOutSince;
  /* A STAMP SLIGHTLY IN THE FUTURE IS CLOCK SKEW, NOT A MYSTERY.
     `sit_out_at` is `now()` on the DATABASE, so a device whose clock is behind
     real time makes every server stamp look future-dated. The first version
     returned `null` for any negative elapsed, which meant such a device lost
     the countdown ENTIRELY and silently — no badge clock, no line in the modal,
     no clock on the footer — while a real eviction timer ran against them.
     Saying nothing is right for a value we cannot trust; it is wrong for a
     value that is merely a few seconds off.
     So: treat a small negative as "just started" (the deadline is then at worst
     a few seconds LATE, which under-promises, the safe direction), and keep
     `null` for a stamp far enough ahead that the clock is genuinely unusable. */
  if (elapsed < -CLOCK_SKEW_TOLERANCE_MS) return null;
  return Math.max(0, SITOUT_MAX_MS - Math.max(0, elapsed));
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
export function sitOutBadgeLabel(
  msRemaining: number | null,
  /**
   * How the sentence opens. The footer says "You Are Sitting Out" because it is
   * the HERO's own bar; a seat badge says "Sitting Out" because it is about
   * somebody else.
   *
   * A PARAMETER, because the footer used to do
   * `sitOutBadgeLabel(...).replace('Sitting Out', 'You Are Sitting Out')` —
   * string surgery on the output of the one function that exists so two
   * surfaces cannot word the same rule differently. Any rewording that stopped
   * beginning with those exact words would have silently produced a sentence
   * with the subject missing, and nothing would have failed.
   */
  subject:
    | 'Sitting Out'
    | 'You Are Sitting Out'
    /* 2026-09-04 (disconnect audit item 3): the bar could not tell a forced
       sit-out from a chosen one and told a player who timed out three times
       that they were "sitting out", as if they had asked. The engine now
       says which; this is the sentence for the one they did not choose. */
    | 'You Timed Out Three Times, So You Are Sitting Out' = 'Sitting Out'
): string {
  if (msRemaining === null) return subject;
  if (msRemaining <= 0) return `${subject}. Seat At Risk`;
  /* "UP TO", and this function is the reason the hedge is not optional.
     The rule is "2 orbits or 5 minutes, whichever comes FIRST", and the orbit
     half is engine state no client can see — so a bare `Sitting Out 4:37`
     PROMISES time the player may not have. The first version of this returned
     exactly that: the one function created "so the two surfaces cannot word the
     same rule differently" was the one that dropped the rule, while the modal,
     which builds its own string, kept it. */
  return `${subject}. Up To ${formatSitOutRemaining(msRemaining)}`;
}

/** Under a minute left: the point at which a seat is worth shouting about. */
export const SITOUT_URGENT_MS = 60 * 1000;

export function isSitOutUrgent(msRemaining: number | null): boolean {
  /* DELIBERATELY UNBOUNDED BELOW. This is the STYLING predicate: at 0:00 the
     seat is at its most at-risk, so a badge that dropped its red exactly then
     would be quietest at the worst moment.

     A caller that needs a LIVE clock — one that intends to count down to this,
     like the multi-table dock competing for its urgent slot — must add its own
     `> 0`, because a passed deadline is not something you can count towards.
     That is done at the dock's own call site, where the reason is visible. */
  return msRemaining !== null && msRemaining <= SITOUT_URGENT_MS;
}
