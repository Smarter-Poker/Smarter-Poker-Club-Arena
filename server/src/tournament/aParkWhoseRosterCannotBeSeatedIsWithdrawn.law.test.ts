/**
 * LAW: A PARK WHOSE ROSTER CANNOT BE SEATED IS WITHDRAWN (2026-10-02).
 *
 * Production 13:28Z-14:30Z, event 4d2afa41 (Morning Free Buy): seven full
 * nine-max tables sat parked for table breaks that could never begin. 286
 * players needed all 32 tables, the 25 tables still dealing had six free
 * seats between them, and every sweep logged
 * `Break 4f208f2b not begun: destinations_full:7_of_9_placed_across_25_tables`.
 * A park waited for seats, so 62 players were dealt nothing for an hour.
 *
 * Industry standard: a table is broken only when its players can be seated
 * at once; otherwise it keeps playing. A park that has not begun and whose
 * roster has found no seats for UNPLACEABLE_PARK_GRACE_MS is withdrawn through
 * fn_f06_withdraw_unplaceable_park, its dealer is stopped and readmitted, and
 * nothing is withdrawn on any other refusal or when the database finds room.
 *
 * Real TournamentManager, retirement custody and balancer.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { GameServer } from '../GameServer.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';
import { supabase } from '../services/supabase.js';

const id = (n: number) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`;
const event = id(1),
  source = id(2),
  lease = id(3),
  breakId = id(4),
  custody = id(5);
const others = [id(11), id(12), id(13)];
const player = (n: number) => id(100 + n);

afterEach(() => {
  vi.restoreAllMocks();
});

function fullField(freeAt: number[] = []) {
  return others.map((tableId, t) => {
    const count = 9 - (freeAt[t] ?? 0);
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

function fixture(
  withdrawAnswer: 'withdrawn' | 'roster_fits' = 'withdrawn',
  parkGeneration: string = lease
) {
  const calls: { name: string; params: any }[] = [];
  const park = {
    ok: true,
    reason: null,
    break_id: breakId,
    tournament_id: event,
    source_table_id: source,
    lifecycle: '7',
    state: 'park_requested' as const,
    revision: '1',
    custody_id: custody,
    custody_generation: parkGeneration,
    members: [],
    terminal_handoff_required: false,
  };
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
  manager.readmitContinuedNoStartTable = vi.fn(async () => {});
  manager.durableTournamentBreaks.set(breakId, park);
  manager.eligibleBreakDestinations = vi.fn(async () => fullField([1, 1, 4]));
  engine.running = true;
  vi.spyOn(engine, 'parkForTournamentMove').mockResolvedValue(true);
  vi.spyOn(engine, 'getF06RetainedPermit').mockReturnValue(null);
  const releasePause = vi.spyOn(engine, 'releaseTournamentMovePause');
  const stop = vi.spyOn(engine, 'stop').mockImplementation(async () => {
    engine.running = false;
  });
  vi.spyOn(engine, 'hasReleasedProcessOwnership').mockImplementation(() => !engine.running);

  const seats = Array.from({ length: 9 }, (_, n) => ({
    id: id(200 + n),
    user_id: player(n + 1),
    seat_number: n + 1,
    stack: 100,
    occupancy_id: id(300 + n),
  }));
  const query: any = {
    select: () => query,
    eq: () => query,
    neq: () => query,
    // Four open tables: the source is not the event's last one.
    or: async () => ({ data: [source, ...others].map((table) => ({ id: table })), error: null }),
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
  vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, params: any) => {
    calls.push({ name, params });
    if (name === 'fn_f06_break_state') return { data: { ...park }, error: null };
    if (name === 'fn_f06_claim_custody') {
      Object.assign(park, {
        custody_id: params.p_custody_id,
        custody_generation: lease,
        revision: String(BigInt(park.revision) + 1n),
      });
      return { data: { ...park }, error: null };
    }
    if (name === 'fn_f06_withdraw_unplaceable_park') {
      if (withdrawAnswer === 'roster_fits')
        return { data: null, error: { code: '55000', message: 'F06_WITHDRAWAL_ROSTER_FITS' } };
      return {
        data: {
          ok: true,
          state: 'withdrawn_unplaceable',
          receipt_id: id(90),
          tournament_id: event,
          table_id: source,
          lifecycle: '7',
          break_id: breakId,
          park_custody_id: park.custody_id,
          park_revision: park.revision,
          lease_generation: lease,
          original_generation: lease,
          permit_id: id(91),
          hand_number: '20358306',
          roster_size: 9,
          free_seats: 6,
          credit: 0,
        },
        error: null,
      };
    }
    throw new Error(`unexpected RPC ${name}`);
  }) as any);
  return { manager, engine, server, calls, park, stop, releasePause };
}

const names = (calls: { name: string }[]) => calls.map((c) => c.name);

it('the 4d2afa41 shape: a full table parked with six free seats elsewhere is withdrawn after the grace and deals again', async () => {
  const f = fixture();
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);

  // First sweep: the roster finds no seats. The table is not yet given up on.
  await f.manager.recoverTournamentBreak(f.park);
  expect(f.manager.lastBreakPreparationRefusal(breakId)).toMatch(/^destinations_full:6_of_9/);
  expect(names(f.calls)).not.toContain('fn_f06_withdraw_unplaceable_park');
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.manager.requestUrgentEliminationSweepAfter).toHaveBeenCalledWith(
    TournamentManager.UNPLACEABLE_PARK_GRACE_MS
  );

  // Still no seats after the grace: the park is withdrawn, never begun.
  now += TournamentManager.UNPLACEABLE_PARK_GRACE_MS;
  await f.manager.recoverTournamentBreak(f.park);
  const withdraw = f.calls.find((c) => c.name === 'fn_f06_withdraw_unplaceable_park');
  expect(withdraw?.params).toEqual({
    p_tournament_id: event,
    p_lease_generation: lease,
    p_table_id: source,
    p_lifecycle: '7',
    p_break_id: breakId,
    p_park_custody_id: custody,
    p_park_revision: '1',
  });
  expect(names(f.calls)).not.toContain('fn_f06_begin_break');
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(f.releasePause).toHaveBeenCalled();
  expect(f.manager.readmitContinuedNoStartTable).toHaveBeenCalledWith(source, f.engine);
  // Its players no longer count as seats a new plan must keep free.
  expect(f.manager.durableTournamentBreaks.has(breakId)).toBe(false);
  expect(await f.manager.unbegunBreakDemand()).toBe(0);
  expect(f.manager.lastBreakPreparationRefusal(breakId)).toBeNull();
});

it('when the database finds room the park stays, its dealer is untouched, and nothing is readmitted', async () => {
  const f = fixture('roster_fits');
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await f.manager.recoverTournamentBreak(f.park);
  now += TournamentManager.UNPLACEABLE_PARK_GRACE_MS;
  await f.manager.recoverTournamentBreak(f.park);
  expect(names(f.calls)).toContain('fn_f06_withdraw_unplaceable_park');
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.manager.readmitContinuedNoStartTable).not.toHaveBeenCalled();
  expect(f.manager.durableTournamentBreaks.has(breakId)).toBe(true);
});

it('a park refused for any other reason is never withdrawn, and a park with room begins', async () => {
  const f = fixture();
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  f.engine.parkForTournamentMove.mockResolvedValue(false);
  await f.manager.recoverTournamentBreak(f.park);
  now += TournamentManager.UNPLACEABLE_PARK_GRACE_MS * 10;
  await f.manager.recoverTournamentBreak(f.park);
  expect(f.manager.lastBreakPreparationRefusal(breakId)).toBe('source_park_probe_missed');
  expect(names(f.calls)).not.toContain('fn_f06_withdraw_unplaceable_park');
  expect(f.stop).not.toHaveBeenCalled();
});

it('a park an earlier generation left is claimed by the live one before it is withdrawn (79feebfc, after a release)', async () => {
  const dead = id(4);
  const f = fixture('withdrawn', dead);
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await f.manager.recoverTournamentBreak({ ...f.park });
  now += TournamentManager.UNPLACEABLE_PARK_GRACE_MS;
  await f.manager.recoverTournamentBreak({ ...f.park });
  const order = names(f.calls).filter((n) => n !== 'fn_f06_break_state');
  expect(order).toEqual(['fn_f06_claim_custody', 'fn_f06_withdraw_unplaceable_park']);
  const withdraw = f.calls.find((c) => c.name === 'fn_f06_withdraw_unplaceable_park');
  expect(withdraw?.params).toMatchObject({
    p_lease_generation: lease,
    p_park_custody_id: f.park.custody_id,
    p_park_revision: '2',
  });
  expect(f.park.custody_id).not.toBe(custody);
  expect(f.manager.readmitContinuedNoStartTable).toHaveBeenCalledWith(source, f.engine);
});
