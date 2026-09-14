import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BLIND_STRUCTURES } from '../../src/config/blindStructures';
const baseline = JSON.parse(readFileSync('tests/fixtures/mtt-blind-preset-preimage.json', 'utf8'));
describe('compact blind presets preserve the original published terms', () => {
  it('keeps every property on all 135 original levels exactly', () => {
    expect(BLIND_STRUCTURES).toEqual(baseline.blind_structures);
    expect(
      Object.values(BLIND_STRUCTURES).reduce((count, levels) => count + levels.length, 0)
    ).toBe(135);
    expect(JSON.stringify(BLIND_STRUCTURES)).toBe(JSON.stringify(baseline.blind_structures));
  });
  it('keeps rows independent within and across presets', () => {
    const levels = Object.values(BLIND_STRUCTURES).flat();
    expect(new Set(levels).size).toBe(levels.length);
  });
});
