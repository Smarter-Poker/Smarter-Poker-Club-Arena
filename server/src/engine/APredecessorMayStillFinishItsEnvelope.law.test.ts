/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: A PREDECESSOR MAY STILL FINISH ITS OWN ENVELOPE (2026-09-12)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * When the exact settlement transaction commits, it commits an immutable
 * post-commit envelope with it. `processHandPostCommitObligations` consumes
 * that envelope, and its contract says who is allowed to:
 *
 *   "This call deliberately carries no dealer lease: once the exact settlement
 *    transaction commits, completing its frozen obligations is authorized by
 *    the durable hand receipt, not by whichever process happens to resume it.
 *    The database row lock and completed receipt make concurrent live/worker
 *    calls converge exactly once."
 *
 * The engine's drain loop was nevertheless gated on `lifecycleCanMutate()` - a
 * DEALER-LEASE check. So on the single path the barrier exists for, a hand
 * committed by an engine whose twenty-second proof lapsed while the settlement
 * was in flight, the loop body never ran: `attempt` stayed 0 and the give-up
 * branch filed a CRITICAL financial alert reading
 *
 *   "...abandoned its durable post-commit envelope ... after 0 attempt(s)"
 *
 * an alarm about abandoning work this process had never once tried to do.
 * 935 of 949 of those alerts all-time carry `attempts: 0`. 414 landed in eight
 * hours on 2026-09-12, while the fleet's lease-renewal loop was dead and every
 * engine was losing its proof every twenty seconds.
 *
 * Safety was never what the lease was providing here, and nothing about it
 * changes: `fn_ca_process_hand_post_commit_obligations` takes a per-table
 * `pg_advisory_xact_lock`, reads the hand `FOR UPDATE`, and returns
 * `already_completed: true` for a receipt somebody else finished. What the
 * lease DOES still gate is process-local reflection, and that fence
 * (`postCommitStateCanReflect`) is untouched - pinned below, because the easy
 * over-correction is to take the lease out of both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  commit: vi.fn(),
  obligations: vi.fn(),
  leaves: vi.fn(),
  recount: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock('../services/supabase.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../services/supabase.js')),
  logHandHistory: mocks.commit,
  processHandPostCommitObligations: mocks.obligations,
  processLeavePending: mocks.leaves,
  reconcileTableSeatCount: mocks.recount,
}));
vi.mock('../services/financialAlerts.js', () => ({
  raiseFinancialAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (error: unknown) => String(error),
}));
import { ServerTableEngine } from './ServerTableEngine.js';
import { supabase } from '../services/supabase/client.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';

const id = '00000000-0000-0000-0000-00000000e9a1';
const handId = '00000000-0000-0000-0000-0000001e09a1';
const joinedAt = '2026-09-12T01:00:00.000Z';

const envelopeAlerts = () =>
  (raiseFinancialAlert as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
    (call) => call[1] === 'ServerTableEngine.post_commit_obligations_pending'
  );

/**
 * A cash table mid-settlement, with a controllable clock and a controllable
 * lease. `leaseAlive` starts true because the envelope is only bound at all
 * when the commit is made under a verified proof; the commit mock then drops it,
 * which is the production sequence exactly: the hand is accepted, and the
 * twenty-second proof lapses before the response is processed.
 */
function committingTable() {
  const engine = new ServerTableEngine(id) as any;
  const clock = { now: Date.UTC(2026, 8, 12, 4, 0, 0) };
  const state = { leaseAlive: true };

  engine.tableInfo = {
    id,
    club_id: 'club',
    tournament_id: null,
    cluster_id: null,
    game_variant: 'nlh',
    small_blind: 1,
    big_blind: 2,
    max_players: 6,
    min_buy_in: 20,
    max_buy_in: 200,
    rake_percent: 0,
    bbj_percent: 0,
  };
  const players = [
    {
      user_id: 'a',
      seat_id: 'seat-a',
      seat_joined_at: joinedAt,
      occupancy_id: 'occupancy-a',
      seat_number: 1,
      stack: 90,
      is_horse: false,
    },
    {
      user_id: 'b',
      seat_id: 'seat-b',
      seat_joined_at: joinedAt,
      occupancy_id: 'occupancy-b',
      seat_number: 2,
      stack: 110,
      is_horse: false,
    },
  ];
  engine.seatedPlayers = players;
  engine.handCount = 4212;
  engine.currentHandVariant = 'nlh';
  engine.currentHandPotSize = 20;
  engine.currentHandRake = 0;
  engine.currentHandBBJFee = 0;
  engine.currentHandInsuranceNet = 0;
  engine.currentHandContributions = new Map([
    ['a', 10],
    ['b', 10],
  ]);
  engine.currentHandDealtStacks = new Map([
    ['a', 100],
    ['b', 100],
  ]);
  engine.currentHandSeatGenerations = new Map(
    players.map((p) => [p.user_id, { seat_id: p.seat_id, seat_joined_at: p.seat_joined_at }])
  );
  engine.currentHandWinners = [{ userId: 'b', amount: 20 }];
  engine.currentHandStartedAt = clock.now - 1000;

  engine.lifecycleCanMutate = () => state.leaseAlive;
  engine.hasCurrentEngineLeaseAuthority = () => state.leaseAlive;
  engine.getEngineLeaseAuthority = () =>
    state.leaseAlive ? { verified: true, generation: 'generation', scope: 'cash' } : null;

  engine.finishTerminalBoundaryPersistence = vi.fn();
  engine.announceEnvelopeResolvedAddOns = vi.fn().mockResolvedValue(undefined);
  engine.executePendingSeatMoves = vi.fn().mockResolvedValue(undefined);
  engine.wakeClusterGame = vi.fn();
  engine.killForRestart = vi.fn();
  engine.hub = { emitEvent: vi.fn(), sendToUser: vi.fn() };

  /* A deterministic clock, so the handover budget is arithmetic rather than a
     five-second test. Every sleep the drain asks for moves it forward. */
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  engine.sleep = vi.fn(async (ms: number) => {
    clock.now += Math.max(0, ms);
  });

  return { engine, players, state, clock };
}

beforeEach(() => {
  mocks.commit.mockReset();
  mocks.obligations.mockReset().mockResolvedValue({ ok: true, pending_addons: 0 });
  mocks.leaves.mockReset().mockResolvedValue([]);
  mocks.recount.mockReset().mockResolvedValue(2);
  /* `restoreAllMocks` below strips a bare `vi.fn()`'s implementation, and the
     give-up branch calls `raiseFinancialAlert(...).catch(...)` - so it has to
     be re-established every test, not merely cleared. */
  (raiseFinancialAlert as unknown as ReturnType<typeof vi.fn>)
    .mockReset()
    .mockResolvedValue(undefined);
  vi.spyOn(supabase, 'rpc').mockImplementation(mocks.rpc);
  vi.spyOn(supabase, 'from').mockImplementation((() => {
    const chain: any = {
      select: vi.fn(),
      eq: vi.fn(),
      is: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    return chain;
  }) as any);
});
afterEach(() => {
  vi.restoreAllMocks();
  mocks.rpc.mockReset();
});

/** The hand is accepted, and the dealer's proof lapses on the way back. */
function commitThenLoseTheLease(state: { leaseAlive: boolean }) {
  mocks.commit.mockImplementation(async () => {
    state.leaseAlive = false;
    return { handId, settlementCommitted: true };
  });
}

describe('a predecessor may still finish its own envelope', () => {
  it('attempts the envelope at least once even though its dealer proof has lapsed', async () => {
    const { engine, players, state } = committingTable();
    commitThenLoseTheLease(state);

    await engine.postHandTasks(players, 1);

    /* THE WHOLE LAW. On the old gate this is 0 - the loop condition was false
       before its first iteration - and the give-up branch then alarmed about
       an envelope nobody had touched. */
    expect(mocks.obligations.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mocks.obligations).toHaveBeenCalledWith(handId);
    // It applied, so there is nothing to alarm about.
    expect(envelopeAlerts()).toHaveLength(0);
  });

  it('never raises the give-up alarm with zero attempts behind it', async () => {
    const { engine, players, state } = committingTable();
    commitThenLoseTheLease(state);
    mocks.obligations.mockRejectedValue(new Error('supabase_timeout'));

    await engine.postHandTasks(players, 1);

    const alerts = envelopeAlerts();
    expect(alerts).toHaveLength(1);
    const [, , message, context] = alerts[0];
    expect((context as { attempts: number }).attempts).toBeGreaterThanOrEqual(1);
    expect(message as string).not.toContain('after 0 attempt');
    expect(mocks.obligations.mock.calls.length).toBe(
      (context as { attempts: number }).attempts as number
    );
  });

  it('hands over to the projection worker at the budget instead of retrying forever', async () => {
    const { engine, players, state, clock } = committingTable();
    const startedAt = clock.now;
    commitThenLoseTheLease(state);
    mocks.obligations.mockRejectedValue(new Error('supabase_timeout'));

    await engine.postHandTasks(players, 1);

    /* Bounded, and bounded by the CLOCK rather than an attempt count: the
       backoff is the same 150ms-doubling ladder it has always been, and the
       last sleep is clipped to what is left of the handover. */
    expect(clock.now - startedAt).toBeLessThanOrEqual(5_000);
    expect(mocks.obligations.mock.calls.length).toBeGreaterThan(1);
    expect(mocks.obligations.mock.calls.length).toBeLessThan(40);
  });

  it('still reflects nothing locally once the proof is gone', async () => {
    const { engine, players, state } = committingTable();
    commitThenLoseTheLease(state);
    // The envelope applies; the engine must still not touch its own state.
    await engine.postHandTasks(players, 1);

    expect(mocks.obligations).toHaveBeenCalledTimes(1);
    /* `announceEnvelopeResolvedAddOns` and the stack refresh live behind
       `postCommitStateCanReflect`, which is re-read from lifecycleCanMutate
       AFTER the drain. Only the drain lost the lease term. */
    expect(engine.announceEnvelopeResolvedAddOns).not.toHaveBeenCalled();
    expect(mocks.leaves).not.toHaveBeenCalled();
  });

  it('leaves a healthy engine exactly as it was: one attempt, full reflection', async () => {
    const { engine, players } = committingTable();
    mocks.commit.mockResolvedValue({ handId, settlementCommitted: true });

    await engine.postHandTasks(players, 1);

    expect(mocks.obligations).toHaveBeenCalledTimes(1);
    expect(envelopeAlerts()).toHaveLength(0);
    expect(engine.announceEnvelopeResolvedAddOns).toHaveBeenCalled();
  });
});
