import { describe, expect, it } from 'vitest';
import { startFloorFor, effectivePrizePool } from './startRules.js';

describe('startFloorFor — the Heads-Up stand-down bug (2026-08-22)', () => {
  it('a 2-seat Heads-Up SNG starts at 2 — the exact live failure', () => {
    // Heads-Up Hyper Duel 0504c8fb: 2/2 seated, stood down for 4+ hours
    // behind the hard-coded 3, starving the whole interval lane.
    expect(startFloorFor(2)).toBe(2);
  });

  it('3+ seat games keep the historical floor of 3', () => {
    expect(startFloorFor(3)).toBe(3);
    expect(startFloorFor(6)).toBe(3);
    expect(startFloorFor(9)).toBe(3);
    expect(startFloorFor(1000)).toBe(3);
  });

  it('never goes below 2 and fails safe to 3 on garbage', () => {
    expect(startFloorFor(1)).toBe(2); // clamped: poker needs an opponent
    expect(startFloorFor(0)).toBe(3);
    expect(startFloorFor(-5)).toBe(3);
    expect(startFloorFor(null)).toBe(3);
    expect(startFloorFor(undefined)).toBe(3);
    expect(startFloorFor('nine')).toBe(3);
  });
});

describe('effectivePrizePool — guarantees are honored (2026-08-23)', () => {
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
