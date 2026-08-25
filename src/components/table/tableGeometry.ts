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

/**
 * The hero's button steps much further in than everyone else's.
 *
 * Dan 2026-08-23: "button needs to be raised up for the hero as well. it
 * currently lays on top of the avatar."
 *
 * Not a style preference - it is geometry. Every other seat is off to a side,
 * so the 0.28 x-factor carries its button sideways, clear of the art. The hero
 * sits at x=50, dead centre of the bottom rail, so its x term is
 * (50 - 50) * 0.28 = 0 and the button can only move on ONE axis. At y 0.16 it
 * lands 8% of the table above the seat centre, which is inside the hero's own
 * avatar: the hero box is 1.3333x everyone else's and its bust art rises about
 * 160px from there. The button had nowhere to go but onto the player's head.
 */
export const DEALER_BUTTON_FACTOR_HERO = { x: 0.28, y: 0.42 } as const;

/** A seat on the bottom rail, where the button and chips can only travel up. */
export function isBottomSeat(seat: Pos): boolean {
  return seat.y > 80;
}

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
  /* Derived from the seat rather than taken as an argument, so every existing
     caller keeps working and no call site can forget to pass it. */
  const factor = isBottomSeat(seat) ? DEALER_BUTTON_FACTOR_HERO : DEALER_BUTTON_FACTOR;

  const dx = 50 - seat.x;
  const dy = 50 - seat.y;

  // Rotate the direction vector by ~22.5 degrees clockwise so the button sits
  // to the side of the bet chips instead of directly in their path.
  const angle = 22.5 * (Math.PI / 180);
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);

  const rDx = dx * cosA - dy * sinA;
  const rDy = dx * sinA + dy * cosA;

  return {
    x: seat.x + rDx * factor.x,
    y: seat.y + rDy * factor.y,
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

/**
 * Extra rail for a bottom-rail seat, the hero's included.
 *
 * Dan 2026-08-23: "chips for the hero need to be pushed out farther in front of
 * them, they are literally on top of the avatar."
 *
 * Same cause as the button above. A side seat's chips travel diagonally and
 * clear the art within the standard inset; the hero's travel straight up from
 * x=50 into an avatar that is a third larger than everyone else's and whose art
 * rises well past its own box. The rail is measured from the seat CENTRE, and
 * for this one seat the thing it has to clear is much taller.
 *
 * Dan 2026-08-25: "hero's chips are put too far in front of them, needs to be
 * closer to the rail." 46 was set BEFORE CHIP_RAIL_SCALE moved into this module
 * (2026-08-24) — at that point the stylesheet's own 1.82 was applied on top of
 * it, so the number here was tuned against a rail that has since been rescaled
 * underneath it. 46 * 1.82 = 84px of hero-only extra, on top of the common rail:
 * that is the "on the felt, nowhere near the player" picture in the screenshot.
 *
 * 16 * 1.82 = ~29px of extra, which is still more than the height the hero's
 * oversized avatar art rises past its own box (the original complaint), and
 * still a strictly positive extra, which tests/unit/chipRail.test.ts requires.
 * Do NOT set this to 0 — the hero's chips then sit on the avatar again.
 */
export const CHIP_RAIL_BOTTOM_EXTRA_PX = 16;

/**
 * The rail's scale factor.
 *
 * Dan 2026-08-24: "chips from players on the left and right sides need to be
 * put on the table farther. they are too close to the rail."
 *
 * They were, and this number is why it was invisible from inside this module.
 * Every inset computed here was multiplied by 1.82 again in CSS
 * (`.table-page .seat__bet-chips` in TableVisualHotfix.css), and that same CSS
 * rule ALSO clamped the horizontal component to +/-52px (44 and 38 at the two
 * mobile breakpoints). So the module said "one rail, equal for every seat", the
 * stylesheet agreed for the top and bottom seats, and quietly cut the left and
 * right seats to less than half the distance - which is exactly the picture
 * Dan is describing, and exactly the property tests/table-geometry-chips.test.ts
 * asserts and could never have caught, because the clamp was not in the maths
 * it tests.
 *
 * The scale now lives here, with the rest of the geometry, and the stylesheet
 * consumes --bet-offset-x/y unmodified. Same numbers for the seats that were
 * already right; the side seats get the rail they were always supposed to have.
 */
export const CHIP_RAIL_SCALE = 1.82;

/**
 * The rail a seat gets when it is LEVEL WITH THE COMMUNITY BOARD.
 *
 * The board holds the middle 68% of the felt (TablePage.css,
 * `.table-surface .community-cards` width: 68%), so a side seat at x=10.5%
 * has only about 5% of the table's width between its own centre and the
 * board's edge. A seat sitting at the board's height therefore cannot be given
 * the full rail: at 1.82 its bets land on the cards, which is what happened in
 * production before the clamp this replaces (a chip covering the 9d).
 *
 * It is a smaller SCALE rather than a clamped x-axis. Truncating one axis
 * turns the offset from "step along the line to the middle" into "step
 * somewhere else", and on a phone-width table the board leaves so little room
 * that the x term clamps to zero - the chips stop travelling toward the felt
 * at all and end up behind the dealer button. Shrinking the scale keeps the
 * direction exactly right and only shortens the walk.
 */
export const CHIP_RAIL_SCALE_BOARD_LEVEL = 1.15;

/**
 * A board-level seat's rail may never fall behind that seat's own button.
 *
 * The two are scaled by different things and they cross over. The button steps
 * a FRACTION of the way to the middle (DEALER_BUTTON_FACTOR, 0.28), so its
 * travel grows without limit as the table gets wider. The rail is a pixel inset
 * that is CLAMPED at 64px (chipRailInset), so it stops growing. On a desktop
 * table the button therefore overtakes the shortened board-level rail and ends
 * up standing in front of the chips it is supposed to stand behind - which is
 * the exact regression tests/table-geometry-chips.test.ts was written for, and
 * it caught it.
 *
 * So the board reduction is a preference and this is the rule: shorten the rail
 * for the board, but never past the button, plus enough clear air that the two
 * do not touch.
 */
export const CHIP_RAIL_MIN_CLEARANCE_PX = 16;

/**
 * A seat this close to the table's mid-height is LEVEL WITH THE BOARD.
 *
 * The clamp being deleted above was not paranoia - it was a live fix. On
 * 4-max and 5-max, side seats sit at y=45 and y=55, i.e. at the board's own
 * height, and an unclamped rail put their bets on top of the community cards
 * (seen in production: a chip covering the 9d). 8-max and 9-max have the same
 * problem at y=52 and y=58.
 *
 * But it applied that clamp to EVERY side seat, including the ones nowhere
 * near the board - 6-max sits its side seats at y=33 and y=66, a sixth of the
 * table clear of it. One flat horizontal limit cannot tell those apart. This
 * can: only a seat inside the band gives up any of its rail, and it gives up
 * only as much as the board actually needs.
 */
export const BOARD_BAND_PCT = 10;

/**
 * The HERO's chair: bottom rail, dead centre.
 *
 * `isBottomSeat` is true for the two bottom-CAP seats as well (9-max seats 2
 * and 9, at x=19 and x=81), and CHIP_RAIL_BOTTOM_EXTRA_PX was never about them.
 * Read its docstring: every word is about an avatar a third larger than
 * everyone else's, sitting at x=50 where the rail can only travel on one axis.
 * A bottom-cap seat has an ordinary avatar and travels diagonally like any
 * other side seat.
 *
 * Handing them the hero's 46px extra on top of CHIP_RAIL_SCALE pushed them
 * into the `len * 0.8` ceiling on a phone-width table, where they SATURATED:
 * the seat holding the button and the same seat without it came out at exactly
 * the same distance, so the button no longer stood in front of its own chips.
 *
 * Deliberately NOT folded into isBottomSeat, which the dealer button also
 * uses. The button's hero exception has its own reason (DEALER_BUTTON_FACTOR_
 * HERO) and its own tuning, and narrowing it here would move the button on two
 * seats nobody asked about.
 */
export function isHeroRailSeat(seat: Pos): boolean {
  return isBottomSeat(seat) && Math.abs(seat.x - 50) < 10;
}

/** True for a seat on the left or right rail rather than the top or bottom. */
export function isSideSeat(seat: Pos): boolean {
  return Math.abs(seat.x - 50) > 25;
}

/** True for a seat sitting at the community board's own height. */
export function isBoardLevelSeat(seat: Pos): boolean {
  return isSideSeat(seat) && Math.abs(seat.y - 50) <= BOARD_BAND_PCT;
}

/**
 * Where a chip finishes when it is collected, as a fraction of seat-to-centre.
 *
 * Raised from 0.66 to 0.9 on 2026-08-24, together with CHIP_RAIL_SCALE.
 *
 * 0.66 was chosen when the rail this module returned was the FINAL resting
 * place. It was not: the stylesheet multiplied it by 1.82 before painting it,
 * and did not touch --collect-dx/dy, so the two halves of the sweep were
 * measured on different scales and the chips never actually landed on the 0.66
 * mark they were aimed at. With the scale folded in here, a seat's rail can
 * reach 0.8 of the way to the middle by itself (see the `len * 0.8` cap), so an
 * endpoint at 0.66 would sit BEHIND where the chips already are and the sweep
 * would run backwards - furthest for the dealer, who starts furthest out.
 *
 * 0.9 is in front of every seat's rail, converges every seat on one point, and
 * is a truer description of what the animation is for: the chips are going to
 * the pot, which is in the middle.
 */
export const CHIP_COLLECT_FRACTION = 0.9;

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
  const bottomExtra = isHeroRailSeat(seat) ? CHIP_RAIL_BOTTOM_EXTRA_PX : 0;
  // A seat level with the board is the one seat that cannot have the common
  // rail - see CHIP_RAIL_SCALE_BOARD_LEVEL. Every other seat gets the same one.
  const scale = isBoardLevelSeat(seat) ? CHIP_RAIL_SCALE_BOARD_LEVEL : CHIP_RAIL_SCALE;
  let inset = (chipRailInset(size, isDealer) + bottomExtra) * scale;

  // Never behind the button - see CHIP_RAIL_MIN_CLEARANCE_PX. Only the
  // shortened board-level rail can fall foul of this; the full rail clears the
  // button at every table size the app renders.
  if (isBoardLevelSeat(seat)) {
    const btn = dealerButtonPosition(seat);
    const btnPx = Math.hypot(((btn.x - seat.x) * size.w) / 100, ((btn.y - seat.y) * size.h) / 100);
    inset = Math.max(inset, btnPx + CHIP_RAIL_MIN_CLEARANCE_PX);
  }

  inset = Math.min(inset, len * 0.8);
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
