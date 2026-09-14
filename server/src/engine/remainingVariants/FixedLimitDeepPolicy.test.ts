import { describe, expect, it } from 'vitest';
import { remainingVariantSpot } from '../../benchmark/RemainingVariantPolicyEvidence.js';
import { evaluateRemainingVariantPolicy } from './RemainingVariantLivePolicy.js';
import { seedFastRandom } from '../HorseEval.js';
import { HorseLogic } from '../HorseLogic.js';
import { remainingVariantSeatCap } from './RemainingVariantPolicyPack.js';

function deepSpot(
  variant: 'flh' | 'flo8' | 'short_deck' | 'pineapple',
  street: 'preflop' | 'flop' | 'turn' | 'river',
  seats: number,
  depth: number,
  mode: 'cash' | 'tournament' = 'cash'
) {
  const s = remainingVariantSpot(variant, street, seats, mode);
  s.hero.stack = depth * s.state.bigBlind - s.hero.bet;
  for (const p of s.state.players) p.stack = depth * s.state.bigBlind - p.bet;
  if (s.state.tournament) {
    s.state.tournament.stacks = s.state.players.map((p) => p.stack + p.totalInvested);
    s.state.tournament.stackByUser = Object.fromEntries(
      s.state.players.map((p) => [p.user_id, p.stack + p.totalInvested])
    );
  }
  return s;
}
describe('actual legacy fixed-limit deep-stack domain', () => {
  it.each(['flh', 'flo8'] as const)(
    '%s covers all seats, streets, positions and fixed raise caps through1000BB',
    (variant) => {
      for (const mode of ['cash', 'tournament'] as const)
        for (const street of ['preflop', 'flop', 'turn', 'river'] as const)
          for (const depth of [251, 400, 1000])
            for (let seats = 2; seats <= remainingVariantSeatCap(variant, mode); seats++)
              for (const button of [1, seats]) {
                const s = deepSpot(variant, street, seats, depth, mode);
                s.state.dealerSeat = button;
                for (const capped of [false, true]) {
                  s.state.wagersCapped = capped;
                  s.state.legalActions = capped ? ['fold', 'call'] : ['fold', 'call', 'raise'];
                  if (capped) {
                    s.state.minRaiseTo = null;
                    s.state.maxRaiseTo = null;
                  }
                  seedFastRandom(120041);
                  const r = evaluateRemainingVariantPolicy(
                    s.hero,
                    s.state,
                    s.baseline,
                    null,
                    'shadow',
                    () => 0
                  );
                  expect(
                    r.receipt.fired,
                    JSON.stringify({
                      variant,
                      street,
                      seats,
                      depth,
                      capped,
                      reason: r.receipt.reason,
                    })
                  ).toBe(true);
                  expect(r.decision).toBe(s.baseline);
                  expect(r.receipt.applied).toBe(false);
                  expect(s.state.legalActions).toContain(r.proposal.action);
                  if (r.proposal.action === 'raise')
                    expect(r.proposal.amount).toBe(s.state.currentBet + s.state.fixedBetSize!);
                }
              }
    }
  );
  it.each(['flh', 'flo8'] as const)(
    '%s reaches the real tournament utility owner at deep fixed limits',
    (variant) => {
      for (const depth of [400, 1000])
        for (const seats of [2, 6, 10])
          for (const street of ['preflop', 'flop', 'turn', 'river'] as const) {
            const s = deepSpot(variant, street, seats, depth, 'tournament');
            const opts = {
              telemetry: false,
              mind: false,
              decisionTimeMs: 0,
              phase13Joint: 'off' as const,
            };
            seedFastRandom(120041);
            const baseline = HorseLogic.decide(
              s.hero,
              s.state,
              'balanced',
              {},
              { ...opts, phase12Remaining: 'off' }
            );
            seedFastRandom(120041);
            const shadow = HorseLogic.decide(
              s.hero,
              s.state,
              'balanced',
              {},
              { ...opts, phase12Remaining: 'shadow', phase12EvidenceMode: true }
            );
            expect(shadow.action).toBe(baseline.action);
            expect(shadow.amount).toBe(baseline.amount);
            expect(shadow.remainingVariantPolicy?.fired).toBe(true);
            // The seeded six-seat FLO8 river subset has only one quarter-pot
            // outcome. Reweighting it to the existing safety-capped equity leaves
            // fewer than eight effective outcomes; the confidence gate must refuse.
            const insufficient = variant === 'flo8' && seats === 6 && street === 'river';
            expect(
              shadow.remainingVariantPolicy?.utilityOwner,
              JSON.stringify({ variant, street, seats, depth })
            ).toBe(insufficient ? 'phase7_unavailable' : 'phase7_evaluated');
            expect(shadow.remainingVariantPolicy?.utilityUnavailableReason).toBe(
              insufficient ? 'sample_calibration' : undefined
            );
            expect(Boolean(shadow.remainingVariantPolicy?.shadowUtility)).toBe(!insufficient);
            expect(shadow.remainingVariantPolicy?.applied).toBe(false);
          }
    }
  );
  it.each(['flh', 'flo8'] as const)('%s retains the tested1000BB upper boundary', (variant) => {
    const s = deepSpot(variant, 'preflop', 2, 1001);
    expect(
      evaluateRemainingVariantPolicy(s.hero, s.state, s.baseline, null, 'shadow', () => 0).receipt
        .reason
    ).toBe('depth_or_ante_outside_pack');
  });
  it.each(['short_deck', 'pineapple'] as const)(
    '%s retains the separate250BB no-limit boundary',
    (variant) => {
      const s = deepSpot(variant, 'preflop', 2, 251);
      expect(
        evaluateRemainingVariantPolicy(s.hero, s.state, s.baseline, null, 'shadow', () => 0).receipt
          .reason
      ).toBe('depth_or_ante_outside_pack');
    }
  );
});
