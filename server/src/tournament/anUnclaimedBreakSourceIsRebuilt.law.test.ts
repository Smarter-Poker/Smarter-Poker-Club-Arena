/**
 * LAW: A KILLED BREAK SOURCE WHOSE PARK WAS NEVER CLAIMED IS REBUILT
 * (2026-09-26).
 *
 * Production, 2026-09-26 04:22-04:43 UTC: ten tables in four events
 * (bc2d52a8, 65e73842, 0168f878, 127b9363, 9702ef3c, 155227b2, 587ad1e6,
 * 3d08b81d, 7341017f, 80fe03f3; 55 players seated) each had a table-break row
 * in `park_requested`, revision 0, `custody_id` null, and a dealer that had
 * been killed (`dealing_loop_10_consecutive_errors` or
 * `tournament_table_zombie`). None was ever rebuilt. They were 22 of the 30
 * stalled-table observations in that window, and `deadStalledCount` went from
 * 2 to 9.
 *
 * The two halves waited on each other. Engine recovery asked the seat-move
 * certificate whether the stopped engine could be replaced, and it said no
 * (`recovery:break_source_retained`) because the break still retained the
 * source, so recovery rescheduled itself for ever. The break could not move
 * either: its one-second park probe had missed, so the park was never
 * claimed, and on a stopped engine `parkForTournamentMove` only answers yes
 * for a park that was already claimed. Recovery waited for the break and the
 * break waited for a live engine.
 *
 * An unclaimed retention holds nothing a replacement could cross: no move
 * boundary was claimed, no move is in flight, and the database already
 * refuses every hand on the table while the row exists. So recovery releases
 * that retention and replaces the engine; the replacement meets
 * `source_excluded` at admission and starts movement-only through
 * `fn_f06_admit_parked_movement` (custody null is claimed there), and the
 * break reaches `begun`. A CLAIMED boundary is a different fact - a move may
 * have been decided against that exact generation - and still refuses.
 *
 * Real ServerTableEngine, real TournamentManager recovery and break path.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { GameServer } from '../GameServer.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';
import { supabase } from '../services/supabase.js';

const id = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const event = id(1),
  lease = id(3),
  destination = id(4),
  user = id(5),
  seat = id(6),
  occupancy = id(7);
const LIFECYCLE = '349500';
// Each case gets its own table: engines register process-wide by table id.
let source = id(2);
let tables = 0;
beforeEach(() => {
  source = id(100 + ++tables);
});

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
  vi.spyOn(engine, 'start').mockResolvedValue(undefined);
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
  manager.requestEliminationSweep = vi.fn(() => true);
  manager.broadcast = vi.fn(async () => {});
  // Every replacement the recovery builds is a real engine whose dealer is
  // modelled below; only its process start is stubbed.
  const fresh: any[] = [];
  const create = manager.createManagedTableEngine.bind(manager);
  manager.createManagedTableEngine = (tableId: string) => {
    const built = create(tableId);
    Object.defineProperty(built, 'ready', { value: Promise.resolve(true) });
    vi.spyOn(built, 'start').mockResolvedValue(undefined);
    fresh.push(built);
    return built;
  };
  // Watch the real recovery the kill signal starts, so the test can settle it.
  const recoveries: Promise<unknown>[] = [];
  const recover = manager.recoverManagedTableEngine.bind(manager);
  manager.recoverManagedTableEngine = (...args: unknown[]) => {
    const recovery = recover(...args);
    recoveries.push(recovery);
    return recovery;
  };
  manager.eligibleBreakDestinations = vi.fn(async () => [
    {
      tableId: destination,
      playerCount: 5,
      maxSeats: 10,
      players: [{ userId: id(20), seat: 10, stack: 100 }],
    },
  ]);
  // The visit stops at `begun`: dispatch and retirement are covered by
  // F06OriginalManagerFlow.
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
        used_hand_number_max: '14640000',
        unresolved_permit: null,
        next_hand_number_candidate: excluded() ? null : '14640001',
      });
    if (name === 'fn_f06_table_state')
      return ok({
        ok: true,
        table_id: source,
        lifecycle: LIFECYCLE,
        excluded: excluded(),
        break_id: excluded() ? durable.break_id : null,
      });
    if (name === 'fn_f06_request_park') {
      durable ??= {
        ok: true,
        reason: null,
        break_id: p.p_break_id,
        tournament_id: event,
        source_table_id: source,
        lifecycle: LIFECYCLE,
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
        proof_hash: 'c'.repeat(64),
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
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.allSettled([
        ...manager.tableEngineRunJobs,
        ...manager.tableEngineStartJobs,
        ...recoveries,
      ]);
    }
  };
  return { manager, server, fresh, calls, state: () => clone(), settle };
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

/** Top of ServerTableEngineDealing's loop: park while fenced, else stop. */
function dealingLoop(engine: any): Promise<void> {
  return (async () => {
    while (engine.running && engine.tournamentMovePauseOwners.size > 0) {
      await engine.awaitPauseGate();
    }
  })();
}

/** Start the dealer and let it reach its gate; the loop is handed back unawaited. */
async function park(engine: any): Promise<{ loop: Promise<void> }> {
  const loop = dealingLoop(engine);
  await vi.advanceTimersByTimeAsync(0);
  expect(engine.handForHandResolve).not.toBeNull();
  return { loop };
}

async function release(engine: any, loop: Promise<void>): Promise<void> {
  engine.running = false;
  engine.tournamentMovePauseOwners.clear();
  engine.claimedTournamentMovePauseOwners.clear();
  engine.releasePauseGate?.();
  await vi.advanceTimersByTimeAsync(1);
  await loop;
  engine.constructor.releaseCurrentEngine?.(source, engine);
  engine.preciseTimer?.dispose?.();
}

const FAKE = {
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
} as const;

const KILLS: Array<[string, (engine: any) => void]> = [
  [
    'dealing_loop_10_consecutive_errors',
    (engine) => engine.killForRestart('dealing_loop_10_consecutive_errors'),
  ],
  [
    'tournament_table_zombie',
    (engine) => engine.fenceForEngineLeaseLoss('tournament_table_zombie', true),
  ],
];

/** Admit the original dealer and arm a break whose one-second probe misses. */
async function armUnclaimedBreak(w: any, engine: any): Promise<string> {
  w.manager.wireEliminationWake(engine);
  w.manager.startManagedTableEngine(engine, 'law admission');
  await w.settle();
  const owner = w.manager.tournamentMoveBoundaryOwner;
  // The balancer asks for the break while a hand is running.
  live(engine, true);
  const requested = await w.manager.requestTournamentBreakPark(source);
  expect(requested.state).toBe('park_requested');
  const sweep = w.manager.recoverTournamentBreak(requested);
  await vi.advanceTimersByTimeAsync(1_000);
  await sweep;
  expect(w.state()).toMatchObject({ state: 'park_requested', custody_id: null });
  expect(w.manager.retainedTournamentBreakSources.get(source)?.engine).toBe(engine);
  expect(engine.hasClaimedTournamentMoveBoundary()).toBe(false);
  return owner;
}

for (const [reason, kill] of KILLS) {
  it(`a source killed by ${reason} before its park was claimed is rebuilt movement-only and the break begins`, async () => {
    vi.useFakeTimers(FAKE as any);
    const engine = tournamentEngine();
    const w = world(engine);
    const owner = await armUnclaimedBreak(w, engine);

    kill(engine);
    await w.settle();

    // The dead generation is gone from both registries; one fresh engine
    // holds the table, admitted movement-only while the break is parked.
    expect(w.manager.seatMoveQuarantineRefusal()).toBeNull();
    expect(w.fresh).toHaveLength(1);
    const replacement = w.fresh[0];
    expect(w.manager.tableEngines.get(source)).toBe(replacement);
    expect(w.server.tableEngines.get(source)).toBe(replacement);
    expect(w.calls).toContain('fn_f06_admit_parked_movement');
    expect(replacement.f06MovementAdmission?.ownerId).toBe(owner);
    expect(replacement.f06Allocator).toBeNull();
    expect(w.state()).toMatchObject({ state: 'park_requested' });
    expect(w.state().custody_id).not.toBeNull();

    // The replacement parks at its gate; the next sweep claims it and the
    // break reaches `begun`. No hand was ever allocated on the source.
    live(replacement, false);
    expect(replacement.claimProcessOwnership()).toBe(true);
    const { loop } = await park(replacement);
    try {
      await w.manager.recoverTournamentBreak(w.state());
      expect(replacement.claimedTournamentMovePauseOwners.has(owner)).toBe(true);
      expect(w.state().state).toBe('begun');
      expect(w.state().members.map((m: any) => [m.user_id, m.destination_table_id])).toEqual([
        [user, destination],
      ]);
      expect(w.manager.retainedTournamentBreakSources.get(source)?.engine).toBe(replacement);
      expect(w.calls).not.toContain('fn_f06_allocate_hand_number');
    } finally {
      await release(replacement, loop);
    }
  });
}

it('a killed source whose park WAS claimed keeps its quarantine and is not replaced', async () => {
  vi.useFakeTimers(FAKE as any);
  const engine = tournamentEngine();
  const w = world(engine);
  w.manager.wireEliminationWake(engine);
  w.manager.startManagedTableEngine(engine, 'law admission');
  await w.settle();
  const owner = w.manager.tournamentMoveBoundaryOwner;

  // The dealer is parked at its gate when the break asks, so the park is
  // claimed and the break begins against this exact generation.
  live(engine, false);
  const requested = await w.manager.requestTournamentBreakPark(source);
  const sweep = w.manager.recoverTournamentBreak(requested);
  for (let i = 0; i < 20 && !engine.tournamentMovePauseOwners.has(owner); i++)
    await vi.advanceTimersByTimeAsync(0);
  const { loop } = await park(engine);
  await vi.advanceTimersByTimeAsync(1_000);
  await sweep;
  expect(w.state().state).toBe('begun');
  expect(engine.claimedTournamentMovePauseOwners.has(owner)).toBe(true);

  engine.killForRestart('dealing_loop_10_consecutive_errors');
  await w.settle();
  await loop;

  expect(w.fresh).toHaveLength(0);
  expect(w.manager.tableEngines.get(source)).toBe(engine);
  expect(w.server.tableEngines.get(source)).toBe(engine);
  expect(w.manager.seatMoveQuarantineRefusal()).toBe('recovery:break_source_retained');
  expect(w.manager.retainedTournamentBreakSources.get(source)?.engine).toBe(engine);
  expect(engine.claimedTournamentMovePauseOwners.has(owner)).toBe(true);
  expect(w.calls).not.toContain('fn_f06_admit_parked_movement');
  engine.preciseTimer?.dispose?.();
});
