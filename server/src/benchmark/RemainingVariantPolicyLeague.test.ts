import { describe, expect, it } from 'vitest';
import {
  REMAINING_VARIANT_LEAGUE_PROFILES,
  runRemainingVariantLeague,
} from './RemainingVariantPolicyLeague.js';
import { equityGovernor } from '../engine/EquityLoadGovernor.js';

describe('remaining variants actual-controller paired populations', () => {
  it('freezes exactly the enabled remaining variant populations', () => {
    expect(REMAINING_VARIANT_LEAGUE_PROFILES).toHaveLength(23);
    expect(
      REMAINING_VARIANT_LEAGUE_PROFILES.some((p) => p.variant === 'pineapple' && p.tournament)
    ).toBe(false);
    expect(new Set(REMAINING_VARIANT_LEAGUE_PROFILES.map((p) => p.id)).size).toBe(23);
  });
  it.each(REMAINING_VARIANT_LEAGUE_PROFILES.map((p) => [p.id] as const))(
    '%s completes legal physical hands and exact chip conservation',
    async (id) => {
      expect(equityGovernor.snapshot().enabled).toBe(false);
      const run = () =>
        runRemainingVariantLeague({
          profileId: id,
          pairs: 2,
          seed: 12101101,
          mode: 'candidate',
          samples: 16,
        });
      const first = await run();
      expect(first.complete, JSON.stringify(first)).toBe(true);
      expect(first.illegalActions).toBe(0);
      expect(first.cardErrors).toBe(0);
      expect(first.conservationErrors).toBe(0);
      expect(first.truncatedHands).toBe(0);
      expect(first.pairs.some((p) => p.candidate.eligible > 0)).toBe(true);
      expect(await run()).toEqual(first);
    }
  );
});
