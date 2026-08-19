/**
 * Maximum seats per game variant — Dan, 2026-08-19, verbatim:
 *
 *   "YOU CAN'T HAVE 8 MAX PLO6. ITS ALWAYS 6 MAX FOR PLO 6 AND 7 MAX FOR PLO5"
 *
 * WHY THIS FILE EXISTS
 *
 * Nothing in the codebase enforced a seat cap per variant. The create-table
 * modal offered the same fixed list — Heads Up (2) / 6-Max / Full Ring (9) —
 * for every game, so a PLO6 table could be created at 9-max with one click.
 * Production reflects that: 76 plo6 tables at 7-max, and 10,054 plo5 tables at
 * 8- or 9-max.
 *
 * IT IS ALSO A DEALING CONSTRAINT, NOT ONLY A HOUSE RULE
 *
 * Hole cards come out of one 52-card deck alongside a 5-card board:
 *
 *   plo6 @  6 seats = 36 + 5 = 41   (11 spare)   <- the rule
 *   plo6 @  7 seats = 42 + 5 = 47   ( 5 spare)
 *   plo6 @  9 seats = 54 + 5 = 59   OVERDRAWS THE DECK by 7
 *   plo5 @  7 seats = 35 + 5 = 40   (12 spare)   <- the rule
 *   plo5 @  9 seats = 45 + 5 = 50   ( 2 spare)
 *
 * `PokerEngine.deal()` THROWS 'Not enough cards in deck' when it cannot fill a
 * request, so an over-seated PLO6 table does not degrade — it fails mid-hand.
 * The caps keep every variant comfortably inside the deck instead of two cards
 * away from it.
 */

export type SeatCappedVariant = string;

/** Seats a variant may never exceed. Anything absent uses the default. */
const MAX_SEATS_BY_VARIANT: Record<string, number> = {
  plo6: 6,
  plo5: 7,
};

/** Full ring, for every variant that has no tighter constraint. */
export const DEFAULT_MAX_SEATS = 9;

/** The hard seat ceiling for a variant. */
export function maxSeatsForVariant(variant: SeatCappedVariant | null | undefined): number {
  if (!variant) return DEFAULT_MAX_SEATS;
  const key = String(variant).toLowerCase();
  return MAX_SEATS_BY_VARIANT[key] ?? DEFAULT_MAX_SEATS;
}

/** True when this seat count is legal for the variant. */
export function isSeatCountLegal(variant: SeatCappedVariant, seats: number): boolean {
  return seats >= 2 && seats <= maxSeatsForVariant(variant);
}

/** Clamp a requested seat count into the legal range for the variant. */
export function clampSeatsForVariant(variant: SeatCappedVariant, seats: number): number {
  const max = maxSeatsForVariant(variant);
  if (!Number.isFinite(seats) || seats < 2) return Math.min(2, max);
  return Math.min(Math.floor(seats), max);
}

/** The seat options a table-builder UI may offer for this variant. */
export function seatOptionsForVariant(
  variant: SeatCappedVariant
): Array<{ value: number; label: string }> {
  const max = maxSeatsForVariant(variant);
  return [
    { value: 2, label: 'Heads Up (2)' },
    { value: 6, label: '6-Max' },
    { value: 7, label: '7-Max' },
    { value: 9, label: 'Full Ring (9)' },
  ].filter((o) => o.value <= max);
}
