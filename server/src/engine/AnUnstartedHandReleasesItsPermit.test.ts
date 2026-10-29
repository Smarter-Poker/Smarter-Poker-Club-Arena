/**
 * A DEAL ATTEMPT THAT ENDS WITHOUT A HAND RELEASES ITS F06 PERMIT
 * (2026-10-15, Dan: "FIX THE STALLING TOURNAMENT TABLES AT THEIR ROOT CAUSE.")
 *
 * Production, 2026-10-11 to 2026-10-15: spin, heads-up and MTT tables committed
 * a hand cleanly, dealt nothing for three minutes, and were killed and rebuilt
 * by GameServer's 180s `tournament_table_zombie` reaper. Every one of them held
 * exactly one F06 permit above its last committed hand, `reserved` until the
 * rebuild's no-start receipt (ef900c4d / 34605918 and 9aca69d4 / 34605926,
 * reserved 06:07, released 06:10:48 after the 06:10:25 kills).
 *
 * The line: dealHand's `finally` released an unstarted permit only when the
 * table was paused or stopped. Any other way an attempt ended unstarted (the
 * permit refusing `start`, a throw between reservation and start, a begin reply
 * lost after SQL committed it) left the permit `reserved`, and every later
 * attempt was then refused (`f06_prior_hand_unresolved` here, and
 * `hand_permit_unresolved` from the allocator in production) until the reaper.
 *
 * These tests drive the real dealHand, the real F06HandPermit and an RPC fake
 * that keeps SQL's one-reserved-permit-per-table rule. Before the fix the
 * second deal in each case rejects with f06_prior_hand_unresolved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: () => {
      throw new Error('Unexpected database write');
    },
    rpc: () => {
      throw new Error('Unexpected database RPC');
    },
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn(), reportWarning: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';
import { F06HandPermit } from '../services/F06HandPermit.js';

const ids = {
  tournament_id: 'aaaaaaaa-0000-4000-8000-0000000000f1',
  lease_generation: 'bbbbbbbb-0000-4000-8000-0000000000f1',
  table_id: 'cccccccc-0000-4000-8000-0000000000f1',
  custody_id: 'eeeeeeee-0000-4000-8000-0000000000f1',
  lifecycle: '7',
};

type Row = {
  permit_id: string;
  hand_number: string;
  state: 'reserved' | 'never_started' | 'accepted';
  evidence_id: string | null;
};

const engines: any[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.cancelHorseDecisionWork();
    engine.running = false;
    (ServerTableEngine as any).releaseCurrentEngine(engine.tableId, engine);
    engine.preciseTimer.dispose();
    engine.engineTelemetry.dispose();
  }
  vi.restoreAllMocks();
});

function fixture(opts: { loseBeginReply?: number; loseCancelReply?: number } = {}) {
  const engine = new ServerTableEngine(ids.table_id) as any;
  engines.push(engine);
  expect(engine.claimProcessOwnership()).toBe(true);
  engine.tableInfo = {
    id: ids.table_id,
    game_variant: 'nlh',
    game_type: 'tournament',
    tournament_id: ids.tournament_id,
    max_players: 3,
    small_blind: 10,
    big_blind: 20,
    ante: 0,
    ante_enabled: false,
  };
  const seats = [1, 2, 3].map((seat) => ({
    seat_number: seat,
    user_id: 'u' + seat,
    username: 'Player ' + seat,
    occupancy_id: 'occupancy-' + seat,
    stack: 1000,
    seat_id: '00000000-0000-4000-8000-00000000000' + seat,
    seat_joined_at: '2026-10-15T00:00:00.123456Z',
  }));
  engine.seatedPlayers = seats;
  engine.takePreparedHandNumber = () => 100 + engine.handsDealtThisSession;
  engine.bombPotSchedPersistedJson = 'null';
  engine.eventShadowEnabled = false;
  engine.hub = { emitEvent: vi.fn() };
  engine.refreshRakeConfig = async () => {};
  // The private writer is qualified separately by OriginalControllerRuntime
  // and native PostgreSQL; this fixture isolates permit cancellation.
  engine.retainOriginalBatch = vi.fn(async () => {});
  engine.saveSnapshot = vi.fn(async () => {});
  engine.persistPresenceForRestart = vi.fn(async () => {});
  const started = vi.fn();
  // Reached after the reservation and the controller build: stop the real
  // hand from running so the test observes only whether it was started.
  engine.fetchTimeBankExtras = async () => {
    engine.handController.start = started;
    return new Map();
  };
  const recorded = vi.spyOn(engine, 'recordRecoveryEvent');

  // SQL's view: one row per permit, and at most one `reserved` per table.
  const db = new Map<string, Row>();
  const reply = (row: Row) => ({
    ...row,
    tournament_id: ids.tournament_id,
    generation: ids.lease_generation,
    table_id: ids.table_id,
    lifecycle: ids.lifecycle,
    custody_id: ids.custody_id,
  });
  let beginCalls = 0;
  let cancelCalls = 0;
  const rpc = vi.fn(async (name: string, input: Record<string, unknown>) => {
    const permitId = String(input.p_permit_id);
    if (name === 'fn_f06_begin_hand') {
      beginCalls += 1;
      const existing = db.get(permitId);
      if (existing) {
        return { data: { ...reply(existing), ok: existing.state === 'reserved' }, error: null };
      }
      if ([...db.values()].some((row) => row.state === 'reserved')) {
        return { data: { ok: false, reason: 'hand_permit_unresolved' }, error: null };
      }
      const row: Row = {
        permit_id: permitId,
        hand_number: String(input.p_hand_number),
        state: 'reserved',
        evidence_id: null,
      };
      db.set(permitId, row);
      // The begin committed, but its reply is lost on the way back.
      if (beginCalls === opts.loseBeginReply) return { data: null, error: new Error('lost reply') };
      return { data: { ...reply(row), ok: true }, error: null };
    }
    if (name === 'fn_f06_cancel_prepared_hand') {
      cancelCalls += 1;
      const row = db.get(permitId);
      if (!row || (row.state !== 'reserved' && row.evidence_id !== permitId))
        return { data: null, error: new Error('F06_PREPARED_NOT_RESERVED') };
      row.state = 'never_started';
      row.evidence_id = permitId;
      if (cancelCalls === opts.loseCancelReply)
        return { data: null, error: new Error('lost reply') };
      return { data: { ...reply(row), ok: true }, error: null };
    }
    throw new Error('unexpected rpc ' + name);
  });
  const allowStart = { value: true };
  engine.running = false;
  engine.installF06HandAdmission(
    (handNumber: string) =>
      new F06HandPermit(
        {
          tournament_id: ids.tournament_id,
          lease_generation: ids.lease_generation,
          table_id: ids.table_id,
          lifecycle: ids.lifecycle,
          permit_id: randomUUID(),
          hand_number: handNumber,
          custody_id: ids.custody_id,
        },
        rpc,
        () => true,
        () => allowStart.value
      )
  );
  engine.running = true;
  const reserved = () => [...db.values()].filter((row) => row.state === 'reserved');
  /** Deal, see the hand start, then let the fixture's hand wait go. */
  async function dealsTheNextHand() {
    const deal = engine.dealHand(seats);
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    engine.activeHandWaitRelease?.release('fixture_done');
    await deal;
  }
  return { engine, seats, db, rpc, started, recorded, allowStart, reserved, dealsTheNextHand };
}

describe('a deal attempt that ends without a hand releases its F06 permit', () => {
  it('a permit that refuses to start is released, and the table deals its next hand', async () => {
    const f = fixture();
    f.allowStart.value = false;
    await f.engine.dealHand(f.seats);
    expect(f.started).not.toHaveBeenCalled();
    // The reservation did not outlive the attempt that took it.
    expect(f.reserved()).toEqual([]);
    expect([...f.db.values()].map((row) => [row.hand_number, row.state])).toEqual([
      ['100', 'never_started'],
    ]);
    expect(f.engine.f06PermitPhase()).toBe('none');
    expect(f.recorded).toHaveBeenCalledWith(
      'unstarted_hand_permit_released',
      'start_failed:f06_start_unproven:permit=reserved'
    );

    // Before the fix this rejected with f06_prior_hand_unresolved, and kept
    // doing so on every retry until the 180s zombie reaper rebuilt the table.
    f.allowStart.value = true;
    await f.dealsTheNextHand();
    expect([...f.db.values()].map((row) => [row.hand_number, row.state])).toEqual([
      ['100', 'never_started'],
      ['101', 'reserved'],
    ]);
    expect(f.rpc.mock.calls.map(([name]) => name)).toEqual([
      'fn_f06_begin_hand',
      'fn_f06_cancel_prepared_hand',
      'fn_f06_begin_hand',
    ]);
  });

  it('a begin whose reply was lost is replayed, released, and the table deals on', async () => {
    const f = fixture({ loseBeginReply: 1 });
    await expect(f.engine.dealHand(f.seats)).rejects.toThrow('f06_permit_unproven');
    expect(f.started).not.toHaveBeenCalled();
    expect(f.reserved()).toEqual([]);
    expect(f.engine.f06PermitPhase()).toBe('none');
    expect(f.recorded).toHaveBeenCalledWith(
      'unstarted_hand_permit_released',
      'threw:f06_permit_unproven:permit=unknown'
    );

    await f.dealsTheNextHand();
    expect(f.rpc.mock.calls.map(([name]) => name)).toEqual([
      'fn_f06_begin_hand', // committed, reply lost
      'fn_f06_begin_hand', // exact replay of the same permit: reserved
      'fn_f06_cancel_prepared_hand',
      'fn_f06_begin_hand', // the next hand
    ]);
  });

  it('a release whose reply was lost is finished by the next attempt, which allocates fresh', async () => {
    const f = fixture({ loseCancelReply: 1 });
    f.allowStart.value = false;
    // The attempt's own outcome is what the loop sees; the lost release is
    // reported and the permit stays held for the next attempt to finish.
    await f.engine.dealHand(f.seats);
    expect(f.engine.f06PermitPhase()).toBe('terminated');
    expect(f.recorded).not.toHaveBeenCalledWith(
      'unstarted_hand_permit_released',
      expect.anything()
    );

    // The preparation made under the next rest was refused while the permit
    // stood. That refusal belongs to no attempt once the permit is released.
    f.engine.preparedF06AllocationError = new Error('f06_allocation_unproven');
    delete f.engine.takePreparedHandNumber;
    f.engine.allocateGlobalHandNumber = vi.fn(async () => 200);
    f.allowStart.value = true;
    await f.dealsTheNextHand();
    expect(f.engine.allocateGlobalHandNumber).toHaveBeenCalledOnce();
    expect([...f.db.values()].map((row) => [row.hand_number, row.state])).toEqual([
      ['100', 'never_started'],
      ['200', 'reserved'],
    ]);
  });

  it('a pause still releases through the maintenance path and records nothing new', async () => {
    const f = fixture();
    f.engine.fetchTimeBankExtras = async () => {
      f.engine.handController.start = f.started;
      f.engine.pauseForMaintenance(300_000);
      return new Map();
    };
    await f.engine.dealHand(f.seats);
    expect(f.started).not.toHaveBeenCalled();
    expect(f.reserved()).toEqual([]);
    expect(f.recorded).not.toHaveBeenCalledWith(
      'unstarted_hand_permit_released',
      expect.anything()
    );
  });

  it('a zombie kill names the loop step and the held permit, without seconds', async () => {
    const f = fixture();
    f.engine.setLoopPhase('next_hand_rest');
    expect(f.engine.describeStallForRecovery()).toBe('next_hand_rest:permit=none');
    f.allowStart.value = false;
    f.engine.resolveUnstartedF06Permit = async () => false; // the pre-fix wedge
    await f.engine.dealHand(f.seats);
    f.engine.setLoopPhase('load_next_hand_inputs');
    expect(f.engine.describeStallForRecovery()).toBe('load_next_hand_inputs:permit=reserved');
  });
});
