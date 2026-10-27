import { describe, expect, it, vi } from 'vitest';
import { wager } from '../testing/horseRegression/plan/fixture.js';
import {
  createFeatureAblationWorker,
  validateFeatureAblationPlanAck,
  type FeatureAblationWorkerReceipt,
} from './FeatureAblationWorker.js';
import { getFullRakeConfig } from '../config/RakeConfig.js';
import {
  playPlo4PolicyHand,
  type Plo4AblationBrain,
  type Plo4LeagueProfile,
} from './Plo4PolicyLeague.js';
import { HorseMind } from '../engine/HorseMind.js';
import { horsePlanHandKey } from '../engine/HorseDecisionEffects.js';
import { defaultHorseDecisionWorkerDependencies } from '../engine/horseDecision/workerRuntime.js';
import { saveFastRandom, seedFastRandom } from '../engine/HorseEval.js';
import { makeFeatureAblationOwnHistory } from './FeatureAblationHistory.js';
import { horseObserverReadContextFromRequest } from '../engine/HorseObserverReadContext.js';
import type { FastHorseDecisionRequest } from '../engine/horseDecision/protocol.js';
const emptyHistory = (r: FastHorseDecisionRequest) => {
  const context = horseObserverReadContextFromRequest(r);
  if (!context) throw Error('Expected actual public observer coordinate');
  return makeFeatureAblationOwnHistory(context, r.player.seat, []);
};
function workerProfile(brain: Plo4AblationBrain, flag: boolean): Plo4LeagueProfile {
  const full = getFullRakeConfig(1, 2, 'plo6');
  return {
    id: 'worker-smoke',
    variant: 'plo6',
    seats: 2,
    tableSeats: 6,
    stackBB: 40,
    rakePercent: full.rakePercent,
    rakeCapBB: full.rakeCap / 2,
    anteBB: 0,
    straddle: false,
    tournament: false,
    opponentStyle: 'balanced',
    publishedRake: true,
    productionStyles: true,
    moodClock: 'deal_seed_time_of_day',
    ablation: { brain, heroOpts: { v24PloDefense: flag } },
  };
}
describe('offline actual current worker adapter', () => {
  it('keeps real admissions and controlled initial stream distinct from natural keys', async () => {
    const receipts: FeatureAblationWorkerReceipt[] = [];
    const brain = createFeatureAblationWorker(
      (r) => receipts.push(r),
      () => {},
      false,
      emptyHistory
    );
    const full = getFullRakeConfig(1, 2, 'plo6');
    seedFastRandom(393923);
    const before = saveFastRandom();
    const hand = await playPlo4PolicyHand(
      workerProfile(brain, false),
      393923,
      2,
      1,
      'off',
      () => true,
      true
    );
    expect(hand.complete).toBe(true);
    expect(hand.illegalActions).toBe(0);
    expect(receipts.length).toBeGreaterThan(0);
    expect(saveFastRandom()).toBe(before);
    expect(receipts.every((r) => r.restoredCanonical && r.controlledRngBefore > 0)).toBe(true);
    expect(receipts.every((r) => r.phase11Authority?.plo6)).toBe(true);
    expect(
      receipts.every(
        (r) =>
          r.observerReads?.history === 'own_public_window' && r.observerReads.historyHands === 0
      )
    ).toBe(true);
    const first = receipts.find((r) => r.actorSeat === 1)!;
    const other: FeatureAblationWorkerReceipt[] = [];
    const candidateBrain = createFeatureAblationWorker(
      (r) => other.push(r),
      () => {},
      false,
      emptyHistory
    );
    await playPlo4PolicyHand(
      workerProfile(candidateBrain, true),
      393923,
      2,
      1,
      'off',
      () => true,
      true
    );
    const second = other.find((r) => r.actorSeat === 1)!;
    expect(first.inputFlags.v24PloDefense).toBe(false);
    expect(second.inputFlags.v24PloDefense).toBe(true);
    expect(first.decisionKey).not.toBe(second.decisionKey);
    expect(first.naturalSamplingKey).not.toBe(second.naturalSamplingKey);
    expect(first.naturalRngBefore).not.toBe(second.naturalRngBefore);
    expect(first.controlledRngBefore).toBe(second.controlledRngBefore);
    expect(saveFastRandom()).toBe(before);
  }, 60000);
});

it('commits only the actual controller-accepted issued effects in the same private read view', async () => {
  const resolved: string[] = [];
  let applied = 0;
  const originalApply = defaultHorseDecisionWorkerDependencies.applyDecisionEffects;
  const decide = vi
    .spyOn(defaultHorseDecisionWorkerDependencies, 'decide')
    .mockImplementation((p, gs, _style, _mods, opts) => {
      if (gs.stage !== 'preflop' && gs.legalActions?.includes('bet')) {
        const key = horsePlanHandKey(gs.actionHistory, opts?.mindPlanContext);
        expect(key).not.toBeNull();
        HorseMind.noteRaisePlan(key, p.user_id, gs.stage, 'foldToRaise');
        return wager('bet', gs.minRaiseTo ?? 2);
      }
      return {
        action: gs.legalActions?.includes('check') ? 'check' : 'call',
        amount: Math.min(p.stack, Math.max(0, gs.currentBet - p.bet)),
        thinkTime: 0,
      };
    });
  const apply = vi
    .spyOn(defaultHorseDecisionWorkerDependencies, 'applyDecisionEffects')
    .mockImplementation((effects) => {
      originalApply(effects);
      for (const effect of effects)
        if (effect.type === 'raise_plan') {
          expect(HorseMind.getRaisePlan(effect.handKey, effect.userId, effect.street)).toBe(
            'foldToRaise'
          );
          applied++;
        }
    });
  try {
    const full = getFullRakeConfig(1, 2, 'plo6');
    const brain = createFeatureAblationWorker(
      () => {},
      (d) => resolved.push(d)
    );
    const hand = await playPlo4PolicyHand(
      {
        id: 'accepted-effect-plumbing',
        variant: 'plo6',
        seats: 2,
        tableSeats: 6,
        stackBB: 40,
        rakePercent: full.rakePercent,
        rakeCapBB: full.rakeCap / 2,
        anteBB: 0,
        straddle: false,
        tournament: false,
        opponentStyle: 'balanced',
        publishedRake: true,
        ablation: { brain, heroOpts: { v24PloDefense: false } },
      },
      393923,
      2,
      1,
      'off',
      () => true,
      true
    );
    expect(hand.complete).toBe(true);
    expect(applied).toBeGreaterThan(0);
    expect(resolved.length).toBe(applied);
    expect(resolved.every((d) => d === 'applied_volatile')).toBe(true);
  } finally {
    decide.mockRestore();
    apply.mockRestore();
  }
}, 60000);

it('accepts only the original exact commit/retire ACK and successful disposition', () => {
  const expected = {
    requestId: 9,
    generation: 3,
    fence: 'physical-hand-turn',
    operation: 'COMMIT_DECISION_EFFECTS' as const,
  };
  const ack = { type: 'ACK' as const, ...expected, planDisposition: 'applied_volatile' as const };
  expect(validateFeatureAblationPlanAck(ack, expected)).toBe('applied_volatile');
  expect(() => validateFeatureAblationPlanAck({ ...ack, requestId: 10 }, expected)).toThrow(
    'identity'
  );
  expect(() => validateFeatureAblationPlanAck({ ...ack, fence: 'other' }, expected)).toThrow(
    'identity'
  );
  expect(() =>
    validateFeatureAblationPlanAck({ ...ack, operation: 'RETIRE_DECISION_EFFECTS' }, expected)
  ).toThrow('identity');
  expect(() =>
    validateFeatureAblationPlanAck({ ...ack, planDisposition: 'issue_absent' }, expected)
  ).toThrow('refused');
});

it('retains loaded public history after accepted plans on the exact failed PLO6 physical deal', async () => {
  const wallClock = Date.now;
  const { hydrateFrozenFeatureAblationStores } = await import('./FeatureAblationStores.js');
  const { plo6V24DevelopmentProfile } = await import('./Plo6V24Qualification.js');
  await hydrateFrozenFeatureAblationStores();
  let applied = 0;
  const brain = createFeatureAblationWorker(
    () => {},
    (disposition, count) => {
      if (disposition === 'applied_volatile') applied += count;
    },
    false,
    emptyHistory
  );
  const profile = plo6V24DevelopmentProfile('plo6-v24-two-dealt-100bb');
  // Original failing physical deal, pinned independently of experiment sampler.
  // Previously derived from seed24304111/index1 under the old unsalted sampler.
  for (const flag of [true, false]) {
    const hand = await playPlo4PolicyHand(
      { ...profile, ablation: { brain, heroOpts: { v24PloDefense: flag } } },
      1025256077,
      1,
      2,
      'off',
      () => true,
      true
    );
    expect(hand.complete).toBe(true);
    expect(hand.illegalActions).toBe(0);
  }
  expect(applied).toBeGreaterThan(0);
  expect(Date.now).toBe(wallClock);
}, 60000);
