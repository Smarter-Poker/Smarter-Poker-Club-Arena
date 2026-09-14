import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  estimateEquity: vi.fn(),
  upsert: vi.fn(async (_rows: unknown) => ({ error: null })),
}));
vi.mock('./equity/EquityWorkerPool.js', () => ({ getEquityPool: () => mocks }));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { from: () => ({ upsert: mocks.upsert }) },
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import { TableStateHub } from '../transport/TableStateHub.js';
import { writeHandFacts } from '../services/supabase/handFacts.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

const TABLE = '96969696-9696-4969-8969-969696969696';
let handNumber = 900;

function harness(mode: 'mandatory_twice' | 'mandatory_three' | 'player_choice', insurance = true) {
  const number = ++handNumber;
  const players = [1, 2].map((seat) => ({
    seat,
    user_id: `equity-rit-${seat}`,
    username: `Player ${seat}`,
    stack: 100,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const events: HandEvent[] = [];
  const controller = new HandController(
    {
      tableId: TABLE,
      handNumber: number,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  controller.onEvent((event) => events.push(event));
  controller.start();
  for (let n = 0; !events.some((e) => e.type === 'ALL_IN_RUNOUT') && n < 10; n++) {
    controller.performAction(controller.getState().currentPlayerSeat, 'all_in', 0);
  }
  const event = events.find((e) => e.type === 'ALL_IN_RUNOUT');
  if (!event || event.type !== 'ALL_IN_RUNOUT') throw new Error('hand did not park');
  const engine = new ServerTableEngine(TABLE) as unknown as Record<string, any>;
  engine.running = true;
  // This isolated engine is not registered by GameServer; inject only that ownership check.
  engine.isCurrentEngine = vi.fn(() => true);
  engine.handCount = number;
  engine.handController = controller;
  engine.tableInfo = {
    game_variant: 'nlh',
    game_type: 'cash',
    big_blind: 2,
    run_it_twice: true,
    allow_run_it_twice: true,
    run_it_mode: mode,
    insurance_enabled: insurance,
  };
  engine.seatedPlayers = players.map((p) => ({
    seat_number: p.seat,
    user_id: p.user_id,
    username: p.username,
    stack: p.stack,
    is_horse: false,
  }));
  // Real hub, with no subscribed room: its production capture precedes that early return.
  engine.hub = new TableStateHub();
  const emitted = vi.spyOn(engine.hub, 'emitEvent');
  engine.broadcastCurrentState = vi.fn();
  engine.scheduleHorseRITResponses = vi.fn();
  engine.markProgress = vi.fn();
  engine.waitForRITResponse = (ready: () => void) => {
    const offer = emitted.mock.calls
      .map((call: any[]) => call[1])
      .find((payload: any) => payload.type === 'rit_offer');
    const id = offer.chooserPlayerId;
    engine.runItTwiceEngine.chooserDecides(TABLE, id, 3);
    for (const p of event.players)
      if (p.user_id !== id) engine.runItTwiceEngine.accept(TABLE, p.user_id);
    ready();
  };
  const writes: Promise<void>[] = [];
  const invested = new Map(event.players.map((p) => [p.user_id, p.totalInvested]));
  const holdings = new Map(
    event.players.map((p) => [p.user_id, { seat: p.seat, cards: [...p.cards] }])
  );
  controller.onEvent((e) => {
    if (e.type !== 'HAND_COMPLETE') return;
    writes.push(
      writeHandFacts({
        handId: `rit-${number}`,
        tableId: TABLE,
        handNumber: number,
        gameVariant: 'nlh',
        bigBlind: 2,
        playedAt: new Date().toISOString(),
        buttonSeat: 1,
        rakeAmount: e.rake,
        boardLength: 5,
        holeCardsAll: holdings,
        contributions: invested,
        winners: controller.getState().players.map((p) => ({ userId: p.user_id, amount: p.stack })),
        actions: events.flatMap((a) =>
          a.type === 'PLAYER_ACTION'
            ? [
                {
                  userId: players.find((p) => p.seat === a.seat)!.user_id,
                  action: a.action,
                  amount: a.amount,
                  stage: a.stage ?? 'preflop',
                  seat: a.seat,
                },
              ]
            : []
        ),
        roster: players.map((p) => ({ userId: p.user_id, isHorse: false })),
      })
    );
  });
  const start = () => engine.handleAllInRunout(event, engine.seatedPlayers);
  const completed = () => events.filter((e) => e.type === 'HAND_COMPLETE');
  const credit = vi.spyOn(controller, 'creditRunoutWinnings');
  return { engine, controller, event, emitted, writes, start, completed, credit };
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('RIT standing-board equity reaches facts before terminal settlement', () => {
  it.each(['mandatory_twice', 'mandatory_three', 'player_choice'] as const)(
    '%s waits for the original worker result before dealing or consuming the fact cache',
    async (mode) => {
      const h = harness(mode);
      let answer!: (result: number[]) => void;
      mocks.estimateEquity.mockReturnValueOnce(
        new Promise<number[]>((resolve) => {
          answer = resolve;
        })
      );
      h.start();
      expect(mocks.estimateEquity).toHaveBeenCalledTimes(1);
      expect(h.completed()).toHaveLength(0);
      expect(h.credit).not.toHaveBeenCalled();
      expect(h.controller.getState().communityCards).toEqual(h.event.board);

      answer([0.8, 0.2]);
      await flush();
      await Promise.all(h.writes);
      expect(h.completed()).toHaveLength(1);
      expect(h.credit).toHaveBeenCalledTimes(1);
      expect(h.engine.currentHandRitBoards).toBe(mode === 'mandatory_twice' ? 2 : 3);
      const facts = mocks.upsert.mock.calls
        .map(([rows]) => rows)
        .find(
          (rows: any) =>
            Array.isArray(rows) &&
            rows[0]?.hand_id === `rit-${h.engine.handCount}` &&
            'all_in_equity' in rows[0]
        ) as any[];
      expect(facts.map((row) => row.all_in_equity)).toEqual([0.8, 0.2]);
      expect(
        h.emitted.mock.calls.filter((call: any[]) => call[1].type === 'all_in_equity')
      ).toHaveLength(1);
      const done = h.completed()[0] as Extract<HandEvent, { type: 'HAND_COMPLETE' }>;
      expect(
        h.controller.getState().players.reduce((sum, p) => sum + p.stack, 0) +
          done.rake +
          done.bbjFee
      ).toBeCloseTo(200, 6);
    }
  );

  it('a failed worker still settles RIT exactly once without invented equity', async () => {
    const h = harness('mandatory_twice');
    mocks.estimateEquity.mockRejectedValueOnce(new Error('bounded worker deadline expired'));
    h.start();
    await flush();
    await Promise.all(h.writes);
    expect(h.completed()).toHaveLength(1);
    expect(h.credit).toHaveBeenCalledTimes(1);
    expect(h.engine.currentHandRitBoards).toBe(2);
    expect(
      h.emitted.mock.calls.filter((call: any[]) => call[1].type === 'all_in_equity')
    ).toHaveLength(0);
    const facts = mocks.upsert.mock.calls
      .map(([rows]) => rows)
      .find(
        (rows: any) =>
          Array.isArray(rows) &&
          rows[0]?.hand_id === `rit-${h.engine.handCount}` &&
          'all_in_equity' in rows[0]
      ) as any[];
    expect(facts.map((row) => row.all_in_equity)).toEqual([null, null]);
  });

  it('reuses the early no-insurance worker and refuses a concurrent second resolver', async () => {
    const h = harness('mandatory_twice', false);
    let answer!: (result: number[]) => void;
    mocks.estimateEquity.mockReturnValueOnce(
      new Promise<number[]>((resolve) => {
        answer = resolve;
      })
    );
    h.start();
    await h.engine.dealAndResolveRIT(h.event.players);
    expect(mocks.estimateEquity).toHaveBeenCalledTimes(1);
    expect(h.credit).not.toHaveBeenCalled();
    answer([0.8, 0.2]);
    await flush();
    await Promise.all(h.writes);
    expect(h.completed()).toHaveLength(1);
    expect(h.credit).toHaveBeenCalledTimes(1);
  });

  it.each(['controller', 'hand_number', 'lifecycle', 'ownership'] as const)(
    'drops the pending resolver after %s changes',
    async (change) => {
      const h = harness('mandatory_twice');
      let answer!: (result: number[]) => void;
      mocks.estimateEquity.mockReturnValueOnce(
        new Promise<number[]>((resolve) => {
          answer = resolve;
        })
      );
      h.start();
      if (change === 'controller') h.engine.handController = null;
      if (change === 'hand_number') h.engine.handCount++;
      if (change === 'lifecycle') h.engine.running = false;
      if (change === 'ownership') h.engine.isCurrentEngine.mockReturnValue(false);
      answer([0.8, 0.2]);
      await flush();
      expect(h.completed()).toHaveLength(0);
      expect(h.credit).not.toHaveBeenCalled();
      expect(h.writes).toHaveLength(0);
      expect(h.engine.ritResolutionOwner).toBeNull();
    }
  );
});
