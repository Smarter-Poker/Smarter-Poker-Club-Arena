/**
 * What the tile-view action band sends for its sizing buttons.
 *
 * Every amount here is a raise-TO absolute, the unit the engine's `raise`
 * action takes and the unit `raiseBounds` ("minTo:maxTo:bb") is reported in.
 *
 * WHY THIS IS ITS OWN FILE (launch audit 2026-10-05). The band computed its
 * sizes inline and got two of them wrong:
 *
 *   - "All In" sent `raise` to `heroStack`, the chips BEHIND. A raise-to has to
 *     include what the hero already has in front, so with any chips committed
 *     (a blind, an earlier bet) it under-raised, and the engine refused it
 *     outright whenever that number fell below the minimum raise.
 *   - "1/2 Pot" and "Pot" sent `toCall + (pot + 2 * toCall) * f`, which is not a
 *     raise-to, and capped it at the stack behind. From the small blind and in
 *     most re-raise spots it landed under the minimum and was refused.
 *
 * The single-table panel has always used `currentBet + (pot + toCall) * f`
 * (ActionPanel `potSizedRaiseTo` at f = 1). This is the same sizing, clamped
 * to the bounds the engine reported, so a button can never send a raise the
 * engine has already said is illegal.
 */

export interface TileRaiseBounds {
  minTo: number;
  maxTo: number;
  bb: number;
}

/** Parse "minTo:maxTo:bb". Null means no raise is legal right now. */
export function parseTileRaiseBounds(raw: string | undefined): TileRaiseBounds | null {
  const parts = (raw || '').split(':').map(Number);
  if (parts.length !== 3 || !parts.every((n) => Number.isFinite(n))) return null;
  const [minTo, maxTo, bb] = parts;
  if (!(minTo > 0) || maxTo < minTo) return null;
  return { minTo, maxTo, bb };
}

const toCents = (n: number) => Math.round(n * 100) / 100;

/**
 * Raise-TO for a fraction of the pot: call first, then raise that fraction of
 * the pot the call creates. Null when no raise is legal.
 */
export function tilePotRaiseTo(
  fraction: number,
  spot: { pot: number; toCall: number; currentBet: number },
  bounds: TileRaiseBounds | null
): number | null {
  if (!bounds) return null;
  const pot = Number.isFinite(spot.pot) ? Math.max(0, spot.pot) : 0;
  const toCall = Number.isFinite(spot.toCall) ? Math.max(0, spot.toCall) : 0;
  const currentBet = Number.isFinite(spot.currentBet) ? Math.max(0, spot.currentBet) : 0;
  const raiseTo = toCents(currentBet + (pot + toCall) * fraction);
  return Math.min(bounds.maxTo, Math.max(bounds.minTo, raiseTo));
}

/**
 * Raise-TO that puts the whole stack in, or null when the engine's ceiling is
 * below it (pot-limit and fixed-limit cap the raise under the stack, and a
 * button labelled All In must not send less than all of it).
 */
export function tileAllInTo(
  allInTo: number | undefined,
  bounds: TileRaiseBounds | null
): number | null {
  if (!bounds) return null;
  if (typeof allInTo !== 'number' || !Number.isFinite(allInTo) || allInTo <= 0) return null;
  if (bounds.maxTo + 0.005 < allInTo) return null;
  return Math.max(bounds.minTo, Math.min(bounds.maxTo, toCents(allInTo)));
}
