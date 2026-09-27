import { afterEach, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { GameServer } from '../GameServer.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';
import { supabase } from '../services/supabase.js';

const id = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const event = id(1),
  source = id(2),
  destination = id(3),
  lease = id(4),
  breakId = id(5);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(count: number, readCost: number) {
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('null', { status: 200 }))
  );
  const engine: any = new ServerTableEngine(source);
  Object.assign(engine, { running: true, handForHandResolve: () => {}, holdBeforeNextHand: true });
  const server: any = Object.create(GameServer.prototype);
  Object.assign(server, {
    running: true,
    tableEngines: new Map([[source, engine]]),
    tournamentOwnedTables: new Set([source]),
    tournamentRetirementCustody: new TournamentRetirementCustody(),
  });
  const manager: any = new TournamentManager(event, server, lease, performance.now() + 60_000);
  Object.assign(manager, { running: true, eliminationSweepDeadlineAt: now + 5_000 });
  manager.tableEngines.set(source, engine);
  manager.requestUrgentEliminationSweepAfter = vi.fn();
  // Retirement follows dispatch and has its own original-engine qualification.
  // Recovery, destination reads/planning, serial authority, boundary and move
  // adapter are real here. Only the external database transport is modeled.
  manager.retireTournamentBreak = vi.fn(async () => {});
  const members = Array.from({ length: count }, (_, i) => ({
    user_id: id(100 + i),
    source_seat_id: id(200 + i),
    source_seat_number: i + 1,
    occupancy_id: id(300 + i),
    request_id: id(400 + i),
    active_request_id: id(400 + i),
    destination_table_id: destination,
    destination_seat_number: i + 1,
    original_destination_table_id: destination,
    original_destination_seat_number: i + 1,
    winner_request_id: null as string | null,
    winning_receipt: null as any,
    attempt_revision: 1,
  }));
  const state: any = {
    ok: true,
    reason: null,
    break_id: breakId,
    tournament_id: event,
    source_table_id: source,
    lifecycle: '1',
    state: 'begun',
    revision: '1',
    custody_id: id(6),
    custody_generation: lease,
    terminal_handoff_required: false,
    members,
  };
  const reads: string[] = [],
    moves: any[] = [],
    receipts = new Map<string, any>();
  let beforeMove: ((parameters: any) => void) | null = null;
  let refuseSeat: number | null = null;
  let loseReply = false;
  let ownerChanges = false;
  let failedRead = 0;
  const occupiedSeats = new Set<number>([10]);
  const amendments: any[] = [];
  let afterAmend: (() => void) | null = null;
  vi.spyOn(supabase, 'from').mockImplementation(((table: string) => {
    let select = '',
      ids: string[] = [];
    const query: any = {
      select: (value: string) => {
        select = value;
        return query;
      },
      eq: () => query,
      neq: () => query,
      or: () => query,
      is: () => query,
      in: (column: string, value: string[]) => {
        if (column === 'id' || column === 'table_id') ids = value;
        return query;
      },
      then: (resolve: (value: any) => unknown, reject: (error: unknown) => unknown) => {
        reads.push(`${table}:${select}`);
        now += readCost;
        if (ownerChanges) manager.running = false;
        if (reads.length === failedRead)
          return Promise.resolve({ data: null, error: { message: 'incomplete board' } }).then(
            resolve,
            reject
          );
        let rows: any[] = [];
        if (table === 'tables')
          rows =
            select === 'id'
              ? [{ id: source }, { id: destination }]
              : ids.map((id) => ({ id, max_players: 10 }));
        if (table === 'table_seats')
          rows = [...occupiedSeats].map((seat_number) => ({
            table_id: destination,
            user_id: id(80 + seat_number),
            stack: 100,
            seat_number,
          }));
        if (table === 'tournament_players')
          rows = [...occupiedSeats].map((seat_number) => ({ table_id: destination, seat_number }));
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
    };
    return query;
  }) as any);
  vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, parameters: any) => {
    now += 20;
    if (name === 'fn_f06_break_state') return { data: structuredClone(state), error: null };
    if (name === 'fn_f06_amend_attempt') {
      amendments.push(structuredClone(parameters));
      const member = members.find((m) => m.user_id === parameters.p_user_id)!;
      member.active_request_id = parameters.p_new_request_id;
      member.destination_seat_number = parameters.p_destination_seat_number;
      member.attempt_revision++;
      state.revision = String(Number(state.revision) + 1);
      afterAmend?.();
      return { data: structuredClone(state), error: null };
    }
    if (name !== 'fn_move_tournament_player') throw new Error(`unexpected RPC ${name}`);
    moves.push(structuredClone(parameters));
    beforeMove?.(parameters);
    const old = receipts.get(parameters.p_request_id);
    if (old) return { data: { ...old, replayed: true }, error: null };
    // Model the unchanged SQL's atomic destination revalidation after the
    // earlier board read; no stale board can override this refusal.
    if (parameters.p_destination_seat_number === refuseSeat)
      return { data: null, error: { code: '55000', message: 'destination occupied concurrently' } };
    const member = members.find((m) => m.user_id === parameters.p_user_id)!;
    const receipt = {
      ok: true,
      request_id: parameters.p_request_id,
      tournament_id: event,
      user_id: member.user_id,
      source_table_id: source,
      destination_table_id: destination,
      source_seat_id: member.source_seat_id,
      source_seat_number: member.source_seat_number,
      destination_seat_id: id(500 + member.source_seat_number),
      destination_seat_number: parameters.p_destination_seat_number,
      stack: '100',
      moved_at: '2026-09-27T00:00:00Z',
      replayed: false,
      source_mode: 'live_source',
      source_occupancy_id: member.occupancy_id,
      source_lifecycle: '1',
      break_id: breakId,
    };
    receipts.set(parameters.p_request_id, receipt);
    member.winner_request_id = parameters.p_request_id;
    member.active_request_id = null as any;
    member.winning_receipt = receipt;
    if (loseReply) {
      loseReply = false;
      return { data: null, error: { message: 'response lost' } };
    }
    return { data: receipt, error: null };
  }) as any);
  return {
    manager,
    engine,
    server,
    state,
    reads,
    moves,
    receipts,
    amendments,
    occupiedSeats,
    nextPass: () => {
      manager.eliminationSweepDeadlineAt = now + 5_000;
    },
    expire: () => {
      now += 5_000;
    },
    loseNextReply: () => {
      loseReply = true;
    },
    changeOwnerDuringRead: () => {
      ownerChanges = true;
    },
    onMove: (callback: (parameters: any) => void) => {
      beforeMove = callback;
    },
    onAmend: (callback: () => void) => {
      afterAmend = callback;
    },
    failRead: (number: number) => {
      failedRead = number;
    },
    refuse: (seat: number | null) => {
      refuseSeat = seat;
    },
    elapsed: () => now - 1_000_000,
  };
}

it.each([
  [4, 400],
  [8, 200],
])(
  'dispatches all %i original members within the unchanged budget after one complete board',
  async (count, readCost) => {
    const f = fixture(count, readCost);
    await f.manager.recoverTournamentBreak(structuredClone(f.state));
    f.nextPass();
    await f.manager.recoverTournamentBreak(structuredClone(f.state));
    expect(f.receipts.size).toBe(count);
    expect(f.reads).toHaveLength(4);
    expect(f.elapsed()).toBeLessThan(5_000);
    expect(f.moves.map((m) => m.p_request_id)).toEqual(
      f.state.members.map((m: any) => m.request_id)
    );
  }
);

it('refreshes the board after an amendment before validating the next member', async () => {
  const f = fixture(2, 100);
  f.occupiedSeats.add(1);
  f.onAmend(() => f.occupiedSeats.add(2));
  await f.manager.recoverTournamentBreak(structuredClone(f.state));
  expect(f.amendments.map((m) => m.p_destination_seat_number)).toEqual([2, 3]);
  expect(f.reads).toHaveLength(8);
  expect(f.receipts.size).toBe(2);
});

it('keeps duplicate recovery invocations on the same original receipts', async () => {
  const f = fixture(4, 100);
  await Promise.all([
    f.manager.recoverTournamentBreak(structuredClone(f.state)),
    f.manager.recoverTournamentBreak(structuredClone(f.state)),
  ]);
  expect(f.receipts.size).toBe(4);
  expect(new Set(f.moves.map((m) => m.p_request_id))).toEqual(
    new Set(f.state.members.map((m: any) => m.request_id))
  );
  expect(f.engine.tournamentMoveOperations.size).toBe(0);
});

it.each([2, 3, 4])(
  'keeps the original atomic refusal after incomplete board read %i',
  async (number) => {
    const f = fixture(4, 100);
    f.failRead(number);
    f.refuse(1);
    await f.manager.recoverTournamentBreak(structuredClone(f.state));
    // Existing recovery may submit the unchanged original destination after an
    // unavailable board. The authoritative RPC still decides it; the planner
    // cannot manufacture a replacement or bypass that refusal.
    expect(f.amendments).toHaveLength(0);
    expect(f.receipts.size).toBe(0);
    expect(f.moves.every((m) => m.p_request_id === id(400))).toBe(true);
  }
);

it('retains original identities when a destination changes after the shared read', async () => {
  const f = fixture(4, 100);
  f.onMove(() => f.refuse(2));
  await f.manager.recoverTournamentBreak(structuredClone(f.state));
  expect(f.receipts.size).toBe(1);
  expect(f.moves.slice(1).every((m) => m.p_request_id === id(401))).toBe(true);
  expect(f.state.members[1].active_request_id).toBe(id(401));
  f.onMove(() => {});
  f.refuse(null);
  f.nextPass();
  await f.manager.recoverTournamentBreak(structuredClone(f.state));
  expect(f.receipts.size).toBe(4);
  expect(new Set(f.moves.map((m) => m.p_request_id))).toEqual(
    new Set(f.state.members.map((m: any) => m.request_id))
  );
});

it('replays a lost reply with the same UUID and one committed receipt', async () => {
  const f = fixture(4, 100);
  f.loseNextReply();
  await f.manager.recoverTournamentBreak(structuredClone(f.state));
  expect(f.moves.slice(0, 2).map((m) => m.p_request_id)).toEqual([id(400), id(400)]);
  expect(f.receipts.size).toBe(4);
});

it('does not reuse the board after manager ownership is lost during its read', async () => {
  const f = fixture(8, 200);
  f.changeOwnerDuringRead();
  await f.manager.recoverTournamentBreak(structuredClone(f.state));
  expect(f.moves).toHaveLength(0);
});

it('cannot dispatch when the manager and server no longer own the same source', async () => {
  const f = fixture(4, 100);
  f.server.tableEngines.set(source, new ServerTableEngine(source));
  await f.manager.recoverTournamentBreak(structuredClone(f.state));
  expect(f.moves).toHaveLength(0);
});

it('cannot invent a claimed boundary on a stopped source', async () => {
  const f = fixture(4, 100);
  f.engine.running = false;
  await f.manager.recoverTournamentBreak(structuredClone(f.state));
  expect(f.moves).toHaveLength(0);
});

it('keeps the original five-second deadline and refuses later dispatch after expiry', async () => {
  const f = fixture(8, 200);
  f.onMove(() => f.expire());
  await f.manager.recoverTournamentBreak(structuredClone(f.state));
  expect(f.receipts.size).toBe(1);
  expect(f.moves).toHaveLength(1);
});
