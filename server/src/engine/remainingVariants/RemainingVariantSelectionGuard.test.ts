/**
 * P12.2 at the HorseLogic owner: an applied Phase 12 candidate the legalizer
 * would rewrite is refused (`selectionRefusal: 'illegal_candidate'`) and the
 * reference executed, the P10.3 law as P11.3 applies it to Phase 11; and the
 * P12.2 shard runner counts those refusals as `illegalCandidates`, beside and
 * never inside `changed`. Expected actions come from the pack-off reference
 * run, not from the code under test.
 */
import { describe, expect, it, vi } from 'vitest';

const forge = vi.hoisted(() => ({ on: false }));
vi.mock('./RemainingVariantLivePolicy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./RemainingVariantLivePolicy.js')>();
  return {
    ...actual,
    evaluateRemainingVariantPolicy: (
      ...args: Parameters<typeof actual.evaluateRemainingVariantPolicy>
    ) => {
      const result = actual.evaluateRemainingVariantPolicy(...args);
      if (!forge.on || !result.receipt.applied) return result;
      // An applied candidate the legalizer would rewrite: a wager off the
      // legal size, or the passive action of the other kind (a fold where
      // nothing is owed, a check against a bet).
      const d = result.decision;
      const decision =
        typeof d.amount === 'number' && (d.action === 'bet' || d.action === 'raise')
          ? { ...d, amount: d.amount + 0.004 }
          : d.action === 'check'
            ? { ...d, action: 'fold' as const }
            : d.action === 'fold'
              ? { ...d, action: 'check' as const }
              : d;
      return { ...result, decision };
    },
  };
});

import { runRemainingVariantStrengthShard } from '../../benchmark/RemainingVariantStrengthLeague.js';
import { HorseLogic } from '../HorseLogic.js';
import { seedFastRandom } from '../HorseEval.js';
import type { RemainingVariantMode } from './RemainingVariantLivePolicy.js';
import type { RemainingPolicyVariant } from './RemainingVariantPolicyPack.js';
import {
  round3ChangedSpot,
  round3ChangedStreet,
  type Round3Spot,
} from './RemainingVariantRound3Spots.test-support.js';

const decide = (spot: Round3Spot, phase12Remaining: RemainingVariantMode) => {
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

// Round 3 changes the reference only in its declared spots: the no-limit
// flop checked to the hero (the pack checks a reference bet) and the
// fixed-limit heads-up button first in (the pack opens a reference fold).
const VARIANTS = ['short_deck', 'pineapple', 'flh', 'flo8'] as const;
const changedSpot = (variant: RemainingPolicyVariant) =>
  round3ChangedSpot(variant, 'cash', (spot) => {
    const off = decide(spot, 'off');
    return JSON.stringify(act(decide(spot, 'candidate'))) !== JSON.stringify(act(off));
  });

describe('P12.2 illegal candidate retention', () => {
  it.each(VARIANTS)(
    'an applied %s candidate the legalizer would rewrite is not executed; the reference is',
    (variant) => {
      const spot = changedSpot(variant);
      expect(spot().state.stage).toBe(round3ChangedStreet(variant));
      const honest = decide(spot(), 'candidate');
      expect(honest.remainingVariantPolicy).toMatchObject({ applied: true });
      expect(honest.remainingVariantPolicy?.selectionRefusal).toBeNull();
      const reference = decide(spot(), 'off');
      expect(act(honest)).not.toEqual(act(reference));
      // Shadow is untouched by the guard: the reference is executed, nothing refused.
      const shadow = decide(spot(), 'shadow');
      expect(act(shadow)).toEqual(act(reference));
      expect(shadow.remainingVariantPolicy?.selectionRefusal).toBeNull();
      forge.on = true;
      try {
        const forged = decide(spot(), 'candidate');
        expect(act(forged)).toEqual(act(reference));
        expect(forged.remainingVariantPolicy).toMatchObject({
          applied: false,
          selectionRefusal: 'illegal_candidate',
          finalAction: reference.action,
          finalAmount: reference.amount ?? null,
        });
      } finally {
        forge.on = false;
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
    // (remainingVariantLegalForm), so the guard refuses no natural candidate.
    // Before that fix the round-1 pack sized no-limit wagers in cents against
    // a whole-dollar legalizer and this shard counted natural refusals.
    const natural = await runRemainingVariantStrengthShard('short_deck', request);
    expect(natural.complete).toBe(true);
    expect(natural.illegalCandidates).toBe(0);
    expect(natural.changed).toBeGreaterThan(0);
    expect(natural.illegalActions + natural.settlementMismatches).toBe(0);
    forge.on = true;
    try {
      const forged = await runRemainingVariantStrengthShard('short_deck', request);
      expect(forged.complete).toBe(true);
      // Every applied change is now one the legalizer rewrites: refused, never changed.
      expect(forged.illegalCandidates).toBeGreaterThan(natural.illegalCandidates);
      expect(forged.changed).toBeLessThan(natural.changed);
      expect(forged.illegalActions + forged.settlementMismatches).toBe(0);
    } finally {
      forge.on = false;
    }
  }, 120_000);
});
