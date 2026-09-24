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
 * Round three, 2026-08-26, both reported off a 390px phone:
 *
 * "The chips put in the pot by the hero and the villains need to be moved
 *  farther in front of them. They are either on the rail, or overlapping the
 *  avatar, or the action box. Chips should be on the table only and never
 *  overlapping any aspect or feature on the table."
 *
 * "The avatar on the left middle who has the button - the button should be
 *  moved up some in that position so it doesn't overlap the date."
 *
 * WHAT THIS NOW GUARANTEES, in order of precedence:
 *
 *   1. ONE RAIL. Every seat's chips rest the SAME number of pixels from that
 *      seat, measured along the line to the middle of the felt. There is no
 *      per-seat term left: no hero extra, no button-holder extra, no shorter
 *      walk for the seats level with the community board. The rail is a FLOOR
 *      that nothing below may take away, which is the part that matters - see
 *      (4), which can only ever lengthen a walk.
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
 *   4. NOTHING ON THE FURNITURE. Three rectangles are keep-outs, and all three
 *      are ONE shape measured against every seat identically, never a term
 *      handed to a named chair: a seat's own PLAYER POD (avatar + name plate),
 *      which the chips are walked out of; the COMMUNITY BOARD, which caps that
 *      walk and wins whenever the two cannot both be had; and the printed FELT
 *      MASTHEAD, which the dealer button is walked around. See SEAT_POD_LADDER,
 *      BOARD_WINDOW and FELT_TEXT_BAND - all three are mirrors of a stylesheet,
 *      like FELT_WINDOW, and all three have to move in the same commit as the
 *      rule they mirror.
 *
 * (1) is the rule; (2), (3) and (4) are guarantees that apply identically to
 * every seat. They move a seat's chips only where the seat's own ring position sits
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
 * `.table-scaler { aspect-ratio: 605 / 1000 }` - the DESKTOP shape. Since
 * 2026-08-29 phones and tablets (<=768px) fill their real box instead and land
 * anywhere from 0.605 to 0.7 wide-per-tall; the art is object-fit: fill, so
 * the ring and the rail stretch together and percentages stay aligned. It is needed here because a percentage of the width and a
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
 *     less half a chip     -1.8%   (a chip is 3.6% of the table - see
 *                                   TableVisualHotfix.css, --cp-chip-size)
 *     less clear air       -0.2%
 *     ------------------------------------------------------------------
 *     rail                 12.5% of the table's width
 *
 * CORRECTED 2026-08-25 (audit): this derivation used to end at 11.5 while the
 * constant below read 12.5, because the chip was quoted at "~4% of the table"
 * from an older token. It is 3.6% now, and half of it is 1.8, not 2.0. The
 * number that was WRONG was the prose - and prose that disagrees with the
 * constant beside it is worse than no prose, because the next person to move
 * this rail will "restore" it to the derivation and shorten every seat's walk
 * by a fifth. tests/table-geometry-chips.test.ts measures the outcome the
 * derivation is aiming at ("no seat's chips land on the cards") rather than
 * taking either number's word for it.
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
 * An extra step further onto the felt, for BOTH markers.
 *
 * Dan 2026-08-26: "move all chip placements and button 3 pixels farther into
 * the table (more towards the middle of the table and farther away from the
 * rail)."
 *
 * Expressed in PIXELS, deliberately, and converted against the live table
 * size at the point of use. Every other distance in this module is a
 * percentage of the table's width because it describes a relationship to
 * something painted on the table, which scales with it. This one does not:
 * it is a nudge measured by eye on a phone, so three pixels has to stay three
 * pixels at every breakpoint rather than becoming one on a phone and six on a
 * desktop.
 *
 * It is added to the rail as a FLOOR, before the board ceiling in
 * `chipStepWidthPct` — so it moves the markers inward exactly as asked, and
 * still cannot push a seat's chips onto the community cards, which remains
 * the one constraint that outranks everything else here.
 */
export const MARKER_INSET_PX = 3;

/** MARKER_INSET_PX as a percentage of this table's width. */
export function markerInsetWidthPct(size: Size): number {
  return size.w > 0 ? (MARKER_INSET_PX / size.w) * 100 : 0;
}

/**
 * Where a chip finishes when it is collected, as a fraction of seat-to-centre.
 *
 * The chips are going to the pot and the pot is in the middle, so every seat
 * converges on one point. 0.9 rather than 1.0 so the arriving stacks form a
 * pile around the pot rather than all landing on the same pixel.
 */
export const CHIP_COLLECT_FRACTION = 0.9;

/* ═══════════════════════════════════════════════════════════════════════════
   THE PLAYER POD - WHY ONE PERCENTAGE RAIL IS NOT ENOUGH
   ═══════════════════════════════════════════════════════════════════════════
   Dan 2026-08-26, on a 390px phone: "The chips put in the pot by the hero and
   the villains need to be moved farther in front of them. They are either on
   the rail, or overlapping the avatar, or the action box. Chips should be on
   the table only and never overlapping any aspect or feature on the table."

   THE ARITHMETIC OF THE DEFECT. CHIP_RAIL_WIDTH_PCT is a percentage of the
   TABLE. The thing it has to clear is not: a seat's pod - avatar stacked on
   name plate - is sized in PIXELS off `--seat-avatar-base` in SeatSlot.css
   (84px desktop, 66 at 640, 58 at 480, 52 at 380), and those pixels do not
   shrink when the table does. So the pod eats a bigger share of a smaller
   table, and a rail that clears it on a 720px desktop felt does not clear it
   on a phone:

       table   villain pod   pod half-width   rail (12.5%)   chip radius
       385px   80 x 88       40px             48.1px         6.9px
       404px   96 x 122      48px             50.5px         7.3px
       646px   96 x 122      48px             80.8px         11.6px

   At 385 a side seat's chips come to rest 48px out with 7px of chip on either
   side of that point, against a plate that reaches 40px - one pixel of felt
   between them, and none at all once the walk is diagonal, because a pod is a
   RECTANGLE and the diagonal exit from a rectangle is longer than either half.
   Measured over the eight production rings at nine table sizes before this was
   written, EVERY size had at least one seat whose chips overlapped its own pod,
   worst case 21px of overlap. It is not one bad seat; it is the unit mismatch.

   WHY NOT SIMPLY A BIGGER PERCENTAGE. The rail's own derivation above says what
   12.5 is: the longest rail that keeps a board-level side seat's chips off the
   community cards. Raising the constant to cover the worst pod (about 14.9% of
   the table) puts a 4-max middle seat's chips 6px onto the flop. The rail
   cannot be both.

   WHAT IS DONE INSTEAD, and why it is not the exception that was deleted. The
   pod is declared here as a keep-out RECTANGLE - one shape, the same shape for
   every seat - and the walk is lengthened only as far as leaving that rectangle
   requires. That is the same kind of thing as `clampIntoFelt`: a region every
   seat is measured against identically, not a term handed to a named seat.
   CHIP_RAIL_SCALE_BOARD_LEVEL was the opposite - a seat SHORTENED because of
   which chair it was - and nothing here shortens anything: the common rail is a
   floor, so no seat ever walks less than it did.

   It also happens to fit the board, and not by luck. The seats the board
   constrains are the ones walking almost horizontally at it, and a horizontal
   exit from the pod is the SHORTEST one - the same 385px table needs 47px for a
   board-level seat and 58px for a diagonal one. The two constraints bind on
   different seats. Where they do collide (a 404px table carrying 96 x 122px
   desktop pods, which is what a 1440x900 laptop renders) BOARD_CHIP_GAP wins
   and the pod loses: see `chipStepWidthPct`. Chips on a plate are ugly; chips
   on the 9d have been a real bug report. */

/**
 * The player pod, in PIXELS, at each of SeatSlot.css's four breakpoints.
 *
 * A MIRROR OF SeatSlot.css, exactly as FELT_WINDOW is a mirror of
 * `.table-surface`. IF THE AVATAR TOKEN OR THE SEAT WIDTH MOVES, MOVE THESE IN
 * THE SAME COMMIT - this module cannot read a stylesheet, and the failure is
 * silent: chips settle back onto the plate and nothing throws.
 *
 * `w` is `.seat`'s own declared width, which is the widest the pod can paint
 * (the name plate is `max-width: 100%` of it and the avatar is narrower).
 * `h` is the avatar slot plus the name plate less `--sp-wrap-overlap`, the
 * negative margin that tucks the avatar into the plate:
 *
 *     <=380   52 + 31 - 4  =  79      seat width 72     hero 79 x 96
 *     <=480   58 + 35 - 5  =  88      seat width 80     hero 88 x 108
 *     <=640   66 + 39 - 6  =  99      seat width 88     hero 101 x 121
 *     else    84 + 44 - 6  = 122      seat width 96     hero 128 x 150
 *
 * The hero column is the same sum with the avatar at `--seat-avatar-hero-ratio`
 * (4/3) and the seat at 8/7 of THAT, which is what `.seat--hero` declares.
 *
 * NOT MODELLED, deliberately: the action label, the position chip and the
 * hand-name pill. All three are transient, all three are drawn ABOVE or BESIDE
 * the plate rather than between it and the pot, and including them would push
 * every seat's chips out for a badge that is on screen for two seconds. The
 * timer ring is the plate's own border and is inside these numbers already.
 */
export const SEAT_POD_LADDER: ReadonlyArray<{
  readonly maxViewportWidthPx: number;
  readonly villain: Size;
  readonly hero: Size;
}> = [
  { maxViewportWidthPx: 380, villain: { w: 72, h: 79 }, hero: { w: 79, h: 96 } },
  { maxViewportWidthPx: 480, villain: { w: 80, h: 88 }, hero: { w: 88, h: 108 } },
  { maxViewportWidthPx: 640, villain: { w: 88, h: 99 }, hero: { w: 101, h: 121 } },
  { maxViewportWidthPx: Infinity, villain: { w: 96, h: 122 }, hero: { w: 128, h: 150 } },
];

/**
 * The pod a seat paints at this viewport width, in pixels.
 *
 * VIEWPORT width, not table width, because that is what the CSS ladder keys off
 * and the two are not interchangeable: a 381px table is what a 480px phone
 * renders (58px avatars) AND what a 1440x900 laptop renders (84px avatars), so
 * a table-width lookup would hand the phone the desktop pod and push its chips
 * onto the board. The caller has the viewport; this module does not.
 *
 * Callers get the pod from the seat's own POSITION - hero is the seat on the
 * scaler's bottom edge - never from a seat index, for the reason
 * `outboardCardSide` gives in tableSeatGeometry.ts: an index means a different
 * chair on every ring.
 */
export function seatPodPx(viewportWidthPx: number, isHero: boolean): Size {
  const rung =
    SEAT_POD_LADDER.find((r) => viewportWidthPx <= r.maxViewportWidthPx) ??
    SEAT_POD_LADDER[SEAT_POD_LADDER.length - 1];
  return isHero ? rung.hero : rung.villain;
}

/**
 * Clear felt between a chip's edge and its own pod, as a percentage of the
 * table's width.
 *
 * 0.6% is 2.3px on a 385px phone and 3.9px on a 646px desktop. Small on
 * purpose: every pixel here is a pixel further from the player who bet, and the
 * point of the exercise is that the chip is not TOUCHING the plate, not that it
 * is somewhere else entirely. A proportion rather than a pixel count for the
 * same reason as everything else on this felt.
 */
export const CHIP_POD_GAP_WIDTH_PCT = 0.6;

/* ═══════════════════════════════════════════════════════════════════════════
   THE MARKERS' OWN SIZES
   ═══════════════════════════════════════════════════════════════════════════
   Both are declared in TableVisualHotfix.css section 4 as a proportion of
   `--table-w` with a pixel floor and ceiling, and both numbers were already
   quoted - as prose - in the comments on CHIP_RAIL_WIDTH_PCT and
   MARKER_MIN_GAP_WIDTH_PCT. They are constants now because the pod and board
   keep-outs have to INFLATE by a marker's radius rather than merely be
   described in a comment, and a second hand-copied "3.6%" is exactly how the
   rail's derivation came to disagree with the rail. */

/** `--cp-chip-size: clamp(10px, calc(var(--table-w) * 0.036), 26px)`. */
export const CHIP_WIDTH_PCT = 3.6;
export const CHIP_MIN_PX = 10;
export const CHIP_MAX_PX = 26;

/** `--dealer-btn-size: calc(var(--cp-chip-size) * 2)` (TableVisualHotfix.css).
 *
 * Dan 2026-09-04: "the button on the table needs to be double the size as the
 * chips in pot." So the puck is DERIVED from the chip - 7.2% of the table with
 * a 20px floor and a 52px ceiling, exactly twice CHIP_* at every width - and
 * cannot drift from it. The old 17px legibility floor is moot: twice the chip
 * floor is already above it. */
export const BUTTON_WIDTH_PCT = CHIP_WIDTH_PCT * 2;
export const BUTTON_MIN_PX = CHIP_MIN_PX * 2;
export const BUTTON_MAX_PX = CHIP_MAX_PX * 2;

const clampPx = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Half a bet chip, as a percentage of the table's width. */
export function chipRadiusWidthPct(size: Size = NOMINAL_SCALER): number {
  return (clampPx((CHIP_WIDTH_PCT / 100) * size.w, CHIP_MIN_PX, CHIP_MAX_PX) / 2 / size.w) * 100;
}

/** Half a dealer puck, as a percentage of the table's width. */
export function buttonRadiusWidthPct(size: Size = NOMINAL_SCALER): number {
  return (
    (clampPx((BUTTON_WIDTH_PCT / 100) * size.w, BUTTON_MIN_PX, BUTTON_MAX_PX) / 2 / size.w) * 100
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE TWO THINGS PRINTED ON THE FELT
   ═══════════════════════════════════════════════════════════════════════════
   Both are mirrors of TablePage.css in the same sense as FELT_WINDOW, and both
   carry the same warning: IF THE RULE MOVES, MOVE THE NUMBERS HERE IN THE SAME
   COMMIT. Neither has a DOM this module can measure. */

/**
 * The community board, as a keep-out region.
 *
 * `.table-surface .community-area { width: 68% }` and `.community-area { top:
 * 43.5%; transform: translate(-50%, -50%) }`, both percentages of the FELT. The
 * five cards are `flex: 1 1 0` with `aspect-ratio: 64 / 92`, so the row's width
 * decides the card's height.
 *
 * The card width is taken as row/5 with the inter-card gaps IGNORED, which
 * over-states the height by about 9%. That is the safe direction for a keep-out
 * and it removes the one number here that would otherwise have to be read out
 * of CommunityCards.css as well.
 */
export const BOARD_WINDOW = {
  widthOfFeltPct: 68,
  centerOfFeltYPct: 43.5,
  cardAspect: 92 / 64,
} as const;

/** Clear felt between a chip's edge and the nearest card. The 0.2% the rail's own derivation spends. */
export const BOARD_CHIP_GAP_WIDTH_PCT = 0.2;

/**
 * The felt masthead - the wordmark with the date, club, union and stakes
 * printed under it - as a keep-out region for the DEALER BUTTON.
 *
 * Dan 2026-08-26: "The avatar on the left middle who has the button - the
 * button should be moved up some in that position so it doesn't overlap the
 * date."
 *
 * `.table-brand` in TablePage.css: `width: 62%` of the felt capped at 260px,
 * hung from `--sp-brand-top` by its top edge (56% on `.table-surface` since
 * 2026-09-23; moved to 59% / 64% by the `[data-boards]` rules), holding a
 * 900x116 wordmark at full width,
 * a 6px gap, and two `.table-brand__line` rows at 0.48rem.
 *
 * ── WHY 62 IS THE RIGHT NUMBER, AND WHY IT WAS NOT ─────────────────────────
 * The width of the BOX is 62%, and until 2026-08-26 the PRINTING was wider than
 * it - which is the whole of Dan's report, and the reason a keep-out written
 * off the box alone would have looked correct and changed nothing.
 *
 * `.table-brand__line` carries `white-space: nowrap` with `max-width: 100%`,
 * and the 2026-08-24 note beside it says it therefore "ellipsizes at the
 * masthead's edge". It did not. `.table-brand__meta` is a flex item in a column
 * container with `align-items: center`, so its cross size is `fit-content` =
 * min(max-content, max(min-content, available)) - and for a nowrap line
 * min-content EQUALS max-content, so that expression returns the TEXT'S own
 * width whenever the text is wider than the box. The line's `max-width: 100%`
 * then resolved against a parent that was already as wide as the line, and
 * clamped nothing.
 *
 * Measured on a 393px phone (felt 281.8px, brand box 175px): line 1 reading
 * "AUG 26, 2026 . SHARK CLUB . MIDWAY UNION" is 40 characters of 0.48rem
 * uppercase with 0.1em tracking, about 221px, so it hung 23px past the box on
 * each side and reached x 21.3% of the scaler. The left-middle seat's puck
 * stands at 20.4% with a 2.2% radius - it reaches 22.6% - and that is the puck
 * sitting on the date.
 *
 * `.table-brand__meta` is given `width: 100%; min-width: 0` in the same commit
 * as this constant, which is what makes the ellipsis rule true and this number
 * exact. WIDENING THE BAND INSTEAD WAS TRIED AND REJECTED: at the masthead's
 * own stated cap of 82% of the felt (`.table-brand`'s first `max-width`, which
 * is dead - `max-width: 260px` overrides it eleven lines below) the puck has to
 * swing so far up the arc to escape that a 5-max side seat's button ends up
 * 0.47 of the way to the middle of the felt, past the 0.40 ceiling
 * tests/table-geometry-chips.test.ts states, and short of the daylight item 8
 * asks for. The text is the thing that had left its declared box; the puck was
 * exactly where the geometry meant to put it.
 *
 * The <=380px block narrows the box to 56% with a 4px gap and 0.44rem type,
 * which shortens the text as well; that variant is a STRICT SUBSET of these
 * numbers, so this module carries no breakpoint of its own. A keep-out that is
 * too big costs a degree of rotation. One that is too small costs the defect.
 *
 * `lineHeightPx` is 11 because `.table-brand__line` declares no line-height:
 * 0.48rem is 7.68px at a 16px root and `normal` resolves to about 1.35 of that
 * for this face, rounded up. It is the one number here that is a measurement of
 * type rather than a copy of a declaration, which is why the band also carries
 * MARKER_FELT_TEXT_GAP_WIDTH_PCT on top.
 */
/* TALLER, NOT WIDER (2026-09-07, with the masthead it describes).
   Dan, 7A: the club + union line must never be abbreviated, so
   `.table-brand__line--identity` in TablePage.css wraps instead of
   ellipsizing. This band is the dealer button's keep-out for exactly that
   printing, and the comment above has always said: change one, change both.

   `lines` therefore goes 2 -> 3 — a long club and union name occupies two of
   them and the puck must clear the block at its TALLEST, not at its usual.

   The WIDTH deliberately does not move. It was tried (62 -> 90%, 260 -> 377px,
   matching a 145% identity row) and reverted: this band is what the button
   walks around, so widening it pushed the puck to 0.44 of its seat's run to
   the middle against the 0.40 ceiling in tests/unit/chipRail — which is Dan's
   item 10 ("the button is not even close to the player who has the button")
   made worse by the fix for his item 7A. The name wraps inside the existing
   box instead, and nothing else on the felt has to move. */
/* THE BAND HANGS FROM ITS TOP (2026-09-23, with the masthead it describes).
   Dan: "THE BOARD CARDS SHOULD NEVER EVER BE OVERLAPPING 'SMARTER.POKER' ON
   THE FELT, ALWAYS ABOVE." `.table-brand` is anchored by its TOP edge now
   (`--sp-brand-top: 56%` of the felt window, translate on X only), so a taller
   block grows down the felt and never up into the board. This band mirrors
   that: `topOfFeltYPct` replaces the old centre, and the rectangle is top +
   height rather than centre +- half. The `lines: 3` tallest-block rule is
   unchanged, and it now means the same thing in both files. */
export const FELT_TEXT_BAND = {
  widthOfFeltPct: 62,
  maxWidthPx: 260,
  topOfFeltYPct: 56,
  logoAspect: 900 / 116,
  logoToMetaGapPx: 6,
  lineHeightPx: 11,
  lines: 3,
  lineGapPx: 1,
} as const;

/**
 * Clear felt between the puck's edge and the printing, as a percentage of the
 * table's width. 1.9px on a phone - enough that "moved up some" reads as moved
 * rather than as touching, without spending a rotation the geometry has to buy
 * somewhere else.
 */
export const MARKER_FELT_TEXT_GAP_WIDTH_PCT = 0.5;

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
 * 0.85 clears a seat's own avatar on the smallest table the app renders: a
 * villain avatar is 52px at 375px (--seat-avatar-base in SeatSlot.css) so its
 * radius is 26px, while the rail is 12.5% x 347px = 43px and the button stands
 * 0.85 of that - 37px - from the seat centre. The puck is therefore off the
 * artwork with 11px to spare, and the two markers are still far enough apart
 * for MARKER_MIN_GAP_WIDTH_PCT to be satisfied by the rotation alone on every
 * unclamped seat (see BUTTON_ANGLE_DEG for that arithmetic).
 *
 * The prose here used to describe 0.78 against an 11.5 rail while the constant
 * read 0.85 - see the correction on CHIP_RAIL_WIDTH_PCT. Both numbers moved and
 * only one of them was written down.
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
 *   rail * sqrt(1 + 0.85^2 - 2 * 0.85 * cos 36) = 0.589 * rail
 * apart before anything else happens, which is 7.4% of the table's width -
 * comfortably past the 6% minimum, with no per-seat term involved.
 */
export const BUTTON_ANGLE_DEG = 36;

/**
 * The closest the two markers may ever be, centre to centre, as a percentage
 * of the table's width.
 *
 * In PERCENT rather than pixels because both markers are sized as a
 * proportion of the table (see TableVisualHotfix.css), and DERIVED from those
 * sizes rather than written as a number, because the number went stale once
 * already:
 *
 *   Written on 2026-08-26 as 6, when a chip was 3.6% of the table and the
 *   button 4.0% - radii 1.8% and 2.0%, touching at 3.8%, so 6% left a chip's
 *   width of felt between them. On 2026-09-04 the button was doubled to
 *   BUTTON_WIDTH_PCT = 7.2% (Dan: "double the size as the chips in pot") and
 *   this constant was not re-derived: radii 1.8% + 3.6% touch at 5.4%, and 6%
 *   left 0.6% - two pixels on a phone - between the puck's rim and the first
 *   chip. Dan 2026-09-23, screenshot of will.marino's seat: "THE BUTTON IS
 *   COVERING HIS CHIPS. THAT SHOULD NEVER HAPPEN."
 *
 * So the rule is stated as what it always meant: the two radii, plus one full
 * chip's width of daylight. 1.8 + 3.6 + 3.6 = 9% today, and if either marker
 * is resized again this follows.
 *
 * The button's mobile floor (BUTTON_MIN_PX, where the glyph would otherwise
 * stop being legible) makes it proportionally larger on a small phone; the
 * chip's daylight of margin absorbs that.
 */
export const MARKER_MIN_GAP_WIDTH_PCT = CHIP_WIDTH_PCT / 2 + BUTTON_WIDTH_PCT / 2 + CHIP_WIDTH_PCT;

/**
 * How far inside the felt's edge a marker's CENTRE must stay, as a percentage
 * of the table's width.
 *
 * A marker is a disc, and "on the felt" has to mean the whole disc, not its
 * centre. 2.5% is more than half a bet chip at its largest relative size (the
 * chip at its 10px floor on a 278px table is 3.6% wide, 1.8% at radius), so no
 * chip can overhang the painted rail at any table size.
 *
 * Until 2026-09-04 this was ALSO the button's radius margin - "the larger of
 * the two markers", a 4.9% puck. The puck is twice the chip now (Dan: "double
 * the size as the chips in pot"), 7.2% wide, and 2.5% no longer covers its
 * radius. It was tried as 3.6% for both markers and rejected in the same
 * sitting: the board's width ceiling and every chip keep-out are derived from
 * this number, so growing it for the puck narrowed the board by two chip
 * widths and walked every seat's bets inward for a marker that had not
 * changed. The button carries its own radius in BUTTON_FELT_MARGIN_WIDTH_PCT
 * below; this constant is the CHIPS' margin, and the board keep-out for the
 * puck reads buttonRadiusWidthPct() directly.
 */
export const FELT_MARKER_MARGIN_WIDTH_PCT = 2.5;

/* ═══════════════════════════════════════════════════════════════════════════
   THE ONE SEAT OFF THE OVAL — THE HERO (Dan 2026-08-27, round 3)
   ═══════════════════════════════════════════════════════════════════════════

   Dan, first: "hero's chips need to be moved up higher on the table when they
   are put into the pot, and the action pill should be below them above the
   hero's head."

   That collides head-on with his own round-2 item 13, which is the rule this
   whole module was built to keep:

     "All chips should all appear to be in the same position and distance in
      front of them. Imagine an imaginary oval, and all chips must appear
      equally on that line for all players at all tables."

   The collision was put to him with the cost stated rather than resolved by an
   agent, and he ruled:

     "All chips in all other positions and seats should sit in the same
      position except for the hero, they need to be raised up more."

   SO THE OVAL SURVIVES, WITH EXACTLY ONE NAMED EXCEPTION. This is a per-seat
   term and it is a deliberate one — the first and only one in this file — so it
   is written where it can be seen rather than folded into a margin that would
   quietly move the two bottom-cap seats along with it.

   WHY THE HERO IS DIFFERENT, AND WHY THE EXCEPTION IS NOT ARBITRARY. Every
   other chair stands just off the painted felt and its bet lands by walking the
   common rail inward. The hero's chair is at y=100 — about 10.8% of the table's
   HEIGHT below the felt, further out than any other seat, because the hero is
   drawn half on the rail where the player's own hands would be. Its rail walk
   therefore overshoots the felt entirely and `clampIntoFelt` projects the bet
   back onto the boundary, so the hero's bet is the one bet on the table that
   the rail does not place: it is pinned to the felt's edge whatever the rail
   says. The seat that is furthest out is the seat whose bet ends up lowest, and
   it is also the only seat with something stacked between its bet and its head
   — the action pill. Equal treatment of unequal geometry is what produced the
   crowding Dan photographed.

   HOW MUCH. 6% of the table's width, ~21px on a 375px phone, measured along the
   line the bet already walks (seat -> felt centre), applied AFTER the clamp so
   it is a lift off the boundary rather than a longer rail. That is the room the
   pill needs: it was sitting in about 17px of space between the bet's underside
   and the top of the hero's avatar, and `.seat--hero .seat__action` in
   SeatSlot.css reads `--bet-offset-y`, so the pill follows this number and the
   gap opens by exactly what is added here.

   The lift cannot push the bet onto anything: at 375px it moves the hero's bet
   from y 87.7% to y 84.1% of the scaler, and the nearest thing above it is the
   felt masthead at y 51-60%. */

/** How far the HERO's bet is lifted off the felt boundary, in % of table width. */
export const HERO_CHIP_LIFT_WIDTH_PCT = 6;

/**
 * Is this the hero's chair?
 *
 * The same test `TablePage.tsx` and `DealerButton.tsx` already use to pick the
 * hero's seat pod (`pos.y >= 100 && pos.x === 50`), so the three cannot disagree
 * about which seat is the hero. Every ring in `src/lib/tableSeatGeometry.ts`
 * puts the hero at exactly {50, 100}; the `>=` is for a future ring that seats
 * the hero further out still, which would need the lift more, not less.
 */
export function isHeroSeat(seat: Pos): boolean {
  return seat.y >= 100 && seat.x === 50;
}

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
export const BUTTON_FELT_DAYLIGHT_WIDTH_PCT = 1.9;

/**
 * The margin the BUTTON's on-felt projection uses: its own radius, so no part
 * of the disc overhangs the painted rail, plus the daylight above, so the disc
 * does not touch it either.
 *
 * Derived rather than typed out, so the two numbers it is made of cannot fall
 * out of step with it - and so `feltEdgeClearanceWidthPct(button) >= this` is
 * exactly the statement the code makes and the tests check.
 */
export const BUTTON_FELT_MARGIN_WIDTH_PCT = BUTTON_WIDTH_PCT / 2 + BUTTON_FELT_DAYLIGHT_WIDTH_PCT;

/* ═══════════════════════════════════════════════════════════════════════════
   THE TOP SEATS' BOX IS AN OBSTACLE (Dan 2026-08-26 mobile pass, item 2)
   ═══════════════════════════════════════════════════════════════════════════

   "The button is currently covering the top player's box. This needs to be
   adjusted to never overlap anything."

   Every top-cap seat (ring y < 20 — the band tableSeatGeometry calls
   TOP_CAP_Y_MAX) stands ABOVE the felt, and its rendered box — avatar over
   nameplate — hangs DOWNWARD over the felt's top edge. The button's on-felt
   projection lands it exactly in that overhang: on the 8-max top-centre seat
   the puck was painted on the nameplate itself.

   So a top-cap seat's button placement gains one more acceptance test: the
   candidate must sit clear of a keep-out box modelled on the seat's rendered
   footprint. The box is expressed in the same square space as everything else
   here (units of 1% of the table's width):

     half-width  13   half a nameplate (~90px on a 347px table) plus air
     drop        22   from the seat ANCHOR down past the plate's bottom edge
     rise         4   a little clearance above the anchor as well

   The same swing loop that already separates the button from the chips walks
   the puck around the felt until it clears the box — for the top-centre seat
   that lands it beside the plate, on clear felt, at the same daylight from
   the rail. Side and bottom seats never enter this branch: their y is ≥ 20. */
export const TOP_CAP_SEAT_Y_MAX = 20;
export const SEAT_BOX_HALF_WIDTH_PCT = 13;
export const SEAT_BOX_DROP_WIDTH_PCT = 22;
export const SEAT_BOX_RISE_WIDTH_PCT = 4;

/**
 * True when the puck's disc intersects the community board.
 *
 * The same rectangle tests/table-seat-ring-integrity.test.ts measures the puck
 * against - the middle 95% of the felt's width, five cards at 64:92 with 2px
 * gaps, hung at 42.5% of the felt's height. Restated rather than imported
 * because that file deliberately owns its own copy; the numbers must be kept
 * in step, and tests/unit/seatCardsAndPlate.test.tsx re-runs the assertion
 * against THIS function so a drift is caught rather than assumed away.
 *
 * Lived in DealerButton.tsx (the wrapper's refinement) until 2026-09-04. It is
 * part of `dealerButtonPosition`'s own predicate now: when the puck became
 * twice the chip, the module's raw answer for the 6-max side seat {8,25}
 * landed a 3.6%-radius disc on the cards and only the wrapper's second swing
 * rescued it. A module that hands out a position on the board and relies on
 * its caller to notice is the "second opinion" the wrapper's header warns
 * about. Uses the puck's real radius, not the chips' margin constant.
 */
export function overlapsBoard(cand: Pos, size: Size = NOMINAL_SCALER): boolean {
  const BOARD_FELT_FRACTION = 0.95;
  const BOARD_GAP_PX = 2;
  const BOARD_TOP_FELT_PCT = 42.5;
  const centreX = FELT_WINDOW.left + FELT_WINDOW.width / 2;
  const centreY = FELT_WINDOW.top + (BOARD_TOP_FELT_PCT / 100) * FELT_WINDOW.height;
  const halfW = (BOARD_FELT_FRACTION * FELT_WINDOW.width) / 2;
  const gapPct = (BOARD_GAP_PX / size.w) * 100;
  const cardW = (BOARD_FELT_FRACTION * FELT_WINDOW.width - 4 * gapPct) / 5;
  const halfH = (cardW * (92 / 64) * (size.w / size.h)) / 2;
  const puckHalf = buttonRadiusWidthPct(size);
  return (
    Math.abs(cand.x - centreX) < halfW + puckHalf &&
    Math.abs(cand.y - centreY) < halfH + puckHalf * (size.w / size.h)
  );
}

/** True when a candidate button position sits inside a TOP-CAP seat's box. */
export function overlapsTopSeatBox(cand: Pos, seat: Pos, size: Size = NOMINAL_SCALER): boolean {
  if (!Number.isFinite(seat.y) || seat.y >= TOP_CAP_SEAT_Y_MAX) return false;
  const c = sq(cand, size);
  const s = sq(seat, size);
  return (
    Math.abs(c.x - s.x) < SEAT_BOX_HALF_WIDTH_PCT &&
    c.y - s.y < SEAT_BOX_DROP_WIDTH_PCT &&
    c.y - s.y > -SEAT_BOX_RISE_WIDTH_PCT
  );
}

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

/* ── KEEP-OUTS, IN SQUARE SPACE ─────────────────────────────────────────────
   All three regions below are axis-aligned rectangles expressed in the same
   units the rail is: one unit is size.w / 100 pixels on BOTH axes. A pixel
   height therefore divides by that unit and NOT by the aspect, which is the
   one place this is easy to get wrong - a pod 122px tall is 122 / (size.w/100)
   units, the same conversion its 96px width gets. */

interface RectSq {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Percent of the table's width -> square-space units (they are the same thing). */
const unitPx = (size: Size) => size.w / 100;

/** The community board. See BOARD_WINDOW. */
function boardRectSq(size: Size): RectSq {
  const feltWidthPx = (FELT_WINDOW.width / 100) * size.w;
  const rowPx = (BOARD_WINDOW.widthOfFeltPct / 100) * feltWidthPx;
  const cardHeightPx = (rowPx / 5) * BOARD_WINDOW.cardAspect;
  const u = unitPx(size);
  const centreYPct = FELT_WINDOW.top + (BOARD_WINDOW.centerOfFeltYPct / 100) * FELT_WINDOW.height;
  const centreYSq = ((centreYPct / 100) * size.h) / u;
  return {
    x0: feltCenter().x - rowPx / 2 / u,
    x1: feltCenter().x + rowPx / 2 / u,
    y0: centreYSq - cardHeightPx / 2 / u,
    y1: centreYSq + cardHeightPx / 2 / u,
  };
}

/** The felt masthead. See FELT_TEXT_BAND. */
function feltTextRectSq(size: Size): RectSq {
  const feltWidthPx = (FELT_WINDOW.width / 100) * size.w;
  const brandPx = Math.min(
    (FELT_TEXT_BAND.widthOfFeltPct / 100) * feltWidthPx,
    FELT_TEXT_BAND.maxWidthPx
  );
  const metaPx =
    FELT_TEXT_BAND.lines * FELT_TEXT_BAND.lineHeightPx +
    (FELT_TEXT_BAND.lines - 1) * FELT_TEXT_BAND.lineGapPx;
  const heightPx = brandPx / FELT_TEXT_BAND.logoAspect + FELT_TEXT_BAND.logoToMetaGapPx + metaPx;
  const u = unitPx(size);
  const topYPct = FELT_WINDOW.top + (FELT_TEXT_BAND.topOfFeltYPct / 100) * FELT_WINDOW.height;
  const topYSq = ((topYPct / 100) * size.h) / u;
  return {
    x0: feltCenter().x - brandPx / 2 / u,
    x1: feltCenter().x + brandPx / 2 / u,
    y0: topYSq,
    y1: topYSq + heightPx / u,
  };
}

/**
 * True when a marker of this radius would sit on the felt masthead - the
 * wordmark and the date / club / union / stakes lines printed under it.
 *
 * The direct measurement of Dan's second report, and what the tests assert on.
 * `markerRadiusWidthPct` is the marker's own radius, so the answer is about the
 * whole disc rather than its centre, exactly as `isInsideFelt` is.
 */
export function isOnFeltText(
  p: Pos,
  size: Size = NOMINAL_SCALER,
  markerRadiusWidthPct: number = 0
): boolean {
  const r = feltTextRectSq(size);
  const q = sq(p, size);
  const pad = markerRadiusWidthPct + MARKER_FELT_TEXT_GAP_WIDTH_PCT;
  return q.x > r.x0 - pad && q.x < r.x1 + pad && q.y > r.y0 - pad && q.y < r.y1 + pad;
}

/**
 * How far along a ray a point may travel before its disc would touch a
 * rectangle, in square-space units. Infinity when the ray misses it entirely.
 *
 * The slab method against the rectangle INFLATED by the disc's radius plus the
 * clear air asked for. Inflating an axis-aligned box rather than offsetting its
 * true rounded outline errs on the safe side everywhere (at an inflated corner
 * the real separation is sqrt(2) times the pad, never less), and a keep-out
 * that is slightly too generous costs a couple of pixels of walk.
 */
function rayEntryDistanceSq(
  from: Pos,
  ux: number,
  uy: number,
  rect: RectSq,
  padWidthPct: number
): number {
  const bounds: Array<[number, number, number, number]> = [
    [from.x, ux, rect.x0 - padWidthPct, rect.x1 + padWidthPct],
    [from.y, uy, rect.y0 - padWidthPct, rect.y1 + padWidthPct],
  ];
  let tMin = -Infinity;
  let tMax = Infinity;
  for (const [origin, dir, lo, hi] of bounds) {
    if (Math.abs(dir) < 1e-12) {
      // Parallel to this pair of slabs: either always between them or never in.
      if (origin < lo || origin > hi) return Infinity;
      continue;
    }
    const a = (lo - origin) / dir;
    const b = (hi - origin) / dir;
    tMin = Math.max(tMin, Math.min(a, b));
    tMax = Math.min(tMax, Math.max(a, b));
  }
  if (tMax < tMin || tMax < 0) return Infinity;
  return Math.max(0, tMin);
}

/**
 * How far a seat has to walk to get its chips off its OWN pod, in square-space
 * units - which is percent of the table's width, the unit the rail is in.
 *
 * The pod is a rectangle centred on the seat (`.seat-wrapper` is
 * `translate(-50%, -50%)`, so the ring position is the centre of the avatar +
 * plate stack), inflated by half a chip and CHIP_POD_GAP_WIDTH_PCT. The exit
 * distance is the smaller of the two axis crossings, which is why a seat
 * walking straight at the middle needs less than one walking on the diagonal -
 * and why this does not fight the board.
 *
 * Zero when the caller supplies no pod. See `chipStepWidthPct`.
 */
function podExitDistanceSq(ux: number, uy: number, size: Size, pod?: Size): number {
  if (!pod) return 0;
  const u = unitPx(size);
  const pad = chipRadiusWidthPct(size) + CHIP_POD_GAP_WIDTH_PCT;
  const halfW = pod.w / 2 / u + pad;
  const halfH = pod.h / 2 / u + pad;
  const tx = Math.abs(ux) < 1e-9 ? Infinity : halfW / Math.abs(ux);
  const ty = Math.abs(uy) < 1e-9 ? Infinity : halfH / Math.abs(uy);
  return Math.min(tx, ty);
}

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
 * How far it walks is `chipStepWidthPct` - the common rail, lengthened only as
 * far as clearing this seat's own pod requires and capped so it can never reach
 * the community cards. Read that function for the order of precedence; the
 * `len * 0.8` degeneracy guard lives there too.
 *
 * `pod` is the seat's avatar-and-plate box IN PIXELS, from `seatPodPx`. It is
 * optional because this module cannot see the DOM and the ladder it comes from
 * keys off the VIEWPORT, which only the caller has. Omitted, the chips walk the
 * plain rail and land exactly where they landed before 2026-08-26 - which is
 * what a consumer that draws no seat pod wants, and what every geometry test
 * that is about the rail itself rather than about the furniture passes.
 */
export function chipRestPosition(seat: Pos, size: Size = NOMINAL_SCALER, pod?: Size): Pos {
  const c = feltCenter();
  const s = sq(seat, size);
  const t = sq(c, size);
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 1e-6) return { x: seat.x, y: seat.y };

  const step = chipStepWidthPct(seat, size, pod);
  const walked = unsq({ x: s.x + (dx / len) * step, y: s.y + (dy / len) * step }, size);
  const onFelt = clampIntoFelt(walked, size);

  /* THE HERO'S LIFT — the one seat off the oval, by Dan's ruling. See
     HERO_CHIP_LIFT_WIDTH_PCT for why this seat and no other.

     AFTER the clamp, not before, and that is the whole trick: the hero's walk
     already overshoots the felt, so anything added to `step` is swallowed by
     the projection and the bet does not move at all. Adding it here lifts the
     bet OFF the boundary it was pinned to. Re-clamped so a small table or a
     future ring cannot push it past the far edge, though at every size that
     ships this lands well inside. */
  if (isHeroSeat(seat)) {
    const lifted = unsq(
      {
        x: sq(onFelt, size).x + (dx / len) * HERO_CHIP_LIFT_WIDTH_PCT,
        y: sq(onFelt, size).y + (dy / len) * HERO_CHIP_LIFT_WIDTH_PCT,
      },
      size
    );
    return clampIntoFelt(lifted, size);
  }
  return onFelt;
}

/**
 * HOW FAR THIS SEAT'S CHIPS WALK, as a percentage of the table's width.
 *
 * One expression, three terms, in strict order of precedence:
 *
 *   1. CHIP_RAIL_WIDTH_PCT is the FLOOR. Every seat walks at least the common
 *      rail, so nothing here can ever hand a seat a shorter walk than its
 *      neighbour - which is the whole of what CHIP_RAIL_SCALE_BOARD_LEVEL did
 *      wrong and the reason it was deleted.
 *   2. The POD is a floor on top of it: the walk is lengthened as far as
 *      leaving the seat's own avatar-and-plate rectangle requires, and not one
 *      unit further. A no-op for any seat with the room, which on a 646px
 *      desktop felt is most of them.
 *   3. The BOARD is the CEILING, and it wins. If a seat cannot have both, its
 *      chips stay off the community cards and accept the plate: on the one
 *      configuration where the two collide - a 404px table carrying 96 x 122px
 *      desktop pods, i.e. a 1440x900 laptop - the 4-max middle seats come up
 *      4.7px short of clearing their plate. That is a stated cost, not an
 *      oversight. The ceiling is itself floored at the common rail, so it can
 *      only ever claw back the extra the pod asked for.
 *
 * `len * 0.8` is the same degeneracy guard `chipRestPosition` has always
 * carried: a seat sitting on the middle of the felt has no room to walk a full
 * rail. No production ring comes near it.
 *
 * Exported because it is the number a person wants when a bet looks wrong, and
 * because the tests measure it directly rather than inferring it from a
 * position that two projections have already touched.
 */
/**
 * Would this seat's chips, walked `stepWidthPct`, sit clear of the community
 * cards?
 *
 * Deliberately mirrors the rectangle and the margins in
 * tests/table-geometry-chips.test.ts rather than reusing `rayEntryDistanceSq`:
 * that ray test uses a tighter chip margin, so it can pass while the board
 * check the suite actually enforces fails. Two definitions of "on the board"
 * is how a nudge lands chips on the flop. Keep these in step.
 */
function chipsClearOfBoard(seat: Pos, stepWidthPct: number, size: Size): boolean {
  const c = feltCenter();
  const s = sq(seat, size);
  const t = sq(c, size);
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 1e-6) return true;
  const p = unsq({ x: s.x + (dx / len) * stepWidthPct, y: s.y + (dy / len) * stepWidthPct }, size);
  const boardHalfW = 0.34 * FELT_WINDOW.width;
  const cardW = (0.68 * FELT_WINDOW.width) / 5;
  const boardHalfH = ((cardW * 92) / 64 / 2) * (1000 / 605);
  const chipHalf = 2;
  const onX = Math.abs(p.x - c.x) < boardHalfW + chipHalf;
  const onY = Math.abs(p.y - c.y) < boardHalfH + chipHalf * (1000 / 605);
  return !(onX && onY);
}

export function chipStepWidthPct(seat: Pos, size: Size = NOMINAL_SCALER, pod?: Size): number {
  const c = feltCenter();
  const s = sq(seat, size);
  const t = sq(c, size);
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 1e-6) return 0;

  const ux = dx / len;
  const uy = dy / len;
  const wanted = Math.max(CHIP_RAIL_WIDTH_PCT, podExitDistanceSq(ux, uy, size, pod));
  const board = rayEntryDistanceSq(
    s,
    ux,
    uy,
    boardRectSq(size),
    chipRadiusWidthPct(size) + BOARD_CHIP_GAP_WIDTH_PCT
  );
  const ceiling = Math.max(CHIP_RAIL_WIDTH_PCT, board);
  const base = Math.min(wanted, ceiling, len * 0.8);

  /* ── Dan 2026-08-26's 3px, added LAST and withdrawn if the board objects ──
     `base` is exactly what this function returned before the inset existed,
     so the inset only ever ADDS to a known-good distance — and
     `chipsClearOfBoard` re-checks the RESULTING point against the same board
     rectangle (and the same generous chip margin) that
     tests/table-geometry-chips.test.ts uses, so a seat that would be pushed
     onto the community cards silently keeps its old position instead.

     Tried and rejected: folding the inset into `wanted`, and into `ceiling`.
     Both raised the board limit by the same 3px and put a board-level seat's
     chips on the flop at 375px. The module's own ray guard uses a tighter
     margin than the test does, so agreeing with the test is the only way this
     is actually safe. Chips never cross the cards; that outranks the nudge. */
  const inset = markerInsetWidthPct(size);
  if (inset <= 0) return base;
  const nudged = Math.min(base + inset, len * 0.8);
  return chipsClearOfBoard(seat, nudged, size) ? nudged : base;
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
 *      OR the puck has landed on the printed masthead, walk the button AROUND
 *      the felt until BOTH are satisfied: MARKER_MIN_GAP_WIDTH_PCT of daylight
 *      from its own chips (item 13), and off FELT_TEXT_BAND (Dan 2026-08-26,
 *      "the button should be moved up some ... so it doesn't overlap the
 *      date"). The button is the marker with somewhere else to be, so it is the
 *      one that moves; the chips are not touched to solve either.
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
export function dealerButtonPosition(seat: Pos, size: Size = NOMINAL_SCALER, pod?: Size): Pos {
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

  // THE COMMON RAIL, NOT THIS SEAT'S. `chipStepWidthPct` can be longer than
  // CHIP_RAIL_WIDTH_PCT where a pod needs clearing, and scaling the button with
  // it was TRIED AND REJECTED: on a 404px table the 9-max bottom-cap puck ended
  // up 94px from its own chair and 82px from the chair above it, and the walk
  // reached 0.40 of the seat's run to the middle - the ceiling the geometry
  // tests state. The button has no plate to clear (it stands at 0.85 of the
  // rail, inside the pod, and the on-felt projection then decides where it
  // actually lands for almost every seat), and pushing the CHIPS out only ever
  // increases the daylight between the two markers. So the puck stays put and
  // the chips walk past it, which is also the reading order Dan asked for:
  // player, button, chips.
  /* ── THE BUTTON DOES NOT TAKE THE 3px, AND THIS IS THE SECOND TIME ───────
     Dan 2026-08-26 asked for "all chip placements AND button" to move 3px
     further in. The chips do (see `chipStepWidthPct`). The button was tried
     and measured, and it fails the ownership rule: on a 9-max 375px table the
     bottom-cap puck ends up 74.3px from its own chair and 77.8px from the
     chair above it — a button that reads as belonging to the wrong player,
     which is worse than a button 3px nearer the rail. That is the same
     failure the pod-clearance pass hit when it tried to scale the button with
     the lengthened rail, recorded in the note just above.

     The button is not left where it was, though: it is walked off the felt
     edge with its own daylight margin in step 2 below, and step 3 walks it
     further for marker separation, so for almost every seat the projection —
     not this step — is what decides its final position. The overlap Dan
     actually reported (the puck sitting on the printed date) was fixed at
     source by the masthead keep-out, not by moving the puck inward. */
  const step = Math.min(CHIP_RAIL_WIDTH_PCT * BUTTON_RAIL_RATIO, len * 0.8);
  const walked = unsq({ x: s.x + rx * step, y: s.y + ry * step }, size);
  const placed = clampIntoFelt(walked, size, BUTTON_FELT_MARGIN_WIDTH_PCT);

  // The chips this puck has to stay clear of are the REAL ones, so the pod is
  // passed through: judging against a shorter walk than the chips actually take
  // would rotate the button to dodge a stack that is not there any more.
  const chips = chipRestPosition(seat, size, pod);
  const puck = buttonRadiusWidthPct(size);
  // Item 2 (Dan 2026-08-26): a candidate must clear the chips, stay off the
  // printed masthead, AND - for a top-cap seat - stay out of the seat's own
  // rendered box (avatar + nameplate hanging over the felt's top edge). One
  // predicate, used by the direct placement and by every swing candidate.
  const clear = (p: Pos) =>
    markerGapWidthPct(p, chips, size) >= MARKER_MIN_GAP_WIDTH_PCT &&
    !isOnFeltText(p, size, puck) &&
    !overlapsTopSeatBox(p, seat, size) &&
    !overlapsBoard(p, size);
  if (clear(placed)) return placed;

  // Swing it around the middle of the felt, 1.5 degrees at a time, out to a
  // quarter turn - far more than any seat on any ring has ever needed. The
  // swing happens in square space so the angle is the angle a person sees, and
  // every candidate is put back on the felt before it is judged.
  //
  // ALL conditions travel together (Dan 2026-08-26, both reports): the puck
  // must be clear of its own chips, off the printed masthead, and out of a
  // top-cap seat's box - satisfied by the SAME candidate, because solving them
  // one after the other lets a later rotation walk the puck back into an
  // earlier problem. Both directions are searched to THEIR first acceptable
  // angle and the winner is the candidate nearer its OWN seat: first-found
  // used to decide, and on a top-cap seat whose box is easier to clear on one
  // side, first-found could walk the puck toward a NEIGHBOURING chair -
  // tests/unit/chipRail.test.ts pins that a button always stays nearest the
  // seat it was computed for.
  const pv = sq(placed, size);
  const cv = sq(c, size);
  const sv = sq(seat, size);
  let best: Pos | null = null;
  let bestDist = Infinity;
  for (const dir of [1, -1]) {
    for (let i = 1; i <= 60; i++) {
      const phi = dir * i * 1.5 * (Math.PI / 180);
      const cosP = Math.cos(phi);
      const sinP = Math.sin(phi);
      const vx = pv.x - cv.x;
      const vy = pv.y - cv.y;
      /* Swung candidates ride the BOUNDARY, in both directions. The stadium
         is not a circle, so a point swung along its own arc can land INSIDE
         the inset boundary near the straight walls - and clampIntoFelt only
         pulls outside points in, it never pushes inside points out. A sunken
         candidate breaks the "never deeper in than the chips" ordering, so
         every candidate is projected exactly onto the button's boundary
         before it is judged. */
      const swung = unsq(
        { x: cv.x + vx * cosP - vy * sinP, y: cv.y + vx * sinP + vy * cosP },
        size
      );
      const exit = feltExitScale(swung, size, BUTTON_FELT_MARGIN_WIDTH_PCT);
      const cand = Number.isFinite(exit)
        ? { x: c.x + (swung.x - c.x) * exit, y: c.y + (swung.y - c.y) * exit }
        : swung;
      if (clear(cand)) {
        const cs = sq(cand, size);
        const d = Math.hypot(cs.x - sv.x, cs.y - sv.y);
        if (d < bestDist) {
          best = cand;
          bestDist = d;
        }
        break; // this direction's first (smallest-swing) acceptable candidate
      }
    }
  }
  return best ?? placed;
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
 * THE COMMON RAIL, which is the FLOOR every seat walks - not necessarily what a
 * given seat walks. A seat whose own pod reaches past it walks further (guarantee
 * 4); `chipStepWidthPct(seat, size, pod)` is that seat's answer.
 *
 * ── THE `isDealer` ARGUMENT IS GONE (audit 2026-08-25) ──────────────────────
 * These three functions used to take a third `_isDealer` parameter that the
 * body ignored. It once added CHIP_RAIL_DEALER_EXTRA_PX so the button holder's
 * chips could clear their own puck; the puck moves instead now (see
 * `dealerButtonPosition`), because giving one seat a longer rail is the exact
 * thing item 13 forbids. The parameter was left behind so the call sites kept
 * compiling, which made every signature say "the dealer gets different chips"
 * when nothing had said that for weeks - and a test was passing `true` and
 * `false` to prove they were the same, which is a test of a parameter that
 * should not exist. The call sites in TablePage.tsx already pass two
 * arguments; the parameter is now dropped here to match.
 *
 * ── AND IT IS NOT COMING BACK AS `pod` (2026-08-26) ─────────────────────────
 * The chip functions do take a third argument again, and it is a different KIND
 * of thing: `pod` is the size of the avatar-and-plate box every seat paints, so
 * the chips can be walked off it. It is not a property of the player - the
 * dealer's pod is the same box as everyone else's - and passing it cannot give
 * one seat a longer rail than another seat with the same pod and the same
 * angle. It is declared with a DEFAULT rather than as `pod?`, so
 * `betChipOffsetPx.length` is still 2: two required arguments, which is the
 * thing tests/unit/chipRail.test.ts is really pinning. A boolean in that slot
 * is a type error, which is the other half.
 */
export function chipRailInset(size: Size): number {
  /* Includes MARKER_INSET_PX (Dan 2026-08-26, "3 pixels farther into the
     table"). This function IS the definition of "the common rail" for every
     caller and for the tests that pin one-rail-for-every-seat, so the inset
     has to live here too — otherwise the rule and the measurement of the rule
     disagree by exactly three pixels and the tests fail on correct code. */
  return (CHIP_RAIL_WIDTH_PCT / 100) * size.w + MARKER_INSET_PX;
}

/**
 * Pixel offset from a seat to its resting bet chips.
 *
 * Pixels because the caller positions with translate(). See `chipRestPosition`
 * for the rule.
 */
export function betChipOffsetPx(seat: Pos, size: Size, pod: Size | undefined = undefined): Pos {
  const p = chipRestPosition(seat, size, pod);
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
export function chipCollectOffsetPx(seat: Pos, size: Size, pod: Size | undefined = undefined): Pos {
  const c = feltCenter();
  const dxPx = ((c.x - seat.x) * size.w) / 100;
  const dyPx = ((c.y - seat.y) * size.h) / 100;
  const rest = betChipOffsetPx(seat, size, pod);
  return {
    x: Math.round(dxPx * CHIP_COLLECT_FRACTION - rest.x),
    y: Math.round(dyPx * CHIP_COLLECT_FRACTION - rest.y),
  };
}
