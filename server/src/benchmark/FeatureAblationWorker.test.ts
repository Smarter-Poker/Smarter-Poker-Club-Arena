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

it('counts each component only after its exact signed final controller action', async () => {
  const { acceptedIncrementalComponents } = await import('./FeatureAblationWorker.js');
  const { HORSE_POLICY_ORDER } = await import('../engine/HorsePolicyGraph.js');
  const components = [
    ['comboDrawPressure', 'combo_draw_pressure_raise', 'combo_draw_pressure_accepted', 'raise'],
    ['v54RiverBluff', 'v54_river_bluff', 'targeted_river_bluff_accepted', 'bet'],
    [
      'riverPositionDefense',
      'river_position_defense_call',
      'river_position_defense_accepted',
      'call',
    ],
    [
      'riverBluffCheckRaise',
      'river_bluff_checkraise_selected',
      'river_bluff_checkraise_accepted',
      'raise',
    ],
  ];
  for (const [flag, tag, counter, action] of components) {
    const selected = { action, amount: 8 };
    const issued: any = {
      ...selected,
      thinkTime: 0,
      policyGraph: {
        version: 'horse-policy-order-v3',
        finalAction: selected,
        transitions: HORSE_POLICY_ORDER.map((node, i) => ({
          node,
          before: i ? selected : null,
          after: selected,
          changed: false,
          elapsedMs: 0,
        })),
      },
    };
    const request: any = {
      opts: { [flag]: true },
      decisionKey: 'original-private-key',
      player: { seat: 2, user_id: 'hero', bet: 0, stack: 20 },
      gameState: { stage: 'river' },
    };
    const record: any = { seat: 2, userId: 'hero', stage: 'river', action, amount: 8 };
    const count = (d = issued, records = [record], submitted = d, tags = { [tag]: 1 }) =>
      acceptedIncrementalComponents(request, d, tags, submitted, records);
    expect(count()).toEqual([counter]);
    expect(count(issued, [])).toEqual([]);
    expect(count(issued, [{ ...record, amount: 9 }])).toEqual([]);
    expect(count(issued, [{ ...record, seat: 3 }])).toEqual([]);
    expect(count(issued, [{ ...record, stage: 'turn' }])).toEqual([]);
    expect(count(issued, [record, record])).toEqual([]);
    expect(count(issued, [record], { ...issued, action: 'fold' })).toEqual([]);
    expect(count(issued, [record], issued, {})).toEqual([]);
    const overwritten = structuredClone(issued);
    overwritten.action = 'fold';
    delete overwritten.amount;
    overwritten.policyGraph.finalAction = { action: 'fold', amount: null };
    for (const t of overwritten.policyGraph.transitions.slice(8))
      t.after = overwritten.policyGraph.finalAction;
    overwritten.policyGraph.transitions[9].before = overwritten.policyGraph.finalAction;
    expect(count(overwritten, [{ ...record, action: 'fold', amount: 0 }])).toEqual([]);
    const repriced = structuredClone(issued);
    repriced.policyGraph.transitions[0].after.amount = 7;
    expect(count(repriced)).toEqual([]);
    expect(count({ ...issued, policyGraph: undefined })).toEqual([]);
    const awayAndBack = structuredClone(issued);
    awayAndBack.policyGraph.transitions[8].after = { action: 'check', amount: null };
    awayAndBack.policyGraph.transitions[9].before = { action: 'check', amount: null };
    expect(count(awayAndBack)).toEqual([]);
    if (flag !== 'riverBluffCheckRaise') {
      const allIn = structuredClone(issued);
      allIn.action = 'all_in';
      delete allIn.amount;
      allIn.policyGraph.finalAction = { action: 'all_in', amount: null };
      for (const [i, t] of allIn.policyGraph.transitions.entries()) {
        t.after = allIn.policyGraph.finalAction;
        t.before = i ? allIn.policyGraph.finalAction : null;
      }
      expect(count(allIn, [{ ...record, action: 'all_in', amount: 20 }])).toEqual([counter]);
      expect(count(allIn, [{ ...record, action: 'all_in', amount: 19 }])).toEqual([]);
    }
  }
});

it('actual controller callback emits accepted coverage once, separately from selected telemetry', async () => {
  const { HorsePolicyGraph, HORSE_POLICY_ORDER } = await import('../engine/HorsePolicyGraph.js');
  const { noteFire, enableBrainTelemetry } = await import('../engine/BrainTelemetry.js');
  enableBrainTelemetry();
  const decide = vi
    .spyOn(defaultHorseDecisionWorkerDependencies, 'decide')
    .mockImplementation((p, gs) => {
      const graph = new HorsePolicyGraph();
      const value: any =
        gs.stage === 'river' && gs.legalActions?.includes('bet')
          ? { action: 'bet', amount: gs.minRaiseTo ?? 2, thinkTime: 0 }
          : {
              action: gs.legalActions?.includes('check') ? 'check' : 'call',
              amount: Math.min(p.stack, Math.max(0, gs.currentBet - p.bet)),
              thinkTime: 0,
            };
      if (value.action === 'bet') noteFire('v54_river_bluff');
      let last: any = null;
      for (const node of HORSE_POLICY_ORDER)
        last = graph.run(node, last, () => ({ decision: value })).decision;
      return graph.finish(last);
    });
  try {
    const brain = createFeatureAblationWorker(
      () => {},
      () => {},
      true,
      emptyHistory
    );
    const profile = workerProfile(brain, false);
    profile.ablation!.heroOpts = { v54RiverBluff: true };
    const hand = await playPlo4PolicyHand(profile, 393923, 2, 1, 'off', () => true, true);
    expect(hand.complete).toBe(true);
    expect(hand.illegalActions).toBe(0);
    expect(hand.ablationEvaluationFires?.hero.v54_river_bluff).toBe(1);
    expect(hand.ablationEvaluationFires?.hero.targeted_river_bluff_accepted).toBe(1);
    await brain.accepted?.({ action: 'bet', amount: 2, thinkTime: 0 }, []);
    expect(brain.takeEvaluationFires?.()).toEqual({});
  } finally {
    decide.mockRestore();
  }
}, 60000);
