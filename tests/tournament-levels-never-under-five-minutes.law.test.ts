import { describe, expect, it } from 'vitest';
import { BLIND_STRUCTURES, SPIN_BLIND_STRUCTURE } from '../src/config/blindStructures';
import { SPIN_TIERS } from '../src/config/spinSpec';
import { HEADS_UP_BLIND_STRUCTURE } from '../src/config/headsUpSpec';
import { MTT_BLIND_PRESETS } from '../server/src/tournament/mttStructurePolicy';
import { acceleratedLevelMs } from '../server/src/tournament/acceleratedLevels';

describe('owner minimum tournament level clock', () => {
  it('every authored preset and Spin tier has at least five minutes', () => {
    for (const levels of [
      ...Object.values(BLIND_STRUCTURES),
      HEADS_UP_BLIND_STRUCTURE,
      SPIN_BLIND_STRUCTURE,
      ...Object.values(MTT_BLIND_PRESETS),
    ])
      for (const level of levels)
        if (!('isBreak' in level && level.isBreak))
          expect(level.durationMinutes).toBeGreaterThanOrEqual(5);
    for (const tier of SPIN_TIERS) expect(tier.levelMinutes).toBeGreaterThanOrEqual(5);
  });
  it('standard MTT levels remain at least eight minutes through the final level', () => {
    for (const level of MTT_BLIND_PRESETS.STANDARD)
      expect(level.durationMinutes).toBeGreaterThanOrEqual(8);
  });
  it('acceleration cannot shorten a level below five minutes', () => {
    for (const minutes of [0.5, 1, 2, 3, 4, 5, 8, 10, 12, 15, 20]) {
      const expected = Math.max(5, Math.ceil(minutes / 2)) * 60_000;
      expect(acceleratedLevelMs(minutes * 60_000)).toBe(expected);
    }
  });
});
