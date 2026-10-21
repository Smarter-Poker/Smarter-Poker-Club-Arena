import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BLIND_STRUCTURES } from '../../src/config/blindStructures';
const baseline = JSON.parse(readFileSync('tests/fixtures/mtt-blind-preset-preimage.json', 'utf8'));
// Owner October 21 changes clocks only; retain every original blind, ante and break.
for (const levels of Object.values(baseline.blind_structures) as Array<
  Array<{ durationMinutes: number; isBreak?: boolean }>
>)
  for (const level of levels)
    if (!level.isBreak) level.durationMinutes = Math.max(5, level.durationMinutes);
describe('compact blind presets preserve the original stakes with the owner clock floor', () => {
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
