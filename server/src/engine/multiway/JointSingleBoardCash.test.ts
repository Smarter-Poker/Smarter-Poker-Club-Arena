import { describe, expect, it } from 'vitest';
import type { GameVariant } from '../../types.js';
import { KNOWN_VARIANTS } from '../VariantRules.js';
import { jointPolicyFixture } from './JointRangeFixture.test-support.js';
import { jointSingleBoardCashActs } from './JointActionModel.js';
import { evaluateJointLivePolicy } from './JointLivePolicy.js';

const VARIANTS = KNOWN_VARIANTS as readonly GameVariant[];
const STREETS = ['preflop', 'flop', 'turn', 'river'] as const;

describe('single-board cash stays with the variant brain where it beats the joint owner', () => {
  it('keeps NLH and PLO4, the two variants whose matrices lost on one board', () => {
    expect(VARIANTS.filter((v) => !jointSingleBoardCashActs(v)).sort()).toEqual(['nlh', 'plo4']);
  });

  it('keeps the baseline on one board in cash, and can still change two and three boards and tournaments', () => {
    let kept = 0;
    let priced = 0;
    for (const variant of VARIANTS)
      for (const street of STREETS)
        for (const boards of street === 'preflop' ? [1] : [1, 2, 3])
          for (const mode of ['cash', 'tournament'] as const) {
            let fixture;
            try {
              fixture = jointPolicyFixture(variant, boards, mode, street);
            } catch {
              continue;
            }
            const { hero, state } = fixture;
            const baseline = { action: 'check' as const, thinkTime: 0 };
            const { decision, receipt } = evaluateJointLivePolicy(
              hero,
              state,
              baseline,
              'candidate',
              () => 0
            );
            if (!receipt.eligible) continue;
            if (mode === 'cash' && boards === 1 && !jointSingleBoardCashActs(variant)) {
              expect(receipt.fired).toBe(true);
              expect(receipt.changed).toBe(false);
              expect(receipt.applied).toBe(false);
              expect(decision).toEqual(baseline);
              kept++;
            } else {
              if (receipt.changed) priced++;
            }
          }
    expect(kept).toBeGreaterThan(0);
    expect(priced).toBeGreaterThan(0);
  });
});
