import { describe, expect, it } from 'vitest';
import { mapCashierRoster, rosterRowMatches, rosterMatchRank } from '../src/lib/cashierRoster';

const rows = mapCashierRoster(
  [
    {
      user_id: 'owner',
      role_rank: 1,
      name: 'KingFish',
      username: 'kingfish',
      role: 'owner',
      player_number: '1',
    },
    {
      user_id: 'agent',
      role_rank: 2,
      name: 'River Runner',
      username: 'river_runner',
      role: 'super_agent',
      player_number: '983754',
    },
  ],
  'owner'
);

describe('Cashier directory search', () => {
  it('finds the readable role with case and surrounding whitespace ignored', () => {
    expect(rows.filter((row) => rosterRowMatches(row, '  SUPER AGENT '))).toEqual([rows[1]]);
    expect(rosterMatchRank(rows[1], 'Super Agent')).toBeGreaterThan(0);
  });
  it('ranks a number substring that the search actually accepts', () => {
    expect(rosterRowMatches(rows[1], '375')).toBe(true);
    expect(rosterMatchRank(rows[1], '375')).toBeGreaterThan(0);
  });
  it('keeps all server-scoped rows for blank search and none for unmatched text', () => {
    expect(rows.filter((row) => rosterRowMatches(row, '   '))).toEqual(rows);
    expect(rows.filter((row) => rosterRowMatches(row, 'missing person'))).toEqual([]);
    expect(rows[0].isSelf).toBe(true);
  });
});
