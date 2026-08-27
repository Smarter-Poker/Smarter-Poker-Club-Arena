/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MYSTERY BOUNTY PRIZE LADDER — which rung a pulled prize sits on
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, verbatim: "IN ANY MYSTERY BOUNTY POOL, ALL PLAYERS IN THE
 * TOURNAMENT SHOULD GET A CELEBRATION TOAST NOTIFYING ALL PLAYERS (AND
 * OBSERVERS) WHEN THE TOP 3 PRIZES ARE PULLED."
 *
 * "The top 3" is a fact about the whole event, not about one knockout, so it
 * cannot be decided from a single payload. It needs the LADDER: every distinct
 * prize value this event holds, largest first. The rank of a pulled prize is
 * then its position on that ladder, 1 being the largest.
 *
 * ── WHY THIS LIVES ON THE SERVER ──────────────────────────────────────────
 *
 * `src/components/tournament/MysteryBountyCelebration.tsx` derives the same
 * ladder in the browser, and that derivation is kept as its fallback. But the
 * server already knows the answer, and deriving it once here rather than in
 * every open tab means:
 *
 *   - a client whose ladder query fails celebrates nothing today. With an
 *     authoritative `prizeRank` on the wire it celebrates correctly;
 *   - an observer holding no entry gets the same number as a seated player,
 *     from the same source, rather than from their own read of tables they may
 *     be permitted to see less of.
 *
 * ── UNITS ─────────────────────────────────────────────────────────────────
 *
 * Unit-agnostic on purpose. The chest phase ranks in CENTS (the chest
 * inventory is stored that way) and the pre-phase ranks in whole currency
 * (`current_bounty` is numeric). Both are correct as long as the amount and
 * the ladder handed to `prizeRankOf` use the SAME unit, which is the one thing
 * a caller must get right.
 *
 * These functions are pure and do no I/O, which is what makes the rule
 * testable without going anywhere near a money path (CLAUDE.md 11.5).
 */

/**
 * A money value normalised to a stable two-decimal number.
 *
 * Anything that is not a finite number becomes 0 rather than NaN, because a
 * NaN on the ladder poisons every comparison silently. Rounding to 2dp is what
 * makes `10.1 + 0.2` style float dust compare equal to a stored `10.30`; on
 * integer cents it is a no-op.
 */
function money2(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * The distinct prize values in a set of rows, largest first.
 *
 * DISTINCT is the point: four players may hold a head worth the same amount,
 * and they are all on the same rung. Zero and negative values are dropped —
 * `current_bounty` is zeroed when a head is claimed, and a zeroed head is not
 * a prize.
 */
export function buildPrizeLadder(values: Iterable<unknown>): number[] {
  const distinct = new Set<number>();
  for (const v of values) {
    const n = money2(v);
    if (n > 0) distinct.add(n);
  }
  return [...distinct].sort((a, b) => b - a);
}

/**
 * The 1-based rank of `amount` on `ladder`, or 0 when it cannot be decided.
 *
 * `ladder` MUST be sorted largest first — `buildPrizeLadder` is the only
 * supported way to make one — because the scan stops at the first value that
 * is not larger than the amount.
 *
 * An empty ladder returns 0, meaning "unknown", NOT 1. A guessed rank of 1
 * would interrupt every table in the event for a routine knockout, which is
 * exactly the thing Dan ruled out; silence is the correct failure.
 *
 * An amount that is not on the ladder at all still gets a sensible answer: it
 * ranks below everything larger than it. That matters when the ladder is a
 * truncated top slice (see the callers) — a prize outside the slice comes back
 * with a rank past the end, which every consumer reads as "not the top three".
 */
export function prizeRankOf(amount: unknown, ladder: readonly number[]): number {
  const target = money2(amount);
  if (target <= 0) return 0;
  if (ladder.length === 0) return 0;

  let above = 0;
  for (const v of ladder) {
    if (v > target) above += 1;
    else break;
  }
  return above + 1;
}

/**
 * The modes `fn_collect_bounty` can return for a knockout that pulled a
 * MYSTERY head.
 *
 * Read off the live function body on 2026-08-26:
 *
 *     v_mode := CASE WHEN COALESCE(v_t.is_pko,false)            THEN 'pko'
 *                    WHEN COALESCE(v_t.is_mystery_bounty,false) THEN 'mystery_pre'
 *                    ELSE 'regular' END;
 *
 * So the value in production is `mystery_pre`, and the engine's old test for
 * `'mystery'` could never be true. `'mystery'` is kept here anyway: it costs
 * nothing, and if the function is ever changed to return it, this list is
 * already right rather than newly wrong.
 *
 * NOTE the CASE order — a tournament flagged BOTH pko and mystery returns
 * `'pko'`, and `paid_cash` is then only half the head. That knockout is
 * deliberately not treated as a mystery pull: ranking a half-payment against a
 * ladder of whole heads would report a rung nobody pulled.
 *
 * That combination CANNOT EXIST any more. Dan 2026-08-26: "no, never
 * pko+mystery bounty ever" — enforced by the DB constraint
 * `tournaments_never_pko_and_mystery` (migration 20260826210000). The CASE
 * order note above stays as the reason the constraint was worth adding.
 */
export const MYSTERY_COLLECT_MODES: readonly string[] = ['mystery', 'mystery_pre'];

/** True when `fn_collect_bounty` says this knockout pulled a mystery head. */
export function isMysteryCollectMode(mode: unknown): boolean {
  return MYSTERY_COLLECT_MODES.includes(String(mode ?? '').toLowerCase());
}

/** Dan's "TOP 3 PRIZES". The only number any consumer decides anything on. */
export const TOP_PRIZE_RANKS = 3;

/** True when a rank is one of the top three, and a real rank at all. */
export function isTopPrize(rank: unknown): boolean {
  const n = Number(rank);
  return Number.isFinite(n) && n >= 1 && n <= TOP_PRIZE_RANKS;
}
