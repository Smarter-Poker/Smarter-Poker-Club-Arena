import { beforeEach, describe, expect, it, vi } from 'vitest';

const workerMocks = vi.hoisted(() => ({
  estimateInsurance: vi.fn(),
  estimateEquity: vi.fn(),
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
  const controller = {};
  engine.handController = controller;
  engine.handCount = 17;
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
  });

  it('omits insurance and continues the paced runout when worker pricing fails', async () => {
    const { engine, controller, offerPlayers, allInPlayers, createOffers } = harness();
    workerMocks.estimateInsurance.mockRejectedValueOnce(new Error('worker unavailable'));

    await engine.runInsurancePerStreetFlow(offerPlayers, allInPlayers, 200, [], controller);

    expect(createOffers).not.toHaveBeenCalled();
    expect(engine.pacedAllInRunout).toHaveBeenCalledOnce();
    expect(engine.pacedAllInRunout).toHaveBeenCalledWith(allInPlayers, 200);
  });

  it('drops a completed worker result after the hand generation changes', async () => {
    const { engine, controller, offerPlayers, allInPlayers, createOffers } = harness();
    let resolvePricing!: (value: unknown) => void;
    workerMocks.estimateInsurance.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePricing = resolve;
      })
    );

    const flow = engine.runInsurancePerStreetFlow(offerPlayers, allInPlayers, 200, [], controller);
    engine.handCount = 18;
    resolvePricing([
      { equity: 82, strictLossPct: 18, pushPct: 0, exact: false, runouts: 6000 },
      { equity: 18, strictLossPct: 82, pushPct: 0, exact: false, runouts: 6000 },
    ]);
    await flow;

    expect(createOffers).not.toHaveBeenCalled();
    expect(engine.pacedAllInRunout).not.toHaveBeenCalled();
  });

  it('uses one structured worker operation for pricing and public equity per street', async () => {
    const { engine, controller, offerPlayers, allInPlayers } = harness();
    engine.hub = { emitEvent: vi.fn() };
    engine.waitForInsuranceResponses = vi.fn();
    engine.insuranceEngine.configure(TABLE, { enabled: true });
    workerMocks.estimateInsurance.mockResolvedValueOnce([
      { equity: 82, strictLossPct: 18, pushPct: 0, exact: false, runouts: 6000 },
      { equity: 18, strictLossPct: 82, pushPct: 0, exact: false, runouts: 6000 },
    ]);

    await engine.runInsurancePerStreetFlow(offerPlayers, allInPlayers, 200, [], controller);

    expect(workerMocks.estimateInsurance).toHaveBeenCalledOnce();
    expect(workerMocks.estimateEquity).not.toHaveBeenCalled();
    expect(engine.hub.emitEvent).toHaveBeenCalledWith(
      TABLE,
      expect.objectContaining({ type: 'all_in_equity', board_count: 1 })
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
      }),
    };
    engine.hub = { emitEvent: vi.fn() };
    let resolveEquity!: (value: number[]) => void;
    workerMocks.estimateEquity.mockReturnValueOnce(
      new Promise<number[]>((resolve) => {
        resolveEquity = resolve;
      })
    );

    const pending = engine.broadcastAllInEquity(allInPlayers, flop, 200);
    liveBoard = turn;
    resolveEquity([0.82, 0.18]);
    await pending;

    expect(engine.hub.emitEvent).not.toHaveBeenCalled();
  });
});
