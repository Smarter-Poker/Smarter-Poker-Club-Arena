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
async function fixture(failure = '', beginOutcome = 'committed') {
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
    if (name === 'fn_f06_begin_hand') {
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
  const beginResult = permit.reserve().then(
    () => ({ ok: true, error: null }),
    (error) => ({ ok: false, error })
  );
  if (!beginOutcome.startsWith('pending_')) expect((await beginResult).ok).toBe(false);
  engine.f06CurrentPermit = permit;
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

it.each(['success', 'allocation lost', 'owner changed'])(
  'allocation-only original retry: %s',
  async (outcome) => {
    const f = await fixture();
    f.engine.f06CurrentPermit = null;
    f.engine.running = false;
    const originalFailure = new Error('original allocation reply lost');
    const allocate = vi.fn(async () => {
      if (outcome === 'allocation lost') throw new Error('second allocation reply lost');
      if (outcome === 'owner changed') f.invalidate();
      return 1000002;
    });
    f.engine.installF06Allocator('original-epoch', allocate, () => true);
    f.engine.preparedF06AllocationError = originalFailure;
    f.engine.running = true;
    if (outcome === 'success') {
      await f.manager.recoverF06OriginalAdmissions();
      expect(f.engine.getF06FailedAllocation()).toBeNull();
      expect(f.engine.takePreparedHandNumber()).toBe(1000002);
    } else {
      await expect(f.manager.recoverF06OriginalAdmissions()).rejects.toThrow();
      expect(f.engine.getF06FailedAllocation().failure).toBe(originalFailure);
      expect(f.engine.preparedHandNumberValue).toBeNull();
    }
    expect(allocate).toHaveBeenCalledTimes(1);
    expect(f.state()).toBeNull();
    expect(f.calls.filter((c) => c.name === 'fn_f06_begin_hand')).toHaveLength(1);
  }
);
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
  await expect(f.manager.recoverF06OriginalAdmissions()).rejects.toThrow(
    'placement remains pending'
  );
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
