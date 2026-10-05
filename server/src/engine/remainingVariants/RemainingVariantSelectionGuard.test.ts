/**
 * P12.2 at the HorseLogic owner: an applied Phase 12 candidate the legalizer
 * would rewrite is refused (`selectionRefusal: 'illegal_candidate'`) and the
 * reference executed, the P10.3 law as P11.3 applies it to Phase 11; and the
 * P12.2 shard runner counts those refusals as `illegalCandidates`, beside and
 * never inside `changed`. Expected actions come from the pack-off reference
 * run, not from the code under test.
 */
import { describe, expect, it, vi } from 'vitest';

const forge = vi.hoisted(() => ({ amountDelta: 0 }));
vi.mock('./RemainingVariantLivePolicy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./RemainingVariantLivePolicy.js')>();
  return {
    ...actual,
    evaluateRemainingVariantPolicy: (
      ...args: Parameters<typeof actual.evaluateRemainingVariantPolicy>
    ) => {
      const result = actual.evaluateRemainingVariantPolicy(...args);
      if (!forge.amountDelta || typeof result.decision.amount !== 'number') return result;
      // An applied candidate whose wager is not a legal size.
      return {
        ...result,
        decision: { ...result.decision, amount: result.decision.amount + forge.amountDelta },
      };
    },
  };
});

import { remainingVariantSpot } from '../../benchmark/RemainingVariantPolicyEvidence.js';
import { runRemainingVariantStrengthShard } from '../../benchmark/RemainingVariantStrengthLeague.js';
import { HorseLogic } from '../HorseLogic.js';
import { seedFastRandom } from '../HorseEval.js';
import type { RemainingVariantMode } from './RemainingVariantLivePolicy.js';
import type { RemainingPolicyVariant } from './RemainingVariantPolicyPack.js';

const decide = (
  variant: RemainingPolicyVariant,
  street: 'preflop' | 'flop' | 'turn',
  phase12Remaining: RemainingVariantMode
) => {
  const spot = remainingVariantSpot(variant, street, 2, 'cash');
  seedFastRandom(100101);
  return HorseLogic.decide(
    spot.hero,
    spot.state,
    'balanced',
    {},
    {
      telemetry: false,
      mind: false,
      decisionTimeMs: 0,
      phase12Remaining,
      phase12EvidenceMode: true,
    }
  );
};
const act = (d: { action: string; amount?: number }) => ({
  action: d.action,
  amount: d.amount ?? null,
});

// Spots where the pack applies a wager that differs from the reference.
const WAGER_SPOTS = [
  ['short_deck', 'preflop'],
  ['pineapple', 'preflop'],
  ['flh', 'turn'],
  ['flo8', 'flop'],
] as const;

describe('P12.2 illegal candidate retention', () => {
  it.each(WAGER_SPOTS)(
    'an applied %s %s candidate the legalizer would rewrite is not executed; the reference is',
    (variant, street) => {
      const honest = decide(variant, street, 'candidate');
      expect(honest.remainingVariantPolicy).toMatchObject({ applied: true });
      expect(honest.remainingVariantPolicy?.selectionRefusal).toBeNull();
      expect(['bet', 'raise']).toContain(honest.action);
      const reference = decide(variant, street, 'off');
      expect(act(honest)).not.toEqual(act(reference));
      // Shadow is untouched by the guard: the reference is executed, nothing refused.
      const shadow = decide(variant, street, 'shadow');
      expect(act(shadow)).toEqual(act(reference));
      expect(shadow.remainingVariantPolicy?.selectionRefusal).toBeNull();
      forge.amountDelta = 0.004;
      try {
        const forged = decide(variant, street, 'candidate');
        expect(act(forged)).toEqual(act(reference));
        expect(forged.remainingVariantPolicy).toMatchObject({
          applied: false,
          selectionRefusal: 'illegal_candidate',
          finalAction: reference.action,
          finalAmount: reference.amount ?? null,
        });
      } finally {
        forge.amountDelta = 0;
      }
    }
  );
});

describe('P12.2 the shard runner counts guard refusals beside changed', () => {
  it('counts no natural refusal (P12.1 legal form), and a forged illegal size moves decisions from changed to illegalCandidates', async () => {
    const request = {
      profileId: 'p12c-short_deck-6max-4dealt-100bb',
      seed: 12101101,
      shard: 0,
      mode: 'development' as const,
      pairs: 96,
    };
    // P12.1 puts every proposal in the legalizer's own form
    // (remainingVariantLegalForm): wagers land on HorseLogic's chip step, so
    // the guard refuses no natural candidate. Before that fix the pack sized
    // no-limit wagers in cents against a whole-dollar legalizer and this shard
    // counted natural refusals.
    const natural = await runRemainingVariantStrengthShard('short_deck', request);
    expect(natural.complete).toBe(true);
    expect(natural.illegalCandidates).toBe(0);
    expect(natural.changed).toBeGreaterThan(0);
    expect(natural.illegalActions + natural.settlementMismatches).toBe(0);
    forge.amountDelta = 0.004;
    try {
      const forged = await runRemainingVariantStrengthShard('short_deck', request);
      expect(forged.complete).toBe(true);
      // Every applied wager is now off the legal grid: refused, never changed.
      expect(forged.illegalCandidates).toBeGreaterThan(natural.illegalCandidates);
      expect(forged.changed).toBeLessThan(natural.changed);
      expect(forged.illegalActions + forged.settlementMismatches).toBe(0);
    } finally {
      forge.amountDelta = 0;
    }
  }, 120_000);
});
