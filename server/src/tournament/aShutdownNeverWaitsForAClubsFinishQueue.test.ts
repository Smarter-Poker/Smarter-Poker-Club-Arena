import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

/**
 * A SHUTDOWN NEVER WAITS FOR A CLUB'S WHOLE FINISH QUEUE (2026-10-19).
 *
 * From 15:43 to 21:42 UTC on 2026-10-19, 992 decided events of ONE club could
 * not finish (the direct-owner fee incident). Every refused finish went
 * through that club's process-local finish lane, held the club's F lock for
 * seconds, and re-queued at the tail for each of its five attempts. A manager's
 * stop() joins its in-flight elimination sweep - the finish waiting in that
 * lane - so graceful shutdown waited for the queue, passed its 40 s deadline,
 * exited without releasing its leases, and the engine release at every break
 * from 16:55 to 20:55 ran out of cutover time and rolled back.
 *
 * These tests load a few hundred such finishes into one club's lane and shut
 * down part-way through. The shutdown must be bounded by the ONE finish that
 * club has in the database, not by the board.
 */

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), verify: vi.fn() }));

vi.mock('../services/supabase.js', () => ({
  supabase: { rpc: mocks.rpc },
  maintenanceSupabase: { rpc: mocks.rpc },
}));
vi.mock('./completionSettlementReceipt.js', () => ({
  verifyTournamentCompletionReceipt: mocks.verify,
  parseLegacyFeeCustodyOrigin: vi.fn(),
}));

import {
  closeTerminalFinishLanes,
  noteTerminalFinishClub,
  openTerminalFinishLanes,
  requestTournamentTerminalReceipt,
  TerminalSettlementNotSentError,
  TerminalSettlementOutcomeUnknownError,
  TerminalSettlementRefusedError,
} from './terminalSettlementRpc.js';

const CLUB = 'fade0000-0000-0000-0000-000000000001';
const STUCK_EVENTS = 300;
/** Measured on production 2026-10-03: a finish holds F(scope) for 2-12 s. */
const FINISH_HOLDS_LOCK_MS = 2_000;
/** index.ts SHUTDOWN_DEADLINE_MS. */
const SHUTDOWN_DEADLINE_MS = 40_000;

const eventId = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const WINNER = '00000000-0000-4000-9000-000000000001';

/** The refusal the incident produced: a database rollback, not deterministic. */
const ACCOUNTING_REFUSAL = {
  code: 'P0001',
  message: 'tournament fee net plan refused: accounting_terms_not_observed',
};

let completeCalls = 0;
let resolverCalls = 0;

function databaseHoldsTheLane(): void {
  mocks.rpc.mockImplementation(async (name: string, args: { p_tournament_id: string }) => {
    if (name === 'fn_complete_tournament_terminal') {
      completeCalls++;
      await new Promise((resolve) => setTimeout(resolve, FINISH_HOLDS_LOCK_MS));
      return { data: null, error: ACCOUNTING_REFUSAL };
    }
    if (name === 'fn_resolve_tournament_terminal_outcome') {
      resolverCalls++;
      await new Promise((resolve) => setTimeout(resolve, FINISH_HOLDS_LOCK_MS));
      return {
        data: {
          ok: true,
          tournament_id: args.p_tournament_id,
          mode: 'places',
          terminal_committed: false,
          definitively_not_committed: true,
          status: 'RUNNING',
          receipt: null,
        },
        error: null,
      };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
}

type Outcome = { settled: boolean; error?: unknown };

function finishEveryDecidedEvent(): Outcome[] {
  const outcomes: Outcome[] = [];
  for (let n = 1; n <= STUCK_EVENTS; n++) {
    const id = eventId(n);
    noteTerminalFinishClub(id, CLUB);
    const outcome: Outcome = { settled: false };
    outcomes.push(outcome);
    requestTournamentTerminalReceipt(id, 'places', WINNER).then(
      () => {
        outcome.settled = true;
      },
      (error) => {
        outcome.settled = true;
        outcome.error = error;
      }
    );
  }
  return outcomes;
}

describe('a shutdown never waits for a club finish queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    openTerminalFinishLanes();
    completeCalls = 0;
    resolverCalls = 0;
    mocks.rpc.mockReset();
    mocks.verify.mockReset();
    databaseHoldsTheLane();
  });

  afterEach(async () => {
    // Whatever a test left queued is refused and drained before the next one.
    closeTerminalFinishLanes();
    await vi.advanceTimersByTimeAsync(60_000);
    openTerminalFinishLanes();
    vi.useRealTimers();
  });

  it('the queue it used to wait for is longer than the shutdown deadline', async () => {
    const outcomes = finishEveryDecidedEvent();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);
    // One finish per club at a time: in 40 s the lane sends about twenty.
    expect(completeCalls).toBeLessThanOrEqual(SHUTDOWN_DEADLINE_MS / FINISH_HOLDS_LOCK_MS + 1);
    expect(outcomes.filter((o) => !o.settled).length).toBeGreaterThan(STUCK_EVENTS - 25);
  });

  it('shutdown sends nothing still queued and settles every request inside one finish', async () => {
    const outcomes = finishEveryDecidedEvent();
    // One finish is in the database when the shutdown signal arrives.
    await vi.advanceTimersByTimeAsync(FINISH_HOLDS_LOCK_MS / 2);
    expect(completeCalls).toBe(1);

    const shutdownBeganAt = Date.now();
    closeTerminalFinishLanes();
    await vi.advanceTimersByTimeAsync(FINISH_HOLDS_LOCK_MS);

    const pending = outcomes.filter((o) => !o.settled).length;
    expect(pending).toBe(0);
    expect(Date.now() - shutdownBeganAt).toBeLessThan(SHUTDOWN_DEADLINE_MS);

    // The one finish already in the database was answered, never abandoned;
    // nothing else was sent, and nobody queued behind the terminal lock.
    expect(completeCalls).toBe(1);
    expect(resolverCalls).toBe(0);
    for (const outcome of outcomes) {
      expect(outcome.error).toBeInstanceOf(TerminalSettlementNotSentError);
      // A proven refusal: callers release the finish guard, never fence.
      expect(outcome.error).toBeInstanceOf(TerminalSettlementRefusedError);
      expect(outcome.error).not.toBeInstanceOf(TerminalSettlementOutcomeUnknownError);
    }
  });

  it('an attempt whose outcome the database did not state still goes to the resolver', async () => {
    mocks.rpc.mockImplementation(async (name: string, args: { p_tournament_id: string }) => {
      if (name === 'fn_complete_tournament_terminal') {
        completeCalls++;
        await new Promise((resolve) => setTimeout(resolve, FINISH_HOLDS_LOCK_MS));
        // A lost response: no SQLSTATE, so it may have committed.
        return { data: null, error: { message: 'supabase_timeout' } };
      }
      resolverCalls++;
      return {
        data: {
          ok: true,
          tournament_id: args.p_tournament_id,
          mode: 'places',
          terminal_committed: false,
          definitively_not_committed: true,
          status: 'RUNNING',
          receipt: null,
        },
        error: null,
      };
    });
    const id = eventId(1);
    noteTerminalFinishClub(id, CLUB);
    const result = requestTournamentTerminalReceipt(id, 'places', WINNER).catch((e) => e);
    await vi.advanceTimersByTimeAsync(FINISH_HOLDS_LOCK_MS / 2);
    closeTerminalFinishLanes();
    await vi.advanceTimersByTimeAsync(FINISH_HOLDS_LOCK_MS);
    const error = await result;
    expect(completeCalls).toBe(1);
    expect(resolverCalls).toBe(1);
    // The resolver proved the miss, so this is the ordinary refusal, not the
    // shutdown one: the unknown attempt was resolved, never assumed.
    expect(error).toBeInstanceOf(TerminalSettlementRefusedError);
    expect(error).not.toBeInstanceOf(TerminalSettlementNotSentError);
  });

  it('a server that starts again sends its finishes', async () => {
    closeTerminalFinishLanes();
    openTerminalFinishLanes();
    const id = eventId(1);
    noteTerminalFinishClub(id, CLUB);
    const result = requestTournamentTerminalReceipt(id, 'places', WINNER, {
      attempts: 1,
    }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(2 * FINISH_HOLDS_LOCK_MS);
    await result;
    expect(completeCalls).toBe(1);
  });

  it('GameServer closes the lanes before its first shutdown await and opens them on start', () => {
    const source = readFileSync(new URL('../GameServer.ts', import.meta.url), 'utf8');
    const stop = sliceMethod(source, 'stop(): Promise<void> {');
    const closeAt = stop.indexOf('closeTerminalFinishLanes();');
    expect(closeAt).toBeGreaterThan(0);
    // stop() is synchronous up to performStop; the close precedes it.
    expect(closeAt).toBeLessThan(stop.indexOf('this.performStop('));
    const start = sliceMethod(source, 'start(): Promise<void> {');
    expect(start).toContain('openTerminalFinishLanes();');
  });
});
