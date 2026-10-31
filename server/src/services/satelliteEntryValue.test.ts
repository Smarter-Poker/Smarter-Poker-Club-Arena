import { describe, expect, it } from 'vitest';
import { satelliteEntryValue } from './satelliteEntryValue.js';
import { splitBuyIn } from '../config/buyIn.js';
describe('satellite entry economics', () => {
  it('replaces 15 into 35 with 5 and preserves economical 5 into 40', () => {
    expect(satelliteEntryValue(35, 15)).toBe(5);
    expect(satelliteEntryValue(40, 5)).toBe(5);
    expect(satelliteEntryValue(30, 10)).toBe(5);
  });
  it('funds one ticket per five to ten entries across supported ticket values', () => {
    for (const ticket of [10, 15, 20, 25, 30, 35, 40, 50, 75, 100, 150, 200, 350, 500, 1000]) {
      const entry = satelliteEntryValue(ticket, ticket);
      const ratio = ticket / splitBuyIn(entry, 0.1).prize;
      expect(ratio).toBeGreaterThanOrEqual(5);
      expect(ratio).toBeLessThanOrEqual(10);
      expect(Number.isInteger(entry)).toBe(true);
    }
  });
  it('refuses missing and unpriceable targets instead of inventing an entry', () => {
    for (const price of [0, NaN, 1]) expect(() => satelliteEntryValue(price, 15)).toThrow();
  });
});
