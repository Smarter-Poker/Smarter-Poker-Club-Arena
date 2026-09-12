import { describe, expect, it } from 'vitest';
import type { Card, GameVariant } from '../../types.js';
import { horseVariantRulesFor } from '../VariantRules.js';
import { bettingStructureFor } from '../BettingStructure.js';
import { calculatePots } from '../PokerEngine.js';
import { saveFastRandom, seedFastRandom } from '../HorseEval.js';
import { jointFixture } from './JointRangeFixture.test-support.js';
import { evaluateJointLivePolicy } from './JointLivePolicy.js';

function fixture(variant: GameVariant = 'nlh', boards = 2, mode: 'cash' | 'tournament' = 'cash') {
  const { hero, state } = jointFixture(variant, 'flop', boards, 4);
  Object.assign(state, {
    stateSchemaVersion: 1,
    heroSeat: hero.seat,
    currentPlayerSeat: hero.seat,
    toCall: 0,
    legalActions: ['check', 'bet', 'all_in'],
    minRaiseTo: 2,
    maxRaiseTo: 100,
    bettingStructure: bettingStructureFor(variant),
    gameMode: mode,
    format: mode === 'cash' ? 'cash' : 'mtt',
    chipUnit: mode === 'cash' ? 0.01 : 1,
    asset: 'chips',
    rakeConfig: { percent: mode === 'cash' ? 10 : 0, cap: 2, noFlopNoDrop: true },
    bbjConfig: null,
    pots: calculatePots(state.players),
    variantRules: horseVariantRulesFor(variant),
  });
  if (state.bettingStructure === 'pot_limit') {
    state.legalActions = ['check', 'bet'];
    state.maxRaiseTo = 20;
  }
  if (state.bettingStructure === 'fixed_limit') {
    state.legalActions = ['check', 'bet'];
    state.maxRaiseTo = 2;
  }
  return { hero, state, baseline: { action: 'check' as const, thinkTime: 1 } };
}
describe('bounded Phase13 shadow policy', () => {
  it.each([
    'nlh',
    'plo4',
    'plo5',
    'plo6',
    'plo8',
    'flo8',
    'flh',
    'pineapple',
    'short_deck',
  ] as GameVariant[])(
    '%s evaluates ordinary multiway and bomb contexts in both available objectives',
    (variant) => {
      for (const boards of [1, 2, 3])
        for (const mode of ['cash', 'tournament'] as const) {
          const { hero, state, baseline } = fixture(variant, boards, mode);
          const result = evaluateJointLivePolicy(hero, state, baseline, 'shadow', () => 0);
          if (variant === 'pineapple' && mode === 'tournament') {
            expect(result.receipt.reason).toBe('pineapple_tournament_unavailable');
            continue;
          }
          expect(result.receipt.fired, result.receipt.reason).toBe(true);
          expect(result.receipt.applied).toBe(false);
          expect(result.decision).toBe(baseline);
          expect(result.receipt.actionModel!.candidates.length).toBeGreaterThan(1);
          expect(result.receipt.completedSamples).toBeGreaterThanOrEqual(8);
          expect(result.receipt.callDistribution!.covariance).toHaveLength(boards);
          expect(result.receipt.utilityOwner).toBe(
            mode === 'tournament' ? 'phase7_pending' : 'cash'
          );
          expect(result.receipt.stateKey).toMatch(/^phase5-v1:/);
        }
    }
  );
  it('proposes a legal value action and preserves the live baseline in shadow', () => {
    const { hero, state, baseline } = fixture('nlh', 1);
    hero.cards = [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'spades' },
    ];
    state.communityCards = [...'QJT'].map((rank) => ({ rank, suit: 'spades' }) as Card);
    seedFastRandom(13111501);
    const before = saveFastRandom();
    const shadow = evaluateJointLivePolicy(hero, state, baseline, 'shadow', () => 0);
    expect(shadow.receipt.fired).toBe(true);
    expect(shadow.receipt.changed).toBe(true);
    expect(state.legalActions).toContain(shadow.proposal.action);
    expect(shadow.decision).toEqual(baseline);
    expect(saveFastRandom()).toBe(before);
    const candidate = evaluateJointLivePolicy(hero, state, baseline, 'candidate', () => 0);
    expect(candidate.proposal).toEqual(shadow.proposal);
    expect(candidate.receipt.applied).toBe(true);
  });
  it('keeps all-in disconnected opponents in the joint sample and side-pot calculation', () => {
    const { hero, state, baseline } = fixture();
    state.players[1].stack = 0;
    state.players[1].is_all_in = true;
    state.players[1].is_sitting_out = true;
    const result = evaluateJointLivePolicy(hero, state, baseline, 'shadow', () => 0);
    expect(result.receipt.fired, result.receipt.reason).toBe(true);
    expect(result.jointEvidence?.opponentIds).toContain('p1');
    expect(result.receipt.ranges.find((r) => r.userId === 'p1')).toMatchObject({
      allIn: true,
      live: true,
    });
  });
  it('does no sampling when disabled and retains the baseline after time expires', () => {
    const { hero, state, baseline } = fixture();
    const off = evaluateJointLivePolicy(hero, state, baseline, 'off', () => 0);
    expect(off.receipt.reason).toBe('off');
    expect(off.receipt.completedSamples).toBe(0);
    let clock = 0;
    const expired = evaluateJointLivePolicy(hero, state, baseline, 'candidate', () => (clock += 5));
    expect(expired.receipt.reason).toBe('work_budget');
    expect(expired.receipt.fired).toBe(false);
    expect(expired.decision).toBe(baseline);
  });
  it.each([
    ['privacy', 'private_state_rejected'],
    ['missing_unit', 'chip_rules_unavailable'],
    ['missing_dealt', 'dealt_census_unavailable'],
    ['missing_fees', 'deductions_unavailable'],
    ['bad_units', 'invalid_chip_geometry'],
    ['depth', 'depth_outside_domain'],
    ['bad_board', 'joint_samples_unavailable'],
    ['bad_betting', 'canonical_state_unavailable'],
    ['discard', 'discard_owned_by_worker'],
    ['preflop_bomb', 'bomb_hand_has_no_preflop_decision'],
    ['diamond_variant', 'diamond_variant_unavailable'],
  ])('names the %s boundary', (fault, reason) => {
    const { hero, state, baseline } = fixture();
    if (fault === 'privacy') state.players[1].cards = hero.cards;
    if (fault === 'missing_unit') delete state.chipUnit;
    if (fault === 'missing_dealt') delete state.dealtSeatIds;
    if (fault === 'missing_fees') delete state.bbjConfig;
    if (fault === 'bad_units') state.players[1].stack = 1.001;
    if (fault === 'depth') {
      hero.stack = 1000;
      state.players.forEach((p) => (p.stack = 1000));
    }
    if (fault === 'bad_board') state.communityCards2![0] = hero.cards[0];
    if (fault === 'bad_betting') state.bettingStructure = 'fixed_limit';
    if (fault === 'discard') state.stage = 'pineapple_discard';
    if (fault === 'preflop_bomb') state.stage = 'preflop';
    if (fault === 'diamond_variant') {
      state.asset = 'diamonds';
      state.chipUnit = 1;
      state.gameVariant = 'short_deck';
    }
    const result = evaluateJointLivePolicy(hero, state, baseline, 'candidate', () => 0);
    expect(result.receipt.reason).toBe(reason);
    expect(result.receipt.fired).toBe(false);
    expect(result.decision).toBe(baseline);
  });
  it('accepts whole-Diamond NLH bomb decisions with zero deductions', () => {
    const { hero, state, baseline } = fixture();
    state.asset = 'diamonds';
    state.chipUnit = 1;
    state.rakeConfig!.percent = 0;
    state.rakeConfig!.cap = 0;
    const result = evaluateJointLivePolicy(hero, state, baseline, 'shadow', () => 0);
    expect(result.receipt.fired, result.receipt.reason).toBe(true);
    expect(
      result.receipt.actionModel!.candidates.every(
        (c) => c.expectedRake === 0 && c.expectedBbj === 0
      )
    ).toBe(true);
  });
});
