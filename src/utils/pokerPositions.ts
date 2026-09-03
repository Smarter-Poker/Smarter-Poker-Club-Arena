/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  POSITION LABELS — seat + button to BTN / SB / BB / UTG / MP / CO
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * hand_history stores `button_seat` and each player's `seat`; it does NOT store
 * positions. Every surface that wanted a position badge re-derived it, and the
 * one in HandHistoryService derives the button from a `players[].isButton` flag
 * that nothing in the codebase has ever written, so it always resolved to seat 1
 * and every badge it produced was wrong.
 *
 * This is the single correct derivation. Seats are SPARSE (a six-handed hand can
 * occupy seats 1, 2, 3, 5, 8, 9), so everything works off the sorted list of
 * occupied seats rather than modular arithmetic on seat numbers.
 */

/** Seats between the big blind and the button, named the way a poker room does. */
const MIDDLE_LABELS: Record<number, string[]> = {
  0: [],
  1: ['CO'],
  2: ['UTG', 'CO'],
  3: ['UTG', 'MP', 'CO'],
  4: ['UTG', 'UTG+1', 'MP', 'CO'],
  5: ['UTG', 'UTG+1', 'MP', 'HJ', 'CO'],
  6: ['UTG', 'UTG+1', 'UTG+2', 'MP', 'HJ', 'CO'],
  7: ['UTG', 'UTG+1', 'UTG+2', 'MP', 'MP+1', 'HJ', 'CO'],
};

/**
 * Map every occupied seat to its position label.
 *
 * Heads-up follows the real rule: the button IS the small blind.
 * If the button seat is not among the occupied seats (a dead button, or a row
 * written before button_seat existed) the map comes back empty rather than
 * guessing — a missing badge is honest, a wrong badge is not.
 */
export function derivePositions(
  occupiedSeats: number[],
  buttonSeat: number | null | undefined
): Record<number, string> {
  const seats = [...new Set(occupiedSeats.filter((s) => Number.isFinite(s)))].sort((a, b) => a - b);
  const out: Record<number, string> = {};
  if (seats.length === 0) return out;

  const btnIndex = seats.indexOf(Number(buttonSeat));
  if (btnIndex < 0) return out;

  const n = seats.length;
  const at = (offset: number) => seats[(btnIndex + offset) % n];

  if (n === 1) {
    out[at(0)] = 'BTN';
    return out;
  }

  if (n === 2) {
    // Heads-up: button posts the small blind.
    out[at(0)] = 'SB';
    out[at(1)] = 'BB';
    return out;
  }

  out[at(0)] = 'BTN';
  out[at(1)] = 'SB';
  out[at(2)] = 'BB';

  const middleCount = n - 3;
  const labels = MIDDLE_LABELS[middleCount];
  for (let i = 0; i < middleCount; i += 1) {
    // Fall back to UTG+k for tables bigger than any label list.
    out[at(3 + i)] = labels ? labels[i] : i === 0 ? 'UTG' : `UTG+${i}`;
  }

  return out;
}

/** Which seat posts the small blind, or null when it cannot be known. */
export function smallBlindSeat(
  occupiedSeats: number[],
  buttonSeat: number | null | undefined
): number | null {
  const map = derivePositions(occupiedSeats, buttonSeat);
  const seat = Object.keys(map).find((s) => map[Number(s)] === 'SB');
  return seat === undefined ? null : Number(seat);
}

/** Which seat posts the big blind, or null when it cannot be known. */
export function bigBlindSeat(
  occupiedSeats: number[],
  buttonSeat: number | null | undefined
): number | null {
  const map = derivePositions(occupiedSeats, buttonSeat);
  const seat = Object.keys(map).find((s) => map[Number(s)] === 'BB');
  return seat === undefined ? null : Number(seat);
}
