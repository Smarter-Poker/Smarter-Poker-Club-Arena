import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withoutMeasurements } from '../HorseDeclaredWork.test-support.js';
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
import {
  remainingVariantActionEconomics,
  remainingVariantActionEconomicsIsValid,
} from './RemainingVariantActionEconomics.js';
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

describe('P12.1 cannot reach the decision from where it runs', () => {
  it('declares no clock budget: the pass, the sampler and the policy do their declared work', () => {
    // 2026-10-16 (docs/changelog/2026-10-16-packs-do-declared-work.md).
    for (const key of ['liveBudgetMs', 'samplingDeadlineMs', 'netActionBudgetMs'])
      expect(Object.hasOwn(REMAINING_VARIANT_DOMAIN, key), key).toBe(false);
  });

  it.each([3, 5, 1_000])(
    'a clock that jumps to %s ms changes nothing: the node fires, samples in full and is priced',
    (elapsed) => {
      let reads = 0;
      const late = evaluate('flo8', 'river', { now: () => (reads++ === 0 ? 0 : elapsed) });
      const fixed = evaluate('flo8', 'river');
      expect(late.result.receipt.reason).not.toBe('work_budget');
      expect(late.result.receipt.fired).toBe(true);
      expect(late.result.receipt.actionEconomics?.unavailable).toBeNull();
      expect(late.result.receipt.actionEconomics?.offeredSamples).toBe(
        REMAINING_VARIANT_DOMAIN.defaultSamples
      );
      expect(withoutMeasurements(late.result)).toEqual(withoutMeasurements(fixed.result));
    }
  );

  it('reports a priced result on the real clock, every time', () => {
    // A real clock on an unknown host. Before 2026-10-16 a loaded machine
    // could starve the sampler or the pass and every outcome had to be NAMED
    // from a closed set (10.86 rule 1); a starved pass still may never come
    // back as an empty result, a zero or a silence (the pass refuses by name
    // when offered fewer than MIN_TERMINAL_SAMPLES showdowns).
    // 2026-10-16: on the real clock of any host the node fires, the sampler
    // draws its full declared sample and the pass prices every line: no clock
    // can starve either any more.
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
        const economics = result.receipt.actionEconomics!;
        expect(economics).toBeTruthy();
        expect(economics.unavailable).toBe(null);
        expect(economics.budgetExhausted).toBe(false);
        expect(economics.offeredSamples).toBe(REMAINING_VARIANT_DOMAIN.defaultSamples);
        expect(economics.values.length).toBeGreaterThan(0);
        expect(result.receipt.features).toContain('net_action_economics');
        expect(result.receipt.reason).not.toBe('work_budget');
        expect(result.receipt.fired).toBe(true);
        expect(result.receipt.applied).toBe(false);
        expect(remainingVariantReceiptBindingIsValid(result.receipt)).toBe(true);
      } finally {
        restoreFastRandom(saved);
      }
    }
  });

  it('is called only after finish, and never on the policy clock', () => {
    // The ordering IS the safety property, so it is pinned at the source
    // rather than inferred from a timing run that a fast host would pass
    // either way. A regression that moves the pass back inside the policy
    // budget, or points its budget at the policy clock, turns this red.
    const source = readFileSync(resolve(__dirname, 'RemainingVariantLivePolicy.ts'), 'utf8');
    const finisher = source.indexOf('const finishPriced = (');
    expect(finisher).toBeGreaterThan(-1);
    const body = source.slice(finisher);
    const finishCall = body.indexOf('const out = finish(reason, proposal);');
    const economicsCall = body.indexOf('remainingVariantActionEconomics({');
    expect(finishCall).toBeGreaterThan(-1);
    expect(economicsCall).toBeGreaterThan(finishCall);
    // Exactly one call site, and it is that one.
    expect(source.split('remainingVariantActionEconomics({').length - 1).toBe(1);
    expect(source.split('actionEconomics =').length - 1).toBe(1);
    // 2026-10-16: no deadline is handed to the pass; it completes its work.
    const call = body.slice(economicsCall, body.indexOf('});', economicsCall));
    expect(call).not.toContain('withinBudget');
    expect(source).not.toContain('economicsStart');
    expect(body.slice(0, economicsCall)).not.toContain('now() - start');
    // A refused node is not priced at all.
    expect(body).toContain('if (!out.receipt.fired ||');
  });

  it('does not price a node the policy refused', () => {
    // No evidence and no sampling: the policy refuses the node, so there is
    // nothing to price and no economics field is invented to say so.
    const spot = remainingVariantSpot('flo8', 'river', 2);
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
    expect(result.receipt.fired).toBe(false);
    expect(result.receipt.reason).toBe('equity_budget_unavailable');
    expect(result.receipt.actionEconomics).toBe(undefined);
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

  it('costs what it costs, measured at the sampler full sample count', () => {
    // Measurement, not a strength claim, and deliberately NOT conditional on
    // the result being available: an unconditional budget lets every run
    // complete, so this always measures something. The number it prints is
    // the cost of the pass's declared work on THIS host (since 2026-10-16 no
    // deadline cuts it). Measured 2026-10-05: Mac Studio median 0.14 ms,
    // shared GitHub ubuntu runner median 1.01 ms with a 5.2 ms p95.
    const spot = remainingVariantSpot('flo8', 'river', 2);
    const opponentIds = spot.state.players
      .filter((p) => p.user_id !== spot.hero.user_id && !p.is_folded)
      .map((p) => p.user_id);
    const input = {
      variant: 'flo8',
      stage: 'river' as const,
      hero: spot.hero,
      players: spot.state.players,
      opponentIds,
      samples: Array.from({ length: REMAINING_VARIANT_DOMAIN.defaultSamples }, (_, i) => ({
        heroHigh: i % 3,
        opponentHigh: opponentIds.map((_id, k) => (i + k) % 5),
        heroLow: i % 2 ? 1 : null,
        opponentLow: opponentIds.map((_id, k) => ((i + k) % 3 ? 2 : null)),
        opponentDecisionStrength: opponentIds.map(() => 0.5),
      })),
      currentBet: spot.state.currentBet,
      betSize: spot.state.fixedBetSize!,
      actionHistory: spot.state.actionHistory ?? [],
      legalActions: spot.state.legalActions!,
      wagersCapped: false,
      minRaiseTo: spot.state.minRaiseTo ?? null,
      maxRaiseTo: spot.state.maxRaiseTo ?? null,
      chipUnit: 0.01 as const,
      asset: 'chips' as const,
      gameMode: 'cash' as const,
      bigBlind: spot.state.bigBlind,
      dealerSeat: spot.state.dealerSeat!,
      rakeConfig: spot.state.rakeConfig!,
      bbjConfig: { enabled: true, feeBB: 0.25, minPotBB: 0, minPlayersDealt: 2 },
      withinBudget: () => true,
    };
    const runs: number[] = [];
    for (let i = 0; i < 32; i++) {
      const started = performance.now();
      const result = remainingVariantActionEconomics(input);
      const elapsed = performance.now() - started;
      expect(result.unavailable, JSON.stringify(result.unavailable)).toBe(null);
      if (i >= 8) runs.push(elapsed);
    }
    runs.sort((a, b) => a - b);
    const median = runs[Math.floor(runs.length / 2)];
    console.log(
      `P12.1 net-action pass at ${REMAINING_VARIANT_DOMAIN.defaultSamples} samples: n=${runs.length} median=${median.toFixed(4)}ms p95=${runs[Math.floor(runs.length * 0.95)].toFixed(4)}ms max=${runs[runs.length - 1].toFixed(4)}ms`
    );
    expect(runs.length).toBe(24);
    expect(median).toBeGreaterThan(0);
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
