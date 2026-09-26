/**
 * LAW: A TABLE EXCLUDED BY ITS OWN BREAK WAITS FOR THE BREAK, NOT THE DEALER
 * (2026-09-26).
 *
 * Production, release 92d59cfb, tournament 21f9013b ("Sunday Deep Stack
 * Satellite"), table 715aee14: the balancer requested a table break
 * (`f06_operations` row cbf00eca, `park_requested`) at 03:41:11.98, 0.7 s
 * after hand #14633520 started, so the one-second park probe missed. The
 * engine parked at the next hand boundary, 03:42:03. The process-wide
 * elimination scheduler runs four sweeps at a time for every tournament on
 * the host, and no sweep reached this one within fifteen seconds, so the
 * unclaimed-park expiry released the pause. While the break row exists the
 * database refuses every hand on that table (`fn_f06_hand_number_state`
 * answers `source_excluded`), so the released dealer failed nine hand-number
 * allocations (`f06_allocation_unproven`) until the zombie watchdog stopped
 * it at 03:45:39, with four players seated.
 *
 * What this pins, with a real ServerTableEngine, the real TournamentManager
 * break path and the admission's real allocator:
 *
 *   1. A park the probe missed stays parked past the fifteen-second expiry and
 *      past the two-minute pause safety timeout while its break row exists;
 *      the dealer never asks for a hand number; the park edge wakes the
 *      Manager's sweep; and that sweep claims the park and begins the break.
 *   2. After a restart with the break row still open (`park_requested`,
 *      `custody_id` null) the table starts parked (movement only), its park
 *      edge wakes the sweep, and the break still reaches `begun`.
 *   3. A dealer that meets `source_excluded` without any park armed (a park
 *      request whose reply was lost) reports it by its own name, is fenced for
 *      the break, wakes the sweep, and the break reaches `begun`.
 *
 * The dealing loop is modelled by its own gate: it awaits the pause gate while
 * any tournament-move owner is present, and asks the allocator for a hand the
 * moment none is (ServerTableEngineDealing's top-of-loop and pre-deal checks).
 */
import { afterEach, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { GameServer } from '../GameServer.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';
import { supabase } from '../services/supabase.js';

const id = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const event = id(1),
  source = id(2),
  lease = id(3),
  destination = id(4),
  user = id(5),
  seat = id(6),
  occupancy = id(7),
  seededBreak = id(50);
const LIFECYCLE = '349300';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function tournamentEngine(): any {
  return new ServerTableEngine(source, {
    scope: 'tournament',
    verified: true,
    generation: lease,
    tournamentId: event,
    proofDeadlineMonotonicMs: performance.now() + 3_600_000,
  });
}

function world(engine: any) {
  Object.defineProperty(engine, 'ready', { value: Promise.resolve(true) });
  const start = vi.spyOn(engine, 'start').mockResolvedValue(undefined);
  const server: any = Object.create(GameServer.prototype);
  Object.assign(server, {
    running: true,
    tableEngines: new Map([[source, engine]]),
    tournamentOwnedTables: new Set([source]),
    tournamentRetirementCustody: new TournamentRetirementCustody(),
    maintenanceBreak: { adopt: vi.fn() },
  });
  const manager: any = new TournamentManager(event, server, lease, performance.now() + 3_600_000);
  Object.assign(manager, { running: true, eliminationSweepDeadlineAt: 0 });
  manager.tableEngines.set(source, engine);
  const token = {};
  manager.lifecycleEpoch.current = () => token;
  manager.lifecycleIsCurrent = () => true;
  manager.requestUrgentEliminationSweepAfter = vi.fn();
  manager.broadcast = vi.fn(async () => {});
  vi.spyOn(manager, 'recoverManagedTableEngine').mockResolvedValue(undefined);
  const wakes: string[] = [];
  manager.requestEliminationSweep = vi.fn((reason?: string) => {
    wakes.push(String(reason));
    return true;
  });
  manager.eligibleBreakDestinations = vi.fn(async () => [
    {
      tableId: destination,
      playerCount: 5,
      maxSeats: 10,
      players: [{ userId: id(20), seat: 10, stack: 100 }],
    },
  ]);
  // The sweep's per-operation visit stops at `begun`: dispatch and
  // retirement are covered by F06OriginalManagerFlow.
  manager.repairTournamentBreakDestinations = vi.fn(async (state: unknown) => state);
  manager.dispatchTournamentBreakMembers = vi.fn(async () => {});
  manager.retireTournamentBreak = vi.fn(async () => {});

  const query: any = {
    select: () => query,
    eq: () => query,
    neq: () => query,
    or: async () => ({ data: [{ id: source }, { id: destination }], error: null }),
    is: async () => ({
      data: [{ id: seat, user_id: user, seat_number: 1, stack: 100, occupancy_id: occupancy }],
      error: null,
    }),
  };
  vi.spyOn(supabase, 'from').mockReturnValue(query);

  let durable: any = null;
  const calls: string[] = [];
  const clone = () => JSON.parse(JSON.stringify(durable));
  const row = (breakId: string) => ({
    ok: true,
    reason: null,
    break_id: breakId,
    tournament_id: event,
    source_table_id: source,
    lifecycle: LIFECYCLE,
    state: 'park_requested',
    revision: '0',
    custody_id: null,
    custody_generation: null,
    terminal_handoff_required: false,
    members: [],
  });
  const excluded = () => !!durable && durable.state !== 'acknowledged';
  vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, p: any) => {
    calls.push(name);
    const ok = (data: unknown) => ({ data, error: null });
    if (name === 'fn_ca_resume_hand_submission') return ok({ found: false });
    if (name === 'fn_f06_hand_number_state')
      return ok({
        ok: true,
        table_id: source,
        lifecycle: LIFECYCLE,
        can_reserve: !excluded(),
        blocked_reason: excluded() ? 'source_excluded' : null,
        used_hand_number_max: '14633520',
        unresolved_permit: null,
        next_hand_number_candidate: excluded() ? null : '14633521',
      });
    if (name === 'fn_f06_allocate_hand_number')
      return ok(
        excluded()
          ? { ok: false, reason: 'source_excluded' }
          : {
              ok: true,
              table_id: source,
              lifecycle: LIFECYCLE,
              hand_number: '14633521',
              hand_number_high_water: '14633520',
            }
      );
    if (name === 'fn_f06_table_state')
      return ok({
        ok: true,
        table_id: source,
        lifecycle: LIFECYCLE,
        excluded: excluded(),
        break_id: excluded() ? durable.break_id : null,
      });
    if (name === 'fn_f06_request_park') {
      durable ??= row(p.p_break_id);
      return ok(clone());
    }
    if (name === 'fn_f06_break_state') return ok(clone());
    if (name === 'fn_f06_claim_custody') {
      durable.custody_id = p.p_custody_id;
      durable.custody_generation = lease;
      durable.revision = String(Number(durable.revision) + 1);
      return ok(clone());
    }
    if (name === 'fn_f06_admit_parked_movement') {
      // Canonical SQL: a park_requested row with custody_id null is admitted
      // by claiming custody for the caller's fresh custody UUID.
      expect(durable.state).toBe('park_requested');
      expect(p.p_expected_revision).toBe(durable.revision);
      durable.custody_id = p.p_custody_id;
      durable.custody_generation = lease;
      durable.revision = String(Number(durable.revision) + 1);
      return ok({
        ok: true,
        mode: 'movement_only',
        admission_id: p.p_admission_id,
        tournament_id: event,
        lease_generation: lease,
        table_id: source,
        lifecycle: LIFECYCLE,
        break_id: durable.break_id,
        custody_id: p.p_custody_id,
        revision: durable.revision,
        proof_hash: 'a'.repeat(64),
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
    throw new Error(`unexpected RPC ${name}`);
  }) as any);

  const settle = async () => {
    await Promise.allSettled([...manager.tableEngineRunJobs, ...manager.tableEngineStartJobs]);
  };
  return {
    manager,
    server,
    start,
    calls,
    wakes,
    state: () => clone(),
    seedBreak: () => {
      durable = row(seededBreak);
    },
    settle,
  };
}

/** The engine is live between or during hands, as the dealing loop leaves it. */
function live(engine: any, handRunning: boolean): void {
  engine.running = true;
  engine.handController = handRunning ? {} : null;
  engine.postHandTasksPromise = null;
  engine.terminalBoundaryPendingGenerations = new Set();
  engine.terminalBoundaryPersistenceFailed = false;
  engine.handForHandResolve = null;
  engine.tableFSM = {
    state: 'running',
    transition: vi.fn((next: string) => {
      engine.tableFSM.state = next;
    }),
  };
}

/** Top of ServerTableEngineDealing's loop: park while fenced, else ask for a hand. */
function dealingLoop(engine: any): Promise<void> {
  return (async () => {
    for (;;) {
      if (!engine.running) return;
      if (engine.tournamentMovePauseOwners.size > 0) {
        await engine.awaitPauseGate();
        continue;
      }
      await engine.allocateGlobalHandNumber().catch(() => undefined);
      return;
    }
  })();
}

async function finish(engine: any, owner: string, loop: Promise<void>): Promise<void> {
  engine.running = false;
  engine.claimedTournamentMovePauseOwners.delete(owner);
  engine.releaseTournamentMovePause(owner);
  engine.releasePauseGate?.();
  await vi.advanceTimersByTimeAsync(1);
  await loop;
  engine.preciseTimer?.dispose?.();
}

const FAKE = {
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
} as const;

it('a park the probe missed stays parked past the expiry, never asks for a hand, and the sweep begins the break', async () => {
  vi.useFakeTimers(FAKE as any);
  const engine = tournamentEngine();
  const w = world(engine);
  w.manager.wireEliminationWake(engine);
  // Ordinary admission: no break yet, so the real allocator is installed.
  w.manager.startManagedTableEngine(engine, 'law admission');
  await w.settle();
  expect(w.start).toHaveBeenCalledOnce();
  const owner = w.manager.tournamentMoveBoundaryOwner;

  // 03:41:11.98 - the balancer requests the break 0.7 s into a hand.
  live(engine, true);
  const requested = await w.manager.requestTournamentBreakPark(source);
  expect(requested.state).toBe('park_requested');
  const sweep = w.manager.recoverTournamentBreak(requested);
  await vi.advanceTimersByTimeAsync(1_000);
  await sweep;
  expect(w.state().state).toBe('park_requested');
  expect(w.state().custody_id).toBeNull();
  expect(engine.tournamentMovePauseOwners.has(owner)).toBe(true);

  // 03:42:03 - the hand lands and the dealer parks at its gate.
  engine.handController = null;
  const loop = dealingLoop(engine);
  await vi.advanceTimersByTimeAsync(0);
  expect(engine.handForHandResolve).not.toBeNull();
  // The park edge is the event the claim waits for.
  expect(w.wakes).toContain('tournament_move_parked');

  // No sweep slot for fifteen seconds, then past the two-minute safety timeout.
  await vi.advanceTimersByTimeAsync(16_000);
  expect(engine.tournamentMovePauseOwners.has(owner)).toBe(true);
  expect(engine.handForHandResolve).not.toBeNull();
  await vi.advanceTimersByTimeAsync(125_000);
  expect(engine.tournamentMovePauseOwners.has(owner)).toBe(true);
  expect(engine.handForHandResolve).not.toBeNull();
  expect(w.calls).not.toContain('fn_f06_allocate_hand_number');

  // The sweep arrives: it claims the parked boundary and begins the break.
  await w.manager.recoverTournamentBreak(w.state());
  expect(engine.claimedTournamentMovePauseOwners.has(owner)).toBe(true);
  expect(w.state().state).toBe('begun');
  expect(w.state().members.map((m: any) => [m.user_id, m.destination_table_id])).toEqual([
    [user, destination],
  ]);
  expect(w.calls).not.toContain('fn_f06_allocate_hand_number');
  await finish(engine, owner, loop);
});

it('after a restart with the break still open and no custody, the table starts parked and the break begins', async () => {
  vi.useFakeTimers(FAKE as any);
  const engine = tournamentEngine();
  const w = world(engine);
  w.seedBreak();
  expect(w.state()).toMatchObject({ state: 'park_requested', custody_id: null });
  w.manager.wireEliminationWake(engine);
  w.manager.startManagedTableEngine(engine, 'law restart admission');
  await w.settle();
  const owner = w.manager.tournamentMoveBoundaryOwner;
  expect(w.start).toHaveBeenCalledOnce();
  expect(engine.f06MovementAdmission?.ownerId).toBe(owner);
  expect(engine.f06Allocator).toBeNull();
  expect(w.state().custody_id).not.toBeNull();
  expect(w.calls).toContain('fn_f06_admit_parked_movement');

  live(engine, false);
  expect(engine.claimProcessOwnership()).toBe(true);
  try {
    const loop = dealingLoop(engine);
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.handForHandResolve).not.toBeNull();
    expect(w.wakes).toContain('tournament_move_parked');
    await vi.advanceTimersByTimeAsync(16_000);
    expect(engine.handForHandResolve).not.toBeNull();

    await w.manager.recoverTournamentBreak(w.state());
    expect(engine.claimedTournamentMovePauseOwners.has(owner)).toBe(true);
    expect(w.state().state).toBe('begun');
    expect(w.calls).not.toContain('fn_f06_allocate_hand_number');
    expect(w.calls).not.toContain('fn_f06_begin_hand');
    engine.running = false;
    engine.claimedTournamentMovePauseOwners.clear();
    engine.tournamentMovePauseOwners.clear();
    engine.releasePauseGate?.();
    await vi.advanceTimersByTimeAsync(1);
    await loop;
  } finally {
    engine.constructor.releaseCurrentEngine(source, engine);
    engine.preciseTimer?.dispose?.();
  }
});

it('a dealer refused by its own break names it, is fenced for the break, and the break begins', async () => {
  vi.useFakeTimers(FAKE as any);
  const engine = tournamentEngine();
  const w = world(engine);
  w.manager.wireEliminationWake(engine);
  w.manager.startManagedTableEngine(engine, 'law admission');
  await w.settle();
  const owner = w.manager.tournamentMoveBoundaryOwner;

  // The park request committed but its reply was lost: nothing is armed here.
  w.seedBreak();
  live(engine, false);
  expect(engine.tournamentMovePauseOwners.size).toBe(0);
  await expect(engine.allocateGlobalHandNumber()).rejects.toThrow('f06_source_excluded_by_break');
  expect(w.wakes).toContain('f06_source_excluded');
  expect(engine.tournamentMovePauseOwners.has(owner)).toBe(true);

  const allocations = w.calls.filter((c) => c === 'fn_f06_allocate_hand_number').length;
  const loop = dealingLoop(engine);
  await vi.advanceTimersByTimeAsync(16_000);
  expect(engine.handForHandResolve).not.toBeNull();
  expect(w.calls.filter((c) => c === 'fn_f06_allocate_hand_number').length).toBe(allocations);

  await w.manager.recoverTournamentBreak(w.state());
  expect(engine.claimedTournamentMovePauseOwners.has(owner)).toBe(true);
  expect(w.state().state).toBe('begun');
  await finish(engine, owner, loop);
});
