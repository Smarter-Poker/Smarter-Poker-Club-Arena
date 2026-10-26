/**
 * A REBUY WINDOW DOES NOT STARVE THE BALANCER (2026-10-26).
 *
 * Dan: "TABLES NEED TO ALWAYS BE BALANCED 100% OF THE TIME NO MATTER WHAT."
 *
 * In a rebuy or Free Buy event the bust stage used to END THE WHOLE SWEEP in
 * two ordinary situations: every busted player in the batch had bought back
 * in, or every one of them was still inside the 30-second rebuy decision
 * window. Busts arrive every few seconds in those events, so almost every
 * sweep stopped at the bust stage and balanceStage - the only caller of
 * checkTableBalance - was reached only in a quiet moment, in practice the :55
 * break. Production 2026-10-26: Diamond Arena Sunrise Bounty a5741141 sat 3-4
 * players apart from 13:00 to 13:28 UTC, its Midway twin was unbalanced in 98%
 * of 10-second samples, and 9 balance moves were made platform wide in 75
 * minutes.
 *
 * The law: both situations finish the bust stage and the pass goes on to
 * balance the tables. Nobody deciding a rebuy is eliminated or finished on,
 * and the window is re-read when it closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  frozen: false,
  from: vi.fn(),
  rpc: vi.fn(),
  reportError: vi.fn(),
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { from: fixture.from, rpc: fixture.rpc },
  maintenanceSupabase: { from: fixture.from, rpc: fixture.rpc },
}));
vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => fixture.frozen }));
vi.mock('../services/errorReporter.js', () => ({ reportError: fixture.reportError }));
vi.stubGlobal(
  'fetch',
  vi.fn(() => {
    throw new Error('Network disabled in fixture');
  })
);

const { TournamentManagerEliminations } = await import('./TournamentManagerEliminations.js');
const { TournamentSweepWorkCursor } = await import('./TournamentSweepWorkCursor.js');

const tournamentId = '00000000-0000-4000-8000-000000000001';
const busted = [
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000102',
  '00000000-0000-4000-8000-000000000103',
];

interface Request {
  table: string;
  columns: string | null;
  head: boolean;
  filters: Array<[string, string, unknown]>;
}

/** A PostgREST stand-in: a thenable builder answered on the next tick. */
function transport(answer: (request: Request) => Record<string, unknown>): void {
  const reply = (request: Request) =>
    Promise.resolve({ data: null, count: null, error: null, ...answer(request) });
  fixture.from.mockImplementation((table: string) => {
    const request: Request = { table, columns: null, head: false, filters: [] };
    const filter = (column: string, op: string, value: unknown): unknown => {
      request.filters.push([column, op, value]);
      return query;
    };
    const query: any = {
      select: (columns: string, options?: { head?: boolean }) => {
        request.columns = columns;
        request.head = options?.head === true;
        return query;
      },
      eq: (c: string, v: unknown) => filter(c, 'eq', v),
      lte: (c: string, v: unknown) => filter(c, 'lte', v),
      in: (c: string, v: unknown) => filter(c, 'in', v),
      is: (c: string, v: unknown) => filter(c, 'is', v),
      order: () => query,
      not: (c: string, op: string, v: unknown) => filter(c, `not.${op}`, v),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        reply(request).then(resolve, reject),
    };
    return query;
  });
  fixture.rpc.mockImplementation((fn: string, args: unknown) =>
    reply({ table: `rpc:${fn}`, columns: null, head: false, filters: [['args', 'eq', args]] })
  );
}

/** A 180-player rebuy event with three fresh busts, each in its rebuy window. */
function field(options: { windowOpen: boolean }) {
  const deadline = new Date(Date.now() + 25_000).toISOString();
  transport((r) => {
    if (r.table === 'tournament_players') {
      if (r.columns === 'user_id, chips')
        return { data: busted.map((user_id) => ({ user_id, chips: 0 })) };
      if (r.columns === 'position') return { data: [] };
      if (r.head) return { count: 180 };
    }
    if (r.table === 'tournament_knockout_candidates')
      return {
        data: busted.map((id, i) => ({
          id: `candidate-${i}`,
          eliminated_user_id: id,
          hand_number: 40 + i,
          stack_before: 1500,
          state: 'pending',
          rebuy_prompt_until: deadline,
        })),
        count: busted.length,
      };
    if (r.table === 'rpc:fn_open_tournament_rebuy_decisions')
      return {
        data: busted.map((user_id) => ({
          user_id,
          decision_open: options.windowOpen,
          rebuy_prompt_until: deadline,
        })),
      };
    if (r.table === 'wallet_transactions' || r.table === 'tournament_participant_funding_receipts')
      return { count: 0 };
    throw new Error(`Unexpected request ${r.table} ${r.columns}`);
  });
}

function manager(rebought: string[] = []) {
  const m = Object.create(TournamentManagerEliminations.prototype) as any;
  Object.assign(m, {
    pendingManagerWakes: new Map(),
    pendingManagerWakeGenerations: new Map(),
    running: true,
    isProcessingEliminations: false,
    tournamentId,
    tournamentCache: {
      variant: 'mtt',
      tournament_type: 'MTT',
      is_rebuy: true,
      is_reentry: false,
      prize_pool_finalized: false,
    },
    tournamentEntryRepricePending: false,
    eliminationSweepCursor: new TournamentSweepWorkCursor(),
    bustRefusalStreak: new Map(),
    resumeCommittedTerminalCleanup: vi.fn().mockResolvedValue(false),
    requestEliminationSweep: vi.fn(),
    requestUrgentEliminationSweepAfter: vi.fn(),
    tryTournamentRebuys: vi.fn(async () => ({
      rebought: new Set(rebought),
      deferredUntil: new Map(),
    })),
    eliminatePlayer: vi.fn(async () => true),
    maybeActivateMysteryBounty: vi.fn().mockResolvedValue(undefined),
    checkFinalTableDeal: vi.fn().mockResolvedValue(true),
    checkTableBalance: vi.fn().mockResolvedValue(undefined),
    finishTournament: vi.fn(),
    // One admission runs the bust stage through balancing, then yields.
    eliminationWorkBudgetExpired: () => m.eliminationSweepCursor.nextStage >= 6,
  });
  m.eliminationSweepCursor.advanceTo(1); // straight to the bust stage
  return m;
}

async function sweep(m: any): Promise<void> {
  const run = m.runEliminationSweep(new AbortController().signal);
  await vi.runAllTimersAsync();
  await run;
}

describe('a rebuy window does not starve the balancer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.frozen = false;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('every bust still deciding its rebuy: the tables are balanced in the same pass', async () => {
    field({ windowOpen: true });
    const m = manager();
    await sweep(m);

    expect(m.checkTableBalance).toHaveBeenCalledTimes(1);
    // Nobody deciding a rebuy is eliminated or finished on.
    expect(m.eliminatePlayer).not.toHaveBeenCalled();
    expect(m.finishTournament).not.toHaveBeenCalled();
    // The window is re-read when it closes.
    expect(m.requestUrgentEliminationSweepAfter).toHaveBeenCalled();
    expect(fixture.reportError).not.toHaveBeenCalled();
  });

  it('every bust bought back in: the tables are balanced in the same pass', async () => {
    field({ windowOpen: false });
    const m = manager(busted);
    await sweep(m);

    expect(m.checkTableBalance).toHaveBeenCalledTimes(1);
    expect(m.eliminatePlayer).not.toHaveBeenCalled();
    expect(m.finishTournament).not.toHaveBeenCalled();
    expect(fixture.reportError).not.toHaveBeenCalled();
  });

  it('a frozen platform still balances nothing', async () => {
    field({ windowOpen: true });
    fixture.frozen = true;
    const m = manager();
    await sweep(m);
    expect(m.checkTableBalance).not.toHaveBeenCalled();
    expect(m.eliminatePlayer).not.toHaveBeenCalled();
  });
});
