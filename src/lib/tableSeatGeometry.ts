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

   ── Dan 2026-08-26 mobile pass, item 3 — SIDE SEATS OFF THE FELT ────────────
   "All avatars on the sides need to be moved over off the tables on both
   sides and closer to the edge of the screens. They are creeping onto the
   table too far." The side rails moved from x 10.5/89.5 to x 8/92 — every
   ring, both sides. The felt window starts at x 13.3, so at 8 the seat CENTRE
   is clearly on the painted rail and the avatar art hangs toward the screen
   edge rather than over the felt. Chips and the dealer button are computed
   from the seat position and clamped INTO the felt by tableGeometry.ts, so
   they follow correctly without a second edit.

   The BOTTOM CAPS (y 82.5) deliberately stay at 10.5/89.5: pushing them to
   8/92 drove their dealer-button projection so deep inboard that the puck
   measured nearer the seat ABOVE than its own seat — the exact "whose button
   is that" failure tests/table-geometry-chips.test.ts pins. The corners sit
   against the rail's curve, so they were never the seats creeping onto the
   felt anyway.

   That is the highest either can go while the bust art — drawn rising from the
   character's feet, so it overhangs the avatar slot upward — stays inside the
   table canvas. The remaining headroom was bought by dropping the top row's
   bust scale from 1.15 to 1.05 (see `.seat-wrapper--top` in SeatSlot.css);
   without that, 5 puts the art's crown above y 0 and into the banner.
   tests/e2e/top-rail-seat.spec.ts measures exactly this and is the guard. */

/* ═══════════════════════════════════════════════════════════════════════════
   THE BOARD'S BAND — why no seat sits at the middle of the side rail any more
   (Dan 2026-08-27, item 2; the seat move that item 2 was waiting on)
   ═══════════════════════════════════════════════════════════════════════════

   "The board cards need to be increased in size, you need to make it so the
   card size equals the entire width of the table ... LIKE FELT WINDOW 95%."

   The board could not grow past 68% of the felt while a seat sat level with it,
   and that was never a stylesheet problem. Three separate things collide with a
   wide board, and all three are decided HERE:

     1. the seat's BET CHIPS, which walk one 12.5%-of-width rail toward the pot;
     2. the seat's DEALER BUTTON, projected onto the felt with daylight;
     3. the SEAT BOX ITSELF — a fixed 96px card of avatar + nameplate that does
        not shrink with the phone (`.seat { width: 96px }`, SeatSlot.css).

   (3) is the one that makes this a seat problem rather than a chip problem. A
   95% board spans x 15.1..84.7% of the scaler; a side seat at x 10.5% spans
   x -3.3..24.3% on a 375px phone. They overlap by 32px NO MATTER WHERE THE
   CHIPS GO. There is no rail short enough and no anchor high enough: the only
   way a board that wide can exist is for the seats to be somewhere else
   VERTICALLY.

   So the rail's middle is now a no-go band. Measured against the shipped 95%
   board at its anchor (`.community-area { top: 42.5% }` -> y 43.03% of the
   scaler, half-height 5.85%), and taking the WORST of the three table sizes the
   app renders, a seat at x 10.5/89.5 must satisfy

       y <= 26.7      (the DEALER BUTTON binds here — its projection onto the
                       felt's arc drags it down toward the cards)
       y >= 57.3      (the SEAT BOX binds here — 48px of nameplate below the
                       seat's centre)

   THE RAIL MOVED WHILE THAT WAS BEING SOLVED, AND IT MOVED THE CEILING DOWN.
   The two numbers above were derived at x 10.5/89.5. Item 3 (2026-08-26, see
   the note above) then took the side rail out to x 8/92, and the SAME 2026-08-26
   commit rewrote the button's swing so it "searches both directions and keeps
   the candidate nearest its own seat". Further from the board is not further
   from the CARDS once the puck is projected: at x 8 the button lands INBOARD of
   where it landed at 10.5, and the top ceiling tightens.

   Re-measured against the shipped rings, board and projection — not re-derived
   by hand, since the button is placed by a search and restating a search is how
   a derivation goes stale:

       x 8      y <= 25.77     <- the binding rail
       x 92     y <= 28.5
       both     y >= 57.5

   The left rail binds because the swing is not symmetric. So the high side seats
   sit at 25, which carries 0.53 points of y — 3.1px on a 375px phone — between
   the puck and the top card, the same clearance the 26.7 ceiling was given when
   it was 26. 26 is NOT available at x 8: it puts the puck 0.16 points ONTO the
   cards, which is precisely the failure
   tests/table-seat-ring-integrity.test.ts catches.

   Every side seat therefore sits at 25 or at 58, 67 or 82.5. The BOTTOM CAPS
   are still at 10.5/89.5 (item 3 left them there on purpose) and at y 82.5 are
   the length of the felt below the band either way.
   tests/unit/mobileBoardAndActionBar.test.ts re-derives the ceiling from the
   shipped rings on every run and fails if a chair moves back into it.

   WHAT IT COSTS, so nobody "fixes" it back. The even-thirds solve that produced
   the old 6-max rail (33 / 66) puts a seat at the board's own height, and the
   old 4-max seat at y 45 sat dead centre of it. Those solves are unavailable
   now — the middle 30 points of the rail belong to the cards — so the legs of
   the ring are as even as the remaining arc allows and no more. On 9-max the
   three legs from the bottom cap to the top cap run 245 / 330 / 222px against
   the old 245 / 280 / 260: the widest leg is now the one that STEPS OVER the
   board, which is the shape of the trade, not a regression of item 10.

   THE ONE HARD CEILING ON THE LOWER SEAT. 58 is not rounding. A bottom-cap
   seat's button is projected onto the felt's bottom arc at y 70.3%, and past
   y 58 the seat BELOW that button is nearer to it than the seat it belongs to —
   which is the invariant "no other chair on the ring is nearer to it than the
   one it was computed from" in tests/table-geometry-chips.test.ts. 8-max and
   9-max are the rings with both a bottom cap and a low seat, so for them the
   window is exactly [57.3, 58]. 6-max and 7-max have no bottom cap and take the
   evenness solve instead (67). */
export const SEAT_POSITIONS_6MAX = [
  { x: 50, y: 100 }, // Seat 1 (Hero, bottom-centre; ring position only - the rail drop is CSS, see above)
  { x: 8, y: 67 }, // Seat 2 (lower-left, below the board's band; 66 -> 67, evenness solve)
  { x: 8, y: 25 }, // Seat 3 (upper-left, above the board's band; 33 -> 25, see THE BOARD'S BAND)
  { x: 50, y: 5 }, // Seat 4 (top-center; box rests ON the rail band - compact seat)
  { x: 92, y: 25 }, // Seat 5 (upper-right, above the board's band; 33 -> 25)
  { x: 92, y: 67 }, // Seat 6 (lower-right, below the board's band; 66 -> 67)
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
   y < 20 and the chat bubble's flip at y < 22.

   ── 2026-08-27: 30 -> 25, and the even-thirds solve is no longer reachable ──
   The 95% board's band (see THE BOARD'S BAND above) forbids the middle of this
   rail, and the left-high seat's DEALER BUTTON is what binds at the top. On the
   rail as it SHIPS — x 8 since item 3, with item 2's rewritten button swing —
   the ceiling is y 25.77: at 26 the puck lands 0.16 points INSIDE the cards.
   25 keeps it 3.1px clear on the smallest phone. The low seat stays at 58 — the
   button-ownership ceiling — so the run above item 10's seat is the one that
   had to give. (The band note above records the same number derived at the OLD
   x 10.5, which was 26.7; moving the rail outboard tightened it, because the
   puck's projection moves inboard as its seat moves out.) */
export const SEAT_POSITIONS_9MAX = [
  { x: 50, y: 100 }, // Seat 1 (Hero, bottom-centre; ring position only - the rail drop is CSS, see above)
  { x: 10.5, y: 82.5 }, // Seat 2 (lower-left, bottom cap)
  { x: 8, y: 58 }, // Seat 3 (left-low, on rail side - the board-band ceiling, exactly)
  { x: 8, y: 25 }, // Seat 4 (left-high, on rail side; 36 -> 30 -> 25, see the notes above)
  { x: 27, y: 6 }, // Seat 5 (top-left, top cap - plate on the rail)
  { x: 73, y: 6 }, // Seat 6 (top-right, top cap - plate on the rail)
  { x: 92, y: 25 }, // Seat 7 (right-high, on rail side; 36 -> 30 -> 25)
  { x: 92, y: 58 }, // Seat 8 (right-low, on rail side)
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
  /* 4-max carried the seat that blocked item 2 outright: (10.5, 45) sat on the
     board's vertical midline, so its chips walked STRAIGHT at the cards and came
     to rest at x 22.8%. That one seat is why the felt board was pinned at 68%
     for a month. The even solve for its run — hero (50,100) up to the top-centre
     seat — is y 52.5, and the board's band starts at 57.3, so it takes the
     nearest legal position below the cards. Legs 483 / 581px against 527 / 536
     at the unreachable ideal. */
  4: [
    { x: 50, y: 100 }, // Hero (ring position; the rail drop is CSS - see the note above)
    { x: 8, y: 58 }, // left-low (45 -> 58: off the board's midline, see THE BOARD'S BAND)
    { x: 50, y: 5 }, // top-center, box on the rail
    { x: 92, y: 58 }, // right-low (45 -> 58)
  ],
  5: [
    { x: 50, y: 100 }, // Hero (ring position; the rail drop is CSS - see the note above)
    { x: 8, y: 58 }, // left-low (55 -> 58; the even solve is 55.8, the band starts at 57.3)
    { x: 20.5, y: 6 }, // upper-left diagonal
    { x: 79.5, y: 6 }, // upper-right diagonal
    { x: 92, y: 58 }, // right-low (55 -> 58)
  ],
  6: SEAT_POSITIONS_6MAX,
  7: [
    { x: 50, y: 100 }, // Hero (ring position; the rail drop is CSS - see the note above)
    { x: 8, y: 67 }, // left-low (62 -> 67, the evenness solve now that 33 has moved)
    { x: 8, y: 25 }, // left-high (33 -> 25, see THE BOARD'S BAND)
    { x: 27, y: 6 }, // top-left diagonal
    { x: 73, y: 6 }, // top-right diagonal
    { x: 92, y: 25 }, // right-high (33 -> 25)
    { x: 92, y: 67 }, // right-low (62 -> 67)
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
     which raising these seats would only make worse.

     2026-08-27: both of those numbers moved again for the 95% board. 52 was
     inside the cards' band (its chips rested at y 51.1% against a board that
     ends at 48.9%) and went to 58, the button-ownership ceiling; 23 went to 25,
     which is as low as the board's band lets a seat with a dealer button sit on
     the x 8/92 rail. 7-max's rail moved too this time — it had a seat at y 33,
     dead in the band. The three legs now run 245 / 330 / 317px. */
  8: [
    { x: 50, y: 100 }, // Hero (ring position; the rail drop is CSS - see the note above)
    { x: 10.5, y: 82.5 }, // lower-left bottom cap
    { x: 8, y: 58 }, // left-low (52 -> 58, see THE BOARD'S BAND)
    { x: 8, y: 25 }, // left-high (28 -> 23 -> 25, see the notes above)
    { x: 50, y: 5 }, // top-center, box on the rail
    { x: 92, y: 25 }, // right-high (28 -> 23 -> 25)
    { x: 92, y: 58 }, // right-low (52 -> 58)
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

/**
 * The largest table this client can DRAW, derived from the layouts themselves
 * (Dan 2026-08-31, phase 1 audit).
 *
 * Computed rather than written as a literal, because a hand-copied second
 * number is exactly what went wrong: `heroSeatReconcile` was given
 * `MAX_SUPPORTED_SEATS = 10` while `SEAT_LAYOUTS` stops at 9. A ten-seat table
 * would then have grown ten rows of state against nine drawable positions —
 * seat 10 existing and rendering nowhere, which is the whole bug this audit
 * exists to kill, planted fresh by the fix for it. Two numbers that must agree,
 * living in two files, is a defect waiting for whoever adds a 10-max table.
 * Now there is ONE number, and it comes from the rings: adding a `10:` layout
 * below raises this and everything that reads it, in the same edit.
 */
export const MAX_SUPPORTED_SEATS = Object.keys(SEAT_LAYOUTS).reduce(
  (max, k) => Math.max(max, Number(k)),
  2
);

/** Ring for a table size; clamps to [2, MAX_SUPPORTED_SEATS] so unknown sizes never crash. */
export function seatLayoutFor(maxPlayers: number): Array<{ x: number; y: number }> {
  return SEAT_LAYOUTS[
    Math.min(MAX_SUPPORTED_SEATS, Math.max(2, maxPlayers || MAX_SUPPORTED_SEATS))
  ];
}

// Create empty player slots for a table
/**
 * Dan 2026-08-31: `count` was typed `6 | 9` while real tables are 2, 3, 6, 7,
 * 8 or 9-max, so every caller had to cast — and a cast is the compiler being
 * told to stop looking. SEAT_LAYOUTS covers 2 through 9; the type now says
 * what the function has always actually accepted.
 */
export const createEmptySeats = (count: number): (SeatPlayer | null)[] => {
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
