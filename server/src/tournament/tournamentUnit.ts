/**
 * WHAT UNIT DOES THIS TOURNAMENT PAY IN?
 *
 * The TypeScript half of `fn_ca_tournament_unit_cents`, which migration
 * 20260912090000 created as "the only place SQL answers this". This is the
 * only place TypeScript answers it, and the two are one rule.
 *
 * Deliberately a standalone module with NO imports, for the same reason
 * `payoutMath.ts` and `recoveryFee.ts` are: it is read by the engine, by the
 * browser (which imports it directly across the repo boundary, exactly as
 * `src/` already imports `server/src/domain/ArenaContext`) and by the laws
 * that hold the two languages together. A rule about money must not be
 * reachable only through whichever service happens to pull in half the engine.
 *
 * ONE COPY, NOT A MIRROR. `payoutMath.ts` is duplicated byte-for-byte into
 * `src/lib/payoutMath.ts` and `payout-one-rule-everywhere.law.test.ts` exists
 * to keep the copies honest. That is a tolerated cost, not a pattern to repeat:
 * the whole point of this phase is that a rule written twice drifts. There is
 * one of this file and both halves import it.
 */

/**
 * The smallest amount a chip tournament can pay. Every tournament that has
 * ever run on this platform is one.
 *
 * `Math.round(x / 1) * 1` is `Math.round(x)` and `Math.floor(x / 1) * 1` is
 * `x`, which is why every unit-aware rule in the estate leaves the chip path
 * unchanged BY CONSTRUCTION rather than by inspection.
 */
export const CHIP_UNIT_CENTS = 1;

/** The smallest amount a Diamond tournament can pay. A Diamond does not divide. */
export const DIAMOND_UNIT_CENTS = 100;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE UNIT A CALLER USES WHEN IT HAS NOT READ THE TOURNAMENT'S ASSET
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CLAUDE.md 10.86 rule 1: "I could not tell" is a distinct outcome and must
 * have its own name. It must never be folded into pending, green, empty, zero
 * or silence - and a defaulted `unitCents = 1` parameter is exactly that fold.
 * Every prize call site in this estate omitted the argument, so every one of
 * them answered "a cent" without ever having looked at a club row.
 *
 * This constant is the fold made VISIBLE. Its value is a cent because there
 * are zero Diamond tournaments - they are refused structurally at every door,
 * and `fn_poker_diamond_plain_cash_table`, `assertDiamondCashTable`,
 * `seatCanAddFunds` and `fn_poker_diamond_open_cash_table` each refuse a
 * tournament id - so a cent is the correct answer for every tournament that
 * can currently exist. It is not the correct answer because nobody looked.
 *
 * The difference is that this is GREPPABLE. The work that opens the Diamond
 * tournament door finds every surface that has to learn its asset by searching
 * for this name, instead of by searching for the absence of an argument.
 *
 * Use `tournamentUnitCents` instead wherever a club row is actually in hand.
 */
export const UNIT_CENTS_ASSET_NOT_READ = CHIP_UNIT_CENTS;

/** The three club columns `fn_ca_tournament_unit_cents` joins and tests. */
export interface TournamentUnitClubRow {
  asset?: unknown;
  is_platform?: unknown;
  union_id?: unknown;
}

/**
 * The smallest amount this tournament can pay, in cents, derived from its
 * club exactly as the database derives it:
 *
 *     SELECT CASE WHEN EXISTS (
 *       SELECT 1 FROM public.tournaments t
 *         JOIN public.clubs c ON c.id = t.club_id
 *        WHERE t.id = p_tournament_id
 *          AND c.asset = 'diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL
 *     ) THEN 100 ELSE 1 END;
 *
 * All three conditions, and the same strictness on each: `is_platform` must be
 * exactly true (SQL's `IS TRUE` is false for NULL), `union_id` must be absent
 * (a Diamond game cannot belong to a union - `parseTableArenaIdentity` refuses
 * that shape too), and any other asset is chips. A club that satisfies some but
 * not all of them is a cent, which is the SQL's answer and not a fallback.
 *
 * `null` means the join found nothing - the tournament has no club, or the
 * tournament does not exist. That is the SQL's own `EXISTS = false` branch and
 * its answer is a cent.
 *
 * THE PARAMETER IS REQUIRED AND DOES NOT ACCEPT `undefined`, which is the
 * whole design. A caller that never read a club cannot reach this function by
 * forgetting an argument; it has to write `null` (I looked, there was nothing)
 * or `UNIT_CENTS_ASSET_NOT_READ` at the call it is feeding (I did not look).
 * Both are statements. An omitted argument is not.
 */
export function tournamentUnitCents(club: TournamentUnitClubRow | null): number {
  if (club === null) return CHIP_UNIT_CENTS;
  return club.asset === 'diamonds' && club.is_platform === true && club.union_id == null
    ? DIAMOND_UNIT_CENTS
    : CHIP_UNIT_CENTS;
}

/**
 * A unit read off a row or a wire, normalised to something the arithmetic can
 * use. A nonsense value is a cent, never a grid.
 *
 * Identical in meaning to the guard `computePlacePrize` and `unitFloorCents`
 * each keep inline. Those two stay inline on purpose - both are import-free
 * leaves and `payoutMath.ts` is copied verbatim into `src/lib/`, so an import
 * there would break the copy - but nothing else should spell it a fourth time.
 */
export function normalizeUnitCents(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : CHIP_UNIT_CENTS;
}
