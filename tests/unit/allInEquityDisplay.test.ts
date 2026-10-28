import { describe, it, expect } from 'vitest';
import {
  allInEquityBoardKey,
  formatAllInEquity,
  validAllInEquityEntries,
} from '../../src/lib/allInEquityDisplay';
describe('all-in probabilities never invent endpoints', () => {
  it('matches wire and client board identities across all boards', () => {
    expect(allInEquityBoardKey([['Ahearts', 'Kspades'], ['Qclubs']])).toBe(
      allInEquityBoardKey([
        [
          { rank: 'A', suit: 'h' },
          { rank: 'K', suit: 's' },
        ],
        [{ rank: 'Q', suit: 'c' }],
        [],
      ])
    );
    expect(allInEquityBoardKey([['Ahearts']])).not.toBe(allInEquityBoardKey([['Adiamonds']]));
  });
  it('preserves a positive chance too small for one decimal', () => {
    expect(formatAllInEquity(0.001)).toBe('<0.1%');
    expect(formatAllInEquity(99.999)).toBe('>99.9%');
    expect(formatAllInEquity(0)).toBe('0%');
    expect(formatAllInEquity(100)).toBe('100%');
    expect(formatAllInEquity(33.333)).toBe('33.3%');
  });
  it('rejects malformed or incomplete fields', () => {
    const a = { userId: 'a', username: 'A', seat: 1, equity: 20 };
    const b = { userId: 'b', username: 'B', seat: 2, equity: 80 };
    expect(validAllInEquityEntries([a, b])).toBe(true);
    for (const field of [
      [],
      [a],
      [a, a],
      [a, { ...b, equity: NaN }],
      [a, { ...b, equity: undefined }],
      [a, { ...b, equity: 101 }],
    ])
      expect(validAllInEquityEntries(field)).toBe(false);
  });
});
