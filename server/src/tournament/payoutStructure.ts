/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PAYOUT STRUCTURE RESOLUTION — what to split the pool by
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `computePlacePrize` answers "what does place N get, given a structure". This
 * module answers the question before it: WHICH structure.
 *
 * ─── THE LANDMINE THIS DEFUSES ──────────────────────────────────────────────
 *
 * Both payout sites in TournamentManagerEliminations had the same fallback: if
 * `payout_structure` was missing, or had no place 1, award 100% of the prize
 * pool to the winner. For a winner-take-all event that is exactly right, and it
 * is a real safety net for an MTT whose structure failed to write.
 *
 * For a Spin at 10x or above it is a 20% overpay. Those tiers pay 80/20 and
 * 80/12/8, and places 2 and 3 are paid AT ELIMINATION — minutes before the
 * finish reads `payout_structure` again. If the column is unreadable on that
 * second read, the winner takes the whole pool on top of money already sent.
 * The pool pays out 120%.
 *
 * At the time of writing exposure was zero: every completed Spin had a
 * structure with a place 1. But the 80/20 and 80/12/8 splits had only just been
 * introduced and had never run end to end, so the fallback was armed and
 * untested rather than harmless.
 *
 * ─── THE FIX ────────────────────────────────────────────────────────────────
 *
 * A Spin does not need a fallback at all. Its structure is a pure function of
 * its multiplier — `spinTier(m).payouts` — so when the stored column is
 * missing or malformed the canonical spec reconstructs it exactly. Nothing is
 * guessed and nothing is over-paid.
 *
 * This lives in its own module for the same reason `payoutMath` does: the
 * import graph around the tournament managers is already circular-adjacent
 * (recovery -> eliminations -> base -> recovery), and money code should not
 * depend on ESM hoisting to survive. `spinSpec` has no imports of its own, so
 * this module adds no edge that could close a cycle.
 */

import { spinTier } from '../config/spinSpec.js';

export interface PayoutPlace {
  place: number;
  percentage: number;
}

export interface PayoutSubject {
  payout_structure?: unknown;
  variant?: string | null;
  tournament_type?: string | null;
  spin_multiplier?: number | null;
}

/** Is this a Spin? Either column may carry it, in either case. */
export function isSpinTournament(t: PayoutSubject | null | undefined): boolean {
  if (!t) return false;
  return (
    String(t.variant ?? '').toLowerCase() === 'spin' ||
    String(t.tournament_type ?? '').toUpperCase() === 'SPIN'
  );
}

/**
 * Parse the column and say whether it is USABLE, which is a stronger question
 * than whether it parsed. A structure with no place 1, a negative percentage or
 * percentages summing to zero is not a structure — it is a corrupt value that
 * happens to be valid JSON, and treating it as authoritative is how a pool gets
 * split by nonsense.
 */
export function parsePayoutStructure(raw: unknown): PayoutPlace[] | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value) || value.length === 0) return null;

  const places: PayoutPlace[] = [];
  for (const entry of value) {
    const place = Number((entry as any)?.place);
    const percentage = Number((entry as any)?.percentage);
    if (!Number.isFinite(place) || place < 1) return null;
    if (!Number.isFinite(percentage) || percentage < 0) return null;
    places.push({ place, percentage });
  }
  if (!places.some((p) => p.place === 1)) return null;
  if (places.reduce((s, p) => s + p.percentage, 0) <= 0) return null;

  return places;
}

/** The structure a Spin's multiplier implies, from the canonical spec. */
export function spinPayoutStructure(multiplier: number | null | undefined): PayoutPlace[] | null {
  const tier = spinTier(Number(multiplier));
  if (!tier || !Array.isArray(tier.payouts) || tier.payouts.length === 0) return null;
  return tier.payouts.map((pct, i) => ({
    place: i + 1,
    // Two decimals of a percentage, matching what createSpin writes to the
    // column, so a derived structure and a stored one are the same numbers.
    percentage: Math.round(pct * 10000) / 100,
  }));
}

/**
 * The structure to actually pay by.
 *
 * Returns null only when there is genuinely nothing to go on — a non-Spin with
 * no usable column. Callers keep their own behaviour for that case (an MTT
 * still falls back to winner-take-all, which is the right net for an event
 * whose structure never wrote), but they must CAP it: see
 * `remainingPoolAfterAwards`.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A STRUCTURE CANNOT PAY A PLACE NOBODY REACHED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SHORT-FIELD RESIDUAL 2026-08-27. `computePlacePrize` gives the LAST place in
 * the structure whatever is left over, so the paid places sum to the pool to
 * the cent. Nothing trimmed the structure to the size of the field, so when
 * fewer players entered than the structure pays, the residual sat on a place no
 * finisher ever held and was never awarded at all.
 *
 * Sunday Midway Major: a 9-place structure, 8 entrants, 250.00 of a 10,000.00
 * pool never left the house. PLO Daily 18155d71: 5 places, 4 entrants, 52.50
 * stranded. Eight events in thirty days, and every one of them also left
 * fn_tournament_payout_reconcile holding a `no_finisher_recorded` critical it
 * refuses, correctly, to resolve on its own.
 *
 * Trimming is all that is needed. The residual rule then lands the leftover on
 * the last place that DOES have a finisher, which is the smallest real prize -
 * the same "adjustment lands on the smallest prize, never a headline one"
 * principle the rule already follows. No renormalisation: the dropped place's
 * share flows into the residual by construction.
 *
 * TRIMMING IS THE DANGEROUS DIRECTION, so this is deliberately timid:
 *
 *   * an absent, non-finite, non-integer or non-positive fieldSize trims
 *     nothing, so every existing caller keeps its exact behaviour;
 *   * a fieldSize at or above the structure trims nothing;
 *   * a trim that would leave no places returns the structure untouched.
 *
 * A fieldSize that is too SMALL would promote an earlier place to residual
 * holder and overpay it, so callers must pass the count of everyone who ever
 * entered - never a live seat count, which drains as players bust - and must
 * not pass one at all until entry is closed and that count can no longer grow.
 */
export function trimStructureToField(
  places: PayoutPlace[] | null,
  fieldSize?: number | null
): PayoutPlace[] | null {
  if (!Array.isArray(places) || places.length === 0) return places;
  if (fieldSize == null) return places;
  const field = Number(fieldSize);
  if (!Number.isInteger(field) || field < 1) return places;

  const kept = places.filter((p) => Number(p.place) <= field);
  if (kept.length === 0 || kept.length === places.length) return places;
  return kept;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PAYOUT DEPTH SCALES WITH THE FIELD (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Measured over 579 completed MTTs, average places paid by field size:
 *
 *     field < 10   (14 events)  ->  5.1 places
 *     10-29       (393 events)  ->  5.8
 *     30-59       (113 events)  ->  7.1
 *     60-99        (31 events)  ->  6.8
 *     100+ (avg 334, 28 events) ->  8.9      <- 2.7% of the field
 *
 * Depth was flat because the preset map tops out at NINE, so a 334-runner event
 * paid the same nine places as a 30-runner one. The industry norm is 10-15% of
 * the field, and the gap is not cosmetic: it is the difference between a big
 * event feeling worth entering and feeling like a lottery with nine tickets.
 *
 * TWO RULES KEEP THIS SAFE, and both are about the direction that overpays.
 *
 *   1. PERCENTAGES ALWAYS SUM TO EXACTLY 100. The residual from rounding lands
 *      on the LAST paid place, never the first — the same choice
 *      computePlacePrize makes, and for the same reason: an error on last place
 *      is a rounding cent, an error on first place is a headline.
 *
 *   2. IT IS ONLY CALLED WHEN THE FIELD CAN NO LONGER GROW. A structure built
 *      for a field that then grows would pay too few places; one built for a
 *      field that shrank would promote an earlier place to residual holder and
 *      overpay it. The single caller sits at prize-pool finalisation, where
 *      entry is closed by definition and `recalculateEliminatedPrizes` already
 *      re-prices everyone who busted before the change.
 *
 * The shape is a geometric decay: first place takes a fixed share and each
 * subsequent place takes a constant fraction of the one above, which is what
 * every published structure approximates.
 */
export const PAID_FRACTION_OF_FIELD = 0.15;
export const MIN_PAID_PLACES = 3;
export const MAX_PAID_PLACES = 100;

export function paidPlacesForField(fieldSize: number): number {
  const field = Math.floor(Number(fieldSize));
  if (!Number.isFinite(field) || field < 1) return MIN_PAID_PLACES;
  /*
   * Never pay more places than there are players, and never pay every player:
   * a structure that pays 100% of the field is a refund, not a tournament.
   *
   * THE FLOOR IS APPLIED FIRST AND THE CAPS LAST (2026-08-31). It used to be
   * the other way round -
   *
   *     Math.max(MIN_PAID_PLACES, Math.min(byFraction, field / 2, MAX))
   *
   * - which raised the answer back OVER the cap it had just applied, so the
   * two caps in that Math.min were inert for every field the minimum could
   * reach. The stated half-field cap did nothing below eight players, and the
   * final clamp was to `field` rather than `field - 1`, so the sentence
   * directly above the code was false wherever it mattered most:
   *
   *     field 2 -> 2 places   every player paid, both get their buy-in back
   *     field 3 -> 3 places   every player paid
   *     field 4 -> 3 places   against a stated cap of 2
   *     field 5 -> 3 places   against a stated cap of 2
   *
   * Now: the minimum lifts the fractional answer, and then the caps bind.
   *
   *     field 1 -> 1   there is nobody to bubble; the winner takes it
   *     field 2 -> 1   a heads-up final is legitimately winner-take-all, and
   *                    paying both seats is a refund with extra steps
   *     field 3 -> 1   the half-field cap, which is the stricter of the two
   *     field 4 -> 2      "
   *     field 5 -> 2      "
   *     field 6 -> 3   the minimum binds from here up
   *     field 20 -> 3, 40 -> 6, 100 -> 15, 500 -> 75  unchanged
   *
   * Only fields of 2 to 5 move. Everything from six players up is byte-for-byte
   * what it was, which is why the measured-bucket pins above still hold.
   *
   * THE LAST CLAMP IS `field - 1`, NOT `field`, because the caller WRITES this
   * over what the operator configured: an off-by-one here does not propose a
   * refund, it stores one. `Math.max(1, ...)` keeps a one-player field at one
   * place rather than zero.
   */
  const byFraction = Math.max(MIN_PAID_PLACES, Math.round(field * PAID_FRACTION_OF_FIELD));
  const capped = Math.min(byFraction, Math.floor(field / 2), MAX_PAID_PLACES);
  return Math.max(1, Math.min(capped, field - 1));
}

/** Places in the steep top tier. Beyond this the tail flattens. */
const TOP_TIER_PLACES = 9;
/** Decay inside the top tier — tuned to the long-standing NINE preset. */
const TOP_TIER_DECAY = 0.72;
/** Decay across the flat min-cash tail. */
const TAIL_DECAY = 0.97;

/**
 * What share of the pool the top nine places take, as depth grows.
 *
 * A REAL PAYOUT STRUCTURE HAS TWO REGIMES, and the first version of this
 * function did not — it was a single geometric decay, which is right for nine
 * places and impossible for seventy-five. At 0.72 per place, place 28 of a
 * 500-runner field rounded to 0.00%: a "paid" place that pays nothing. The law
 * test caught it, which is what it is for.
 *
 * Published structures are steep across the final table and nearly flat across
 * the min-cash tail, so that is what this models. The top nine keep their
 * familiar shape at every depth; everyone below shares what is left with a
 * gentle decline.
 */
function topTierShareFor(places: number): number {
  if (places <= TOP_TIER_PLACES) return 100;
  return Math.max(50, Math.min(100, 100 - (places - TOP_TIER_PLACES) * 0.7));
}

export function payoutStructureForField(fieldSize: number): PayoutPlace[] {
  const places = paidPlacesForField(fieldSize);
  const topCount = Math.min(places, TOP_TIER_PLACES);
  const tailCount = places - topCount;
  const topShare = tailCount > 0 ? topTierShareFor(places) : 100;

  // Raw weights per tier, each normalised inside its own share of the pool.
  const topWeights: number[] = [];
  for (let i = 0; i < topCount; i++) topWeights.push(Math.pow(TOP_TIER_DECAY, i));
  const topWeightTotal = topWeights.reduce((s, w) => s + w, 0);

  const tailWeights: number[] = [];
  for (let i = 0; i < tailCount; i++) tailWeights.push(Math.pow(TAIL_DECAY, i));
  const tailWeightTotal = tailWeights.reduce((s, w) => s + w, 0) || 1;

  const raw: number[] = [
    ...topWeights.map((w) => (w / topWeightTotal) * topShare),
    ...tailWeights.map((w) => (w / tailWeightTotal) * (100 - topShare)),
  ];

  const out: PayoutPlace[] = [];
  let running = 0;
  for (let i = 0; i < places; i++) {
    const isLast = i === places - 1;
    // Two decimals: the column and every downstream reader are money-shaped.
    // The residual lands on the LAST place, never the first.
    const pct = isLast ? Math.round((100 - running) * 100) / 100 : Math.round(raw[i] * 100) / 100;
    running = Math.round((running + pct) * 100) / 100;
    out.push({ place: i + 1, percentage: pct });
  }
  return out;
}

export function resolvePayoutStructure(
  t: PayoutSubject | null | undefined,
  fieldSize?: number | null
): PayoutPlace[] | null {
  const stored = parsePayoutStructure(t?.payout_structure);
  if (stored) return trimStructureToField(stored, fieldSize);
  if (isSpinTournament(t))
    return trimStructureToField(spinPayoutStructure(t?.spin_multiplier), fieldSize);
  return null;
}

/**
 * How much of the pool is still unspent.
 *
 * The universal invariant behind all of the above: a prize pool cannot pay out
 * more than it holds. Whatever a fallback decides the winner is owed, it can
 * never exceed the pool minus what eliminated players were already paid. This
 * holds for every format, not just Spins — an MTT with a lost structure has the
 * identical exposure and had the identical missing guard.
 */
export function remainingPoolAfterAwards(prizePool: number, alreadyAwarded: number): number {
  const pool = Number.isFinite(prizePool) && prizePool > 0 ? prizePool : 0;
  const paid = Number.isFinite(alreadyAwarded) && alreadyAwarded > 0 ? alreadyAwarded : 0;
  return Math.max(0, Math.round((pool - paid) * 100) / 100);
}
