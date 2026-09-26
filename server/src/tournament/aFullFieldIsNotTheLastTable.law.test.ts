/**
 * LAW: A FULL FIELD IS NOT THE LAST TABLE (2026-09-26).
 *
 * Production, 2026-09-26, event 45b5b001, table 7441f3b1: a dealer's hand
 * permit was left unresolved, so the original-admission recovery asked for a
 * table break (`f06_operations` row 4c53987e, `park_requested`, requested
 * 04:30:20) and retired the stopped original under custody. Its permit was
 * decided `never_started`. The table held 9 players; the four other open
 * 9-max tables held 8 + 7 + 8 + 7, so there were 6 free seats for 9 players.
 * `prepareParkedTournamentBreak` correctly answered null (the roster does not
 * fit), and the stopped-original path read that null as "this is the last
 * table", asked `fn_f06_continue_no_start_last_table`, which refused
 * (`F06_CONTINUATION_LAST_TABLE_REQUIRED`: five tables were open), and threw
 * "F06 original placement remains pending" on every sweep.
 *
 * A roster that does not fit yet is a wait, not the end of the event. Only a
 * source that really is the event's last open table takes the no-start
 * continuation; any other source keeps its break pending under the same
 * custody, asks the Manager's existing redrive, and begins the break once the
 * field has room. The balancer itself never plans such a break
 * (`TableBalancer.shouldBreakTable` refuses when the other tables' free seats
 * cannot hold the roster); this break came from permit recovery, whose only
 * two lawful outcomes are the last-table continuation and a break.
 *
 * Real TournamentManager, retirement custody, F06 permit and balancer.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { GameServer } from '../GameServer.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';
import { F06HandPermit } from '../services/F06HandPermit.js';
import { supabase } from '../services/supabase.js';

const id = (n: number) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`;
const event = id(1),
  source = id(2),
  lease = id(3);
const others = [id(11), id(12), id(13), id(14)];
const seatedElsewhere = [8, 7, 8, 7];
const player = (n: number) => id(100 + n);
const sourceSeat = (n: number) => id(200 + n);
const occupancy = (n: number) => id(300 + n);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function destinations(freed = 0) {
  return others.map((tableId, t) => {
    const count = Math.max(0, seatedElsewhere[t] - (t === 0 ? freed : 0));
    return {
      tableId,
      playerCount: count,
      maxSeats: 9,
      players: Array.from({ length: count }, (_, s) => ({
        userId: id(1000 + t * 10 + s),
        seat: s + 1,
        stack: 100,
      })),
    };
  });
}

async function fixture(openTables: string[]) {
  let durable: any = null;
  let original: any = null;
  const calls: string[] = [];
  const clone = () => JSON.parse(JSON.stringify(durable));
  const engine: any = new ServerTableEngine(source);
  const server: any = Object.create(GameServer.prototype);
  Object.assign(server, {
    running: true,
    tableEngines: new Map([[source, engine]]),
    tournamentOwnedTables: new Set([source]),
    tournamentRetirementCustody: new TournamentRetirementCustody(),
    maintenanceBreak: { adopt: vi.fn() },
  });
  const manager: any = new TournamentManager(event, server, lease, performance.now() + 60000);
  Object.assign(manager, { running: true, eliminationSweepDeadlineAt: 0 });
  manager.tableEngines.set(source, engine);
  const token = {};
  manager.lifecycleEpoch.current = () => token;
  manager.lifecycleIsCurrent = () => true;
  manager.requestUrgentEliminationSweepAfter = vi.fn();
  manager.broadcast = vi.fn(async () => {});
  manager.retireManagedTableFromHandForHand = vi.fn();
  manager.readmitContinuedNoStartTable = vi.fn(async () => {});
  vi.spyOn(engine, 'stop').mockImplementation(async () => {
    engine.running = false;
    engine.terminal = true;
  });
  vi.spyOn(engine, 'hasReleasedProcessOwnership').mockReturnValue(true);
  manager.eligibleBreakDestinations = vi.fn(async () =>
    destinations().filter((t) => openTables.includes(t.tableId))
  );

  const seats = Array.from({ length: 9 }, (_, n) => ({
    id: sourceSeat(n + 1),
    user_id: player(n + 1),
    seat_number: n + 1,
    stack: 100,
    occupancy_id: occupancy(n + 1),
  }));
  const query: any = {
    select: () => query,
    eq: () => query,
    neq: () => query,
    or: async () => ({ data: openTables.map((table) => ({ id: table })), error: null }),
    is: async () => ({ data: seats, error: null }),
  };
  vi.spyOn(supabase, 'from').mockReturnValue(query);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('null', { status: 200 }))
  );
  const identity = {
    tournament_id: event,
    generation: lease,
    table_id: source,
    lifecycle: '1',
    permit_id: id(8),
    hand_number: '1000001',
    custody_id: id(10),
  };
  vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, p: any) => {
    calls.push(name);
    const ok = (data: any) => ({ data, error: null });
    if (name === 'fn_ca_resume_hand_submission') return ok({ found: false });
    if (name === 'fn_f06_begin_hand') {
      // The BEGIN committed and its reply was lost: the permit is unknown.
      original = { ...identity, state: 'reserved', evidence_id: null };
      return { data: null, error: { message: 'BEGIN reply lost' } };
    }
    if (name === 'fn_f06_table_state')
      return ok({
        ok: true,
        table_id: source,
        lifecycle: '1',
        excluded: !!durable,
        break_id: durable?.break_id ?? null,
      });
    if (name === 'fn_f06_request_park') {
      durable ??= {
        ok: true,
        reason: null,
        break_id: p.p_break_id,
        tournament_id: event,
        source_table_id: source,
        lifecycle: '1',
        state: 'park_requested',
        revision: '0',
        custody_id: null,
        custody_generation: null,
        terminal_handoff_required: false,
        members: [],
      };
      return ok(clone());
    }
    if (name === 'fn_f06_break_state') return ok(clone());
    if (name === 'fn_f06_claim_custody') {
      durable.custody_id = p.p_custody_id;
      durable.custody_generation = lease;
      durable.revision = '1';
      return ok(clone());
    }
    if (name === 'fn_f06_finish_original_no_start') {
      original = { ...identity, state: 'never_started', evidence_id: durable.custody_id };
      return ok({ ...original, ok: true });
    }
    if (name === 'fn_f06_continue_no_start_last_table') {
      // Canonical SQL: refused unless the source is the event's last open table.
      if (openTables.length !== 1)
        return {
          data: null,
          error: { code: '55000', message: 'F06_CONTINUATION_LAST_TABLE_REQUIRED' },
        };
      return ok({
        ok: true,
        state: 'continued_never_started',
        receipt_id: id(81),
        credit: 0,
        tournament_id: event,
        table_id: source,
        lifecycle: '1',
        break_id: durable.break_id,
        park_custody_id: durable.custody_id,
        park_revision: durable.revision,
        lease_generation: lease,
        original_generation: lease,
        permit_id: id(8),
        hand_number: '1000001',
      });
    }
    if (name === 'fn_f06_begin_break') {
      durable.state = 'begun';
      durable.members = p.p_members.map((m: any) => ({
        ...m,
        original_destination_table_id: m.destination_table_id,
        original_destination_seat_number: m.destination_seat_number,
        active_request_id: m.request_id,
        winner_request_id: null,
        winning_receipt: null,
        attempt_revision: 1,
      }));
      return ok(clone());
    }
    if (name === 'fn_move_tournament_player') {
      const m = durable.members.find((member: any) => member.active_request_id === p.p_request_id);
      const receipt = {
        ok: true,
        request_id: p.p_request_id,
        tournament_id: event,
        user_id: m.user_id,
        source_table_id: source,
        destination_table_id: m.destination_table_id,
        source_seat_id: m.source_seat_id,
        destination_seat_id: id(400 + m.source_seat_number),
        source_seat_number: m.source_seat_number,
        destination_seat_number: m.destination_seat_number,
        stack: '100',
        moved_at: '2026-09-26T04:40:00Z',
        replayed: false,
        source_mode: 'live_source',
        source_occupancy_id: m.occupancy_id,
        source_lifecycle: '1',
        break_id: durable.break_id,
      };
      m.winner_request_id = p.p_request_id;
      m.active_request_id = null;
      m.winning_receipt = receipt;
      return ok(receipt);
    }
    if (name === 'fn_f06_close_break') {
      durable.state = 'close_confirmed';
      return ok(clone());
    }
    if (name === 'fn_f06_ack_cleanup') {
      durable.state = 'acknowledged';
      return ok(clone());
    }
    throw new Error(`unexpected RPC ${name}`);
  }) as any);

  const permit = new F06HandPermit(
    { ...identity, lease_generation: lease } as any,
    (n, p) => supabase.rpc(n, p) as any,
    () => true
  );
  await permit.reserve().catch(() => undefined);
  engine.f06CurrentPermit = permit;
  engine.running = true;
  return { manager, engine, server, calls, state: clone, original: () => original };
}

const openField = [source, ...others];

it('a 9-player source with 6 free seats elsewhere keeps its break pending, never asks the last-table continuation, and begins once the field has room', async () => {
  const f = await fixture(openField);

  // The permit recovery's sweep: park, custody, the permit decided, no room.
  await expect(f.manager.recoverF06OriginalAdmissions()).resolves.toBeUndefined();
  expect(f.original().state).toBe('never_started');
  expect(f.state()).toMatchObject({ state: 'park_requested', members: [] });
  expect(f.calls).not.toContain('fn_f06_continue_no_start_last_table');
  expect(f.calls).not.toContain('fn_f06_begin_break');
  // The table stays fenced under the same custody; nothing is readmitted.
  expect(f.server.tableEngines.get(f.engine.tableId)).toBe(f.engine);
  expect(f.server.tournamentRetirementCustody.admissionAllowed(source)).toBe(false);
  expect(f.manager.pendingNoStartContinuations.size).toBe(0);
  expect(f.manager.readmitContinuedNoStartTable).not.toHaveBeenCalled();
  // The Manager's own redrive is asked for; nothing is scheduled here.
  expect(f.manager.requestUrgentEliminationSweepAfter).toHaveBeenCalled();

  // Every later sweep is the same quiet wait, not a standing error.
  const custody = f.state().custody_id;
  await expect(f.manager.recoverTournamentBreak(f.state())).resolves.toBeUndefined();
  await expect(f.manager.recoverTournamentBreak(f.state())).resolves.toBeUndefined();
  expect(f.state()).toMatchObject({ state: 'park_requested', custody_id: custody });
  expect(f.calls).not.toContain('fn_f06_continue_no_start_last_table');

  // Three players bust at another table: 9 free seats, and the break runs.
  f.manager.eligibleBreakDestinations = vi.fn(async () => destinations(3));
  await f.manager.recoverTournamentBreak(f.state());
  expect(f.state().state).toBe('acknowledged');
  expect(f.state().members).toHaveLength(9);
  expect(f.state().members.every((m: any) => m.winner_request_id)).toBe(true);
  expect(f.calls).not.toContain('fn_f06_continue_no_start_last_table');
  expect(f.server.tournamentRetirementCustody.admissionAllowed(source)).toBe(true);
});

it('the true last open table still takes the no-start continuation', async () => {
  const f = await fixture([source]);

  await f.manager.recoverF06OriginalAdmissions();

  expect(f.calls).toContain('fn_f06_continue_no_start_last_table');
  expect(f.calls).not.toContain('fn_f06_begin_break');
  expect(f.manager.readmitContinuedNoStartTable).toHaveBeenCalledWith(source, f.engine);
  expect(f.manager.pendingNoStartContinuations.size).toBe(0);
});
