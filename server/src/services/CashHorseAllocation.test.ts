import { describe, expect, it } from 'vitest';
import { compareCashPopulation, isHoldemOrPlo } from './CashHorseAllocation.js';

describe('cash floor allocation', () => {
  it('recognizes Holdem and every PLO variant', () => {
    for (const value of ['nlh', 'PLO4', 'plo5', 'plo6', 'plo8']) {
      expect(isHoldemOrPlo(value)).toBe(true);
    }
    expect(isHoldemOrPlo('pineapple')).toBe(false);
  });
  it('fills occupied Holdem and PLO ahead of empty games and other variants', () => {
    const rows = [
      { game_variant: 'pineapple', occupied: 5, max_players: 6 },
      { game_variant: 'nlh', occupied: 0, max_players: 6 },
      { game_variant: 'plo4', occupied: 3, max_players: 6 },
      { game_variant: 'nlh', occupied: 5, max_players: 6 },
    ].sort(compareCashPopulation);
    expect(rows.map((row) => row.occupied)).toEqual([5, 3, 0, 5]);
  });
});
