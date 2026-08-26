/**
 * Table geometry shared by the seats, the dealer button and the bet chips.
 *
 * Two markers live on this felt and they belong to the same player: the chips
 * that player has bet, and the puck that says they are the dealer. This module
 * is the single answer to "where do those two go", because when they were
 * computed in two places they disagreed - the button used factors of 0.28/0.16
 * and the chips a flat 0.22, so on the side seats the BUTTON sat further onto
 * the felt than the chips it was supposed to stand behind.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * REWRITTEN 2026-08-25 (Dan, mobile pass items 11 and 13). Read this before
 * changing a number; four separate exceptions were deleted here and every one
 * of them will look reasonable again the next time a single seat looks wrong.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Item 11: "The button must always be on the table, and never on the rail."
 * Item 13: "All chips ... should all appear to be in the same position and
 *           distance in front of them. Imagine an imaginary oval, and all chips
 *           must appear equally on that line for all players at all tables.
 *           Those chips must never be in the same position on the table where
 *           the button lands."
 *
 * Round two of the same pass, after Dan read it back on a real phone:
 *
 * Item 8:  "The button is too close to the rail and should be pushed a little
 *           farther into the table, so it's 'in front of the player' without
 *           touching the rail."
 *
 * WHAT THIS NOW GUARANTEES, in order of precedence:
 *
 *   1. ONE RAIL. Every seat's chips rest the SAME number of pixels from that
 *      seat, measured along the line to the middle of the felt. There is no
 *      per-seat term left: no hero extra, no button-holder extra, no shorter
 *      walk for the seats level with the community board.
 *   2. ON THE FELT, AND THE BUTTON WITH DAYLIGHT. Neither marker may sit on the
 *      painted rail: any point that lands outside the felt window is projected
 *      back inside it - a closed form, exact for every seat of every ring, not
 *      a tuned constant. The BUTTON is projected to a boundary set further in
 *      still, because "inside the felt" is satisfied by a puck resting flat
 *      against the rail with nothing between them, and that is what item 8 is
 *      looking at. See BUTTON_FELT_DAYLIGHT_WIDTH_PCT.
 *   3. VISIBLY APART. The button is placed off the chip line by construction,
 *      and then, if the projection in (2) has pushed the two together, it is
 *      walked around the felt until they are at least MARKER_MIN_GAP_WIDTH_PCT
 *      of the table's width apart. Two markers, never one blob.
 *
 * (1) is the rule; (2) and (3) are guarantees that apply identically to every
 * seat. They move a seat's chips only where the seat's own ring position sits
 * OUTSIDE the painted felt - the hero at y=100 is 10.8% of the table's height
 * below the felt's bottom edge, and the bottom and top cap seats are outside it
 * too. Those seats get a longer walk than the common rail because the first
 * part of their walk is spent crossing the rail they are standing on. That is
 * a consequence of where the seat ring is painted, not a preference about that
 * seat, which is exactly the difference between this and what it replaced.
 *
 * WHAT WAS DELETED, and why it does not come back:
 *
 *   - CHIP_RAIL_BOTTOM_EXTRA_PX (+46px for the hero) and
 *     CHIP_RAIL_DEALER_EXTRA_PX (+20px for whoever holds the button): both
 *     handed one seat a different distance, which is the one thing item 13
 *     forbids. The hero's real problem was that its chips landed on the rail;
 *     guarantee (2) fixes that for every seat at once. The button-holder's real
 *     problem was that the two markers overlapped; guarantee (3) fixes that by
 *     moving the BUTTON, which is the marker that has somewhere else to be.
 *   - CHIP_RAIL_SCALE_BOARD_LEVEL (1.15 instead of 1.82 for a seat level with
 *     the board): the same defect from the other direction. Dan: "solve it by
 *     moving the whole rail for the whole table rather than by giving one seat
 *     a shorter walk." That is what CHIP_RAIL_WIDTH_PCT is - the longest rail
 *     that keeps EVERY seat's chips off the community cards, applied to every
 *     seat on every ring. It is shorter than the old rail for the seats that
 *     used to get the full 1.82; that is the trade, and it is the trade Dan
 *     asked for.
 *   - The `len * 0.8` ceiling: it saturated, so two seats with different rails
 *     came out at the same distance and the ordering guarantees silently
 *     stopped holding. A degeneracy guard survives (a seat sitting on the felt
 *     centre has no direction to walk in) but no production ring reaches it -
 *     the closest seat on any ring is over three rails away from the middle.
 */

export interface Pos {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE TABLE, MEASURED
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The felt window, as percentages of `.table-scaler`.
 *
 * These four numbers are `.table-surface` in TablePage.css, which is itself a
 * measurement of the painted skin (source felt x 20.3-79.6% / y 8.9-89.2% of
 * the 896x1200 composite, after the scaler's cover-crop to x [9.5%, 90.5%]).
 * Everything on this felt - both markers, and the guarantee that they are on
 * it - is expressed against these, so the geometry follows the artwork rather
 * than a pixel assumption about any one breakpoint.
 *
 * IF `.table-surface` MOVES, MOVE THESE IN THE SAME COMMIT. There is no way for
 * this module to read the stylesheet, and the failure is silent and ugly: the
 * markers stay inside a felt window that is no longer where the felt is.
 */
export const FELT_WINDOW = {
  left: 13.3,
  top: 8.9,
  width: 73.2,
  height: 80.3,
} as const;

/**
 * The scaler's own shape, width over height.
 *
 * `.table-scaler { aspect-ratio: 605 / 1000 }` - declared at every breakpoint in
 * TablePage.css and locked there, because the seat ring percentages are derived
 * from that box. It is needed here because a percentage of the width and a
 * percentage of the height are not the same distance: an angle, a rotation or
 * an "equal distance" computed in raw percentages is wrong by a factor of 1.65
 * on one axis. Every construction below converts into a square space first.
 *
 * Used only as the DEFAULT table shape for `dealerButtonPosition`, which is
 * handed a seat and nothing else by DealerButton.tsx. Anything that already
 * knows the measured size passes it, and then this constant does not
 * participate at all.
 */
export const NOMINAL_SCALER: Size = { w: 605, h: 1000 };

/* ═══════════════════════════════════════════════════════════════════════════
   THE RAIL
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * How far a seat's chips rest from that seat, as a percentage of the TABLE'S
 * WIDTH. One number, every seat, every ring.
 *
 * Derived, not tuned. The binding constraint is the community board, which is
 * the only thing on the felt that a bet can land on top of (seen in production
 * before this was worked out: a chip covering the 9d):
 *
 *     board width          68% of the felt (TablePage.css, `.community-cards`)
 *     board's left edge    49.9 - 0.34 * 73.2  =  25.0% of the scaler
 *     innermost seat       x = 10.5% (every ring puts its side seats there)
 *     room in between      14.5% of the scaler's width
 *     less half a chip     -2.0%   (a chip is ~4% of the table - see
 *                                   TableVisualHotfix.css, --cp-chip-size)
 *     less clear air       -1.0%
 *     ------------------------------------------------------------------
 *     rail                 11.5% of the table's width
 *
 * A side seat sitting at the board's own height walks straight at the cards, so
 * it is the seat this arithmetic is about; every other seat approaches at an
 * angle and has more room than this. Giving the shorter rail to only that one
 * seat is what the old CHIP_RAIL_SCALE_BOARD_LEVEL did, and it is what makes
 * one player's chips sit closer to them than everyone else's. The whole table
 * walks the shorter rail instead.
 *
 * A percentage of the WIDTH rather than of `min(w, h)` because the table is
 * always portrait and the width is both the short axis and the axis the board
 * constrains. On a hypothetical landscape table the two differ; no breakpoint
 * produces one.
 */
export const CHIP_RAIL_WIDTH_PCT = 12.5;

/**
 * Where a chip finishes when it is collected, as a fraction of seat-to-centre.
 *
 * The chips are going to the pot and the pot is in the middle, so every seat
 * converges on one point. 0.9 rather than 1.0 so the arriving stacks form a
 * pile around the pot rather than all landing on the same pixel.
 */
export const CHIP_COLLECT_FRACTION = 0.9;

/* ═══════════════════════════════════════════════════════════════════════════
   THE BUTTON
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * How far the button sits from its seat, as a fraction of the chip rail.
 *
 * Under 1 on purpose. Dan 2026-08-19: "chips must always be in front of the
 * user (in front of the button if they're the button)" - so the reading order
 * out from a player is player, button, chips, and the button is the marker that
 * stands nearer the player.
 *
 * 0.78 is the largest fraction that still clears a seat's own avatar on a phone
 * (a villain avatar is 52px at 375px against a rail of 11.5% x 347px = 40px, so
 * the button at 31px from the seat centre stands just off the artwork) while
 * leaving the two markers far enough apart for MARKER_MIN_GAP_WIDTH_PCT to be
 * satisfied by the rotation alone on every unclamped seat.
 */
export const BUTTON_RAIL_RATIO = 0.85;

/**
 * How far off the chip line the button starts, in degrees.
 *
 * The button and the chips walk out from the same seat toward the same middle,
 * so without an angle between them they walk the same line and the only thing
 * keeping them apart is the difference in their distances. That is a single
 * number's worth of separation and it disappears the moment either marker is
 * moved by the on-felt guarantee - which is exactly how the button ended up
 * standing in the chips before.
 *
 * At 36 degrees the two markers are
 *   rail * sqrt(1 + 0.78^2 - 2 * 0.78 * cos 36) = 0.598 * rail
 * apart before anything else happens, which is 6.9% of the table's width -
 * comfortably past the 6% minimum, with no per-seat term involved.
 */
export const BUTTON_ANGLE_DEG = 36;

/**
 * The closest the two markers may ever be, centre to centre, as a percentage
 * of the table's width.
 *
 * In PERCENT rather than pixels because both markers are now sized as a
 * proportion of the table (see TableVisualHotfix.css): a chip is 3.6% of the
 * table's width and the button 4.0%, so their radii are 1.8% and 2.0%, and they
 * touch at 3.8%. 6% leaves a chip's width of felt between them at every table
 * size, so they read as two markers rather than one smear.
 *
 * The button's mobile floor (17px, where the glyph would otherwise stop being
 * legible) makes it proportionally larger on a small phone - 2.45% of the width
 * rather than 2.0% - which the 6% still covers.
 */
export const MARKER_MIN_GAP_WIDTH_PCT = 6;

/**
 * How far inside the felt's edge a marker's CENTRE must stay, as a percentage
 * of the table's width.
 *
 * A marker is a disc, and "on the felt" has to mean the whole disc, not its
 * centre. 2.5% is half of the larger of the two markers at its largest relative
 * size (the button at its 17px mobile floor on a 347px table is 4.9% wide), so
 * neither disc can overhang the painted rail at any table size.
 */
export const FELT_MARKER_MARGIN_WIDTH_PCT = 2.5;

/**
 * How much CLEAR FELT the button keeps between its own edge and the painted
 * rail, as a percentage of the table's width.
 *
 * Dan 2026-08-25, round two item 8: "The button is too close to the rail and
 * should be pushed a little farther into the table, so it's 'in front of the
 * player' without touching the rail."
 *
 * FELT_MARKER_MARGIN_WIDTH_PCT keeps the whole disc on the felt, and that is
 * ALL it does - "inside" is satisfied by a puck resting flat against the rail
 * with nothing between them. That is not an edge case here, it is the common
 * case, because EVERY seat on every ring stands outside the painted felt: the
 * felt window is x 13.3..86.5 and y 8.9..89.2, while the ring puts its side
 * seats at x 10.5/89.5, its caps at y 6 and 82.5, and the hero at y 100. For
 * all of them the projection is what DECIDES where the button lands rather than
 * what corrects it, so it lands exactly on the boundary. Counted over the eight
 * production rings at the three table sizes the app renders - 132 seats - 75
 * had their button flat against the rail with zero daylight and 102 had less
 * than the half-puck below. That is the screen Dan is describing, and no amount
 * of asking "is it inside" can see it.
 *
 * So the button is projected onto a boundary set further in than the one that
 * merely keeps it on the felt, and this constant is the difference between the
 * two. 2.5% is HALF THE BUTTON'S OWN WIDTH at its largest relative size (the
 * puck's 17px mobile floor on a 347px table is 4.9% - see --dealer-btn-size in
 * TableVisualHotfix.css), so the felt shows a gap you could lay half a puck
 * into, at every table size:
 *
 *     375px phone (347px table)    8.7px of felt between the puck and the rail
 *     tablet portrait (600px)     15.0px
 *     desktop (720px)             18.0px
 *
 * A proportion rather than a pixel count for the same reason as everything else
 * on this felt: the table's width is continuous (`--table-w` is
 * `min(100vw - 28px, 360px)` on a phone), so a pixel constant is correct only
 * at the one width somebody measured it at.
 *
 * ONLY THE BUTTON MOVES. The chips keep the plain marker margin, because they
 * are the marker with somewhere to be: they walk one derived rail
 * (CHIP_RAIL_WIDTH_PCT) whose length is set by the community board, and pushing
 * them in as well would walk every off-felt seat's bet toward the cards that
 * rail exists to keep them off. Item 8 is about the puck.
 *
 * WHAT IT COSTS, stated so nobody has to re-derive it. The button stands
 * further from its seat. Across all eight production rings at all three table
 * sizes the furthest any button now travels is 0.32 of that seat's distance to
 * the middle of the felt (6-max phone, seat 89.5/66: 53.8px of 168.4px),
 * against 0.29 before. It is still nearer its own seat than any other seat on
 * the ring, everywhere - that is the invariant that would actually break if
 * this number grew, and tests/table-geometry-chips.test.ts asserts it rather
 * than assuming it.
 */
export const BUTTON_FELT_DAYLIGHT_WIDTH_PCT = 2.5;

/**
 * The margin the BUTTON's on-felt projection uses: its own radius, so no part
 * of the disc overhangs the painted rail, plus the daylight above, so the disc
 * does not touch it either.
 *
 * Derived rather than typed out, so the two numbers it is made of cannot fall
 * out of step with it - and so `feltEdgeClearanceWidthPct(button) >= this` is
 * exactly the statement the code makes and the tests check.
 */
export const BUTTON_FELT_MARGIN_WIDTH_PCT =
  FELT_MARKER_MARGIN_WIDTH_PCT + BUTTON_FELT_DAYLIGHT_WIDTH_PCT;

/* ═══════════════════════════════════════════════════════════════════════════
   FELT MATHS
   ═══════════════════════════════════════════════════════════════════════════
   The felt is a STADIUM, not an ellipse. `.table-surface` carries
   `border-radius: 9999px`, which every browser resolves to min(w, h) / 2 on
   both axes, so the painted window is a rectangle with two semicircular caps -
   a racetrack, which is the shape a real poker table is cut to.

   An earlier pass here used the ellipse INSCRIBED in that window, on the theory
   that inside the ellipse is inside anything rounder. It is, and it costs too
   much: on a 347x574 table the ellipse is 25px narrower than the felt at the
   height the 9-max bottom cap seats sit at, so those seats' chips were being
   pushed a fifth of a rail further in than they needed to be, purely to satisfy
   a shape the table does not have. Every pixel of that came straight out of
   "one rail, equal for every seat".

   So the region below is the real one, and the two operations on it are done by
   bisection along a ray rather than in closed form. That is not a compromise:
   the stadium is convex and contains its own centre, so the ray crosses the
   boundary exactly once and bisection converges on it to full double precision
   in 40 halvings. There is no ambiguity to trade away. */

/** Centre of the felt window, in scaler percentages. */
export function feltCenter(): Pos {
  return {
    x: FELT_WINDOW.left + FELT_WINDOW.width / 2,
    y: FELT_WINDOW.top + FELT_WINDOW.height / 2,
  };
}

/** The felt window in pixels, inset on every side by a marker's own radius. */
function feltBoxPx(size: Size, marginWidthPct: number) {
  const inset = (marginWidthPct / 100) * size.w;
  const w = Math.max(1, (FELT_WINDOW.width / 100) * size.w - 2 * inset);
  const h = Math.max(1, (FELT_WINDOW.height / 100) * size.h - 2 * inset);
  return {
    left: (FELT_WINDOW.left / 100) * size.w + inset,
    top: (FELT_WINDOW.top / 100) * size.h + inset,
    w,
    h,
    // What `border-radius: 9999px` resolves to. Insetting the box by `inset`
    // reduces min(w, h) by 2 * inset and so the radius by exactly `inset`,
    // which is what makes this the true offset curve of the painted window.
    r: Math.min(w, h) / 2,
  };
}

/**
 * Distance in PIXELS from a point to the stadium's SPINE - the segment left
 * after both semicircular caps are removed. A stadium is every point within r
 * of that spine, so this one number answers both "is it inside" and "how much
 * felt is left before the rail".
 */
function spineDistancePx(px: number, py: number, box: ReturnType<typeof feltBoxPx>): number {
  const sx = Math.min(Math.max(px, box.left + box.r), box.left + box.w - box.r);
  const sy = Math.min(Math.max(py, box.top + box.r), box.top + box.h - box.r);
  return Math.hypot(px - sx, py - sy);
}

/** True when a point in PIXELS is inside the inset stadium. */
function insideStadiumPx(px: number, py: number, box: ReturnType<typeof feltBoxPx>): boolean {
  return spineDistancePx(px, py, box) <= box.r + 1e-9;
}

/**
 * How much felt lies between a marker's centre and the PAINTED rail, as a
 * percentage of the table's WIDTH. Negative when the point is off the felt.
 *
 * The direct measurement of item 8, and the one the tests assert on. A marker
 * whose clearance is at least its own radius has its whole disc on the felt; a
 * marker whose clearance is MORE than that has the difference as visible
 * daylight between the disc and the rail.
 *
 * Exact, and cheap, where the on/off test has to bisect: insetting the felt box
 * by `i` leaves the stadium's spine exactly where it was and shrinks its radius
 * by exactly `i` (the box loses 2i on both axes, and the width is the shorter
 * axis at every table size this app renders). That identity is also why
 * `clampIntoFelt(p, size, m)` and `feltEdgeClearanceWidthPct(p, size) >= m` are
 * two statements of the same thing, which is what lets a test measure the
 * daylight rather than take the constant's word for it.
 */
export function feltEdgeClearanceWidthPct(p: Pos, size: Size = NOMINAL_SCALER): number {
  const box = feltBoxPx(size, 0);
  const d = spineDistancePx((p.x / 100) * size.w, (p.y / 100) * size.h, box);
  return ((box.r - d) / size.w) * 100;
}

/**
 * How far along the ray from the felt's centre through `p` the felt ends.
 *
 * Returns the scale `s` such that centre + s * (p - centre) is exactly on the
 * boundary. s > 1 means `p` is inside with room to spare; s < 1 means it is out
 * on the painted rail and s is how much of the way back it has to come.
 */
function feltExitScale(p: Pos, size: Size, marginWidthPct: number): number {
  const box = feltBoxPx(size, marginWidthPct);
  const c = feltCenter();
  const cx = (c.x / 100) * size.w;
  const cy = (c.y / 100) * size.h;
  const dx = (p.x / 100) * size.w - cx;
  const dy = (p.y / 100) * size.h - cy;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 1e-9) return Infinity;
  if (!insideStadiumPx(cx, cy, box)) return 0; // a table too small to have a felt

  let lo = 0; // inside
  let hi = 1;
  // Push `hi` out until it is outside, so the boundary is bracketed.
  for (let i = 0; i < 40 && insideStadiumPx(cx + dx * hi, cy + dy * hi, box); i++) hi *= 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (insideStadiumPx(cx + dx * mid, cy + dy * mid, box)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * How far out toward the rail a point sits: 0 is the middle of the felt, 1 is
 * as far out as a marker of this size may go, above 1 is on the painted rail.
 *
 * The one number that says whether `clampIntoFelt` moved a point, which is what
 * separates "this seat walks the common rail" from "this seat's ring position
 * is off the felt and the on-felt guarantee had to lengthen its walk".
 */
export function feltRadialFraction(
  p: Pos,
  size: Size = NOMINAL_SCALER,
  marginWidthPct: number = FELT_MARKER_MARGIN_WIDTH_PCT
): number {
  const s = feltExitScale(p, size, marginWidthPct);
  if (!Number.isFinite(s)) return 0;
  return s <= 0 ? Infinity : 1 / s;
}

/** True when a marker centred here has its whole disc on the felt. */
export function isInsideFelt(
  p: Pos,
  size: Size = NOMINAL_SCALER,
  marginWidthPct: number = FELT_MARKER_MARGIN_WIDTH_PCT
): boolean {
  const box = feltBoxPx(size, marginWidthPct);
  return insideStadiumPx((p.x / 100) * size.w, (p.y / 100) * size.h, box);
}

/**
 * ITEM 11'S GUARANTEE. Returns a point that is always on the felt.
 *
 * Dan 2026-08-25: "The button must always be on the table, and never on the
 * rail."
 *
 * The old construction stepped a FRACTION of the way from the seat toward the
 * middle - 0.28 of the horizontal run, 0.16 of the vertical - and a fraction of
 * a short run is a short step. Every TOP CAP DIAGONAL on every ring therefore
 * left its button hanging over the painted rail, measured on the current rings:
 *
 *     3-max and 5-max  (20.5, 6) -> (23.4, 14.3)   7.6% past the felt's edge
 *     7-max and 9-max  (27,   6) -> (28.2, 13.9)   2.7% past
 *
 * and it is worth noticing WHEN they became wrong: they were fine at y=8.5, and
 * a seat move in a different file on 2026-08-25 raised the cap to y=6. A tuned
 * constant here would have been correct on the day it was written and silently
 * wrong the moment someone moved a chair - which is what happened. No constant
 * can fix it, either, because the amount by which each seat misses depends on
 * where that seat is.
 *
 * So this is not a constant. The point is pulled straight back along the line
 * to the centre of the felt until it is inside, and not one step further. It is
 * a no-op for every point that was already on the felt, so no seat that was
 * right moves, and it cannot fail for any seat of any ring at any table size -
 * the felt is convex and contains the point being pulled toward.
 */
export function clampIntoFelt(
  p: Pos,
  size: Size = NOMINAL_SCALER,
  marginWidthPct: number = FELT_MARKER_MARGIN_WIDTH_PCT
): Pos {
  const s = feltExitScale(p, size, marginWidthPct);
  if (!Number.isFinite(s) || s >= 1) return { x: p.x, y: p.y };
  const c = feltCenter();
  return { x: c.x + (p.x - c.x) * s, y: c.y + (p.y - c.y) * s };
}

/* ═══════════════════════════════════════════════════════════════════════════
   SQUARE SPACE
   ═══════════════════════════════════════════════════════════════════════════
   Percentages of a 605x1000 box are not distances: 1% across is 6.05px and 1%
   down is 10px. Rotating a direction vector, or stepping "the same distance"
   along one, has to happen where the axes agree. `sq()` divides y by the
   table's aspect so that a unit in either axis is the same number of pixels
   (specifically w/100 of them), and `unsq()` puts it back. Every length below
   is therefore in units of "1% of the table's width", which is also why the
   rail and the minimum gap are quoted that way. */

const sq = (p: Pos, size: Size): Pos => ({ x: p.x, y: (p.y * size.h) / size.w });
const unsq = (p: Pos, size: Size): Pos => ({ x: p.x, y: (p.y * size.w) / size.h });

/* ═══════════════════════════════════════════════════════════════════════════
   THE TWO MARKERS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Where a seat's bet chips come to rest, in scaler percentages.
 *
 * One rail for every seat (CHIP_RAIL_WIDTH_PCT), walked along the line to the
 * centre of the FELT - not the centre of the scaler, which is a different point
 * by about 1% of the table's height and is not where the pot is.
 *
 * The `Math.min(rail, len * 0.8)` is a degeneracy guard and nothing more: a
 * seat sitting almost on top of the felt centre has no room to walk a full
 * rail, and without it the chips would step past the middle and end up on the
 * far side of the table from the player who bet them. The closest seat on any
 * production ring is 40 units from the centre against a rail of 11.5, so it
 * cannot bind on a real table - which is the point. Its predecessor was applied
 * to seats it COULD bind on, where it silently equalised two seats that were
 * supposed to differ.
 */
export function chipRestPosition(seat: Pos, size: Size = NOMINAL_SCALER): Pos {
  const c = feltCenter();
  const s = sq(seat, size);
  const t = sq(c, size);
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 1e-6) return { x: seat.x, y: seat.y };

  const step = Math.min(CHIP_RAIL_WIDTH_PCT, len * 0.8);
  const walked = unsq({ x: s.x + (dx / len) * step, y: s.y + (dy / len) * step }, size);
  return clampIntoFelt(walked, size);
}

/**
 * Where a seat's dealer button sits, in scaler percentages.
 *
 * Built from the chip rail rather than from its own set of factors, so the two
 * markers can no longer drift apart the way they did when each had its own
 * arithmetic. Three steps, in order:
 *
 *   1. walk BUTTON_RAIL_RATIO of the rail, along the line to the felt centre
 *      rotated by BUTTON_ANGLE_DEG - nearer the player than the chips, and off
 *      their line;
 *   2. project onto the felt, using the button's own margin, which is its
 *      radius plus BUTTON_FELT_DAYLIGHT_WIDTH_PCT of clear felt (items 11 and
 *      8). Step 2 is what places the button for most seats rather than merely
 *      correcting it - almost every seat on the ring stands off the painted
 *      felt - so the daylight belongs HERE, in the projection, and not in a
 *      separate nudge applied afterwards that step 3 could then undo;
 *   3. if step 2 has pushed the two markers together - it can, because a seat
 *      outside the felt has both of its markers projected onto the same arc -
 *      walk the button AROUND the felt until they are MARKER_MIN_GAP_WIDTH_PCT
 *      apart (item 13).
 *
 * Step 3 swings the button about the CENTRE of the felt and then re-applies
 * step 2 WITH THE SAME MARGIN - a stadium is not rotation-invariant, so a point
 * swung along its own arc can end up outside the boundary it started on, and
 * re-clamping with the plain marker margin would quietly hand the daylight back
 * on exactly the seats that needed the swing. It searches
 * outward from zero in both directions and takes the first angle that satisfies
 * the gap, so it moves the button as little as the geometry allows and is a
 * no-op on every seat that did not need it.
 *
 * `size` defaults to the scaler's own shape because DealerButton.tsx is handed
 * a seat and nothing else. Only the ASPECT of `size` reaches the answer (the
 * result is in percentages), and TablePage.css locks that aspect at every
 * breakpoint, so the default is exact in production rather than approximate.
 */
export function dealerButtonPosition(seat: Pos, size: Size = NOMINAL_SCALER): Pos {
  const c = feltCenter();
  const s = sq(seat, size);
  const t = sq(c, size);
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 1e-6) return { x: seat.x, y: seat.y };

  const ux = dx / len;
  const uy = dy / len;
  const a = BUTTON_ANGLE_DEG * (Math.PI / 180);
  const cosA = Math.cos(a);
  const sinA = Math.sin(a);
  // Same rotation sense the button has always used, so it stays on the side of
  // each seat that players are used to seeing it on.
  const rx = ux * cosA - uy * sinA;
  const ry = ux * sinA + uy * cosA;

  const step = Math.min(CHIP_RAIL_WIDTH_PCT * BUTTON_RAIL_RATIO, len * 0.8);
  const walked = unsq({ x: s.x + rx * step, y: s.y + ry * step }, size);
  const placed = clampIntoFelt(walked, size, BUTTON_FELT_MARGIN_WIDTH_PCT);

  const chips = chipRestPosition(seat, size);
  if (markerGapWidthPct(placed, chips, size) >= MARKER_MIN_GAP_WIDTH_PCT) return placed;

  // Swing it around the middle of the felt, 1.5 degrees at a time, out to a
  // quarter turn - far more than any seat on any ring has ever needed. The
  // swing happens in square space so the angle is the angle a person sees, and
  // every candidate is put back on the felt before it is judged.
  const pv = sq(placed, size);
  const cv = sq(c, size);
  for (let i = 1; i <= 60; i++) {
    for (const dir of [1, -1]) {
      const phi = dir * i * 1.5 * (Math.PI / 180);
      const cosP = Math.cos(phi);
      const sinP = Math.sin(phi);
      const vx = pv.x - cv.x;
      const vy = pv.y - cv.y;
      const cand = clampIntoFelt(
        unsq({ x: cv.x + vx * cosP - vy * sinP, y: cv.y + vx * sinP + vy * cosP }, size),
        size,
        BUTTON_FELT_MARGIN_WIDTH_PCT
      );
      if (markerGapWidthPct(cand, chips, size) >= MARKER_MIN_GAP_WIDTH_PCT) return cand;
    }
  }
  return placed;
}

/**
 * Distance between two points on the table, in percent of the table's WIDTH.
 *
 * The unit both the minimum gap and the rail are quoted in; multiply by
 * `size.w / 100` for pixels.
 */
export function markerGapWidthPct(a: Pos, b: Pos, size: Size = NOMINAL_SCALER): number {
  const pa = sq(a, size);
  const pb = sq(b, size);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

/* ═══════════════════════════════════════════════════════════════════════════
   WHAT THE TABLE PAGE ACTUALLY CALLS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The one rail, in pixels, for a given table size.
 *
 * Kept as a named export because it is the number a person wants when a bet
 * looks wrong, and because it is the thing the tests measure.
 *
 * `_isDealer` is accepted and IGNORED. It used to add CHIP_RAIL_DEALER_EXTRA_PX
 * so the button holder's chips could clear their own puck; the puck now moves
 * instead (see `dealerButtonPosition`), because giving one seat a longer rail is
 * the exact thing item 13 forbids. The parameter survives only so the existing
 * call in TablePage.tsx keeps compiling - drop it there and then here.
 */
export function chipRailInset(size: Size, _isDealer?: boolean): number {
  return (CHIP_RAIL_WIDTH_PCT / 100) * size.w;
}

/**
 * Pixel offset from a seat to its resting bet chips.
 *
 * Pixels because the caller positions with translate(). See `chipRestPosition`
 * for the rule; `_isDealer` is accepted and ignored, see `chipRailInset`.
 */
export function betChipOffsetPx(seat: Pos, size: Size, _isDealer?: boolean): Pos {
  const p = chipRestPosition(seat, size);
  return {
    x: Math.round(((p.x - seat.x) * size.w) / 100),
    y: Math.round(((p.y - seat.y) * size.h) / 100),
  };
}

/**
 * How much FURTHER a chip travels when collected into the pot.
 *
 * The chip already sits at betChipOffsetPx(); the collect keyframe translates it
 * by this again. Expressed as the remainder to a common endpoint so every seat's
 * chips converge on the same place regardless of where they started.
 */
export function chipCollectOffsetPx(seat: Pos, size: Size, _isDealer?: boolean): Pos {
  const c = feltCenter();
  const dxPx = ((c.x - seat.x) * size.w) / 100;
  const dyPx = ((c.y - seat.y) * size.h) / 100;
  const rest = betChipOffsetPx(seat, size);
  return {
    x: Math.round(dxPx * CHIP_COLLECT_FRACTION - rest.x),
    y: Math.round(dyPx * CHIP_COLLECT_FRACTION - rest.y),
  };
}
