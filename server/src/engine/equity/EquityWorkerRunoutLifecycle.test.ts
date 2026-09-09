import { beforeEach, describe, expect, it, vi } from 'vitest';

const workerMocks = vi.hoisted(() => ({
  estimateInsurance: vi.fn(),
  estimateEquity: vi.fn(),
  estimateLayeredEquity: vi.fn(),
}));

vi.mock('./EquityWorkerPool.js', () => ({
  getEquityPool: () => workerMocks,
}));

import { ServerTableEngine } from '../ServerTableEngine.js';

const TABLE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const cards = {
  hero: [
    { rank: 'A', suit: 'spades' },
    { rank: 'A', suit: 'hearts' },
  ],
  villain: [
    { rank: 'K', suit: 'spades' },
    { rank: 'K', suit: 'hearts' },
  ],
} as const;

function harness() {
  const engine = new ServerTableEngine(TABLE) as any;
  const controller = {
    getState: () => ({
      communityCards: [],
      communityCards2: [],
      communityCards3: [],
      dealerSeat: 1,
    }),
    computeLivePots: () => [{ amount: 200, eligiblePlayers: ['hero', 'villain'] }],
    computeRakeAndBBJ: () => ({ rake: 0, bbjFee: 0 }),
  };
  engine.handController = controller;
  engine.handCount = 17;
  engine.killForRestart = vi.fn();
  engine.lifecycleCanMutate = vi.fn(() => true);
  engine.pacedAllInRunout = vi.fn(async () => undefined);
  const createOffers = vi.spyOn(engine.insuranceEngine, 'createOffers');
  const offerPlayers = [
    { playerId: 'hero', holeCards: cards.hero },
    { playerId: 'villain', holeCards: cards.villain },
  ];
  const allInPlayers = [
    { user_id: 'hero', username: 'Hero', seat: 1, cards: cards.hero, totalInvested: 100 },
    { user_id: 'villain', username: 'Villain', seat: 2, cards: cards.villain, totalInvested: 100 },
  ];
  return { engine, controller, offerPlayers, allInPlayers, createOffers };
}

describe('worker-only insurance runout authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerMocks.estimateLayeredEquity.mockImplementation(
      async (
        hands: unknown[][],
        _ids: string[],
        _seats: number[],
        _board: unknown[],
        _dead: unknown[],
        _iters: number,
        _variant: string,
        pots: unknown[],
        _dealer: number,
        totalWinnings: number
      ) => ({
        equities: hands.map(() => 1 / hands.length),
        layerEquities: pots.map(() => hands.map(() => 1 / hands.length)),
        expectedNetReturns: hands.map(() => totalWinnings / hands.length),
        strictLossPcts: hands.map((_, index) => (index === 0 ? 18 : 82)),
        pushPcts: hands.map(() => 0),
        seed: 424242,
        exact: true,
        runouts: 1,
      })
    );
  });

  it('omits insurance and continues the paced runout when worker pricing fails', async () => {
    const { engine, controller, offerPlayers, allInPlayers, createOffers } = harness();
    workerMocks.estimateLayeredEquity.mockRejectedValueOnce(new Error('worker unavailable'));

    await engine.runInsurancePerStreetFlow(offerPlayers, allInPlayers, 200, [], controller);

    expect(createOffers).not.toHaveBeenCalled();
    expect(engine.pacedAllInRunout).toHaveBeenCalledOnce();
    expect(engine.pacedAllInRunout).toHaveBeenCalledWith(allInPlayers, 200);
  });

  it('drops a completed worker result after the hand generation changes', async () => {
    const { engine, controller, offerPlayers, allInPlayers, createOffers } = harness();
    let resolvePricing!: (value: unknown) => void;
    workerMocks.estimateLayeredEquity.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePricing = resolve;
      })
    );

    const flow = engine.runInsurancePerStreetFlow(offerPlayers, allInPlayers, 200, [], controller);
    engine.handCount = 18;
    resolvePricing({
      equities: [0.82, 0.18],
      layerEquities: [[0.82, 0.18]],
      expectedNetReturns: [164, 36],
      strictLossPcts: [18, 82],
      pushPcts: [0, 0],
      seed: 424242,
      exact: false,
      runouts: 6000,
    });
    await flow;

    expect(createOffers).not.toHaveBeenCalled();
    expect(engine.pacedAllInRunout).not.toHaveBeenCalled();
  });

  it('uses one structured worker operation for pricing and public equity per street', async () => {
    const { engine, controller, offerPlayers, allInPlayers } = harness();
    engine.hub = { emitEvent: vi.fn() };
    engine.waitForInsuranceResponses = vi.fn();
    engine.insuranceEngine.configure(TABLE, { enabled: true });
    await engine.runInsurancePerStreetFlow(offerPlayers, allInPlayers, 200, [], controller);

    expect(workerMocks.estimateLayeredEquity).toHaveBeenCalledOnce();
    expect(workerMocks.estimateInsurance).not.toHaveBeenCalled();
    expect(workerMocks.estimateEquity).not.toHaveBeenCalled();
    expect(engine.hub.emitEvent).toHaveBeenCalledWith(
      TABLE,
      expect.objectContaining({ type: 'all_in_equity', board_count: 1 })
    );
  });

  it('quarantines an impossible insurance card universe before pricing or durable evidence', async () => {
    const { engine, controller, offerPlayers, allInPlayers, createOffers } = harness();
    const duplicatedPlayers = [
      allInPlayers[0],
      { ...allInPlayers[1], cards: [allInPlayers[0].cards[0], allInPlayers[1].cards[1]] },
    ];
    const duplicatedOffers = duplicatedPlayers.map((player) => ({
      playerId: player.user_id,
      holeCards: player.cards,
    }));
    engine.currentHandActions = [
      { seat: 1, userId: 'hero', action: 'all_in', timestamp: 1, stage: 'preflop' },
      { seat: 2, userId: 'villain', action: 'call', timestamp: 1, stage: 'preflop' },
    ];
    engine.recordAllInRunoutObligation(duplicatedPlayers, [[]]);
    const joined = engine.currentHandAllInEquityEvidence;

    await engine.runInsurancePerStreetFlow(
      duplicatedOffers,
      duplicatedPlayers,
      200,
      [],
      controller,
      0,
      true
    );
    await joined;

    expect(workerMocks.estimateInsurance).not.toHaveBeenCalled();
    expect(createOffers).not.toHaveBeenCalled();
    expect(engine.pacedAllInRunout).not.toHaveBeenCalled();
    expect(engine.killForRestart).toHaveBeenCalledWith('insurance_visible_cards_invalid');
    expect(engine.currentHandActions.every((entry: any) => entry.allInEquity === undefined)).toBe(
      true
    );
  });

  it('subtracts revealed all-in Pineapple discards from the popup outs denominator', () => {
    const { engine, allInPlayers } = harness();
    engine.hub = { emitEvent: vi.fn() };
    engine.activeHandVariant = () => 'nlh';
    const board = [
      { rank: '2', suit: 'clubs' },
      { rank: '7', suit: 'diamonds' },
      { rank: 'J', suit: 'hearts' },
      { rank: 'Q', suit: 'spades' },
    ];
    const visibleDeadCards = [{ rank: '8', suit: 'clubs' }];
    const outs = [
      { rank: '3', suit: 'clubs' },
      { rank: '4', suit: 'clubs' },
      { rank: '5', suit: 'clubs' },
      { rank: '6', suit: 'clubs' },
      { rank: '9', suit: 'clubs' },
      { rank: 'T', suit: 'clubs' },
    ];

    engine.broadcastInsuranceOffers([], 200, 25, {
      board,
      allInPlayers,
      outs,
      visibleDeadCards,
    });

    expect(engine.hub.emitEvent).toHaveBeenCalledWith(
      TABLE,
      expect.objectContaining({ type: 'insurance_offers', outCount: 6, outPct: 14 })
    );
  });

  it('drops a cosmetic equity result when its exact board generation advances', async () => {
    const { engine, allInPlayers } = harness();
    const flop = [
      { rank: '2', suit: 'clubs' },
      { rank: '7', suit: 'diamonds' },
      { rank: 'J', suit: 'hearts' },
    ];
    const turn = [...flop, { rank: 'Q', suit: 'spades' }];
    let liveBoard = flop;
    engine.handController = {
      getState: () => ({
        communityCards: liveBoard,
        communityCards2: [],
        communityCards3: [],
        dealerSeat: 1,
      }),
      computeLivePots: () => [{ amount: 200, eligiblePlayers: ['hero', 'villain'] }],
      computeRakeAndBBJ: () => ({ rake: 0, bbjFee: 0 }),
    };
    engine.hub = { emitEvent: vi.fn() };
    let resolveEquity!: (value: number[]) => void;
    workerMocks.estimateLayeredEquity.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveEquity = resolve;
      })
    );

    const pending = engine.broadcastAllInEquity(allInPlayers, flop, 200);
    liveBoard = turn;
    resolveEquity({
      equities: [0.82, 0.18],
      layerEquities: [[0.82, 0.18]],
      expectedNetReturns: [164, 36],
      strictLossPcts: [18, 82],
      pushPcts: [0, 0],
      seed: 424242,
      exact: true,
      runouts: 1,
    } as never);
    await pending;

    expect(engine.hub.emitEvent).not.toHaveBeenCalled();
  });

  it('prices simultaneous boards in one shared visible card universe', async () => {
    const { engine, allInPlayers } = harness();
    const boardOne = [
      { rank: '2', suit: 'clubs' },
      { rank: '7', suit: 'diamonds' },
      { rank: 'J', suit: 'hearts' },
    ];
    const boardTwo = [
      { rank: '3', suit: 'clubs' },
      { rank: '8', suit: 'diamonds' },
      { rank: 'Q', suit: 'hearts' },
    ];
    engine.handController = {
      getState: () => ({
        communityCards: boardOne,
        communityCards2: boardTwo,
        communityCards3: [],
        dealerSeat: 1,
      }),
      computeLivePots: () => [{ amount: 200, eligiblePlayers: ['hero', 'villain'] }],
      computeRakeAndBBJ: () => ({ rake: 0, bbjFee: 0 }),
    };
    engine.hub = { emitEvent: vi.fn() };
    await engine.broadcastAllInEquity(allInPlayers, boardOne, 200, [boardTwo]);

    expect(workerMocks.estimateLayeredEquity).toHaveBeenCalledOnce();
    expect(workerMocks.estimateLayeredEquity.mock.calls[0][3]).toEqual([boardOne, boardTwo]);
    expect(workerMocks.estimateLayeredEquity.mock.calls[0][4]).toEqual([]);
  });

  it('normalizes legacy uppercase short-deck variants before worker pricing', async () => {
    const { engine, allInPlayers } = harness();
    engine.activeHandVariant = () => 'SHORT_DECK';
    engine.handController = {
      getState: () => ({
        communityCards: [],
        communityCards2: [],
        communityCards3: [],
        dealerSeat: 1,
      }),
      computeLivePots: () => [{ amount: 200, eligiblePlayers: ['hero', 'villain'] }],
      computeRakeAndBBJ: () => ({ rake: 0, bbjFee: 0 }),
    };

    await engine.broadcastAllInEquity(allInPlayers, [], 200);

    expect(workerMocks.estimateLayeredEquity).toHaveBeenCalledWith(
      expect.any(Array),
      ['hero', 'villain'],
      [1, 2],
      [[]],
      [],
      1000,
      'SHORT_DECK',
      expect.any(Array),
      1,
      200,
      0.01
    );
  });

  it('refuses an impossible duplicated visible card instead of publishing equity', async () => {
    const { engine, allInPlayers } = harness();
    const duplicate = cards.hero[0];
    const board = [duplicate, { rank: '7', suit: 'diamonds' }, { rank: 'J', suit: 'hearts' }];
    engine.handController = {
      getState: () => ({
        communityCards: board,
        communityCards2: [],
        communityCards3: [],
        dealerSeat: 1,
      }),
      computeLivePots: () => [{ amount: 200, eligiblePlayers: ['hero', 'villain'] }],
      computeRakeAndBBJ: () => ({ rake: 0, bbjFee: 0 }),
    };
    engine.hub = { emitEvent: vi.fn() };

    await engine.broadcastAllInEquity(allInPlayers, board, 200);

    expect(workerMocks.estimateEquity).not.toHaveBeenCalled();
    expect(engine.hub.emitEvent).not.toHaveBeenCalled();
  });

  it('records an immutable first-point result after the board advances but suppresses its stale display', async () => {
    const { engine, allInPlayers } = harness();
    const flop = [
      { rank: '2', suit: 'clubs' },
      { rank: '7', suit: 'diamonds' },
      { rank: 'J', suit: 'hearts' },
    ];
    const turn = [...flop, { rank: 'Q', suit: 'spades' }];
    let liveBoard = flop;
    engine.handController = {
      getState: () => ({
        communityCards: liveBoard,
        communityCards2: [],
        communityCards3: [],
        dealerSeat: 1,
      }),
      computeLivePots: () => [{ amount: 200, eligiblePlayers: ['hero', 'villain'] }],
      computeRakeAndBBJ: () => ({ rake: 0, bbjFee: 0 }),
    };
    engine.hub = { emitEvent: vi.fn() };
    engine.currentHandActions = [
      { seat: 1, userId: 'hero', action: 'all_in', timestamp: 1, stage: 'flop' },
      { seat: 2, userId: 'villain', action: 'call', timestamp: 1, stage: 'flop' },
    ];
    engine.recordAllInRunoutObligation(allInPlayers, [flop]);
    const joined = engine.currentHandAllInEquityEvidence;
    let resolveFirst!: (value: unknown) => void;
    workerMocks.estimateLayeredEquity.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      })
    );

    const first = engine.broadcastAllInEquity(allInPlayers, flop, 200, [], {
      recordDurable: true,
    });
    liveBoard = turn;
    resolveFirst({
      equities: [0.82, 0.18],
      layerEquities: [[0.82, 0.18]],
      expectedNetReturns: [164, 36],
      strictLossPcts: [18, 82],
      pushPcts: [0, 0],
      seed: 424242,
      exact: true,
      runouts: 1,
    });
    await first;
    await joined;
    expect(engine.currentHandActions.map((entry: any) => entry.allInEquity)).toEqual([0.82, 0.18]);
    expect(engine.hub.emitEvent).not.toHaveBeenCalled();

    workerMocks.estimateLayeredEquity.mockResolvedValueOnce({
      equities: [0.1, 0.9],
      layerEquities: [[0.1, 0.9]],
      expectedNetReturns: [20, 180],
      strictLossPcts: [90, 10],
      pushPcts: [0, 0],
      seed: 424242,
      exact: true,
      runouts: 1,
    });
    await engine.broadcastAllInEquity(allInPlayers, turn, 200);
    expect(engine.currentHandActions.map((entry: any) => entry.allInEquity)).toEqual([0.82, 0.18]);
  });

  it('closes the settlement join with durable NULL when the first-point worker fails', async () => {
    const { engine, allInPlayers } = harness();
    const flop = [
      { rank: '2', suit: 'clubs' },
      { rank: '7', suit: 'diamonds' },
      { rank: 'J', suit: 'hearts' },
    ];
    engine.handController = {
      getState: () => ({
        communityCards: flop,
        communityCards2: [],
        communityCards3: [],
        dealerSeat: 1,
      }),
      computeLivePots: () => [{ amount: 200, eligiblePlayers: ['hero', 'villain'] }],
      computeRakeAndBBJ: () => ({ rake: 0, bbjFee: 0 }),
    };
    engine.currentHandActions = [
      { seat: 1, userId: 'hero', action: 'all_in', timestamp: 1, stage: 'flop' },
      { seat: 2, userId: 'villain', action: 'call', timestamp: 1, stage: 'flop' },
    ];
    engine.recordAllInRunoutObligation(allInPlayers, [flop]);
    const joined = engine.currentHandAllInEquityEvidence;
    workerMocks.estimateLayeredEquity.mockRejectedValueOnce(new Error('worker unavailable'));

    await engine.broadcastAllInEquity(allInPlayers, flop, 200, [], { recordDurable: true });
    await joined;

    expect(engine.currentHandAllInEquityEvidenceClosed).toBe(true);
    expect(engine.currentHandActions.every((entry: any) => entry.allInEquity === undefined)).toBe(
      true
    );
  });
});
