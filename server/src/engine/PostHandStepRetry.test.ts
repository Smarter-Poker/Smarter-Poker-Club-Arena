/**
 * A BOUNDARY IS NOT LOST TO ONE SLOW ROUND TRIP - drift incident bf4ef6e0.
 *
 * `[postHandTasks.step_failed.leave_pending] Error: supabase_timeout`, six
 * times, table 0a936714 hand #9459694. The step threw on the flat 15s client
 * deadline, was reported, was alerted, and was then abandoned - taking the
 * whole boundary with it: every departure the sweep would have made AND the
 * announced seat moves that run after them.
 *
 * The timeout is not a slow statement. `processLeavePending` rejects only on
 * its enumerate SELECT (a per-seat cash-out failure is swallowed by
 * `atomicCashout`'s own `onFailed`), and that SELECT measures 0.0ms mean /
 * 162.8ms max over 749,233 calls in pg_stat_statements. Fifteen seconds is a
 * round trip that never got a connection on a saturated database - a blink.
 *
 * Every assertion below except the two marked "unchanged" FAILS on
 * origin/main, where the first throw was the last word.
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

const id = '00000000-0000-0000-0000-0000000009a1';
const handId = '00000000-0000-0000-0000-0000001009a1';
const joinedAt = '2026-09-11T01:00:00.000Z';

/** The alert the incident is made of. */
const leavePendingAlerts = () =>
  (raiseFinancialAlert as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
    (call) => call[1] === 'postHandTasks.leave_pending_failed'
  );

function cashTable() {
  const engine = new ServerTableEngine(id) as any;
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
  engine.handCount = 9459694;
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
  engine.currentHandStartedAt = Date.now() - 1000;
  engine.lifecycleCanMutate = () => true;
  engine.hasCurrentEngineLeaseAuthority = () => true;
  engine.getEngineLeaseAuthority = () => ({
    verified: true,
    generation: 'generation',
    scope: 'cash',
  });
  engine.finishTerminalBoundaryPersistence = vi.fn();
  engine.announceEnvelopeResolvedAddOns = vi.fn().mockResolvedValue(undefined);
  engine.executePendingSeatMoves = vi.fn().mockResolvedValue(undefined);
  engine.wakeClusterGame = vi.fn();
  engine.killForRestart = vi.fn();
  engine.hub = { emitEvent: vi.fn(), sendToUser: vi.fn() };
  return { engine, players };
}

beforeEach(() => {
  mocks.commit.mockReset().mockResolvedValue({ handId, settlementCommitted: true });
  mocks.obligations.mockReset().mockResolvedValue({ ok: true, pending_addons: 0 });
  mocks.leaves.mockReset().mockResolvedValue([]);
  mocks.recount.mockReset().mockResolvedValue(2);
  (raiseFinancialAlert as unknown as ReturnType<typeof vi.fn>).mockClear();
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

describe('a transient leave_pending failure costs a retry, not the boundary', () => {
  it('re-runs the sweep after a supabase_timeout and raises no alert', async () => {
    const { engine, players } = cashTable();
    const unregister = vi.spyOn(engine.disconnectEngine, 'unregisterPlayer');
    mocks.leaves
      .mockRejectedValueOnce(new Error('supabase_timeout'))
      .mockResolvedValueOnce([{ userId: 'a', occupancyId: 'occupancy-a' }]);

    await engine.postHandTasks(players, 1);

    expect(mocks.leaves).toHaveBeenCalledTimes(2);
    expect(leavePendingAlerts()).toHaveLength(0);
    // The departure the first attempt lost is made on the second.
    expect(unregister).toHaveBeenCalledWith(id, 'a');
  });

  it('stops at the budget and says how many attempts it spent', async () => {
    const { engine, players } = cashTable();
    mocks.leaves.mockRejectedValue(new Error('supabase_timeout'));

    await engine.postHandTasks(players, 1);

    // One attempt plus the two-deep budget, and no more.
    expect(mocks.leaves).toHaveBeenCalledTimes(3);
    const alerts = leavePendingAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0][2]).toContain('after 3 attempts');
    expect(alerts[0][3]).toMatchObject({ attempts: 3, retry_budget: 2, hand_number: 9459694 });
  });

  it('does not retry a refusal the database meant, only a blink', async () => {
    const { engine, players } = cashTable();
    mocks.leaves.mockRejectedValue(new Error('Pending Departure Read Failed'));

    await engine.postHandTasks(players, 1);

    expect(mocks.leaves).toHaveBeenCalledTimes(1);
    expect(leavePendingAlerts()).toHaveLength(1);
  });

  it('leaves every other step exactly as it was: no budget, one attempt (unchanged)', async () => {
    const { engine, players } = cashTable();
    mocks.recount.mockRejectedValue(new Error('supabase_timeout'));

    await engine.postHandTasks(players, 1);

    expect(mocks.recount).toHaveBeenCalledTimes(1);
  });
});

describe('a seat that already left is torn down even when the boundary throws', () => {
  it('drains the departure the failed attempt had already made', async () => {
    const { engine, players } = cashTable();
    const unregister = vi.spyOn(engine.disconnectEngine, 'unregisterPlayer');
    const timeBank = vi.spyOn(engine.timeBankEngine, 'removePlayer');
    // The cash-out commits in its own transaction and is reported at once;
    // the sweep then fails on something after it.
    mocks.leaves
      .mockImplementationOnce(async (_t: string, _c: string, _l: unknown, onDeparted: any) => {
        onDeparted?.('a', 'occupancy-a');
        throw new Error('supabase_timeout');
      })
      .mockResolvedValueOnce([]);

    await engine.postHandTasks(players, 1);

    expect(mocks.leaves).toHaveBeenCalledTimes(2);
    expect(unregister).toHaveBeenCalledWith(id, 'a');
    expect(timeBank).toHaveBeenCalledWith(id, 'a');
  });

  it('keeps the registrations of a seat the same player has since retaken (unchanged)', async () => {
    const { engine, players } = cashTable();
    const unregister = vi.spyOn(engine.disconnectEngine, 'unregisterPlayer');
    mocks.leaves.mockResolvedValue([{ userId: 'a', occupancyId: 'a-previous-occupancy' }]);

    await engine.postHandTasks(players, 1);

    // 'a' is seated under occupancy-a, so the stale departure is not theirs.
    expect(unregister).not.toHaveBeenCalledWith(id, 'a');
  });
});
