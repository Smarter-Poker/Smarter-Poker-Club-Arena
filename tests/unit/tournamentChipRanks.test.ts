import { describe, expect, it } from 'vitest';
import { tournamentChipRanks } from '../../src/utils/tournamentChipRanks';

describe('settled chip ranks shared by lobby and table', () => {
  it('shares ties and leaves the correct gap, independent of incoming order', () => {
    const rows = [
      { user_id: 'short', chips: 0 },
      { user_id: 'b', chips: 2000 },
      { user_id: 'a', chips: 2000 },
      { user_id: 'c', chips: 1000 },
    ];
    expect(Object.fromEntries(tournamentChipRanks(rows))).toEqual({ a: 1, b: 1, c: 3, short: 4 });
    expect(rows[0].user_id).toBe('short');
  });
  it('includes players from every table, not a first-page subset', () => {
    const rows = Array.from({ length: 1501 }, (_, i) => ({ user_id: String(i), chips: i }));
    expect(tournamentChipRanks(rows).get('0')).toBe(1501);
    expect(tournamentChipRanks([]).size).toBe(0);
  });
});
