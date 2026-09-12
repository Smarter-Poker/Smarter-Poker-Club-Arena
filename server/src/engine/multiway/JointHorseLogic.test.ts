import { describe, expect, it } from 'vitest';
import { HorseLogic, type HorseDecideOpts } from '../HorseLogic.js';
import { saveFastRandom, seedFastRandom } from '../HorseEval.js';
import type { GameVariant } from '../../types.js';
import { jointPolicyFixture } from './JointRangeFixture.test-support.js';
import { remainingCards } from '../../benchmark/RemainingVariantPolicyEvidence.js';
import { calculatePots } from '../PokerEngine.js';

const variants: GameVariant[] = [
  'nlh',
  'plo4',
  'plo5',
  'plo6',
  'plo8',
  'flo8',
  'flh',
  'pineapple',
  'short_deck',
];
const opts: HorseDecideOpts = {
  telemetry: false,
  mind: false,
  decisionTimeMs: 0,
  phase10Plo4: 'off',
  phase11Omaha: 'off',
  phase12Remaining: 'off',
};
const action = (d: ReturnType<typeof HorseLogic.decide>) => ({
  action: d.action,
  amount: d.amount,
  thinkTime: d.thinkTime,
});
describe('Phase13 actual HorseLogic integration', () => {
  it.each(['plo4', 'plo5', 'plo6'] as const)(
    '%s preserves a rejected non-nut flush-draw call-off against two all-ins',
    (variant) => {
      const s = jointPolicyFixture(variant, 1, 'cash', 'flop');
      s.hero.cards = remainingCards('9s 8s Kc Qd Jh Tc').slice(0, Number(variant.slice(-1)));
      s.state.communityCards = remainingCards('As 7s 2d');
      s.hero.totalInvested = 20;
      s.state.players[0].totalInvested = 20;
      for (const opponent of s.state.players.slice(1, 3)) {
        Object.assign(opponent, { stack: 0, bet: 100, totalInvested: 120, is_all_in: true });
      }
      Object.assign(s.state, {
        currentBet: 100,
        toCall: 100,
        pot: 265,
        contestablePot: 265,
        legalActions: ['fold', 'all_in'],
        minRaiseTo: null,
        maxRaiseTo: null,
      });
      s.state.pots = calculatePots(s.state.players);
      s.state.actionHistory = s.state.players.slice(1, 3).map((p, i) => ({
        seat: p.seat,
        userId: p.user_id,
        action: 'all_in',
        amount: 100,
        timestamp: i + 1,
        stage: 'flop',
        isFullRaise: true,
      }));
      for (let seed = 131001; seed < 131013; seed++) {
        seedFastRandom(seed);
        const baseline = HorseLogic.decide(
          s.hero,
          s.state,
          'balanced',
          {},
          { ...opts, phase13Joint: 'off' }
        );
        seedFastRandom(seed);
        const candidate = HorseLogic.decide(
          s.hero,
          s.state,
          'balanced',
          {},
          { ...opts, phase13Joint: 'candidate', phase13EvidenceMode: true }
        );
        expect(baseline.action).toBe('fold');
        expect(candidate.action).toBe('fold');
        expect(candidate.jointPolicy?.fired, candidate.jointPolicy?.reason).toBe(true);
        expect(candidate.jointPolicy?.reason).toContain('protected_');
      }
    }
  );
  it.each(variants)(
    '%s retains baseline action and RNG across supported multiway streets and boards',
    (variant) => {
      for (const mode of ['cash', 'tournament'] as const) {
        if (variant === 'pineapple' && mode === 'tournament') continue;
        for (const street of ['preflop', 'flop', 'turn', 'river'] as const)
          for (const boards of street === 'preflop' ? [1] : [1, 2, 3]) {
            const s = jointPolicyFixture(variant, boards, mode, street);
            const before = JSON.stringify(s);
            seedFastRandom(130999);
            const off = HorseLogic.decide(
              s.hero,
              s.state,
              'balanced',
              {},
              { ...opts, phase13Joint: 'off' }
            );
            const rng = saveFastRandom();
            seedFastRandom(130999);
            const shadow = HorseLogic.decide(
              s.hero,
              s.state,
              'balanced',
              {},
              { ...opts, phase13Joint: 'shadow', phase13EvidenceMode: true }
            );
            expect(action(shadow)).toEqual(action(off));
            expect(saveFastRandom()).toBe(rng);
            expect(JSON.stringify(s)).toBe(before);
            const receipt = shadow.jointPolicy;
            expect(receipt?.fired, JSON.stringify({ variant, mode, street, boards, receipt })).toBe(
              true
            );
            expect(receipt?.applied).toBe(false);
            expect(receipt?.executionStatus).toBe('pending');
            expect(receipt?.finalAction).toBe(shadow.action);
            expect(receipt?.actionModel?.candidates.length).toBeGreaterThan(1);
            if (mode === 'tournament') {
              expect(receipt?.utilityOwner).toBe('phase7_evaluated');
              expect(receipt?.shadowUtility?.selectedAction).toBe(receipt?.proposalAction);
              expect(
                receipt?.shadowUtility?.candidates.every((c) => c.stackConservationError < 1e-8)
              ).toBe(true);
            }
          }
      }
    }
  );
  it('keeps tournament candidates unavailable when context is incomplete', () => {
    const s = jointPolicyFixture('nlh', 2, 'tournament');
    s.state.tournament!.contextStatus = 'incomplete';
    seedFastRandom(130999);
    const off = HorseLogic.decide(
      s.hero,
      s.state,
      'balanced',
      {},
      { ...opts, phase13Joint: 'off' }
    );
    seedFastRandom(130999);
    const candidate = HorseLogic.decide(
      s.hero,
      s.state,
      'balanced',
      {},
      { ...opts, phase13Joint: 'candidate', phase13EvidenceMode: true }
    );
    expect(action(candidate)).toEqual(action(off));
    expect(candidate.jointPolicy).toMatchObject({
      fired: true,
      applied: false,
      utilityOwner: 'phase7_unavailable',
    });
    expect(candidate.jointPolicy?.shadowUtility).toBeUndefined();
  });
  it('lets the existing utility owner select an offline candidate and prices bounty and recovery inputs', () => {
    const s = jointPolicyFixture('nlh', 2, 'tournament', 'river');
    Object.assign(s.state.tournament!, {
      isPko: true,
      isBounty: true,
      bountyFactor: 0.5,
      bountyPoolCents: 5000,
      bountyByUser: Object.fromEntries(s.state.players.map((p) => [p.user_id, 1000])),
    });
    seedFastRandom(130999);
    const d = HorseLogic.decide(
      s.hero,
      s.state,
      'balanced',
      {},
      { ...opts, phase13Joint: 'candidate', phase13EvidenceMode: true }
    );
    expect(d.jointPolicy?.utilityOwner).toBe('phase7_evaluated');
    expect(d.tournamentUtility).toEqual(d.jointPolicy?.shadowUtility);
    expect(d.tournamentUtility?.selectedAction).toBe(d.action);
    expect(d.tournamentUtility?.componentReconciliationError).toBeLessThan(1e-8);
  });
});
