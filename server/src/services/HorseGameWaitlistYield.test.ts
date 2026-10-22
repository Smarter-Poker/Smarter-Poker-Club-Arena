/**
 * A PERSON ON A GAME'S LIST IS A PERSON WAITING (2026-10-22).
 *
 * Found live: both Lightning pilot games 100% horses, and a person who used
 * the Lightning door sat on `cash_game_waitlist` for ever, because the tick
 * stands down for a Lightning Cluster and every yield path read only
 * `table_waitlist`. Pinned here against the pure attribution and against the
 * three real readers (the rotator, the fleet, the Stable Hand snapshot)
 * driven through a fake PostgREST.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from './supabase.js';
import {
  GAME_WAIT_NOTIFIED_TTL_MS,
  attributeGameWaiters,
  gameQueueKey,
  servedKeys,
  tickServesGameList,
  yieldTableForGame,
  type GameWaitGame,
  type GameWaitRow,
  type GameWaitTable,
} from './HorseGameWaitlistYield.js';
import { HorseSessionRotator, type RotatorEngine } from './HorseSessionRotator.js';
import { HorseFleetManager } from './HorseFleetManager.js';
import { buildFloorSnapshot, clearPopulationCache } from './StableHandSnapshot.js';
import { planFloor } from './StableHandController.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';
import { MIDWAY_UNION_ID, JAQK_CLUB_ID } from './StableHand.js';

const NOW = Date.parse('2026-10-22T09:15:00Z');
const LIGHTNING = 'aaaaaaaa-0000-4000-8000-000000000001';
const MUSTMOVE = 'aaaaaaaa-0000-4000-8000-000000000002';
const T_A = '10000000-0000-4000-8000-00000000000a';
const T_B = '10000000-0000-4000-8000-00000000000b';
const T_C = '10000000-0000-4000-8000-00000000000c';
const T_M = '10000000-0000-4000-8000-00000000000d';
const PERSON = 'p0000000-0000-4000-8000-000000000001';
const PERSON2 = 'p0000000-0000-4000-8000-000000000002';
const HORSE_WAITER = 'h0000000-0000-4000-8000-0000000000ff';

const lightningGame: GameWaitGame = {
  id: LIGHTNING,
  must_move: true,
  cluster_mode: 'lightning',
  enabled: true,
};
const mustMoveGame: GameWaitGame = {
  id: MUSTMOVE,
  must_move: true,
  cluster_mode: 'must_move',
  enabled: true,
};
const fullTables: GameWaitTable[] = [
  { id: T_B, clusterId: LIGHTNING, lifecycle: 'live', horses: 6 },
  { id: T_A, clusterId: LIGHTNING, lifecycle: 'live', horses: 6 },
  { id: T_C, clusterId: LIGHTNING, lifecycle: 'live', horses: 5 },
  { id: T_M, clusterId: MUSTMOVE, lifecycle: 'live', horses: 9 },
];
const row = (o: Partial<GameWaitRow> = {}): GameWaitRow => ({
  id: 'w1',
  game_id: LIGHTNING,
  user_id: PERSON,
  status: 'waiting',
  created_at: new Date(NOW - 60_000).toISOString(),
  updated_at: new Date(NOW - 60_000).toISOString(),
  ...o,
});
const attribute = (
  rows: GameWaitRow[],
  over: Partial<Parameters<typeof attributeGameWaiters>[0]> = {}
) =>
  attributeGameWaiters({
    rows,
    games: [lightningGame, mustMoveGame],
    horseIds: new Set([HORSE_WAITER]),
    tables: fullTables,
    alreadyServed: new Set(),
    nowMs: NOW,
    ...over,
  });

describe('the attribution: one game-list person, one table, once', () => {
  it('a Lightning game, every seat a horse, one person waiting: exactly one table owes a chair', () => {
    const out = attribute([row()]);
    expect([...out.entries()]).toEqual([[T_A, { count: 1, oldestMs: NOW - 60_000 }]]);
  });

  it('the table is the one with the most horses, ties by id, and only a live one', () => {
    expect(yieldTableForGame(LIGHTNING, fullTables)).toBe(T_A);
    expect(
      yieldTableForGame(LIGHTNING, [
        { id: T_A, clusterId: LIGHTNING, lifecycle: 'breaking', horses: 6 },
        { id: T_C, clusterId: LIGHTNING, lifecycle: 'live', horses: 2 },
      ])
    ).toBe(T_C);
    expect(
      yieldTableForGame(LIGHTNING, [
        { id: T_A, clusterId: LIGHTNING, lifecycle: 'live', horses: 0 },
      ])
    ).toBeNull();
  });

  it('a horse on the game list is ignored', () => {
    expect(attribute([row({ user_id: HORSE_WAITER })]).size).toBe(0);
  });

  it('an ordinary must-move game, whose tick opens tables for its list, is not counted again', () => {
    expect(tickServesGameList(mustMoveGame)).toBe(true);
    expect(tickServesGameList(lightningGame)).toBe(false);
    expect(attribute([row({ game_id: MUSTMOVE })]).size).toBe(0);
  });

  it('a disabled game is not counted: no offer would follow the vacancy', () => {
    expect(attribute([row()], { games: [{ ...lightningGame, enabled: false }] }).size).toBe(0);
  });

  it('a person already on a table list of the game, or seated in it, is not counted twice', () => {
    expect(
      attribute([row()], { alreadyServed: new Set([gameQueueKey(LIGHTNING, PERSON)]) }).size
    ).toBe(0);
    expect(attribute([row()], { alreadyServed: new Set([gameQueueKey('*', PERSON)]) }).size).toBe(
      0
    );
    const served = servedKeys([{ table_id: T_C, user_id: PERSON }], fullTables);
    expect(served.has(gameQueueKey(LIGHTNING, PERSON))).toBe(true);
  });

  it('two people are two chairs on the same table; a stale offer or a day-old place is not', () => {
    const out = attribute([
      row(),
      row({ id: 'w2', user_id: PERSON2, created_at: new Date(NOW - 120_000).toISOString() }),
      row({
        id: 'w3',
        user_id: 'p-stale-offer',
        status: 'notified',
        updated_at: new Date(NOW - GAME_WAIT_NOTIFIED_TTL_MS - 1).toISOString(),
      }),
      row({ id: 'w4', user_id: 'p-old', created_at: new Date(NOW - 25 * 3600_000).toISOString() }),
    ]);
    expect([...out.entries()]).toEqual([[T_A, { count: 2, oldestMs: NOW - 120_000 }]]);
  });
});

/* ── A FAKE POSTGREST ──────────────────────────────────────────────────────
   Enough of the builder for the readers under test: select/eq/in/is/gt/lte/
   order/limit/range/not, awaited. Each table answers from a fixture; a table
   named in `fail` answers with an error, which is what an incomplete read is. */
type Rows = Record<string, any>[];
function fakeDb(tables: Record<string, Rows>, fail: Set<string> = new Set()) {
  const calls: string[] = [];
  const build = (name: string) => {
    let rows = [...(tables[name] ?? [])];
    let from = 0;
    let to = Infinity;
    let lim = Infinity;
    const pick = (r: any, col: string) => r[col];
    const b: any = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => ((rows = rows.filter((r) => pick(r, c) === v)), b);
    b.in = (c: string, v: unknown[]) => ((rows = rows.filter((r) => v.includes(pick(r, c)))), b);
    b.is = (c: string, v: unknown) => ((rows = rows.filter((r) => (pick(r, c) ?? null) === v)), b);
    b.gt = (c: string, v: any) => ((rows = rows.filter((r) => String(pick(r, c)) > String(v))), b);
    b.lte = () => b;
    b.not = () => b;
    b.order = () => b;
    b.limit = (n: number) => ((lim = n), b);
    b.range = (a: number, z: number) => ((from = a), (to = z), b);
    b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
      calls.push(name);
      if (fail.has(name))
        return Promise.resolve({ data: null, error: { message: 'boom' } }).then(ok, bad);
      const out = rows.slice(from, Math.min(rows.length, to + 1)).slice(0, lim);
      return Promise.resolve({ data: out, error: null }).then(ok, bad);
    };
    return b;
  };
  vi.spyOn(supabase, 'from').mockImplementation(((name: string) => build(name)) as never);
  vi.spyOn(supabase, 'rpc').mockImplementation((() =>
    Promise.resolve({ data: null, error: { message: 'no rpc in fixture' } })) as never);
  return calls;
}

const HORSES = Array.from(
  { length: 18 },
  (_, i) => `h0000000-0000-4000-8000-${String(i).padStart(12, '0')}`
);
const tableRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  big_blind: 0.02,
  tournament_id: null,
  status: 'running',
  settings: {},
  cluster_id: LIGHTNING,
  role: 'main',
  main_index: 1,
  lifecycle: 'live',
  created_at: new Date(NOW - 3600_000).toISOString(),
  max_players: 6,
  min_buy_in: 1,
  max_buy_in: 4,
  ...extra,
});
function lightningFloor(opts: { tableWaitlist?: Rows; gameWaitlist?: Rows; games?: Rows } = {}) {
  const tables = [
    tableRow(T_A),
    tableRow(T_B, { role: 'feeder', main_index: null }),
    tableRow(T_C),
  ];
  const seats: Rows = [];
  tables.forEach((t, ti) => {
    for (let s = 0; s < 6; s++) {
      seats.push({
        id: `s-${ti}-${s}`,
        table_id: t.id,
        user_id: HORSES[ti * 6 + s],
        seat_number: s + 1,
        stack: 2,
        joined_at: new Date(NOW - (60 + s) * 60_000).toISOString(),
        club_id: JAQK_CLUB_ID,
        leave_pending: false,
        is_sitting_out: false,
        left_at: null,
        tables: t,
      });
    }
  });
  return {
    table_seats: seats,
    profiles: [...HORSES, HORSE_WAITER].map((id) => ({ id, is_horse: true })),
    club_members: [],
    chip_ledger: [],
    table_waitlist: opts.tableWaitlist ?? [],
    cash_game_waitlist: opts.gameWaitlist ?? [],
    cash_games: opts.games ?? [{ ...lightningGame }, { ...mustMoveGame }],
    cash_seat_moves: [],
    hand_history: [],
    tournament_players: [],
    tables: tables.map((t) => ({ ...t, is_deleted: false })),
  };
}
const gameRow = (o: Partial<GameWaitRow> = {}) => ({ ...row(), ...o });

describe('the rotator stands exactly one horse up for a game-list person', () => {
  beforeEach(() => {
    setMaintenanceFrozen(false);
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    for (const m of ['log', 'warn', 'error'] as const)
      vi.spyOn(console, m).mockImplementation(() => {});
    vi.spyOn(Math, 'random').mockReturnValue(0.999999); // no discretionary departures or breaks
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const run = async (db: ReturnType<typeof lightningFloor>, fail?: Set<string>) => {
    const calls = fakeDb(db, fail);
    const leaves: Array<{ tableId: string; userId: string }> = [];
    const engine = (tableId: string): RotatorEngine => ({
      leaveTable: (userId: string) => {
        leaves.push({ tableId, userId });
        return { success: true };
      },
      sitOut: () => ({ success: true }),
    });
    const rot = new HorseSessionRotator(engine) as any;
    rot.isRunning = true;
    rot.lifecycleGeneration = 1;
    await rot.rotate(1);
    return { leaves, calls };
  };

  it('Lightning game, all 18 seats horses, one person on the game list: one horse, one table', async () => {
    const { leaves } = await run(lightningFloor({ gameWaitlist: [gameRow()] }));
    expect(leaves).toHaveLength(1);
    expect(leaves[0].tableId).toBe(T_A);
    // The newest arrival is the one asked, as for any table-list person.
    expect(leaves[0].userId).toBe(HORSES[0]);
  });

  it('a horse on the game list stands nobody up', async () => {
    const { leaves } = await run(
      lightningFloor({ gameWaitlist: [gameRow({ user_id: HORSE_WAITER })] })
    );
    expect(leaves).toHaveLength(0);
  });

  it('an incomplete game-list read fails closed: nobody is asked to leave', async () => {
    const { leaves } = await run(
      lightningFloor({ gameWaitlist: [gameRow()] }),
      new Set(['cash_game_waitlist'])
    );
    expect(leaves).toHaveLength(0);
  });

  it('an ordinary must-move game whose tick opens tables for its list is not double counted', async () => {
    const db = lightningFloor({
      gameWaitlist: [gameRow({ game_id: MUSTMOVE })],
      games: [{ ...mustMoveGame }, { ...lightningGame, id: LIGHTNING }],
    });
    // Same full floor, but the person waits on a game the tick serves.
    const { leaves } = await run(db);
    expect(leaves).toHaveLength(0);
  });

  it('table_waitlist behaviour is unchanged: a table-list person stands one horse up at that table', async () => {
    const { leaves } = await run(
      lightningFloor({
        tableWaitlist: [{ id: 'tw1', table_id: T_C, user_id: PERSON, status: 'waiting' }],
      })
    );
    expect(leaves).toHaveLength(1);
    expect(leaves[0].tableId).toBe(T_C);
  });

  it('a person on both lists of the game is counted once, at their table list', async () => {
    const { leaves } = await run(
      lightningFloor({
        tableWaitlist: [{ id: 'tw1', table_id: T_C, user_id: PERSON, status: 'notified' }],
        gameWaitlist: [
          gameRow({ status: 'notified', updated_at: new Date(NOW - 10_000).toISOString() }),
        ],
      })
    );
    expect(leaves).toHaveLength(1);
    expect(leaves[0].tableId).toBe(T_C);
  });
});

describe('the fleet subtracts the game-list person from exactly one table', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    for (const m of ['log', 'warn', 'error'] as const)
      vi.spyOn(console, m).mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const gameTables: GameWaitTable[] = fullTables.filter((t) => t.clusterId === LIGHTNING);
  const fleet = () => new HorseFleetManager() as any;

  it('one person on a Lightning list reads as one person waiting at the most-horsed table', async () => {
    fakeDb(lightningFloor({ gameWaitlist: [gameRow()] }));
    const out: Map<string, number> = await fleet().humansWaitingByTable(
      new Set(HORSES),
      () => true,
      gameTables,
      []
    );
    expect([...out.entries()]).toEqual([[T_A, 1]]);
  });

  it('a horse waiter, a must-move game, and an incomplete read each add nobody', async () => {
    fakeDb(lightningFloor({ gameWaitlist: [gameRow({ user_id: HORSE_WAITER })] }));
    expect(
      (
        await fleet().humansWaitingByTable(
          new Set([...HORSES, HORSE_WAITER]),
          () => true,
          gameTables,
          []
        )
      ).size
    ).toBe(0);
    vi.restoreAllMocks();
    fakeDb(lightningFloor({ gameWaitlist: [gameRow({ game_id: MUSTMOVE })] }));
    expect(
      (await fleet().humansWaitingByTable(new Set(HORSES), () => true, gameTables, [])).size
    ).toBe(0);
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeDb(
      lightningFloor({
        gameWaitlist: [gameRow()],
        tableWaitlist: [{ id: 'tw1', table_id: T_C, user_id: PERSON2, status: 'waiting' }],
      }),
      new Set(['cash_game_waitlist'])
    );
    // Fails CLOSED as a whole: not even the table-list person is counted on a half read.
    expect(
      (await fleet().humansWaitingByTable(new Set(HORSES), () => true, gameTables, [])).size
    ).toBe(0);
  });

  it('without game tables the table-list count is exactly what it always was', async () => {
    const calls = fakeDb(
      lightningFloor({
        gameWaitlist: [gameRow()],
        tableWaitlist: [{ id: 'tw1', table_id: T_C, user_id: PERSON2, status: 'waiting' }],
      })
    );
    const out: Map<string, number> = await fleet().humansWaitingByTable(
      new Set(HORSES),
      () => true
    );
    expect([...out.entries()]).toEqual([[T_C, 1]]);
    expect(calls).not.toContain('cash_game_waitlist');
  });
});

describe("Stable Hand's human_yield applies yieldCount once, on one table", () => {
  beforeEach(() => {
    clearPopulationCache();
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    for (const m of ['log', 'warn', 'error'] as const)
      vi.spyOn(console, m).mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const hostFloor = (gameWaitlist: Rows, failing?: Set<string>) => {
    const db = lightningFloor({ gameWaitlist });
    const tables = db.tables.map((t) => ({
      ...t,
      club_id: MIDWAY_UNION_ID,
      game_variant: 'nlh',
      small_blind: 0.01,
      current_players: 6,
    }));
    fakeDb(
      {
        ...db,
        tables,
        club_members: HORSES.map((user_id) => ({
          club_id: JAQK_CLUB_ID,
          user_id,
          status: 'active',
        })),
      },
      failing
    );
  };

  it('one person on a Lightning list: human_yield orders on exactly one table, yieldCount(1) of them', async () => {
    hostFloor([gameRow()]);
    const snap = await buildFloorSnapshot();
    expect(snap.unreadableHosts).toEqual([]);
    const yields = planFloor(snap).stand.filter((o) => o.reason === 'human_yield');
    expect(new Set(yields.map((o) => o.tableId))).toEqual(new Set([T_A]));
    expect(yields).toHaveLength(2); // yieldCount(1) = humans_waiting + 1
    const t = snap.hosts[0].tables.find((x) => x.tableId === T_A)!;
    expect(t.waitlistOldestJoinedAtMs).toBe(NOW - 60_000);
  });

  it('a horse waiter yields nobody; an incomplete read leaves the host out, ordering nobody', async () => {
    hostFloor([gameRow({ user_id: HORSE_WAITER })]);
    let snap = await buildFloorSnapshot();
    expect(planFloor(snap).stand.filter((o) => o.reason === 'human_yield')).toHaveLength(0);
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    hostFloor([gameRow()], new Set(['cash_game_waitlist']));
    snap = await buildFloorSnapshot();
    expect(snap.unreadableHosts).toEqual([MIDWAY_UNION_ID]);
    expect(planFloor(snap).stand).toHaveLength(0);
  });
});
