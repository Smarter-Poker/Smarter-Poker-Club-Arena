import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { omahaVariantSpot } from '../../benchmark/OmahaVariantPolicyEvidence.js';
import { restoreFastRandom, saveFastRandom } from '../HorseEval.js';
import {
  evaluateOmahaVariantPolicy,
  omahaVariantReceiptBindingIsValid,
} from './OmahaVariantLivePolicy.js';
import { omahaVariantActionEconomicsIsValid } from './OmahaVariantActionEconomics.js';
import { sampleOmahaVariantEquity } from './OmahaVariantSampler.js';
import type { OmahaPolicyVariant } from './OmahaVariantPolicyPack.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';

/**
 * P11-A live wiring (audit 2026-10-07). The river net-action result is
 * produced by the live Omaha policy on a fired river node, re-checked by the
 * receipt binding the worker boundary applies, and proven to change no
 * decision.
 */

const PINNED_RNG = 0x5f3759df;
const VARIANTS: OmahaPolicyVariant[] = ['plo5', 'plo6', 'plo8'];

function evaluate(
  variant: OmahaPolicyVariant,
  street: 'preflop' | 'flop' | 'turn' | 'river' = 'river',
  edit: (state: HorseGameStateV2) => void = () => {}
) {
  const spot = omahaVariantSpot(variant, street, 2);
  edit(spot.state);
  const saved = saveFastRandom();
  restoreFastRandom(PINNED_RNG);
  try {
    // A fixed clock keeps the content deterministic; it is evidence about
    // the calculation, never about how long it takes.
    return {
      spot,
      result: evaluateOmahaVariantPolicy(
        spot.hero,
        spot.state,
        spot.baseline,
        null,
        'shadow',
        () => 0
      ),
    };
  } finally {
    restoreFastRandom(saved);
  }
}

describe('P11-A reaches the live PLO5/PLO6/PLO8 river node', () => {
  it.each(VARIANTS)('%s carries an available, bound net-action result', (variant) => {
    const { spot, result } = evaluate(variant);
    const receipt = result.receipt;
    expect(receipt.fired, receipt.reason).toBe(true);
    const economics = receipt.netActionEconomics!;
    expect(economics, receipt.reason).toBeTruthy();
    expect(economics.unavailable, JSON.stringify(economics)).toBeNull();
    expect(economics.variant).toBe(variant);
    expect(economics.scoring).toBe(variant === 'plo8' ? 'high_low_split' : 'high_only');
    expect(receipt.features).toContain('net_action_economics');
    // The wager bounds are the controller's own, and the sizes priced lie
    // inside them: the minimum and the pot-limit/stack ceiling.
    expect(economics.wagerBounds).toEqual({
      minRaiseTo: spot.state.minRaiseTo,
      maxRaiseTo: spot.state.maxRaiseTo,
      priced: [spot.state.minRaiseTo, spot.state.maxRaiseTo],
    });
    const call = economics.values.find((v) => v.action === 'call')!;
    expect(call.committed).toBeCloseTo(spot.state.toCall!, 6);
    expect(call.samples).toBeGreaterThanOrEqual(4);
    expect(economics.contestingOpponents).toBe(1);
    expect(omahaVariantActionEconomicsIsValid(economics)).toBe(true);
    expect(omahaVariantReceiptBindingIsValid(receipt)).toBe(true);
  });

  it.each(['preflop', 'flop', 'turn'] as const)('carries nothing on the %s node', (street) => {
    for (const variant of VARIANTS) {
      const { result } = evaluate(variant, street);
      expect(result.receipt.netActionEconomics).toBeUndefined();
      expect(result.receipt.features).not.toContain('net_action_economics');
      expect(omahaVariantReceiptBindingIsValid(result.receipt)).toBe(true);
    }
  });

  it('a node the policy refused is not priced', () => {
    const { result } = evaluate('plo8', 'river', (s) => {
      (s as { rakeConfig?: unknown }).rakeConfig = undefined;
    });
    expect(result.receipt.fired).toBe(false);
    expect(result.receipt.netActionEconomics).toBeUndefined();
  });

  it('decides nothing: the BBJ fee moves only the net chips', () => {
    for (const variant of VARIANTS) {
      const plain = evaluate(variant).result;
      const bbj = evaluate(variant, 'river', (s) => {
        s.bbjConfig = { enabled: true, feeBB: 0.5, minPotBB: 0, minPlayersDealt: 2 };
      }).result;
      const call = (r: typeof plain) =>
        r.receipt.netActionEconomics!.values.find((v) => v.action === 'call')!;
      expect(call(bbj).bbjFee).toBe(1);
      expect(call(plain).bbjFee).toBe(0);
      expect(call(bbj).netChips).toBeLessThan(call(plain).netChips);
      for (const key of [
        'reason',
        'proposalAction',
        'proposalAmount',
        'callPrice',
        'fired',
        'changed',
        'applied',
        'latencyMs',
      ] as const)
        expect(bbj.receipt[key], key).toEqual(plain.receipt[key]);
      expect(bbj.decision).toEqual(plain.decision);
      expect(bbj.proposal).toEqual(plain.proposal);
    }
  });

  it('the receipt binding refuses a tampered or mislabelled result', () => {
    const { result } = evaluate('plo8');
    const copy = () => JSON.parse(JSON.stringify(result.receipt));
    expect(omahaVariantReceiptBindingIsValid(copy())).toBe(true);
    const untagged = copy();
    untagged.features = untagged.features.filter((f: string) => f !== 'net_action_economics');
    expect(omahaVariantReceiptBindingIsValid(untagged)).toBe(false);
    const otherVariant = copy();
    otherVariant.netActionEconomics.variant = 'plo5';
    otherVariant.netActionEconomics.scoring = 'high_only';
    expect(omahaVariantReceiptBindingIsValid(otherVariant)).toBe(false);
    const wrongBest = copy();
    wrongBest.netActionEconomics.best = {
      action: 'fold',
      response: 'terminal_showdown',
      amount: null,
    };
    expect(omahaVariantReceiptBindingIsValid(wrongBest)).toBe(false);
    const absent = copy();
    delete absent.netActionEconomics;
    expect(omahaVariantReceiptBindingIsValid(absent)).toBe(false);
    absent.features = absent.features.filter((f: string) => f !== 'net_action_economics');
    expect(omahaVariantReceiptBindingIsValid(absent)).toBe(true);
  });

  it('retaining the showdowns leaves the sampler evidence identical', () => {
    for (const variant of VARIANTS) {
      const spot = omahaVariantSpot(variant, 'river', 3);
      const run = (retain?: Parameters<typeof sampleOmahaVariantEquity>[4]) => {
        const saved = saveFastRandom();
        restoreFastRandom(PINNED_RNG);
        try {
          const e = sampleOmahaVariantEquity(variant, spot.hero, spot.state, () => true, retain);
          return e ? { ...e, analysisMs: 0 } : e;
        } finally {
          restoreFastRandom(saved);
        }
      };
      let retained = 0;
      const withRetain = run((showdowns) => {
        retained = showdowns.samples.length;
        expect(showdowns.opponentIds).toEqual(['v2', 'v3']);
      });
      expect(withRetain).toEqual(run());
      expect(retained).toBe(withRetain!.samples);
    }
  });

  it('is priced strictly after finish, once, on its own budget (source pin)', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./OmahaVariantLivePolicy.ts', import.meta.url)),
      'utf8'
    );
    const calls = source.match(/omahaVariantActionEconomics\(\{/g) ?? [];
    expect(calls).toHaveLength(1);
    const body = source.slice(source.indexOf('const finishPriced = '));
    const finishAt = body.indexOf('const out = finish(reason, proposal);');
    const firedGate = body.indexOf("if (!out.receipt.fired || s.stage !== 'river') return out;");
    const callAt = body.indexOf('omahaVariantActionEconomics({');
    expect(finishAt).toBeGreaterThan(0);
    expect(firedGate).toBeGreaterThan(finishAt);
    expect(callAt).toBeGreaterThan(firedGate);
    expect(body).toContain(
      'withinBudget: () => now() - economicsStart < OMAHA_VARIANT_NET_ACTION_BUDGET_MS'
    );
    // A refused sample is not priced.
    expect(source).toContain("return finish('invalid_equity_evidence');");
    expect(source).not.toContain("finishPriced('invalid_equity_evidence')");
  });
});
