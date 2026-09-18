/**
 * Fixed-field creation helpers for SNGs and Spins.
 * MTTs and satellites have no maximum entry count. Their minimum field is a
 * launch threshold, and their final payouts derive from actual funded entries.
 */

import type { PayoutEntry } from '../services/PayoutEngine';

/** Normalize a fixed SNG/Spin seat count. Never use this as an MTT limit. */
export function fieldCapFor(raw: string | number | null | undefined): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 2 ? n : 2;
}

/** Fixed fields start full; uncapped MTTs default to a three-player start. */
export function minPlayersFor(startsWhenFull: boolean, fieldCap: number | null): number {
  return startsWhenFull ? fieldCapFor(fieldCap) : 3;
}

/**
 * Trim a payout ladder to the seats that exist, and renormalise to 100.
 *
 * THE CAP IS THE FIELD, NOT THE FIELD MINUS ONE (2026-08-31). A ladder may pay
 * EVERY seat: a Spin & Go is three-handed and its 25x, 50x and 100x tiers pay
 * 80 / 12 / 8 across all three, and 21 such tournaments are sitting completed
 * and paid in `tournaments` right now. The `- 1` that used to be here existed
 * for exactly one reason - `fn_create_tournament` refused
 * `paid_places >= max_players` - and it was never a rule about poker. Fed the
 * Spin ladder at a three-seat field it dropped third place and rescaled the
 * rest, so the operator was shown, and the row was written, as 86.96 / 13.04.
 * The RPC now agrees (`>` , not `>=`), so the trim is only what it says: a
 * structure cannot pay a place nobody can reach.
 *
 * The renormalisation is not optional: `TournamentService` refuses a ladder that
 * does not total 100, so a trimmed-but-unscaled ladder would swap one refusal
 * for another. A ladder that already fits is returned untouched, so a preset
 * that sums to 100 is never rounded through this path at all.
 *
 * Rounding is to two decimals with the whole drift pushed onto first place,
 * which is what `PayoutEngine.normalizePayouts` does — first place is the one
 * number large enough to absorb a cent without changing what a player reads.
 */
export function capPaidPlaces(entries: PayoutEntry[], fieldCap: number | null): PayoutEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) return [{ place: 1, percentage: 100 }];
  /* A LADDER THAT PAYS NOTHING IS CHECKED BEFORE THE TRIM, not inside it
     (2026-08-31). It used to be checked only on the path that sliced, so while
     the cap was `field - 1` a two-place all-zero ladder was always sliced and
     always caught. Raising the cap to the field made that same ladder FIT, and
     a fitting ladder is returned untouched — so 0 / 0 would have been sent to
     a service that refuses anything not totalling 100, as a refusal the
     operator cannot see the cause of. Winner-take-all is the same net it has
     always been. */
  const declared = entries.reduce((a, e) => a + (Number(e.percentage) || 0), 0);
  if (!(declared > 0)) return [{ place: 1, percentage: 100 }];

  // An MTT has no field ceiling. Its provisional/final ladder is not trimmed
  // to a legacy capacity or an artificial substitute.
  if (fieldCap === null) return entries;

  const maxPlaces = Math.max(1, fieldCapFor(fieldCap));
  if (entries.length <= maxPlaces) return entries;

  const kept = entries.slice(0, maxPlaces);
  const sum = kept.reduce((a, e) => a + (Number(e.percentage) || 0), 0);
  if (sum <= 0) return [{ place: 1, percentage: 100 }];

  const scaled = kept.map((e) => ({
    place: e.place,
    percentage: Math.round(((Number(e.percentage) || 0) / sum) * 10000) / 100,
  }));
  const drift = Math.round((100 - scaled.reduce((a, e) => a + e.percentage, 0)) * 100) / 100;
  scaled[0] = { ...scaled[0], percentage: Math.round((scaled[0].percentage + drift) * 100) / 100 };
  return scaled;
}
