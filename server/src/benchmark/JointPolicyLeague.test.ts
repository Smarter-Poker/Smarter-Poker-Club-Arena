import { describe, expect, it } from 'vitest';
import {
  JOINT_LEAGUE_PROFILES,
  JOINT_LEAGUE_SEEDS,
  runJointPolicyLeague,
} from './JointPolicyLeague.js';
import { KNOWN_VARIANTS, horseVariantRulesFor } from '../engine/VariantRules.js';
import { maxSeatsForVariant } from '../config/tableSeating.js';
describe('frozen joint actual-controller populations', () => {
  it('covers all enabled variants and board modes before outcomes are observed', () => {
    expect(new Set(JOINT_LEAGUE_PROFILES.map((p) => p.variant))).toEqual(new Set(KNOWN_VARIANTS));
    expect(JOINT_LEAGUE_SEEDS).toEqual([13101101, 13102203, 13103307]);
    expect(JOINT_LEAGUE_PROFILES).toHaveLength(55);
    expect(new Set(JOINT_LEAGUE_PROFILES.map((p) => p.id)).size).toBe(55);
    for (const p of JOINT_LEAGUE_PROFILES) {
      const rules = horseVariantRulesFor(p.variant);
      expect(p.seats * rules.holeCardsDealt + 5 * (p.bombBoards ?? 1)).toBeLessThanOrEqual(
        rules.deckSize
      );
      expect(p.tournament && p.variant === 'pineapple').toBe(false);
      if (!p.tournament) expect(p.seats).toBeLessThanOrEqual(maxSeatsForVariant(p.variant));
    }
  });
  it.each(JOINT_LEAGUE_PROFILES.map((p) => [p.id] as const))(
    '%s plays conserved legal physical hands',
    async (id) => {
      const run = () =>
        runJointPolicyLeague({ profileId: id, pairs: 2, seed: JOINT_LEAGUE_SEEDS[0] });
      const a = await run();
      expect(a.complete, JSON.stringify(a)).toBe(true);
      expect(a.illegalActions).toBe(0);
      expect(a.cardErrors).toBe(0);
      expect(a.conservationErrors).toBe(0);
      expect(a.truncatedHands).toBe(0);
      expect(
        a.pairs.some((p) => (p.candidate.joint?.fired ?? 0) > 0),
        JSON.stringify(a.pairs.map((p) => p.candidate.reasons))
      ).toBe(true);
      expect(await run()).toEqual(a);
    }
  );
});
