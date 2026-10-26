import {
  registerPublicObserver,
  inspectObserverReads,
} from '../../testing/horseRegression/plan/fixture.js';
import { afterEach, expect, it, vi } from 'vitest';
import { HandController } from '../HandController.js';
import { HorseMind, readScopeOf } from '../HorseMind.js';
import {
  maniacRaiseWidth,
  openerRangeWidth,
  reRaiseWidth,
  strengthBarForTopShare,
} from '../HorseOpponentExploit.js';
import {
  defaultHorseDecisionWorkerDependencies as defaults,
  HorseDecisionWorkerRuntime,
} from './workerRuntime.js';
import type { HorseDecisionWorkerResponse } from './protocol.js';
import type { ActionRecord, HandConfig, SeatPlayer } from '../../types.js';
import { controllerDecisionState } from '../remainingVariants/RemainingVariantControllerSpots.test-support.js';
import { buildHorseDecisionKey } from './protocol.js';
import { captureHorseHandJournalContext } from '../HorseDecisionHandBinding.js';
import {
  decodeHorseDecisionReads,
  type HorseDecisionReadFrame,
} from '../HorseDecisionReadFrame.js';
import { applyTableCommitmentCap } from '../ServerTableEngineTurns.js';
import type { HorsePlanContext } from '../HorsePlanHandIdentity.js';

const table = '10000000-0000-4000-8000-000000000001';
const opponent = '20000000-0000-4000-8000-000000000001';
const hero = '20000000-0000-4000-8000-000000000002';
afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});

it.each(['open', 'limp_reraise'] as const)(
  'learns a controller accepted %s as both VPIP and PFR through the worker',
  async (line) => {
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
    let admitted: Awaited<ReturnType<typeof registerPublicObserver>>;
    let lastActions: ActionRecord[] = [];
    let lastPlayers: SeatPlayer[] = [];
    for (let h = 0; h < 30; h++) {
      const handNumber = 1000000 + h;
      const config: HandConfig = {
        tableId: table,
        handNumber,
        gameVariant: 'flh',
        smallBlind: 1,
        bigBlind: 2,
        isTournament: false,
        rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      };
      const players = [opponent, hero].map((user_id, i) => ({
        seat: i + 1,
        user_id,
        username: `Actor ${i + 1}`,
        stack: 100,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      })) as SeatPlayer[];
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
      const observation = {
        type: 'OBSERVE_COMPLETED_HAND' as const,
        requestId: h * 2 + 1,
        generation: handNumber,
        fence: `${table}:${handNumber}:9:observe`,
        handKey: `${table}:${handNumber}`,
        committedHandId: `30000000-0000-4000-8000-${String(h + 1).padStart(12, '0')}`,
        actions: lastActions,
        bigBlind: 2,
        showdown: null,
        scope: readScopeOf('flh', 2),
      };
      admitted = await registerPublicObserver(worker, observation, hero, lastPlayers, 'flh');
      worker.receive(observation);
      worker.receive({ ...observation, requestId: h * 2 + 2 });
      await worker.drain();
      expect(messages.at(-1)).toMatchObject({ type: 'ACK', operation: 'OBSERVE_COMPLETED_HAND' });
    }
    expect(HorseMind.getStats(opponent)).toBeUndefined();
    inspectObserverReads(worker, admitted!, () => {
      expect(HorseMind.getStats(opponent)).toMatchObject({
        hands: 30,
        vpip: 30,
        pfr: 30,
        threeBet: line === 'limp_reraise' ? 30 : 0,
      });
      const scoped = HorseMind.snapshotDecisionReads(lastPlayers, null).scoped.get(
        `${readScopeOf('flh', 2)}|${opponent}`
      );
      expect(scoped).toMatchObject({ hands: 30, vpip: 30, pfr: 30 });
      HorseMind.setDecisionScope(readScopeOf('flh', 2), 'flh');
      const learned = HorseMind.bandFor(opponent, lastActions, 2, false);
      // 2026-10-16 OPPONENT EXPLOIT: thirty straight raises are credibly outside
      // the horse envelope, so the raiser's own measured width replaces the
      // seat band (and the lifetime -0.1 PFR widening that read it).
      const read = HorseMind.opponentRead(opponent);
      expect(read).not.toBeNull();
      // 2026-10-22 MANIAC PRESSURE: a re-raise from a maniac is read at its
      // whole raising width, not its 3-bet statistic alone.
      const width =
        line === 'open' ? openerRangeWidth(read) : (maniacRaiseWidth(read) ?? reRaiseWidth(read));
      const legacy = (() => {
        const real = HorseMind.opponentRead;
        (HorseMind as unknown as { opponentRead: () => null }).opponentRead = () => null;
        try {
          return HorseMind.bandFor(opponent, lastActions, 2, false);
        } finally {
          (HorseMind as unknown as { opponentRead: typeof real }).opponentRead = real;
        }
      })();
      HorseMind.reset();
      const prior = HorseMind.bandFor(opponent, lastActions, 2, false);
      expect(learned).not.toBeNull();
      // Without the read the lifetime widening still applies, exactly as before.
      expect(legacy![0]).toBeCloseTo(prior![0] - 0.1, 10);
      if (width === null) expect(learned![0]).toBeCloseTo(prior![0] - 0.1, 10);
      else {
        // A width is a share of hands; a hold'em band is a score bar
        // (2026-10-22: `1 - width` read a 100% raiser as a top-60% range).
        expect(learned![0]).toBeCloseTo(
          Math.max(0, Math.min(0.9, strengthBarForTopShare(width))),
          10
        );
        expect(learned![0]).toBeLessThan(legacy![0]);
      }
    });
  }
);

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
    journalDecision: (_request, captured) => {
      captures.push(captured as Capture);
    },
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
  // Establish a contrasting pooled prior from another variant scope.
  // The actual FAST accessor must choose its >=40-hand Holdem scope.
  for (let h = 0; h < 160; h++) {
    HorseMind.setDecisionScope(readScopeOf('plo4', 2));
    HorseMind.observe(
      [
        {
          seat: 1,
          userId: opponent,
          action: 'fold',
          amount: 0,
          timestamp: 1700000000000 + h,
          stage: 'preflop',
        },
      ],
      [],
      { version: 1, tableId: table, handNumber: 1000500 + h }
    );
  }
  HorseMind.setDecisionScope(null);
  const makeHand = (handNumber: number) => {
    const config: HandConfig = {
      tableId: table,
      handNumber,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      isTournament: false,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    };
    const players = [opponent, hero].map((user_id, i) => ({
      seat: i + 1,
      user_id,
      username: `Actor ${i + 1}`,
      stack: 1000,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    })) as SeatPlayer[];
    const controller = new HandController(config, players, 1);
    controller.start();
    expect(controller.performAction(1, 'raise', 6)).toBe(true);
    expect(controller.performAction(2, 'call')).toBe(true);
    return { controller, config };
  };
  for (let h = 0; h < 40; h++) {
    const handNumber = 1000100 + h;
    const { controller } = makeHand(handNumber);
    for (const stage of ['flop', 'turn', 'river']) {
      expect(controller.getState().stage).toBe(stage);
      expect(controller.performAction(2, 'check')).toBe(true);
      const pot = controller.getState().pot;
      expect(controller.performAction(1, 'bet', pot)).toBe(true);
      expect(controller.performAction(2, stage === 'river' ? 'fold' : 'call')).toBe(true);
    }
    const completed = {
      type: 'OBSERVE_COMPLETED_HAND' as const,
      requestId: h + 1,
      generation: handNumber,
      fence: `${table}:${handNumber}:9:observe`,
      handKey: `${table}:${handNumber}`,
      committedHandId: `30000000-0000-4000-8000-${String(h + 101).padStart(12, '0')}`,
      actions: controller.getState().actionHistory,
      bigBlind: 2,
      showdown: null,
      scope: readScopeOf('nlh', 2),
    };
    await registerPublicObserver(worker, completed, hero, controller.getState().players);
    worker.receive(completed);
    await worker.drain();
    expect(messages.at(-1)).toMatchObject({ type: 'ACK', operation: 'OBSERVE_COMPLETED_HAND' });
  }
  const { controller, config } = makeHand(1000140);
  expect(controller.performAction(2, 'check')).toBe(true);
  expect(controller.performAction(1, 'bet', controller.getState().pot)).toBe(true);
  // This is the real controller menu/public-state builder already used by
  // the maintained joint-variant controller harness, including NLH.
  const spot = controllerDecisionState(controller, 'nlh' as never, 'cash', config)!;
  expect(spot.hero.user_id).toBe(hero);
  spot.state.commitmentCapRemaining = applyTableCommitmentCap(
    controller.getAuthoritativeActionState(hero)!,
    spot.hero,
    false,
    0,
    2
  ).commitmentCapRemaining;
  captures.length = 0;
  messages.length = 0;
  const range = vi.spyOn(HorseMind, 'bandFor');
  const exploit = vi.spyOn(HorseMind, 'exploit');
  const request = {
    type: 'DECIDE_FAST' as const,
    requestId: 100,
    generation: 1,
    fence: `${table}:1000140:2:9:1`,
    decisionKey: '',
    decisionTimeMs: Date.now() + 10000,
    player: spot.hero,
    gameState: spot.state,
    style: 'balanced' as const,
    mods: {},
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
  const view = decodeHorseDecisionReads(
    captured.readFrame!,
    spot.state.players,
    JSON.parse(captured.readFrame!.json).handKey,
    captured.planContext
  );
  expect(view.scoped.get(`${readScopeOf('nlh', 2)}|${opponent}`)).toMatchObject({
    hands: 41,
    vpip: 41,
    pfr: 41,
    postAggr: 121,
    postPassive: 0,
  });
  const ranges = range.mock.calls.flatMap((call, i) =>
    call[0] === opponent ? [{ call, value: range.mock.results[i]!.value }] : []
  );
  expect(ranges.length).toBeGreaterThan(0);
  const exploits = exploit.mock.calls.flatMap((call, i) =>
    call[0] === opponent ? [exploit.mock.results[i]!.value] : []
  );
  expect(exploits.length).toBeGreaterThan(0);
  // 2026-10-16 OPPONENT EXPLOIT: forty hands of raising and potting are a
  // credible aggressor and station, so the bettor's own read replaces the
  // lifetime 1.2 call-down (legacy cap) with a stronger one.
  expect(exploits.some((read) => read.callDownMod > 1.2)).toBe(true);
  expect(view.exploit.get(`${readScopeOf('nlh', 2)}|${opponent}`)).toBeDefined();
  vi.restoreAllMocks();
  // Every range read at decision time is WIDER than the same read with the
  // layer off (the raiser's measured width, not its seat), and the layer-off
  // read is still the legacy lifetime widening.
  HorseMind.setDecisionScope(readScopeOf('nlh', 2), 'nlh');
  const real = HorseMind.opponentRead;
  for (const { call, value } of ranges) {
    (HorseMind as unknown as { opponentRead: () => null }).opponentRead = () => null;
    let off;
    try {
      off = HorseMind.bandFor(...call);
    } finally {
      (HorseMind as unknown as { opponentRead: typeof real }).opponentRead = real;
    }
    expect(value).not.toBeNull();
    expect(value[0]).toBeLessThan(off![0]);
  }
  HorseMind.setDecisionScope(null);
});

it.each([
  ['call', 6, 0],
  ['short_raise', 8, 0],
  ['full_raise', 100, 1],
] as const)(
  'completed deep reads classify a controller accepted all-in %s consistently with basic reads',
  async (_line, stack, opportunities) => {
    HorseMind.reset();
    const players = [opponent, hero].map((user_id, i) => ({
      seat: i + 1,
      user_id,
      username: 'Actor',
      stack: i === 0 ? 100 : stack,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    })) as SeatPlayer[];
    const controller = new HandController(
      {
        tableId: table,
        handNumber: 1000300,
        gameVariant: 'nlh',
        smallBlind: 1,
        bigBlind: 2,
        isTournament: false,
        rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      },
      players,
      1
    );
    controller.start();
    expect(controller.performAction(1, 'raise', 6)).toBe(true);
    expect(controller.performAction(2, 'all_in')).toBe(true);
    const actions = controller.getState().actionHistory;
    expect(actions[1]).toMatchObject({ action: 'all_in', amount: stack });
    expect(actions[1]!.isFullRaise).toBe(opportunities ? true : stack === 8 ? false : undefined);
    const request = {
      type: 'OBSERVE_COMPLETED_HAND' as const,
      requestId: 300,
      generation: 1000300,
      handKey: `${table}:1000300`,
      fence: `${table}:1000300:9:observe`,
      committedHandId: '30000000-0000-4000-8000-000000000300',
      actions,
      bigBlind: 2,
      showdown: null,
      scope: readScopeOf('nlh', 2),
    };
    const worker = new HorseDecisionWorkerRuntime(() => {}, {
      ...defaults,
      startServices: async () => defaults.workerReadiness(),
      stopServices: async () => {},
      journalEnabled: () => false,
      journalAcceptedHand: () => {},
      journalLifecycle: () => {},
      noteFeature: () => {},
      noteDecision: () => {},
    });
    await worker.start();
    const admitted = await registerPublicObserver(worker, request, hero, players);
    worker.receive(request);
    worker.receive({ ...request, requestId: 301 });
    await worker.drain();
    expect(HorseMind.getStats(opponent)).toBeUndefined();
    inspectObserverReads(worker, admitted, () => {
      expect(HorseMind.getStats(opponent)?.f3bOpps).toBe(opportunities);
      expect(HorseMind.getStats(hero)?.pfr).toBe(opportunities);
    });
  }
);

it.each(['cbet', 'river'] as const)(
  'deep %s reads distinguish an aggressive shove from a whole-stack call',
  (branch) => {
    const make = (handNumber: number) => {
      const players = [opponent, hero].map((user_id, i) => ({
        seat: i + 1,
        user_id,
        username: 'Actor',
        stack: 100,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      })) as SeatPlayer[];
      const c = new HandController(
        {
          tableId: table,
          handNumber,
          gameVariant: 'nlh',
          smallBlind: 1,
          bigBlind: 2,
          isTournament: false,
          rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
        },
        players,
        1
      );
      c.start();
      expect(c.performAction(1, 'raise', 6)).toBe(true);
      expect(c.performAction(2, 'call')).toBe(true);
      return c;
    };
    if (branch === 'cbet') {
      const cbet = make(1000700);
      expect(cbet.performAction(2, 'check')).toBe(true);
      expect(cbet.performAction(1, 'all_in')).toBe(true);
      expect(cbet.performAction(2, 'fold')).toBe(true);
      expect(cbet.getState().actionHistory[3]).toMatchObject({
        action: 'all_in',
        isFullRaise: true,
      });
      HorseMind.observeHandComplete('cbet-full-shove', cbet.getState().actionHistory, 2, null);
      HorseMind.observeHandComplete('cbet-full-shove', cbet.getState().actionHistory, 2, null);
      expect(HorseMind.getStats(hero)).toMatchObject({ cbetOpps: 1, cbetFolds: 1 });
      return;
    }
    const river = make(1000701);
    for (const stage of ['flop', 'turn']) {
      expect(river.getState().stage).toBe(stage);
      expect(river.performAction(2, 'check')).toBe(true);
      expect(river.performAction(1, 'check')).toBe(true);
    }
    expect(river.performAction(2, 'all_in')).toBe(true);
    expect(river.performAction(1, 'all_in')).toBe(true);
    const actions = river.getState().actionHistory;
    expect(actions.at(-2)).toMatchObject({ action: 'all_in', isFullRaise: true });
    expect(actions.at(-1)?.isFullRaise).toBeUndefined();
    HorseMind.observeHandComplete(
      'river-shove-call',
      actions,
      2,
      [opponent, hero].map((user_id) => ({ user_id, mucked: false, hand_name: 'two pair' }))
    );
    expect(HorseMind.getStats(hero)).toMatchObject({ bigBetSD: 1, bigBetSDStrong: 1 });
    expect(HorseMind.getStats(opponent)?.bigBetSD ?? 0).toBe(0);
  }
);

it('a controller all-in call does not steal the preflop aggressor c-bet read', () => {
  const caller = '20000000-0000-4000-8000-000000000003';
  const players = [opponent, caller, hero].map((user_id, i) => ({
    seat: i + 1,
    user_id,
    username: 'Actor',
    stack: i === 1 ? 6 : 100,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const c = new HandController(
    {
      tableId: table,
      handNumber: 1000702,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      isTournament: false,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    },
    players,
    1
  );
  c.start();
  expect(c.performAction(1, 'raise', 6)).toBe(true);
  expect(c.performAction(2, 'all_in')).toBe(true);
  expect(c.performAction(3, 'call')).toBe(true);
  expect(c.performAction(3, 'check')).toBe(true);
  expect(c.performAction(1, 'bet', 10)).toBe(true);
  expect(c.performAction(3, 'fold')).toBe(true);
  HorseMind.observeHandComplete('cbet-after-allin-call', c.getState().actionHistory, 2, null);
  expect(HorseMind.getStats(hero)).toMatchObject({ cbetOpps: 1, cbetFolds: 1 });
  expect(HorseMind.getStats(opponent)?.f3bOpps ?? 0).toBe(0);
});
