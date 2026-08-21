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


/*
 * betChipFactor(), betChipPosition(), chipCollectFactor() and
 * CHIP_COLLECT_END_FACTOR were removed on 2026-08-21. They scaled each axis by
 * how far the seat sat from centre ON THAT AXIS, which cannot produce an equal
 * distance for every seat - see THE CHIP RAIL at the bottom of this file for
 * why, and betChipOffsetPx() for what replaced them. Leaving them here would
 * have left a second, wrong answer to "where do the chips go" next to the
 * right one.
 */

/** Absolute position of the dealer button for a seat, in scaler percentages. */
export function dealerButtonPosition(seat: Pos): Pos {
  return {
    x: seat.x + (50 - seat.x) * DEALER_BUTTON_FACTOR.x,
    y: seat.y + (50 - seat.y) * DEALER_BUTTON_FACTOR.y,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE CHIP RAIL
   ═══════════════════════════════════════════════════════════════════════════
   Dan 2026-08-21: "ALL CHIPS FOR ALL PLAYERS NEED TO BE PLACED THE SAME
   DISTANCE FROM THEM REGARDLESS OF SEAT POSITION. IMAGINE AN IMAGINARY RAIL
   THAT GOES ALL AROUND THE TABLE EQUALLY, AND ALL CHIPS SHOULD BE IN THE SAME
   AREA, ABOVE THAT LINE."

   WHY THE OLD MATH COULD NOT DO THAT. The offset was computed per axis as
   `(50 - seat.x) * width * factor` and `(50 - seat.y) * height * factor`. Each
   axis was scaled by how far that seat happened to be from the centre ON THAT
   AXIS, so the distance from seat to chips depended entirely on where the seat
   sat:

     - top-centre seat  (seat.x = 50): dx = 0, so the chips dropped straight
       down by a large amount and did not move sideways at all;
     - side seat        (seat.y = 50): dy = 0, so they slid inward by a large
       amount and did not move vertically at all;
     - corner seat:     a moderate amount of both, i.e. a different distance
       again.

   Multiplying by a constant factor keeps the chips on a concentric ellipse,
   and a concentric ellipse is NOT a constant distance from the original: the
   gap is widest where the curve is flattest. On a table this much taller than
   it is wide that difference is plainly visible, which is what the screenshot
   shows.

   WHAT THIS DOES INSTEAD. Take the inward direction in PIXELS, normalise it,
   and step a fixed number of pixels along it. Every seat's chips then sit the
   same visual distance inside their player, which is exactly a rail running
   parallel to the seats the whole way round. */

/** Chips rest this far inside the player, in px, at a mid-size table. */
export const CHIP_RAIL_INSET_PX = 46;

/**
 * Extra clearance when the seat also holds the dealer button, so the reading
 * order out from the player stays: player, button, chips.
 */
export const CHIP_RAIL_DEALER_EXTRA_PX = 20;

/** Where a chip finishes when it is collected, as a fraction of seat-to-centre. */
export const CHIP_COLLECT_FRACTION = 0.66;

export interface Size {
  w: number;
  h: number;
}

/**
 * The rail inset for a given table size.
 *
 * A flat 46px is right on a phone-sized table and mean on a large one, so it
 * scales with the table's SHORTER side - the axis that actually constrains how
 * much room there is between a seat and the felt - and is clamped so it can
 * never collapse to nothing or swallow the middle of the table.
 */
export function chipRailInset(size: Size, isDealer: boolean): number {
  const base = Math.min(size.w, size.h) * 0.11;
  const clamped = Math.max(30, Math.min(base, 64));
  return clamped + (isDealer ? CHIP_RAIL_DEALER_EXTRA_PX : 0);
}

/**
 * Pixel offset from a seat to its resting bet chips.
 *
 * Same distance for every seat, measured along the line to the centre of the
 * table. Returns pixels because the caller positions with translate().
 */
export function betChipOffsetPx(seat: Pos, size: Size, isDealer: boolean): Pos {
  const dxPx = ((50 - seat.x) * size.w) / 100;
  const dyPx = ((50 - seat.y) * size.h) / 100;
  const len = Math.hypot(dxPx, dyPx);
  // A seat sitting on the centre has no inward direction to step along.
  if (!Number.isFinite(len) || len < 1) return { x: 0, y: 0 };

  // Never step more than most of the way to the middle, however small the
  // table gets - the chips belong to a player, not to the pot.
  const inset = Math.min(chipRailInset(size, isDealer), len * 0.8);
  return {
    x: Math.round((dxPx / len) * inset),
    y: Math.round((dyPx / len) * inset),
  };
}

/**
 * How much FURTHER a chip travels when collected into the pot.
 *
 * The chip already sits at betChipOffsetPx(); the collect keyframe translates
 * it by this again. Expressed as the remainder to a common endpoint so every
 * seat's chips converge on the same place regardless of where they started.
 */
export function chipCollectOffsetPx(seat: Pos, size: Size, isDealer: boolean): Pos {
  const dxPx = ((50 - seat.x) * size.w) / 100;
  const dyPx = ((50 - seat.y) * size.h) / 100;
  const rest = betChipOffsetPx(seat, size, isDealer);
  return {
    x: Math.round(dxPx * CHIP_COLLECT_FRACTION - rest.x),
    y: Math.round(dyPx * CHIP_COLLECT_FRACTION - rest.y),
  };
}
