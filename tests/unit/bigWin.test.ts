import { describe, expect, it } from 'vitest';
import { BIG_WIN_CENTS, BIG_WIN_MULTIPLE, isBigPayout } from '../../src/utils/bigWin';
import { BIG_WIN_CENTS as PLINKO_BIG_WIN_CENTS } from '../../src/components/plinko/PlinkoBoard';

describe('isBigPayout', () => {
  it('is five times the stake or more, the bar Plinko already used', () => {
    expect(BIG_WIN_MULTIPLE).toBe(5);
    expect(BIG_WIN_CENTS).toBe(500);
    expect(PLINKO_BIG_WIN_CENTS).toBe(BIG_WIN_CENTS);
    expect(isBigPayout(50, 10)).toBe(true);
    expect(isBigPayout(49.99, 10)).toBe(false);
  });
  it('is never big without a real stake', () => {
    expect(isBigPayout(50, 0)).toBe(false);
    expect(isBigPayout(50, null)).toBe(false);
    expect(isBigPayout(undefined, 10)).toBe(false);
    expect(isBigPayout(50, Number.NaN)).toBe(false);
  });
});
