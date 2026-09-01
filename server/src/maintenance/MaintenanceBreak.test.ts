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
 * worth trusting: pauseAfterHand only ARMS the pause, and the table is not
 * actually parked until the deal loop reaches the gate (`park()` here).
 * Conflating the two would let a test pass while real tables were still
 * mid-hand.
 */
class FakeEngine {
  paused = false;
  holdBeforeNextHand = false;
  atGate = false;
  running = true;
  budgets: number[] = [];
  resumeCount = 0;

  pauseAfterHand(maxWaitMs?: number, opts?: { beforeNextHand?: boolean }): void {
    this.paused = true;
    if (typeof maxWaitMs === 'number') this.budgets.push(maxWaitMs);
    if (opts?.beforeNextHand) this.holdBeforeNextHand = true;
  }
  resumeDealing(): void {
    this.paused = false;
    this.holdBeforeNextHand = false;
    this.atGate = false;
    this.resumeCount++;
  }
  isWaitingForHandForHand(): boolean {
    return this.paused && this.atGate;
  }
  isPausedByDesign(): boolean {
    return this.paused;
  }
  isRunning(): boolean {
    return this.running;
  }
  /** The deal loop reaching awaitPauseGate between hands. */
  park(): void {
    this.atGate = true;
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
    [...engines.values()][0].resumeDealing = () => {
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
