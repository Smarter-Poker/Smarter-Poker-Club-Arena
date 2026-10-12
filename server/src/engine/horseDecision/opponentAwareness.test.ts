import { afterEach, expect, it, vi } from 'vitest';
import { HandController } from '../HandController.js';
import { HorseMind, readScopeOf } from '../HorseMind.js';
import { defaultHorseDecisionWorkerDependencies as defaults, HorseDecisionWorkerRuntime } from './workerRuntime.js';
import type { HorseDecisionWorkerResponse } from './protocol.js';
import type { ActionRecord, HandConfig, SeatPlayer } from '../../types.js';
import { controllerDecisionState } from '../remainingVariants/RemainingVariantControllerSpots.test-support.js';
import { buildHorseDecisionKey } from './protocol.js';
import { captureHorseHandJournalContext } from '../HorseDecisionHandBinding.js';
import { decodeHorseDecisionReads, type HorseDecisionReadFrame } from '../HorseDecisionReadFrame.js';
import { applyTableCommitmentCap } from '../ServerTableEngineTurns.js';
import type { HorsePlanContext } from '../HorsePlanHandIdentity.js';

const table = '10000000-0000-4000-8000-000000000001';
const opponent = '20000000-0000-4000-8000-000000000001';
const hero = '20000000-0000-4000-8000-000000000002';
afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});

it.each(['open', 'limp_reraise'] as const)('learns a controller accepted %s as both VPIP and PFR through the worker', async (line) => {
  HorseMind.reset();
  const messages: HorseDecisionWorkerResponse[] = [];
  const worker = new HorseDecisionWorkerRuntime((m) => messages.push(m), {
    ...defaults,
    startServices: async () => defaults.workerReadiness(),
    stopServices: async () => {},
    journalEnabled: () => false,
    journalAcceptedHand: () => {},
    journalLifecycle: () => {},
    admitPhase8Authority: undefined,
    admitPhase10Authority: undefined,
    admitPhase11Authority: undefined,
    admitPhase12Authority: undefined,
    admitPhase13Authority: undefined,
    noteFeature: () => {},
    noteDecision: () => {},
  });
  await worker.start();
  let lastActions: ActionRecord[] = [];
  let lastPlayers: SeatPlayer[] = [];
  for (let h = 0; h < 30; h++) {
    const handNumber = 1000000 + h;
    const config: HandConfig = { tableId: table, handNumber, gameVariant: 'flh', smallBlind: 1, bigBlind: 2, isTournament: false, rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true } };
    const players = [opponent, hero].map((user_id, i) => ({ seat: i + 1, user_id, username: `Actor ${i + 1}`, stack: 100, bet: 0, totalInvested: 0, cards: [], is_folded: false, is_all_in: false, is_sitting_out: false })) as SeatPlayer[];
    const controller = new HandController(config, players, 1);
    controller.start();
    expect(controller.getState().currentPlayerSeat).toBe(1);
    if (line === 'limp_reraise') {
      expect(controller.performAction(1, 'call')).toBe(true);
      const raise = controller.getAuthoritativeActionState(hero)!;
      expect(controller.performAction(2, 'raise', raise.minRaiseTo!)).toBe(true);
    }
    const raise = controller.getAuthoritativeActionState(opponent)!;
    expect(controller.performAction(1, 'raise', raise.minRaiseTo!)).toBe(true);
    expect(controller.performAction(2, 'fold')).toBe(true);
    lastActions = controller.getState().actionHistory;
    lastPlayers = controller.getState().players;
    const observation = { type: 'OBSERVE_COMPLETED_HAND' as const, requestId: h * 2 + 1, generation: handNumber, fence: `${table}:${handNumber}:9:observe`, handKey: `${table}:${handNumber}`, committedHandId: `30000000-0000-4000-8000-${String(h + 1).padStart(12, '0')}`, actions: lastActions, bigBlind: 2, showdown: null, scope: readScopeOf('flh', 2) };
    worker.receive(observation);
    worker.receive({ ...observation, requestId: h * 2 + 2 });
    await worker.drain();
    expect(messages.at(-1)).toMatchObject({ type: 'ACK', operation: 'OBSERVE_COMPLETED_HAND' });
  }
  expect(HorseMind.getStats(opponent)).toMatchObject({ hands: 30, vpip: 30, pfr: 30, threeBet: line === 'limp_reraise' ? 30 : 0 });
  const scoped = HorseMind.snapshotDecisionReads(lastPlayers, null).scoped.get(`${readScopeOf('flh', 2)}|${opponent}`);
  expect(scoped).toMatchObject({ hands: 30, vpip: 30, pfr: 30 });
  HorseMind.setDecisionScope(readScopeOf('flh', 2));
  const learned = HorseMind.bandFor(opponent, lastActions, 2, false);
  HorseMind.reset();
  const prior = HorseMind.bandFor(opponent, lastActions, 2, false);
  expect(learned).not.toBeNull();
  expect(learned![0]).toBeCloseTo(prior![0] - 0.1, 10);
});

it('a 100% preflop raiser and postflop pot bettor reaches the actual FAST range, exploit and read frame', async () => {
  HorseMind.reset();
  const messages: HorseDecisionWorkerResponse[] = [];
  type Capture = { readFrame: HorseDecisionReadFrame | null; planContext: HorsePlanContext };
  const captures: Capture[] = [];
  const worker = new HorseDecisionWorkerRuntime((m) => messages.push(m), {
    ...defaults,
    startServices: async () => defaults.workerReadiness(),
    stopServices: async () => {},
    journalEnabled: () => true,
    journalDecision: (_request, captured) => { captures.push(captured as Capture); },
    journalAcceptedHand: () => {},
    journalLifecycle: () => {},
    sourceRelease: () => null,
    admitPhase8Authority: undefined,
    admitPhase10Authority: undefined,
    admitPhase11Authority: undefined,
    admitPhase12Authority: undefined,
    admitPhase13Authority: undefined,
    noteFeature: () => {},
    noteDecision: () => {},
  });
  await worker.start();
  const makeHand = (handNumber: number) => {
    const config: HandConfig = {
      tableId: table, handNumber, gameVariant: 'nlh', smallBlind: 1,
      bigBlind: 2, isTournament: false,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    };
    const players = [opponent, hero].map((user_id, i) => ({
      seat: i + 1, user_id, username: `Actor ${i + 1}`, stack: 1000,
      bet: 0, totalInvested: 0, cards: [], is_folded: false,
      is_all_in: false, is_sitting_out: false,
    })) as SeatPlayer[];
    const controller = new HandController(config, players, 1);
    controller.start();
    expect(controller.performAction(1, 'raise', 6)).toBe(true);
    expect(controller.performAction(2, 'call')).toBe(true);
    return { controller, config };
  };
  for (let h = 0; h < 30; h++) {
    const handNumber = 1000100 + h;
    const { controller } = makeHand(handNumber);
    for (const stage of ['flop', 'turn', 'river']) {
      expect(controller.getState().stage).toBe(stage);
      expect(controller.performAction(2, 'check')).toBe(true);
      const pot = controller.getState().pot;
      expect(controller.performAction(1, 'bet', pot)).toBe(true);
      expect(controller.performAction(2, stage === 'river' ? 'fold' : 'call')).toBe(true);
    }
    worker.receive({
      type: 'OBSERVE_COMPLETED_HAND', requestId: h + 1,
      generation: handNumber, fence: `${table}:${handNumber}:9:observe`,
      handKey: `${table}:${handNumber}`,
      committedHandId: `30000000-0000-4000-8000-${String(h + 101).padStart(12, '0')}`,
      actions: controller.getState().actionHistory, bigBlind: 2,
      showdown: null, scope: readScopeOf('nlh', 2),
    });
    await worker.drain();
    expect(messages.at(-1)).toMatchObject({ type: 'ACK', operation: 'OBSERVE_COMPLETED_HAND' });
  }
  const { controller, config } = makeHand(1000130);
  expect(controller.performAction(2, 'check')).toBe(true);
  expect(controller.performAction(1, 'bet', controller.getState().pot)).toBe(true);
  // This is the real controller menu/public-state builder already used by
  // the maintained joint-variant controller harness, including NLH.
  const spot = controllerDecisionState(controller, 'nlh' as never, 'cash', config)!;
  expect(spot.hero.user_id).toBe(hero);
  spot.state.commitmentCapRemaining = applyTableCommitmentCap(
    controller.getAuthoritativeActionState(hero)!, spot.hero, false, 0, 2
  ).commitmentCapRemaining;
  const range = vi.spyOn(HorseMind, 'bandFor');
  const exploit = vi.spyOn(HorseMind, 'exploit');
  const request = {
    type: 'DECIDE_FAST' as const, requestId: 100, generation: 1,
    fence: `${table}:1000130:2:9:1`, decisionKey: '',
    decisionTimeMs: 1700000000000, player: spot.hero, gameState: spot.state,
    style: 'balanced' as const, mods: {},
    handJournalContext: captureHorseHandJournalContext(spot.state.actionHistory!),
  };
  request.decisionKey = buildHorseDecisionKey(request);
  worker.receive(request);
  await worker.drain();
  const result = messages.find((m) => m.type === 'FAST_RESULT');
  expect(result?.type, JSON.stringify(messages.at(-1))).toBe('FAST_RESULT');
  if (!result || result.type !== 'FAST_RESULT') throw Error('FAST did not return a decision');
  expect(result.decision.policyFallback).not.toBe('brain_exception');
  expect(spot.state.legalActions).toContain(result.decision.action);
  expect(captures).toHaveLength(1);
  const captured = captures[0]!;
  expect(captured.readFrame).not.toBeNull();
  const view = decodeHorseDecisionReads(captured.readFrame!, spot.state.players,
    JSON.parse(captured.readFrame!.json).handKey, captured.planContext);
  expect(view.scoped.get(`${readScopeOf('nlh', 2)}|${opponent}`)).toMatchObject({
    hands: 31, vpip: 31, pfr: 31, postAggr: 91, postPassive: 0,
  });
  const ranges = range.mock.calls.flatMap((call, i) => call[0] === opponent
    ? [{ call, value: range.mock.results[i]!.value }] : []);
  expect(ranges.length).toBeGreaterThan(0);
  const exploits = exploit.mock.calls.flatMap((call, i) => call[0] === opponent
    ? [exploit.mock.results[i]!.value] : []);
  expect(exploits.length).toBeGreaterThan(0);
  expect(exploits.some((read) => read.callDownMod === 1.2)).toBe(true);
  vi.restoreAllMocks();
  HorseMind.reset();
  for (const { call, value } of ranges) {
    const prior = HorseMind.bandFor(...call);
    expect(value).not.toBeNull();
    expect(value[0]).toBeCloseTo(prior![0] - 0.1, 10);
  }
});
