import { describe, expect, it } from 'vitest';
import {
  OMAHA_VARIANT_LEAGUE_PROFILES,
  OMAHA_VARIANT_LEAGUE_SEEDS,
  runOmahaVariantLeague,
} from './OmahaVariantPolicyLeague.js';
import { saveFastRandom, seedFastRandom } from '../engine/HorseEval.js';

describe('Phase 11 per-variant paired controller benchmarks', () => {
  it.each(OMAHA_VARIANT_LEAGUE_PROFILES.map((p) => p.id))(
    '%s is legal, conserved and reproducible',
    async (profileId) => {
      const options = { profileId, pairs: 1, seed: OMAHA_VARIANT_LEAGUE_SEEDS[0] };
      seedFastRandom(112233);
      const rng = saveFastRandom();
      const a = await runOmahaVariantLeague(options),
        b = await runOmahaVariantLeague(options);
      expect(a.complete, JSON.stringify(a.incompleteHands)).toBe(true);
      expect(a.illegalActions + a.cardErrors + a.conservationErrors + a.truncatedHands).toBe(0);
      expect(b).toEqual(a);
      expect(saveFastRandom()).toBe(rng);
      expect(a.confidence99[0]).toBeLessThan(0);
      expect(a.confidence99[1]).toBeGreaterThan(0);
      expect(a.promotionEligible).toBe(false);
      expect(a.pairs[0].candidate.eligible).toBeGreaterThan(0);
    },
    30000
  );
  it.each(['plo5', 'plo6', 'plo8'])(
    '%s shadow is identical to the baseline through whole-hand settlement',
    async (variant) => {
      const result = await runOmahaVariantLeague({
        profileId: `${variant}-hu-25bb`,
        pairs: 2,
        seed: OMAHA_VARIANT_LEAGUE_SEEDS[1],
        mode: 'shadow',
      });
      expect(result.complete).toBe(true);
      expect(result.positionCoverageComplete).toBe(true);
      expect(result.meanAfterRakeDifferenceBbPerHand).toBe(0);
      expect(
        result.pairs.every(
          (p) => JSON.stringify(p.candidate.net) === JSON.stringify(p.baseline.net)
        )
      ).toBe(true);
    }
  );
});
