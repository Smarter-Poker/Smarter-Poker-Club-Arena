/**
 * A DEAD-BUTTON HAND IS LABELLED FROM ITS BLINDS (Dan, 2026-10-21).
 *
 * Hand #43306703, Midweek Mystery Table 17: seat 8 busted, so the tournament
 * dead-button rule put the button on the empty seat 8, the small blind on
 * seat 9 (Burls, who posted the big blind the hand before) and the big blind
 * on seat 1. The felt could not find seat 8 among the players and treated
 * seat 1 as the button, so Burls posted the small blind wearing "CO" and the
 * two players after the real big blind wore SB and BB.
 */
import { describe, expect, it } from 'vitest';
import { positionLabelsFor } from './projectHandState.js';
import { derivePosition } from '../../services/supabase/handFacts.js';
import type { SeatPlayer } from '../../types.js';

const table17 = [1, 2, 4, 5, 6, 7, 9].map((seat) => ({ seat }) as SeatPlayer);

describe('a dead-button hand is labelled from its blinds', () => {
  it('hand #43306703: the small blind is SB, the big blind is BB, nobody is BTN', () => {
    const labels = positionLabelsFor(8, table17, { smallBlind: 9, bigBlind: 1 });
    expect(labels.get(9)).toBe('SB');
    expect(labels.get(1)).toBe('BB');
    expect(labels.get(2)).toBe('UTG');
    expect(labels.get(7)).toBe('CO');
    expect([...labels.values()]).not.toContain('BTN');
    expect(labels.size).toBe(7);
  });

  it('without the posted blinds it walks clockwise from the empty button seat', () => {
    const labels = positionLabelsFor(8, table17);
    expect(labels.get(9)).toBe('SB');
    expect(labels.get(1)).toBe('BB');
    expect(labels.get(7)).toBe('CO');
  });

  it('a dead small blind labels only the big blind', () => {
    // Button seat 3 empty, the small blind seat emptied too: seat 5 posts the big blind alone.
    const seats = [1, 2, 5, 6, 7].map((seat) => ({ seat }) as SeatPlayer);
    const labels = positionLabelsFor(3, seats, { smallBlind: null, bigBlind: 5 });
    expect(labels.get(5)).toBe('BB');
    expect([...labels.values()]).not.toContain('SB');
    expect([...labels.values()]).not.toContain('BTN');
    expect(labels.get(6)).toBe('UTG');
    expect(labels.get(2)).toBe('CO');
  });

  it('the next hand, with the button live again, is unchanged', () => {
    const labels = positionLabelsFor(1, table17, { smallBlind: 2, bigBlind: 4 });
    expect(labels.get(1)).toBe('BTN');
    expect(labels.get(2)).toBe('SB');
    expect(labels.get(4)).toBe('BB');
    expect(labels.get(9)).toBe('CO');
  });

  it('the recorded hand facts agree: the small blind is not stored as the button', () => {
    const dealt = [1, 2, 4, 5, 6, 7, 9];
    expect(derivePosition(9, 8, dealt)).toBe('SB');
    expect(derivePosition(1, 8, dealt)).toBe('BB');
    expect(derivePosition(7, 8, dealt)).toBe('CO');
    // A live button is untouched.
    expect(derivePosition(1, 1, dealt)).toBe('BTN');
    expect(derivePosition(9, 1, dealt)).toBe('CO');
  });
});
