import { describe, expect, it } from 'vitest';
import { remainingVariantSpot } from '../../benchmark/RemainingVariantPolicyEvidence.js';
import { restoreFastRandom, saveFastRandom } from '../HorseEval.js';
import { fixedLimitStreetBounds } from '../BettingStructure.js';
import { horseDecisionReceiptIsValid } from '../horseDecision/responseValidation.js';
import { horsePolicyOwnership } from '../HorsePolicyRegistry.js';
import {
  evaluateRemainingVariantPolicy,
  remainingVariantReceiptBindingIsValid,
} from './RemainingVariantLivePolicy.js';
import { REMAINING_VARIANT_DOMAIN } from './RemainingVariantPolicyPack.js';
import { remainingVariantActionEconomicsIsValid } from './RemainingVariantActionEconomics.js';
import { variantEquityFromShowdowns } from '../omaha/OmahaVariantEquity.js';

/**
 * P12.1 live wiring. The net-action economics are produced by the policy on
 * the FLH/FLO8 river node, VERIFIED at the worker response boundary against
 * the running module, and prove they changed no decision.
 */

const PINNED_RNG = 0x5f3759df;

function evaluate(
  variant: 'flh' | 'flo8' | 'short_deck' | 'pineapple',
  street: 'preflop' | 'flop' | 'turn' | 'river' = 'river',
  options: { now?: () => number; external?: boolean; seats?: number } = {}
) {
  const spot = remainingVariantSpot(variant, street, options.seats ?? 2);
  // A fixed clock keeps the CONTENT assertions deterministic. It is evidence
  // about the calculation, never about how long it takes: the real-clock cost
  // is measured separately below and is not asserted as a strength claim.
  options = { now: () => 0, ...options };
  const saved = saveFastRandom();
  restoreFastRandom(PINNED_RNG);
  try {
    return {
      spot,
      result: evaluateRemainingVariantPolicy(
        spot.hero,
        spot.state,
        spot.baseline,
        null,
        'shadow',
        options.now,
        1,
        !options.external
      ),
    };
  } finally {
    restoreFastRandom(saved);
  }
}

describe('P12.1 reaches the live FLH/FLO8 river node', () => {
  it.each(['flh', 'flo8'] as const)('%s carries an available net-action result', (variant) => {
    const { spot, result } = evaluate(variant);
    const receipt = result.receipt;
    expect(receipt.fired, receipt.reason).toBe(true);
    const economics = receipt.actionEconomics;
    expect(economics, receipt.reason).toBeTruthy();
    expect(economics!.unavailable, JSON.stringify(economics)).toBe(null);
    expect(economics!.variant).toBe(variant);
    expect(economics!.street).toBe('river');
    expect(economics!.scoring).toBe(variant === 'flo8' ? 'high_low_split' : 'high_only');
    expect(receipt.features).toContain('net_action_economics');
    // The declared bound is the canonical one, recomputed here from the
    // state's own action history rather than read back off the receipt.
    const bounds = fixedLimitStreetBounds(
      spot.state.actionHistory ?? [],
      'river',
      spot.state.fixedBetSize!,
      spot.state.currentBet
    );
    expect(economics!.wagerBounds).toMatchObject({
      betSize: spot.state.fixedBetSize,
      raiseSize: bounds.raiseSize,
      raiseTo: spot.state.minRaiseTo,
      wagers: bounds.wagers,
    });
    // The call line commits exactly what the controller says is owed.
    const call = economics!.values.find((v) => v.action === 'call')!;
    expect(call.committed).toBeCloseTo(spot.state.toCall!, 6);
    expect(call.samples).toBeGreaterThanOrEqual(4);
    expect(economics!.contestingOpponents).toBe(
      spot.state.players.filter((p) => p.user_id !== spot.hero.user_id && !p.is_folded).length
    );
    expect(remainingVariantActionEconomicsIsValid(economics)).toBe(true);
    expect(remainingVariantReceiptBindingIsValid(receipt)).toBe(true);
  });

  it.each(['preflop', 'flop', 'turn'] as const)('carries nothing on the %s node', (street) => {
    for (const variant of ['flh', 'flo8'] as const) {
      const { result } = evaluate(variant, street);
      expect(result.receipt.actionEconomics).toBe(undefined);
      expect(result.receipt.features).not.toContain('net_action_economics');
      expect(remainingVariantReceiptBindingIsValid(result.receipt)).toBe(true);
    }
  });

  it.each(['short_deck', 'pineapple'] as const)(
    'carries nothing for the no-limit %s river',
    (variant) => {
      const { result } = evaluate(variant);
      expect(result.receipt.fired, result.receipt.reason).toBe(true);
      expect(result.receipt.actionEconomics).toBe(undefined);
      expect(remainingVariantReceiptBindingIsValid(result.receipt)).toBe(true);
    }
  );

  it('is a function of the node, not of when it ran', () => {
    const first = evaluate('flo8').result.receipt.actionEconomics!;
    const second = evaluate('flo8').result.receipt.actionEconomics!;
    expect({ ...second, analysisMs: 0 }).toEqual({ ...first, analysisMs: 0 });
  });

  it('names the result unavailable when no terminal showdown was retained', () => {
    // External reference evidence arrives ALREADY aggregated: the individual
    // runouts it was built from are not available to price, and the receipt
    // says exactly that instead of pricing something else.
    const spot = remainingVariantSpot('flh', 'river', 2);
    const opponentIds = spot.state.players
      .filter((p) => p.user_id !== spot.hero.user_id && !p.is_folded)
      .map((p) => p.user_id);
    const evidence = variantEquityFromShowdowns({
      variant: 'flh',
      players: spot.state.players,
      heroId: spot.hero.user_id,
      callCost: spot.state.toCall!,
      opponentIds,
      samples: Array.from({ length: 16 }, () => ({
        heroHigh: 2,
        heroLow: null,
        opponentHigh: opponentIds.map(() => 1),
        opponentLow: opponentIds.map(() => null),
        opponentDecisionStrength: opponentIds.map(() => 0.5),
      })),
    })!;
    evidence.analysisMs = 0;
    const result = evaluateRemainingVariantPolicy(
      spot.hero,
      spot.state,
      spot.baseline,
      evidence,
      'shadow',
      () => 0,
      1,
      false
    );
    expect(result.receipt.fired, result.receipt.reason).toBe(true);
    expect(result.receipt.actionEconomics?.unavailable).toBe('terminal_samples_unavailable');
    expect(result.receipt.features).not.toContain('net_action_economics');
    expect(remainingVariantReceiptBindingIsValid(result.receipt)).toBe(true);
  });

  it('carries nothing at all when the equity read itself was refused', () => {
    // No evidence and no sampling: the policy never reaches a priced node, so
    // the refusal is the receipt's own reason and no economics field is
    // invented to carry it.
    const spot = remainingVariantSpot('flh', 'river', 2);
    const result = evaluateRemainingVariantPolicy(
      spot.hero,
      spot.state,
      spot.baseline,
      null,
      'shadow',
      () => 0,
      1,
      false
    );
    expect(result.receipt.reason).toBe('equity_budget_unavailable');
    expect(result.receipt.actionEconomics).toBe(undefined);
    expect(remainingVariantReceiptBindingIsValid(result.receipt)).toBe(true);
  });
});

describe('P12.1 never spends the policy budget it was given', () => {
  it('stops before the policy budget, not at it', () => {
    expect(REMAINING_VARIANT_DOMAIN.netActionDeadlineMs).toBeLessThan(
      REMAINING_VARIANT_DOMAIN.liveBudgetMs
    );
    expect(REMAINING_VARIANT_DOMAIN.netActionDeadlineMs).toBeGreaterThan(
      REMAINING_VARIANT_DOMAIN.samplingDeadlineMs
    );
  });

  it('names a work budget refusal while the policy itself still fires', () => {
    // Evidence whose own analysis already consumed past the net-action
    // deadline but not the policy budget. The economics refuse by name without
    // inspecting anything, and the policy completes on its own path: a
    // diagnostic can never be the reason a proposal is dropped.
    const spot = remainingVariantSpot('flh', 'river', 2);
    const opponentIds = spot.state.players
      .filter((p) => p.user_id !== spot.hero.user_id && !p.is_folded)
      .map((p) => p.user_id);
    const evidence = variantEquityFromShowdowns({
      variant: 'flh',
      players: spot.state.players,
      heroId: spot.hero.user_id,
      callCost: spot.state.toCall!,
      opponentIds,
      samples: Array.from({ length: 16 }, () => ({
        heroHigh: 2,
        heroLow: null,
        opponentHigh: opponentIds.map(() => 1),
        opponentLow: opponentIds.map(() => null),
        opponentDecisionStrength: opponentIds.map(() => 0.5),
      })),
    })!;
    evidence.analysisMs = REMAINING_VARIANT_DOMAIN.netActionDeadlineMs + 0.05;
    expect(evidence.analysisMs).toBeLessThan(REMAINING_VARIANT_DOMAIN.liveBudgetMs);
    const result = evaluateRemainingVariantPolicy(
      spot.hero,
      spot.state,
      spot.baseline,
      evidence,
      'shadow',
      () => 0,
      1,
      false
    );
    expect(result.receipt.reason).not.toBe('work_budget');
    expect(result.receipt.fired).toBe(true);
    expect(result.receipt.actionEconomics?.unavailable).toBe('work_budget_unavailable');
    expect(result.receipt.actionEconomics?.budgetExhausted).toBe(true);
    expect(result.receipt.actionEconomics?.values).toEqual([]);
    expect(remainingVariantReceiptBindingIsValid(result.receipt)).toBe(true);
  });

  it.each(['flh', 'flo8'] as const)(
    'prices %s with fees the structural path never reads, and proposes the same thing',
    (variant) => {
      // The policy's own price path reads `rakeConfig` and nothing else. The
      // BBJ schedule is read ONLY by the net-action economics, through the
      // joint deduction owner. Turning it on must therefore move the net chip
      // numbers and leave the proposal, the reason and the firing untouched:
      // that is what "diagnostic this round" means, demonstrated rather than
      // asserted in a comment.
      const bare = evaluate(variant).result;
      const spot = remainingVariantSpot(variant, 'river', 2);
      spot.state.bbjConfig = { enabled: true, feeBB: 0.25, minPotBB: 0, minPlayersDealt: 2 };
      const saved = saveFastRandom();
      restoreFastRandom(PINNED_RNG);
      const taxed = (() => {
        try {
          return evaluateRemainingVariantPolicy(
            spot.hero,
            spot.state,
            spot.baseline,
            null,
            'shadow',
            () => 0,
            1,
            true
          );
        } finally {
          restoreFastRandom(saved);
        }
      })();
      expect(taxed.receipt.reason).toBe(bare.receipt.reason);
      expect(taxed.receipt.fired).toBe(bare.receipt.fired);
      expect(taxed.proposal.action).toBe(bare.proposal.action);
      expect(taxed.proposal.amount).toBe(bare.proposal.amount);
      expect(taxed.receipt.callPrice).toBe(bare.receipt.callPrice);
      expect(taxed.receipt.applied).toBe(false);
      expect(bare.receipt.applied).toBe(false);
      const bareCall = bare.receipt.actionEconomics!.values.find((v) => v.action === 'call')!;
      const taxedCall = taxed.receipt.actionEconomics!.values.find((v) => v.action === 'call')!;
      expect(bareCall.bbjFee).toBe(0);
      // 0.25 BB of a 2 big blind is 0.50 a qualifying hand.
      expect(taxedCall.bbjFee).toBeCloseTo(0.5, 6);
      expect(taxedCall.netChips).toBeLessThan(bareCall.netChips);
    }
  );

  it('completes the whole priced node well inside the policy budget once warm', () => {
    // Measurement, not a strength claim: the fixed-clock assertions above are
    // computation coverage. This records what the pass actually costs on this
    // host at the sampler's full sample count.
    const runs: number[] = [];
    for (let i = 0; i < 24; i++) {
      const spot = remainingVariantSpot('flo8', 'river', 2);
      const saved = saveFastRandom();
      restoreFastRandom(PINNED_RNG);
      try {
        const result = evaluateRemainingVariantPolicy(
          spot.hero,
          spot.state,
          spot.baseline,
          null,
          'shadow',
          undefined,
          1,
          true
        );
        if (i >= 8 && result.receipt.actionEconomics?.unavailable === null)
          runs.push(result.receipt.actionEconomics.analysisMs);
      } finally {
        restoreFastRandom(saved);
      }
    }
    expect(runs.length).toBeGreaterThan(0);
    runs.sort((a, b) => a - b);
    const median = runs[Math.floor(runs.length / 2)];
    console.log(
      `P12.1 net-action pass: n=${runs.length} median=${median.toFixed(4)}ms max=${runs[runs.length - 1].toFixed(4)}ms`
    );
    expect(median).toBeLessThan(REMAINING_VARIANT_DOMAIN.liveBudgetMs);
  });
});

describe('P12.1 the receipt is verified at the boundary, not merely carried', () => {
  const build = (variant: 'flh' | 'flo8' = 'flo8') => {
    const { spot, result } = evaluate(variant);
    const decision = {
      ...result.decision,
      remainingVariantPolicy: structuredClone(result.receipt),
    };
    return {
      spot,
      decision: {
        ...decision,
        policyOwnership: horsePolicyOwnership(variant, decision, true),
      },
    };
  };

  it('accepts the decision the policy actually produced', () => {
    const { spot, decision } = build();
    expect(horseDecisionReceiptIsValid(decision, spot.state.gameVariant)).toBe(true);
  });

  it.each([
    [
      'a net result off its own declared bound',
      (r: Record<string, unknown>) => {
        const economics = r.actionEconomics as Record<string, unknown>;
        (economics.values as Record<string, unknown>[]).find((v) => v.action === 'raise')!.amount =
          999;
      },
    ],
    [
      'a best that is not the argmax',
      (r: Record<string, unknown>) => {
        const economics = r.actionEconomics as Record<string, unknown>;
        economics.best = { action: 'fold', response: 'terminal_showdown' };
      },
    ],
    [
      'a scoring model the pack does not use',
      (r: Record<string, unknown>) => {
        (r.actionEconomics as Record<string, unknown>).scoring = 'high_only';
      },
    ],
    [
      'a version nothing in this build produces',
      (r: Record<string, unknown>) => {
        (r.actionEconomics as Record<string, unknown>).version = 'net-action-v9';
      },
    ],
    [
      'economics bound to another variant',
      (r: Record<string, unknown>) => {
        (r.actionEconomics as Record<string, unknown>).variant = 'flh';
      },
    ],
    [
      'economics bound to another street',
      (r: Record<string, unknown>) => {
        (r.actionEconomics as Record<string, unknown>).street = 'turn';
      },
    ],
    [
      'the feature tag without a result',
      (r: Record<string, unknown>) => {
        const economics = r.actionEconomics as Record<string, unknown>;
        economics.values = [];
        economics.best = null;
        economics.unavailable = 'work_budget_unavailable';
      },
    ],
    [
      'a result without the feature tag',
      (r: Record<string, unknown>) => {
        r.features = (r.features as string[]).filter((f) => f !== 'net_action_economics');
      },
    ],
  ])('refuses %s', (_label, mutate) => {
    const { spot, decision } = build();
    expect(horseDecisionReceiptIsValid(decision, spot.state.gameVariant)).toBe(true);
    mutate(decision.remainingVariantPolicy as unknown as Record<string, unknown>);
    expect(remainingVariantReceiptBindingIsValid(decision.remainingVariantPolicy)).toBe(false);
    expect(horseDecisionReceiptIsValid(decision, spot.state.gameVariant)).toBe(false);
  });

  it('still accepts a receipt that claims no economics at all', () => {
    const { spot, decision } = build();
    const receipt = decision.remainingVariantPolicy as unknown as Record<string, unknown>;
    delete receipt.actionEconomics;
    receipt.features = (receipt.features as string[]).filter((f) => f !== 'net_action_economics');
    expect(remainingVariantReceiptBindingIsValid(receipt)).toBe(true);
    expect(horseDecisionReceiptIsValid(decision, spot.state.gameVariant)).toBe(true);
  });
});
