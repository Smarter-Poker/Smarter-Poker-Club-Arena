/**
 * Table geometry shared by the seats, the dealer button and the bet chips.
 *
 * Everything here is expressed as a FACTOR of the distance from a seat toward
 * the centre of the table (50%, 50%), per axis. A factor of 0 is on the seat, 1
 * is dead centre. The table is much taller than it is wide, so the two axes
 * deliberately use different factors: an equal y-factor flings a marker far up
 * or down the felt and away from the seat it belongs to.
 *
 * This lives in one module because the dealer button and the bet chips have to
 * agree about who stands where. They previously did not: the button used
 * 0.28/0.16 and the chips a flat 0.22, so on the side seats the BUTTON sat
 * further toward the felt than the chips it was supposed to stand behind.
 */

export interface Pos {
  x: number;
  y: number;
}

/** Dealer button: tucks in toward the felt, stays close to its seat vertically. */
export const DEALER_BUTTON_FACTOR = { x: 0.28, y: 0.16 } as const;

/** Bet chips for an ordinary seat: close to the player, not out near the middle. */
export const BET_CHIP_FACTOR = { x: 0.22, y: 0.22 } as const;

/**
 * Clearance the chips must keep BEYOND the dealer button when the same seat
 * holds both. Dan 2026-08-19, bug list item 8: "chips must always be in front
 * of the user (in front of the button if they're the button)". The button is
 * 28px across, so a tenth of the seat-to-centre run is a comfortable gap at
 * every table size without throwing the chips out into the felt.
 */
export const DEALER_CHIP_CLEARANCE = 0.1;

/**
 * How far the bet chips sit from their seat, per axis.
 *
 * For the seat holding the button the chips step PAST it, so the reading order
 * out from the player is always: player, then button, then chips. Taking the
 * max with the ordinary factor means a seat whose button factor is already
 * small (the hero, bottom-centre, where the button barely moves vertically)
 * does not pull its chips back in toward the player.
 */
export function betChipFactor(isDealer: boolean): { x: number; y: number } {
  if (!isDealer) return { ...BET_CHIP_FACTOR };
  return {
    x: Math.max(BET_CHIP_FACTOR.x, DEALER_BUTTON_FACTOR.x + DEALER_CHIP_CLEARANCE),
    y: Math.max(BET_CHIP_FACTOR.y, DEALER_BUTTON_FACTOR.y + DEALER_CHIP_CLEARANCE),
  };
}

/** Absolute position of the dealer button for a seat, in scaler percentages. */
export function dealerButtonPosition(seat: Pos): Pos {
  return {
    x: seat.x + (50 - seat.x) * DEALER_BUTTON_FACTOR.x,
    y: seat.y + (50 - seat.y) * DEALER_BUTTON_FACTOR.y,
  };
}

/** Absolute resting position of a seat's bet chips, in scaler percentages. */
export function betChipPosition(seat: Pos, isDealer: boolean): Pos {
  const f = betChipFactor(isDealer);
  return {
    x: seat.x + (50 - seat.x) * f.x,
    y: seat.y + (50 - seat.y) * f.y,
  };
}
