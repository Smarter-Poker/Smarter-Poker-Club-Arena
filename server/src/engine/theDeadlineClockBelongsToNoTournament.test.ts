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

describe('every lazily-started process-wide timer runs as the process', () => {
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

  it('the horse nets flush, started by the first settled hand, is bound to the process', () => {
    const src = readFileSync(resolve(__dirname, '../services/HorseHandReview.ts'), 'utf8');
    expect(src).toMatch(/netFlushTimer = setInterval\(\s*bindToProcessRoot\(/);
  });

  it('the deadline scheduler binds every tick to the process', () => {
    const src = readFileSync(resolve(__dirname, './DeadlineScheduler.ts'), 'utf8');
    expect(src).toMatch(/this\.setIntervalFn\(\s*bindToProcessRoot\(\(\) => this\.tick\(\)\)/);
  });
});
