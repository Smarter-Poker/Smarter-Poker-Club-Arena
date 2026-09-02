/**
 * THE MAINTENANCE BREAK LAW (Dan, 2026-09-01)
 *
 * Every assertion here is a way the restart could become visible to players
 * again. The feature is not "a countdown appears"; it is "no hand is
 * interrupted, no table deals during the break, and the break outlives the
 * process that declared it". Those three are what is pinned.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  MaintenanceBreak,
  type MaintenanceBreakStore,
  type PersistedMaintenanceBreak,
} from './MaintenanceBreak.js';

/**
 * Mirrors ServerTableEngineBase's real pause semantics closely enough to be
 * worth trusting: pauseForMaintenance only ARMS the pause, and the table is
 * not actually parked until one of its loops reaches the gate (`park()`
 * here). Conflating the two would let a test pass while real tables were
 * still mid-hand - which is exactly the bug the restart-gate test caught.
 */
class FakeEngine {
  paused = false;
  holdBeforeNextHand = false;
  atGate = false;
  running = true;
  budgets: number[] = [];
  resumeCount = 0;
  /** Set when hand-for-hand tries to resume this table. */
  handForHandResumeAttempts = 0;

  pauseForMaintenance(maxWaitMs: number): void {
    this.paused = true;
    this.holdBeforeNextHand = true;
    if (typeof maxWaitMs === 'number') this.budgets.push(maxWaitMs);
  }
  resumeFromMaintenance(): void {
    this.paused = false;
    this.holdBeforeNextHand = false;
    this.atGate = false;
    this.resumeCount++;
  }
  isParkedBetweenHands(): boolean {
    return this.atGate;
  }
  isRunning(): boolean {
    return this.running;
  }
  /** A loop reaching awaitPauseGate between hands. */
  park(): void {
    this.atGate = true;
  }
  /**
   * What hand-for-hand's 500ms sync loop does. On the real engine
   * resumeDealing() early-returns while maintenancePaused, which is the whole
   * point of the two flags; the fake mirrors that.
   */
  handForHandResume(): void {
    this.handForHandResumeAttempts++;
    if (this.paused) return; // maintenance still holds it
    this.atGate = false;
  }
}

class FakeStore implements MaintenanceBreakStore {
  row: PersistedMaintenanceBreak | null = null;
  saves = 0;
  clears = 0;
  async load() {
    return this.row;
  }
  async save(s: PersistedMaintenanceBreak) {
    this.row = { ...s };
    this.saves++;
  }
  async clear() {
    this.row = null;
    this.clears++;
  }
}

function build(engineCount = 3) {
  const engines = new Map<string, FakeEngine>();
  for (let i = 0; i < engineCount; i++) engines.set(`t${i}`, new FakeEngine());
  const store = new FakeStore();
  const emitted: Array<{ tableId: string; payload: Record<string, unknown> }> = [];
  const mb = new MaintenanceBreak({
    engines: () => engines.entries() as any,
    isRunning: () => true,
    emit: (tableId, payload) => emitted.push({ tableId, payload }),
    store,
  });
  return { mb, engines, store, emitted };
}

const parkAll = (engines: Map<string, FakeEngine>) => engines.forEach((e) => e.park());

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// ───────────────────────────────────────────────────────────────────────────

describe('the announcement', () => {
  it('holds every table BEFORE its next hand, not merely after the current one', async () => {
    const { mb, engines } = build();
    await mb.announceLastHand();

    for (const [id, e] of engines) {
      expect(e.paused, `${id} was not paused`).toBe(true);
      // The whole guarantee. Without beforeNextHand the gate sits below the
      // short-handed and spin-reveal branches, so an idle table deals the
      // moment a seat fills mid-break - the bug Dan hit at the :55 tournament
      // break, reproduced here.
      expect(e.holdBeforeNextHand, `${id} may still start a hand`).toBe(true);
    }
  });

  it('gives every table a budget that outlasts the last hand plus the whole break', async () => {
    const { mb, engines } = build();
    await mb.announceLastHand();

    const floor = MaintenanceBreak.LAST_HAND_LEAD_MS + MaintenanceBreak.BREAK_DURATION_MS;
    for (const [id, e] of engines) {
      // A budget shorter than this makes awaitPauseGate's safety timeout fire
      // mid-break and the table silently resumes dealing behind the overlay.
      expect(e.budgets[0], `${id} budget too short`).toBeGreaterThanOrEqual(floor);
      // ...and never so long that the stall reapers stop believing the table.
      expect(e.budgets[0]).toBeLessThan(10 * 60 * 1000);
    }
  });

  it('treats every table identically, with no branch of any kind', async () => {
    // CLAUDE.md 10.5. There is no is_horse here and there must never be: a
    // table that kept dealing while its neighbour stopped would tell every
    // watching player which seats are horses.
    const { mb, engines } = build(8);
    await mb.announceLastHand();
    const shapes = [...engines.values()].map((e) =>
      JSON.stringify({ p: e.paused, h: e.holdBeforeNextHand, b: e.budgets })
    );
    expect(new Set(shapes).size).toBe(1);
  });

  it('persists straight away, so a kill between :53 and :55 is still a break', async () => {
    const { mb, store } = build();
    await mb.announceLastHand();
    expect(store.row?.phase).toBe('last_hand');
    // No end time yet: the countdown has not started and we refuse to show a
    // number we would have to take back.
    expect(store.row?.breakEndsAt).toBeNull();
  });
});

describe('the countdown', () => {
  it('starts five minutes only once, and writes an absolute end time', async () => {
    const { mb, engines, store } = build();
    await mb.announceLastHand();
    parkAll(engines);
    await mb.beginCountdown();

    expect(store.row?.phase).toBe('counting_down');
    expect(store.row?.breakEndsAt).toBeGreaterThan(Date.now());
    expect(mb.remainingMs()).toBeGreaterThan(4 * 60 * 1000);

    // Idempotent: a second call must not extend the break.
    const first = store.row?.breakEndsAt;
    await mb.beginCountdown();
    expect(store.row?.breakEndsAt).toBe(first);
  });

  it('sends an absolute instant to clients, never a duration', async () => {
    // This is what lets the browser keep correct time through the ~2 minutes
    // when there is no engine to ask.
    const { mb, engines, emitted } = build(1);
    await mb.announceLastHand();
    parkAll(engines);
    await mb.beginCountdown();

    const last = emitted[emitted.length - 1].payload;
    expect(last.type).toBe('maintenance_break');
    expect(typeof last.break_ends_at).toBe('number');
    expect(last.break_ends_at as number).toBeGreaterThan(Date.now());
  });
});

describe('the restart gate', () => {
  it('stays shut until every single table has reached the pause gate', async () => {
    const { mb, engines } = build(3);
    await mb.announceLastHand();
    await mb.beginCountdown();

    expect(mb.readyForRestart()).toBe(false);

    const list = [...engines.values()];
    list[0].park();
    list[1].park();
    // One table still mid-hand is enough to refuse the restart. Losing a
    // deploy window costs six hours of slightly older code; restarting here
    // voids somebody's hand.
    expect(mb.readyForRestart()).toBe(false);

    list[2].park();
    expect(mb.readyForRestart()).toBe(true);
  });

  it('opens for a QUIET table, which parks in the start-up loop not the deal loop', async () => {
    /**
     * FOUND BY AUDIT BEFORE THIS SHIPPED, and it would have made the whole
     * feature inert. The gate first used `isWaitingForHandForHand()`, which is
     * only ever true for a table that reached the gate from the DEALING loop.
     * A table below minPlayersToDeal sits in the start-up wait loop instead,
     * and GameServer deliberately starts engines for exactly those tables.
     *
     * So every quiet table counted as unparked forever, the gate could never
     * open, and the deploy would have waited fourteen minutes and given up -
     * every hour, permanently, with nothing ever shipping except force=true,
     * which restarts on live tables. The symptom would have been the straggler
     * warning naming the same table ids every hour.
     *
     * `isParkedBetweenHands()` accepts a park from either loop, so this test
     * is the difference between the feature working and doing nothing.
     */
    const { mb, engines } = build(2);
    await mb.announceLastHand();
    await mb.beginCountdown();

    // Neither table ever sees a hand; they park from the wait loop.
    parkAll(engines);
    expect(mb.readyForRestart()).toBe(true);
  });

  it('shuts again once too little break remains to finish a restart inside it', async () => {
    const { mb, engines } = build(1);
    await mb.announceLastHand();
    parkAll(engines);
    await mb.beginCountdown();
    expect(mb.readyForRestart()).toBe(true);

    // A restart takes ~3 minutes. Starting one with 90 seconds left would put
    // the rehydration outage back outside the announced break.
    vi.advanceTimersByTime(MaintenanceBreak.BREAK_DURATION_MS - 90_000);
    expect(mb.readyForRestart()).toBe(false);
  });

  it('is never open when no break is running', () => {
    const { mb } = build();
    expect(mb.readyForRestart()).toBe(false);
    expect(mb.isActive()).toBe(false);
  });
});

describe('the end of the break', () => {
  it('resumes every table and deletes the row', async () => {
    const { mb, engines, store } = build(4);
    await mb.announceLastHand();
    parkAll(engines);
    await mb.beginCountdown();
    await mb.end();

    for (const [id, e] of engines) {
      expect(e.paused, `${id} still paused after the break`).toBe(false);
      expect(e.resumeCount, `${id} resumed the wrong number of times`).toBe(1);
    }
    expect(store.row).toBeNull();
    expect(mb.isActive()).toBe(false);
  });

  it('hand-for-hand cannot deal a hand inside the break', async () => {
    /**
     * FOUND BY AUDIT. Hand-for-hand runs a 500ms sync loop that says "every
     * table is waiting, so the round is over, resume them all". During a break
     * every table IS waiting - so on a bubble tournament at :55 that loop
     * resumed the fleet and dealt a hand inside the break.
     *
     * The second-order damage was worse than the hand: its resume cleared the
     * break's pause budget, and the 500ms re-park was a bare pauseAfterHand()
     * with no budget, so the safety timeout fell back to 120s and the table
     * SELF-RESUMED two minutes into a five minute break. That is the
     * 2026-08-19 bug PARK_BUDGET_MS exists to prevent, through another door.
     *
     * Two independent flags is the fix: whoever paused a table is the only one
     * who may resume it.
     */
    const { mb, engines } = build(3);
    await mb.announceLastHand();
    parkAll(engines);
    await mb.beginCountdown();

    for (const e of engines.values()) e.handForHandResume();

    for (const [id, e] of engines) {
      expect(e.handForHandResumeAttempts, `${id} was not exercised`).toBe(1);
      expect(e.paused, `${id} was un-parked by hand-for-hand`).toBe(true);
      expect(e.isParkedBetweenHands(), `${id} left the gate mid-break`).toBe(true);
      expect(e.resumeCount, `${id} counted a real resume`).toBe(0);
    }
    // And the break is still the authority the restart gate trusts.
    expect(mb.readyForRestart()).toBe(true);
  });

  it('thaws the clocks BEFORE the first table resumes', async () => {
    /**
     * "Picks back up exactly as it was" is a statement about CLOCKS. The thaw
     * shifts every in-flight deadline (sit-out, seat holds, add-on windows,
     * Spin levels, claim-back) by the frozen duration, and it must land while
     * every table is still parked - a table resumed first could evict a
     * sit-out or roll a blind level on a clock that had not been given its
     * five minutes back yet.
     */
    const engines = new Map<string, FakeEngine>([['t0', new FakeEngine()]]);
    const events: string[] = [];
    const origResume = FakeEngine.prototype.resumeFromMaintenance;
    const store = new FakeStore();
    let thawArgs: { startedAt: number; seconds: number } | null = null;
    const mb = new MaintenanceBreak({
      engines: () => engines.entries() as any,
      isRunning: () => true,
      emit: () => {},
      store,
      thaw: async (startedAt, seconds) => {
        events.push('thaw');
        thawArgs = { startedAt, seconds };
      },
    });
    engines.get('t0')!.resumeFromMaintenance = function (this: FakeEngine) {
      events.push('resume');
      origResume.call(this);
    };

    await mb.announceLastHand();
    parkAll(engines);
    await mb.beginCountdown();
    const started = Date.now();
    vi.advanceTimersByTime(MaintenanceBreak.BREAK_DURATION_MS);
    await mb.end();

    expect(events).toEqual(['thaw', 'resume']);
    expect(thawArgs!.seconds).toBeGreaterThanOrEqual(299);
    expect(thawArgs!.seconds).toBeLessThanOrEqual(301);
    expect(thawArgs!.startedAt).toBeLessThanOrEqual(started);
  });

  it('a thaw failure never leaves the platform frozen', async () => {
    // Five minutes of clock drift is a wrong that heals; a platform that
    // stays frozen is not.
    const { mb, engines } = build(2);
    (mb as any).deps.thaw = async () => {
      throw new Error('PGRST002');
    };
    await mb.announceLastHand();
    parkAll(engines);
    await mb.beginCountdown();
    await mb.end();
    for (const [id, e] of engines) {
      expect(e.paused, `${id} stayed frozen after a thaw failure`).toBe(false);
    }
    expect(mb.isActive()).toBe(false);
  });

  it('measures the WHOLE freeze across a restart, not this process`s slice', async () => {
    // An engine that adopted the break at ~:58 must thaw from the ORIGINAL
    // :55 start, or the clocks get back three minutes instead of five.
    const engines = new Map<string, FakeEngine>([['t0', new FakeEngine()]]);
    const store = new FakeStore();
    const originalStart = Date.now() - 3 * 60 * 1000;
    store.row = {
      phase: 'counting_down',
      announcedAt: originalStart - 2 * 60 * 1000,
      breakStartedAt: originalStart,
      breakEndsAt: Date.now() + 2 * 60 * 1000,
      reason: 'Scheduled Engine Maintenance',
    };
    let thawSeconds = 0;
    const mb = new MaintenanceBreak({
      engines: () => engines.entries() as any,
      isRunning: () => true,
      emit: () => {},
      store,
      thaw: async (_startedAt, seconds) => {
        thawSeconds = seconds;
      },
    });
    await mb.start();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 500);
    // ~5 minutes total: the 3 before the restart plus the 2 after it.
    expect(thawSeconds).toBeGreaterThanOrEqual(295);
    expect(thawSeconds).toBeLessThanOrEqual(305);
  });

  it('leaves a table another authority is still holding', async () => {
    // A tournament add-on break runs up to ten minutes. One starting near :55
    // outlives this five-minute break, and resuming its tables here would deal
    // that event back into play while its own clock still has it away.
    const engines = new Map<string, FakeEngine>([
      ['cash', new FakeEngine()],
      ['mtt', new FakeEngine()],
    ]);
    const mb = new MaintenanceBreak({
      engines: () => engines.entries() as any,
      isRunning: () => true,
      emit: () => {},
      store: new FakeStore(),
      shouldStayPaused: (id) => id === 'mtt',
    });

    await mb.announceLastHand();
    await mb.beginCountdown();
    await mb.end();

    expect(engines.get('cash')!.paused).toBe(false);
    expect(engines.get('mtt')!.paused).toBe(true);
    expect(engines.get('mtt')!.resumeCount).toBe(0);
  });

  it('still clears the row when a table refuses to resume', async () => {
    // A stranded row is worse than a stranded table: the engine's own pause
    // timeout eventually deals again, but a row nobody deletes keeps every
    // browser on the platform showing a break that ended.
    const { mb, engines, store } = build(2);
    [...engines.values()][0].resumeFromMaintenance = () => {
      throw new Error('engine is wedged');
    };
    await mb.announceLastHand();
    await mb.beginCountdown();
    await mb.end();

    expect(store.row).toBeNull();
    expect([...engines.values()][1].paused).toBe(false);
  });
});

describe('surviving the restart', () => {
  it('re-parks every table for what is LEFT of a break the previous engine declared', async () => {
    const { mb, engines, store } = build(3);
    store.row = {
      phase: 'counting_down',
      announcedAt: Date.now() - 4 * 60 * 1000,
      breakStartedAt: Date.now() - 60_000,
      breakEndsAt: Date.now() + 2 * 60 * 1000,
      reason: 'Scheduled Engine Maintenance',
    };

    await mb.start();

    // Without this the fleet comes back dealing while every screen still
    // shows two minutes on the clock.
    for (const [id, e] of engines) {
      expect(e.paused, `${id} came back dealing`).toBe(true);
      expect(e.holdBeforeNextHand).toBe(true);
    }
    expect(mb.remainingMs()).toBeGreaterThan(60_000);
    expect(mb.remainingMs()).toBeLessThanOrEqual(2 * 60 * 1000);
  });

  it('resumes on time after adopting a break, without being told', async () => {
    const { mb, engines, store } = build(2);
    store.row = {
      phase: 'counting_down',
      announcedAt: Date.now(),
      breakStartedAt: Date.now() - 60_000,
      breakEndsAt: Date.now() + 30_000,
      reason: 'Scheduled Engine Maintenance',
    };
    await mb.start();
    expect([...engines.values()][0].paused).toBe(true);

    await vi.advanceTimersByTimeAsync(31_000);
    for (const [id, e] of engines) {
      expect(e.paused, `${id} never resumed`).toBe(false);
    }
    expect(store.row).toBeNull();
  });

  it('ignores an expired row rather than blacking out the platform', async () => {
    const { mb, engines, store } = build(2);
    store.row = {
      phase: 'counting_down',
      announcedAt: Date.now() - 10 * 60 * 1000,
      breakStartedAt: Date.now() - 60_000,
      breakEndsAt: Date.now() - 60_000,
      reason: 'Scheduled Engine Maintenance',
    };
    await mb.start();

    expect(mb.isActive()).toBe(false);
    expect([...engines.values()][0].paused).toBe(false);
    expect(store.clears).toBe(1);
  });

  it('deals normally when the break row cannot be read at all', async () => {
    // Fails OPEN on purpose. A database blip must not become a platform
    // outage - the worst case is a visible restart, which is where we were
    // before this existed.
    const { mb, engines, store } = build(2);
    store.load = async () => {
      throw new Error('PGRST002');
    };
    await mb.start();
    expect(mb.isActive()).toBe(false);
    expect([...engines.values()][0].paused).toBe(false);
  });

  it('parks a table CREATED during the break', async () => {
    // The post-restart discovery sweep rebuilds the whole fleet inside the
    // break; every one of those engines is born after the announcement.
    const { mb, engines } = build(1);
    await mb.announceLastHand();
    await mb.beginCountdown();

    const late = new FakeEngine();
    engines.set('late', late);
    mb.adopt('late', late);

    expect(late.paused).toBe(true);
    expect(late.holdBeforeNextHand).toBe(true);
    // Its budget must not outlive the break it was created inside.
    expect(late.budgets[0]).toBeLessThanOrEqual(MaintenanceBreak.BREAK_DURATION_MS + 60_000);
  });

  it('does not park a table created when no break is running', () => {
    const { mb } = build(0);
    const e = new FakeEngine();
    mb.adopt('t', e);
    expect(e.paused).toBe(false);
  });
});

describe('the schedule', () => {
  it('announces at :53 so the countdown starts at :55 with the tournament break', () => {
    // The two must coincide: an MTT may not be stopped twice in one hour, and
    // at :55 its blind clock is already suspended.
    expect(MaintenanceBreak.BREAK_START_MINUTE - MaintenanceBreak.LAST_HAND_LEAD_MS / 60000).toBe(
      53
    );
    expect(MaintenanceBreak.BREAK_START_MINUTE).toBe(55);
  });

  it('fires every hour, and never restricts itself to a set of hours', () => {
    // Dan 2026-09-01: "every hour on the :55 instead of every 5 hours so
    // nothing gets lost or orphaned from production improvements." An hours
    // allowlist here is the thing that stranded merged code for six hours.
    expect(MaintenanceBreak).not.toHaveProperty('RESTART_WINDOW_HOURS_CHICAGO');

    const seen = new Set<number>();
    for (let h = 0; h < 24; h++) {
      // 07 minutes past each hour, so the next :53 is always this hour's.
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 1, h, 7, 0)));
      const { mb } = build(0);
      // @ts-expect-error - exercising the private scheduler directly is the
      // point: it is the one thing a wrong answer here would hide.
      const ms = mb.msUntilNextAnnouncement();
      const fireAt = new Date(Date.UTC(2026, 8, 1, h, 7, 0) + ms);
      expect(fireAt.getMinutes(), `hour ${h} did not target :53`).toBe(53);
      seen.add(fireAt.getUTCHours());
    }
    expect(seen.size, 'the break must be reachable in every hour of the day').toBe(24);
  });

  it('rolls to the next hour once :53 has passed', () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 1, 9, 54, 0)));
    const { mb } = build(0);
    // @ts-expect-error - private by design, see above.
    const ms = mb.msUntilNextAnnouncement();
    const fireAt = new Date(Date.UTC(2026, 8, 1, 9, 54, 0) + ms);
    expect(fireAt.getUTCHours()).toBe(10);
    expect(fireAt.getMinutes()).toBe(53);
    // Never zero or negative: a scheduler that returns those spins the loop.
    expect(ms).toBeGreaterThan(0);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BREAK MUST STOP THE DEAL, ON THE REAL ENGINE (2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The header of this file promises "no table deals during the break". On the
 * first break that ever ran armed, 18:55-19:00, production dealt 1204 hands -
 * against 0 in each of the two breaks on the build before it, and 1299 in a
 * normal five minutes. The break had stopped stopping play.
 *
 * Everything above this line passed the whole time, because the stub engine
 * these tests drive models the pause the way the break INTENDS it. The real
 * engine has a second predicate, `isPausedByDesign()`, which is what the turn
 * loop consults - and #2537 split the break into its own `maintenancePaused`
 * authority without teaching that predicate about it. `pauseAfterHand` sets
 * `handForHandPaused`, which the predicate reads; `pauseForMaintenance`
 * deliberately does not, so it answered false all the way through a break.
 *
 * The same predicate is GameServer's `parkedOnPurpose`, so every table the
 * break held also looked stalled to the table watchdog, which killed and
 * rebuilt it - the hourly :00 wave in #2651.
 *
 * So these run against the REAL engine. A stub cannot catch a stub's
 * optimism.
 */
describe('the real engine treats a maintenance pause as paused', () => {
  const TBL = 'aaaaaaaa-1111-2222-3333-444444444444';

  it('is not paused before anything asks it to be', async () => {
    const { ServerTableEngine } = await import('../engine/ServerTableEngine.js');
    const e = new ServerTableEngine(TBL) as any;
    expect(e.isPausedByDesign()).toBe(false);
  });

  it('is paused by design while the maintenance break holds it', async () => {
    const { ServerTableEngine } = await import('../engine/ServerTableEngine.js');
    const e = new ServerTableEngine(TBL) as any;
    e.pauseForMaintenance(300_000);
    expect(
      e.isPausedByDesign(),
      'the turn loop and the table watchdog both read this. False here means the ' +
        'break deals hands through itself and the watchdog rebuilds every parked table.'
    ).toBe(true);
  });

  it('stops being paused when the break lifts', async () => {
    const { ServerTableEngine } = await import('../engine/ServerTableEngine.js');
    const e = new ServerTableEngine(TBL) as any;
    e.pauseForMaintenance(300_000);
    e.resumeFromMaintenance();
    expect(e.isPausedByDesign()).toBe(false);
  });

  it('still reports the hand-for-hand pause it always did', async () => {
    // The maintenance authority is additive; it must not shadow the original.
    const { ServerTableEngine } = await import('../engine/ServerTableEngine.js');
    const e = new ServerTableEngine(TBL) as any;
    e.pauseAfterHand(120_000);
    expect(e.isPausedByDesign()).toBe(true);
  });

  it('a hand-for-hand resume cannot unpause a table the break is holding', async () => {
    // The reason the break got its own authority in the first place.
    const { ServerTableEngine } = await import('../engine/ServerTableEngine.js');
    const e = new ServerTableEngine(TBL) as any;
    e.pauseForMaintenance(300_000);
    e.resumeDealing();
    expect(e.isPausedByDesign()).toBe(true);
  });
});
