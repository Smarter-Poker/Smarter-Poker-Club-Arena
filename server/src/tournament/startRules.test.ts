import { describe, expect, it } from 'vitest';
import { effectivePrizePool } from './startRules.js';

describe('effectivePrizePool - guarantees are honored (2026-08-23)', () => {
  it('overlay: guarantee wins when entries fall short', () => {
    // Bounty Builder Turbo completed with pool 12.5 against a 500 GTD —
    // the guarantee was never applied anywhere in the engine.
    expect(effectivePrizePool(12.5, 500)).toBe(500);
  });

  it('entries win once they beat the guarantee', () => {
    expect(effectivePrizePool(720, 0)).toBe(720);
    expect(effectivePrizePool(12000, 10000)).toBe(12000);
  });

  it('null/garbage columns read as 0, never NaN', () => {
    expect(effectivePrizePool(null, null)).toBe(0);
    expect(effectivePrizePool(undefined, 100)).toBe(100);
    expect(effectivePrizePool('x', 'y')).toBe(0);
  });
});
