/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE SEAT GEOMETRY — pure
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Moved out of TablePage.tsx on 2026-08-19. These are measured positions on the
 * painted rail — percentages of the 896x1200 skin frame — and the comments
 * carry the measurements and the reasoning behind them. That is exactly the
 * kind of knowledge that evaporates when an 8,700-line file gets rewritten, and
 * when it does, seats land on the felt or off the table entirely.
 *
 * Pure data plus small functions, so the geometry can be tested directly:
 * every ring has hero at slot 0, every seat sits inside the frame, and no table
 * size can index past the end of its ring. The rotation and pixel projection at
 * the foot of the file are the same idea one step later — where each seat
 * actually lands on screen once the hero is put at the bottom.
 */
import type { SeatPlayer } from '../components/table/SeatSlot';

/* ── Dan 2026-08-25, mobile pass item 4 — WHERE THE HERO SITS ────────────────
   "The Hero position needs to be moved down. They should be on the rail, not
   on the table."

   The hero's y is STILL 100 and must stay 100: that is the scaler's bottom
   edge, measured against the painted skin, and every other rail number is
   measured from the same frame. What actually put the hero on the felt was a
   CSS lift bolted on top of it — `.seat-wrapper--hero { --hero-lift: 78px }`
   in TablePage.css, added 2026-08-23 so the stack would stop being cut off by
   the fixed action bar. 78px is most of a seat: it carried the whole hero
   block up off the rail and onto the playing surface.

   So the fix is a CSS offset, not a new number here — see
   `.seat-wrapper.seat-wrapper--hero` in SeatSlot.css, which retires the lift
   by re-declaring `--hero-lift` as 0 at a specificity neither that rule nor
   its two short-viewport reductions can reach. Retiring the variable rather
   than adding a counter-offset means the hero lands on the ring's own measured
   position at every viewport height, with nothing left to keep in step.

   ── item 7 — WHERE THE TOP SEATS SIT ────────────────────────────────────────
   "The top two players need to be moved up more. Their action boxes should be
   on the rail, not on the table."

   The felt window (.table-surface) starts at y 8.9% of the scaler and the rail
   band is centred near 8.5%, so a box whose TOP edge is below 8.9% is floating
   on the playing surface. With the avatar drawn ABOVE the nameplate the box
   sits a whole avatar below the seat centre, which is why the top cap has to
   be this high to get the plate onto the rail at all:

     top cap diagonals  8.5 -> 6     (9-max seats 5/6, 7-max, 5-max, 3-max)
     top centre         6   -> 5     (2/4/6/8-max)

   That is the highest either can go while the bust art — drawn rising from the
   character's feet, so it overhangs the avatar slot upward — stays inside the
   table canvas. The remaining headroom was bought by dropping the top row's
   bust scale from 1.15 to 1.05 (see `.seat-wrapper--top` in SeatSlot.css);
   without that, 5 puts the art's crown above y 0 and into the banner.
   tests/e2e/top-rail-seat.spec.ts measures exactly this and is the guard. */
export const SEAT_POSITIONS_6MAX = [
  { x: 50, y: 100 }, // Seat 1 (Hero, bottom-centre; ring position only - the rail drop is CSS, see above)
  { x: 10.5, y: 66 }, // Seat 2 (lower-left, on rail side)
  { x: 10.5, y: 33 }, // Seat 3 (upper-left, on rail side)
  { x: 50, y: 5 }, // Seat 4 (top-center; box rests ON the rail band - compact seat)
  { x: 89.5, y: 33 }, // Seat 5 (upper-right, on rail side)
  { x: 89.5, y: 66 }, // Seat 6 (lower-right, on rail side)
];

/* ── Dan 2026-08-25 round 2, item 10 — THE SEAT UNDER THE TOP CAP SAT TOO LOW ──
   "Villan 'Violet Wei' and villan Jaxaaron should both be raised up higher in
   their positions on the table." Those two are the `left-high` / `right-high`
   entries below, and they were at y 36.

   The ring is meant to be evenly distributed, so this is arithmetic rather
   than taste. Gaps are measured on the painted frame, where the width is 605
   for every 1000 of height (the scaler's locked aspect), so one point of x is
   6.05px and one point of y is 10px. Walking the left rail with y 36:

       hero (50,100) -> (10.5,82.5)   297px
       (10.5,82.5)   -> (10.5,58)     245px
       (10.5,58)     -> (10.5,36)     220px   <- the crowded pair
       (10.5,36)     -> (27,6)        316px   <- and the hole above them

   That is the widest gap on the ring sitting directly above the narrowest one,
   which is exactly what "too low" looks like. Solving for the two seats that
   split the run from the bottom cap to the top cap into three EQUAL legs gives
   y 56.3 and y 30.2. 58 is within 1.7 points of its answer, so it stays put and
   only the crowded seat moves; 36 -> 30 turns the four gaps into

       297 / 245 / 280 / 260

   — max-to-min 1.14 where it was 1.44 — and lifts the seat 60px on the frame.
   Still on the rail (x is untouched, and the felt window starts at x 18.8%),
   still clear of the two thresholds that read this y: `.seat-wrapper--top` at
   y < 20 and the chat bubble's flip at y < 22. */
export const SEAT_POSITIONS_9MAX = [
  { x: 50, y: 100 }, // Seat 1 (Hero, bottom-centre; ring position only - the rail drop is CSS, see above)
  { x: 10.5, y: 82.5 }, // Seat 2 (lower-left, bottom cap)
  { x: 10.5, y: 58 }, // Seat 3 (left-low, on rail side)
  { x: 10.5, y: 30 }, // Seat 4 (left-high, on rail side; 36 -> 30, see the note above)
  { x: 27, y: 6 }, // Seat 5 (top-left, top cap - plate on the rail)
  { x: 73, y: 6 }, // Seat 6 (top-right, top cap - plate on the rail)
  { x: 89.5, y: 30 }, // Seat 7 (right-high, on rail side; 36 -> 30, see the note above)
  { x: 89.5, y: 58 }, // Seat 8 (right-low, on rail side)
  { x: 89.5, y: 82.5 }, // Seat 9 (lower-right, bottom cap)
];

/* Dan 2026-08-17 — PER-SIZE SEAT RINGS.
   Production runs 2..9-max tables, but the client only had 6MAX/9MAX rings picked
   by `maxPlayers === 9`. An 8-max table therefore indexed seats 7-8 past the
   end of the 6-seat array — no position at all. Every count now has its own
   ring on the SAME measured rail band (sides x 10.5/89.5, top cap y 8.5,
   top diagonals on the cap circle, bottom caps (19/81, 82.5)); hero is
   always slot 0, bottom-center.

   CORRECTION 2026-08-19: this comment used to cite "53 seven-max plo6 + 472
   eight-max tables live in the fleet" as evidence for the range. Those seat
   counts are ILLEGAL for that variant — Dan: "ITS ALWAYS 6 MAX FOR PLO 6 AND
   7 MAX FOR PLO5" — so they were evidence of a missing seat cap, not of a
   supported configuration, and citing them as normal is what led a later
   audit to reason from an 8-max PLO6 table that cannot exist. The caps now
   live in src/config/tableSeating.ts and are enforced in TableService. The
   rings below still cover 2..9 because other variants legitimately use them
   and because 10,130 pre-existing rows still carry the old seat counts.

   2026-08-25: the top cap moved up with the named rings above (diagonals
   8.5 -> 6, top centre 6 -> 5). Every size shares those two numbers on
   purpose — the cap is one measured band, not a per-size taste call. */
export const SEAT_LAYOUTS: Record<number, Array<{ x: number; y: number }>> = {
  2: [
    { x: 50, y: 100 }, // Hero (ring position; the rail drop is CSS - see the note above)
    { x: 50, y: 5 }, // Villain, top-center (heads-up), box on the rail
  ],
  3: [
    { x: 50, y: 100 }, // Hero (ring position; the rail drop is CSS - see the note above)
    { x: 20.5, y: 6 }, // upper-left diagonal, on rail cap circle
    { x: 79.5, y: 6 }, // upper-right diagonal
  ],
  4: [
    { x: 50, y: 100 }, // Hero (ring position; the rail drop is CSS - see the note above)
    { x: 10.5, y: 45 }, // left-middle
    { x: 50, y: 5 }, // top-center, box on the rail
    { x: 89.5, y: 45 }, // right-middle
  ],
  5: [
    { x: 50, y: 100 }, // Hero (ring position; the rail drop is CSS - see the note above)
    { x: 10.5, y: 55 }, // left-low
    { x: 20.5, y: 6 }, // upper-left diagonal
    { x: 79.5, y: 6 }, // upper-right diagonal
    { x: 89.5, y: 55 }, // right-low
  ],
  6: SEAT_POSITIONS_6MAX,
  7: [
    { x: 50, y: 100 }, // Hero (ring position; the rail drop is CSS - see the note above)
    { x: 10.5, y: 62 }, // left-low
    { x: 10.5, y: 33 }, // left-high
    { x: 27, y: 6 }, // top-left diagonal
    { x: 73, y: 6 }, // top-right diagonal
    { x: 89.5, y: 33 }, // right-high
    { x: 89.5, y: 62 }, // right-low
  ],
  /* 8-max carried the SAME crowding as 9-max (see SEAT_POSITIONS_9MAX): the
     left/right-high pair sat at 28 with a 240px gap below them and a 331px hole
     above them, up to the top-centre seat. The even-thirds solve for this run —
     bottom cap (10.5,82.5) to top centre (50,5) — is 52.7 and 22.8; 52 is
     already right, and 23 is used rather than 22.8 because y < 22 flips the chat
     bubble below the plate and y < 20 claims the compact top-cap treatment, and
     this seat is neither. Gaps become 305 / 290 / 299 where they were
     305 / 240 / 331. 7-max is deliberately NOT touched: its seat under the top
     cap sits 288px from the cap and 290px from its lower neighbour, which is
     already even — 7-max's uneven gap is the 449px hero-to-first-seat run,
     which raising these seats would only make worse. */
  8: [
    { x: 50, y: 100 }, // Hero (ring position; the rail drop is CSS - see the note above)
    { x: 10.5, y: 82.5 }, // lower-left bottom cap
    { x: 10.5, y: 52 }, // left-low
    { x: 10.5, y: 23 }, // left-high (28 -> 23, see the note above)
    { x: 50, y: 5 }, // top-center, box on the rail
    { x: 89.5, y: 23 }, // right-high (28 -> 23, see the note above)
    { x: 89.5, y: 52 }, // right-low
    { x: 89.5, y: 82.5 }, // lower-right bottom cap
  ],
  9: SEAT_POSITIONS_9MAX,
};

/* ═══════════════════════════════════════════════════════════════════════════
   WHICH SIDE OF A SEAT ITS HOLE-CARD FAN HANGS OFF
   ═══════════════════════════════════════════════════════════════════════════

   Dan 2026-08-26 villain-fan rebuild, spec section 3b: ONE rule, everywhere.
   The fan is MIRRORED OUTWARD — away from the middle of the table. Left-half
   seats fan left, right-half seats fan right. This keeps the betting lane
   (between pod and pot) clear: chips render on the pod's inward side, cards
   on its outward side, so the two can never collide.

   This deliberately replaces the 2026-08-25 two-band rule (outboard at the
   top cap, inboard everywhere else). Inboard put a rail seat's cards in its
   own betting lane, which is exactly what the rebuild's reference screenshots
   flagged. The overflow concern that motivated inboard — an outboard PLO hand
   running off a 375px phone — is retired by the fan geometry itself: the fan
   is tucked 0.32 x card width under the avatar, capped at 2.5 card widths for
   six cards, and scales with the avatar token, so it is a fraction of the old
   row's width.

   Derived from the seat's measured position on the ring — never from a seat
   INDEX, because an index means a different chair at every table size, while
   "left of the middle of the table" means the same thing on every ring from
   2-max to 9-max.

   x exactly 50 (the top-centre and hero slots) has no side and defaults to
   'right'. NaN answers 'right' for the same reason — see `seatWrapperPercent`
   in SeatSlot.tsx, which returns NaN when it cannot measure and must degrade
   to the long-standing default rather than to a coin flip.

   Pure and position-only so the rule can be applied to a percentage read off
   a ring above or to one measured from the DOM; SeatSlot does the latter,
   since a seat is handed its number but never its position. */
export type CardSide = 'left' | 'right';

/**
 * Above this share of the frame a seat is a TOP-CAP seat — the row of seats
 * with the BBJ banner rather than felt above them. Kept because TablePage's
 * `.seat-wrapper--top` tagging (pos.y < 20) and the compact top-row avatar
 * treatment still key off this band; the fan side no longer does.
 */
export const TOP_CAP_Y_MAX = 20;

/** True for the top row of seats — the compact-avatar band under the banner. */
export function isTopCapSeat(yPercent: number): boolean {
  return Number.isFinite(yPercent) && yPercent < TOP_CAP_Y_MAX;
}

/** AWAY from the middle of the table — the one rule, every seat. */
export function outboardCardSide(xPercent: number): CardSide {
  return Number.isFinite(xPercent) && xPercent < 50 ? 'left' : 'right';
}

/**
 * THE rule: outward mirroring at every seat, on every ring.
 *
 * `yPercent` is accepted (and ignored) so every existing call site — which
 * measures both coordinates anyway — keeps compiling; the side is a function
 * of x alone now that the two-band rule is gone.
 */
export function seatCardSide(xPercent: number, _yPercent: number): CardSide {
  return outboardCardSide(xPercent);
}

/** Ring for a table size; clamps to [2, 9] so unknown sizes never crash. */
export function seatLayoutFor(maxPlayers: number): Array<{ x: number; y: number }> {
  return SEAT_LAYOUTS[Math.min(9, Math.max(2, maxPlayers || 9))];
}

// Create empty player slots for a table
export const createEmptySeats = (count: 6 | 9): (SeatPlayer | null)[] => {
  return Array(count).fill(null);
};

// ═══════════════════════════════════════════════════════════════════════════════
//  SEAT ROTATION + PIXEL PROJECTION
// ═══════════════════════════════════════════════════════════════════════════════
// Moved out of TablePage.tsx on 2026-08-19, second pass. Both of these were
// inline useMemo bodies. They are the last step between a measured ring above
// and what a player actually sees, and both have a history: the rotation has
// been applied twice by mistake (dealer button landed on the wrong seat), and
// the pixel projection replaced a hardcoded 800x500 ellipse that matched
// nothing on screen.

export interface SeatPos {
  x: number;
  y: number;
}

/** A physical seat's screen position plus the visual slot it rotated into. */
export interface RotatedSeat {
  pos: SeatPos;
  visualIndex: number;
}

/**
 * Rotate a ring so the hero's physical seat renders at slot 0 (bottom-centre).
 *
 * Indexed by PHYSICAL seat index: `rotateSeatsForHero(ring, heroSeat)[i]` is
 * where physical seat i+1 should be drawn. Anything reading this array is
 * therefore already rotated and must not rotate again.
 *
 * `heroSeat` is 1-indexed; 0 means the hero is not seated, and the ring is left
 * in its natural orientation.
 *
 * The `% maxP` on the hero index is a guard, not decoration. Without it a hero
 * seat larger than the ring (seat 9 while `maxPlayers` still reads its initial
 * 6, which is exactly what a slow table-row fetch produces) drives
 * `(physIdx - heroIdx + maxP) % maxP` negative — JavaScript's remainder keeps
 * the sign of the dividend — and `ring[-2]` is `undefined`. The seat renderer
 * then reads `pos.y` off nothing and the whole table white-screens. The
 * finite/floor guard covers the same failure from the other direction — a
 * fractional or Infinite seat number also indexes nothing. All of it only
 * touches inputs that could not render at all, so no working case moves.
 */
export function rotateSeatsForHero(ring: SeatPos[], heroSeat: number): RotatedSeat[] {
  const maxP = ring.length;
  if (maxP === 0) return [];
  const raw = Number.isFinite(heroSeat) && heroSeat > 0 ? Math.floor(heroSeat) - 1 : 0;
  const heroIdx = raw % maxP;
  return ring.map((_, physIdx) => {
    // Visual slot: rotate so hero's physical index maps to slot 0.
    const visualIdx = (physIdx - heroIdx + maxP) % maxP;
    return { pos: ring[visualIdx], visualIndex: visualIdx };
  });
}

/**
 * Percentages of the table scaler -> pixels inside that same scaler, keyed by
 * 1-indexed seat number (what ThrowEvent.fromSeat/toSeat use).
 *
 * Dan 2026-08-15 — THROWABLE GEOMETRY (item 4). Throws used to be positioned by
 * useTableAnimations.getSeatPositions(), which invented a hardcoded 800x500
 * ellipse (centre 400,250 / radii 300,150) that corresponds to nothing on
 * screen. The real table is a 341:609 PORTRAIT box, so the projectile launched
 * and landed at arbitrary points — never on the villain's avatar. Every other
 * animation on this table (dealer button, deal, chip flights) drives off the
 * hero-rotated percentage map that the seats themselves render from, so throws
 * do too.
 *
 * Scaler-relative rather than viewport pixels on purpose: MultiTablePage puts a
 * `transform` on its container, so a position:fixed overlay would re-anchor to
 * that transformed strip and land the throw in the wrong tab. .table-scaler is
 * position:relative, so an absolutely-positioned child inside it shares exactly
 * the seats' geometry and follows the table through any resize or rescale.
 */
export function seatPixelMap(
  seatPositions: Array<SeatPos | null | undefined>,
  scaler: { w: number; h: number }
): Map<number, { x: number; y: number }> {
  const map = new Map<number, { x: number; y: number }>();
  seatPositions.forEach((pct, physIdx) => {
    if (!pct) return;
    map.set(physIdx + 1, {
      x: (pct.x / 100) * scaler.w,
      y: (pct.y / 100) * scaler.h,
    });
  });
  return map;
}
