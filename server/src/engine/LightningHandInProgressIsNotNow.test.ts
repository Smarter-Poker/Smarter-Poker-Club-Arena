/**
 * LIGHTNING_HAND_IN_PROGRESS IS "NOT NOW" (Lightning 2.0 Phase 5 remediation,
 * 2026-09-25).
 *
 * The database refuses any change to a seat's stack or `left_at` while the
 * player is in a live Lightning hand, with a message carrying the token
 * LIGHTNING_HAND_IN_PROGRESS. The refusing trigger rolls the whole
 * transaction back, so nothing moved. Every engine path that cashes a seat
 * out or lands chips on it must treat that as "retry on the next pass":
 *
 *   - never fatal (no engine kill, no error report for an expected state),
 *   - never dropping the leave (the durable `leave_pending` request stays),
 *   - never paying twice (every retry goes through the same one-transaction,
 *     occupancy-keyed cash-out, and a deferred seat is never reported gone).
 *
 * Driven end to end over a mocked database: the REAL atomicCashout,
 * processLeavePending, atomicCashoutVoluntary, requestSeatDeparture and
 * leaveTable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TABLE = 'eeeeeeee-1111-4222-8333-444444444444';
const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'aaaaaaaa-0000-4000-8000-000000000002';
const OCC_A = 'bbbbbbbb-0000-4000-8000-000000000001';
const OCC_B = 'bbbbbbbb-0000-4000-8000-000000000002';

const db = vi.hoisted(() => ({
  /** userId -> what fn_cashout_seat_occupancy answers next. */
  cashout: new Map<string, 'lightning' | 'ok' | 'boom'>(),
  pending: [] as Array<{ user_id: string; seat_number: number; occupancy_id: string }>,
  departures: [] as Array<Record<string, unknown>>,
  cashoutCalls: [] as Array<Record<string, unknown>>,
  resolver: 'lightning' as 'lightning' | 'ok',
  addon: 'lightning' as 'lightning' | 'ok',
}));
const reportError = vi.hoisted(() => vi.fn());

const LIGHTNING_ERROR = {
  code: 'P0001',
  message: 'LIGHTNING_HAND_IN_PROGRESS: seat is in a live Lightning hand',
};

vi.mock('../services/supabase/client.js', () => {
  const rpc = vi.fn(async (fn: string, args: Record<string, any>) => {
    if (fn === 'fn_cashout_seat_occupancy') {
      db.cashoutCalls.push(args);
      const verdict = db.cashout.get(args.p_user_id) ?? 'ok';
      if (verdict === 'lightning') return { data: null, error: LIGHTNING_ERROR };
      if (verdict === 'boom') return { data: null, error: { message: 'connection reset' } };
      return {
        data: {
          ok: true,
          stack: 150,
          credited: true,
          seat_number: args.p_seat_number,
          occupancy_id: args.p_occupancy_id,
          user_id: args.p_user_id,
          table_id: args.p_table_id,
          idempotency_key: 'cashout:occupancy:' + args.p_occupancy_id,
          tournament_table: false,
        },
        error: null,
      };
    }
    if (fn === 'fn_request_seat_departure') {
      db.departures.push(args);
      return {
        data: {
          accepted: true,
          user_id: args.p_user_id,
          table_id: args.p_table_id,
          seat_number: args.p_seat_number,
          occupancy_id: args.p_occupancy_id,
          leave_mode: args.p_leave_mode,
          tournament_table: false,
        },
        error: null,
      };
    }
    if (fn === 'fn_ca_resolve_unbound_pending_addons') {
      if (db.resolver === 'lightning') return { data: null, error: LIGHTNING_ERROR };
      return {
        data: {
          ok: true,
          table_id: args.p_table_id,
          lease_generation: args.p_lease_generation,
          resolved: 0,
          rows: [],
        },
        error: null,
      };
    }
    if (fn === 'atomic_table_addon') {
      if (db.addon === 'lightning') return { data: null, error: LIGHTNING_ERROR };
      return { data: null, error: null };
    }
    if (fn === 'fn_offer_open_seat')
      return { data: { ok: false, reason: 'nobody_waiting' }, error: null };
    return { data: [], error: null };
  });
  const from = (table: string) => {
    const chain: any = {
      select: () => chain,
      // Presence writes (a sit-out persisted to table_seats) resolve quietly.
      update: () => chain,
      upsert: async () => ({ data: null, error: null }),
      then: (ok: (v: unknown) => unknown) => ok({ data: null, error: null }),
      eq: () => chain,
      is: () =>
        table === 'table_seats'
          ? Promise.resolve({ data: db.pending.map((p) => ({ ...p })), error: null })
          : Promise.resolve({ data: [], error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
    };
    return chain;
  };
  return { supabase: { rpc, from }, maintenanceSupabase: { rpc, from } };
});
vi.mock('../services/errorReporter.js', () => ({ reportError }));
vi.mock('../services/financialPush.js', () => ({ pushFinancialUpdate: vi.fn() }));

const { atomicCashout, processLeavePending } = await import('../services/supabase/seats.js');
const { atomicCashoutVoluntary } = await import('../services/supabase/cashSessions.js');
const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { deadlineScheduler } = await import('./DeadlineScheduler.js');

beforeEach(() => {
  db.cashout.clear();
  db.pending = [];
  db.departures = [];
  db.cashoutCalls = [];
  db.resolver = 'lightning';
  db.addon = 'lightning';
  reportError.mockClear();
});
afterEach(() => {
  deadlineScheduler.cancelAll(TABLE);
  vi.restoreAllMocks();
});

describe('the cash-out door hears LIGHTNING_HAND_IN_PROGRESS as "not now"', () => {
  it('atomicCashout calls the deferral callback, returns 0, and never reports a failure', async () => {
    db.cashout.set(ALICE, 'lightning');
    const onFailed = vi.fn();
    const onLightningHandInProgress = vi.fn();
    const paid = await atomicCashout(ALICE, TABLE, 1, {
      occupancyId: OCC_A,
      leaveMode: 'voluntary',
      onFailed,
      onLightningHandInProgress,
    });
    expect(paid).toBe(0);
    expect(onLightningHandInProgress).toHaveBeenCalledOnce();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('a caller that has not opted in still gets the old "seat preserved" failure, not a throw into the loop', async () => {
    db.cashout.set(ALICE, 'lightning');
    const onFailed = vi.fn();
    await atomicCashout(ALICE, TABLE, 1, { occupancyId: OCC_A, leaveMode: 'forced', onFailed });
    expect(onFailed).toHaveBeenCalledOnce();
  });

  it('atomicCashoutVoluntary names it, distinct from a failure', async () => {
    db.cashout.set(ALICE, 'lightning');
    await expect(atomicCashoutVoluntary(ALICE, TABLE, 1, OCC_A)).resolves.toEqual({
      ok: false,
      code: 'LIGHTNING_HAND_IN_PROGRESS',
    });
  });

  it('the leave_pending sweep defers that seat, pays the others, and reports only who left', async () => {
    db.pending = [
      { user_id: ALICE, seat_number: 1, occupancy_id: OCC_A },
      { user_id: BOB, seat_number: 2, occupancy_id: OCC_B },
    ];
    db.cashout.set(ALICE, 'lightning');
    const departed = vi.fn();
    const left = await processLeavePending(TABLE, 'club', undefined, departed);
    expect(left).toEqual([{ userId: BOB, occupancyId: OCC_B }]);
    expect(departed).toHaveBeenCalledTimes(1);
    expect(departed).toHaveBeenCalledWith(BOB, OCC_B);
    // One cash-out attempt per seat: nothing retried inside the pass.
    expect(db.cashoutCalls.map((c) => c.p_user_id)).toEqual([ALICE, BOB]);
  });
});

function tableWith(
  ...seats: Array<{ user_id: string; occupancy_id: string; seat_number: number }>
) {
  const e = new ServerTableEngine(TABLE) as any;
  e.tableInfo = {
    id: TABLE,
    club_id: 'club',
    small_blind: 1,
    big_blind: 2,
    game_variant: 'nlh',
    max_players: 9,
    game_type: 'cash',
    min_buy_in: 80,
    max_buy_in: 400,
    cluster_id: 'game-1',
  };
  e.running = true;
  e.isCurrentEngine = () => true;
  e.handController = null;
  e.seatedPlayers = seats.map((s) => ({
    ...s,
    username: s.user_id.slice(-1),
    stack: 150,
    is_horse: s.user_id === BOB, // a horse leaves by the same door (CLAUDE.md 10.5)
  }));
  e.hub = { emitEvent: vi.fn(), publish: vi.fn() };
  e.broadcastCurrentState = vi.fn(async () => undefined);
  return e;
}

describe('a player leaving while their chips are in a Lightning hand', () => {
  for (const [who, id, occ] of [
    ['a human', ALICE, OCC_A],
    ['a horse', BOB, OCC_B],
  ] as const) {
    it(`${who}: the leave is queued durably, the client is told so, and it completes on a later pass - paid once`, async () => {
      const e = tableWith({ user_id: id, occupancy_id: occ, seat_number: 1 });
      db.cashout.set(id, 'lightning');

      const answer = await e.leaveTable(id, { occupancyId: occ, seatNumber: 1 });
      expect(answer).toEqual({
        success: true,
        immediate: false,
        code: 'LIGHTNING_HAND_IN_PROGRESS',
      });
      // Durable: the same request the mid-hand leave writes.
      expect(db.departures).toHaveLength(1);
      expect(db.departures[0]).toMatchObject({ p_user_id: id, p_leave_mode: 'voluntary' });
      // Not dropped and not torn down: still seated, marked leaving, out of the deal.
      expect(e.seatedPlayers.map((p: any) => p.user_id)).toEqual([id]);
      expect(e.seatedPlayers[0].leave_pending).toBe(true);
      expect(e.disconnectEngine.isSittingOut(TABLE, id)).toBe(true);
      expect(reportError).not.toHaveBeenCalled();

      // A retry pass while the Lightning hand is still live: still deferred.
      db.pending = [{ user_id: id, seat_number: 1, occupancy_id: occ }];
      await e.sweepQueuedLeaves();
      expect(e.seatedPlayers.map((p: any) => p.user_id)).toEqual([id]);

      // The Lightning hand ends; the next pass completes the leave.
      db.cashout.set(id, 'ok');
      await e.sweepQueuedLeaves();
      expect(e.seatedPlayers).toEqual([]);
      // Three attempts in all (refused, refused, paid), each the same
      // occupancy-keyed transaction - exactly one of them paid.
      expect(db.cashoutCalls).toHaveLength(3);
      expect(new Set(db.cashoutCalls.map((c) => c.p_occupancy_id))).toEqual(new Set([occ]));
      // Nothing left to sweep: a table with nobody leaving asks nothing.
      db.pending = [];
      await e.sweepQueuedLeaves();
      expect(db.cashoutCalls).toHaveLength(3);
      e.preciseTimer?.dispose?.();
    });
  }

  it('an admin removal behind a Lightning hand is queued on the authority already recorded', async () => {
    const e = tableWith({ user_id: ALICE, occupancy_id: OCC_A, seat_number: 1 });
    db.cashout.set(ALICE, 'lightning');
    const answer = await e.leaveTable(ALICE, { forced: true });
    expect(answer).toMatchObject({
      success: true,
      immediate: false,
      code: 'LIGHTNING_HAND_IN_PROGRESS',
    });
    expect(db.departures).toHaveLength(1);
    expect(db.departures[0]).toMatchObject({ p_leave_mode: 'forced' });
    expect(e.seatedPlayers).toHaveLength(1);
    e.preciseTimer?.dispose?.();
  });

  it('a quiet table with no leaver makes no departure read at all', async () => {
    const e = tableWith({ user_id: ALICE, occupancy_id: OCC_A, seat_number: 1 });
    const { supabase } = await import('../services/supabase/client.js');
    const fromSpy = vi.spyOn(supabase as any, 'from');
    await e.sweepQueuedLeaves();
    expect(fromSpy).not.toHaveBeenCalled();
    e.preciseTimer?.dispose?.();
  });
});

describe('chips landing on a seat whose player is in a Lightning hand', () => {
  it('the pending add-on resolver waits and retries; it never kills the engine', async () => {
    const e = tableWith({ user_id: ALICE, occupancy_id: OCC_A, seat_number: 1 });
    e.getEngineLeaseAuthority = () => ({ verified: true, scope: 'cash', generation: 'gen-1' });
    e.hasCurrentEngineLeaseAuthority = () => true;
    const kill = vi.spyOn(e, 'killForRestart');
    e.pendingAddOnSweepNeeded = true;

    await e.processPendingAddOns(e.seatedPlayers);
    expect(kill).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    expect(e.pendingAddOnSweepNeeded, 'the sweep stays requested for the next pass').toBe(true);
    expect(e.isRunning()).toBe(true);
    e.preciseTimer?.dispose?.();
  });

  it('a between-hands add-on is refused plainly: nothing taken, no error report, not asked twice', async () => {
    const e = tableWith({ user_id: ALICE, occupancy_id: OCC_A, seat_number: 1 });
    const { supabase } = await import('../services/supabase/client.js');
    const rpcSpy = vi.spyOn(supabase as any, 'rpc');
    const answer = await e.addChips(ALICE, 50);
    expect(answer).toEqual({
      success: false,
      error: 'Your Chips Are In A Lightning Hand. Add Chips When It Finishes.',
    });
    expect(rpcSpy.mock.calls.filter((c) => c[0] === 'atomic_table_addon')).toHaveLength(1);
    expect(reportError).not.toHaveBeenCalled();
    expect(e.seatedPlayers[0].stack).toBe(150);
    e.preciseTimer?.dispose?.();
  });
});
