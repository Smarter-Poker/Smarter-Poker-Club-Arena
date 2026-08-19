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
 * Pure data plus two tiny functions, so the geometry can be tested directly:
 * every ring has hero at slot 0, every seat sits inside the frame, and no table
 * size can index past the end of its ring.
 */
import type { SeatPlayer } from '../components/table/SeatSlot';

export const SEAT_POSITIONS_6MAX = [
  { x: 50, y: 93.5 }, // Seat 1 (Hero, bottom-center, hangs below the rail)
  { x: 10.5, y: 66 }, // Seat 2 (lower-left, on rail side)
  { x: 10.5, y: 33 }, // Seat 3 (upper-left, on rail side)
  { x: 50, y: 6 }, // Seat 4 (top-center; box rests ON the rail band - compact seat)
  { x: 89.5, y: 33 }, // Seat 5 (upper-right, on rail side)
  { x: 89.5, y: 66 }, // Seat 6 (lower-right, on rail side)
];

export const SEAT_POSITIONS_9MAX = [
  { x: 50, y: 93.5 }, // Seat 1 (Hero, bottom-center, hangs below the rail)
  { x: 19, y: 82.5 }, // Seat 2 (lower-left, bottom cap)
  { x: 10.5, y: 58 }, // Seat 3 (left-low, on rail side)
  { x: 10.5, y: 36 }, // Seat 4 (left-high, on rail side)
  { x: 27, y: 13 }, // Seat 5 (top-left, top cap)
  { x: 73, y: 13 }, // Seat 6 (top-right, top cap)
  { x: 89.5, y: 36 }, // Seat 7 (right-high, on rail side)
  { x: 89.5, y: 58 }, // Seat 8 (right-low, on rail side)
  { x: 81, y: 82.5 }, // Seat 9 (lower-right, bottom cap)
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
   and because 10,130 pre-existing rows still carry the old seat counts. */
export const SEAT_LAYOUTS: Record<number, Array<{ x: number; y: number }>> = {
  2: [
    { x: 50, y: 93.5 }, // Hero
    { x: 50, y: 6 }, // Villain, top-center (heads-up), box on the rail
  ],
  3: [
    { x: 50, y: 93.5 }, // Hero
    { x: 20.5, y: 14 }, // upper-left diagonal, on rail cap circle
    { x: 79.5, y: 14 }, // upper-right diagonal
  ],
  4: [
    { x: 50, y: 93.5 }, // Hero
    { x: 10.5, y: 45 }, // left-middle
    { x: 50, y: 6 }, // top-center, box on the rail
    { x: 89.5, y: 45 }, // right-middle
  ],
  5: [
    { x: 50, y: 93.5 }, // Hero
    { x: 10.5, y: 55 }, // left-low
    { x: 20.5, y: 14 }, // upper-left diagonal
    { x: 79.5, y: 14 }, // upper-right diagonal
    { x: 89.5, y: 55 }, // right-low
  ],
  6: SEAT_POSITIONS_6MAX,
  7: [
    { x: 50, y: 93.5 }, // Hero
    { x: 10.5, y: 62 }, // left-low
    { x: 10.5, y: 33 }, // left-high
    { x: 27, y: 13 }, // top-left diagonal
    { x: 73, y: 13 }, // top-right diagonal
    { x: 89.5, y: 33 }, // right-high
    { x: 89.5, y: 62 }, // right-low
  ],
  8: [
    { x: 50, y: 93.5 }, // Hero
    { x: 19, y: 82.5 }, // lower-left bottom cap
    { x: 10.5, y: 52 }, // left-low
    { x: 10.5, y: 28 }, // left-high
    { x: 50, y: 6 }, // top-center, box on the rail
    { x: 89.5, y: 28 }, // right-high
    { x: 89.5, y: 52 }, // right-low
    { x: 81, y: 82.5 }, // lower-right bottom cap
  ],
  9: SEAT_POSITIONS_9MAX,
};

/** Ring for a table size; clamps to [2, 9] so unknown sizes never crash. */
export function seatLayoutFor(maxPlayers: number): Array<{ x: number; y: number }> {
  return SEAT_LAYOUTS[Math.min(9, Math.max(2, maxPlayers || 9))];
}

// Create empty player slots for a table
export const createEmptySeats = (count: 6 | 9): (SeatPlayer | null)[] => {
  return Array(count).fill(null);
};
