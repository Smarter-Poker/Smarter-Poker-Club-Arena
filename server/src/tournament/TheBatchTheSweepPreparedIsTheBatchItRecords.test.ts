/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BATCH THE SWEEP PREPARED IS THE BATCH IT RECORDS (2026-09-27)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Read on production at 22:44 UTC: the process-wide elimination scheduler had
 * 317 managers registered, 275 queued, all four slots busy and an oldest wait
 * of 333 s, so a large MTT was admitted about every six minutes. Inside each
 * admission the reads that prepare the bust batch spent the 5 s work budget,
 * the one-time grace bought exactly one committed finish, and the pass
 * yielded. Three freerolls (341, 347 and 309 entrants) accumulated 213, 96 and
 * 100 busted players still `status='playing'` at 0 chips; every one of those
 * rows held its roster chair, the balancer could place nobody, all 110 open
 * tables drained to one player each, and nothing dealt for hours.
 *
 * The transport below answers every request TRIP_MS after it is sent, so the
 * five reads that prepare the batch alone outrun the budget, exactly as on
 * the saturated loop. The elimination stand-in asks
 * `eliminationMutationAllowed()` first, as the real `eliminatePlayer` does,
 * and answers false when it is refused. It pins:
 *
 *   - a pass that reaches its mutations past the budget records EVERY bust of
 *     its prepared batch, in the ladder's order, and says so once;
 *   - the batch window closes with the pass: the clock refuses again after
 *     it, and the pass yields through the scheduler as before;
 *   - manager stop and the sweep's abort signal still end the pass at once;
 *   - a refusal from the door still ends the pass in hand order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  reportError: vi.fn(),
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { from: fixture.from, rpc: fixture.rpc },
  maintenanceSupabase: { from: fixture.from, rpc: fixture.rpc },
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: fixture.reportError }));
vi.stubGlobal(
  'fetch',
  vi.fn(() => {
    throw new Error('Network disabled in fixture');
  })
);

const { TournamentManagerEliminations } = await import('./TournamentManagerEliminations.js');
const { TournamentManagerBase } = await import('./TournamentManagerBase.js');
const { TournamentSweepWorkCursor } = await import('./TournamentSweepWorkCursor.js');

/**
 * Five preparatory reads at this trip cost 7.5 s, past the 5 s budget, before
 * the first mutation is attempted: the shape of the saturated loop.
 */
const TRIP_MS = 1_500;
const tournamentId = '00000000-0000-4000-8000-000000000001';
const bustedIds = [
  '00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-0000000000a2',
  '00000000-0000-4000-8000-0000000000a3',
];

interface Request {
  table: string;
  columns: string | null;
  head: boolean;
  filters: Array<[string, string, unknown]>;
}
interface Answer {
  data?: unknown;
  count?: number | null;
  error?: unknown;
}

const has = (request: Request, column: string, op: string, value?: unknown): boolean =>
  request.filters.some(
    ([c, o, v]) => c === column && o === op && (value === undefined || v === value)
  );

function transport(answer: (request: Request) => Answer): void {
  const reply = (request: Request): Promise<Answer> => {
    const response = { data: null, count: null, error: null, ...answer(request) };
    return new Promise((resolve) => setTimeout(() => resolve(response), TRIP_MS));
  };
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
      eq: (column: string, value: unknown) => filter(column, 'eq', value),
      lte: (column: string, value: unknown) => filter(column, 'lte', value),
      in: (column: string, value: unknown) => filter(column, 'in', value),
      is: (column: string, value: unknown) => filter(column, 'is', value),
      order: () => query,
      not: (column: string, op: string, value: unknown) => filter(column, `not.${op}`, value),
      then: (resolve: (value: Answer) => unknown, reject: (reason: unknown) => unknown) =>
        reply(request).then(resolve, reject),
    };
    return query;
  });
  fixture.rpc.mockImplementation((fn: string, args: unknown) =>
    reply({ table: `rpc:${fn}`, columns: null, head: false, filters: [['args', 'eq', args]] })
  );
}

/**
 * Four players left, three of them on zero, with the evidence the door needs.
 * `players` widens the field so the batch leaves more than one standing.
 */
function threeBustsOfFour(players = 4): void {
  transport((request) => {
    if (request.table === 'tournament_players') {
      if (request.columns === 'user_id, chips')
        return { data: bustedIds.map((user_id) => ({ user_id, chips: 0 })) };
      if (request.head && has(request, 'status', 'eq', 'playing')) return { count: players };
      if (request.columns === 'position') return { data: [] };
      if (request.head && has(request, 'position', 'is', null)) return { count: players };
      if (request.head) return { count: players };
    }
    if (request.table === 'tournament_knockout_candidates') {
      return {
        data: bustedIds.map((eliminated_user_id, index) => ({
          id: `00000000-0000-4000-8000-0000000000c${index + 1}`,
          eliminated_user_id,
          hand_number: 10 + index,
          stack_before: 1_500,
          state: 'pending',
        })),
        count: bustedIds.length,
      };
    }
    if (request.table === 'rpc:fn_open_tournament_rebuy_decisions') {
      return { data: bustedIds.map((user_id) => ({ user_id, decision_open: false })) };
    }
    if (request.table === 'wallet_transactions') return { count: 0 };
    throw new Error(`Unexpected request in bust-stage fixture: ${request.table}`);
  });
}

function bustStageManager(door?: (userId: string, place: number) => Promise<boolean>) {
  const eliminated: Array<{ userId: string; place: number; at: number }> = [];
  const manager = Object.create(TournamentManagerEliminations.prototype) as any;
  Object.assign(manager, {
    pendingManagerWakes: new Map(),
    pendingManagerWakeGenerations: new Map(),
    running: true,
    isProcessingEliminations: false,
    tournamentId,
    tournamentCache: {
      variant: 'freezeout',
      tournament_type: 'MTT',
      is_rebuy: false,
      is_reentry: false,
      prize_pool_finalized: true,
    },
    tournamentEntryRepricePending: false,
    eliminationSweepCursor: new TournamentSweepWorkCursor(),
    bustRefusalStreak: new Map(),
    resumeCommittedTerminalCleanup: vi.fn().mockResolvedValue(false),
    requestEliminationSweep: vi.fn(),
    requestUrgentEliminationSweepAfter: vi.fn(),
    // The real eliminatePlayer asks eliminationMutationAllowed() before its
    // first read and answers false when refused. So does this stand-in, and
    // it costs one round trip, so a batch of three outlasts any grace.
    eliminatePlayer: vi.fn(async (userId: string, place: number) => {
      if (!manager.eliminationMutationAllowed()) return false;
      if (door) return door(userId, place);
      await new Promise((resolve) => setTimeout(resolve, TRIP_MS));
      eliminated.push({ userId, place, at: Date.now() });
      return true;
    }),
  });
  manager.eliminationSweepCursor.advanceTo(1); // straight to the bust stage
  return { manager, eliminated };
}

async function sweep(manager: any, signal = new AbortController().signal): Promise<number> {
  const startedAt = Date.now();
  const run = manager.runEliminationSweep(signal);
  await vi.runAllTimersAsync();
  await run;
  return startedAt;
}

describe('the batch the sweep prepared is the batch it records', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('records every bust of the prepared batch when the reads alone spent the budget', async () => {
    threeBustsOfFour();
    const { manager, eliminated } = bustStageManager();
    const startedAt = await sweep(manager);

    // The reads outran the budget before the first mutation was attempted.
    expect(eliminated[0].at - startedAt).toBeGreaterThan(
      TournamentManagerBase.SWEEP_WORK_BUDGET_MS
    );
    // ...and the whole batch was recorded anyway, worst place first, in hand order.
    expect(eliminated.map((e) => [e.userId, e.place])).toEqual([
      [bustedIds[0], 4],
      [bustedIds[1], 3],
      [bustedIds[2], 2],
    ]);
    expect(fixture.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'Tournament.bust_batch_recorded_past_budget'
    );
    expect(fixture.reportError).toHaveBeenCalledTimes(1);
  });

  it('closes the batch window with the pass and yields through the scheduler', async () => {
    // Five players, so two are left standing: a live field, which yields to
    // the budget after its bust stage. A batch that leaves one standing goes
    // on to its finish instead (aDecidedGameIsPaidInTheAdmissionThatRecordsItsLastBust).
    threeBustsOfFour(5);
    const { manager, eliminated } = bustStageManager();
    // Observe the window from inside the sweep: the sweep's own finally clears
    // the deadline afterwards, so only the moment of closing can say whether
    // the clock got its vote back.
    const closings: Array<{ at: number; expired: boolean; allowed: boolean }> = [];
    const close = TournamentManagerBase.prototype['closeEliminationMutationBatch'];
    manager.closeEliminationMutationBatch = function (this: any) {
      close.call(this);
      closings.push({
        at: Date.now(),
        expired: this.eliminationWorkBudgetExpired(),
        allowed: this.eliminationMutationAllowed(),
      });
    };
    await sweep(manager);

    expect(eliminated).toHaveLength(3);
    // Reset at admission (deadline not yet expired), then closed after the batch.
    expect(closings).toHaveLength(2);
    expect(closings[0].expired).toBe(false);
    expect(closings[1].at).toBeGreaterThanOrEqual(eliminated[2].at);
    // The deadline had long passed: the moment the window closed the clock
    // refused again, exactly as for every other stage.
    expect(closings[1].expired).toBe(true);
    expect(closings[1].allowed).toBe(false);
    expect(manager.eliminationMutationBatchIsOpen()).toBe(false);
    // The pass recorded what it prepared and handed the slot back: the cursor
    // moved past the bust stage and the continuation was re-armed.
    expect(manager.eliminationSweepCursor.nextStage).toBe(2);
    expect(manager.requestUrgentEliminationSweepAfter).toHaveBeenCalledWith(
      TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS
    );
  });

  it('a stopped manager still ends the pass at once, inside the batch', async () => {
    threeBustsOfFour();
    const { manager, eliminated } = bustStageManager(async (userId, place) => {
      eliminated.push({ userId, place, at: Date.now() });
      manager.running = false;
      return true;
    });
    await sweep(manager);
    expect(eliminated).toHaveLength(1);
    expect(manager.eliminationMutationBatchIsOpen()).toBe(false);
  });

  it('an aborted sweep still ends the pass at once, inside the batch', async () => {
    threeBustsOfFour();
    const controller = new AbortController();
    const { manager, eliminated } = bustStageManager(async (userId, place) => {
      eliminated.push({ userId, place, at: Date.now() });
      controller.abort();
      return true;
    });
    await sweep(manager, controller.signal);
    expect(eliminated).toHaveLength(1);
    expect(manager.eliminationMutationBatchIsOpen()).toBe(false);
  });

  it('a refusal from the door still ends the pass in hand order', async () => {
    threeBustsOfFour();
    const { manager, eliminated } = bustStageManager(async (userId, place) => {
      if (userId === bustedIds[1]) return false; // a CAS miss on the second bust
      eliminated.push({ userId, place, at: Date.now() });
      return true;
    });
    await sweep(manager);
    // The first was recorded; the refusal ended the pass before the third, so
    // the ladder is rebuilt from persisted places before anybody else is placed.
    expect(eliminated.map((e) => e.userId)).toEqual([bustedIds[0]]);
    expect(manager.bustRefusalStreak.get(bustedIds[1])).toBe(1);
    expect(manager.eliminationMutationBatchIsOpen()).toBe(false);
  });
});
