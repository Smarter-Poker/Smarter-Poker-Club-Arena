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

export const SEAT_POSITIONS_9MAX = [
  { x: 50, y: 100 }, // Seat 1 (Hero, bottom-centre; ring position only - the rail drop is CSS, see above)
  { x: 10.5, y: 82.5 }, // Seat 2 (lower-left, bottom cap)
  { x: 10.5, y: 58 }, // Seat 3 (left-low, on rail side)
  { x: 10.5, y: 36 }, // Seat 4 (left-high, on rail side)
  { x: 27, y: 6 }, // Seat 5 (top-left, top cap - plate on the rail)
  { x: 73, y: 6 }, // Seat 6 (top-right, top cap - plate on the rail)
  { x: 89.5, y: 36 }, // Seat 7 (right-high, on rail side)
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
  8: [
    { x: 50, y: 100 }, // Hero (ring position; the rail drop is CSS - see the note above)
    { x: 10.5, y: 82.5 }, // lower-left bottom cap
    { x: 10.5, y: 52 }, // left-low
    { x: 10.5, y: 28 }, // left-high
    { x: 50, y: 5 }, // top-center, box on the rail
    { x: 89.5, y: 28 }, // right-high
    { x: 89.5, y: 52 }, // right-low
    { x: 89.5, y: 82.5 }, // lower-right bottom cap
  ],
  9: SEAT_POSITIONS_9MAX,
};

/**
 * Which side of a seat its hole cards hang off.
 *
 * Dan 2026-08-25, item 7: "The guy on the left, his cards should be on the
 * left." The top cap seats used to throw their face-down row to the RIGHT
 * unconditionally (`.seat-wrapper--top ... { left: calc(100% + 4px) }`), which
 * is correct for the top-RIGHT seat and wrong for the top-LEFT one: it threw
 * that player's cards inward, straight at the neighbour's, so a PLO5 table
 * showed five and five running together as one unbroken row of ten (item 12).
 *
 * Derived from the seat's measured x rather than from a seat INDEX because the
 * index means a different chair at every table size — index 4 is the top-left
 * diagonal at 9-max and the top CENTRE at 8-max — while "left of the middle of
 * the table" means the same thing on every ring from 2-max to 9-max. Dead
 * centre (the top-centre and hero slots, x exactly 50) resolves to 'right',
 * which is where those two have always hung their cards and where the only
 * open felt is.
 *
 * Pure and x-only so it can be applied to a percentage read off the ring or
 * to one measured from the DOM; SeatSlot does the latter, since a seat is
 * handed its number but never its position.
 */
export type CardSide = 'left' | 'right';

export function outboardCardSide(xPercent: number): CardSide {
  return Number.isFinite(xPercent) && xPercent < 50 ? 'left' : 'right';
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
