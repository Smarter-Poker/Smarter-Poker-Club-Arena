import { describe, expect, it } from 'vitest';
import { MEMORY_VARIANTS } from './HorseOpponentMemory.js';
import { playExploitPairs } from './HorseOpponentExploitBehavior.test-support.js';

describe('restored profiles reach the real Holdem and PLO decision consumers', () => {
  for (const mode of ['cash', 'tournament'] as const) {
    it.each(MEMORY_VARIANTS)(
      '%s ' + mode + ' retains the same exploit after snapshot restoration',
      (variant) => {
        const reference = playExploitPairs(variant, mode, 32, 7);
        const restored = playExploitPairs(variant, mode, 32, 7, true);
        expect(restored).toEqual(reference);
        expect(restored.on.engagedDecisions).toBe(restored.on.decisions);
        expect(restored.on.decisions).toBeGreaterThan(20);
        expect(restored.on.open.fold).toBeLessThan(restored.off.open.fold);
        expect(restored.on.open.raise).toBeGreaterThan(restored.off.open.raise);
      }
    );
  }
});
