import { beforeEach, describe, expect, it, vi } from 'vitest';

const workerMocks = vi.hoisted(() => ({
  estimateInsurance: vi.fn(),
  estimateEquity: vi.fn(),
}));

vi.mock('./EquityWorkerPool.js', () => ({
  getEquityPool: () => workerMocks,
}));

import { TableStateHub } from '../../transport/TableStateHub.js';
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
    getState: () => ({ communityCards: [], communityCards2: [], communityCards3: [] }),
  };
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

  it('keeps sampled insurance pricing separate from exact public equity', async () => {
    const { engine, controller, offerPlayers, allInPlayers } = harness();
    engine.hub = { emitEvent: vi.fn() };
    workerMocks.estimateEquity.mockResolvedValueOnce([0.826366112559452, 0.173633887440548]);
    engine.waitForInsuranceResponses = vi.fn();
    engine.insuranceEngine.configure(TABLE, { enabled: true });
    workerMocks.estimateInsurance.mockResolvedValueOnce([
      { equity: 82, strictLossPct: 18, pushPct: 0, exact: false, runouts: 6000 },
      { equity: 18, strictLossPct: 82, pushPct: 0, exact: false, runouts: 6000 },
    ]);

    await engine.runInsurancePerStreetFlow(offerPlayers, allInPlayers, 200, [], controller);

    expect(workerMocks.estimateInsurance).toHaveBeenCalledOnce();
    expect(workerMocks.estimateEquity).toHaveBeenCalledOnce();
    expect(engine.hub.emitEvent).toHaveBeenCalledWith(
      TABLE,
      expect.objectContaining({
        type: 'all_in_equity',
        exact: true,
        board_count: 1,
        equities: [
          expect.objectContaining({ equity: 82.6, equityRaw: 82.6366112559452 }),
          expect.objectContaining({ equity: 17.4, equityRaw: 17.3633887440548 }),
        ],
      })
    );
  });

  it('retains exact display and insurance continuation while the weekly owner holds the hand', async () => {
    const { engine, controller, offerPlayers, allInPlayers, createOffers } = harness();
    engine.hub = { emitEvent: vi.fn() };
    engine.waitForInsuranceResponses = vi.fn();
    engine.insuranceEngine.configure(TABLE, { enabled: true });
    workerMocks.estimateInsurance.mockResolvedValueOnce([
      { equity: 82, strictLossPct: 18, pushPct: 0, exact: false, runouts: 6000 },
      { equity: 18, strictLossPct: 82, pushPct: 0, exact: false, runouts: 6000 },
    ]);
    let resolveDisplay!: (value: number[]) => void;
    workerMocks.estimateEquity.mockReturnValueOnce(
      new Promise<number[]>((resolve) => {
        resolveDisplay = resolve;
      })
    );
    const flow = engine.runInsurancePerStreetFlow(offerPlayers, allInPlayers, 200, [], controller);
    await vi.waitFor(() => expect(workerMocks.estimateEquity).toHaveBeenCalledOnce());
    expect(workerMocks.estimateEquity).toHaveBeenCalledWith(
      expect.anything(),
      [],
      [],
      expect.any(Number),
      expect.objectContaining({ exact: true })
    );
    engine.weeklyHandPause.hold('weekly');
    resolveDisplay([0.82, 0.18]);
    for (let step = 0; step < 12; step++) await Promise.resolve();
    expect(engine.hub.emitEvent).not.toHaveBeenCalled();
    expect(createOffers).not.toHaveBeenCalled();
    expect(engine.waitForInsuranceResponses).not.toHaveBeenCalled();
    engine.weeklyHandPause.release('weekly');
    await flow;
    expect(
      engine.hub.emitEvent.mock.calls.filter(([, event]: any[]) => event.type === 'all_in_equity')
    ).toHaveLength(1);
    expect(createOffers).toHaveBeenCalledOnce();
    expect(engine.waitForInsuranceResponses).toHaveBeenCalledOnce();
  });

  it.each(['hand', 'controller', 'board'])(
    'does not issue insurance when the %s fence changes during exact display computation',
    async (fence) => {
      const { engine, controller, offerPlayers, allInPlayers, createOffers } = harness();
      engine.hub = { emitEvent: vi.fn() };
      engine.waitForInsuranceResponses = vi.fn();
      engine.insuranceEngine.configure(TABLE, { enabled: true });
      workerMocks.estimateInsurance.mockResolvedValueOnce([
        { equity: 82, strictLossPct: 18, pushPct: 0, exact: false, runouts: 6000 },
        { equity: 18, strictLossPct: 82, pushPct: 0, exact: false, runouts: 6000 },
      ]);
      let release!: (value: number[]) => void;
      workerMocks.estimateEquity.mockReturnValueOnce(
        new Promise<number[]>((resolve) => {
          release = resolve;
        })
      );
      const flow = engine.runInsurancePerStreetFlow(
        offerPlayers,
        allInPlayers,
        200,
        [],
        controller
      );
      await vi.waitFor(() => expect(workerMocks.estimateEquity).toHaveBeenCalledOnce());
      if (fence === 'hand') engine.handCount = 18;
      else if (fence === 'controller')
        engine.handController = { getState: () => ({ communityCards: [] }) };
      else
        controller.getState = () => ({
          communityCards: [
            { rank: '2', suit: 'clubs' },
            { rank: '7', suit: 'diamonds' },
            { rank: 'J', suit: 'hearts' },
          ] as any,
          communityCards2: [],
          communityCards3: [],
        });
      release([0.82, 0.18]);
      await flow;
      expect(createOffers).not.toHaveBeenCalled();
      expect(engine.waitForInsuranceResponses).not.toHaveBeenCalled();
      expect(engine.hub.emitEvent).not.toHaveBeenCalled();
    }
  );

  it('preserves a rare nonzero percentage through hub reconnect replay', async () => {
    const { engine, allInPlayers } = harness();
    engine.hub = new TableStateHub();
    workerMocks.estimateEquity.mockResolvedValueOnce([1 / 990, 989 / 990]);
    await engine.broadcastAllInEquity(allInPlayers, [], 200);
    const received: any[] = [];
    engine.hub.subscribe(TABLE, {
      id: 'reconnected',
      readyState: 1,
      bufferedAmount: 0,
      send: (text: string) => received.push(JSON.parse(text)),
    });
    const event = received.find((e) => e.type === 'EVENT' && e.payload.type === 'all_in_equity');
    expect(event.payload).toMatchObject({
      hand_number: 17,
      exact: true,
      replayed: true,
      boards: [[]],
    });
    expect(event.payload.equities[0].equityRaw).toBeCloseTo(100 / 990, 12);
  });

  it('sends pot eligibility, hi-lo and other exposed cards to every board worker', async () => {
    const { engine, allInPlayers } = harness();
    const board = [
      { rank: '2', suit: 'clubs' },
      { rank: '3', suit: 'clubs' },
      { rank: '4', suit: 'clubs' },
    ];
    const other = [
      { rank: '5', suit: 'diamonds' },
      { rank: '6', suit: 'diamonds' },
      { rank: '7', suit: 'diamonds' },
    ];
    engine.activeHandVariant = () => 'plo8';
    engine.handController = {
      getState: () => ({ communityCards: board, communityCards2: other, communityCards3: [] }),
      isDoubleBoardActive: () => true,
      computeLivePots: () => [{ amount: 200, eligiblePlayers: ['hero', 'villain'] }],
    };
    engine.hub = { emitEvent: vi.fn() };
    workerMocks.estimateEquity.mockResolvedValue([0.5, 0.5]);
    await engine.broadcastAllInEquity(allInPlayers, board, 200, other.length ? [other] : undefined);
    expect(workerMocks.estimateEquity).toHaveBeenCalledWith(
      expect.anything(),
      board,
      other,
      expect.any(Number),
      expect.objectContaining({
        exact: true,
        hiLo: true,
        pots: [{ amount: 200, eligible: [0, 1] }],
      })
    );
    expect(workerMocks.estimateEquity).toHaveBeenCalledWith(
      expect.anything(),
      other,
      board,
      expect.any(Number),
      expect.objectContaining({ exact: true })
    );
    expect(engine.hub.emitEvent).toHaveBeenCalledWith(
      TABLE,
      expect.objectContaining({ board_count: 2 })
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
