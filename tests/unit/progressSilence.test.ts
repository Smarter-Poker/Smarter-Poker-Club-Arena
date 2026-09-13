import { describe, expect, it } from 'vitest';
import { createProgressSilenceGuard } from '../e2e/support/progressSilence';

describe('next-hand observation preserves its independent activity limit', () => {
  it('allows a hand lasting longer than45seconds while actions continue', () => {
    const active = createProgressSilenceGuard(45_000);
    // Samples span a60second hand; each is time since the latest action.
    for (const msSinceProgress of [1_000, 5_000, 12_000, 2_000, 8_000, 3_000, 0]) {
      expect(active({ tableId: 'cash-a', msSinceProgress })).toBe(true);
    }
  });
  it('does not accept a stalled table after it later resumes and starts another hand', () => {
    const active = createProgressSilenceGuard(45_000);
    expect(active({ tableId: 'cash-a', msSinceProgress: 1_000 })).toBe(true);
    expect(active({ tableId: 'cash-a', msSinceProgress: 45_001 })).toBe(false);
    expect(active({ tableId: 'cash-a', msSinceProgress: 0 })).toBe(false);
  });
  it('can select another continuously active tournament table after one stalls', () => {
    const active = createProgressSilenceGuard(45_000);
    expect(active({ tableId: 'mtt-a', msSinceProgress: 50_000 })).toBe(false);
    expect(active({ tableId: 'mtt-b', msSinceProgress: 10_000 })).toBe(true);
    expect(active({ tableId: 'mtt-a', msSinceProgress: 0 })).toBe(false);
    expect(active({ tableId: 'mtt-b', msSinceProgress: 0 })).toBe(true);
  });
  it('refuses missing or invalid progress evidence and preserves the exact boundary', () => {
    const active = createProgressSilenceGuard(45_000);
    expect(active(undefined)).toBe(false);
    expect(active({ tableId: 'boundary', msSinceProgress: 45_000 })).toBe(true);
    for (const msSinceProgress of [NaN, Infinity, -1]) {
      const tableId = String(msSinceProgress);
      expect(active({ tableId, msSinceProgress })).toBe(false);
      expect(active({ tableId, msSinceProgress: 0 })).toBe(false);
    }
  });
});
