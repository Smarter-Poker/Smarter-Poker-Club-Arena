import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import { supabase } from '../services/supabase.js';
import {
  currentTournamentDataAuthority,
  runWithTournamentDataAuthority,
} from '../services/supabase/dataActorContext.js';

const TABLE = 'aaaaaaaa-1111-4111-8111-111111111111';
const TOURNEY = 'bbbbbbbb-1111-4111-8111-111111111111';
const GEN = 'cccccccc-1111-4111-8111-111111111111';
const NEXT_GEN = 'dddddddd-1111-4111-8111-111111111111';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup(tableId = TABLE) {
  const engine = Object.create(ServerTableEngine.prototype) as any;
  engine.tableId = tableId;
  engine.handCount = 123;
  engine.lifecycleCanMutate = vi.fn(() => true);
  engine.hub = { sendToUser: vi.fn(), emitEvent: vi.fn() };
  engine.currentHandHoleCards = new Map();
  return engine;
}
function cards(rank = 'A') {
  return [
    { rank, suit: 's' },
    { rank: 'K', suit: 'h' },
  ];
}
function user(i: number) {
  return 'eeeeeeee-1111-4111-8111-' + String(i).padStart(12, '0');
}
async function microtasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('private hole-card writes batch one synchronous deal', () => {
  it('delivers all private socket rows immediately, then awaits one durable RPC for nine seats', async () => {
    const engine = setup();
    const db = deferred<any>();
    const rpc = vi.spyOn(supabase, 'rpc').mockReturnValue(db.promise as any);
    const done = vi.fn();
    const writes = Array.from({ length: 9 }, (_, i) =>
      engine.persistHoleCardsWithRetry(user(i), i + 1, cards()).then(done)
    );
    expect(engine.hub.sendToUser).toHaveBeenCalledTimes(9);
    expect(engine.hub.emitEvent).not.toHaveBeenCalled();
    for (let i = 0; i < 9; i++) {
      const [table, recipient, message] = engine.hub.sendToUser.mock.calls[i];
      expect(table).toBe(TABLE);
      expect(recipient).toBe(user(i));
      expect(message.row).toEqual({
        table_id: TABLE,
        user_id: user(i),
        seat_number: i + 1,
        hand_number: 123,
        cards: cards(),
      });
    }
    await microtasks();
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0] as any;
    expect(name).toBe('insert_hole_cards');
    expect(args.p_table_id).toBe(TABLE);
    expect(args.p_hand_number).toBe(123);
    expect(JSON.parse(args.p_cards)).toEqual(
      Array.from({ length: 9 }, (_, i) => ({
        user_id: user(i),
        seat_number: i + 1,
        cards: cards(),
      }))
    );
    expect(done).not.toHaveBeenCalled();
    db.resolve({ error: null });
    await Promise.all(writes);
    expect(done).toHaveBeenCalledTimes(9);
  });

  it('the CARDS_DEALT event path still fills the reconnect cache and batches its writes', async () => {
    const engine = setup();
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ error: null } as any);
    engine.handController = {
      getState: () => ({
        players: [
          { user_id: user(1), seat: 1 },
          { user_id: user(2), seat: 2 },
        ],
      }),
    };
    await Promise.all(
      [1, 2].map((seat) =>
        engine.handleHandEvent({ type: 'CARDS_DEALT', seat, cards: cards() }, [])
      )
    );
    expect(engine.currentHandHoleCards.size).toBe(2);
    expect(engine.currentHandHoleCards.get(user(2))).toEqual({ seat: 2, cards: cards() });
    expect(engine.hub.sendToUser).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['nlh', 9, 2],
    ['plo6', 6, 6],
  ] as const)(
    'batches a real %s controller deal for %i seats',
    async (variant, count, cardCount) => {
      const engine = setup();
      const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ error: null } as any);
      const players = Array.from({ length: count }, (_, i) => ({
        user_id: user(i + 1),
        seat: i + 1,
        stack: 400,
        bet: 0,
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        cards: [],
      }));
      const controller = new HandController(
        {
          tableId: TABLE,
          handNumber: 123,
          gameVariant: variant,
          smallBlind: 2,
          bigBlind: 4,
          rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
        } as any,
        players as any,
        1
      );
      engine.handController = controller;
      const writes: Promise<void>[] = [];
      controller.onEvent((event) => {
        if (event.type === 'CARDS_DEALT') writes.push(engine.handleHandEvent(event, []));
      });
      controller.start();
      expect(engine.hub.sendToUser).toHaveBeenCalledTimes(count);
      await Promise.all(writes);
      expect(rpc).toHaveBeenCalledTimes(1);
      const rows = JSON.parse((rpc.mock.calls[0][1] as any).p_cards);
      expect(rows).toHaveLength(count);
      expect(rows.every((row: any) => row.cards.length === cardCount)).toBe(true);
      expect(engine.hub.emitEvent).not.toHaveBeenCalled();
    }
  );

  it('captures card values before a later draw can mutate the source array', async () => {
    const engine = setup();
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ error: null } as any);
    const source = cards();
    const write = engine.persistHoleCardsWithRetry(user(1), 1, source);
    source[0].rank = '2';
    source.push({ rank: '3', suit: 'd' });
    await write;
    expect(JSON.parse((rpc.mock.calls[0][1] as any).p_cards)[0].cards).toEqual(cards());
  });

  it('does not share a batch across tables or service and manager generations', async () => {
    const engine = setup();
    const other = setup('ffffffff-1111-4111-8111-111111111111');
    const seen: Array<unknown> = [];
    const rpc = vi.spyOn(supabase, 'rpc').mockImplementation((() => {
      seen.push(currentTournamentDataAuthority());
      return Promise.resolve({ error: null });
    }) as any);
    const calls = [
      engine.persistHoleCardsWithRetry(user(1), 1, cards()),
      other.persistHoleCardsWithRetry(user(2), 2, cards()),
      runWithTournamentDataAuthority({ tournamentId: TOURNEY, leaseGeneration: GEN }, () =>
        engine.persistHoleCardsWithRetry(user(3), 3, cards())
      ),
      runWithTournamentDataAuthority({ tournamentId: TOURNEY, leaseGeneration: NEXT_GEN }, () =>
        engine.persistHoleCardsWithRetry(user(4), 4, cards())
      ),
    ];
    await Promise.all(calls);
    expect(rpc).toHaveBeenCalledTimes(4);
    expect(seen).toEqual([
      null,
      null,
      { tournamentId: TOURNEY, leaseGeneration: GEN },
      { tournamentId: TOURNEY, leaseGeneration: NEXT_GEN },
    ]);
  });

  it('a later reconnect gets another durable write, even while the previous batch is in flight', async () => {
    const engine = setup();
    const first = deferred<any>();
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockReturnValueOnce(first.promise as any)
      .mockResolvedValue({ error: null } as any);
    const pending = engine.persistHoleCardsWithRetry(user(1), 1, cards());
    await microtasks();
    engine.handController = {};
    engine.currentHandHoleCards.set(user(1), { seat: 1, cards: cards() });
    await engine.rePushHoleCards(user(1));
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(engine.hub.sendToUser).toHaveBeenCalledTimes(2);
    first.resolve({ error: null });
    await pending;
  });

  it('retries the immutable whole batch and reports recovery for every affected player', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = setup();
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValue({ error: { message: 'unavailable' } } as any);
    const writes = [1, 2].map((seat) =>
      engine.persistHoleCardsWithRetry(user(seat), seat, cards())
    );
    await vi.runAllTimersAsync();
    await Promise.all(writes);
    expect(rpc).toHaveBeenCalledTimes(3);
    const args = rpc.mock.calls.map((call) => call[1]);
    expect(args[1]).toEqual(args[0]);
    expect(args[2]).toEqual(args[0]);
    expect(engine.hub.emitEvent).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) {
      expect(engine.hub.emitEvent.mock.calls[i]).toEqual([
        TABLE,
        {
          type: 'hole_cards_unavailable',
          table_id: TABLE,
          hand_number: 123,
          user_id: user(i + 1),
          seat: i + 1,
          timestamp: expect.any(Number),
        },
      ]);
    }
  });

  it('owns thrown RPC errors and resolves all callers after a successful retry', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = setup();
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockRejectedValueOnce(new Error('network lost'))
      .mockResolvedValue({ error: null } as any);
    const writes = [1, 2].map((seat) =>
      engine.persistHoleCardsWithRetry(user(seat), seat, cards())
    );
    await vi.runAllTimersAsync();
    await Promise.all(writes);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(engine.hub.emitEvent).not.toHaveBeenCalled();
  });

  it('retired engines do not deliver or enqueue new cards', async () => {
    const engine = setup();
    engine.lifecycleCanMutate.mockReturnValue(false);
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ error: null } as any);
    await engine.persistHoleCardsWithRetry(user(1), 1, cards());
    expect(rpc).not.toHaveBeenCalled();
    expect(engine.hub.sendToUser).not.toHaveBeenCalled();
  });

  it('retirement before the flush cancels only that pending write', async () => {
    const engine = setup();
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ error: null } as any);
    const write = engine.persistHoleCardsWithRetry(user(1), 1, cards());
    engine.lifecycleCanMutate.mockReturnValue(false);
    await write;
    expect(rpc).not.toHaveBeenCalled();
  });

  it('new hands cannot inherit an older queued write', async () => {
    const engine = setup();
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ error: null } as any);
    const old = engine.persistHoleCardsWithRetry(user(1), 1, cards());
    engine.handCount = 124;
    const fresh = engine.persistHoleCardsWithRetry(user(2), 2, cards('Q'));
    await Promise.all([old, fresh]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect((rpc.mock.calls[0][1] as any).p_hand_number).toBe(124);
    expect(JSON.parse((rpc.mock.calls[0][1] as any).p_cards)).toEqual([
      { user_id: user(2), seat_number: 2, cards: cards('Q') },
    ]);
  });

  it.each(['retired', 'next hand'])(
    'does not retry or emit stale recovery after %s',
    async (reason) => {
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const engine = setup();
      const rpc = vi
        .spyOn(supabase, 'rpc')
        .mockResolvedValue({ error: { message: 'unavailable' } } as any);
      const write = engine.persistHoleCardsWithRetry(user(1), 1, cards());
      await microtasks();
      if (reason === 'retired') engine.lifecycleCanMutate.mockReturnValue(false);
      else engine.handCount++;
      await vi.runAllTimersAsync();
      await write;
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(engine.hub.emitEvent).not.toHaveBeenCalled();
    }
  );
});
