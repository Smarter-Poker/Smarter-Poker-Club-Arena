/**
 * Position badges.
 *
 * hand_history stores button_seat and each player's seat but never a position,
 * so every badge is derived. The previous derivation in HandHistoryService read
 * a `players[].isButton` flag that NOTHING in the codebase has ever written, so
 * the button always resolved to seat 1 and every badge it produced was wrong.
 * These pin the rules that make that impossible to repeat.
 */
import { describe, it, expect } from 'vitest';
import { derivePositions, smallBlindSeat, bigBlindSeat } from '../../src/utils/pokerPositions';

describe('derivePositions', () => {
  it('names a full six-handed table the way a poker room does', () => {
    // Button on seat 2, six occupied seats.
    expect(derivePositions([1, 2, 3, 4, 5, 6], 2)).toEqual({
      2: 'BTN',
      3: 'SB',
      4: 'BB',
      5: 'UTG',
      6: 'MP',
      1: 'CO',
    });
  });

  it('wraps around the table, it does not run off the end', () => {
    const p = derivePositions([1, 2, 3, 4, 5, 6], 6);
    expect(p[6]).toBe('BTN');
    expect(p[1]).toBe('SB');
    expect(p[2]).toBe('BB');
    expect(p[5]).toBe('CO');
  });

  it('handles SPARSE seats - real tables are not contiguous', () => {
    // Six players sitting on seats 1, 2, 3, 5, 8, 9. Modular arithmetic on the
    // seat NUMBER gets this wrong; ordering the occupied seats does not.
    const p = derivePositions([1, 2, 3, 5, 8, 9], 5);
    expect(p[5]).toBe('BTN');
    expect(p[8]).toBe('SB');
    expect(p[9]).toBe('BB');
    expect(p[1]).toBe('UTG');
    expect(p[2]).toBe('MP');
    expect(p[3]).toBe('CO');
  });

  it('heads-up: the button IS the small blind', () => {
    const p = derivePositions([4, 7], 4);
    expect(p[4]).toBe('SB');
    expect(p[7]).toBe('BB');
    expect(Object.values(p)).not.toContain('BTN');
  });

  it('nine-handed gets the full ladder, CO last before the button', () => {
    const p = derivePositions([1, 2, 3, 4, 5, 6, 7, 8, 9], 1);
    expect(p[1]).toBe('BTN');
    expect(p[2]).toBe('SB');
    expect(p[3]).toBe('BB');
    expect(p[4]).toBe('UTG');
    expect(p[9]).toBe('CO');
    expect(Object.keys(p)).toHaveLength(9);
  });

  it('three-handed is button, small, big and nothing else', () => {
    expect(derivePositions([1, 2, 3], 1)).toEqual({ 1: 'BTN', 2: 'SB', 3: 'BB' });
  });

  it('returns nothing rather than guessing when the button is unknown', () => {
    // A missing badge is honest. A wrong one is not.
    expect(derivePositions([1, 2, 3], null)).toEqual({});
    expect(derivePositions([1, 2, 3], undefined)).toEqual({});
    expect(derivePositions([1, 2, 3], 7)).toEqual({});
    expect(derivePositions([], 1)).toEqual({});
  });

  it('never assigns the same position twice', () => {
    for (const n of [2, 3, 4, 5, 6, 7, 8, 9]) {
      const seats = Array.from({ length: n }, (_, i) => i + 1);
      for (const btn of seats) {
        const labels = Object.values(derivePositions(seats, btn));
        expect(labels).toHaveLength(n);
        expect(new Set(labels).size).toBe(n);
      }
    }
  });
});

describe('blind seats', () => {
  it('finds the seats that post, for the pot reconstruction', () => {
    expect(smallBlindSeat([1, 2, 3, 4, 5, 6], 2)).toBe(3);
    expect(bigBlindSeat([1, 2, 3, 4, 5, 6], 2)).toBe(4);
  });

  it('heads-up posts from the button', () => {
    expect(smallBlindSeat([4, 7], 4)).toBe(4);
    expect(bigBlindSeat([4, 7], 4)).toBe(7);
  });

  it('returns null when the button is unknown, so no blind is invented', () => {
    expect(smallBlindSeat([1, 2, 3], null)).toBeNull();
    expect(bigBlindSeat([1, 2, 3], null)).toBeNull();
  });
});
