import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const worker = vi.hoisted(() => ({ decideDiscard: vi.fn() }));
const equityWorker = vi.hoisted(() => ({
  estimateEquity: vi.fn(async (hands: unknown[][], _board?: unknown[], _dead?: unknown[]) =>
    hands.map(() => 1 / hands.length)
  ),
  estimateLayeredEquity: vi.fn(
    async (
      hands: unknown[][],
      _playerIds: string[],
      _playerSeats: number[],
      _boards: Card[][],
      _dead: Card[],
      _iters: number,
      _variant: string,
      pots: Array<{ amount: number }>,
      _dealerSeat: number,
      totalWinnings: number
    ) => ({
      equities: hands.map(() => 1 / hands.length),
      layerEquities: pots.map(() => hands.map(() => 1 / hands.length)),
      expectedNetReturns: hands.map(() => totalWinnings / hands.length),
      strictLossPcts: hands.map(() => 50),
      pushPcts: hands.map(() => 0),
      seed: 424242,
      exact: true,
      runouts: 1,
    })
  ),
}));

vi.mock('./horseDecision/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./horseDecision/index.js')>()),
  getLiveHorseDecisionWorker: () => worker,
}));

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('./equity/EquityWorkerPool.js', () => ({
  getEquityPool: () => equityWorker,
}));
vi.mock('../services/financialAlerts.js', () => ({
  raiseFinancialAlert: vi.fn(() => Promise.resolve({ persisted: true, alertId: 'test' })),
}));

import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import type { Card, HandConfig, HandEvent, SeatPlayer } from '../types.js';

const TABLE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
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

function engineHarness(controller: any) {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.running = true;
  engine.handCount = 41;
  engine.handController = controller;
  engine.tableInfo = { action_time_seconds: 15 };
  engine.seatedPlayers = [{ seat_number: 1, user_id: 'horse-1', is_horse: true }];
  engine.lifecycleCanMutate = () => true;
  engine.getEngineLeaseAuthority = () => null;
  engine.activeHandVariant = () => 'pineapple';
  return engine;
}

function workerResult(snapshot: { generation: number; fence: string }, cardIndex = 1) {
  return {
    type: 'DISCARD_RESULT' as const,
    requestId: 1,
    generation: snapshot.generation,
    fence: snapshot.fence,
    cardIndex,
    computeMs: 5,
    governorScale: 1,
  };
}

beforeEach(() => {
  worker.decideDiscard.mockReset();
  worker.decideDiscard.mockImplementation(async (snapshot) => workerResult(snapshot));
  equityWorker.estimateEquity.mockClear();
  equityWorker.estimateLayeredEquity.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Pineapple discard worker ownership', () => {
  it('routes a normal horse discard through the worker after the visible delay', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let owes = true;
    const performDiscard = vi.fn(() => {
      owes = false;
      return true;
    });
    const controller = {
      getState: () => ({
        stage: 'pineapple_discard',
        communityCards: FLOP,
        players: [{ seat: 1, cards: CARDS, is_folded: false }],
      }),
      owesPineappleDiscard: () => owes,
      allPineappleDiscardsIn: () => !owes,
      performDiscard,
      cancelPineappleSettle: vi.fn(),
    };
    const engine = engineHarness(controller);
    const clearTurnTimer = vi.spyOn(engine, 'clearTurnTimer');

    engine.handlePineappleDiscard({ type: 'PINEAPPLE_DISCARD_REQUIRED', seats: [1] });
    expect(clearTurnTimer).toHaveBeenCalledTimes(1);
    expect(worker.decideDiscard).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_201);

    expect(worker.decideDiscard).toHaveBeenCalledTimes(1);
    expect(worker.decideDiscard.mock.calls[0][0]).toMatchObject({
      cards: CARDS,
      communityCards: FLOP,
      gameVariant: 'pineapple',
    });
    expect(performDiscard).toHaveBeenCalledWith(1, 1);
    engine.clearLooseHandTimers();
  });

  it('aborts an in-flight job on teardown and stale-discards its late result', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let resolve!: (value: ReturnType<typeof workerResult>) => void;
    let submittedSnapshot: { generation: number; fence: string } | null = null;
    let submittedSignal: AbortSignal | undefined;
    worker.decideDiscard.mockImplementation(
      (snapshot, signal) =>
        new Promise((done) => {
          submittedSnapshot = snapshot;
          submittedSignal = signal;
          resolve = done;
        })
    );
    const controller = {
      getState: () => ({
        stage: 'pineapple_discard',
        communityCards: FLOP,
        players: [{ seat: 1, cards: CARDS, is_folded: false }],
      }),
      owesPineappleDiscard: () => true,
      allPineappleDiscardsIn: () => false,
      performDiscard: vi.fn(),
      cancelPineappleSettle: vi.fn(),
    };
    const engine = engineHarness(controller);

    engine.handlePineappleDiscard({ type: 'PINEAPPLE_DISCARD_REQUIRED', seats: [1] });
    await vi.advanceTimersByTimeAsync(1_201);
    expect(submittedSignal?.aborted).toBe(false);

    engine.clearLooseHandTimers();
    expect(submittedSignal?.aborted).toBe(true);
    resolve(workerResult(submittedSnapshot!));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.performDiscard).not.toHaveBeenCalled();
  });

  it('prepares every all-in choice before the flop and completes with two-card hands', async () => {
    const players: SeatPlayer[] = [1, 2, 3].map(
      (seat) =>
        ({
          seat,
          user_id: `u${seat}`,
          username: `P${seat}`,
          stack: 100,
          bet: 0,
          totalInvested: 0,
          cards: [],
          is_folded: false,
          is_all_in: false,
          is_sitting_out: false,
        }) as SeatPlayer
    );
    const config = {
      tableId: TABLE,
      handNumber: 41,
      gameVariant: 'pineapple',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    } as HandConfig;
    const controller = new HandController(config, players, 1);
    const events: HandEvent[] = [];
    controller.onEvent((event) => events.push(event));
    controller.start();
    const internal = controller as unknown as { state: { players: SeatPlayer[] } };
    for (const player of internal.state.players) player.is_all_in = true;

    const engine = engineHarness(controller);
    engine.allInFirstPauseMs = 0;
    engine.allInStreetPauseMs = 0;
    engine.allInPreShowdownPauseMs = 0;
    engine.allInStreetRevealMs = 0;
    engine.sleep = async () => undefined;
    engine.broadcastCurrentState = vi.fn();
    engine.broadcastAllInEquity = vi.fn(async () => undefined);

    await engine.pacedAllInRunout(controller.getState().players, controller.getPot());

    expect(worker.decideDiscard).toHaveBeenCalledTimes(3);
    expect(controller.getCommunityCards()).toHaveLength(5);
    expect(controller.getState().players.filter((player) => !player.is_folded)).toHaveLength(3);
    expect(
      controller
        .getState()
        .players.filter((player) => !player.is_folded)
        .map((player) => player.cards.length)
    ).toEqual([2, 2, 2]);
    expect(events.filter((event) => event.type === 'PINEAPPLE_DISCARDED')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'HAND_COMPLETE')).toHaveLength(1);
    for (const call of engine.broadcastAllInEquity.mock.calls) {
      expect(call[0].map((player: SeatPlayer) => player.cards.length)).toEqual([2, 2, 2]);
    }
  });

  it('prices the next insurance street once from committed two-card hands', async () => {
    const players: SeatPlayer[] = [1, 2].map(
      (seat) =>
        ({
          seat,
          user_id: `insurance-${seat}`,
          username: `Insurance ${seat}`,
          stack: 100,
          bet: 0,
          totalInvested: 0,
          cards: [],
          is_folded: false,
          is_all_in: false,
          is_sitting_out: false,
        }) as SeatPlayer
    );
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
    const internal = controller as unknown as { state: { players: SeatPlayer[] } };
    for (const player of internal.state.players) player.is_all_in = true;
    const allInPlayers = controller.getState().players;
    const offerPlayers = allInPlayers.map((player) => ({
      playerId: player.user_id,
      holeCards: player.cards,
    }));

    const engine = engineHarness(controller);
    engine.allInStreetPauseMs = 0;
    engine.allInStreetRevealMs = 0;
    engine.sleep = async () => undefined;
    engine.broadcastCurrentState = vi.fn();
    engine.broadcastAllInEquity = vi.fn(async () => undefined);
    engine.runInsurancePerStreetFlow = vi.fn(async () => undefined);

    await engine.dealNextInsuranceStreet(
      offerPlayers,
      allInPlayers,
      controller.getPot(),
      controller
    );

    // The structured insurance worker pass owns both pricing and the public
    // percentages. A second cosmetic job here would duplicate the CPU work.
    expect(engine.broadcastAllInEquity).not.toHaveBeenCalled();
    expect(engine.runInsurancePerStreetFlow).toHaveBeenCalledTimes(1);
    const [nextOffers, nextAllIn] = engine.runInsurancePerStreetFlow.mock.calls[0];
    expect(nextOffers.map((player: { holeCards: Card[] }) => player.holeCards.length)).toEqual([
      2, 2,
    ]);
    expect(nextAllIn.map((player: SeatPlayer) => player.cards.length)).toEqual([2, 2]);
  });

  it('resolves externally-built RIT boards only after worker discards are committed', async () => {
    const startingStacks = [40, 40];
    const players: SeatPlayer[] = startingStacks.map(
      (stack, index) =>
        ({
          seat: index + 1,
          user_id: `rit-${index + 1}`,
          username: `RIT ${index + 1}`,
          stack,
          bet: 0,
          totalInvested: 0,
          cards: [],
          is_folded: false,
          is_all_in: false,
          is_sitting_out: false,
        }) as SeatPlayer
    );
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
    const events: HandEvent[] = [];
    controller.onEvent((event) => events.push(event));
    controller.start();
    let guard = 0;
    while (!events.some((event) => event.type === 'ALL_IN_RUNOUT') && guard++ < 8) {
      const state = controller.getState();
      if (state.currentPlayerSeat < 0) break;
      controller.performAction(state.currentPlayerSeat, 'all_in', 0);
    }
    expect(events.some((event) => event.type === 'ALL_IN_RUNOUT')).toBe(true);

    const engine = engineHarness(controller);
    engine.tableInfo = { action_time_seconds: 15, game_variant: 'pineapple', big_blind: 2 };
    const active = controller.getState().players.filter((player) => !player.is_folded);
    engine.runItTwiceEngine.configure(TABLE, {
      enabled: true,
      autoDeclineTimeout: 10,
      maxRuns: 2,
    });
    engine.runItTwiceEngine.offer(
      TABLE,
      `${TABLE}:41`,
      active[0].user_id,
      active.map((player) => player.user_id),
      controller.getPot()
    );
    engine.runItTwiceEngine.chooserDecides(TABLE, active[0].user_id, 2);
    engine.runItTwiceEngine.accept(TABLE, active[1].user_id);
    engine.currentHandActions = active.map((player, index) => ({
      seat: player.seat,
      userId: player.user_id,
      action: index === 0 ? 'all_in' : 'call',
      timestamp: 1,
      stage: 'preflop',
    }));
    engine.recordAllInRunoutObligation(active, [[]]);
    const equityEvidence = engine.currentHandAllInEquityEvidence;

    await engine.dealAndResolveRIT(active);
    await equityEvidence;

    expect(worker.decideDiscard).toHaveBeenCalledTimes(2);
    expect(
      controller
        .getState()
        .players.filter((player) => !player.is_folded)
        .map((player) => player.cards.length)
    ).toEqual([2, 2]);
    expect(events.filter((event) => event.type === 'PINEAPPLE_DISCARDED')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'HAND_COMPLETE')).toHaveLength(1);
    expect(engine.currentHandCommunityCards).toHaveLength(5);
    expect(equityWorker.estimateLayeredEquity).toHaveBeenCalledTimes(1);
    const equityCalls = equityWorker.estimateLayeredEquity.mock.calls as unknown as Array<
      [unknown[][], string[], number[], Card[][], Card[]]
    >;
    expect(equityCalls[0][3].map((board) => board.length)).toEqual([3, 0]);
    expect(equityCalls[0][4]).toHaveLength(2);
    const privateDiscardKeys = new Set(
      events
        .filter(
          (event): event is Extract<HandEvent, { type: 'PINEAPPLE_DISCARDED' }> =>
            event.type === 'PINEAPPLE_DISCARDED'
        )
        .map((event) => `${event.card.rank}:${event.card.suit}`)
    );
    const futureRunoutKeys = new Set([
      ...engine.currentHandCommunityCards.slice(3),
      ...engine.currentHandRitExtraBoards.flat(),
    ]);
    for (const call of equityCalls) {
      const boardKeys = call[3].flat().map((card: Card) => `${card.rank}:${card.suit}`);
      const deadKeys = new Set(call[4].map((card: Card) => `${card.rank}:${card.suit}`));
      expect(boardKeys.some((key: string) => privateDiscardKeys.has(key))).toBe(false);
      expect([...privateDiscardKeys].every((key) => deadKeys.has(key))).toBe(true);
      expect([...deadKeys].some((key: string) => futureRunoutKeys.has(key))).toBe(false);
    }
    expect(
      engine.currentHandActions
        .filter((entry: any) => entry.allInRunout === true)
        .map((entry: any) => entry.allInEquity)
    ).toEqual([0.5, 0.5]);
  });

  it('rolls back staged Pineapple RIT equity before a pre-credit single-run fallback', async () => {
    const players: SeatPlayer[] = [1, 2].map(
      (seat) =>
        ({
          seat,
          user_id: `fallback-${seat}`,
          username: `Fallback ${seat}`,
          stack: 40,
          bet: 0,
          totalInvested: 0,
          cards: [],
          is_folded: false,
          is_all_in: false,
          is_sitting_out: false,
        }) as SeatPlayer
    );
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
    const events: HandEvent[] = [];
    controller.onEvent((event) => events.push(event));
    controller.start();
    let guard = 0;
    while (!events.some((event) => event.type === 'ALL_IN_RUNOUT') && guard++ < 8) {
      const state = controller.getState();
      if (state.currentPlayerSeat < 0) break;
      controller.performAction(state.currentPlayerSeat, 'all_in', 0);
    }
    const engine = engineHarness(controller);
    engine.tableInfo = { action_time_seconds: 15, game_variant: 'pineapple', big_blind: 2 };
    engine.killForRestart = vi.fn();
    const active = controller.getState().players.filter((player) => !player.is_folded);
    engine.runItTwiceEngine.configure(TABLE, {
      enabled: true,
      autoDeclineTimeout: 10,
      maxRuns: 2,
    });
    engine.runItTwiceEngine.offer(
      TABLE,
      `${TABLE}:41`,
      active[0].user_id,
      active.map((player) => player.user_id),
      controller.getPot()
    );
    engine.runItTwiceEngine.chooserDecides(TABLE, active[0].user_id, 2);
    engine.runItTwiceEngine.accept(TABLE, active[1].user_id);
    engine.currentHandActions = active.map((player, index) => ({
      seat: player.seat,
      userId: player.user_id,
      action: index === 0 ? 'all_in' : 'call',
      timestamp: 1,
      stage: 'preflop',
    }));
    engine.recordAllInRunoutObligation(active, [[]]);
    const evidence = engine.currentHandAllInEquityEvidence;
    const continueRunout = vi.spyOn(controller, 'continueRunout');
    const creditRunout = vi.spyOn(controller, 'creditRunoutWinnings');
    const computeLivePots = controller.computeLivePots.bind(controller);
    let potReads = 0;
    vi.spyOn(controller, 'computeLivePots').mockImplementation(() => {
      potReads += 1;
      if (potReads === 2) throw new Error('fault after staged evidence, before credit');
      return computeLivePots();
    });

    await engine.dealAndResolveRIT(active);
    await evidence;

    expect(equityWorker.estimateLayeredEquity).toHaveBeenCalledTimes(1);
    expect(creditRunout).not.toHaveBeenCalled();
    expect(continueRunout).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === 'HAND_COMPLETE')).toHaveLength(1);
    expect(engine.currentHandRitBoards).toBe(0);
    expect(engine.currentHandRitExtraBoards).toEqual([]);
    expect(
      engine.currentHandActions
        .filter((entry: any) => entry.allInRunout === true)
        .map((entry: any) => ({
          equity: entry.allInEquity,
          expected: entry.allInEvReturned,
          hash: entry.allInEquityInputHash,
        }))
    ).toEqual([
      { equity: undefined, expected: undefined, hash: undefined },
      { equity: undefined, expected: undefined, hash: undefined },
    ]);
    expect(engine.killForRestart).not.toHaveBeenCalled();
  });
});
