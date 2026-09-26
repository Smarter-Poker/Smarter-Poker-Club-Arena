import { afterEach, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { GameServer } from '../GameServer.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';
import { F06HandPermit } from '../services/F06HandPermit.js';
import { supabase } from '../services/supabase.js';
const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const event = id(1),
  source = id(2),
  lease = id(3),
  destination = id(4),
  user = id(5),
  seat = id(6),
  occupancy = id(7);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture(failure = '', beginOutcome = 'committed', prepareThroughDealer = false) {
  let releaseBegin: ((value: any) => void) | null = null;
  let originalRow: any = null;
  let beginReached = false;
  const originalIdentity = {
    tournament_id: event,
    generation: lease,
    table_id: source,
    lifecycle: '1',
    permit_id: id(8),
    hand_number: '1000001',
    custody_id: id(10),
  };
  const canonicalBegin = () => {
    beginReached = true;
    if (originalRow) return { ...originalRow, ok: originalRow.state === 'reserved' };
    originalRow = { ...originalIdentity, state: 'reserved', evidence_id: null };
    return { ...originalRow, ok: true };
  };
  let durable: any = null,
    fail = failure,
    valid = true;
  const events: string[] = [],
    calls: { name: string; p: any }[] = [];
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
  manager.lifecycleIsCurrent = () => valid;
  manager.requestUrgentEliminationSweepAfter = vi.fn();
  manager.broadcast = vi.fn(async () => {});
  manager.retireManagedTableFromHandForHand = vi.fn(() => events.push('H4H'));
  // Lifecycle and process-stop are controlled boundaries; construction, retirement
  // adapter, custody, permit, planner, Manager decisions and RPC parsers are real.
  vi.spyOn(engine, 'stop').mockImplementation(async () => {
    events.push('stop');
    engine.running = false;
    engine.terminal = true;
  });
  vi.spyOn(engine, 'hasReleasedProcessOwnership').mockReturnValue(true);
  manager.eligibleBreakDestinations = vi.fn(async () => [
    {
      tableId: destination,
      playerCount: 1,
      maxSeats: 10,
      players: [{ userId: id(20), seat: 10, stack: 100 }],
    },
  ]);
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('null', { status: 200 }))
  );
  const rpc = vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, p: any) => {
    calls.push({ name, p: structuredClone(p) });
    if (name === 'fn_ca_resume_hand_submission') return { data: { found: false }, error: null };
    if (name === 'fn_f06_begin_hand') {
      if (beginOutcome === 'live_reserved') return { data: canonicalBegin(), error: null };
      if (beginOutcome.startsWith('pending_')) {
        if (beginOutcome === 'pending_reserved') canonicalBegin();
        return new Promise<any>((resolve) => {
          releaseBegin = resolve;
        });
      }
      if (beginOutcome === 'committed') canonicalBegin();
      return { data: null, error: { message: 'BEGIN reply lost' } };
    }
    events.push(name);
    if (name === fail && name !== 'fn_move_tournament_player') {
      fail = '';
      return { data: null, error: { message: 'reply lost' } };
    }
    const ok = (data: any) => ({ data, error: null });
    if (name === 'fn_f06_table_state')
      return ok({
        ok: true,
        table_id: source,
        lifecycle: '1',
        excluded: !!durable,
        break_id: durable?.break_id ?? null,
      });
    if (name === 'fn_f06_cancel_prepared_hand') {
      expect(originalRow?.state).toBe('reserved');
      originalRow = { ...originalRow, state: 'never_started', evidence_id: p.p_permit_id };
      return ok({ ...originalRow, ok: true });
    }
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
    if (name === 'fn_f06_finish_hand') {
      // The original SQL boundary must still reject absent permits; it is not
      // a fallback for the new disposition API.
      if (!originalRow)
        return { data: null, error: { code: '22023', message: 'F06_UNKNOWN_PERMIT' } };
      throw new Error('obsolete no-start boundary: exact disposition RPC required');
    }
    if (name === 'fn_f06_finish_original_no_start') {
      expect(p).toEqual({
        p_tournament_id: event,
        p_lease_generation: lease,
        p_table_id: source,
        p_lifecycle: '1',
        p_permit_id: id(8),
        p_hand_number: '1000001',
        p_original_custody_id: id(10),
        p_break_id: durable.break_id,
        p_park_custody_id: durable.custody_id,
        p_park_revision: '1',
      });
      expect(p.p_original_custody_id).not.toBe(p.p_park_custody_id);
      expect(durable.state).toBe('park_requested');
      expect(engine.running).toBe(false);
      expect(server.tableEngines.get(source)).toBe(engine);
      expect(manager.tableEngines.get(source)).toBe(engine);
      expect(server.tournamentRetirementCustody.admissionAllowed(source)).toBe(false);
      // Transport-level model of Accounting's separately native-tested orderings.
      // This does not claim to execute SQL locks in a unit fixture.
      if (beginOutcome === 'delayed_begin_first' && !beginReached) canonicalBegin();
      originalRow = {
        ...originalIdentity,
        state: 'never_started',
        evidence_id: durable.custody_id,
      };
      return ok({ ...originalRow, ok: true });
    }
    if (name === 'fn_f06_continue_no_start_last_table')
      return {
        data: null,
        error: { code: '55000', message: 'F06_CONTINUATION_LAST_TABLE_REQUIRED' },
      };
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
      expect(server.tournamentRetirementCustody.admissionAllowed(source)).toBe(false);
      expect(engine.getF06RetainedPermit()).toBeNull();
      if (fail === name) return { data: null, error: { message: 'move reply lost' } };
      const m = durable.members[0];
      const receipt = {
        ok: true,
        request_id: p.p_request_id,
        tournament_id: event,
        user_id: user,
        source_table_id: source,
        destination_table_id: destination,
        source_seat_id: seat,
        destination_seat_id: id(9),
        source_seat_number: 1,
        destination_seat_number: m.destination_seat_number,
        stack: '100',
        moved_at: '2026-09-12T00:00:00Z',
        replayed: false,
        source_mode: 'live_source',
        source_occupancy_id: occupancy,
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
      expect(server.tableEngines.size).toBe(0);
      expect(manager.tableEngines.size).toBe(0);
      durable.state = 'acknowledged';
      return ok(clone());
    }
    throw new Error(`unexpected RPC ${name}`);
  }) as any);
  const permit = new F06HandPermit(
    {
      tournament_id: event,
      lease_generation: lease,
      table_id: source,
      lifecycle: '1',
      permit_id: id(8),
      hand_number: '1000001',
      custody_id: id(10),
    },
    (n, p) => supabase.rpc(n, p) as any,
    () => true
  );
  const beginResult = (prepareThroughDealer ? Promise.resolve() : permit.reserve()).then(
    () => ({ ok: true, error: null }),
    (error) => ({ ok: false, error })
  );
  if (!prepareThroughDealer && !beginOutcome.startsWith('pending_'))
    expect((await beginResult).ok).toBe(false);
  if (prepareThroughDealer) engine.installF06HandAdmission(() => permit);
  else engine.f06CurrentPermit = permit;
  engine.running = true;
  return {
    beginResult,
    releaseBegin: (row: any) => releaseBegin!({ data: row, error: null }),
    originalState: () => originalRow && structuredClone(originalRow),
    lateBegin: canonicalBegin,
    manager,
    engine,
    server,
    events,
    calls,
    rpc,
    permit,
    state: clone,
    clearFailure: () => {
      fail = '';
    },
    invalidate: () => {
      valid = false;
    },
  };
}
it('actual scheduled Manager path retires the original unknown BEGIN under one reservation', async () => {
  const f = await fixture();
  // End the scheduler after its new original-admission decision; all decisions
  // from park through ACK run unchanged, with canonical database responses.
  f.manager.visitTournamentBreakPage = vi.fn(async () => false);
  await f.manager.checkTableBalance();
  expect(f.state().state).toBe('acknowledged');
  expect(f.events.indexOf('fn_f06_claim_custody')).toBeLessThan(f.events.indexOf('stop'));
  expect(f.events.indexOf('fn_f06_finish_original_no_start')).toBeLessThan(
    f.events.indexOf('fn_move_tournament_player')
  );
  expect(f.server.tableEngines.size).toBe(0);
  expect(f.manager.tableEngines.size).toBe(0);
  expect(f.server.tournamentRetirementCustody.admissionAllowed(source)).toBe(true);
  expect(f.manager.stoppedOriginalBreaks.size).toBe(0);
  expect(f.calls.filter((c) => c.name === 'fn_f06_begin_hand')).toHaveLength(1);
});
it.each([
  'fn_f06_request_park',
  'fn_f06_claim_custody',
  'fn_f06_finish_original_no_start',
  'fn_f06_begin_break',
  'fn_move_tournament_player',
  'fn_f06_close_break',
  'fn_f06_ack_cleanup',
])('retains identity after unknown %s and completes exact redrive', async (failure) => {
  const f = await fixture(failure);
  await expect(f.manager.recoverF06OriginalAdmissions()).rejects.toThrow();
  expect(f.state()?.state).not.toBe('acknowledged');
  if (failure !== 'fn_f06_request_park' && failure !== 'fn_f06_ack_cleanup') {
    expect(f.manager.tableEngines.get(source)).toBe(f.engine);
    expect(f.server.tableEngines.get(source)).toBe(f.engine);
    expect(f.server.tournamentRetirementCustody.admissionAllowed(source)).toBe(false);
  }
  const before = f.calls.filter((c) => c.name === failure).map((c) => c.p);
  f.clearFailure();
  if (f.state()) await f.manager.recoverTournamentBreak(f.state());
  else await f.manager.recoverF06OriginalAdmissions();
  expect(f.state().state).toBe('acknowledged');
  const after = f.calls.filter((c) => c.name === failure).map((c) => c.p);
  if (failure !== 'fn_f06_claim_custody') expect(after.at(-1)).toEqual(before[0]);
  else expect(after.at(-1).p_custody_id).toBe(before[0].p_custody_id);
  expect(f.calls.filter((c) => c.name === 'fn_f06_begin_hand')).toHaveLength(1);
  expect(f.server.tournamentRetirementCustody.admissionAllowed(source)).toBe(true);
});
it('possible original actuation cannot select the no-start retirement path', async () => {
  const f = await fixture();
  (f.permit as any).phase = 'attempted';
  await f.manager.recoverF06OriginalAdmissions();
  expect(f.state()).toBeNull();
  expect(f.engine.stop).not.toHaveBeenCalled();
});
it('ownership loss after park response cannot stop or move the original', async () => {
  const f = await fixture();
  const park = f.manager.requestTournamentBreakPark.bind(f.manager);
  f.manager.requestTournamentBreakPark = async (...args: any[]) => {
    const result = await park(...args);
    f.invalidate();
    return result;
  };
  await expect(f.manager.recoverF06OriginalAdmissions()).rejects.toThrow('owner changed');
  expect(f.engine.stop).not.toHaveBeenCalled();
  expect(f.state().state).toBe('park_requested');
});

it('the Manager sweep leaves a failed allocation to the dealer and allocates nothing', async () => {
  // A failed allocation claims no hand; the dealer's next preparation
  // allocates fresh. The sweep neither retries it nor clears it.
  const f = await fixture();
  f.engine.f06CurrentPermit = null;
  f.engine.running = false;
  const originalFailure = new Error('original allocation reply lost');
  const allocate = vi.fn(async () => 1000002);
  f.engine.installF06Allocator('original-epoch', allocate, () => true);
  f.engine.preparedF06AllocationError = originalFailure;
  f.engine.running = true;
  await f.manager.recoverF06OriginalAdmissions();
  expect(allocate).not.toHaveBeenCalled();
  expect(f.engine.preparedF06AllocationError).toBe(originalFailure);
  expect(f.engine.preparedHandNumberValue ?? null).toBeNull();
  expect(f.state()).toBeNull();
  expect(f.calls.filter((c) => c.name === 'fn_f06_begin_hand')).toHaveLength(1);
});
it('retained stopped original never silently falls back to successor custody', async () => {
  const f = await fixture('fn_f06_begin_break');
  await expect(f.manager.recoverF06OriginalAdmissions()).rejects.toThrow();
  const replacement = new ServerTableEngine(source);
  f.manager.tableEngines.set(source, replacement);
  f.server.tableEngines.set(source, replacement);
  await expect(f.manager.recoverTournamentBreak(f.state())).rejects.toThrow(
    'original registry changed'
  );
  expect(f.state().state).toBe('park_requested');
});

it('committed ACK with lost response releases only retained proven absence', async () => {
  const f = await fixture();
  const rpc = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation((async (name: string, p: any) => {
    const result = await rpc(name, p);
    return name === 'fn_f06_ack_cleanup'
      ? { data: null, error: { message: 'committed ACK reply lost' } }
      : result;
  }) as any);
  await expect(f.manager.recoverF06OriginalAdmissions()).rejects.toThrow();
  expect(f.state().state).toBe('acknowledged');
  expect(f.server.tournamentRetirementCustody.admissionAllowed(source)).toBe(false);
  const stops = (f.engine.stop as any).mock.calls.length;
  await f.manager.recoverTournamentBreak(f.state());
  expect(f.engine.stop).toHaveBeenCalledTimes(stops);
  expect(f.calls.filter((c) => c.name === 'fn_f06_ack_cleanup')).toHaveLength(1);
  expect(f.server.tournamentRetirementCustody.admissionAllowed(source)).toBe(true);
  expect(f.manager.stoppedOriginalBreaks.size).toBe(0);
});
it('capacity delay preserves original no-start evidence and reservation for later placement', async () => {
  const f = await fixture();
  f.manager.eligibleBreakDestinations.mockResolvedValueOnce([]);
  // Two tables are open, so the wait is pending, not an error and not the
  // last-table continuation (aFullFieldIsNotTheLastTable.law.test.ts).
  await expect(f.manager.recoverF06OriginalAdmissions()).resolves.toBeUndefined();
  expect(f.calls.some((c) => c.name === 'fn_f06_continue_no_start_last_table')).toBe(false);
  expect(f.state()).toMatchObject({ state: 'park_requested', members: [] });
  expect(f.engine.getF06RetainedPermit()).toBeNull();
  expect(f.server.tableEngines.get(source)).toBe(f.engine);
  expect(f.server.tournamentRetirementCustody.admissionAllowed(source)).toBe(false);
  await f.manager.recoverTournamentBreak(f.state());
  expect(f.state().state).toBe('acknowledged');
  expect(f.calls.filter((c) => c.name === 'fn_f06_finish_original_no_start')).toHaveLength(1);
});
it('ownership changes during fresh reconciliation refuse before custody claim', async () => {
  const f = await fixture();
  const reconcile = f.manager.reconcileTournamentBreak.bind(f.manager);
  f.manager.reconcileTournamentBreak = async (...args: any[]) => {
    const result = await reconcile(...args);
    f.invalidate();
    return result;
  };
  await expect(f.manager.recoverF06OriginalAdmissions()).rejects.toThrow(
    'retirement owner changed'
  );
  expect(f.engine.stop).not.toHaveBeenCalled();
  expect(f.calls.filter((c) => c.name === 'fn_f06_claim_custody')).toHaveLength(0);
});

it.each(['committed', 'absent', 'rolled_back', 'delayed_begin_first', 'delayed_disposition_first'])(
  'exact disposition contract completes distinct BEGIN outcome: %s',
  async (outcome) => {
    const f = await fixture('', outcome);
    if (outcome === 'absent' || outcome === 'rolled_back' || outcome.startsWith('delayed'))
      expect(f.originalState()).toBeNull();
    await f.manager.recoverF06OriginalAdmissions();
    expect(f.state().state).toBe('acknowledged');
    expect(f.originalState()).toMatchObject({
      permit_id: id(8),
      hand_number: '1000001',
      custody_id: id(10),
      state: 'never_started',
    });
    expect(f.calls.filter((c) => c.name === 'fn_f06_begin_hand')).toHaveLength(1);
    expect(f.calls.filter((c) => c.name === 'fn_f06_finish_original_no_start')).toHaveLength(1);
    // A delayed exact BEGIN observes the durable terminal identity and cannot
    // grant start authority. Accounting owns native lock-order qualification.
    expect(f.lateBegin()).toMatchObject({ ok: false, state: 'never_started', permit_id: id(8) });
    expect(f.server.tournamentRetirementCustody.admissionAllowed(source)).toBe(true);
  }
);

it.each([
  'tournament_id',
  'table_id',
  'permit_id',
  'lifecycle',
  'hand_number',
  'custody_id',
  'generation',
  'evidence_id',
  'state',
  'ok',
])(
  'refuses a disposition receipt with mismatched %s before movement or local clear',
  async (field) => {
    const f = await fixture('', 'absent');
    const rpc = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation((async (name: string, p: any) => {
      const result = await rpc(name, p);
      if (name === 'fn_f06_finish_original_no_start')
        return {
          ...result,
          data: {
            ...(result as any).data,
            [field]:
              field === 'ok'
                ? false
                : field === 'lifecycle' || field === 'hand_number'
                  ? '2'
                  : field === 'state'
                    ? 'reserved'
                    : id(99),
          },
        };
      return result;
    }) as any);
    await expect(f.manager.recoverF06OriginalAdmissions()).rejects.toThrow();
    expect(f.engine.getF06RetainedPermit().binding.permit_id).toBe(id(8));
    expect(f.manager.tableEngines.get(source)).toBe(f.engine);
    expect(f.state().state).toBe('park_requested');
    expect(f.calls.filter((c) => c.name === 'fn_move_tournament_player')).toHaveLength(0);
    expect(f.server.tournamentRetirementCustody.admissionAllowed(source)).toBe(false);
  }
);
it('lost committed original disposition replays identical ten arguments before movement', async () => {
  const f = await fixture('', 'absent');
  const rpc = f.rpc.getMockImplementation()!;
  let first = true;
  f.rpc.mockImplementation((async (name: string, p: any) => {
    const result = await rpc(name, p);
    if (name === 'fn_f06_finish_original_no_start' && first) {
      first = false;
      return { data: null, error: { message: 'committed disposition reply lost' } };
    }
    return result;
  }) as any);
  await expect(f.manager.recoverF06OriginalAdmissions()).rejects.toThrow();
  expect(f.originalState().state).toBe('never_started');
  expect(f.engine.getF06RetainedPermit().binding.permit_id).toBe(id(8));
  expect(f.calls.filter((c) => c.name === 'fn_move_tournament_player')).toHaveLength(0);
  await f.manager.recoverTournamentBreak(f.state());
  const calls = f.calls.filter((c) => c.name === 'fn_f06_finish_original_no_start');
  expect(calls).toHaveLength(2);
  expect(calls[1].p).toEqual(calls[0].p);
  expect(f.state().state).toBe('acknowledged');
});

it.each(['pending_reserved', 'pending_absent'])(
  'actual pending original reserve reply cannot reactivate after Manager disposition: %s',
  async (mode) => {
    const f = await fixture('', mode);
    expect(f.permit.recoveryState()).toBe('unknown');
    await f.manager.recoverF06OriginalAdmissions();
    expect(f.state().state).toBe('acknowledged');
    // Simulate a pre-disposition reservation reply arriving late, or the canonical
    // terminal reply when disposition won first. The original promise is real.
    const reply =
      mode === 'pending_reserved'
        ? { ...f.originalState(), state: 'reserved', ok: true, evidence_id: null }
        : { ...f.originalState(), ok: false };
    f.releaseBegin(reply);
    const result = await f.beginResult;
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain('owner_changed');
    const actuate = vi.fn();
    expect(() => f.permit.start(actuate)).toThrow();
    expect(actuate).not.toHaveBeenCalled();
    expect(f.engine.getF06RetainedPermit()).toBeNull();
    expect(f.calls.filter((c) => c.name === 'fn_f06_begin_hand')).toHaveLength(1);
  }
);

it.each(['committed', 'absent', 'pending_reserved'])(
  'retired original %s reaches a real destination next-hand controller through Manager admission',
  async (mode) => {
    const f = await fixture('', mode);
    await f.manager.recoverF06OriginalAdmissions();
    const moved = f.state().members[0].winning_receipt;
    expect(moved.user_id).toBe(user);
    expect(moved.source_occupancy_id).toBe(occupancy);
    expect(moved.destination_table_id).toBe(destination);
    if (mode === 'pending_reserved') {
      f.releaseBegin({ ...f.originalState(), ok: true, state: 'reserved', evidence_id: null });
      expect((await f.beginResult).ok).toBe(false);
    }
    const next: any = new ServerTableEngine(destination);
    const roster = [
      {
        user_id: moved.user_id,
        seat_number: moved.destination_seat_number,
        stack: Number(moved.stack),
        occupancy_id: id(40),
        seat_id: moved.destination_seat_id,
        seat_joined_at: moved.moved_at,
        username: 'Moved player',
        is_horse: false,
      },
      {
        user_id: id(20),
        seat_number: 10,
        stack: 100,
        occupancy_id: id(41),
        seat_id: id(42),
        seat_joined_at: '2026-09-12T00:00:00Z',
        username: 'Destination player',
        is_horse: false,
      },
    ];
    Object.assign(next, {
      tableInfo: {
        id: destination,
        tournament_id: event,
        game_type: 'tournament',
        game_variant: 'nlh',
        max_players: 10,
        current_players: 2,
        status: 'running',
        small_blind: 10,
        big_blind: 20,
        ante: 0,
        action_time_seconds: 15,
      },
      seatedPlayers: roster,
      knownPlayerIds: new Set(roster.map((p) => p.user_id)),
      lastButtonSeat: 10,
      lastBigBlindSeat: 10,
      dealtInUserIds: new Set(roster.map((p) => p.user_id)),
      bombPotSchedPersistedJson: 'null',
      eventShadowEnabled: false,
      isCurrentEngine: () => true,
    });
    // External hydration/lifetime is controlled; Manager installs its actual F06
    // allocator/admission callbacks, then real dealHand and HandController run.
    vi.spyOn(next, 'start').mockImplementation(async () => {
      next.running = true;
    });
    Object.defineProperty(next, 'ready', { value: Promise.resolve(true) });
    next.fetchTimeBankExtras = async () => new Map();
    next.refreshRakeConfig = async () => {};
    next.persistHoleCardsWithRetry = async () => {};
    next.flushSnapshot = async () => {};
    const handEvents: any[] = [];
    next.handleHandEvent = async (event: any) => {
      handEvents.push(event);
    };
    f.manager.tableEngines.set(destination, next);
    f.server.tableEngines.set(destination, next);
    f.server.tournamentOwnedTables.add(destination);
    const rpc = f.rpc.getMockImplementation()!;
    const destinationCalls: { name: string; p: any }[] = [];
    f.rpc.mockImplementation((async (name: string, p: any) => {
      if (p?.p_table_id !== destination) return rpc(name, p);
      destinationCalls.push({ name, p: structuredClone(p) });
      if (name === 'fn_ca_resume_hand_submission') return { data: { found: false }, error: null };
      if (name === 'fn_f06_hand_number_state')
        return {
          data: {
            ok: true,
            table_id: destination,
            lifecycle: '1',
            can_reserve: true,
            blocked_reason: null,
            used_hand_number_max: '1000001',
            next_hand_number_candidate: '1000002',
            unresolved_permit: null,
          },
          error: null,
        };
      if (name === 'fn_f06_allocate_hand_number')
        return {
          data: {
            ok: true,
            table_id: destination,
            lifecycle: '1',
            hand_number: '1000002',
            hand_number_high_water: '1000001',
          },
          error: null,
        };
      if (name === 'fn_f06_begin_hand')
        return {
          data: {
            ok: true,
            tournament_id: p.p_tournament_id,
            generation: p.p_lease_generation,
            custody_id: p.p_custody_id,
            permit_id: p.p_permit_id,
            table_id: destination,
            lifecycle: '1',
            hand_number: '1000002',
            state: 'reserved',
          },
          error: null,
        };
      throw new Error('unexpected destination RPC ' + name);
    }) as any);
    f.manager.startManagedTableEngine(next, 'destination test hydration');
    await Promise.all([...f.manager.tableEngineRunJobs, ...f.manager.tableEngineStartJobs]);
    expect(next.start).toHaveBeenCalledTimes(1);
    let dealError: unknown;
    const dealing = next.dealHand(roster).catch((e: unknown) => {
      dealError = e;
    });
    try {
      for (
        let i = 0;
        i < 100 && !handEvents.some((e) => e.type === 'HAND_START') && !dealError;
        i++
      )
        await Promise.resolve();
      expect(dealError).toBeUndefined();
      expect(handEvents.some((e) => e.type === 'HAND_START')).toBe(true);
      const state = next.handController.getState();
      expect(state.stage).toBe('preflop');
      const player = state.players.find((p: any) => p.user_id === user);
      expect(player).toBeDefined();
      expect(player.cards).toHaveLength(2);
      expect(player.stack + player.totalInvested).toBe(Number(moved.stack));
      expect(state.pot).toBe(30);
      expect(next.handCount).toBe(1000002);
      expect(next.getF06RetainedPermit().phase).toBe('attempted');
      expect(destinationCalls.map((c) => c.name)).toEqual([
        'fn_ca_resume_hand_submission',
        'fn_f06_hand_number_state',
        'fn_f06_allocate_hand_number',
        'fn_f06_hand_number_state',
        'fn_f06_begin_hand',
      ]);
      expect(destinationCalls.at(-1)!.p.p_permit_id).not.toBe(id(8));
      expect(f.engine.getF06RetainedPermit()).toBeNull();
    } finally {
      next.running = false;
      next.activeHandWaitRelease?.release('test_cleanup');
      next.preciseTimer.dispose();
      await dealing;
    }
  }
);

it.each(['continue', 'fail', 'pause', 'unknown_reply'])(
  'ordinary reserved preparation is not original recovery while its allowance read is pending: %s',
  async (outcome) => {
    const f = await fixture(
      'fn_f06_request_park',
      outcome === 'unknown_reply' ? 'pending_reserved' : 'live_reserved',
      true
    );
    const roster = [
      {
        user_id: user,
        seat_number: 1,
        stack: 100,
        occupancy_id: occupancy,
        seat_id: seat,
        seat_joined_at: '2026-09-12T00:00:00Z',
        username: 'First player',
        is_horse: false,
      },
      {
        user_id: id(20),
        seat_number: 2,
        stack: 100,
        occupancy_id: id(41),
        seat_id: id(42),
        seat_joined_at: '2026-09-12T00:00:00Z',
        username: 'Second player',
        is_horse: false,
      },
    ];
    Object.assign(f.engine, {
      tableInfo: {
        id: source,
        tournament_id: event,
        game_type: 'tournament',
        game_variant: 'nlh',
        max_players: 2,
        current_players: 2,
        status: 'waiting',
        small_blind: 10,
        big_blind: 20,
        ante: 0,
        action_time_seconds: 15,
      },
      seatedPlayers: roster,
      knownPlayerIds: new Set(roster.map((p) => p.user_id)),
      lastButtonSeat: 2,
      lastBigBlindSeat: 2,
      dealtInUserIds: new Set(roster.map((p) => p.user_id)),
      bombPotSchedPersistedJson: 'null',
      eventShadowEnabled: false,
      isCurrentEngine: () => true,
      allocateGlobalHandNumber: async () => 1000001,
      refreshRakeConfig: async () => {},
      persistHoleCardsWithRetry: async () => {},
      flushSnapshot: async () => {},
    });
    let release!: () => void;
    const allowance = new Promise<Map<string, number>>((resolve, reject) => {
      release = () =>
        outcome === 'fail' ? reject(new Error('original preparation failed')) : resolve(new Map());
    });
    const allowanceRead = vi.fn(() => allowance);
    f.engine.fetchTimeBankExtras = allowanceRead;
    const handEvents: any[] = [];
    f.engine.handleHandEvent = async (event: any) => {
      handEvents.push(event);
    };
    let dealError: unknown;
    const dealing = f.engine.dealHand(roster).catch((e: unknown) => {
      dealError = e;
    });
    try {
      if (outcome === 'unknown_reply') {
        for (let i = 0; i < 100 && !f.calls.some((call) => call.name === 'fn_f06_begin_hand'); i++)
          await Promise.resolve();
        expect(f.engine.getF06RetainedPermit().phase).toBe('unknown');
        await f.manager.recoverF06OriginalAdmissions();
        expect(f.calls.some((call) => call.name === 'fn_f06_request_park')).toBe(false);
        f.releaseBegin(f.lateBegin());
      }
      for (let i = 0; i < 100 && !allowanceRead.mock.calls.length && !dealError; i++)
        await Promise.resolve();
      expect(dealError).toBeUndefined();
      expect(allowanceRead).toHaveBeenCalledOnce();
      expect(f.engine.getF06RetainedPermit().phase).toBe('reserved');
      expect(handEvents.some((event) => event.type === 'HAND_START')).toBe(false);
      // This is the real scheduled recovery decision, during the real dealer's
      // asynchronous gap after BEGIN and before its synchronous controller start.
      await f.manager.recoverF06OriginalAdmissions();
      expect(f.calls.some((call) => call.name === 'fn_f06_request_park')).toBe(false);
      expect(f.engine.stop).not.toHaveBeenCalled();
      expect(
        f.manager.bindStoppedOriginalBreak({
          source_table_id: source,
          break_id: id(98),
          state: 'park_requested',
          lifecycle: '1',
        })
      ).toBe(false);
      if (outcome === 'pause') f.engine.pauseAfterHand(120000, { beforeNextHand: true });
      release();
      for (
        let i = 0;
        i < 100 && !handEvents.some((event) => event.type === 'HAND_START') && !dealError;
        i++
      )
        await Promise.resolve();
      if (outcome === 'continue' || outcome === 'unknown_reply') {
        expect(dealError).toBeUndefined();
        expect(handEvents.some((event) => event.type === 'HAND_START')).toBe(true);
        expect(f.engine.getF06RetainedPermit().phase).toBe('attempted');
        await f.manager.recoverF06OriginalAdmissions();
        expect(f.engine.stop).not.toHaveBeenCalled();
      } else {
        await dealing;
        if (outcome === 'fail') expect(String(dealError)).toContain('original preparation failed');
        else expect(dealError).toBeUndefined();
        expect(handEvents.some((event) => event.type === 'HAND_START')).toBe(false);
        if (outcome === 'pause') {
          // A paused original preparation is durably cancelled by its own
          // exact permit, without manufacturing a table-retirement operation.
          await f.manager.recoverF06OriginalAdmissions();
          expect(
            f.calls.filter((call) => call.name === 'fn_f06_cancel_prepared_hand')
          ).toHaveLength(1);
          expect(f.calls.filter((call) => call.name === 'fn_f06_request_park')).toHaveLength(0);
          expect(f.engine.getF06RetainedPermit()).toBeNull();
        } else {
          await expect(f.manager.recoverF06OriginalAdmissions()).rejects.toThrow(
            'outcome unproven'
          );
          expect(f.calls.filter((call) => call.name === 'fn_f06_request_park')).toHaveLength(1);
          expect(f.engine.getF06RetainedPermit().binding.permit_id).toBe(id(8));
        }
      }
    } finally {
      release();
      f.engine.running = false;
      f.engine.activeHandWaitRelease?.release('test_cleanup');
      f.engine.preciseTimer.dispose();
      await dealing;
    }
  }
);

it('a replacement Manager admission cannot reconstruct an unresolved original permit to cancel it', async () => {
  const f = await fixture('', 'committed');
  const original = f.engine.getF06RetainedPermit();
  const replacement = new ServerTableEngine(source) as any;
  Object.defineProperty(replacement, 'ready', { value: Promise.resolve(false) });
  vi.spyOn(replacement, 'start').mockResolvedValue(undefined);
  f.manager.tableEngines.set(source, replacement);
  f.server.tableEngines.set(source, replacement);
  const recovery = vi.spyOn(f.manager, 'recoverManagedTableEngine').mockResolvedValue(undefined);
  f.rpc.mockImplementation((async (name: string) => {
    if (name === 'fn_ca_resume_hand_submission') return { data: { found: false }, error: null };
    expect(name).toBe('fn_f06_hand_number_state');
    return {
      data: {
        ok: true,
        table_id: source,
        lifecycle: '1',
        can_reserve: false,
        blocked_reason: 'hand_permit_unresolved',
        used_hand_number_max: '1000001',
        next_hand_number_candidate: '1000002',
        unresolved_permit: original,
      },
      error: null,
    };
  }) as any);
  try {
    f.manager.startManagedTableEngine(replacement, 'test replacement');
    await Promise.allSettled([...f.manager.tableEngineRunJobs, ...f.manager.tableEngineStartJobs]);
    expect(replacement.start).not.toHaveBeenCalled();
    expect(replacement.getF06RetainedPermit()).toBeNull();
    expect(recovery).toHaveBeenCalledOnce();
    expect(f.engine.getF06RetainedPermit()).toEqual(original);
    expect(f.calls.some((call) => call.name === 'fn_f06_cancel_prepared_hand')).toBe(false);
  } finally {
    f.engine.running = false;
    f.engine.preciseTimer.dispose();
    replacement.preciseTimer.dispose();
  }
});

async function lastTableFixture() {
  const f = await fixture();
  f.manager.eligibleBreakDestinations.mockResolvedValue([]);
  // The last table is the event's only open table (2026-09-26: a source whose
  // roster merely does not fit elsewhere is not; aFullFieldIsNotTheLastTable).
  const tables: any = supabase.from('tables');
  tables.or = async () => ({ data: [{ id: source }], error: null });
  const fresh: any = new ServerTableEngine(source);
  vi.spyOn(fresh, 'start').mockImplementation(async () => {
    fresh.running = true;
  });
  Object.defineProperty(fresh, 'ready', { value: Promise.resolve(true) });
  f.manager.createManagedTableEngine = vi.fn(() => fresh);
  const originalRpc = f.rpc.getMockImplementation()!;
  let receipt: any = null;
  let continuationFailure: any = null;
  let lostAfterCommit = false;
  let currentGeneration = lease;
  f.rpc.mockImplementation((async (name: string, p: any) => {
    if (name === 'fn_f06_continue_no_start_last_table') {
      f.calls.push({ name, p: structuredClone(p) });
      f.events.push(name);
      expect(f.engine.hasReleasedProcessOwnership()).toBe(true);
      expect(f.engine.getF06RetainedPermit()).toBeNull();
      expect(f.server.tournamentRetirementCustody.admissionAllowed(source)).toBe(false);
      if (continuationFailure) return { data: null, error: continuationFailure };
      const state = f.state();
      receipt ??= {
        ok: true,
        state: 'continued_never_started',
        receipt_id: id(81),
        credit: 0,
        tournament_id: event,
        table_id: source,
        lifecycle: '1',
        break_id: state.break_id,
        park_custody_id: state.custody_id,
        park_revision: state.revision,
        lease_generation: currentGeneration,
        original_generation: lease,
        permit_id: id(8),
        hand_number: '1000001',
      };
      // The native companion owns actual withdrawal/locks. This transport
      // fixture returns the immutable same receipt after a committed lost reply.
      if (lostAfterCommit) {
        lostAfterCommit = false;
        return { data: null, error: { message: 'committed reply lost' } };
      }
      return { data: { ...receipt }, error: null };
    }
    if (name === 'fn_f06_hand_number_state')
      return {
        data: {
          ok: true,
          table_id: source,
          lifecycle: '1',
          can_reserve: !!receipt,
          blocked_reason: receipt ? null : 'source_excluded',
          unresolved_permit: null,
          used_hand_number_max: '1000001',
          next_hand_number_candidate: receipt ? '1000002' : null,
        },
        error: null,
      };
    return originalRpc(name, p);
  }) as any);
  return {
    ...f,
    fresh,
    receipt: () => receipt,
    loseReply: () => {
      lostAfterCommit = true;
    },
    refuse: (error: any) => {
      continuationFailure = error;
    },
    useGeneration: (value: string) => {
      currentGeneration = value;
    },
  };
}

it('last table original positive no-start uses one receipt and real registry CAS into fresh admission', async () => {
  const f = await lastTableFixture();
  await f.manager.recoverF06OriginalAdmissions();
  await Promise.all([...f.manager.tableEngineRunJobs, ...f.manager.tableEngineStartJobs]);
  expect(f.receipt()?.state).toBe('continued_never_started');
  expect(f.originalState().state).toBe('never_started');
  expect(f.server.tableEngines.get(source)).toBe(f.fresh);
  expect(f.manager.tableEngines.get(source)).toBe(f.fresh);
  expect(f.fresh.start).toHaveBeenCalledTimes(1);
  expect(f.engine.running).toBe(false);
  expect(f.manager.pendingNoStartContinuations.size).toBe(0);
  expect(f.calls.filter((c) => c.name === 'fn_f06_begin_hand')).toHaveLength(1);
  expect(
    f.calls.some((c) =>
      [
        'fn_f06_begin_break',
        'fn_move_tournament_player',
        'fn_f06_close_break',
        'fn_f06_ack_cleanup',
      ].includes(c.name)
    )
  ).toBe(false);
  f.fresh.running = false;
});

it('last table lost committed continuation replays exact identity before fresh registry admission', async () => {
  const f = await lastTableFixture();
  f.loseReply();
  await expect(f.manager.recoverF06OriginalAdmissions()).rejects.toThrow('outcome unproven');
  expect(f.receipt()).not.toBeNull();
  expect(f.server.tableEngines.get(source)).toBe(f.engine);
  expect(f.manager.pendingNoStartContinuations.size).toBe(1);
  expect(f.fresh.start).not.toHaveBeenCalled();
  await f.manager.recoverF06OriginalAdmissions();
  await Promise.all([...f.manager.tableEngineRunJobs, ...f.manager.tableEngineStartJobs]);
  const calls = f.calls.filter((c) => c.name === 'fn_f06_continue_no_start_last_table');
  expect(calls).toHaveLength(2);
  expect(calls[1].p).toEqual(calls[0].p);
  expect(f.server.tableEngines.get(source)).toBe(f.fresh);
  expect(f.manager.pendingNoStartContinuations.size).toBe(0);
  expect(f.calls.filter((c) => c.name === 'fn_f06_finish_original_no_start')).toHaveLength(1);
  f.fresh.running = false;
});

it.each([
  { code: '55000', message: 'F06_CONTINUATION_LAST_TABLE_REQUIRED' },
  { code: '55000', message: 'F06_CONTINUATION_POSITIVE_ORIGINAL_REQUIRED' },
  { code: '42501', message: 'current lease refused' },
])(
  'last table known refusal preserves stopped original and never admits fresh: $message',
  async (error) => {
    const f = await lastTableFixture();
    f.refuse(error);
    await expect(f.manager.recoverF06OriginalAdmissions()).rejects.toThrow();
    expect(f.manager.pendingNoStartContinuations.size).toBe(0);
    expect(f.server.tableEngines.get(source)).toBe(f.engine);
    expect(f.fresh.start).not.toHaveBeenCalled();
    expect(f.server.tournamentRetirementCustody.admissionAllowed(source)).toBe(false);
  }
);

it('successor startup continues only positive terminal no-start, then uses normal fresh admission', async () => {
  const f = await lastTableFixture();
  f.refuse({ code: '55000', message: 'F06_CONTINUATION_LAST_TABLE_REQUIRED' });
  await expect(f.manager.recoverF06OriginalAdmissions()).rejects.toThrow();
  expect(f.originalState().state).toBe('never_started');
  const successorLease = id(82);
  f.useGeneration(successorLease);
  f.refuse(null);
  const candidate: any = new ServerTableEngine(source);
  vi.spyOn(candidate, 'stop').mockImplementation(async () => {
    candidate.running = false;
    candidate.terminal = true;
  });
  vi.spyOn(candidate, 'hasReleasedProcessOwnership').mockReturnValue(true);
  Object.defineProperty(candidate, 'ready', { value: Promise.resolve(true) });
  const start = vi.spyOn(candidate, 'start').mockImplementation(async () => {});
  // A successor owns a fresh process registry; the old owner remains retired.
  f.server.tournamentRetirementCustody = new TournamentRetirementCustody();
  f.server.tableEngines.set(source, candidate);
  const manager: any = new TournamentManager(
    event,
    f.server,
    successorLease,
    performance.now() + 60000
  );
  manager.running = true;
  manager.tableEngines.set(source, candidate);
  const token = {};
  manager.lifecycleEpoch.current = () => token;
  manager.lifecycleIsCurrent = () => true;
  manager.createManagedTableEngine = vi.fn(() => f.fresh);
  const query: any = {
    select: () => query,
    eq: () => query,
    neq: () => query,
    or: async () => ({ data: [{ id: source }], error: null }),
  };
  vi.mocked(supabase.from).mockReturnValue(query);
  manager.startManagedTableEngine(candidate, 'successor no-start fixture');
  while (manager.tableEngineRunJobs.size) await Promise.all([...manager.tableEngineRunJobs]);
  expect(f.receipt()?.lease_generation).toBe(successorLease);
  expect(start).not.toHaveBeenCalled();
  expect(candidate.stop).toHaveBeenCalled();
  expect(f.fresh.start).toHaveBeenCalledTimes(1);
  expect(manager.tableEngines.get(source)).toBe(f.fresh);
  expect(f.server.tableEngines.get(source)).toBe(f.fresh);
  expect(f.originalState().state).toBe('never_started');
  expect(f.calls.filter((c) => c.name === 'fn_f06_finish_original_no_start')).toHaveLength(1);
  f.fresh.running = false;
});

it('multi-table source exclusion remains available to movement admission without stopping candidate', async () => {
  const f = await lastTableFixture();
  f.engine.f06CurrentPermit = null;
  const query: any = {
    select: () => query,
    eq: () => query,
    neq: () => query,
    or: async () => ({ data: [{ id: source }, { id: destination }], error: null }),
  };
  vi.mocked(supabase.from).mockReturnValue(query);
  expect(await f.manager.continueExcludedNoStartTable(source, f.engine, () => true)).toBe(false);
  expect(f.engine.stop).not.toHaveBeenCalled();
  expect(f.calls.some((c) => c.name === 'fn_f06_continue_no_start_last_table')).toBe(false);
});

it.each(['valid', 'unresolved', 'wrong custody', 'wrong proof', 'owner changed'])(
  'replacement Manager admits only exact canonical movement custody: %s',
  async (mode) => {
    const f = await fixture('', 'absent');
    const replacement: any = new ServerTableEngine(source, {
      scope: 'tournament',
      verified: true,
      generation: lease,
      tournamentId: event,
      proofDeadlineMonotonicMs: performance.now() + 60_000,
    });
    Object.defineProperty(replacement, 'ready', { value: Promise.resolve(true) });
    const start = vi.spyOn(replacement, 'start').mockResolvedValue(undefined);
    const recovery = vi.spyOn(f.manager, 'recoverManagedTableEngine').mockResolvedValue(undefined);
    f.manager.tableEngines.set(source, replacement);
    f.server.tableEngines.set(source, replacement);
    const seen: string[] = [];
    f.rpc.mockImplementation((async (name: string, p: any) => {
      seen.push(name);
      if (name === 'fn_ca_resume_hand_submission') return { data: { found: false }, error: null };
      if (name === 'fn_f06_hand_number_state')
        return {
          data: {
            ok: true,
            table_id: source,
            lifecycle: '252200',
            can_reserve: false,
            blocked_reason: mode === 'unresolved' ? 'hand_permit_unresolved' : 'source_excluded',
            unresolved_permit: mode === 'unresolved' ? { permit_id: id(8) } : null,
            used_hand_number_max: '12297119',
            next_hand_number_candidate: null,
          },
          error: null,
        };
      if (name === 'fn_f06_table_state')
        return {
          data: {
            ok: true,
            table_id: source,
            lifecycle: '252200',
            excluded: true,
            break_id: id(50),
          },
          error: null,
        };
      if (name === 'fn_f06_break_state')
        return {
          data: {
            ok: true,
            reason: null,
            break_id: id(50),
            tournament_id: event,
            source_table_id: source,
            lifecycle: '252200',
            state: 'park_requested',
            revision: '0',
            custody_id: null,
            custody_generation: null,
            members: [],
            terminal_handoff_required: false,
          },
          error: null,
        };
      if (name === 'fn_f06_admit_parked_movement') {
        if (mode === 'owner changed') f.manager.tableEngines.delete(source);
        return {
          data: {
            ok: true,
            mode: 'movement_only',
            admission_id: p.p_admission_id,
            tournament_id: event,
            lease_generation: lease,
            table_id: source,
            lifecycle: '252200',
            break_id: id(50),
            custody_id: mode === 'wrong custody' ? id(51) : p.p_custody_id,
            revision: '1',
            proof_hash: mode === 'wrong proof' ? null : 'a'.repeat(64),
          },
          error: null,
        };
      }
      throw new Error('unexpected RPC: ' + name);
    }) as any);
    try {
      f.manager.startManagedTableEngine(replacement, 'test movement admission');
      await Promise.allSettled([
        ...f.manager.tableEngineRunJobs,
        ...f.manager.tableEngineStartJobs,
      ]);
      if (mode === 'valid') {
        expect(start).toHaveBeenCalledOnce();
        expect(recovery).not.toHaveBeenCalled();
        expect(replacement.f06MovementAdmission.receipt.lifecycle).toBe('252200');
        expect(replacement.f06Allocator).toBeNull();
        expect(replacement.getF06RetainedPermit()).toBeNull();
      } else {
        expect(start).not.toHaveBeenCalled();
        expect(recovery).toHaveBeenCalledOnce();
      }
      expect(seen.slice(0, 2)).toEqual([
        'fn_ca_resume_hand_submission',
        'fn_f06_hand_number_state',
      ]);
      expect(seen).not.toContain('fn_f06_begin_hand');
      expect(seen).not.toContain('fn_f06_allocate_hand_number');
      expect(seen).not.toContain('fn_f06_finish_original_no_start');
    } finally {
      f.engine.running = false;
      f.engine.preciseTimer.dispose();
      replacement.preciseTimer.dispose();
    }
  }
);

it.each(['accepted', 'pending', 'lost owner'])(
  'retained original continuation precedes actual replacement admission: %s',
  async (outcome) => {
    const f = await fixture('', 'committed');
    const replacement = new ServerTableEngine(source) as any;
    Object.defineProperty(replacement, 'ready', { value: Promise.resolve(true) });
    const start = vi.spyOn(replacement, 'start').mockResolvedValue(undefined);
    f.manager.tableEngines.set(source, replacement);
    f.server.tableEngines.set(source, replacement);
    vi.spyOn(f.manager, 'recoverManagedTableEngine').mockResolvedValue(undefined);
    const order: string[] = [];
    f.rpc.mockImplementation((async (name: string) => {
      order.push(name);
      if (name === 'fn_ca_resume_hand_submission') {
        if (outcome === 'lost owner') f.invalidate();
        return {
          data:
            outcome === 'pending'
              ? { found: true, completed: false, reason: 'original_failure_or_handoff_unproven' }
              : {
                  found: true,
                  completed: true,
                  success: true,
                  atomic_hand_commit: true,
                  snapshot_completed: true,
                  post_commit_completed: true,
                  table_id: source,
                  history_id: id(42),
                  submission_id: id(42),
                  submission_hash: 'a'.repeat(64),
                  hand_number: '1000001',
                },
          error: null,
        };
      }
      if (name !== 'fn_f06_hand_number_state') throw new Error('Unexpected admission RPC ' + name);
      return {
        data: {
          ok: true,
          table_id: source,
          lifecycle: '1',
          can_reserve: true,
          blocked_reason: null,
          used_hand_number_max: '1000001',
          next_hand_number_candidate: '1000002',
          unresolved_permit: null,
        },
        error: null,
      };
    }) as any);
    try {
      f.manager.startManagedTableEngine(replacement, 'retained admission test');
      await Promise.allSettled([
        ...f.manager.tableEngineRunJobs,
        ...f.manager.tableEngineStartJobs,
      ]);
      expect(order).toEqual(
        outcome === 'accepted'
          ? ['fn_ca_resume_hand_submission', 'fn_f06_hand_number_state']
          : ['fn_ca_resume_hand_submission']
      );
      expect(start).toHaveBeenCalledTimes(outcome === 'accepted' ? 1 : 0);
      expect(replacement.getF06RetainedPermit()).toBeNull();
    } finally {
      replacement.preciseTimer.dispose();
      f.engine.preciseTimer.dispose();
    }
  }
);
