/**
 * P13.1 SELECTION GUARD: the P10.3 `illegal_candidate` law for the joint node.
 *
 * With the legal form in place (JointLegalForm.test.ts) no natural candidate
 * is ever rewritten by the legalizer, so the guard is proved here by removing
 * the owner's legalizer from the policy call: the raw cent-sized wager the
 * policy then ranks is exactly the origin/main defect. Before P13.1 the joint
 * node applied the legalizer's rewrite of such a candidate silently; now it
 * is refused by name and the reference action is retained.
 */
import { describe, expect, it, vi } from 'vitest';
import { HorseLogic, type HorseDecideOpts } from '../HorseLogic.js';
import { seedFastRandom } from '../HorseEval.js';
import { jointPolicyFixture } from './JointRangeFixture.test-support.js';
import { calculatePots, calculateContestablePot } from '../PokerEngine.js';

vi.mock('./JointLivePolicy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./JointLivePolicy.js')>();
  return {
    ...actual,
    // The policy without the owner's legalizer: origin/main's sizing.
    evaluateJointLivePolicy: (...args: Parameters<typeof actual.evaluateJointLivePolicy>) =>
      actual.evaluateJointLivePolicy(args[0], args[1], args[2], args[3], args[4], args[5]),
  };
});

const opts: HorseDecideOpts = {
  telemetry: false,
  mind: false,
  decisionTimeMs: 0,
  phase10Plo4: 'off',
  phase11Omaha: 'off',
  phase12Remaining: 'off',
  phase13EvidenceMode: true,
};

describe('P13.1 an applied Phase 13 candidate the legalizer would rewrite never acts', () => {
  it('refuses it as illegal_candidate and keeps the reference action', () => {
    let refused = 0;
    // Round 3 acts only where a wager's paired edge clears its lower bound,
    // so the spots are swept over several decision seeds.
    for (let seed = 131313; seed < 131313 + 24; seed++)
      for (const boards of [1, 2])
        for (const street of ['flop', 'turn', 'river'] as const)
          for (const invested of [5.25, 5.37, 5.5]) {
            const s = jointPolicyFixture('nlh', boards, 'cash', street);
            // Fractional pot fractions at a whole big blind: the settlement
            // unit sizes them in cents, the legalizer in whole chips.
            for (const p of s.state.players) p.totalInvested = invested;
            s.hero.totalInvested = invested;
            s.state.pot = invested * s.state.players.length;
            s.state.pots = calculatePots(s.state.players);
            s.state.contestablePot = calculateContestablePot(s.state.players, s.hero.user_id, 0);
            seedFastRandom(seed);
            const reference = HorseLogic.decide(
              s.hero,
              s.state,
              'balanced',
              {},
              { ...opts, phase13Joint: 'off' }
            );
            seedFastRandom(seed);
            const d = HorseLogic.decide(
              s.hero,
              s.state,
              'balanced',
              {},
              { ...opts, phase13Joint: 'candidate' }
            );
            const r = d.jointPolicy!;
            expect(r.inputs?.geometry.legalForm).toBe('not_supplied');
            if (r.selectionRefusal !== 'illegal_candidate') continue;
            refused++;
            expect(r.applied).toBe(false);
            expect({ action: d.action, amount: d.amount ?? null }).toEqual({
              action: reference.action,
              amount: reference.amount ?? null,
            });
            expect(r.finalAction).toBe(reference.action);
          }
    expect(refused).toBeGreaterThan(0);
  });
});
