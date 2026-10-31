import { describe, it, expect } from 'vitest';
import {
  allInEquityBoardKey,
  allInEquityHandMatches,
  formatAllInEquity,
  validAllInEquityEntries,
} from '../../src/lib/allInEquityDisplay';
describe('all-in probabilities never invent endpoints', () => {
  it.each([
    [0, 17, false],
    [17, 0, false],
    [17, 18, false],
    [18, 17, false],
    [17, 17, true],
    [NaN, 17, false],
  ])('binds replay hand %s to current hand %s only when known', (current, event, expected) => {
    expect(allInEquityHandMatches(current as number, event as number)).toBe(expected);
  });
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
  it('never presents sampled or legacy endpoints as mathematical certainty', () => {
    expect(formatAllInEquity(0, false)).toBeNull();
    expect(formatAllInEquity(100, false)).toBeNull();
    expect(formatAllInEquity(82.3, false)).toBe('82.3%');
  });
  it('rejects malformed or incomplete fields', () => {
    const a = { userId: 'a', username: 'A', seat: 1, equity: 20 };
    const b = { userId: 'b', username: 'B', seat: 2, equity: 80 };
    expect(validAllInEquityEntries([a, b])).toBe(true);
    expect(validAllInEquityEntries([{ ...a, equityRaw: NaN }, b])).toBe(false);
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
