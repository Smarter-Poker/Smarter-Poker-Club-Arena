import { horsePlanBatchBindingFromRequest } from './HorsePlanHandIdentity.js';
// These inherited scheduler tests stub worker emission. Their local batch binding is
// fixture shape only; the new paired client/worker suite proves actual issue ownership.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastHorseDecisionResult } from './horseDecision/protocol.js';

const decisionWorker = vi.hoisted(() => {
  const commitDecisionEffects = vi.fn(async (authority: { generation: number; fence: string }) => ({
    type: 'ACK' as const,
    requestId: 999,
    generation: authority.generation,
    fence: authority.fence,
    operation: 'COMMIT_DECISION_EFFECTS' as const,
  }));
  const decideFast = vi.fn(
    async (
      snapshot: import('./horseDecision/protocol.js').LiveHorseDecisionSnapshot
    ): Promise<FastHorseDecisionResult> => ({
      type: 'FAST_RESULT' as const,
      planIssueDisposition: 'issued' as const,
      planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 1 }),
      requestId: 1,
      generation: snapshot.generation,
      fence: snapshot.fence,
      decision: { action: 'bet' as const, amount: 20, thinkTime: 1 },
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 2,
      governorScale: 1,
      effects: [
        {
          type: 'raise_plan' as const,
          handKey: 'table:hand',
          userId: 'horse-1',
          street: 'flop',
          plan: 'foldToRaise' as const,
        },
      ],
    })
  );
  const worker = {
    decideFast,
    decideDeep: vi.fn(),
    commitDecisionEffects,
    runWithDispatchBarrier: vi.fn(<T>(fn: () => T): T => fn()),
  };
  return { worker, decideFast, commitDecisionEffects };
});

vi.mock('./horseDecision/index.js', async () => {
  const actual = await vi.importActual<typeof import('./horseDecision/index.js')>(
    './horseDecision/index.js'
  );
  return {
    ...actual,
    getLiveHorseDecisionWorker: () => decisionWorker.worker,
  };
});

// The main gate admits only the committed release selection (null today).
// Replace that one export with a gate whose admission these tests control.
const phase8Main = vi.hoisted(() => ({ admission: null as unknown }));
vi.mock('./HorseQualifiedAuthority.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./HorseQualifiedAuthority.js')>();
  return {
    ...actual,
    liveHorsePhase8Authority: new actual.HorsePhase8AuthorityGate(
      () =>
        (phase8Main.admission as
          | import('./HorseQualifiedAuthority.js').HorseAuthorityAdmission
          | null) ?? {
          status: 'refused',
          reason: 'unselected',
          transient: false,
        },
      'turns-test-main'
    ),
  };
});

// P10.3: the Phase 10 main gate is the same class with its own admission.
const phase10Main = vi.hoisted(() => ({ admission: null as unknown }));
vi.mock('./HorsePhase10Authority.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./HorsePhase10Authority.js')>();
  const { HorsePhase8AuthorityGate } = await import('./HorseQualifiedAuthority.js');
  return {
    ...actual,
    liveHorsePhase10Authority: new HorsePhase8AuthorityGate(
      () =>
        (phase10Main.admission as
          | import('./HorseQualifiedAuthority.js').HorseAuthorityAdmission
          | null) ?? {
          status: 'refused',
          reason: 'unselected',
          transient: false,
        },
      'turns-test-phase10-main',
      'plo4-policy-round1-v3'
    ),
  };
});

// P11.3: one Phase 11 main gate per pack, the same class, each with an
// admission these tests control.
const phase11Main = vi.hoisted(() => ({
  admission: { plo5: null, plo6: null, plo8: null } as Record<string, unknown>,
}));
vi.mock('./HorsePhase11Authority.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./HorsePhase11Authority.js')>();
  const { HorsePhase8AuthorityGate } = await import('./HorseQualifiedAuthority.js');
  const { OMAHA_VARIANT_PACKS } = await import('./omaha/OmahaVariantPolicyPack.js');
  const gate = (variant: 'plo5' | 'plo6' | 'plo8') =>
    new HorsePhase8AuthorityGate(
      () =>
        (phase11Main.admission[variant] as
          | import('./HorseQualifiedAuthority.js').HorseAuthorityAdmission
          | null) ?? {
          status: 'refused',
          reason: 'unselected',
          transient: false,
        },
      `turns-test-phase11-main-${variant}`,
      OMAHA_VARIANT_PACKS[variant].version
    );
  return {
    ...actual,
    liveHorsePhase11Authorities: Object.freeze({
      plo5: gate('plo5'),
      plo6: gate('plo6'),
      plo8: gate('plo8'),
    }),
  };
});

import { HandController } from './HandController.js';
import { liveHorsePhase10Authority } from './HorsePhase10Authority.js';
import { liveHorsePhase11Authorities } from './HorsePhase11Authority.js';
import { qualifiedPhase11TestAdmission } from './HorsePhase11Authority.test-support.js';
import { OMAHA_VARIANT_PACKS } from './omaha/OmahaVariantPolicyPack.js';
import { qualifiedPhase10TestAdmission } from './HorsePhase10Authority.test-support.js';
import {
  HorseQualifiedAuthorityHolder,
  liveHorsePhase8Authority,
} from './HorseQualifiedAuthority.js';
import { qualifiedTestAdmission } from './HorseQualifiedAuthority.test-support.js';
import type { HandConfig, SeatPlayer } from '../types.js';
import { ServerTableEngine } from './ServerTableEngine.js';
import { ServerTableEngineTurns } from './ServerTableEngineTurns.js';
import { HorseDecisionAbortedError, HorseDecisionExpiredError } from './horseDecision/index.js';
import { drainFires, enableBrainTelemetry } from './BrainTelemetry.js';
import { createHorseExecutionWitness } from './HorseExecutionWitness.js';
import { bindHorseDecisionToCommittedHand } from './HorseDecisionHandBinding.js';
import { bindHorseObservationIdentity } from './HorseObservationIdentity.js';

const TABLE = 'fafafafa-fafa-fafa-fafa-fafafafafafa';

function harness(intendedActionAccepted: boolean) {
  const player = {
    seat_number: 1,
    user_id: 'horse-1',
    username: 'Horse One',
    stack: 100,
    is_horse: true,
    horse_profile: {},
  };
  const enginePlayer = {
    seat: 1,
    user_id: player.user_id,
    username: player.username,
    stack: 100,
    bet: 0,
    totalInvested: 0,
    cards: [
      { rank: 'A', suit: 'hearts' },
      { rank: 'K', suit: 'hearts' },
    ],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  };
  const state = {
    currentPlayerSeat: 1,
    currentBet: 0,
    minRaise: 2,
    pot: 10,
    communityCards: [
      { rank: 'Q', suit: 'hearts' },
      { rank: '7', suit: 'clubs' },
      { rank: '2', suit: 'diamonds' },
    ],
    stage: 'flop' as const,
    players: [
      enginePlayer,
      {
        ...enginePlayer,
        seat: 2,
        user_id: 'human-2',
        username: 'Human Two',
        cards: [
          { rank: 'J', suit: 'spades' },
          { rank: 'J', suit: 'diamonds' },
        ],
      },
    ],
    communityCards2: [],
    communityCards3: [],
    pots: [],
    dealerSeat: 2,
    actionHistory: [],
  };
  const performAction = vi.fn().mockReturnValueOnce(intendedActionAccepted).mockReturnValue(true);
  const engine = new ServerTableEngine(TABLE) as any;
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.handCount = 12;
  engine.tableInfo = { action_time_seconds: 15, big_blind: 2, game_variant: 'nlh' };
  engine.seatedPlayers = [player];
  engine.handController = {
    getState: () => state,
    getAuthoritativeActionState: () => ({
      schemaVersion: 1,
      heroSeat: 1,
      currentPlayerSeat: 1,
      canAct: true,
      legalActions: ['fold', 'check', 'bet', 'all_in'],
      toCall: 0,
      minRaiseTo: 2,
      maxRaiseTo: 100,
      structure: 'no_limit',
      fixedBetSize: null,
      wagersCapped: false,
    }),
    computeLivePots: () => [{ amount: 10, eligiblePlayers: ['horse-1', 'human-2'] }],
    getContestablePotForCall: () => 10,
    getChipRulesSnapshot: () => ({ asset: 'chips', chipUnit: 0.01 }),
    getActiveBoardCount: () => 1,
    getRakeConfigSnapshot: () => ({
      percent: 10,
      cap: 5,
      noFlopNoDrop: true,
      playerCountCaps: [{ players: 2, cap: 2.5 }],
    }),
    performAction: (...args: any[]) => {
      const applied = performAction(...args.slice(0, 4));
      if (applied) {
        const [seat, action, amount, , onAccepted] = args;
        onAccepted?.({
          seat,
          userId: player.user_id,
          action,
          amount: action === 'all_in' ? enginePlayer.stack + enginePlayer.bet : (amount ?? 0),
          stage: state.stage,
          timestamp: Date.now(),
        });
      }
      return applied;
    },
  };
  engine.disconnectEngine = { isSittingOut: () => false, recordPlayerActed: vi.fn() };
  engine.timeBankEngine = {
    isArmed: () => false,
    getPlayerBank: () => null,
  };
  engine.getEngineLeaseAuthority = () => ({ verified: true, generation: 'lease-9' });
  engine.humansSeated = () => 0;
  engine.tableFormat = () => 'cash';
  engine.markProgress = vi.fn();
  return { engine, player, enginePlayer, state, performAction };
}

beforeEach(() => {
  vi.useFakeTimers();
  decisionWorker.decideFast.mockClear();
  decisionWorker.commitDecisionEffects.mockClear();
  decisionWorker.worker.runWithDispatchBarrier.mockClear();
  decisionWorker.worker.decideDeep.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('authoritative horse action effect commit', () => {
  it.each([undefined, 2, 20])(
    'reconciles the actual call price through the scheduled executor (selected %s)',
    async (amount) => {
      const { engine, player, enginePlayer } = harness(true);
      player.user_id = '20000000-0000-4000-8000-000000000001';
      enginePlayer.user_id = player.user_id;
      engine.getEngineLeaseAuthority = () => ({ verified: true, generation: '9' });
      engine.broadcastCurrentState = vi.fn();
      const hc = new HandController(
        {
          tableId: TABLE,
          handNumber: 12,
          gameVariant: 'nlh',
          smallBlind: 1,
          bigBlind: 2,
          ante: 1,
          rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
        } as HandConfig,
        [1, 2, 3, 4].map((seat) => ({
          ...enginePlayer,
          seat,
          cards: [],
          user_id: seat === 1 ? player.user_id : `20000000-0000-4000-8000-00000000000${seat}`,
        })) as SeatPlayer[],
        2
      );
      engine.handController = hc;
      const events: Promise<void>[] = [];
      hc.onEvent((event) => {
        if (event.type === 'FORCED_BETS_POSTED' || event.type === 'PLAYER_ACTION')
          events.push(engine.handleHandEvent(event, [player]));
      });
      hc.start();
      await Promise.all(events);
      const acceptedPrefixLength = engine.currentHandActions.length;
      expect(acceptedPrefixLength).toBeGreaterThan(hc.getState().actionHistory.length);
      let witness: ReturnType<typeof createHorseExecutionWitness>;
      decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => {
        const decision = { action: 'call' as const, amount, thinkTime: 1 };
        witness = createHorseExecutionWitness(snapshot, decision, {
          requestId: 1,
          lane: 'fast',
          computeMs: 1,
          governorScale: 1,
        });
        return {
          type: 'FAST_RESULT',
          planIssueDisposition: 'no_effects' as const,
          planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 1 }),
          requestId: 1,
          generation: snapshot.generation,
          fence: snapshot.fence,
          decision: { ...decision, executionWitness: witness },
          rngBefore: 11,
          rngAfter: 22,
          computeMs: 1,
          governorScale: 1,
          effects: [],
        };
      });
      const state = hc.getState();
      expect(state.currentPlayerSeat).toBe(1);
      const perform = vi.spyOn(hc, 'performAction');
      engine.scheduleHorseAction(player, 1, state.players.find((p) => p.seat === 1)!, state);
      await vi.advanceTimersByTimeAsync(300);
      await Promise.all(events);
      expect(perform).toHaveBeenCalledOnce();
      expect(hc.getState().actionHistory.find((r) => r.seat === 1)).toMatchObject({
        action: 'call',
        amount: 2,
      });
      expect(witness!).toMatchObject({
        executionStatus: amount === 20 ? 'coerced' : 'intended',
        expectedExecutionAmount: amount ?? 2,
        executedAction: 'call',
        executedAmount: 2,
      });
      expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
      expect(witness!.handAnchor).toMatchObject({
        status: 'anchored',
        actionOrdinal: acceptedPrefixLength,
      });
      const committedHandId = '30000000-0000-4000-8000-000000000001';
      const actions = engine.currentHandActions.map((action: any, ordinal: number) => ({
        ...action,
        observationIdentity: bindHorseObservationIdentity(action, ordinal, {
          handId: committedHandId,
          tableId: TABLE,
          seatGenerations: new Map([
            [player.user_id, { seat_id: player.user_id, seat_joined_at: '2026-09-14T12:00:00Z' }],
          ]) as never,
        }),
      }));
      expect(
        bindHorseDecisionToCommittedHand(witness!, {
          generation: 12,
          fence: `${TABLE}:12:9:observe`,
          handKey: `${TABLE}:12`,
          committedHandId,
          bigBlind: 2,
          actions,
        })
      ).toMatchObject({ status: 'bound', committedHandId, actionOrdinal: acceptedPrefixLength });
    }
  );
  it.each([
    ['check', 'throw'],
    ['check', 'false'],
    ['fold', 'throw'],
    ['fold', 'false'],
  ] as const)('stops after fallback %s was accepted despite %s', async (fallback, mode) => {
    const { engine, player, enginePlayer, state } = harness(false);
    let witness: ReturnType<typeof createHorseExecutionWitness>;
    decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => {
      const decision = { action: 'bet' as const, amount: 20, thinkTime: 1 };
      witness = createHorseExecutionWitness(snapshot, decision, {
        requestId: 1,
        lane: 'fast',
        computeMs: 2,
        governorScale: 1,
      });
      return {
        type: 'FAST_RESULT',
        planIssueDisposition: 'no_effects' as const,
        planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 1 }),
        requestId: 1,
        generation: snapshot.generation,
        fence: snapshot.fence,
        decision: { ...decision, executionWitness: witness },
        rngBefore: 11,
        rngAfter: 22,
        computeMs: 2,
        governorScale: 1,
        effects: [],
      };
    });
    const attempts: string[] = [];
    engine.handController.performAction = (
      seat: number,
      action: string,
      _amount: unknown,
      _origin: unknown,
      onAccepted: (r: unknown) => void
    ) => {
      attempts.push(action);
      if (action !== fallback) return false;
      onAccepted({ seat, action, amount: 0, stage: state.stage, timestamp: Date.now() });
      if (mode === 'throw') throw Error('after fallback acceptance');
      return false;
    };
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(300);
    expect(attempts).toEqual(fallback === 'check' ? ['bet', 'check'] : ['bet', 'check', 'fold']);
    expect(witness!).toMatchObject({ executionStatus: 'fallback', executedAction: fallback });
    expect(witness!.acceptedActions).toHaveLength(1);
    expect(engine.markProgress).toHaveBeenCalledOnce();
    expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
  });
  it.each(['throw', 'false', 'coerced'] as const)(
    'uses the actual controller record when a wager finishes with %s',
    async (mode) => {
      const { engine, player, enginePlayer } = harness(true);
      const hc = new HandController(
        {
          tableId: TABLE,
          handNumber: 12,
          gameVariant: mode === 'coerced' ? 'flh' : 'nlh',
          smallBlind: 1,
          bigBlind: 2,
          rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
        } as HandConfig,
        [1, 2, 3, 4].map((seat) => ({
          ...enginePlayer,
          seat,
          cards: [],
          user_id: seat === 1 ? player.user_id : `opponent-${seat}`,
        })) as SeatPlayer[],
        2
      );
      hc.start();
      engine.handController = hc;
      engine.tableInfo.game_variant = mode === 'coerced' ? 'flh' : 'nlh';
      const policies = {
        tournamentUtility: { selectedAction: 'raise', selectedAmount: 20 },
        tournamentPostflop: { applied: false, baselineAction: 'raise', baselineAmount: 20 },
        plo4Policy: { finalAction: 'raise', finalAmount: 20 },
        omahaVariantPolicy: { variant: 'plo5', finalAction: 'raise', finalAmount: 20 },
        remainingVariantPolicy: { variant: 'flh', finalAction: 'raise', finalAmount: 20 },
        jointPolicy: { variant: 'nlh', finalAction: 'raise', finalAmount: 20 },
      };
      let witness: ReturnType<typeof createHorseExecutionWitness>;
      decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => {
        const decision = { action: 'raise', amount: 20, thinkTime: 1, ...policies } as any;
        witness = createHorseExecutionWitness(snapshot, decision, {
          requestId: 1,
          lane: 'fast',
          computeMs: 2,
          governorScale: 1,
        });
        return {
          type: 'FAST_RESULT',
          planIssueDisposition: 'issued' as const,
          planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 1 }),
          requestId: 1,
          generation: snapshot.generation,
          fence: snapshot.fence,
          decision: { ...decision, executionWitness: witness },
          rngBefore: 11,
          rngAfter: 22,
          computeMs: 2,
          governorScale: 1,
          effects: [
            {
              type: 'raise_plan',
              handKey: 'table:hand',
              userId: player.user_id,
              street: 'preflop',
              plan: 'foldToRaise',
            },
          ],
        };
      });
      if (mode === 'throw')
        vi.spyOn(hc as any, 'advanceGame').mockImplementation(() => {
          throw Error('post-acceptance advance failure');
        });
      const original = hc.performAction.bind(hc);
      const attempted = vi.spyOn(hc, 'performAction').mockImplementation((...args) => {
        const result = original(...args);
        return mode === 'false' ? false : result;
      });
      const state = hc.getState();
      engine.scheduleHorseAction(player, 1, state.players.find((p) => p.seat === 1)!, state);
      await vi.advanceTimersByTimeAsync(300);
      expect(attempted).toHaveBeenCalledOnce();
      expect(hc.getState().actionHistory.filter((r) => r.seat === 1)).toHaveLength(1);
      const status = mode === 'coerced' ? 'coerced' : 'intended';
      const amount = mode === 'coerced' ? 4 : 20;
      expect(witness!).toMatchObject({
        executionStatus: status,
        executedAction: 'raise',
        executedAmount: amount,
      });
      for (const receipt of Object.values(policies))
        expect(receipt).toMatchObject({
          executionStatus: status,
          executedAction: 'raise',
          executedAmount: amount,
        });
      expect(decisionWorker.commitDecisionEffects).toHaveBeenCalledTimes(
        mode === 'coerced' ? 0 : 1
      );
      expect(engine.markProgress).toHaveBeenCalledOnce();
    }
  );
  it.each(['plo4', 'plo5', 'plo6', 'plo8', 'flh', 'flo8'] as const)(
    'reconciles the actual %s controller clamp through the scheduled executor',
    async (variant) => {
      const { engine, player, enginePlayer } = harness(true);
      const hc = new HandController(
        {
          tableId: TABLE,
          handNumber: 12,
          gameVariant: variant,
          smallBlind: 1,
          bigBlind: 2,
          rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
        } as HandConfig,
        [1, 2, 3, 4].map((seat) => ({
          ...enginePlayer,
          seat,
          cards: [],
          user_id: seat === 1 ? player.user_id : `opponent-${seat}`,
        })) as SeatPlayer[],
        2
      );
      hc.start();
      engine.handController = hc;
      engine.tableInfo.game_variant = variant;
      const policies = {
        tournamentUtility: {
          selectedAction: 'all_in',
          selectedAmount: null,
          executionStatus: 'pending',
        },
        tournamentPostflop: {
          applied: false,
          baselineAction: 'all_in',
          baselineAmount: null,
          executionStatus: 'pending',
        },
        plo4Policy: { finalAction: 'all_in', finalAmount: null, executionStatus: 'pending' },
        omahaVariantPolicy: {
          variant,
          finalAction: 'all_in',
          finalAmount: null,
          executionStatus: 'pending',
        },
        remainingVariantPolicy: {
          variant,
          finalAction: 'all_in',
          finalAmount: null,
          executionStatus: 'pending',
        },
        jointPolicy: {
          variant,
          finalAction: 'all_in',
          finalAmount: null,
          executionStatus: 'pending',
        },
      };
      let witness: ReturnType<typeof createHorseExecutionWitness> | undefined;
      decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => {
        const decision = { action: 'all_in' as const, thinkTime: 1, ...policies } as any;
        witness = createHorseExecutionWitness(snapshot, decision, {
          requestId: 1,
          lane: 'fast',
          computeMs: 2,
          governorScale: 1,
        });
        return {
          type: 'FAST_RESULT',
          planIssueDisposition: 'no_effects' as const,
          planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 1 }),
          requestId: 1,
          generation: snapshot.generation,
          fence: snapshot.fence,
          decision: { ...decision, executionWitness: witness },
          rngBefore: 11,
          rngAfter: 22,
          computeMs: 2,
          governorScale: 1,
          effects: [],
        };
      });
      const state = hc.getState();
      expect(state.currentPlayerSeat).toBe(1);
      engine.scheduleHorseAction(player, 1, state.players.find((p) => p.seat === 1)!, state);
      await vi.advanceTimersByTimeAsync(300);
      const expectedAmount = variant.startsWith('plo') ? 7 : 4;
      expect(witness).toMatchObject({
        executionStatus: 'coerced',
        executedAction: 'raise',
        executedAmount: expectedAmount,
      });
      expect(witness?.acceptedActions).toEqual([
        {
          intended: true,
          record: {
            seat: 1,
            action: 'raise',
            amount: expectedAmount,
            stage: 'preflop',
            userId: player.user_id,
            timestamp: hc.getState().actionHistory.find((r) => r.seat === 1)!.timestamp,
            isFullRaise: true,
          },
        },
      ]);
      for (const receipt of Object.values(policies)) {
        expect(receipt).toMatchObject({
          executionStatus: 'coerced',
          executedAction: 'raise',
          executedAmount: expectedAmount,
        });
      }
      expect(hc.getState().players.find((p) => p.seat === 1)!.stack).toBe(100 - expectedAmount);
    }
  );
  it('keeps a disconnected all-in seat as a live pot contender', () => {
    const { engine, player, enginePlayer, state } = harness(true);
    state.players[1].is_all_in = true;
    state.players[1].stack = 0;
    engine.disconnectEngine.isSittingOut = (_table: string, userId: string) => userId === 'human-2';
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    const snapshot = decisionWorker.decideFast.mock.calls[0]?.[0] as any;
    expect(snapshot.gameState.players[1]).toMatchObject({ is_all_in: true, is_sitting_out: false });
  });
  it('publishes the controller actual board count after a physical deck downgrade', () => {
    const { engine, player, enginePlayer, state } = harness(true);
    engine.currentHandBombPot = { board_count: 3 };
    engine.handController.getActiveBoardCount = () => 2;
    (state as any).communityCards2 = [
      { rank: '3', suit: 'clubs' },
      { rank: '4', suit: 'diamonds' },
      { rank: '5', suit: 'hearts' },
    ];
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    const snapshot = decisionWorker.decideFast.mock.calls[0]?.[0] as any;
    expect(snapshot.gameState.boardCount).toBe(2);
  });
  it('retains folded disconnected deals without exposing their cards', () => {
    const { engine, player, enginePlayer, state } = harness(true);
    state.players[1].is_folded = true;
    state.players.push({ ...state.players[1], seat: 3, user_id: 'never-dealt', cards: [] });
    engine.disconnectEngine.isSittingOut = (_table: string, userId: string) =>
      userId !== player.user_id;
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    const snapshot = decisionWorker.decideFast.mock.calls[0]?.[0] as any;
    expect(snapshot.gameState.players[1].is_sitting_out).toBe(true);
    expect(snapshot.gameState.dealtSeatIds).toEqual([1, 2]);
    expect(snapshot.gameState.chipUnit).toBe(0.01);
    expect(snapshot.gameState.asset).toBe('chips');
    expect(snapshot.gameState.players.every((seat: any) => seat.cards.length === 0)).toBe(true);
    state.players[1].cards.pop();
    expect(snapshot.gameState.dealtSeatIds).toEqual([1, 2]);
  });

  it('publishes one canonical public state and never exposes any seat private cards', () => {
    const { engine, player, enginePlayer, state } = harness(true);

    engine.scheduleHorseAction(player, 1, enginePlayer, state);

    const snapshot = decisionWorker.decideFast.mock.calls[0]?.[0] as any;
    expect(snapshot.player.cards).toEqual(enginePlayer.cards);
    expect(snapshot.gameState.players).toHaveLength(2);
    expect(snapshot.gameState.players.every((seat: any) => seat.cards.length === 0)).toBe(true);
    expect(snapshot.gameState).toMatchObject({
      stateSchemaVersion: 1,
      heroSeat: 1,
      currentPlayerSeat: 1,
      legalActions: ['fold', 'check', 'bet', 'all_in'],
      toCall: 0,
      minRaiseTo: 2,
      maxRaiseTo: 100,
      bettingStructure: 'no_limit',
      commitmentCapRemaining: null,
      contestablePot: 10,
      pots: [{ amount: 10, eligiblePlayers: ['horse-1', 'human-2'] }],
      rakeConfig: { percent: 10, cap: 5, noFlopNoDrop: true },
      variantRules: { holeCardsDealt: 2, holeCardsUse: 'any', deckSize: 52 },
    });
    expect(snapshot.decisionKey).toMatch(/^phase5-v1:[0-9a-f]{64}$/);
    expect(snapshot.decisionKey).not.toContain('"rank":"J"');
  });

  it('publishes the legal two-card Pineapple flop after the hero discard', () => {
    const { engine, player, enginePlayer, state } = harness(true);
    engine.tableInfo = { ...engine.tableInfo, game_variant: 'pineapple' };
    engine.handController.getGameVariant = () => 'pineapple';
    const discarded = [{ rank: 'Q', suit: 'diamonds' }];
    engine.handController.getPineappleKnownDeadCards = vi.fn(() => discarded);
    enginePlayer.cards = [
      { rank: 'A', suit: 'hearts' },
      { rank: 'K', suit: 'hearts' },
    ];
    (state as any).actionHistory = [
      {
        seat: 1,
        userId: 'horse-1',
        action: 'discard',
        amount: 0,
        timestamp: 100,
        stage: 'pineapple_discard',
      },
    ];

    engine.scheduleHorseAction(player, 1, enginePlayer, state);

    const snapshot = decisionWorker.decideFast.mock.calls[0]?.[0] as any;
    expect(snapshot.player.cards).toHaveLength(2);
    expect(snapshot.player.knownDeadCards).toEqual(discarded);
    expect(engine.handController.getPineappleKnownDeadCards).toHaveBeenCalledWith(1);
    expect(snapshot.gameState.players.every((seat: any) => seat.knownDeadCards === undefined)).toBe(
      true
    );
    expect(snapshot.gameState).toMatchObject({
      gameVariant: 'pineapple',
      stage: 'flop',
      actionHistory: [
        {
          seat: 1,
          userId: 'horse-1',
          action: 'discard',
          stage: 'pineapple_discard',
        },
      ],
      variantRules: {
        holeCardsDealt: 3,
        holeCardsUse: 'discard_to_two',
        boardCardsUse: 'any',
      },
    });
  });

  it('never schedules an ordinary fast decision during the Pineapple discard round', async () => {
    const { engine, player, state } = harness(true);
    engine.tableInfo = { ...engine.tableInfo, game_variant: 'pineapple' };
    (state as any).stage = 'pineapple_discard';
    (state as any).currentPlayerSeat = 1;

    await engine.handleTurnChange({ type: 'TURN_CHANGE', seat: 1, availableActions: [] }, [player]);

    expect(decisionWorker.decideFast).not.toHaveBeenCalled();
  });

  it('removes a false all-in and clamps the wager ceiling at a table commitment cap', () => {
    const { engine, player, enginePlayer, state } = harness(true);
    engine.tableInfo = {
      ...engine.tableInfo,
      cap_enabled: true,
      cap_bb: 10,
    };
    enginePlayer.totalInvested = 15;

    engine.scheduleHorseAction(player, 1, enginePlayer, state);

    const snapshot = decisionWorker.decideFast.mock.calls[0]?.[0] as any;
    expect(snapshot.gameState.commitmentCapRemaining).toBe(5);
    expect(snapshot.gameState.maxRaiseTo).toBe(5);
    expect(snapshot.gameState.legalActions).toEqual(['fold', 'check', 'bet']);
  });

  it('publishes the cap-safe all-in-or-fold menu before the worker evaluates it', () => {
    const { engine, player, enginePlayer, state } = harness(true);
    engine.tableInfo = {
      ...engine.tableInfo,
      all_in_or_fold: true,
      cap_enabled: true,
      cap_bb: 10,
    };
    (state as any).stage = 'preflop';
    enginePlayer.totalInvested = 15;

    engine.scheduleHorseAction(player, 1, enginePlayer, state);

    const snapshot = decisionWorker.decideFast.mock.calls[0]?.[0] as any;
    expect(snapshot.gameState.commitmentCapRemaining).toBe(5);
    expect(snapshot.gameState.legalActions).toEqual(['check']);
    expect(snapshot.gameState.minRaiseTo).toBeNull();
    expect(snapshot.gameState.maxRaiseTo).toBeNull();
  });

  it('keeps the host non-fold-to-shove belt when the canonical AoF menu allows it', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    engine.tableInfo = { ...engine.tableInfo, all_in_or_fold: true };
    (state as any).stage = 'preflop';
    decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => ({
      type: 'FAST_RESULT' as const,
      planIssueDisposition: 'no_effects' as const,
      planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 40 }),
      requestId: 40,
      generation: snapshot.generation,
      fence: snapshot.fence,
      decision: { action: 'bet' as const, amount: 20, thinkTime: 1 },
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 2,
      governorScale: 1,
      effects: [],
    }));

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(250);

    expect(performAction).toHaveBeenCalledWith(1, 'all_in', undefined, 'horse_policy');
  });

  it('never resurrects an all-in removed from the canonical AoF menu by the cap', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    engine.tableInfo = {
      ...engine.tableInfo,
      all_in_or_fold: true,
      cap_enabled: true,
      cap_bb: 10,
    };
    (state as any).stage = 'preflop';
    enginePlayer.totalInvested = 15;
    decisionWorker.decideFast.mockImplementationOnce(
      async (snapshot: any) =>
        ({
          type: 'FAST_RESULT' as const,
          planIssueDisposition: 'no_effects' as const,
          planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 41 }),
          requestId: 41,
          generation: snapshot.generation,
          fence: snapshot.fence,
          decision: { action: 'all_in' as const, thinkTime: 1 },
          rngBefore: 11,
          rngAfter: 22,
          computeMs: 2,
          governorScale: 1,
          effects: [],
        }) as any
    );

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(250);

    expect(performAction).toHaveBeenCalledTimes(1);
    expect(performAction).toHaveBeenCalledWith(1, 'check', undefined, 'horse_policy');
    expect(performAction.mock.calls.some(([, action]) => action === 'all_in')).toBe(false);
  });

  it.each([
    [true, 'intended', 'bet'],
    [false, 'fallback', 'check'],
  ] as const)(
    'records the authoritative Phase 7 execution receipt (%s -> %s)',
    async (accepted, expectedStatus, expectedAction) => {
      const { engine, player, enginePlayer, state, performAction } = harness(accepted);
      const receipt: any = {
        selectedAction: 'bet',
        selectedAmount: 20,
        executedAction: null,
        executedAmount: null,
        executionStatus: 'pending',
      };
      decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => ({
        type: 'FAST_RESULT' as const,
        planIssueDisposition: 'no_effects' as const,
        planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 41 }),
        requestId: 41,
        generation: snapshot.generation,
        fence: snapshot.fence,
        decision: {
          action: 'bet' as const,
          amount: 20,
          thinkTime: 1,
          tournamentUtility: receipt,
        },
        rngBefore: 11,
        rngAfter: 22,
        computeMs: 2,
        governorScale: 1,
        effects: [],
      }));

      engine.scheduleHorseAction(player, 1, enginePlayer, state);
      await vi.advanceTimersByTimeAsync(250);

      expect(receipt.executionStatus).toBe(expectedStatus);
      expect(receipt.executedAction).toBe(expectedAction);
      expect(receipt.executedAmount).toBe(expectedAction === 'bet' ? 20 : null);
      expect(performAction).toHaveBeenCalledTimes(accepted ? 1 : 2);
      expect(performAction.mock.calls.map((call) => call[3])).toEqual(
        accepted ? ['horse_policy'] : ['horse_policy', 'horse_fallback']
      );
    }
  );

  it('closes a pending Phase 7 receipt when the authority fence expires before commit', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    const receipt: any = {
      selectedAction: 'bet',
      selectedAmount: 20,
      executedAction: null,
      executedAmount: null,
      executionStatus: 'pending',
    };
    decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => ({
      type: 'FAST_RESULT' as const,
      planIssueDisposition: 'no_effects' as const,
      planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 42 }),
      requestId: 42,
      generation: snapshot.generation,
      fence: snapshot.fence,
      decision: {
        action: 'bet' as const,
        amount: 20,
        thinkTime: 1_000,
        tournamentUtility: receipt,
      },
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 2,
      governorScale: 1,
      effects: [],
    }));

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(0);
    engine.handCount += 1;
    await vi.advanceTimersByTimeAsync(1_500);

    expect(receipt.executionStatus).toBe('not_executed');
    expect(receipt.executedAction).toBeNull();
    expect(receipt.executedAmount).toBeNull();
    expect(performAction).not.toHaveBeenCalled();
  });

  it.each(['capacity_unavailable', 'reissue_unavailable', 'no_effects'] as const)(
    'records an accepted wager with %s without pretending plan application',
    async (disposition) => {
      enableBrainTelemetry();
      drainFires();
      const { engine, player, enginePlayer, state, performAction } = harness(true);
      decisionWorker.decideFast.mockImplementationOnce(async (snapshot) => ({
        type: 'FAST_RESULT',
        requestId: 1,
        generation: snapshot.generation,
        fence: snapshot.fence,
        planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 1 }),
        planIssueDisposition: disposition,
        decision: { action: 'bet', amount: 20, thinkTime: 1 },
        rngBefore: 11,
        rngAfter: 22,
        computeMs: 2,
        governorScale: 1,
        effects:
          disposition === 'no_effects'
            ? []
            : [
                {
                  type: 'raise_plan',
                  handKey: 'table:hand',
                  userId: 'horse-1',
                  street: 'flop',
                  plan: 'foldToRaise',
                },
              ],
      }));
      engine.scheduleHorseAction(player, 1, enginePlayer, state);
      await vi.advanceTimersByTimeAsync(250);
      expect(performAction).toHaveBeenCalledOnce();
      expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
      expect(drainFires()).toContainEqual(
        expect.objectContaining({ feature: `phase15_plan_accepted_${disposition}`, fires: 1 })
      );
    }
  );
  it('commits one captured plan only after the intended wager is accepted', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(250);

    expect(performAction).toHaveBeenCalledTimes(1);
    expect(performAction).toHaveBeenCalledWith(1, 'bet', 20, 'horse_policy');
    expect(decisionWorker.commitDecisionEffects).toHaveBeenCalledTimes(1);
    await expect(decisionWorker.commitDecisionEffects.mock.results[0]!.value).resolves.toEqual({
      type: 'ACK',
      requestId: 999,
      generation: expect.any(Number),
      fence: expect.any(String),
      operation: 'COMMIT_DECISION_EFFECTS',
    });
    expect(decisionWorker.commitDecisionEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: expect.any(Number),
        fence: expect.any(String),
        planBinding: expect.objectContaining({ version: 'horse-plan-batch-v1' }),
        effects: [expect.objectContaining({ type: 'raise_plan', handKey: 'table:hand' })],
      })
    );
  });

  it('does not commit an intended wager plan when that wager is rejected and degraded', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(false);

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(250);

    expect(performAction).toHaveBeenNthCalledWith(1, 1, 'bet', 20, 'horse_policy');
    expect(performAction).toHaveBeenNthCalledWith(2, 1, 'check', undefined, 'horse_fallback');
    expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
  });

  it('takes the safe action immediately when a queued worker decision expires', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    decisionWorker.decideFast.mockRejectedValueOnce(
      new HorseDecisionExpiredError('queued decision used its complete budget')
    );

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(0);

    expect(performAction).toHaveBeenCalledTimes(1);
    expect(performAction).toHaveBeenCalledWith(1, 'check', undefined, 'horse_fallback');
    expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
  });

  it('does not act after a genuine authority abort', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    decisionWorker.decideFast.mockRejectedValueOnce(new HorseDecisionAbortedError());

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(performAction).not.toHaveBeenCalled();
    expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
  });
});

// Phase 10 must reconcile through the same real scheduled action boundary.
describe('Phase 10 authoritative execution receipts', () => {
  it.each([
    [true, 'intended', 'bet'],
    [false, 'fallback', 'check'],
  ] as const)(
    'records the authoritative Phase 10 execution receipt (%s -> %s)',
    async (accepted, expectedStatus, expectedAction) => {
      const { engine, player, enginePlayer, state, performAction } = harness(accepted);
      const receipt: any = {
        finalAction: 'bet',
        finalAmount: 20,
        executedAction: null,
        executedAmount: null,
        executionStatus: 'pending',
      };
      decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => ({
        type: 'FAST_RESULT' as const,
        planIssueDisposition: 'no_effects' as const,
        planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 41 }),
        requestId: 41,
        generation: snapshot.generation,
        fence: snapshot.fence,
        decision: {
          action: 'bet' as const,
          amount: 20,
          thinkTime: 1,
          plo4Policy: receipt,
        },
        rngBefore: 11,
        rngAfter: 22,
        computeMs: 2,
        governorScale: 1,
        effects: [],
      }));

      engine.scheduleHorseAction(player, 1, enginePlayer, state);
      await vi.advanceTimersByTimeAsync(250);

      expect(receipt.executionStatus).toBe(expectedStatus);
      expect(receipt.executedAction).toBe(expectedAction);
      expect(receipt.executedAmount).toBe(expectedAction === 'bet' ? 20 : null);
      expect(performAction).toHaveBeenCalledTimes(accepted ? 1 : 2);
    }
  );

  it('closes a pending Phase 10 receipt when the authority fence expires before commit', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    const receipt: any = {
      finalAction: 'bet',
      finalAmount: 20,
      executedAction: null,
      executedAmount: null,
      executionStatus: 'pending',
    };
    decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => ({
      type: 'FAST_RESULT' as const,
      planIssueDisposition: 'no_effects' as const,
      planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 42 }),
      requestId: 42,
      generation: snapshot.generation,
      fence: snapshot.fence,
      decision: {
        action: 'bet' as const,
        amount: 20,
        thinkTime: 1_000,
        plo4Policy: receipt,
      },
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 2,
      governorScale: 1,
      effects: [],
    }));

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(0);
    engine.handCount += 1;
    await vi.advanceTimersByTimeAsync(1_500);

    expect(receipt.executionStatus).toBe('not_executed');
    expect(receipt.executedAction).toBeNull();
    expect(receipt.executedAmount).toBeNull();
    expect(performAction).not.toHaveBeenCalled();
  });
});

// Phase 11 must reconcile through the same real scheduled action boundary.
describe('Phase 11 authoritative execution receipts', () => {
  it.each(['generation', 'fence'] as const)(
    'retires every ledger on an early %s mismatch without executing an action',
    async (mismatch) => {
      const { engine, player, enginePlayer, state, performAction } = harness(true);
      const ledgers = Object.fromEntries(
        ['tournamentUtility', 'tournamentPostflop', 'plo4Policy', 'omahaVariantPolicy'].map(
          (key) => [
            key,
            {
              variant: 'plo8',
              finalAction: 'bet',
              finalAmount: 20,
              executedAction: null,
              executedAmount: null,
              executionStatus: 'pending',
            },
          ]
        )
      );
      decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => ({
        type: 'FAST_RESULT' as const,
        planIssueDisposition: 'no_effects' as const,
        planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 45 }),
        requestId: 45,
        generation: snapshot.generation + Number(mismatch === 'generation'),
        fence: mismatch === 'fence' ? 'retired-fence' : snapshot.fence,
        decision: { action: 'bet' as const, amount: 20, thinkTime: 1, ...ledgers },
        rngBefore: 11,
        rngAfter: 22,
        computeMs: 2,
        governorScale: 1,
        effects: [],
      }));
      engine.scheduleHorseAction(player, 1, enginePlayer, state);
      await vi.advanceTimersByTimeAsync(250);
      for (const ledger of Object.values(ledgers))
        expect(ledger.executionStatus).toBe('not_executed');
      expect(performAction).not.toHaveBeenCalled();
      expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
    }
  );
  it.each([
    [true, 'intended', 'bet'],
    [false, 'fallback', 'check'],
  ] as const)(
    'records the authoritative Phase 11 execution receipt (%s -> %s)',
    async (accepted, expectedStatus, expectedAction) => {
      const { engine, player, enginePlayer, state, performAction } = harness(accepted);
      const receipt: any = {
        finalAction: 'bet',
        finalAmount: 20,
        executedAction: null,
        executedAmount: null,
        executionStatus: 'pending',
      };
      decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => ({
        type: 'FAST_RESULT' as const,
        planIssueDisposition: 'no_effects' as const,
        planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 41 }),
        requestId: 41,
        generation: snapshot.generation,
        fence: snapshot.fence,
        decision: {
          action: 'bet' as const,
          amount: 20,
          thinkTime: 1,
          omahaVariantPolicy: receipt,
        },
        rngBefore: 11,
        rngAfter: 22,
        computeMs: 2,
        governorScale: 1,
        effects: [],
      }));

      engine.scheduleHorseAction(player, 1, enginePlayer, state);
      await vi.advanceTimersByTimeAsync(250);

      expect(receipt.executionStatus).toBe(expectedStatus);
      expect(receipt.executedAction).toBe(expectedAction);
      expect(receipt.executedAmount).toBe(expectedAction === 'bet' ? 20 : null);
      expect(performAction).toHaveBeenCalledTimes(accepted ? 1 : 2);
    }
  );

  it('closes a pending Phase 11 receipt when the authority fence expires before commit', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    const receipt: any = {
      finalAction: 'bet',
      finalAmount: 20,
      executedAction: null,
      executedAmount: null,
      executionStatus: 'pending',
    };
    decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => ({
      type: 'FAST_RESULT' as const,
      planIssueDisposition: 'no_effects' as const,
      planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 42 }),
      requestId: 42,
      generation: snapshot.generation,
      fence: snapshot.fence,
      decision: {
        action: 'bet' as const,
        amount: 20,
        thinkTime: 1_000,
        omahaVariantPolicy: receipt,
      },
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 2,
      governorScale: 1,
      effects: [],
    }));

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(0);
    engine.handCount += 1;
    await vi.advanceTimersByTimeAsync(1_500);

    expect(receipt.executionStatus).toBe('not_executed');
    expect(receipt.executedAction).toBeNull();
    expect(receipt.executedAmount).toBeNull();
    expect(performAction).not.toHaveBeenCalled();
  });
});

describe.each([
  'tournamentUtility',
  'tournamentPostflop',
  'plo4Policy',
  'omahaVariantPolicy',
  'remainingVariantPolicy',
  'jointPolicy',
  'executionWitness',
] as const)('%s deep and cancelled execution reconciliation', (policyKey) => {
  beforeEach(() => {
    enableBrainTelemetry();
    drainFires();
  });
  const ledger = (action = 'call', amount: number | null = 20) => ({
    variant: 'nlh',
    selectedAction: action,
    selectedAmount: amount,
    baselineAction: action,
    baselineAmount: amount,
    applied: false,
    finalAction: action,
    finalAmount: amount,
    executedAction: null,
    executedAmount: null,
    executionStatus: 'pending',
  });
  const response = (
    snapshot: any,
    receipt: any,
    action: any,
    amount: number | undefined = action === 'call' || action === 'bet' ? 20 : undefined,
    lane: 'fast' | 'deep' = 'fast'
  ) => {
    if (policyKey === 'executionWitness') {
      Object.assign(
        receipt,
        createHorseExecutionWitness(
          snapshot,
          { action, amount, thinkTime: 1000 },
          {
            requestId: 81,
            lane,
            computeMs: 2,
            governorScale: 1,
          }
        )
      );
    }
    return {
      type: 'FAST_RESULT' as const,
      planIssueDisposition: 'no_effects' as const,
      planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 81 }),
      requestId: 81,
      generation: snapshot.generation,
      fence: snapshot.fence,
      decision: { action, amount, thinkTime: 1000, [policyKey]: receipt },
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 2,
      governorScale: 1,
      effects: [],
    };
  };
  it.each([
    'accepted',
    'unchanged',
    'generation',
    'fence',
    'after_commit',
    'cancelled',
    'brain_exception',
  ] as const)('reconciles the actual scheduled deep result: %s', async (mode) => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    const fast = ledger(),
      deep = ledger(mode === 'unchanged' ? 'call' : 'fold', mode === 'unchanged' ? 20 : null);
    state.currentBet = 20;
    const authority = engine.handController.getAuthoritativeActionState();
    engine.handController.getAuthoritativeActionState = () => ({
      ...authority,
      legalActions: ['fold', 'call', 'raise', 'all_in'],
      toCall: 20,
      minRaiseTo: 40,
    });
    vi.spyOn(ServerTableEngineTurns, 'secondLookPlan').mockReturnValue({
      ok: true,
      afterMs: 100,
    });
    decisionWorker.decideFast.mockImplementationOnce(async (s: any) => response(s, fast, 'call'));
    let release: (v: any) => void = () => {};
    let deepSnapshot: any;
    decisionWorker.worker.decideDeep.mockImplementationOnce((s: any) => {
      deepSnapshot = s;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(100);
    expect(decisionWorker.worker.decideDeep).toHaveBeenCalledOnce();
    if (mode === 'after_commit') await vi.advanceTimersByTimeAsync(1000);
    if (mode === 'cancelled') engine.cancelHorseDecisionWork();
    const result = response(
      deepSnapshot,
      deep,
      mode === 'unchanged' ? 'call' : 'fold',
      mode === 'unchanged' ? 20 : undefined,
      'deep'
    );
    if (mode === 'brain_exception')
      Object.assign(result.decision, { policyFallback: 'brain_exception' });
    if (mode === 'generation') result.generation += 1;
    if (mode === 'fence') result.fence = 'retired';
    release({ ...result, type: 'DEEP_RESULT' });
    await vi.advanceTimersByTimeAsync(1100);
    expect(fast.executionStatus).toBe(
      mode === 'accepted' || mode === 'cancelled' ? 'not_executed' : 'intended'
    );
    expect(deep.executionStatus).toBe(mode === 'accepted' ? 'intended' : 'not_executed');
    // DEEP only replaces call/fold/all-in. Its retired FAST cannot supply plans.
    expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
    if (mode === 'cancelled') expect(performAction).not.toHaveBeenCalled();
    else {
      expect(performAction).toHaveBeenCalledOnce();
      expect(performAction.mock.calls[0][1]).toBe(mode === 'accepted' ? 'fold' : 'call');
    }
    expect(mode === 'accepted' ? fast.executedAction : deep.executedAction).toBeNull();
    const retirementFeature = {
      tournamentUtility: 'phase7_utility_not_executed',
      tournamentPostflop: 'phase8_execution_not_executed',
      plo4Policy: 'phase10_execution_not_executed',
      omahaVariantPolicy: 'phase11_execution_not_executed',
      remainingVariantPolicy: 'phase12_execution_not_executed',
      jointPolicy: 'phase13_execution_not_executed',
      executionWitness: 'phase15_execution_not_executed',
    }[policyKey];
    expect(drainFires().find(({ feature }) => feature === retirementFeature)?.fires).toBe(
      mode === 'cancelled' ? 2 : 1
    );
  });
  it.each(['coerced', 'rejected'] as const)(
    'reports %s at the actual action boundary',
    async (mode) => {
      const { engine, player, enginePlayer, state, performAction } = harness(true);
      const receipt = ledger('bet', 20);
      if (mode === 'coerced') {
        engine.tableInfo.all_in_or_fold = true;
        state.stage = 'preflop' as any;
      } else performAction.mockReset().mockReturnValue(false);
      decisionWorker.decideFast.mockImplementationOnce(async (s: any) =>
        response(s, receipt, 'bet')
      );
      engine.scheduleHorseAction(player, 1, enginePlayer, state);
      await vi.advanceTimersByTimeAsync(1250);
      expect(receipt.executionStatus).toBe(mode === 'coerced' ? 'coerced' : 'not_executed');
      expect(receipt.executedAction).toBe(mode === 'coerced' ? 'all_in' : null);
    }
  );
  it('retires a cancelled turn immediately even though its action timer never runs', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    const receipt = ledger('bet', 20);
    decisionWorker.decideFast.mockImplementationOnce(async (s: any) => response(s, receipt, 'bet'));
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(0);
    expect(receipt.executionStatus).toBe('pending');
    engine.cancelHorseDecisionWork();
    expect(engine.horseActionTimer).toBeNull();
    expect(receipt.executionStatus).toBe('not_executed');
    expect(receipt.executedAction).toBeNull();
    expect(receipt.executedAmount).toBeNull();
    engine.cancelHorseDecisionWork();
    await vi.advanceTimersByTimeAsync(2000);
    expect(receipt.executionStatus).toBe('not_executed');
    expect(performAction).not.toHaveBeenCalled();
    expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
  });
});

// Each phase reconciles through the same real scheduled action boundary.
describe.each(['remainingVariantPolicy', 'jointPolicy'] as const)(
  '%s authoritative execution receipts',
  (policyKey) => {
    it.each(['generation', 'fence'] as const)(
      'retires every ledger on an early %s mismatch without executing an action',
      async (mismatch) => {
        const { engine, player, enginePlayer, state, performAction } = harness(true);
        const ledgers = Object.fromEntries(
          [
            'tournamentUtility',
            'tournamentPostflop',
            'plo4Policy',
            'omahaVariantPolicy',
            'remainingVariantPolicy',
            'jointPolicy',
          ].map((key) => [
            key,
            {
              variant: 'flo8',
              finalAction: 'bet',
              finalAmount: 20,
              executedAction: null,
              executedAmount: null,
              executionStatus: 'pending',
            },
          ])
        );
        decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => ({
          type: 'FAST_RESULT' as const,
          planIssueDisposition: 'no_effects' as const,
          planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 45 }),
          requestId: 45,
          generation: snapshot.generation + Number(mismatch === 'generation'),
          fence: mismatch === 'fence' ? 'retired-fence' : snapshot.fence,
          decision: { action: 'bet' as const, amount: 20, thinkTime: 1, ...ledgers },
          rngBefore: 11,
          rngAfter: 22,
          computeMs: 2,
          governorScale: 1,
          effects: [],
        }));
        engine.scheduleHorseAction(player, 1, enginePlayer, state);
        await vi.advanceTimersByTimeAsync(250);
        for (const ledger of Object.values(ledgers))
          expect(ledger.executionStatus).toBe('not_executed');
        expect(performAction).not.toHaveBeenCalled();
        expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
      }
    );
    it.each([
      [true, 'intended', 'bet'],
      [false, 'fallback', 'check'],
    ] as const)(
      'records the authoritative Phase 12 execution receipt (%s -> %s)',
      async (accepted, expectedStatus, expectedAction) => {
        const { engine, player, enginePlayer, state, performAction } = harness(accepted);
        const receipt: any = {
          finalAction: 'bet',
          finalAmount: 20,
          executedAction: null,
          executedAmount: null,
          executionStatus: 'pending',
        };
        decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => ({
          type: 'FAST_RESULT' as const,
          planIssueDisposition: 'no_effects' as const,
          planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 41 }),
          requestId: 41,
          generation: snapshot.generation,
          fence: snapshot.fence,
          decision: {
            action: 'bet' as const,
            amount: 20,
            thinkTime: 1,
            [policyKey]: receipt,
          },
          rngBefore: 11,
          rngAfter: 22,
          computeMs: 2,
          governorScale: 1,
          effects: [],
        }));

        engine.scheduleHorseAction(player, 1, enginePlayer, state);
        await vi.advanceTimersByTimeAsync(250);

        expect(receipt.executionStatus).toBe(expectedStatus);
        expect(receipt.executedAction).toBe(expectedAction);
        expect(receipt.executedAmount).toBe(expectedAction === 'bet' ? 20 : null);
        expect(performAction).toHaveBeenCalledTimes(accepted ? 1 : 2);
      }
    );

    it('closes a pending Phase 12 receipt when the authority fence expires before commit', async () => {
      const { engine, player, enginePlayer, state, performAction } = harness(true);
      const receipt: any = {
        finalAction: 'bet',
        finalAmount: 20,
        executedAction: null,
        executedAmount: null,
        executionStatus: 'pending',
      };
      decisionWorker.decideFast.mockImplementationOnce(async (snapshot: any) => ({
        type: 'FAST_RESULT' as const,
        planIssueDisposition: 'no_effects' as const,
        planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 42 }),
        requestId: 42,
        generation: snapshot.generation,
        fence: snapshot.fence,
        decision: {
          action: 'bet' as const,
          amount: 20,
          thinkTime: 1_000,
          [policyKey]: receipt,
        },
        rngBefore: 11,
        rngAfter: 22,
        computeMs: 2,
        governorScale: 1,
        effects: [],
      }));

      engine.scheduleHorseAction(player, 1, enginePlayer, state);
      await vi.advanceTimersByTimeAsync(0);
      engine.handCount += 1;
      await vi.advanceTimersByTimeAsync(1_500);

      expect(receipt.executionStatus).toBe('not_executed');
      expect(receipt.executedAction).toBeNull();
      expect(receipt.executedAmount).toBeNull();
      expect(performAction).not.toHaveBeenCalled();
    });
  }
);

describe('Phase 8.3 acceptance-time authority recheck', () => {
  let approval = 200;
  beforeEach(() => {
    enableBrainTelemetry();
    drainFires();
  });
  /** A fresh, greater approval renews the process gate after any withdrawal. */
  function authority() {
    approval += 1;
    phase8Main.admission = qualifiedTestAdmission(approval);
    liveHorsePhase8Authority.refresh();
    const worker = new HorseQualifiedAuthorityHolder(`turns-worker-${approval}`);
    worker.apply(qualifiedTestAdmission(approval));
    liveHorsePhase8Authority.observeWorker(worker.receipt());
    return worker;
  }
  const ledger = (
    worker: HorseQualifiedAuthorityHolder,
    candidate: { action: string; amount: number | null },
    baseline: { action: string; amount: number | null }
  ) => ({
    version: 'horse-tournament-postflop-round1-v4',
    mode: 'candidate',
    changed: true,
    applied: true,
    selection: 'selected',
    authority: liveHorsePhase8Authority.stamp(worker.receipt()),
    authorityVerdict: null,
    baselineAction: baseline.action,
    baselineAmount: baseline.amount,
    candidateAction: candidate.action,
    candidateAmount: candidate.amount,
    executionStatus: 'pending',
    executedAction: null,
    executedAmount: null,
  });
  const result = (snapshot: any, receipt: any, lane: 'fast' | 'deep' = 'fast'): any => {
    const decision: any = {
      action: receipt.candidateAction,
      ...(receipt.candidateAmount === null ? {} : { amount: receipt.candidateAmount }),
      thinkTime: 1000,
      tournamentPostflop: receipt,
    };
    decision.executionWitness = createHorseExecutionWitness(snapshot, decision, {
      requestId: 91,
      lane,
      computeMs: 2,
      governorScale: 1,
    });
    return {
      type: lane === 'fast' ? ('FAST_RESULT' as const) : ('DEEP_RESULT' as const),
      planIssueDisposition: 'no_effects' as const,
      planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 91 }),
      requestId: 91,
      generation: snapshot.generation,
      fence: snapshot.fence,
      decision,
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 2,
      governorScale: 1,
      effects: [],
    };
  };

  it('accepts a selected candidate under usable authority and records controller acceptance', async () => {
    const worker = authority();
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    const receipt = ledger(
      worker,
      { action: 'check', amount: null },
      { action: 'bet', amount: 20 }
    );
    let witness: any;
    decisionWorker.decideFast.mockImplementationOnce(async (s: any) => {
      const r = result(s, receipt);
      witness = r.decision.executionWitness;
      return r;
    });
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(1250);
    expect(performAction).toHaveBeenCalledOnce();
    expect(performAction.mock.calls[0][1]).toBe('check');
    expect(receipt).toMatchObject({
      applied: true,
      selection: 'controller_accepted',
      authorityVerdict: 'usable',
      executionStatus: 'intended',
    });
    expect(witness.executionStatus).toBe('intended');
    expect(witness.phase8Authority).toMatchObject({
      selection: 'controller_accepted',
      verdict: 'usable',
    });
    const fires = drainFires().map(({ feature }) => feature);
    expect(fires).toContain('phase8_selection_controller_accepted');
  });

  it.each(['withdrawn', 'stale_generation', 'restarted', 'refresh_failed'] as const)(
    'authority %s during think time executes the reference with an exact accepted-wager receipt',
    async (verdict) => {
      const worker = authority();
      const { engine, player, enginePlayer, state, performAction } = harness(true);
      const receipt = ledger(
        worker,
        { action: 'check', amount: null },
        { action: 'bet', amount: 20 }
      );
      let witness: any;
      decisionWorker.decideFast.mockImplementationOnce(async (s: any) => {
        const r = result(s, receipt);
        witness = r.decision.executionWitness;
        return r;
      });
      engine.scheduleHorseAction(player, 1, enginePlayer, state);
      await vi.advanceTimersByTimeAsync(0);
      expect(receipt.executionStatus).toBe('pending');
      if (verdict === 'withdrawn') liveHorsePhase8Authority.withdraw('test_withdrawal');
      if (verdict === 'stale_generation') {
        worker.apply({ status: 'refused', reason: 'unreadable_evidence', transient: true });
        worker.apply(qualifiedTestAdmission(approval));
        liveHorsePhase8Authority.observeWorker(worker.receipt());
      }
      if (verdict === 'restarted') liveHorsePhase8Authority.forgetWorker(worker.epoch);
      if (verdict === 'refresh_failed') {
        phase8Main.admission = {
          status: 'refused',
          reason: 'unreadable_evidence',
          transient: true,
        };
        liveHorsePhase8Authority.refresh();
      }
      await vi.advanceTimersByTimeAsync(1250);
      expect(performAction).toHaveBeenCalledOnce();
      expect(performAction.mock.calls[0].slice(1, 4)).toEqual(['bet', 20, 'horse_policy']);
      expect(receipt).toMatchObject({
        applied: false,
        selection: 'withdrawn_before_acceptance',
        authorityVerdict: verdict,
        executionStatus: 'intended',
        executedAction: 'bet',
        executedAmount: 20,
      });
      // The witness was re-selected before acceptance, so the controller
      // record matches it exactly and is not misreported as coerced.
      expect(witness.selected).toEqual({ action: 'bet', amount: 20 });
      expect(witness.executionStatus).toBe('intended');
      expect(witness.phase8Authority).toMatchObject({
        selection: 'withdrawn_before_acceptance',
        verdict,
        candidate: { action: 'check', amount: null },
      });
      expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
      expect(drainFires().map(({ feature }) => feature)).toEqual(
        expect.arrayContaining([
          'phase8_selection_withdrawn_before_acceptance',
          `phase8_authority_verdict_${verdict}`,
        ])
      );
    }
  );

  it('deep work selected before a withdrawal cannot act after it', async () => {
    const worker = authority();
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    state.currentBet = 20;
    const base = engine.handController.getAuthoritativeActionState();
    engine.handController.getAuthoritativeActionState = () => ({
      ...base,
      legalActions: ['fold', 'call', 'raise', 'all_in'],
      toCall: 20,
      minRaiseTo: 40,
    });
    vi.spyOn(ServerTableEngineTurns, 'secondLookPlan').mockReturnValue({ ok: true, afterMs: 100 });
    decisionWorker.decideFast.mockImplementationOnce(async (s: any) => ({
      ...result(s, { candidateAction: 'call', candidateAmount: 20 }),
      decision: { action: 'call', amount: 20, thinkTime: 1000 },
    }));
    const deepReceipt = ledger(
      worker,
      { action: 'fold', amount: null },
      { action: 'call', amount: 20 }
    );
    let deepWitness: any;
    decisionWorker.worker.decideDeep.mockImplementationOnce(async (s: any) => {
      const r = result(s, deepReceipt, 'deep');
      deepWitness = r.decision.executionWitness;
      return r;
    });
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(150);
    expect(decisionWorker.worker.decideDeep).toHaveBeenCalledOnce();
    expect(deepReceipt.executionStatus).toBe('pending');
    liveHorsePhase8Authority.withdraw('withdrawn_during_think_time');
    await vi.advanceTimersByTimeAsync(1200);
    expect(performAction).toHaveBeenCalledOnce();
    expect(performAction.mock.calls[0].slice(1, 3)).toEqual(['call', 20]);
    expect(deepReceipt).toMatchObject({
      selection: 'withdrawn_before_acceptance',
      authorityVerdict: 'withdrawn',
      executionStatus: 'intended',
    });
    expect(deepWitness.executionStatus).toBe('intended');
    expect(deepWitness.selected).toEqual({ action: 'call', amount: 20 });
  });

  it('a controller refusal of a selected candidate withdraws authority for this process', async () => {
    const worker = authority();
    const { engine, player, enginePlayer, state } = harness(false);
    const receipt = ledger(
      worker,
      { action: 'bet', amount: 20 },
      { action: 'check', amount: null }
    );
    decisionWorker.decideFast.mockImplementationOnce(async (s: any) => result(s, receipt));
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(1250);
    expect(receipt.executionStatus).toBe('fallback');
    expect(receipt.selection).toBe('selected');
    expect(liveHorsePhase8Authority.mainState()).toBe('withdrawn');
    // Later work admitted under that worker generation is now refused.
    expect(liveHorsePhase8Authority.check(liveHorsePhase8Authority.stamp(worker.receipt()))).toBe(
      'withdrawn'
    );
  });
});

describe('P10.3 acceptance-time Phase 10 authority recheck (the Phase 8 law)', () => {
  let approval = 300;
  beforeEach(() => {
    enableBrainTelemetry();
    drainFires();
  });
  function authority() {
    approval += 1;
    phase10Main.admission = qualifiedPhase10TestAdmission(approval);
    liveHorsePhase10Authority.refresh();
    const worker = new HorseQualifiedAuthorityHolder(
      `turns-p10-worker-${approval}`,
      'plo4-policy-round1-v3'
    );
    worker.apply(qualifiedPhase10TestAdmission(approval));
    liveHorsePhase10Authority.observeWorker(worker.receipt());
    return worker;
  }
  const receiptFor = (
    worker: HorseQualifiedAuthorityHolder | null,
    proposal: { action: string; amount: number | null },
    baseline: { action: string; amount: number | null },
    selected = true
  ) => ({
    version: 'plo4-policy-round1-v3',
    mode: selected ? 'candidate' : 'shadow',
    eligible: true,
    fired: true,
    changed: true,
    applied: selected,
    selection: selected ? 'selected' : 'shadow_change',
    selectionRefusal: null,
    authority: worker ? liveHorsePhase10Authority.stamp(worker.receipt()) : null,
    authorityVerdict: null,
    baselineAction: baseline.action,
    baselineAmount: baseline.amount,
    proposalAction: proposal.action,
    proposalAmount: proposal.amount,
    finalAction: selected ? proposal.action : baseline.action,
    finalAmount: selected ? proposal.amount : baseline.amount,
    utilityOwner: 'cash',
    executionStatus: 'pending',
    executedAction: null,
    executedAmount: null,
  });
  const result = (snapshot: any, receipt: any): any => {
    const decision: any = {
      action: receipt.finalAction,
      ...(receipt.finalAmount === null ? {} : { amount: receipt.finalAmount }),
      thinkTime: 1000,
      plo4Policy: receipt,
    };
    decision.executionWitness = createHorseExecutionWitness(snapshot, decision, {
      requestId: 92,
      lane: 'fast',
      computeMs: 2,
      governorScale: 1,
    });
    return {
      type: 'FAST_RESULT' as const,
      planIssueDisposition: 'no_effects' as const,
      planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 92 }),
      requestId: 92,
      generation: snapshot.generation,
      fence: snapshot.fence,
      decision,
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 2,
      governorScale: 1,
      effects: [],
    };
  };

  it('accepts a selected PLO4 proposal under usable authority and records selected, accepted and baseline actions', async () => {
    const worker = authority();
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    const receipt = receiptFor(
      worker,
      { action: 'bet', amount: 20 },
      { action: 'check', amount: null }
    );
    let witness: any;
    decisionWorker.decideFast.mockImplementationOnce(async (s: any) => {
      const r = result(s, receipt);
      witness = r.decision.executionWitness;
      return r;
    });
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(1250);
    expect(performAction).toHaveBeenCalledOnce();
    expect(performAction.mock.calls[0].slice(1, 4)).toEqual(['bet', 20, 'horse_policy']);
    expect(receipt).toMatchObject({
      applied: true,
      selection: 'controller_accepted',
      authorityVerdict: 'usable',
      executionStatus: 'intended',
      executedAction: 'bet',
      executedAmount: 20,
    });
    expect(witness.executionStatus).toBe('intended');
    expect(witness.selected).toEqual({ action: 'bet', amount: 20 });
    expect(witness.phase10Authority).toMatchObject({
      continuationVersion: 'plo4-policy-round1-v3',
      mode: 'candidate',
      selection: 'controller_accepted',
      verdict: 'usable',
      candidate: { action: 'bet', amount: 20 },
      reference: { action: 'check', amount: null },
    });
    expect(witness.acceptedActions[0].record).toMatchObject({ action: 'bet', amount: 20 });
    expect(drainFires().map(({ feature }) => feature)).toEqual(
      expect.arrayContaining([
        'phase10_authority_verdict_usable',
        'phase10_selection_controller_accepted',
      ])
    );
  });

  it.each(['withdrawn', 'stale_generation', 'restarted', 'refresh_failed'] as const)(
    'Phase 10 authority %s during think time executes the shadow baseline exactly',
    async (verdict) => {
      const worker = authority();
      const { engine, player, enginePlayer, state, performAction } = harness(true);
      const receipt = receiptFor(
        worker,
        { action: 'check', amount: null },
        { action: 'bet', amount: 20 }
      );
      let witness: any;
      decisionWorker.decideFast.mockImplementationOnce(async (s: any) => {
        const r = result(s, receipt);
        witness = r.decision.executionWitness;
        return r;
      });
      engine.scheduleHorseAction(player, 1, enginePlayer, state);
      await vi.advanceTimersByTimeAsync(0);
      expect(receipt.executionStatus).toBe('pending');
      if (verdict === 'withdrawn') liveHorsePhase10Authority.withdraw('test_withdrawal');
      if (verdict === 'stale_generation') {
        worker.apply({ status: 'refused', reason: 'unreadable_evidence', transient: true });
        worker.apply(qualifiedPhase10TestAdmission(approval));
        liveHorsePhase10Authority.observeWorker(worker.receipt());
      }
      if (verdict === 'restarted') liveHorsePhase10Authority.forgetWorker(worker.epoch);
      if (verdict === 'refresh_failed') {
        phase10Main.admission = {
          status: 'refused',
          reason: 'unreadable_evidence',
          transient: true,
        };
        liveHorsePhase10Authority.refresh();
      }
      await vi.advanceTimersByTimeAsync(1250);
      expect(performAction).toHaveBeenCalledOnce();
      expect(performAction.mock.calls[0].slice(1, 4)).toEqual(['bet', 20, 'horse_policy']);
      expect(receipt).toMatchObject({
        applied: false,
        selection: 'withdrawn_before_acceptance',
        authorityVerdict: verdict,
        finalAction: 'bet',
        finalAmount: 20,
        executionStatus: 'intended',
        executedAction: 'bet',
        executedAmount: 20,
      });
      expect(witness.selected).toEqual({ action: 'bet', amount: 20 });
      expect(witness.executionStatus).toBe('intended');
      expect(witness.phase10Authority).toMatchObject({
        selection: 'withdrawn_before_acceptance',
        verdict,
        candidate: { action: 'check', amount: null },
        reference: { action: 'bet', amount: 20 },
      });
      expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
      expect(drainFires().map(({ feature }) => feature)).toEqual(
        expect.arrayContaining([
          'phase10_selection_withdrawn_before_acceptance',
          `phase10_authority_verdict_${verdict}`,
        ])
      );
    }
  );

  it('a controller refusal of a selected PLO4 proposal withdraws Phase 10 authority for this process', async () => {
    const worker = authority();
    const { engine, player, enginePlayer, state } = harness(false);
    const receipt = receiptFor(
      worker,
      { action: 'bet', amount: 20 },
      { action: 'check', amount: null }
    );
    decisionWorker.decideFast.mockImplementationOnce(async (s: any) => result(s, receipt));
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(1250);
    expect(receipt.executionStatus).toBe('fallback');
    expect(receipt.selection).toBe('selected');
    expect(liveHorsePhase10Authority.mainState()).toBe('withdrawn');
    expect(liveHorsePhase10Authority.check(liveHorsePhase10Authority.stamp(worker.receipt()))).toBe(
      'withdrawn'
    );
  });

  it('a shadow PLO4 receipt is never rechecked and executes the baseline it already carries', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    const receipt = receiptFor(
      null,
      { action: 'bet', amount: 20 },
      { action: 'check', amount: null },
      false
    );
    let witness: any;
    decisionWorker.decideFast.mockImplementationOnce(async (s: any) => {
      const r = result(s, receipt);
      witness = r.decision.executionWitness;
      return r;
    });
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(1250);
    expect(performAction.mock.calls[0][1]).toBe('check');
    expect(receipt).toMatchObject({
      selection: 'shadow_change',
      authorityVerdict: null,
      executionStatus: 'intended',
    });
    expect(witness.phase10Authority).toMatchObject({
      mode: 'shadow',
      selection: 'shadow_change',
      verdict: null,
      candidate: { action: 'bet', amount: 20 },
      reference: { action: 'check', amount: null },
    });
    expect(drainFires().map(({ feature }) => feature)).not.toContain(
      'phase10_authority_verdict_usable'
    );
  });
});

describe('P11.3 acceptance-time Phase 11 authority recheck (the Phase 8 law, one gate per pack)', () => {
  let approval = 500;
  beforeEach(() => {
    enableBrainTelemetry();
    drainFires();
  });
  /** Usable authority for `variant` at its own main gate and a worker holder. */
  function authority(variant: 'plo5' | 'plo6' | 'plo8') {
    approval += 1;
    phase11Main.admission[variant] = qualifiedPhase11TestAdmission(variant, approval);
    liveHorsePhase11Authorities[variant].refresh();
    const worker = new HorseQualifiedAuthorityHolder(
      `turns-p11-worker-${approval}`,
      OMAHA_VARIANT_PACKS[variant].version
    );
    worker.apply(qualifiedPhase11TestAdmission(variant, approval));
    liveHorsePhase11Authorities[variant].observeWorker(worker.receipt());
    return worker;
  }
  const receiptFor = (
    variant: 'plo5' | 'plo6' | 'plo8',
    worker: HorseQualifiedAuthorityHolder | null,
    proposal: { action: string; amount: number | null },
    baseline: { action: string; amount: number | null },
    selected = true
  ) => ({
    version: OMAHA_VARIANT_PACKS[variant].version,
    variant,
    mode: selected ? 'candidate' : 'shadow',
    eligible: true,
    fired: true,
    changed: true,
    applied: selected,
    selection: selected ? 'selected' : 'shadow_change',
    selectionRefusal: null,
    authority: worker ? liveHorsePhase11Authorities[variant].stamp(worker.receipt()) : null,
    authorityVerdict: null,
    baselineAction: baseline.action,
    baselineAmount: baseline.amount,
    proposalAction: proposal.action,
    proposalAmount: proposal.amount,
    finalAction: selected ? proposal.action : baseline.action,
    finalAmount: selected ? proposal.amount : baseline.amount,
    utilityOwner: 'cash',
    executionStatus: 'pending',
    executedAction: null,
    executedAmount: null,
  });
  const result = (snapshot: any, receipt: any): any => {
    const decision: any = {
      action: receipt.finalAction,
      ...(receipt.finalAmount === null ? {} : { amount: receipt.finalAmount }),
      thinkTime: 1000,
      omahaVariantPolicy: receipt,
    };
    decision.executionWitness = createHorseExecutionWitness(snapshot, decision, {
      requestId: 93,
      lane: 'fast',
      computeMs: 2,
      governorScale: 1,
    });
    return {
      type: 'FAST_RESULT' as const,
      planIssueDisposition: 'no_effects' as const,
      planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 93 }),
      requestId: 93,
      generation: snapshot.generation,
      fence: snapshot.fence,
      decision,
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 2,
      governorScale: 1,
      effects: [],
    };
  };

  it.each(['plo5', 'plo6', 'plo8'] as const)(
    'accepts a selected %s proposal under usable authority and records selected, accepted and baseline actions',
    async (variant) => {
      const worker = authority(variant);
      const { engine, player, enginePlayer, state, performAction } = harness(true);
      const receipt = receiptFor(
        variant,
        worker,
        { action: 'bet', amount: 20 },
        { action: 'check', amount: null }
      );
      let witness: any;
      decisionWorker.decideFast.mockImplementationOnce(async (s: any) => {
        const r = result(s, receipt);
        witness = r.decision.executionWitness;
        return r;
      });
      engine.scheduleHorseAction(player, 1, enginePlayer, state);
      await vi.advanceTimersByTimeAsync(1250);
      expect(performAction).toHaveBeenCalledOnce();
      expect(performAction.mock.calls[0].slice(1, 4)).toEqual(['bet', 20, 'horse_policy']);
      expect(receipt).toMatchObject({
        applied: true,
        selection: 'controller_accepted',
        authorityVerdict: 'usable',
        executionStatus: 'intended',
        executedAction: 'bet',
        executedAmount: 20,
      });
      expect(witness.executionStatus).toBe('intended');
      expect(witness.selected).toEqual({ action: 'bet', amount: 20 });
      expect(witness.phase11Authority).toMatchObject({
        continuationVersion: OMAHA_VARIANT_PACKS[variant].version,
        mode: 'candidate',
        selection: 'controller_accepted',
        verdict: 'usable',
        candidate: { action: 'bet', amount: 20 },
        reference: { action: 'check', amount: null },
      });
      expect(witness.phase10Authority).toBeUndefined();
      expect(witness.acceptedActions[0].record).toMatchObject({ action: 'bet', amount: 20 });
      expect(drainFires().map(({ feature }) => feature)).toEqual(
        expect.arrayContaining([
          'phase11_authority_verdict_usable',
          'phase11_selection_controller_accepted',
        ])
      );
    }
  );

  it.each(['withdrawn', 'stale_generation', 'restarted', 'refresh_failed'] as const)(
    'Phase 11 authority %s during think time executes the shadow baseline exactly',
    async (verdict) => {
      const worker = authority('plo6');
      const gate = liveHorsePhase11Authorities.plo6;
      const { engine, player, enginePlayer, state, performAction } = harness(true);
      const receipt = receiptFor(
        'plo6',
        worker,
        { action: 'check', amount: null },
        { action: 'bet', amount: 20 }
      );
      let witness: any;
      decisionWorker.decideFast.mockImplementationOnce(async (s: any) => {
        const r = result(s, receipt);
        witness = r.decision.executionWitness;
        return r;
      });
      engine.scheduleHorseAction(player, 1, enginePlayer, state);
      await vi.advanceTimersByTimeAsync(0);
      expect(receipt.executionStatus).toBe('pending');
      if (verdict === 'withdrawn') gate.withdraw('test_withdrawal');
      if (verdict === 'stale_generation') {
        worker.apply({ status: 'refused', reason: 'unreadable_evidence', transient: true });
        worker.apply(qualifiedPhase11TestAdmission('plo6', approval));
        gate.observeWorker(worker.receipt());
      }
      if (verdict === 'restarted') gate.forgetWorker(worker.epoch);
      if (verdict === 'refresh_failed') {
        phase11Main.admission.plo6 = {
          status: 'refused',
          reason: 'unreadable_evidence',
          transient: true,
        };
        gate.refresh();
      }
      await vi.advanceTimersByTimeAsync(1250);
      expect(performAction).toHaveBeenCalledOnce();
      expect(performAction.mock.calls[0].slice(1, 4)).toEqual(['bet', 20, 'horse_policy']);
      expect(receipt).toMatchObject({
        applied: false,
        selection: 'withdrawn_before_acceptance',
        authorityVerdict: verdict,
        finalAction: 'bet',
        finalAmount: 20,
        executionStatus: 'intended',
        executedAction: 'bet',
        executedAmount: 20,
      });
      expect(witness.selected).toEqual({ action: 'bet', amount: 20 });
      expect(witness.executionStatus).toBe('intended');
      expect(witness.phase11Authority).toMatchObject({
        selection: 'withdrawn_before_acceptance',
        verdict,
        candidate: { action: 'check', amount: null },
        reference: { action: 'bet', amount: 20 },
      });
      expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
      expect(drainFires().map(({ feature }) => feature)).toEqual(
        expect.arrayContaining([
          'phase11_selection_withdrawn_before_acceptance',
          `phase11_authority_verdict_${verdict}`,
        ])
      );
    }
  );

  it('a selected receipt is checked at its own pack gate: usable PLO5 authority never accepts a PLO8 proposal', async () => {
    const plo5Worker = authority('plo5');
    // PLO8's gate is unselected; the receipt is stamped with the PLO5 receipt.
    phase11Main.admission.plo8 = null;
    liveHorsePhase11Authorities.plo8.refresh();
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    const receipt = {
      ...receiptFor('plo8', null, { action: 'bet', amount: 20 }, { action: 'check', amount: null }),
      authority: liveHorsePhase11Authorities.plo5.stamp(plo5Worker.receipt()),
    };
    decisionWorker.decideFast.mockImplementationOnce(async (s: any) => result(s, receipt));
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(1250);
    expect(performAction.mock.calls[0].slice(1, 4)).toEqual(['check', undefined, 'horse_policy']);
    expect(receipt).toMatchObject({
      applied: false,
      selection: 'withdrawn_before_acceptance',
      authorityVerdict: 'unselected',
      executedAction: 'check',
    });
    // The PLO5 gate itself is untouched and still usable for its own receipts.
    expect(
      liveHorsePhase11Authorities.plo5.check(
        liveHorsePhase11Authorities.plo5.stamp(plo5Worker.receipt())
      )
    ).toBe('usable');
  });

  it('a controller refusal of a selected proposal withdraws that pack only, for this process', async () => {
    const plo6Worker = authority('plo6');
    const plo8Worker = authority('plo8');
    const { engine, player, enginePlayer, state } = harness(false);
    const receipt = receiptFor(
      'plo6',
      plo6Worker,
      { action: 'bet', amount: 20 },
      { action: 'check', amount: null }
    );
    decisionWorker.decideFast.mockImplementationOnce(async (s: any) => result(s, receipt));
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(1250);
    expect(receipt.executionStatus).toBe('fallback');
    expect(receipt.selection).toBe('selected');
    expect(liveHorsePhase11Authorities.plo6.mainState()).toBe('withdrawn');
    expect(
      liveHorsePhase11Authorities.plo6.check(
        liveHorsePhase11Authorities.plo6.stamp(plo6Worker.receipt())
      )
    ).toBe('withdrawn');
    expect(liveHorsePhase11Authorities.plo8.mainState()).toBe('usable');
    expect(
      liveHorsePhase11Authorities.plo8.check(
        liveHorsePhase11Authorities.plo8.stamp(plo8Worker.receipt())
      )
    ).toBe('usable');
    expect(drainFires().map(({ feature }) => feature)).toContain(
      'phase11_authority_controller_withdrawn'
    );
  });

  it('a shadow Phase 11 receipt is never rechecked and executes the baseline it already carries', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);
    const receipt = receiptFor(
      'plo5',
      null,
      { action: 'bet', amount: 20 },
      { action: 'check', amount: null },
      false
    );
    let witness: any;
    decisionWorker.decideFast.mockImplementationOnce(async (s: any) => {
      const r = result(s, receipt);
      witness = r.decision.executionWitness;
      return r;
    });
    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(1250);
    expect(performAction.mock.calls[0][1]).toBe('check');
    expect(receipt).toMatchObject({
      selection: 'shadow_change',
      authorityVerdict: null,
      executionStatus: 'intended',
    });
    expect(witness.phase11Authority).toMatchObject({
      mode: 'shadow',
      selection: 'shadow_change',
      verdict: null,
      candidate: { action: 'bet', amount: 20 },
      reference: { action: 'check', amount: null },
    });
    expect(
      drainFires()
        .map(({ feature }) => feature)
        .filter((f) => f.startsWith('phase11_authority_'))
    ).toEqual([]);
  });
});
