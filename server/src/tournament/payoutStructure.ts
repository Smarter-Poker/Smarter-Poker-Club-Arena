import { isUnlimitedMtt, type TournamentEntryCapacitySubject } from './tournamentEntryCapacity.js';
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
 * pool to the winner. It happened to produce the intended split for a genuine
 * winner-take-all event, but it was still an unproved guess when an MTT's
 * structure failed to write. That guess has now been removed: an unavailable
 * payout contract leaves the tournament COMPLETING for repair.
 *
 * For a Spin at 10x or above it was a 20% overpay. Those tiers pay 80/20 and
 * 80/12/8, and the retired path paid places 2 and 3 AT ELIMINATION - minutes
 * before finish read `payout_structure` again. If the column was unreadable on
 * that second read, the winner took the whole pool on top of money already
 * sent. The pool paid out 120%.
 *
 * At the time of writing exposure was zero: every completed Spin had a
 * structure with a place 1. But the 80/20 and 80/12/8 splits had only just been
 * introduced and had never run end to end, so the fallback was armed and
 * untested rather than harmless.
 *
 * ─── THE FIX ────────────────────────────────────────────────────────────────
 *
 * A Spin does not need a fallback at all. Its structure is a pure function of
 * its multiplier — `spinTier(m).payouts` — so the canonical spec reconstructs
 * it exactly. Nothing is guessed and nothing is over-paid.
 *
 * 2026-08-31: and the spec does not merely fill a GAP, it OUTRANKS the stored
 * column on a Spin. See the rule above `resolvePayoutStructure`: a Spin's
 * stored structure is only ever a copy of the tier, so one that disagrees is
 * stale rather than chosen, and 62 completed spins were being paid by exactly
 * such a stale copy.
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

export interface PayoutSubject extends TournamentEntryCapacitySubject {
  payout_structure?: unknown;
  variant?: string | null;
  tournament_type?: string | null;
  spin_multiplier?: number | null;
}

function numericJsonScalar(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') return Number.NaN;
  if (typeof value === 'string' && value.trim() === '') return Number.NaN;
  return Number(value);
}

/** Is this a Spin? Either column may carry it, in either case. */
export function isSpinTournament(t: PayoutSubject | null | undefined): boolean {
  if (!t || isUnlimitedMtt(t)) return false;
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
  const seen = new Set<number>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const place = numericJsonScalar((entry as any)?.place);
    const percentage = numericJsonScalar((entry as any)?.percentage);
    const basisPoints = Math.round(percentage * 100);
    if (!Number.isInteger(place) || place < 1 || place > 2_147_483_647) return null;
    if (
      !Number.isFinite(percentage) ||
      percentage <= 0 ||
      !Number.isSafeInteger(basisPoints) ||
      basisPoints <= 0
    ) {
      return null;
    }
    if (seen.has(place)) continue;
    seen.add(place);
    places.push({ place, percentage });
  }
  if (!seen.has(1)) return null;

  return places.sort((a, b) => a.place - b.place);
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
 * Returns null when the exact contract cannot be proved: either a Spin whose
 * multiplier has no canonical tier, or a non-Spin with no usable stored
 * structure. Callers must fail closed in both cases; they may not infer a
 * winner-take-all ladder.
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

// MTT field ladders are generated by fn_ca_payout_structure inside the atomic
// database entry close. The retired TypeScript generator used a different paid
// depth and dumped percentage rounding on the last place. Do not reconstruct a
// funded ladder here; consume the close receipt and its stored snapshot.

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ON A SPIN, THE TIER OUTRANKS THE COLUMN (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This used to prefer the stored column over the tier for EVERY format, and
 * fall back to the spec only when the column was missing or corrupt. For an
 * MTT that is right and stays right: the ladder is the operator's to choose,
 * and a stored structure is a decision, not a cache.
 *
 * A SPIN HAS NO SUCH DECISION TO STORE. Its split is a pure function of the
 * multiplier — `spinTier(m).payouts` — and nobody, operator included, may
 * author a different one. So a stored structure on a Spin is only ever a COPY
 * of the tier, and a copy that disagrees with its source is not a preference
 * being expressed, it is a stale value. Preferring it is preferring the lie.
 *
 * It is not hypothetical. A Spin is created carrying a winner-take-all
 * PLACEHOLDER, because the tier is drawn at start and writing the true ladder
 * at creation would leak the multiplier to the lobby. TournamentManagerBase
 * rewrites the column from the drawn tier at start — and where that write
 * fails (dea62e98, a374cdd3, 78181713 are the three known), or where an
 * in-memory copy of the row was taken before it, the placeholder is what the
 * old rule paid by. Measured live on 2026-08-31: 62 COMPLETED spins at 10x or
 * above still carry `[{place:1,percentage:100}]`, and every one of them paid
 * 100% of the pool to first place when the tier owed second (and sometimes
 * third) a share.
 *
 * ─── THE RULE ───────────────────────────────────────────────────────────────
 *
 *   1. Spin WITH a multiplier the ladder knows  ->  the tier, always.
 *   2. Spin whose multiplier is unknown to the ladder (not yet drawn, or a
 *      retired tier such as the old 500x)       ->  null. The stored value may
 *      be the creation-time placeholder, so it is not proof of a payout.
 *   3. Anything else                            ->  the stored column, then
 *      null. Unchanged, and deliberately so: an operator's MTT ladder still
 *      wins over anything derived.
 *
 * Rule 1 is safe in the only direction that matters. For every sub-10x tier
 * the derived structure and an honest stored one are the SAME value
 * ([{1,100}]), so nothing moves on ~98.9% of spins; where they differ, the
 * tier is the one the reserve pool actually settled against.
 */
export function resolvePayoutStructure(
  t: PayoutSubject | null | undefined,
  fieldSize?: number | null
): PayoutPlace[] | null {
  if (isSpinTournament(t)) {
    /* A Spin's multiplier is the draw. If that draw is not durably persisted
       or no longer maps to a canonical tier, the creation-time WTA placeholder
       is not a payout contract. Returning null leaves the event COMPLETING
       until the already-scheduled row repair restores the exact draw. */
    const tier = spinPayoutStructure(t?.spin_multiplier);
    return tier ? trimStructureToField(tier, fieldSize) : null;
  }
  const stored = parsePayoutStructure(t?.payout_structure);
  if (stored) return trimStructureToField(stored, fieldSize);
  return null;
}

/**
 * Does a Spin's stored column disagree with the tier that outranks it?
 *
 * Exported for diagnostics rather than used by the resolver: this module
 * deliberately has no imports beyond `spinSpec`, so it cannot report an error
 * itself. A caller that has a reporter can ask this and say so out loud —
 * a disagreement means the start-time rewrite did not land, which is a bug
 * upstream of the payout even though the payout is now protected from it.
 */
export function spinStoredStructureIsStale(t: PayoutSubject | null | undefined): boolean {
  if (!isSpinTournament(t)) return false;
  const tier = spinPayoutStructure(t?.spin_multiplier);
  if (!tier) return false;
  const stored = parsePayoutStructure(t?.payout_structure);
  if (!stored) return false;
  if (stored.length !== tier.length) return true;
  return tier.some(
    (p, i) => stored[i]?.place !== p.place || stored[i]?.percentage !== p.percentage
  );
}

/**
 * How much of the pool is still unspent.
 *
 * The arithmetic invariant behind the historical regression: a prize pool
 * cannot pay out more than it holds. The atomic settlement path now refuses an
 * unavailable structure instead of using this value as a guessed prize, but
 * this helper still captures the maximum unspent amount for diagnostics and
 * regression tests.
 */
export function remainingPoolAfterAwards(prizePool: number, alreadyAwarded: number): number {
  const pool = Number.isFinite(prizePool) && prizePool > 0 ? prizePool : 0;
  const paid = Number.isFinite(alreadyAwarded) && alreadyAwarded > 0 ? alreadyAwarded : 0;
  return Math.max(0, Math.round((pool - paid) * 100) / 100);
}
