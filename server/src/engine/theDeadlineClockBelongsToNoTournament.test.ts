import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { DeadlineScheduler } from './DeadlineScheduler.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  bindToProcessRoot,
  bindTournamentDataAuthority,
  currentTournamentDataAuthority,
  runWithTournamentDataAuthority,
} from '../services/supabase/dataActorContext.js';
import { recordHorseHandReviews, type HorseReviewInput } from '../services/HorseHandReview.js';

/**
 * The horse review writes go to a stand-in client that notes whose authority
 * the retention prune went out under. Nothing else in this file reaches the
 * client: the scheduler and the context module never import it.
 */
const horseDb = vi.hoisted(() => ({ pruneWentOutAs: [] as unknown[] }));
vi.mock('../services/supabase/client.js', async () => {
  const { currentTournamentDataAuthority: authorityNow } =
    await import('../services/supabase/dataActorContext.js');
  return {
    supabase: {
      from: () => ({
        upsert: (rows: Array<{ horse_user_id: string }>) => ({
          select: async () => ({
            data: rows.map((row) => ({ horse_user_id: row.horse_user_id })),
            error: null,
          }),
        }),
      }),
      rpc: async (name: string) => {
        if (name === 'sp_prune_horse_hand_reviews') horseDb.pruneWentOutAs.push(authorityNow());
        return { data: null, error: null };
      },
    },
  };
});

/**
 * 2026-09-11, the 01:55 restart (404948b3). The deadline scheduler is ONE
 * setInterval for the process, started lazily by the first PreciseActionTimer
 * - that is, by the first ServerTableEngine constructed. A tournament's table
 * engines are constructed inside its manager's data-authority context, and a
 * Node timer inherits the async context it was created in. A tournament table
 * won the boot race, so the interval - and every callback for every table on
 * the box - ran inside that one tournament's authority. Every other
 * tournament table's bound heartbeat and turn callbacks threw "Tournament data
 * authority cannot be rebound inside another manager context": 3,367 callback
 * throws and 3,389 zombie kills across 561 tables in thirty minutes.
 *
 * These start a real scheduler, on real timers, inside tournament A's
 * authority - the losing boot order - and check what its callbacks see.
 */

const A = {
  tournamentId: 'aaaaaaaa-0000-4000-8000-00000000000a',
  leaseGeneration: 'aaaaaaaa-0000-4000-8000-0000000000a1',
};
const B = {
  tournamentId: 'bbbbbbbb-0000-4000-8000-00000000000b',
  leaseGeneration: 'bbbbbbbb-0000-4000-8000-0000000000b1',
};
const C = {
  tournamentId: 'cccccccc-0000-4000-8000-00000000000c',
  leaseGeneration: 'cccccccc-0000-4000-8000-0000000000c1',
};

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The scheduler reports a throwing callback through reportError, which always
 * writes console.error first. (A vi.mock of the reporter would not reach it:
 * the test setup loads the scheduler module before any test file's mocks.)
 */
const callbackThrows = (spy: MockInstance): number =>
  spy.mock.calls.filter((args) => String(args[0]).includes('DeadlineScheduler.callback_threw'))
    .length;

describe('the deadline clock belongs to no tournament', () => {
  let scheduler: DeadlineScheduler | null = null;
  let consoleError: MockInstance;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    scheduler?.stop();
    scheduler = null;
    consoleError.mockRestore();
  });

  it("runs another tournament's bound callback though the clock was started inside one", async () => {
    scheduler = new DeadlineScheduler({ tickMs: 5 });
    runWithTournamentDataAuthority(A, () => scheduler!.start());

    const seen: Array<string | null> = [];
    const tableOfB = bindTournamentDataAuthority(B, function heartbeat() {
      seen.push(currentTournamentDataAuthority()?.tournamentId ?? null);
    });
    scheduler.schedule({
      tableId: 'table-of-b',
      eventId: 'heartbeat_check',
      deadlineMs: Date.now(),
      callback: () => tableOfB(),
    });
    await settle(80);

    expect(callbackThrows(consoleError)).toBe(0);
    expect(seen).toEqual([B.tournamentId]);
  });

  it("never lends a tournament's authority to a cash table's callback", async () => {
    scheduler = new DeadlineScheduler({ tickMs: 5 });
    runWithTournamentDataAuthority(A, () => scheduler!.start());

    const seen: unknown[] = [];
    scheduler.schedule({
      tableId: 'cash-table',
      eventId: 'heartbeat_check',
      deadlineMs: Date.now(),
      callback: () => {
        seen.push(currentTournamentDataAuthority());
      },
    });
    await settle(80);

    expect(seen).toEqual([null]);
  });

  it("still runs a tournament's own bound callback in its own authority", async () => {
    scheduler = new DeadlineScheduler({ tickMs: 5 });
    runWithTournamentDataAuthority(A, () => scheduler!.start());

    const seen: Array<string | null> = [];
    const tableOfA = bindTournamentDataAuthority(A, function heartbeat() {
      seen.push(currentTournamentDataAuthority()?.tournamentId ?? null);
    });
    scheduler.schedule({
      tableId: 'table-of-a',
      eventId: 'heartbeat_check',
      deadlineMs: Date.now(),
      callback: () => tableOfA(),
    });
    await settle(80);

    expect(callbackThrows(consoleError)).toBe(0);
    expect(seen).toEqual([A.tournamentId]);
  });
});

/**
 * One settled hand at a table of tournament A in which a horse lost 25bb: the
 * first flagged hand of the process, so it is the one that arms the prune.
 */
const flaggedHandOfA = (): HorseReviewInput => ({
  handId: 'hand-of-a',
  tableId: 'table-of-a',
  tournamentId: A.tournamentId,
  gameVariant: 'nlh',
  bigBlind: 2,
  playedAt: '2026-09-11T02:04:46.000Z',
  holeCardsAll: new Map([
    ['horse-1', { seat: 1, cards: [] }],
    ['human-1', { seat: 2, cards: [] }],
  ]),
  contributions: new Map([
    ['horse-1', 50],
    ['human-1', 50],
  ]),
  winners: [{ userId: 'human-1', amount: 100 }],
  actions: [],
  roster: [
    { userId: 'horse-1', isHorse: true },
    { userId: 'human-1', isHorse: false },
  ],
});

/**
 * THE REST OF THE SWEEP (2026-09-11). #4225 bound the scheduler and the horse
 * nets flush and called the flush the one other process-wide timer started
 * from an engine path. It was not: the horse retention prune, armed by the
 * first hand that flags a horse, still sent its DELETE as that hand's
 * tournament. Every timer in server/src was then read. Three do the process's
 * own database work and can be armed from a tournament's path; they are pinned
 * below. Every other one belongs to one table, tournament, connection or job
 * and keeps that authority; or starts at boot, or captures the process owner
 * when it starts; or runs in a worker thread; or can inherit an authority
 * without ever using it - the elimination scheduler enters each tournament's
 * own registration context before calling it, and the equity pool's
 * replacement worker only hands out jobs.
 */
describe("the process's own database work never goes out as a tournament", () => {
  it('bindToProcessRoot runs outside the authority of whoever called it', async () => {
    const seen: unknown[] = [];
    const tick = bindToProcessRoot(() => {
      seen.push(currentTournamentDataAuthority());
    });
    // Started from inside tournament A, the way a settled hand or the first
    // table engine would start it...
    let handle: ReturnType<typeof setInterval> | null = null;
    runWithTournamentDataAuthority(A, () => {
      handle = setInterval(tick, 5);
    });
    await settle(40);
    clearInterval(handle!);
    // ...and every tick still sees no tournament at all.
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((s) => JSON.stringify(s)))).toEqual(new Set(['null']));
  });

  it('stays outside every authority when a tournament calls it synchronously', async () => {
    // Node 22's AsyncLocalStorage - production's and CI's - writes a run()'s
    // store onto the resource executing at the time, and inside a root-bound
    // callback that is the process root itself. So a root-bound helper that a
    // table of B reached synchronously, inside a root-bound tick, ran as B.
    // (Node 24 keeps the store in a separate frame and never did this; run
    // with --no-async-context-frame to see the Node 22 behaviour there.)
    const seen: Record<string, unknown> = {};
    const helper = bindToProcessRoot(() => {
      seen.helper = currentTournamentDataAuthority();
      try {
        runWithTournamentDataAuthority(C, () => {
          seen.helperRunsC = currentTournamentDataAuthority()?.tournamentId ?? null;
        });
      } catch (error) {
        seen.helperRunsC = (error as Error).message;
      }
      seen.helperAfterC = currentTournamentDataAuthority();
      setTimeout(() => {
        seen.timerTheHelperStarted = currentTournamentDataAuthority();
      }, 1);
    });
    const tableOfB = bindTournamentDataAuthority(B, function turnClock() {
      helper();
      seen.tableOfBAfterwards = currentTournamentDataAuthority()?.tournamentId ?? null;
    });
    const tick = bindToProcessRoot(() => {
      tableOfB();
      seen.tickAfterwards = currentTournamentDataAuthority();
    });
    // Armed inside tournament A, the losing boot order again.
    runWithTournamentDataAuthority(A, () => {
      setTimeout(tick, 1);
    });
    await vi.waitFor(() => expect(seen).toHaveProperty('timerTheHelperStarted'));

    expect(seen).toEqual({
      helper: null,
      helperRunsC: C.tournamentId,
      helperAfterC: null,
      timerTheHelperStarted: null,
      tableOfBAfterwards: B.tournamentId,
      tickAfterwards: null,
    });
  });

  it('the horse retention prune, armed by a tournament hand, goes out as the process', async () => {
    // Real Node timers: keeping the context a timer was created in is what
    // Node's timers do and a fake clock does not - it fires every callback
    // from inside advanceTimersByTime, in the test's own context, and passed
    // on the old code. Only the prune's ten minutes are shortened, inside the
    // arming call itself, so the real timer is still created in the
    // continuation of tournament A's hand.
    vi.stubEnv('HORSE_HAND_REVIEW_ENABLED', 'true');
    vi.stubEnv('HORSE_NET_ROLLUP_ENABLED', 'false'); // leaves no nets interval behind
    const realSetTimeout = globalThis.setTimeout;
    const tenMinutes = 10 * 60 * 1000;
    const shortenThePrune = ((cb: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) =>
      realSetTimeout(cb, ms === tenMinutes ? 1 : ms, ...a)) as unknown as typeof setTimeout;
    const tenMinutesIsOneMs = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(shortenThePrune);
    try {
      await runWithTournamentDataAuthority(A, () => recordHorseHandReviews(flaggedHandOfA()));
    } finally {
      tenMinutesIsOneMs.mockRestore();
      vi.unstubAllEnvs();
    }
    await vi.waitFor(() => expect(horseDb.pruneWentOutAs).toHaveLength(1));

    expect(horseDb.pruneWentOutAs).toEqual([null]);
  });

  it('the horse nets flush, started by the first settled hand, is bound to the process', () => {
    const src = readFileSync(resolve(__dirname, '../services/HorseHandReview.ts'), 'utf8');
    expect(src).toMatch(/netFlushTimer = setInterval\(\s*bindToProcessRoot\(/);
  });

  it('the deadline scheduler binds every tick to the process', () => {
    const src = readFileSync(resolve(__dirname, './DeadlineScheduler.ts'), 'utf8');
    expect(src).toMatch(/this\.setIntervalFn\(\s*bindToProcessRoot\(\(\) => this\.tick\(\)\)/);
  });
});
