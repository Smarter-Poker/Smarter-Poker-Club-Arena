/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A FORGED ARENA REQUEST IS REFUSED (Diamond Arena, D2, 2026-09-19)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Diamond Arena is one open club played with Diamonds. Every money door it
 * shares with the chip estate takes a table id and nothing else that names
 * the arena: the engine reads the arena off the TABLE it loaded (`tableInfo`
 * from `loadTable`, which parses `tables.arena` and refuses a mismatch), and
 * the database reads it off the table row again. So a client that posts
 * `club_id`, `asset`, `role`, `user_id` or `arena` in a body is posting words
 * nobody reads.
 *
 * This file proves that at every door a browser can reach, for a Diamond
 * table and for a chip table:
 *
 *   POST /action, POST /timebank        the HTTP handlers
 *   POST /addchips (top-up)             the HTTP handler and the engine door
 *   POST /leave-occupancy (cash-out)    the HTTP handler and the engine door
 *   POST /leave (retired)               never reaches an engine at all
 *   buy-in, tournament register         no engine HTTP door exists; the SQL
 *                                       doors are certified by the runners in
 *                                       tests/sql (poker-diamond-forged-arena-
 *                                       acceptance.sql) and the engine-side
 *                                       boundary those doors share is the
 *                                       table identity parser pinned below
 *
 * Refusal here means two things, both asserted: the forged words never reach
 * the engine or the RPC (the only identity forwarded is the JWT's), and when
 * the actor behind the JWT has no seat, nothing moves - no RPC is called at
 * all, or the RPC is called for the actor and refused.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth.js', () => ({ authenticateRequest: vi.fn() }));
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (e: unknown) => String(e),
}));
vi.mock('../services/financialAlerts.js', () => ({ raiseFinancialAlert: vi.fn() }));

import { authenticateRequest } from './auth.js';
import { handleAction } from '../handlers/action.js';
import { handleTimebank } from '../handlers/timebank.js';
import { handleAddchips } from '../handlers/addchips.js';
import { handleLeave } from '../handlers/leave.js';
import { handleLeaveOccupancy } from '../handlers/leaveOccupancy.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { supabase } from '../services/supabase/client.js';
import { parseTableArenaIdentity } from '../domain/ArenaContext.js';
import {
  assertDiamondCashTable,
  assertDiamondTable,
  assertDiamondTournamentTable,
} from '../domain/DiamondCashBoundary.js';

const TABLES_LOADER = fileURLToPath(new URL('../services/supabase/tables.ts', import.meta.url));

const ACTOR = '11111111-1111-4111-8111-111111111111';
const VICTIM = '22222222-2222-4222-8222-222222222222';
const DIAMOND_TABLE = '00000000-0000-4000-8000-00000000d1a0';
const CHIP_TABLE = '00000000-0000-4000-8000-00000000c41b';
const OCCUPANCY = '33333333-3333-4333-8333-333333333333';

/** Everything a hostile client might post to move the financial context. */
const FORGED = {
  club_id: 'shark-club',
  clubId: '20000000-0000-4000-8000-000000000001',
  asset: 'chips',
  role: 'owner',
  user_id: VICTIM,
  userId: VICTIM,
  is_platform: false,
  union_id: 'union-1',
  tournament_id: 'event-1',
  arena: { id: 'shark', asset: 'chips', is_platform: false, union_id: null },
};
const FORGED_VALUES = ['shark-club', 'shark', 'owner', VICTIM, 'union-1', 'event-1'];

const diamondArena = { id: 'arena', asset: 'diamonds', kind: 'diamond_arena' } as const;
const chipArena = { id: 'club', asset: 'chips', kind: 'chip_club' } as const;
type TableRow = Record<string, unknown> & {
  id: string;
  arena: typeof diamondArena | typeof chipArena;
};
const diamondTable: TableRow = {
  id: DIAMOND_TABLE,
  club_id: 'arena',
  union_id: null,
  arena: diamondArena,
  game_variant: 'nlh',
  tournament_id: null,
  cluster_id: null,
  status: 'waiting',
  small_blind: 1,
  big_blind: 2,
  min_buy_in: 20,
  max_buy_in: 200,
  ante: 0,
  rake_percent: 0,
  rake_cap_bb: 0,
  bbj_percent: 0,
  run_it_twice: false,
  allow_run_it_twice: false,
};
const chipTable: TableRow = { ...diamondTable, id: CHIP_TABLE, club_id: 'club', arena: chipArena };

function request(body: unknown, url = '/'): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    url,
    headers: { host: 'localhost' },
  }) as IncomingMessage;
}

function response() {
  const state = { status: 0, body: {} as Record<string, unknown> };
  const res = {
    writeHead(status: number) {
      state.status = status;
    },
    end(body: string) {
      state.body = JSON.parse(body);
    },
  } as unknown as ServerResponse;
  return { state, res };
}

/** Nothing the client forged may appear anywhere in what the engine was told. */
function expectNothingForged(calls: unknown[][]) {
  const text = JSON.stringify(calls);
  for (const value of FORGED_VALUES)
    expect(text, `${value} reached the engine`).not.toContain(value);
  expect(text).not.toContain('"asset"');
  expect(text).not.toContain('club_id');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequest).mockResolvedValue({ userId: ACTOR } as Awaited<
    ReturnType<typeof authenticateRequest>
  >);
});
afterEach(() => vi.restoreAllMocks());

/* ─────────────────────────────────────────────────────────────────────────────
   THE HTTP HANDLERS. A stub engine records what it was told; the assertion is
   that it was told the JWT identity and the table-scoped arguments, and not
   one forged word. Each handler is exercised for a Diamond table id and a chip
   table id, because the handlers do not know the difference and must not.
   ───────────────────────────────────────────────────────────────────────── */
describe.each([
  ['a Diamond table', DIAMOND_TABLE],
  ['a chip table', CHIP_TABLE],
])('the HTTP doors at %s ignore a forged arena', (_label, tableId) => {
  it('POST /action acts for the JWT identity and forwards no forged field', async () => {
    const handlePlayerAction = vi.fn(() => ({ success: true }));
    const recordActionPerformance = vi.fn();
    const getTableEngine = vi.fn((id: string) =>
      id === tableId ? { handlePlayerAction, recordActionPerformance } : undefined
    );
    const { res, state } = response();
    await handleAction(request({ tableId, action: 'raise', amount: 50, ...FORGED }), res, {
      gameServer: { getTableEngine },
    });
    expect(state.status).toBe(200);
    expect(getTableEngine).toHaveBeenCalledWith(tableId);
    expect(handlePlayerAction).toHaveBeenCalledTimes(1);
    expect(handlePlayerAction).toHaveBeenCalledWith(ACTOR, 'raise', 50, null);
    expectNothingForged(handlePlayerAction.mock.calls);
  });

  it('POST /action for a forged user id lands on the actor, who the engine then refuses', async () => {
    const handlePlayerAction = vi.fn((userId: string) =>
      userId === VICTIM ? { success: true } : { success: false, error: 'Not your turn' }
    );
    const { res, state } = response();
    await handleAction(request({ tableId: tableId + '-b', action: 'fold', ...FORGED }), res, {
      gameServer: {
        getTableEngine: () => ({ handlePlayerAction, recordActionPerformance: vi.fn() }),
      },
    });
    expect(state.status).toBe(400);
    expect(state.body).toEqual({ success: false, error: 'Not your turn' });
    expect(handlePlayerAction.mock.calls[0][0]).toBe(ACTOR);
  });

  it('POST /timebank asks for the JWT identity only', async () => {
    const activateTimeBank = vi.fn(async () => ({ success: true }));
    const { res, state } = response();
    await handleTimebank(request({ tableId, ...FORGED }), res, {
      gameServer: { getTableEngine: () => ({ activateTimeBank }) },
    });
    expect(state.status).toBe(200);
    expect(activateTimeBank).toHaveBeenCalledTimes(1);
    expect(activateTimeBank).toHaveBeenCalledWith(ACTOR);
    expectNothingForged(activateTimeBank.mock.calls);
  });

  it('POST /addchips (top-up) hands the engine the actor, the amount and the attempt id', async () => {
    const addChips = vi.fn(async () => ({ success: true, applied: 25 }));
    const { res, state } = response();
    await handleAddchips(request({ tableId, amount: 25, opId: 'attempt-0001', ...FORGED }), res, {
      gameServer: { getTableEngine: () => ({ addChips }) },
    });
    expect(state.status).toBe(200);
    expect(addChips).toHaveBeenCalledTimes(1);
    expect(addChips).toHaveBeenCalledWith(ACTOR, 25, 'attempt-0001');
    expectNothingForged(addChips.mock.calls);
  });

  it('POST /leave-occupancy (cash-out) looks up and leaves as the actor, never the forged user', async () => {
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: null, error: null } as any);
    const leaveTable = vi.fn(async () => ({
      success: false,
      immediate: false,
      code: 'STALE_OCCUPANCY' as const,
      error: 'This Request Belongs To A Previous Seat.',
    }));
    const { res, state } = response();
    const uuidTable = tableId;
    await handleLeaveOccupancy(
      request({ tableId: uuidTable, occupancyId: OCCUPANCY, seatNumber: 3, ...FORGED }),
      res,
      { gameServer: { getTableEngine: () => ({ leaveTable }) } }
    );
    expect(state.status).toBe(409);
    expect(state.body.success).toBe(false);
    /* The receipt lookup that precedes the engine is keyed on the JWT user. */
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('fn_get_seat_cashout_receipt', {
      p_user_id: ACTOR,
      p_table_id: uuidTable,
      p_seat_number: 3,
      p_occupancy_id: OCCUPANCY,
    });
    expect(leaveTable).toHaveBeenCalledTimes(1);
    expect(leaveTable).toHaveBeenCalledWith(ACTOR, {
      occupancyId: OCCUPANCY,
      seatNumber: 3,
    });
    expectNothingForged(leaveTable.mock.calls);
    expectNothingForged(rpc.mock.calls as unknown[][]);
  });

  it('POST /leave (retired) acknowledges no cash-out and touches no engine', async () => {
    const getTableEngine = vi.fn();
    const { res, state } = response();
    await handleLeave(request({ tableId, ...FORGED }), res, { gameServer: { getTableEngine } });
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ success: false, code: 'SEAT_OCCUPANCY_REQUIRED' });
    expect(getTableEngine).not.toHaveBeenCalled();
  });

  it('refuses every door before reading the body when the JWT is missing', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue(null);
    const rpc = vi.spyOn(supabase, 'rpc');
    for (const handler of [
      handleAction,
      handleTimebank,
      handleAddchips,
      handleLeaveOccupancy,
      handleLeave,
    ]) {
      const getTableEngine = vi.fn();
      const { res, state } = response();
      await handler(
        request({
          tableId,
          action: 'fold',
          amount: 25,
          occupancyId: OCCUPANCY,
          seatNumber: 1,
          ...FORGED,
        }),
        res,
        { gameServer: { getTableEngine } } as any
      );
      expect(state.status, handler.name).toBe(401);
      expect(getTableEngine, handler.name).not.toHaveBeenCalled();
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   THE ENGINE DOORS. A real ServerTableEngine with its table loaded as the
   arena says, and the RPC layer spied. The engine has no body to read: the
   only inputs are the JWT identity the handler forwarded and the amount. What
   is proved is that the DOOR is chosen by the table and the RPC carries only
   table-scoped identity, and that an actor with no seat moves nothing.
   ───────────────────────────────────────────────────────────────────────── */
describe('the engine derives the money door from the table it loaded', () => {
  function engineFor(table: TableRow, seated: Array<Record<string, unknown>>) {
    const engine = new ServerTableEngine(table.id) as any;
    engine.tableInfo = table;
    engine.seatedPlayers = seated;
    engine.lifecycleCanMutate = () => true;
    engine.broadcastCurrentState = () => {};
    return engine;
  }
  const hero = {
    user_id: ACTOR,
    seat_number: 1,
    stack: 40,
    is_horse: false,
    occupancy_id: OCCUPANCY,
  };

  it('a top-up at a Diamond table goes through the Diamond custody door, whatever the client claimed', async () => {
    const engine = engineFor(diamondTable, [hero]);
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValue({ data: { success: true, stack: 140 }, error: null } as any);
    await expect(engine.addChips(ACTOR, 100, 'attempt-0001')).resolves.toEqual({
      success: true,
      applied: 100,
    });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['fn_poker_diamond_top_up']);
    expect(Object.keys(rpc.mock.calls[0][1] as object).sort()).toEqual([
      'p_amount',
      'p_expected_stack',
      'p_request_id',
      'p_table_id',
      'p_user_id',
    ]);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_user_id: ACTOR, p_table_id: DIAMOND_TABLE });
  });

  it('a top-up at a chip table goes through the chip add-on door and never the Diamond one', async () => {
    const engine = engineFor(chipTable, [hero]);
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: null, error: null } as any);
    await expect(engine.addChips(ACTOR, 100, 'attempt-0001')).resolves.toMatchObject({
      success: true,
    });
    /* The chip continuity mirror re-reads the cash session afterwards; that
       is a read, not a door. The one money door is the chip add-on. */
    const names = rpc.mock.calls.map((c) => c[0]);
    expect(names.filter((n) => n === 'atomic_table_addon')).toHaveLength(1);
    expect(names).not.toContain('fn_poker_diamond_top_up');
    expect(Object.keys(rpc.mock.calls[0][1] as object).sort()).toEqual([
      'p_amount',
      'p_apply_to_seat',
      'p_idempotency_key',
      'p_table_id',
      'p_user_id',
    ]);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_user_id: ACTOR, p_table_id: CHIP_TABLE });
  });

  it.each([
    ['a Diamond table', diamondTable],
    ['a chip table', chipTable],
  ])('a top-up by an actor with no seat at %s moves nothing', async (_label, table) => {
    const engine = engineFor(table, [{ ...hero, user_id: VICTIM }]);
    const rpc = vi.spyOn(supabase, 'rpc');
    await expect(engine.addChips(ACTOR, 100, 'attempt-0001')).resolves.toEqual({
      success: false,
      error: 'Player not seated',
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(engine.diamondTopUpIntents.size).toBe(0);
    expect(engine.pendingAddOns.size).toBe(0);
  });

  it.each([
    ['a Diamond table', diamondTable, 'diamonds'],
    ['a chip table', chipTable, 'chips'],
  ])(
    'a cash-out at %s is keyed on the actor and the occupancy, nothing more',
    async (_label, table, asset) => {
      const engine = engineFor(table, [hero]);
      const rpc = vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, args: any) => {
        if (name === 'fn_cashout_seat_occupancy')
          return {
            data: {
              ok: true,
              asset,
              stack: 40,
              credited: true,
              seat_number: args.p_seat_number,
              occupancy_id: args.p_occupancy_id,
              user_id: args.p_user_id,
              table_id: args.p_table_id,
              idempotency_key: 'cashout:occupancy:' + args.p_occupancy_id,
              tournament_table: false,
            },
            error: null,
          } as any;
        return { data: null, error: null } as any;
      }) as any);
      vi.spyOn(supabase, 'from').mockImplementation((() => {
        const chain: any = {};
        for (const m of ['select', 'eq', 'neq', 'is', 'in', 'update', 'insert', 'order', 'limit'])
          chain[m] = () => chain;
        chain.maybeSingle = async () => ({ data: null, error: null });
        chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
        return chain;
      }) as any);
      const result = await engine.leaveTable(ACTOR, { occupancyId: OCCUPANCY, seatNumber: 1 });
      expect(result).toMatchObject({ success: true, immediate: true });
      const cashouts = rpc.mock.calls.filter((c) => c[0] === 'fn_cashout_seat_occupancy');
      expect(cashouts).toHaveLength(1);
      expect(cashouts[0][1]).toEqual({
        p_user_id: ACTOR,
        p_table_id: table.id,
        p_seat_number: 1,
        p_occupancy_id: OCCUPANCY,
        p_leave_mode: 'voluntary',
      });
      expect(engine.seatedPlayers).toEqual([]);
    }
  );

  it.each([
    ['a Diamond table', diamondTable],
    ['a chip table', chipTable],
  ])(
    'a cash-out at %s by an actor claiming another seat is refused for the actor',
    async (_label, table) => {
      /* The victim holds the occupancy. The actor asks to cash it out. The
       engine asks the database as the ACTOR, and the database refuses an
       identity that holds no such seat; the victim's chips do not move. */
      const engine = engineFor(table, [{ ...hero, user_id: VICTIM }]);
      const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({
        data: null,
        error: { message: 'CASHOUT_STALE_OCCUPANCY' },
      } as any);
      const result = await engine.leaveTable(ACTOR, { occupancyId: OCCUPANCY, seatNumber: 1 });
      expect(result.success).toBe(false);
      const cashouts = rpc.mock.calls.filter((c) => c[0] === 'fn_cashout_seat_occupancy');
      for (const call of cashouts) expect((call[1] as any).p_user_id).toBe(ACTOR);
      expect(JSON.stringify(rpc.mock.calls)).not.toContain(VICTIM);
      expect(engine.seatedPlayers).toEqual([{ ...hero, user_id: VICTIM }]);
    }
  );
});

/* ─────────────────────────────────────────────────────────────────────────────
   BUY-IN AND TOURNAMENT ENTRY. Neither has an engine HTTP door: the browser
   calls the SQL doors directly and they read the table's or the tournament's
   arena themselves (tests/sql/poker-diamond-forged-arena-acceptance.sql
   proves `atomic_table_buyin` refuses a forged club on a Diamond table). What
   the engine shares with those doors is the identity parser every loaded table
   passes through, and it is where a row claiming two arenas dies.
   ───────────────────────────────────────────────────────────────────────── */
describe('the shared table identity refuses a row that claims a different arena', () => {
  it('a Diamond table row cannot be relabelled as a chip club by its club id', () => {
    expect(() =>
      parseTableArenaIdentity({
        club_id: FORGED.clubId,
        union_id: null,
        arena: { id: 'arena', asset: 'diamonds', is_platform: true, union_id: null },
      })
    ).toThrow('Arena Identity Mismatch');
  });
  it('a chip club row cannot be relabelled as the Diamond arena', () => {
    expect(() =>
      parseTableArenaIdentity({
        club_id: 'arena',
        union_id: null,
        arena: { id: 'club', asset: 'chips', is_platform: false },
      })
    ).toThrow('Arena Identity Mismatch');
    expect(() =>
      parseTableArenaIdentity({ club_id: 'arena', union_id: null, arena: FORGED.arena })
    ).toThrow();
  });
  it('a Diamond table with a union stamped on it is not a Diamond table', () => {
    expect(() =>
      parseTableArenaIdentity({
        club_id: 'arena',
        union_id: FORGED.union_id,
        arena: { id: 'arena', asset: 'diamonds', is_platform: true, union_id: null },
      })
    ).toThrow('Diamond Games Cannot Belong To A Union');
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   TOURNAMENT REGISTER AND UNREGISTER. A Diamond tournament entry is bought and
   handed back through SQL doors the browser calls directly, so there is no
   engine HTTP handler to post a forged body to. The boundary those doors share
   with the engine is `assertDiamondTable`, which decides from the TABLE ROW
   which of the two Diamond shapes a table is, and admits neither to the
   other's door. A register forgery is therefore an attempt to make one shape
   answer as the other, and that is what is refused here. The money side of the
   same forgery is certified against real PostgreSQL by
   tests/sql/poker-diamond-forged-arena-acceptance.sql.
   ───────────────────────────────────────────────────────────────────────── */
describe('a forged tournament entry cannot change which door a Diamond table answers', () => {
  const tournamentRow = {
    id: '00000000-0000-4000-8000-00000000d1a1',
    club_id: 'arena',
    union_id: null,
    arena: { id: 'arena', asset: 'diamonds', is_platform: true, union_id: null },
    game_type: 'tournament',
    game_variant: 'nlh',
    tournament_id: 'event',
    cluster_id: null,
    status: 'running',
    small_blind: 50,
    big_blind: 100,
    ante: 0,
    min_buy_in: 0,
    max_buy_in: 0,
    rake_percent: -1,
    rake_cap_bb: -1,
    bbj_percent: 100,
    run_it_twice: true,
    allow_run_it_twice: true,
  };

  it('admits each real shape at its own door', () => {
    expect(() => assertDiamondTable(diamondTable as Record<string, unknown>)).not.toThrow();
    expect(() => assertDiamondTable(tournamentRow)).not.toThrow();
  });

  it('a forged tournament id on a Diamond cash row buys no free tournament seat', () => {
    /* `tournament_id` is in the hostile body because a tournament seat costs
       nothing at the table: the entry was paid for elsewhere. A cash row that
       suddenly carries one is routed to the tournament door and refused there,
       so the forgery does not produce a seat, it produces an error. */
    const relabelled = { ...diamondTable, tournament_id: FORGED.tournament_id } as Record<
      string,
      unknown
    >;
    expect(() => assertDiamondTable(relabelled)).toThrow('Diamond Tournament Table Required');
    expect(() => assertDiamondTournamentTable(relabelled)).toThrow(
      'Diamond Tournament Table Required'
    );
  });

  it('a Diamond tournament row is not admitted as a cash table, so a forged buy-in finds no door', () => {
    expect(() => assertDiamondCashTable(tournamentRow)).toThrow(
      'Diamond Plain Cash Table Required'
    );
    /* And claiming a purchasable stack on a tournament table is refused by the
       tournament door itself: the seat is not for sale at either boundary. */
    expect(() =>
      assertDiamondTournamentTable({ ...tournamentRow, min_buy_in: 20, max_buy_in: 200 })
    ).toThrow('A Diamond Tournament Table Sells No Seat');
  });

  it('the union scope an agent-club forgery would need dies at the row, not at the door', () => {
    /* MEASURED WHILE WRITING THIS FILE. The tournament boundary refuses a union
       scope itself; the cash boundary does not look at `union_id` at all. That
       is not a hole, and it is worth writing down so nobody "hardens" the wrong
       file: every table the engine deals arrives through `loadTable`, which
       calls `parseTableArenaIdentity` on the row FIRST, and a Diamond row
       carrying a union never becomes a table object for either door to judge.
       Both facts are pinned so that removing the parser's check cannot be
       covered by the belief that the cash boundary repeats it. */
    expect(() =>
      assertDiamondTournamentTable({ ...tournamentRow, union_id: FORGED.union_id })
    ).toThrow('Diamond Tournament Table Required');
    expect(() =>
      parseTableArenaIdentity({
        club_id: 'arena',
        union_id: FORGED.union_id,
        arena: { id: 'arena', asset: 'diamonds', is_platform: true, union_id: null },
      })
    ).toThrow('Diamond Games Cannot Belong To A Union');
    expect(readFileSync(TABLES_LOADER, 'utf8')).toContain('parseTableArenaIdentity(');
  });

  it('an unregister reads the tournament fact off the database answer, never the body', async () => {
    /* Handing a seat back is one door for both shapes. The client claims a
       tournament id; the RPC arguments do not carry it, and whether this was a
       tournament seat is stated by the database in its own reply. */
    const engine = new ServerTableEngine(DIAMOND_TABLE) as any;
    engine.tableInfo = diamondTable;
    engine.seatedPlayers = [
      { user_id: ACTOR, seat_number: 1, stack: 40, is_horse: false, occupancy_id: OCCUPANCY },
    ];
    engine.lifecycleCanMutate = () => true;
    engine.broadcastCurrentState = () => {};
    const rpc = vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, args: any) => {
      if (name === 'fn_cashout_seat_occupancy')
        return {
          data: {
            ok: true,
            asset: 'diamonds',
            stack: 40,
            credited: true,
            seat_number: args.p_seat_number,
            occupancy_id: args.p_occupancy_id,
            user_id: args.p_user_id,
            table_id: args.p_table_id,
            idempotency_key: 'cashout:occupancy:' + args.p_occupancy_id,
            tournament_table: false,
          },
          error: null,
        } as any;
      return { data: null, error: null } as any;
    }) as any);
    vi.spyOn(supabase, 'from').mockImplementation((() => {
      const chain: any = {};
      for (const m of ['select', 'eq', 'neq', 'is', 'in', 'update', 'insert', 'order', 'limit'])
        chain[m] = () => chain;
      chain.maybeSingle = async () => ({ data: null, error: null });
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
      return chain;
    }) as any);
    await expect(
      engine.leaveTable(ACTOR, { occupancyId: OCCUPANCY, seatNumber: 1 })
    ).resolves.toMatchObject({ success: true, immediate: true });
    const cashouts = rpc.mock.calls.filter((c) => c[0] === 'fn_cashout_seat_occupancy');
    expect(cashouts).toHaveLength(1);
    expect(Object.keys(cashouts[0][1] as object).sort()).toEqual([
      'p_leave_mode',
      'p_occupancy_id',
      'p_seat_number',
      'p_table_id',
      'p_user_id',
    ]);
    expectNothingForged(rpc.mock.calls as unknown[][]);
  });
});
