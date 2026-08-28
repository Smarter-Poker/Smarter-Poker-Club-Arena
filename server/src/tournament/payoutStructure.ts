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
