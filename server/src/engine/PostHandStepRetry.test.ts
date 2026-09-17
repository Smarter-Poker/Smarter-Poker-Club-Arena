/**
 * A BOUNDARY IS NOT LOST TO ONE SLOW ROUND TRIP - drift incident bf4ef6e0.
 *
 * `[postHandTasks.step_failed.leave_pending] Error: supabase_timeout`, six
 * times, table 0a936714 hand #9459694. The step threw on the flat 15s client
 * deadline, was reported, was alerted, and was then abandoned - taking the
 * whole boundary with it: every departure the sweep would have made AND the
 * announced seat moves that run after them.
 *
 * A generic timeout alone does not identify the failed suboperation or prove
 * database saturation. The three later received originals 37375/37377/37389
 * lack that attribution; the diagnostic tests below harden future evidence.
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
import {
  ServerTableEngineBase,
  _setEngineLeaseMonotonicNowForTests,
  type EngineLeaseAuthority,
} from './ServerTableEngineBase.js';
import {
  LeavePendingAttempt,
  type LeavePendingOperation,
} from '../observability/LeavePendingDiagnostic.js';
import { supabase } from '../services/supabase/client.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { reportError } from '../services/errorReporter.js';

const id = '00000000-0000-0000-0000-0000000009a1';
const handId = '00000000-0000-0000-0000-0000001009a1';
const joinedAt = '2026-09-11T01:00:00.000Z';

/** The alert the incident is made of. */
const leavePendingAlerts = () =>
  (raiseFinancialAlert as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
    (call) => call[1] === 'postHandTasks.leave_pending_failed'
  );

function cashTable(authority?: EngineLeaseAuthority) {
  const engine = new ServerTableEngine(id, authority) as any;
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
  vi.mocked(reportError).mockReset();
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
  _setEngineLeaseMonotonicNowForTests();
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
    const evidence = alerts[0][3].leave_pending_diagnostic_v1;
    expect(evidence).toMatchObject({
      table_id: id,
      hand_number: 9459694,
      persistence_generation: 1,
    });
    expect(evidence.attempts.map((a: any) => a.retry_decision)).toEqual([
      'retry_scheduled',
      'retry_scheduled',
      'budget_exhausted',
    ]);
    expect(evidence.attempts[2]).toMatchObject({
      transient_checked: false,
      lifecycle_checked: false,
    });
  });

  it('does not retry a refusal the database meant, only a blink', async () => {
    const { engine, players } = cashTable();
    mocks.leaves.mockRejectedValue(new Error('Pending Departure Read Failed'));

    await engine.postHandTasks(players, 1);

    expect(mocks.leaves).toHaveBeenCalledTimes(1);
    expect(leavePendingAlerts()).toHaveLength(1);
    expect(leavePendingAlerts()[0][3].leave_pending_diagnostic_v1.attempts[0]).toMatchObject({
      retry_decision: 'non_transient',
      transient_checked: true,
      lifecycle_checked: false,
    });
  });

  it('leaves every other step exactly as it was: no budget, one attempt (unchanged)', async () => {
    const { engine, players } = cashTable();
    mocks.recount.mockRejectedValue(new Error('supabase_timeout'));

    await engine.postHandTasks(players, 1);

    expect(mocks.recount).toHaveBeenCalledTimes(1);
    const other = vi
      .mocked(raiseFinancialAlert)
      .mock.calls.find((call) => call[1] === 'postHandTasks.table_unlock_failed');
    expect(other?.[3]).not.toHaveProperty('leave_pending_diagnostic_v1');
  });
});

describe('leave failure evidence preserves the actual retry and reporting decisions', () => {
  it.each(['budget_exhausted', 'non_transient'] as const)(
    'does not add predicate calls on the %s short circuit',
    async (decision) => {
      const { engine, players } = cashTable();
      engine.sleep = vi.fn().mockResolvedValue(undefined);
      const lifecycle = vi.spyOn(engine, 'lifecycleCanMutate');
      const classifier = vi.spyOn(ServerTableEngineBase as any, 'isTransientDbError');
      const reject = LeavePendingAttempt.prototype.rejected;
      let counts: [number, number] | undefined;
      vi.spyOn(LeavePendingAttempt.prototype, 'rejected').mockImplementation(function (
        this: LeavePendingAttempt,
        error: unknown
      ) {
        reject.call(this, error);
        if (this.attempt === (decision === 'budget_exhausted' ? 3 : 1)) {
          counts = [lifecycle.mock.calls.length, classifier.mock.calls.length];
        }
      });
      let observed = false;
      vi.mocked(reportError).mockImplementation((_error, context) => {
        if (context !== 'postHandTasks.step_failed.leave_pending') return;
        observed = true;
        expect(counts).toBeDefined();
        expect(lifecycle.mock.calls.length).toBe(counts![0]);
        expect(classifier.mock.calls.length).toBe(
          counts![1] + (decision === 'non_transient' ? 1 : 0)
        );
      });
      mocks.leaves.mockRejectedValue(
        new Error(decision === 'budget_exhausted' ? 'supabase_timeout' : 'read refused')
      );
      await engine.postHandTasks(players, 19);
      expect(observed).toBe(true);
      expect(leavePendingAlerts()).toHaveLength(1);
      expect(classifier).toHaveBeenCalledTimes(decision === 'budget_exhausted' ? 2 : 1);
    }
  );
  it('captures the query phase and original message before the existing reporter mutation', async () => {
    const { engine, players } = cashTable();
    engine.sleep = vi.fn().mockResolvedValue(undefined);
    const classify = vi.spyOn(ServerTableEngineBase as any, 'isTransientDbError');
    const error = new Error('supabase_timeout');
    mocks.leaves.mockImplementation(
      async (
        _t: string,
        _c: string,
        _l: unknown,
        _d: unknown,
        diagnostic: LeavePendingOperation
      ) => {
        diagnostic.phase('table_seats_query');
        throw error;
      }
    );
    vi.mocked(reportError).mockImplementation((err, context) => {
      if (context === 'postHandTasks.step_failed.leave_pending' && err instanceof Error) {
        err.message = '[existing reporter] ' + err.message;
      }
    });
    await engine.postHandTasks(players, 17);
    const alert = leavePendingAlerts()[0][3];
    expect(alert.error).toContain('[existing reporter] supabase_timeout');
    expect(alert.leave_pending_diagnostic_v1).toMatchObject({
      table_id: id,
      hand_number: 9459694,
      persistence_generation: 17,
      attempts: [1, 2, 3].map((attempt) => ({
        attempt,
        departures: { phase: 'table_seats_query', error: { message: 'supabase_timeout' } },
      })),
    });
    expect(classify).toHaveBeenCalledTimes(2); // budget short-circuits the third
    expect(classify.mock.calls.every(([value]) => value === error)).toBe(true);
    expect(engine.sleep.mock.calls).toEqual([[250], [1000]]);
  });

  it('records actual lease expiry as the reason a third attempt cannot run', async () => {
    let monotonic = 0;
    _setEngineLeaseMonotonicNowForTests(() => monotonic);
    const generation = 'aaaaaaaa-0000-4000-8000-000000000017';
    const { engine, players } = cashTable({
      scope: 'cash',
      verified: true,
      generation,
      proofDeadlineMonotonicMs: 20_000,
    });
    // Restore actual instance authority and terminal transitions, not a fake
    // false-returning lifecycle predicate. The transport remains mocked.
    delete engine.lifecycleCanMutate;
    delete engine.hasCurrentEngineLeaseAuthority;
    delete engine.getEngineLeaseAuthority;
    delete engine.killForRestart;
    expect(engine.claimProcessOwnership()).toBe(true);
    engine.running = true;
    engine.sleep = vi.fn().mockResolvedValue(undefined);
    engine.flushSnapshot = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;
    mocks.leaves.mockImplementation(async () => {
      if (++attempts === 2) monotonic = 20_001;
      throw new Error('supabase_timeout');
    });
    try {
      await engine.postHandTasks(players, 18);
      expect(mocks.leaves).toHaveBeenCalledTimes(2);
      expect(engine.sleep.mock.calls).toEqual([[250]]);
      const alert = leavePendingAlerts()[0][3];
      expect(alert).toMatchObject({ attempts: 2, retry_budget: 2 });
      expect(alert.leave_pending_diagnostic_v1.attempts[1]).toMatchObject({
        attempt: 2,
        retry_decision: 'lifecycle_denied',
        guards: {
          runStep_retry: {
            allowed: false,
            state: {
              terminal: true,
              running: false,
              lease_generation: generation,
              lease_expired: true,
              first_terminal: { reason: 'cash_lease_proof_expired' },
            },
          },
        },
      });
    } finally {
      await engine.stop();
    }
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
