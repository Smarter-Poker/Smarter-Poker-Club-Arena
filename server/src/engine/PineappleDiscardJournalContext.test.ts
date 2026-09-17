import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const worker = vi.hoisted(() => ({ decideDiscard: vi.fn(), observeDiscardExecution: vi.fn() }));
vi.mock('./horseDecision/index.js', async (original) => ({
  ...(await original<typeof import('./horseDecision/index.js')>()),
  getLiveHorseDecisionWorker: () => worker,
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../services/financialAlerts.js', () => ({
  raiseFinancialAlert: vi.fn(async () => ({ persisted: true, alertId: 'test' })),
}));

import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import { captureHorseHandJournalContext } from './HorseDecisionHandBinding.js';
import { validateHorseDiscardExecution } from '../services/horseDecisionJournal/discard.js';
import type { Card, HandConfig, SeatPlayer } from '../types.js';

const TABLE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const ACTOR = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const HUMAN = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CARDS: Card[] = [
  { rank: 'A', suit: 'hearts' },
  { rank: 'K', suit: 'hearts' },
  { rank: '2', suit: 'clubs' },
];
const FLOP: Card[] = [
  { rank: 'Q', suit: 'hearts' },
  { rank: '7', suit: 'spades' },
  { rank: '3', suit: 'diamonds' },
];
const PRIOR = [
  { seat: 10, userId: ACTOR, action: 'call', amount: 2, timestamp: 1_000, stage: 'preflop' },
];

function harness() {
  let owes = true;
  const controller = {
    getState: () => ({
      stage: 'pineapple_discard',
      communityCards: FLOP,
      players: [{ seat: 10, user_id: ACTOR, cards: CARDS, is_folded: false }],
    }),
    owesPineappleDiscard: () => owes,
    allPineappleDiscardsIn: () => !owes,
    performDiscard: vi.fn(() => {
      owes = false;
      return true;
    }),
    cancelPineappleSettle: vi.fn(),
    getPineappleRunoutDiscardSnapshot: () => ({
      flop: FLOP,
      players: [{ seat: 10, cards: CARDS }],
    }),
    preparePineappleRunoutDiscards: vi.fn(() => true),
  };
  const engine = new ServerTableEngine(TABLE) as any;
  engine.running = true;
  engine.handCount = 41;
  engine.handController = controller;
  engine.tableInfo = { action_time_seconds: 15 };
  engine.seatedPlayers = [{ seat_number: 10, user_id: ACTOR, is_horse: true }];
  engine.currentHandActions = structuredClone(PRIOR);
  engine.lifecycleCanMutate = () => true;
  engine.getEngineLeaseAuthority = () => ({ verified: true, generation: '17' });
  engine.activeHandVariant = () => 'pineapple';
  return { engine, controller };
}

beforeEach(() => {
  worker.decideDiscard.mockReset();
  worker.observeDiscardExecution.mockReset();
  worker.decideDiscard.mockImplementation(async (snapshot) => ({
    type: 'DISCARD_RESULT',
    requestId: 23,
    generation: snapshot.generation,
    fence: snapshot.fence,
    cardIndex: 1,
    computeMs: 5,
    governorScale: 1,
  }));
});

function realHarness(forced: boolean, leaseGeneration = '17') {
  const players = [ACTOR, HUMAN].map((user_id, index) => ({
    user_id,
    seat: index + 1,
    username: `Player ${index + 1}`,
    stack: 100,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const controller = new HandController(
    {
      tableId: TABLE,
      handNumber: 41,
      gameVariant: 'pineapple',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  controller.start();
  if (forced) {
    for (const player of (controller as any).state.players) player.is_all_in = true;
  } else {
    for (let step = 0; step < 8 && controller.getState().stage === 'preflop'; step++) {
      const state = controller.getState();
      const player = state.players.find((entry) => entry.seat === state.currentPlayerSeat)!;
      expect(
        controller.performAction(player.seat, player.bet < state.currentBet ? 'call' : 'check')
      ).toBe(true);
    }
    expect(controller.getState().stage).toBe('pineapple_discard');
  }
  const { engine } = harness();
  engine.getEngineLeaseAuthority = () => ({ verified: true, generation: leaseGeneration });
  engine.handController = controller;
  engine.seatedPlayers = players.map((player) => ({
    seat_number: player.seat,
    user_id: player.user_id,
    is_horse: player.user_id === ACTOR,
  }));
  engine.currentHandActions = structuredClone(controller.getState().actionHistory);
  // The real accepted records enter the same producer prefix synchronously.
  // This test isolates Runout's private capture from persistence / public I/O.
  controller.onEvent((event) => {
    if (event.type === 'PLAYER_ACTION' && event.record)
      engine.currentHandActions.push({ ...event.record });
  });
  return { engine, controller };
}

describe('Runout binds only actual private controller acceptance', () => {
  it.each(['17', '50000000-0000-4000-8000-000000000001'])(
    'captures a normal accepted choice after an intervening human discard using the actual request id and lease %s',
    async (leaseGeneration) => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const { engine, controller } = realHarness(false, leaseGeneration);
      let resolve!: (value: unknown) => void;
      worker.decideDiscard.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      );
      engine.handlePineappleDiscard({ type: 'PINEAPPLE_DISCARD_REQUIRED', seats: [1, 2] });
      await vi.advanceTimersByTimeAsync(1_201);
      const request = worker.decideDiscard.mock.calls[0]![0];
      expect(controller.performDiscard(2, 0)).toBe(true);
      const acceptedPrefix = captureHorseHandJournalContext(engine.currentHandActions);
      expect(acceptedPrefix!.actionCount).toBe(request.journalContext.priorActions.actionCount + 1);
      resolve({
        type: 'DISCARD_RESULT',
        requestId: 97,
        generation: request.generation,
        fence: request.fence,
        cardIndex: 1,
        computeMs: 5,
        governorScale: 1,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(worker.observeDiscardExecution).toHaveBeenCalledTimes(1);
      const execution = worker.observeDiscardExecution.mock.calls[0]![0];
      expect(() => validateHorseDiscardExecution(execution)).not.toThrow();
      expect(execution.request).toEqual({ ...request, type: 'DECIDE_DISCARD', requestId: 97 });
      expect(execution).toMatchObject({
        version: 1,
        selectedIndex: 1,
        priorActions: acceptedPrefix,
        acceptedActionOrdinal: acceptedPrefix!.actionCount,
        controller: {
          actorId: ACTOR,
          seat: 1,
          chosenIndex: 1,
          originalCards: request.cards,
          discardedCard: request.cards[1],
          retainedCards: request.cards.filter((_: Card, index: number) => index !== 1),
          communityCards: request.communityCards,
          acceptedRecord: {
            userId: ACTOR,
            seat: 1,
            action: 'discard',
            amount: 0,
            stage: 'pineapple_discard',
          },
        },
      });
      expect(engine.currentHandActions[execution.acceptedActionOrdinal]).toEqual(
        execution.controller.acceptedRecord
      );
      engine.clearLooseHandTimers();
    }
  );

  it.each(['17', '50000000-0000-4000-8000-000000000001'])(
    'emits no accepted journal during preparation, then captures the exact forced commit for the horse only with lease %s',
    async (leaseGeneration) => {
      const { engine, controller } = realHarness(true, leaseGeneration);
      const flop = controller.getPineappleRunoutDiscardSnapshot()!.flop;
      expect(await engine.preparePineappleRunoutDiscards(controller)).toBe(true);
      expect(worker.decideDiscard).toHaveBeenCalledTimes(2);
      expect(worker.observeDiscardExecution).not.toHaveBeenCalled();
      expect(controller.commitPreparedPineappleRunoutDiscards(flop)).toBe(true);
      expect(worker.observeDiscardExecution).toHaveBeenCalledTimes(1);
      const execution = worker.observeDiscardExecution.mock.calls[0]![0];
      expect(() => validateHorseDiscardExecution(execution)).not.toThrow();
      expect(execution.request.journalContext).toMatchObject({
        actorId: ACTOR,
        seat: 1,
        lane: 'forced_runout',
      });
      expect(execution.controller).toMatchObject({
        chosenIndex: 1,
        discardedCard: execution.request.cards[1],
        communityCards: flop,
      });
      expect(engine.currentHandActions[execution.acceptedActionOrdinal]).toEqual(
        execution.controller.acceptedRecord
      );
      expect(controller.getState().players.map((player) => player.cards.length)).toEqual([2, 2]);
      engine.clearLooseHandTimers();
    }
  );

  it('removes private observers when the controller refuses preparation', async () => {
    const { engine, controller } = realHarness(true);
    const flop = controller.getPineappleRunoutDiscardSnapshot()!.flop;
    const prepare = vi
      .spyOn(controller, 'preparePineappleRunoutDiscards')
      .mockReturnValueOnce(false);
    expect(await engine.preparePineappleRunoutDiscards(controller)).toBe(false);
    prepare.mockRestore();
    // An unrelated later controller choice must not be attached to the refused request.
    expect(
      controller.preparePineappleRunoutDiscards(
        flop,
        new Map([
          [1, 2],
          [2, 0],
        ])
      )
    ).toBe(true);
    expect(controller.commitPreparedPineappleRunoutDiscards(flop)).toBe(true);
    expect(worker.observeDiscardExecution).not.toHaveBeenCalled();
    engine.clearLooseHandTimers();
  });

  it.each(['teardown', 'lease_move'])(
    'does not journal a prepared choice after %s',
    async (reason) => {
      const { engine, controller } = realHarness(true);
      const flop = controller.getPineappleRunoutDiscardSnapshot()!.flop;
      expect(await engine.preparePineappleRunoutDiscards(controller)).toBe(true);
      if (reason === 'teardown') engine.clearLooseHandTimers();
      else engine.getEngineLeaseAuthority = () => ({ verified: true, generation: '18' });
      expect(controller.commitPreparedPineappleRunoutDiscards(flop)).toBe(true);
      expect(worker.observeDiscardExecution).not.toHaveBeenCalled();
      engine.clearLooseHandTimers();
    }
  );

  it('rejects a stale normal worker response before either card mutation or acceptance publication', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { engine, controller } = realHarness(false);
    let resolve!: (value: unknown) => void;
    worker.decideDiscard.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    engine.handlePineappleDiscard({ type: 'PINEAPPLE_DISCARD_REQUIRED', seats: [1, 2] });
    await vi.advanceTimersByTimeAsync(1_201);
    const request = worker.decideDiscard.mock.calls[0]![0];
    engine.clearLooseHandTimers();
    resolve({
      type: 'DISCARD_RESULT',
      requestId: 99,
      generation: request.generation,
      fence: request.fence,
      cardIndex: 1,
      computeMs: 5,
      governorScale: 1,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.getState().players[0]!.cards).toHaveLength(3);
    expect(worker.observeDiscardExecution).not.toHaveBeenCalled();
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('private discard authoritative journal context', () => {
  it('captures the real horse, lease and full action prefix without changing the choice fence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { engine, controller } = harness();
    engine.handlePineappleDiscard({ type: 'PINEAPPLE_DISCARD_REQUIRED', seats: [10] });
    await vi.advanceTimersByTimeAsync(1_201);
    const snapshot = worker.decideDiscard.mock.calls[0]![0];
    expect(snapshot.journalContext).toEqual({
      version: 1,
      tableId: TABLE,
      handNumber: 41,
      leaseGeneration: '17',
      actorId: ACTOR,
      seat: 10,
      requestedAtMs: 11_200,
      lane: 'choice',
      priorActions: captureHorseHandJournalContext(PRIOR),
    });
    expect(snapshot.fence).toBe(
      `${TABLE}:41:pineapple-discard:10:17:1:A:hearts|K:hearts|2:clubs:Q:hearts|7:spades|3:diamonds`
    );
    expect(controller.performDiscard).toHaveBeenCalledWith(10, 1);
    expect(worker.observeDiscardExecution).not.toHaveBeenCalled();
    engine.clearLooseHandTimers();
  });

  it('captures forced-runout identity while preparation remains distinct from acceptance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { engine, controller } = harness();
    expect(await engine.preparePineappleRunoutDiscards(controller)).toBe(true);
    const snapshot = worker.decideDiscard.mock.calls[0]![0];
    expect(snapshot.journalContext).toEqual({
      version: 1,
      tableId: TABLE,
      handNumber: 41,
      leaseGeneration: '17',
      actorId: ACTOR,
      seat: 10,
      requestedAtMs: 10_000,
      lane: 'forced_runout',
      priorActions: captureHorseHandJournalContext(PRIOR),
    });
    expect(controller.performDiscard).not.toHaveBeenCalled();
    engine.clearLooseHandTimers();
  });

  it.each(['isolated', 'human', 'actor_mismatch', 'invalid_prior'])(
    'does not manufacture a journal identity for %s context',
    async (caseName) => {
      const { engine, controller } = harness();
      if (caseName === 'isolated') engine.getEngineLeaseAuthority = () => null;
      if (caseName === 'human') engine.seatedPlayers[0].is_horse = false;
      if (caseName === 'actor_mismatch') engine.seatedPlayers[0].user_id = TABLE;
      if (caseName === 'invalid_prior') engine.currentHandActions[0].userId = 'legacy-fixture';
      expect(await engine.preparePineappleRunoutDiscards(controller)).toBe(true);
      expect(worker.decideDiscard.mock.calls[0]![0].journalContext).toBeNull();
      engine.clearLooseHandTimers();
    }
  );
});
