/**
 * P12.1 LEGAL FORM: a Phase 12 proposal is already what HorseLogic.legalize
 * would make of it.
 *
 * The Phase 11 audit found that the Omaha variant proposals were not in the
 * legalizer's form: cash wagers were floored to cents while the legalizer
 * snaps to whole chips whenever the big blind is whole (`chipStep`), a bet at
 * 92% of the stack or a raise at 95% becomes an all-in, and a call that covers
 * the stack is the all-in the menu accepts. The P11.3 guard therefore refused
 * such candidates as `illegal_candidate`. The Phase 12 policy had the same
 * sizing (`unit = tournament ? 1 : 0.01`, a cent-floored target, raw calls).
 *
 * These cases run the REAL legalizer over natural spots from a real
 * HandController for every variant and mode, and refuse any rewrite of any
 * proposal, changed or not. Fixed-limit wagers must also equal the
 * controller's canonical bet, raise or completion amount.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HorseDecision, SeatPlayer } from '../../types.js';
import { HorseLogic, type HorseGameStateV2 } from '../HorseLogic.js';
import { seedFastRandom, variantInfo, type VariantInfo } from '../HorseEval.js';
import { evaluateRemainingVariantPolicy } from './RemainingVariantLivePolicy.js';
import {
  controllerSpotRandom,
  forEachControllerSpot,
} from './RemainingVariantControllerSpots.test-support.js';

const legalize = (
  HorseLogic as unknown as {
    legalize(d: HorseDecision, p: SeatPlayer, gs: HorseGameStateV2, vi: VariantInfo): HorseDecision;
  }
).legalize.bind(HorseLogic);

/** The legal reference decision HorseLogic would hand the policy here (the
 * pack off), so the policy is checked on the inputs it receives live. */
const reference = (spot: { hero: SeatPlayer; state: HorseGameStateV2 }): HorseDecision => {
  const d = HorseLogic.decide(
    spot.hero,
    spot.state,
    'balanced',
    {},
    { telemetry: false, mind: false, decisionTimeMs: 0, phase12Remaining: 'off' }
  );
  return {
    action: d.action,
    ...(d.amount !== undefined ? { amount: d.amount } : {}),
    thinkTime: 0,
  };
};

const CHANGED_FLOOR = 0;

const cases = [
  ['short_deck', 'cash', 70],
  ['short_deck', 'tournament', 50],
  ['pineapple', 'cash', 90],
  ['flh', 'cash', 70],
  ['flh', 'tournament', 50],
  ['flo8', 'cash', 60],
  ['flo8', 'tournament', 40],
] as const;

function pinDeckEntropy(seed: number) {
  const random = controllerSpotRandom(seed);
  vi.stubGlobal('crypto', {
    getRandomValues(target: Uint32Array) {
      for (let i = 0; i < target.length; i++) target[i] = Math.floor(random() * 0x100000000) >>> 0;
      return target;
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('P12.1 every Phase 12 proposal is in the legalizer form', () => {
  it.each(cases)(
    '%s %s: the real legalizer never rewrites a proposal (%i real hands)',
    (variant, mode, hands) => {
      // Card dealing must stay cryptographically random in production, but a
      // release gate cannot set a fixed coverage floor against fresh entropy.
      // Pin only this test's WebCrypto stream so every natural hand and every
      // coverage tally is reproducible without weakening the assertions.
      pinDeckEntropy(0xd3c00000 ^ hands ^ variant.length ^ (mode.length << 8));
      const limit = variant === 'flh' || variant === 'flo8';
      const tally = { spots: 0, eligible: 0, changed: 0, wagers: 0, allIns: 0, calls: 0 };
      const rewrites: unknown[] = [];
      forEachControllerSpot(variant, mode, hands, 0x5121 + hands, (spot) => {
        tally.spots++;
        seedFastRandom(0x7a11 + tally.spots);
        const baseline = reference(spot);
        seedFastRandom(0x7a11 + tally.spots);
        const r = evaluateRemainingVariantPolicy(
          spot.hero,
          spot.state,
          baseline,
          null,
          'shadow',
          () => 0
        );
        if (!r.receipt.eligible) return;
        tally.eligible++;
        const proposal = r.proposal;
        if (r.receipt.changed) tally.changed++;
        if (proposal.action === 'bet' || proposal.action === 'raise') tally.wagers++;
        if (proposal.action === 'all_in') tally.allIns++;
        if (proposal.action === 'call') tally.calls++;
        const vi: VariantInfo = {
          ...variantInfo(variant),
          isPotLimit: false,
          isFixedLimit: limit,
        };
        const legal = legalize({ ...proposal }, spot.hero, spot.state, vi);
        if (
          legal.action !== proposal.action ||
          (legal.amount ?? null) !== (proposal.amount ?? null)
        )
          rewrites.push({
            proposal: { action: proposal.action, amount: proposal.amount },
            legal: { action: legal.action, amount: legal.amount },
            reason: r.receipt.reason,
            stage: spot.state.stage,
            bigBlind: spot.state.bigBlind,
            stack: spot.hero.stack,
            bet: spot.hero.bet,
            currentBet: spot.state.currentBet,
            minRaiseTo: spot.state.minRaiseTo,
            maxRaiseTo: spot.state.maxRaiseTo,
            legalActions: spot.state.legalActions,
          });
        // Fixed limit: a sized wager is exactly the controller's canonical
        // bet, raise or completion amount, never a pot fraction.
        if (limit && (proposal.action === 'bet' || proposal.action === 'raise'))
          expect(proposal.amount).toBe(spot.state.minRaiseTo);
        expect(spot.state.legalActions).toContain(proposal.action);
      });
      if (process.env.P12_1_TALLY)
        console.log(
          JSON.stringify({ variant, mode, ...tally, rewrites: rewrites.length }) +
            '\n' +
            rewrites
              .slice(0, 3)
              .map((row) => '  ' + JSON.stringify(row))
              .join('\n')
        );
      expect(rewrites.slice(0, 5)).toEqual([]);
      expect(rewrites).toHaveLength(0);
      // Coverage: the spots are not all one shape.
      expect(tally.eligible).toBeGreaterThan(150);
      // Round 3 changes the reference only in its declared spots.
      expect(tally.changed).toBeGreaterThan(CHANGED_FLOOR);
      expect(tally.wagers).toBeGreaterThan(10);
      expect(tally.calls).toBeGreaterThan(10);
    }
  );

  it.each([
    // Whole-chip big blind, cash: the wager lands on whole chips.
    ['short_deck', 2, 1],
    // A cent big blind keeps the cent step.
    ['short_deck', 0.1, 0.01],
  ] as const)('%s with a %s big blind sizes on a %s chip step', (variant, bigBlind, step) => {
    pinDeckEntropy(0xd3c05121 ^ Math.round(bigBlind * 100));
    let wagers = 0;
    forEachControllerSpot(variant, 'cash', 120, 0x2a17, (spot) => {
      if (spot.state.bigBlind !== bigBlind) return;
      seedFastRandom(31);
      const baseline = reference(spot);
      seedFastRandom(31);
      const r = evaluateRemainingVariantPolicy(
        spot.hero,
        spot.state,
        baseline,
        null,
        'shadow',
        () => 0
      );
      const p = r.proposal;
      if (p.action !== 'bet' && p.action !== 'raise') return;
      // A wager is on the step unless it is pinned to the controller's own
      // interval boundary.
      const onStep = Math.abs(p.amount! / step - Math.round(p.amount! / step)) < 1e-6;
      expect(
        onStep || p.amount === spot.state.minRaiseTo || p.amount === spot.state.maxRaiseTo
      ).toBe(true);
      if (r.receipt.inputs) expect(r.receipt.inputs.geometry.chipUnit).toBe(step);
      wagers++;
    });
    expect(wagers).toBeGreaterThan(3);
  });
});
