/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT RESULTS: PRIZE, BOUNTY, TOTAL (Dan sections 82.41 to 82.44)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 41. results include the regular tournament prize
 * 42. results include bounty winnings
 * 43. total = prize + bounty
 * 44. a lower finisher CAN have a larger total than the winner, and the layout
 *     and the sort have to handle it correctly
 *
 * The field below is a mystery bounty final table where exactly that happened:
 * the champion took 4,200 for the win, and the player who went out 14th opened
 * the 5,000 jackpot chest. Sorting or highlighting on the placement prize alone
 * names the wrong person as the biggest winner of the night.
 */

import { describe, it, expect } from 'vitest';
import {
  totalPayout,
  sortResults,
  biggestEarner,
  bountyBeatTheChampion,
  type PayoutRow,
} from '../../src/utils/tournamentPayout';

interface Row extends PayoutRow {
  username: string;
}

const FIELD: Row[] = [
  { user_id: 'u-champ', username: 'Champ', position: 1, prize: 4200, bounty_winnings: 150 },
  { user_id: 'u-second', username: 'Second', position: 2, prize: 2600, bounty_winnings: 0 },
  { user_id: 'u-third', username: 'Third', position: 3, prize: 1800, bounty_winnings: 900 },
  { user_id: 'u-hunter', username: 'Hunter', position: 14, prize: 120, bounty_winnings: 5350 },
  { user_id: 'u-bubble', username: 'Bubble', position: 40, prize: 0, bounty_winnings: 0 },
];

describe('41 and 42. both halves are present and separate', () => {
  it('keeps the placement prize as its own number', () => {
    expect(FIELD.find((r) => r.username === 'Hunter')!.prize).toBe(120);
    expect(FIELD.find((r) => r.username === 'Champ')!.prize).toBe(4200);
  });

  it('keeps bounty winnings as their own number', () => {
    expect(FIELD.find((r) => r.username === 'Hunter')!.bounty_winnings).toBe(5350);
  });
});

describe('43. total = prize + bounty', () => {
  it('adds the two halves and nothing else', () => {
    expect(totalPayout({ prize: 120, bounty_winnings: 5350 })).toBe(5470);
    expect(totalPayout({ prize: 4200, bounty_winnings: 150 })).toBe(4350);
  });

  it('is the prize when there is no bounty, and zero when there is neither', () => {
    expect(totalPayout({ prize: 2600, bounty_winnings: 0 })).toBe(2600);
    expect(totalPayout({ prize: 0, bounty_winnings: 0 })).toBe(0);
  });

  it('treats a missing or null half as zero rather than as NaN', () => {
    expect(totalPayout({ prize: 100, bounty_winnings: null as unknown as number })).toBe(100);
    expect(totalPayout({ prize: undefined as unknown as number, bounty_winnings: 50 })).toBe(50);
  });
});

describe('44. a lower finisher can out-earn the champion', () => {
  it('names the 14th place finisher as the biggest earner', () => {
    const top = biggestEarner(FIELD)!;
    expect(top.username).toBe('Hunter');
    expect(totalPayout(top)).toBe(5470);
    expect(top.position).toBe(14);
  });

  it('says the champion was out-earned', () => {
    expect(bountyBeatTheChampion(FIELD)).toBe(true);
  });

  it('does NOT say so when the champion is also the biggest earner', () => {
    const champTookItAll = FIELD.map((r) =>
      r.username === 'Hunter' ? { ...r, bounty_winnings: 0 } : r
    );
    expect(biggestEarner(champTookItAll)!.username).toBe('Champ');
    expect(bountyBeatTheChampion(champTookItAll)).toBe(false);
  });

  it('does NOT say so on an exact tie, because "more than" has to mean more', () => {
    const tied = FIELD.map((r) =>
      r.username === 'Hunter' ? { ...r, prize: 120, bounty_winnings: 4230 } : r
    );
    expect(totalPayout(tied.find((r) => r.username === 'Hunter')!)).toBe(4350);
    expect(bountyBeatTheChampion(tied)).toBe(false);
  });

  it('is false rather than a crash for an empty field or one with no champion', () => {
    expect(bountyBeatTheChampion([])).toBe(false);
    expect(biggestEarner([])).toBeNull();
    expect(bountyBeatTheChampion(FIELD.filter((r) => r.position !== 1))).toBe(false);
  });
});

describe('44. the sort handles it correctly', () => {
  it('by finish, the champion is first and Hunter is fourth', () => {
    const rows = sortResults(FIELD, 'finish');
    expect(rows.map((r) => r.username)).toEqual(['Champ', 'Second', 'Third', 'Hunter', 'Bubble']);
  });

  it('by total payout, Hunter is first and the champion drops to second', () => {
    const rows = sortResults(FIELD, 'total');
    expect(rows.map((r) => r.username)).toEqual(['Hunter', 'Champ', 'Third', 'Second', 'Bubble']);
    expect(totalPayout(rows[0])).toBeGreaterThan(totalPayout(rows[1]));
  });

  it('breaks a money tie on the finish, so the order is stable', () => {
    const tied: Row[] = [
      { user_id: 'b', username: 'Later', position: 9, prize: 500, bounty_winnings: 0 },
      { user_id: 'a', username: 'Earlier', position: 4, prize: 500, bounty_winnings: 0 },
    ];
    expect(sortResults(tied, 'total').map((r) => r.username)).toEqual(['Earlier', 'Later']);
  });

  it('never mutates the array it was given', () => {
    const original = [...FIELD];
    sortResults(FIELD, 'total');
    expect(FIELD).toEqual(original);
  });

  it('sorts a player with no position last rather than first', () => {
    const withUnplaced: Row[] = [
      ...FIELD,
      { user_id: 'u-x', username: 'Unplaced', position: null, prize: 0, bounty_winnings: 0 },
    ];
    expect(sortResults(withUnplaced, 'finish').at(-1)!.username).toBe('Unplaced');
  });
});
