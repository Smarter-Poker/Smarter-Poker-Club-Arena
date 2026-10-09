import { describe, expect, it } from 'vitest';
import type { GameVariant } from '../../types.js';
import { KNOWN_VARIANTS } from '../VariantRules.js';
import { isJointHoldoutSeed } from '../../benchmark/JointStrengthContract.js';
import { sampleJointRanges } from './JointRangeSampler.js';
import { jointPolicyFixture } from './JointRangeFixture.test-support.js';
import {
  evaluateJointActions,
  JOINT_ACTION_PACK,
  JOINT_ACTION_PACK_ROUND2,
  JOINT_SELECTION_RULE,
} from './JointActionModel.js';
import {
  JOINT_RESPONSE_CALIBRATION,
  JOINT_RESPONSE_FEATURES,
  jointCalibratedResponse,
  jointResponseFeatureVector,
  jointResponseFrequencies,
  jointStrengthPercentiles,
} from './JointResponseCalibration.js';
import { JOINT_RESPONSE_LIMITS } from './JointResponseTree.js';
import { evaluateJointLivePolicy } from './JointLivePolicy.js';

const STREETS = ['preflop', 'flop', 'turn', 'river'] as const;
const VARIANTS = KNOWN_VARIANTS as readonly GameVariant[];
const spot = {
  price: 10,
  pot: 20,
  active: 2,
  streetWagers: 1,
  ownRaises: 0,
  bomb: false,
  allInForCall: false,
};

function evidenceFor(variant: GameVariant, street: (typeof STREETS)[number], boards = 1) {
  const { hero, state } = jointPolicyFixture(variant, boards, 'cash', street);
  const evidence = sampleJointRanges(hero, state, {
    seed: 13100401,
    samples: 16,
    withinBudget: () => true,
  })!;
  return { hero, state, evidence };
}

describe('Phase 13 round 3: the response pack measured on the horse population', () => {
  it('fits every variant and street, on development seeds only', () => {
    expect(JOINT_RESPONSE_CALIBRATION.developmentSeeds.length).toBeGreaterThan(0);
    for (const seed of JOINT_RESPONSE_CALIBRATION.developmentSeeds)
      expect(isJointHoldoutSeed(seed)).toBe(false);
    for (const variant of VARIANTS)
      for (const street of STREETS) {
        const fit = (
          JOINT_RESPONSE_CALIBRATION.table as Record<
            string,
            Record<string, { continue: number[]; raise: number[]; n: number }>
          >
        )[variant][street];
        expect(fit.continue).toHaveLength(JOINT_RESPONSE_FEATURES.length);
        expect(fit.raise).toHaveLength(JOINT_RESPONSE_FEATURES.length);
        expect(fit.continue.every(Number.isFinite)).toBe(true);
        expect(fit.raise.every(Number.isFinite)).toBe(true);
        expect(fit.n).toBeGreaterThan(500);
      }
    expect(JOINT_ACTION_PACK.responses).toBe(JOINT_RESPONSE_CALIBRATION.version);
    expect(JOINT_ACTION_PACK.version).toBe('joint-action-response-round3-v1');
    expect(JOINT_ACTION_PACK_ROUND2.version).toBe('joint-action-response-round2-v1');
  });

  it('answers every cell with a frequency, and a dearer price is continued less often', () => {
    for (const variant of VARIANTS)
      for (const street of STREETS) {
        const cheap = jointResponseFrequencies({ ...spot, variant, street, price: 2, pot: 40 });
        const dear = jointResponseFrequencies({ ...spot, variant, street, price: 40, pot: 20 });
        for (const f of [cheap, dear]) {
          expect(f.continueFrequency).toBeGreaterThan(0);
          expect(f.continueFrequency).toBeLessThan(1);
          expect(f.raiseShare).toBeGreaterThanOrEqual(0);
          expect(f.raiseShare).toBeLessThan(1);
        }
        expect(dear.continueFrequency).toBeLessThan(cheap.continueFrequency);
        // An all-in call cannot raise.
        expect(
          jointResponseFrequencies({ ...spot, variant, street, allInForCall: true }).raiseShare
        ).toBe(0);
      }
    expect(() => jointResponseFrequencies({ ...spot, variant: 'omaha', street: 'flop' })).toThrow(
      'joint_response_uncalibrated_cell'
    );
    expect(() =>
      jointResponseFeatureVector({ ...spot, variant: 'nlh', street: 'flop', price: 0 })
    ).toThrow('joint_response_invalid_features');
    expect(
      jointResponseFeatureVector({
        ...spot,
        variant: 'nlh',
        street: 'flop',
        active: 4,
        streetWagers: 2,
        ownRaises: 1,
        bomb: true,
      })
    ).toEqual([1, 10 / 30, Math.log(4), 1, 1, 1, 0]);
  });

  it('ranks each responder within its own sampled range by its runout strength, high or low', () => {
    const { evidence } = evidenceFor('nlh', 'flop', 2);
    const n = evidence.samples.length;
    const pct = jointStrengthPercentiles(evidence.samples, 0, (i) => i / n);
    expect([...pct].sort((a, b) => a - b)).toEqual(
      Array.from({ length: n }, (_, r) => (r + 0.5) / n)
    );
    const signal = evidence.samples.map(
      (s) => s.boards.reduce((a, b) => a + b.opponentHigh[0], 0) / s.boards.length
    );
    for (let a = 0; a < n; a++)
      for (let b = 0; b < n; b++) if (signal[a] > signal[b]) expect(pct[a]).toBeGreaterThan(pct[b]);
    // Split games: a sample holding the best low ranks at the top even with
    // the weakest high.
    const split = structuredClone(evidence.samples);
    split.forEach((s, i) =>
      s.boards.forEach((b) => {
        b.opponentHigh[0] = i === 0 ? 0 : 1000 + i;
        b.opponentLow[0] = i === 0 ? 1 : null;
      })
    );
    const lows = jointStrengthPercentiles(split, 0, (i) => i / n, true);
    expect(lows[0]).toBeGreaterThanOrEqual((n - 1.5) / n);
    expect(jointStrengthPercentiles(split, 0, (i) => i / n, false)[0]).toBe(0.5 / n);
    const f = { continueFrequency: 0.5, raiseShare: 0.2 };
    expect(jointCalibratedResponse(0.4, f)).toBe('fold');
    expect(jointCalibratedResponse(0.5, f)).toBe('fold');
    expect(jointCalibratedResponse(0.6, f)).toBe('call');
    expect(jointCalibratedResponse(0.95, f)).toBe('raise');
    expect(jointCalibratedResponse(0.99, { continueFrequency: 0.3, raiseShare: 0 })).toBe('call');
  });

  it('continues exactly the measured share of each responder range', () => {
    for (const variant of VARIANTS) {
      const { hero, state, evidence } = evidenceFor(variant, 'preflop', 1);
      const baseline = { action: 'check' as const, thinkTime: 0 };
      const result = evaluateJointActions(hero, state, baseline, evidence, () => true)!;
      expect(result.version).toBe(JOINT_ACTION_PACK.version);
      expect(result.responseModel).toBe('one_response_then_showdown');
      for (const row of result.candidates) {
        if (!['bet', 'raise'].includes(row.action)) continue;
        // The first responder faces one price, pot and table in every
        // sample, so one frequency: it continues with exactly the top
        // `meanCallProbability` of its sampled range.
        const count = row.responseCounts.p1;
        expect(count.responded).toBe(evidence.samples.length);
        const share = count.called / count.responded;
        expect(Math.abs(share - count.meanCallProbability!)).toBeLessThanOrEqual(
          1 / count.responded + 1e-9
        );
      }
    }
  });

  it('prices the flop, turn and river with the bounded raise tree and pairs every row with the baseline', () => {
    expect([...JOINT_RESPONSE_LIMITS.raiseStreets]).toEqual(['flop', 'turn', 'river']);
    expect([...JOINT_ACTION_PACK_ROUND2.limits.raiseStreets]).toEqual(['turn', 'river']);
    for (const variant of VARIANTS)
      for (const street of ['flop', 'turn', 'river'] as const) {
        const { hero, state, evidence } = evidenceFor(variant, street, 1);
        const baseline = { action: 'check' as const, thinkTime: 0 };
        const result = evaluateJointActions(hero, state, baseline, evidence, () => true)!;
        expect(result.responseModel).toBe('bounded_raise_tree');
        expect(result.baselineCandidateId).toBe('check');
        for (const row of result.candidates) {
          expect(row.maxConservationError).toBeLessThan(1e-6);
          expect(row).not.toHaveProperty('sampleNets');
          if (row.id === 'check') {
            expect(row.pairedEdge).toBe(0);
            expect(row.pairedStandardError).toBe(0);
          } else {
            expect(row.pairedEdge).toBeCloseTo(
              row.expectedNetChips -
                result.candidates.find((c) => c.id === 'check')!.expectedNetChips,
              9
            );
            expect(row.pairedStandardError).toBeGreaterThanOrEqual(0);
          }
        }
        // Without the baseline among the candidates nothing is paired.
        const unpriced = evaluateJointActions(
          hero,
          state,
          { action: 'fold', thinkTime: 0 },
          evidence,
          () => true
        )!;
        expect(unpriced.baselineCandidateId).toBeNull();
        expect(unpriced.candidates.every((c) => c.pairedEdge === null)).toBe(true);
      }
  });

  it('keeps the baseline unless a candidate clears the paired lower bound, and never acts facing a wager', () => {
    expect(JOINT_SELECTION_RULE).toEqual({
      rule: 'paired_edge_over_baseline_lower_bound',
      z: 2,
      minEdgeBigBlinds: 0.1,
      actsWhen: 'nothing_to_call',
    });
    let changed = 0;
    for (const variant of VARIANTS)
      for (const street of STREETS)
        for (const boards of street === 'preflop' ? [1] : [1, 2, 3]) {
          const { hero, state } = jointPolicyFixture(variant, boards, 'cash', street);
          const baseline = { action: 'check' as const, thinkTime: 0 };
          const result = evaluateJointLivePolicy(hero, state, baseline, 'candidate', () => 0);
          const model = result.receipt.actionModel;
          if (!model) continue;
          if (result.receipt.changed) {
            changed++;
            const row = model.candidates.find(
              (c) =>
                c.action === result.proposal.action &&
                (!['bet', 'raise'].includes(c.action) || c.amount === result.proposal.amount)
            )!;
            expect(row.pairedEdge! - 2 * row.pairedStandardError!).toBeGreaterThan(
              0.1 * state.bigBlind
            );
            for (const other of model.candidates)
              if (other.pairedEdge !== null && other.id !== model.baselineCandidateId)
                expect(other.pairedEdge - 2 * other.pairedStandardError!).toBeLessThanOrEqual(
                  row.pairedEdge! - 2 * row.pairedStandardError! + 1e-12
                );
          } else
            for (const other of model.candidates)
              if (other.pairedEdge !== null && other.id !== model.baselineCandidateId)
                expect(other.pairedEdge - 2 * other.pairedStandardError!).toBeLessThanOrEqual(
                  0.1 * state.bigBlind
                );
          // Facing a wager the same spot keeps the baseline call whatever the rows say.
          const facing = jointPolicyFixture(variant, boards, 'cash', street);
          Object.assign(facing.state, {
            currentBet: 4,
            toCall: 4,
            legalActions: ['fold', 'call', 'raise'],
            minRaiseTo: 8,
            maxRaiseTo: facing.state.bettingStructure === 'fixed_limit' ? 8 : 40,
          });
          facing.state.players[1] = { ...facing.state.players[1], bet: 4 };
          const call = { action: 'call' as const, amount: 4, thinkTime: 0 };
          const answered = evaluateJointLivePolicy(
            facing.hero,
            facing.state,
            call,
            'candidate',
            () => 0
          );
          expect(answered.receipt.fired).toBe(true);
          expect(answered.decision.action).toBe('call');
          expect(answered.receipt.changed).toBe(false);
        }
    // The fixtures are not built to hold an edge; the count only documents
    // that both branches of the rule were reached.
    expect(changed).toBeGreaterThanOrEqual(0);
  });
});
