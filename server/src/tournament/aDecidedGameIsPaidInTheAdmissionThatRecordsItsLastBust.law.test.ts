/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DECIDED GAME IS PAID IN THE ADMISSION THAT RECORDS ITS LAST BUST
 *  (2026-10-02)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Production, 2026-10-02 16:17-16:32 UTC, engine 1-b4b20b86: 62 Spins and
 * Sit & Gos were RUNNING with one player left. Of the 896 completed in the
 * hour before, the elimination sweep that recorded the final bust waited a
 * median 221 s for a scheduler slot, and 410 of them (46%) were then sent to
 * the back of the queue by the five-second work budget between the bust stage
 * and the finish stage, and paid a median 549 s after that. Spin 9ed8878f
 * dealt its last hand at 16:18:14, recorded both busts at 16:24:46 and paid
 * its winner at 16:31:44. The work itself took four seconds.
 *
 * The law: once a field is decided (the deciding hand left one stack, or this
 * pass recorded the bust that left one player standing), the sweep does not
 * yield to the work budget before its finish stage. A live field still yields
 * exactly as before. The scheduler half (decided slots of its own) is pinned
 * in aDecidedGameIsNotWaitingBehindLiveOnes.law.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManagerEliminations } from './TournamentManagerEliminations.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { TournamentSweepWorkCursor } from './TournamentSweepWorkCursor.js';
import { supabase } from '../services/supabase.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const TOURNAMENT = 'aaaaaaaa-0000-4000-8000-000000000002';

/** One PostgREST builder whose every filter returns itself and which resolves to `result`. */
function answer(result: Record<string, unknown>) {
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'lte', 'in', 'order', 'not', 'is', 'limit', 'gte']) {
    query[method] = () => query;
  }
  query.maybeSingle = () => Promise.resolve(result);
  query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return query;
}

function spendTheBudget(): void {
  vi.setSystemTime(Date.now() + TournamentManagerBase.SWEEP_WORK_BUDGET_MS + 1);
}

function manager(extra: Record<string, unknown> = {}) {
  const m = Object.create(TournamentManagerEliminations.prototype) as any;
  Object.assign(m, {
    tournamentId: TOURNAMENT,
    running: true,
    tournamentCache: { variant: 'spin', tournament_type: 'SPIN' },
    pendingManagerWakes: new Map(),
    pendingManagerWakeGenerations: new Map(),
    bustRefusalStreak: new Map(),
    eliminationSweepCursor: new TournamentSweepWorkCursor(),
    tableEngines: new Map(),
    resumeCommittedTerminalCleanup: vi.fn().mockResolvedValue(false),
    refreshChipCapInputs: vi.fn().mockResolvedValue(undefined),
    recoverPendingBountyObligations: vi.fn().mockResolvedValue(true),
    checkFinalTableDeal: vi.fn().mockResolvedValue(true),
    checkSatelliteQualifierCompletion: vi.fn().mockResolvedValue('legacy'),
    tryTournamentRebuys: vi.fn().mockResolvedValue({ rebought: new Set(), answered: new Set() }),
    requestEliminationSweep: vi.fn(),
    requestUrgentEliminationSweepAfter: vi.fn(),
    declareFieldDecided: vi.fn(),
    finishTournament: vi.fn(async function (this: any) {
      // A paid event stops its manager; the sweep ends there.
      this.tournamentFinished = true;
      this.running = false;
    }),
    ...extra,
  });
  return m;
}

/**
 * The reads of a bust stage that records one bust out of `playing` live
 * players, followed (when the finish stage is reached) by its count and
 * winner reads.
 */
function oneBustOutOf(playing: number) {
  const from = vi
    .spyOn(supabase, 'from')
    .mockReturnValueOnce(answer({ data: [{ user_id: 'loser', chips: 0 }], error: null }) as never)
    .mockReturnValueOnce(answer({ count: playing, error: null }) as never)
    .mockReturnValueOnce(answer({ data: [], count: 0, error: null }) as never)
    .mockReturnValueOnce(answer({ data: [], error: null }) as never)
    .mockReturnValueOnce(answer({ count: playing, error: null }) as never)
    .mockReturnValueOnce(answer({ count: playing - 1, error: null }) as never)
    .mockReturnValueOnce(answer({ data: { user_id: 'winner' }, error: null }) as never);
  vi.spyOn(supabase, 'rpc').mockResolvedValue({
    data: [{ user_id: 'loser', decision_open: false }],
    error: null,
  } as never);
  return from;
}

describe('a decided field runs from its last bust to its finish in one admission', () => {
  it('the bust that leaves one player standing is followed by the finish, past the budget', async () => {
    vi.useFakeTimers();
    oneBustOutOf(2);
    const m = manager({
      // Recording the bust spends the whole budget, as it does on a slow database.
      eliminatePlayer: vi.fn(async () => {
        spendTheBudget();
        return true;
      }),
    });

    await m.runEliminationSweep(new AbortController().signal);

    expect(m.eliminatePlayer).toHaveBeenCalledWith('loser', 2);
    expect(m.declareFieldDecided).toHaveBeenCalledOnce();
    expect(m.finishTournament).toHaveBeenCalledWith('winner');
    expect(m.requestEliminationSweep).not.toHaveBeenCalled();
  });

  it('a field the deciding hand declared decided is not sent back to the queue by the budget', async () => {
    vi.useFakeTimers();
    vi.spyOn(supabase, 'from')
      .mockReturnValueOnce(answer({ data: [], error: null }) as never)
      .mockReturnValueOnce(answer({ count: 1, error: null }) as never)
      .mockReturnValueOnce(answer({ data: { user_id: 'winner' }, error: null }) as never);
    const m = manager({ fieldDecidedDeclared: true });
    m.refreshChipCapInputs.mockImplementation(async () => spendTheBudget());

    await m.runEliminationSweep(new AbortController().signal);

    expect(m.finishTournament).toHaveBeenCalledWith('winner');
    expect(m.requestEliminationSweep).not.toHaveBeenCalled();
  });

  it('a live field still yields to the budget after its bust stage', async () => {
    vi.useFakeTimers();
    const from = oneBustOutOf(3);
    const m = manager({
      eliminatePlayer: vi.fn(async () => {
        spendTheBudget();
        return true;
      }),
    });

    await m.runEliminationSweep(new AbortController().signal);

    expect(m.eliminatePlayer).toHaveBeenCalledWith('loser', 3);
    expect(m.declareFieldDecided).not.toHaveBeenCalled();
    expect(m.finishTournament).not.toHaveBeenCalled();
    expect(m.requestEliminationSweep).toHaveBeenCalledOnce();
    expect(m.eliminationSweepCursor.nextStage).toBe(2);
    // Five bust-stage reads; the finish stage never asked for its count.
    expect(from).toHaveBeenCalledTimes(5);
  });
});
