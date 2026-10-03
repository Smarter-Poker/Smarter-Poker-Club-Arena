/**
 * LAW: A ROSTER NOBODY CAN SEAT IS NOT PARKED FOR EVER (2026-10-03).
 *
 * Production 01:07Z-02:30Z, event 79feebfc "Prime Time Free Buy (NLH)": a
 * Supabase IO stall left fifteen full nine-max tables' hand permits unknown;
 * the zombie watchdog rebuilt them and stopped-original recovery parked each
 * one for a table break. The field needed every table it had
 * (`destinations_full:N_of_9_placed_across_16_tables` on every sweep), so each
 * break waited for seats under a custody that held its stopped dealer, and 135
 * players were dealt nothing for over an hour. The withdrawal door
 * (fn_f06_withdraw_unplaceable_park) was reachable only from discovery, which
 * that custody fences out; it had never fired in production.
 *
 * A stopped original whose roster has found no seats for
 * UNPLACEABLE_PARK_GRACE_MS is withdrawn under its own custody and its dealer
 * readmitted; a field the database finds room in still waits and then breaks
 * the table; the last table whose continuation cannot read its witness is
 * withdrawn the same way.
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

let lastTableWitnessUnreadable = false;

afterEach(() => {
  lastTableWitnessUnreadable = false;
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

async function fixture(openTables: string[], withdrawRefusal: string | null = null) {
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
    in: async () => ({
      data: seats.map((s) => ({
        user_id: s.user_id,
        status: 'playing',
        chips: s.stack,
        seat_number: s.seat_number,
      })),
      error: null,
    }),
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
    if (name === 'fn_f06_withdraw_unplaceable_park') {
      if (withdrawRefusal)
        return { data: null, error: { code: '55000', message: withdrawRefusal } };
      if (p.p_park_custody_id !== durable.custody_id || p.p_lease_generation !== lease)
        return {
          data: null,
          error: { code: '55000', message: 'F06_WITHDRAWAL_EXACT_PREMANIFEST_PARK' },
        };
      durable.state = 'withdrawn_before_manifest';
      return ok({
        ok: true,
        state: 'withdrawn_unplaceable',
        receipt_id: id(82),
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
        roster_size: 9,
        free_seats: 6,
      });
    }
    if (name === 'fn_f06_continue_no_start_last_table') {
      // Canonical SQL: refused unless the source is the event's last open table.
      if (openTables.length !== 1 || lastTableWitnessUnreadable)
        return {
          data: null,
          error: {
            code: '55000',
            message:
              openTables.length !== 1
                ? 'F06_CONTINUATION_LAST_TABLE_REQUIRED'
                : 'F06_CONTINUATION_POSITIVE_ORIGINAL_REQUIRED',
          },
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

function later(ms: number) {
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + ms);
}

it('a stopped original nobody can seat is withdrawn under its custody after the grace, and its table deals again', async () => {
  const f = await fixture(openField);

  await f.manager.recoverF06OriginalAdmissions();
  // Inside the grace a bust may still free the chairs: the break waits.
  expect(f.state()).toMatchObject({ state: 'park_requested', members: [] });
  expect(f.calls).not.toContain('fn_f06_withdraw_unplaceable_park');
  expect(f.server.tournamentRetirementCustody.admissionAllowed(source)).toBe(false);

  later(TournamentManager.UNPLACEABLE_PARK_GRACE_MS + 1);
  await f.manager.recoverTournamentBreak(f.state());

  expect(f.calls).toContain('fn_f06_withdraw_unplaceable_park');
  expect(f.calls).not.toContain('fn_f06_begin_break');
  expect(f.calls).not.toContain('fn_f06_continue_no_start_last_table');
  expect(f.state().state).toBe('withdrawn_before_manifest');
  expect(f.manager.readmitContinuedNoStartTable).toHaveBeenCalledWith(source, f.engine);
  expect(f.manager.pendingNoStartContinuations.size).toBe(0);
  expect(f.server.tournamentRetirementCustody.admissionAllowed(source)).toBe(true);
});

it('a field the database finds room in keeps the break, which begins once the balancer can place it', async () => {
  const f = await fixture(openField, 'F06_WITHDRAWAL_ROSTER_FITS');

  await f.manager.recoverF06OriginalAdmissions();
  later(TournamentManager.UNPLACEABLE_PARK_GRACE_MS + 1);
  await expect(f.manager.recoverTournamentBreak(f.state())).resolves.toBeUndefined();

  expect(f.calls).toContain('fn_f06_withdraw_unplaceable_park');
  expect(f.state()).toMatchObject({ state: 'park_requested', members: [] });
  expect(f.manager.readmitContinuedNoStartTable).not.toHaveBeenCalled();
  expect(f.manager.pendingNoStartContinuations.size).toBe(0);
  expect(f.server.tournamentRetirementCustody.admissionAllowed(source)).toBe(false);

  f.manager.eligibleBreakDestinations = vi.fn(async () => destinations(3));
  await f.manager.recoverTournamentBreak(f.state());
  expect(f.state().state).toBe('acknowledged');
  expect(f.state().members).toHaveLength(9);
});

it('the last table whose continuation cannot read its witness is withdrawn instead of pending for ever', async () => {
  lastTableWitnessUnreadable = true;
  const f = await fixture([source]);

  await expect(f.manager.recoverF06OriginalAdmissions()).rejects.toThrow(
    'F06 original placement remains pending'
  );
  expect(f.calls).toContain('fn_f06_continue_no_start_last_table');
  expect(f.calls).not.toContain('fn_f06_withdraw_unplaceable_park');

  later(TournamentManager.UNPLACEABLE_PARK_GRACE_MS + 1);
  await f.manager.recoverTournamentBreak(f.state());

  expect(f.calls).toContain('fn_f06_withdraw_unplaceable_park');
  expect(f.state().state).toBe('withdrawn_before_manifest');
  expect(f.manager.readmitContinuedNoStartTable).toHaveBeenCalledWith(source, f.engine);
  expect(f.server.tournamentRetirementCustody.admissionAllowed(source)).toBe(true);
});
