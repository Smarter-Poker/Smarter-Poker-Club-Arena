/**
 * TABLE WATCHDOG — behavioural proof.
 *
 * The watchdog is the last line of defence against a frozen table, and on
 * 2026-08-15 it shipped BROKEN in three separate ways that no test would have
 * caught because it had no tests at all:
 *
 *   1. `markProgress()` ran unconditionally after a forced action, and it zeroes
 *      `watchdogTrips`. When the force was REJECTED the ladder reset every
 *      cycle, so Tier 3 (kill + rebuild) was unreachable — the table logged a
 *      stall every 45s forever and never recovered.
 *   2. Tier 1 armed a clock but never reset the stall window, so Tier 2
 *      force-folded the player 10s later, 7s before that clock would expire.
 *   3. A parked all-in runout still carried a live `currentPlayerSeat`, so the
 *      watchdog armed an action clock on an ALL-IN player and forced check/folds
 *      from them.
 *
 * A recovery mechanism with no tests is not a recovery mechanism. Every tier is
 * asserted here, including the escalation ladder actually reaching the kill.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STALL_MS = 45_000;
const IDLE_MS = 90_000;

interface Harness {
  engine: ServerTableEngine;
  calls: {
    performAction: Array<[number, string]>;
    startTimer: Array<[string, number, number]>;
    killed: string[];
    continueRunout: number;
  };
  setStale(ms: number): void;
  /** Park the dealing loop in `phase`, entered `ms` ago. */
  setLoopPhase(phase: string, ms: number): void;
  state: any;
}

/**
 * Build an engine with every collaborator stubbed. We drive the real
 * runTableWatchdog against it — no re-implementation of the logic under test.
 */
function harness(opts: {
  seats?: Array<{ seat: number; stack: number; allIn?: boolean; folded?: boolean }>;
  currentSeat?: number;
  hasClock?: boolean;
  /** performAction outcome. 'reject' = the stale-pointer case that broke Tier 3. */
  action?: 'accept' | 'reject';
  noHand?: boolean;
}): Harness {
  const seats = opts.seats ?? [
    { seat: 1, stack: 1000 },
    { seat: 2, stack: 1000 },
  ];
  const calls = {
    performAction: [] as Array<[number, string]>,
    startTimer: [] as Array<[string, number, number]>,
    killed: [] as string[],
    continueRunout: 0,
  };

  const state = {
    currentPlayerSeat: opts.currentSeat ?? 1,
    currentBet: 100,
    stage: 'flop',
    players: seats.map((s) => ({
      seat: s.seat,
      user_id: `u${s.seat}`,
      bet: 0,
      stack: s.stack,
      is_folded: !!s.folded,
      is_all_in: !!s.allIn,
      is_sitting_out: false,
    })),
  };

  const engine = new ServerTableEngine(TABLE);
  const e = engine as any;

  e.running = true;
  // The harness drives the protected watchdog without start(); explicitly
  // model the process-ownership CAS which start() must win in production.
  e.isCurrentEngine = () => true;
  e.handCount = 7;
  e.tableInfo = { action_time_seconds: 15, game_variant: 'nlh' };
  e.seatedPlayers = seats.map((s) => ({
    seat_number: s.seat,
    user_id: `u${s.seat}`,
    username: `p${s.seat}`,
    stack: s.stack,
    is_horse: true,
  }));
  e.waitingForBB = new Set<string>();
  e.disconnectEngine = { isSittingOut: () => false };
  e.timeBankEngine = { playerActed: () => {} };
  e.preciseTimer = {
    hasTimer: () => opts.hasClock ?? false,
    clearTable: () => {},
    startTimer: () => {},
    cancelTimer: () => {},
  };
  e.handController = opts.noHand
    ? null
    : {
        getState: () => state,
        performAction: (seat: number, a: string) => {
          calls.performAction.push([seat, a]);
          return opts.action === 'reject' ? false : true;
        },
        continueRunout: () => {
          calls.continueRunout++;
        },
      };
  // Observe the recovery levers instead of letting them touch real timers.
  e.startTurnTimer = (uid: string, seat: number, secs: number) => {
    calls.startTimer.push([uid, seat, secs]);
  };
  e.killForRestart = (reason: string) => {
    calls.killed.push(reason);
    e.running = false;
  };

  return {
    engine,
    calls,
    state,
    setStale: (ms: number) => {
      e.lastProgressAtMs = Date.now() - ms;
    },
    setLoopPhase: (phase: string, ms: number) => {
      e.loopPhase = phase;
      e.loopPhaseSinceMs = Date.now() - ms;
    },
  };
}

const run = (h: Harness) => (h.engine as any).runTableWatchdog();
const trips = (h: Harness) => (h.engine as any).watchdogTrips;

describe('table watchdog - when it must stay out of the way', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('never kills a table paused by design, no matter how stale (hand-for-hand)', () => {
    // Regression: a hand-for-hand pause longer than the idle window used to
    // read as "dealing loop dead" — the engine was killed, the rebuild lost
    // the pause flag, and the table dealt a hand INTO hand-for-hand.
    const h = harness({ noHand: true });
    (h.engine as any).handForHandPaused = true;
    (h.engine as any).pausedSinceMs = Date.now() - 10 * 60_000;
    h.setStale(10 * 60_000);
    run(h);
    run(h);
    run(h);
    expect(h.calls.killed).toEqual([]);
    expect(trips(h)).toBe(0);
    expect((h.engine as any).isRunning()).toBe(true);
  });

  it('resumeDealing clears the pause so the watchdog re-engages', () => {
    const h = harness({ noHand: true });
    (h.engine as any).handForHandPaused = true;
    (h.engine as any).pausedSinceMs = Date.now() - 10 * 60_000;
    h.setStale(10 * 60_000);
    run(h);
    expect(trips(h)).toBe(0);
    (h.engine as any).handForHandResolve = null;
    h.engine.resumeDealing();
    expect((h.engine as any).isPausedByDesign()).toBe(false);
    /**
     * 2026-09-05: this used to `run(h)` here and expect a trip immediately,
     * on the ten minutes of staleness accrued DURING the pause. That is the
     * defect this commit fixes, and the test was pinning it.
     *
     * `releasePauseGate()` now credits the progress clock when a pause ends,
     * because time a table was TOLD not to deal is not time it failed to deal
     * (§13 rule 4, "deadlines are thawed, not burned"). Measured: 49.5% of
     * every stalled table-second in a 24-hour day was the maintenance break
     * being charged to the fleet the instant it lifted, and that reading is
     * what sp-autoheal restarted production on five times.
     *
     * What this test is FOR is unchanged and still asserted above and below:
     * the pause no longer suppresses the watchdog. It re-engages on staleness
     * accrued AFTER the resume, which is the only staleness that means
     * anything.
     */
    expect((h.engine as any).msSinceProgress()).toBeLessThan(1_000);
    h.setStale(10 * 60_000);
    run(h); // idle + dealable + unpaused -> Case B counts a trip again
    expect(trips(h)).toBe(1);
  });

  it('does nothing to a table that is making progress', () => {
    const h = harness({});
    h.setStale(5_000);
    run(h);
    expect(h.calls.performAction).toHaveLength(0);
    expect(h.calls.startTimer).toHaveLength(0);
    expect(h.calls.killed).toHaveLength(0);
  });

  it('does not restart a table that is idle by design (fewer than 2 dealable seats)', () => {
    const h = harness({ noHand: true, seats: [{ seat: 1, stack: 1000 }] });
    h.setStale(IDLE_MS + 60_000);
    run(h);
    run(h);
    run(h);
    expect(h.calls.killed).toHaveLength(0);
  });

  it('rebuilds a table whose dealing loop is WEDGED, naming the step it died in', () => {
    const h = harness({ noHand: true });
    h.setStale(IDLE_MS + 10_000);
    // The loop has not moved off this step for longer than the idle window.
    // That, not the absence of a hand, is what "the loop is dead" means.
    h.setLoopPhase('load_seats', IDLE_MS + 10_000);
    run(h); // trip 1 — report only
    expect(h.calls.killed).toHaveLength(0);
    run(h); // trip 2 — the dealing loop is gone, rebuild
    expect(h.calls.killed).toEqual(['dealing_loop_dead:load_seats']);
  });
});

/**
 * ── The 2026-08-22 fleet-wide kill storm ──
 *
 * 1,603 `dealing_loop_dead` kills in six hours; every running cash table
 * killed 22-30 times, each after an average of three hands. Nothing was wrong
 * with the tables. The between-hands path is five Supabase round trips and
 * none of them marked progress, so a slow minute on a database that every
 * table shares read as "the dealing loop is dead" on every table at once —
 * and the rebuild storm loaded the database harder than the slowness that
 * started it.
 *
 * These pin the distinction that ends it: a loop still moving between steps
 * is ALIVE, however slow the step is.
 */
describe('table watchdog - a slow database is not a dead engine', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('does not kill a table whose loop is still moving, only waiting on the database', () => {
    const h = harness({ noHand: true });
    h.setStale(IDLE_MS + 30_000); // no hand for two minutes
    h.setLoopPhase('load_seats', 4_000); // ...but the loop moved 4s ago
    run(h);
    run(h);
    run(h);
    expect(h.calls.killed).toHaveLength(0);
    expect(trips(h)).toBe(0);
  });

  it('still kills a loop that cycles forever without ever dealing, under its own name', () => {
    const h = harness({ noHand: true });
    // Past the five-minute alive-loop horizon: cycling this long with two
    // funded seats is a real fault, just not the wedged one.
    h.setStale(6 * 60_000);
    h.setLoopPhase('spin_reveal_hold', 500);
    run(h);
    expect(h.calls.killed).toHaveLength(0);
    run(h);
    expect(h.calls.killed).toEqual(['loop_ticking_no_hands:spin_reveal_hold']);
  });

  it('reports the phase and its age so a storm names its own cause', () => {
    const h = harness({ noHand: true });
    h.setStale(IDLE_MS + 10_000);
    h.setLoopPhase('recover_busted_horses', 96_000);
    run(h);
    expect((h.engine as any).describeLoopPhase()).toBe('recover_busted_horses+96s');
  });
});

describe('table watchdog - escalation ladder', () => {
  it('TIER 1: a stalled seat with no clock is given one, and is NOT force-folded', () => {
    const h = harness({ hasClock: false });
    h.setStale(STALL_MS + 1_000);
    run(h);
    expect(h.calls.startTimer).toHaveLength(1);
    expect(h.calls.startTimer[0][2]).toBe(15);
    // The whole point of Tier 1 is to let the player use the clock it just got.
    expect(h.calls.performAction).toHaveLength(0);
  });

  it('TIER 1 resets the stall window so TIER 2 cannot stomp it 10s later', () => {
    const h = harness({ hasClock: false });
    h.setStale(STALL_MS + 1_000);
    run(h);
    // Next heartbeat is 10s away. The granted clock has 15s to run.
    const idleAfter = (h.engine as any).msSinceProgress();
    expect(idleAfter).toBeLessThan(1_000);
    run(h); // simulate that next heartbeat
    expect(h.calls.performAction).toHaveLength(0);
  });

  it('TIER 2: forces check when checking is free, and counts it as progress', () => {
    const h = harness({ hasClock: true, action: 'accept' });
    h.state.currentBet = 0; // nothing to call -> check is free
    h.setStale(STALL_MS + 1_000);
    run(h);
    expect(h.calls.performAction).toEqual([[1, 'check']]);
    expect(trips(h)).toBe(0); // markProgress ran — real action = real progress
  });

  it('TIER 2: forces fold when facing a bet', () => {
    const h = harness({ hasClock: true, action: 'accept' });
    h.setStale(STALL_MS + 1_000);
    run(h);
    expect(h.calls.performAction).toEqual([[1, 'fold']]);
  });

  it('TIER 3 IS REACHABLE: a seat that cannot be acted escalates to a rebuild', () => {
    // THE regression. performAction returns false (stale pointer), so the force
    // does nothing. Before the fix markProgress() still ran, zeroing the trip
    // count every cycle and pinning the table at Tier 2 forever.
    const h = harness({ hasClock: true, action: 'reject' });
    for (let i = 0; i < 5 && h.calls.killed.length === 0; i++) {
      h.setStale(STALL_MS + 1_000);
      run(h);
    }
    expect(h.calls.killed).toEqual(['turn_unrecoverable']);
  });

  it('a rejected force must NOT be recorded as progress', () => {
    const h = harness({ hasClock: true, action: 'reject' });
    h.setStale(STALL_MS + 1_000);
    run(h);
    expect(trips(h)).toBeGreaterThan(0);
  });
});

describe('table watchdog - a parked runout is not a stall', () => {
  it('finishes the runout instead of forcing an action when no seat is actionable', () => {
    const h = harness({ currentSeat: -1, hasClock: false });
    h.setStale(STALL_MS + 1_000);
    run(h);
    // -1 is the signal HandController now sets when it parks for a runout.
    expect(h.calls.continueRunout).toBe(1);
    expect(h.calls.performAction).toHaveLength(0);
    expect(h.calls.startTimer).toHaveLength(0);
  });

  it('escalates to a rebuild if the runout still will not finish', () => {
    const h = harness({ currentSeat: -1, hasClock: false });
    for (let i = 0; i < 4 && h.calls.killed.length === 0; i++) {
      h.setStale(STALL_MS + 1_000);
      run(h);
    }
    expect(h.calls.killed).toEqual(['stalled_no_seat']);
  });

  it('escalates when currentPlayerSeat points at a seat that is not in the hand', () => {
    const h = harness({ currentSeat: 99, hasClock: false });
    for (let i = 0; i < 4 && h.calls.killed.length === 0; i++) {
      h.setStale(STALL_MS + 1_000);
      run(h);
    }
    expect(h.calls.killed).toEqual(['current_seat_not_in_state']);
  });
});

describe('clearTurnTimer actually cancels (was an empty function)', () => {
  it("cancels the table's turn deadlines, and startTurnTimer does not wipe its own", () => {
    const cancelled: string[] = [];
    const started: string[] = [];
    const engine = new ServerTableEngine(TABLE) as any;
    engine.running = true;
    engine.tableInfo = { action_time_seconds: 15 };
    engine.currentHandTimerLog = [];
    engine.preciseTimer = {
      clearTable: (t: string) => cancelled.push(t),
      startTimer: (_t: string, uid: string) => started.push(uid),
      cancelTimer: () => {},
      hasTimer: () => false,
    };

    // The runout path believed this paused the clock. For four months it did nothing.
    engine.clearTurnTimer();
    expect(cancelled).toEqual([TABLE]);

    // Arming a timer must NOT cancel the table's deadlines — the time-bank
    // auto-activation path re-enters startTurnTimer moments after arming, and
    // a self-cancel there would silently drop the clock it just set.
    cancelled.length = 0;
    engine.startTurnTimer('u1', 1, 15);
    expect(started).toEqual(['u1']);
    expect(cancelled).toEqual([]);
  });
});
