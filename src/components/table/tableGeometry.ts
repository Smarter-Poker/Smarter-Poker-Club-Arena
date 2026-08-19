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

/**
 * Where a bet chip ENDS UP when it is collected into the pot, as a factor of
 * the seat-to-centre run.
 *
 * The chip is already sitting at `betChipFactor()` from its seat, and the
 * collect keyframe translates it by a FURTHER `--collect-dx`. So the endpoint
 * is (bet factor + collect factor), and the collect offset has to be derived
 * from the bet offset — not multiplied by it.
 *
 * It used to be a flat `betOffset * 2`, which put the endpoint at 3x the bet
 * factor. That happened to land at 0.66 while every seat shared one 0.22
 * factor. The moment the dealer seat's chips moved out to 0.38 (item 8), the
 * same multiply sent them to 3 x 0.38 = 1.14 — straight past the centre of the
 * table and out the other side. Deriving the collect offset instead keeps the
 * endpoint identical for every seat, dealer or not, and reproduces the old
 * 0.44 collect offset exactly for the ordinary 0.22 case.
 */
export const CHIP_COLLECT_END_FACTOR = 0.66;

/** How far a chip must still travel to reach the collect endpoint. */
export function chipCollectFactor(isDealer: boolean): { x: number; y: number } {
  const bet = betChipFactor(isDealer);
  return {
    x: Math.max(0, CHIP_COLLECT_END_FACTOR - bet.x),
    y: Math.max(0, CHIP_COLLECT_END_FACTOR - bet.y),
  };
}
