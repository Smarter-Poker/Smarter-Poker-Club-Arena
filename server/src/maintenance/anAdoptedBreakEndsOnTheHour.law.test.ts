/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AN ADOPTED BREAK ENDS ON THE HOUR, NOT ON A BOOT INSTANT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CLAUDE.md 13: the break runs :55 -> :00 and the whole platform freezes for
 * it. Every timer in MaintenanceBreak is anchored to the wall clock for that
 * reason — `msUntilNextAnnouncement` is scrupulous about it — with ONE
 * exception, which this law closes.
 *
 * WHAT HAPPENED (2026-09-06). At 18:54:14 a manual `workflow_dispatch` deploy
 * restarted the engine ACROSS the :53 announcement instead of inside the :55
 * countdown. The new process found a persisted `last_hand` row, which carries
 * no `breakEndsAt`, so `restoreFromStore()` fell through to a full five
 * minutes measured from `this.now()` — the adopting process's boot instant.
 * `engine_maintenance_break_log` recorded the result:
 *
 *     break_started_at  2026-09-06 18:53:48.433
 *     break_ended_at    2026-09-06 18:58:49.531
 *
 * SEVENTY-ONE SECONDS BEFORE THE HOUR every player's countdown was pointing
 * at. Per-minute hand counts across the fleet show it exactly: zero hands in
 * 18:54, 18:55, 18:56, 18:57 and 18:58 — the break held 329 dealing tables
 * perfectly — and then 366 hands in the single minute 18:59.
 *
 * The scorecard then reported that as "Maintenance Break At 19:00 Did Not
 * Pass ... Hands In Window 366", which is how a five-minute freeze that worked
 * came to be paged as a freeze that leaked. The break dealt nothing. It
 * stopped early, and stopping early is its own defect: the felt came back to
 * life under an overlay that still said there was time.
 *
 * TWO PINS:
 *   1. an adopted `last_hand` break ends at the next :00, whatever time the
 *      process happened to boot;
 *   2. a `last_hand` row older than the whole announcement-plus-break span is
 *      refused rather than adopted. Before the fix `remaining` was the
 *      CONSTANT five minutes for such a row, so the staleness check above it
 *      could never fire, and an orphaned announcement from any earlier hour
 *      would park the entire platform for five minutes from any later boot.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MaintenanceBreak,
  type MaintenanceBreakStore,
  type PersistedMaintenanceBreak,
} from './MaintenanceBreak.js';

class FakeEngine {
  paused = false;
  holdBeforeNextHand = false;
  atGate = false;
  handInFlight = false;
  handForHandPaused = false;
  pauseForMaintenance(): void {
    this.paused = true;
    this.holdBeforeNextHand = true;
  }
  resumeFromMaintenance(): void {
    this.paused = false;
    this.holdBeforeNextHand = false;
    this.atGate = false;
  }
  isParkedBetweenHands(): boolean {
    return this.atGate;
  }
  isBetweenHands(): boolean {
    return !this.handInFlight;
  }
  isRunning(): boolean {
    return true;
  }
}

class FakeStore implements MaintenanceBreakStore {
  async loadReleaseBoundary(): Promise<number | null> {
    return null;
  }
  row: PersistedMaintenanceBreak | null = null;
  clears = 0;
  async load() {
    return this.row;
  }
  async save(s: PersistedMaintenanceBreak) {
    if (this.row && this.row.ownershipToken !== s.ownershipToken) {
      throw new Error('MAINTENANCE_OWNERSHIP_LOST');
    }
    this.row = { ...s };
  }
  async claim(expectedOwnershipToken: string, newOwnershipToken: string) {
    if (!this.row || this.row.ownershipToken !== expectedOwnershipToken) return null;
    this.row = { ...this.row, ownershipToken: newOwnershipToken };
    return this.row;
  }
  async clear(expected: PersistedMaintenanceBreak) {
    if (this.row?.ownershipToken !== expected.ownershipToken) return;
    this.row = null;
    this.clears++;
  }
}

function build(engineCount = 3) {
  const engines = new Map<string, FakeEngine>();
  for (let i = 0; i < engineCount; i++) engines.set(`t${i}`, new FakeEngine());
  const store = new FakeStore();
  const mb = new MaintenanceBreak({
    engines: () => engines.entries() as any,
    isRunning: () => true,
    emit: () => {},
    store,
    recordOutcome: async () => {},
  });
  return { mb, engines, store };
}

/**
 * LITERAL INSTANTS, NOT A TRANSCRIPTION OF THE CODE UNDER TEST.
 *
 * This file used to carry a `hourAfter()` helper that reimplemented
 * `nextHourBoundary()`, `<=` included — so when that function turned out to
 * return the FOLLOWING hour for a boot at exactly :00:00.000, the oracle
 * agreed with it and the test ratified a sixty-minute fleet freeze. A test
 * whose expectation is the implementation restated cannot catch the
 * implementation being wrong.
 *
 * Every expectation below is now a hard-coded instant a human can check
 * against §13's timeline (announce :53, park :55, resume :00), plus the
 * invariant that no adopted break may ever exceed a break's length.
 */
const AT = (iso: string): number => new Date(iso).getTime();

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('an adopted last-hand break', () => {
  it('ends at the next :00, not five minutes after the process booted', async () => {
    // The exact instant of the incident.
    const boot = new Date('2026-09-06T18:53:48.433Z').getTime();
    vi.setSystemTime(boot);
    const { mb, engines, store } = build();
    store.row = {
      phase: 'last_hand',
      announcedAt: new Date('2026-09-06T18:53:00.000Z').getTime(),
      breakStartedAt: null,
      breakEndsAt: null,
      reason: 'Scheduled Engine Maintenance',
      ownershipToken: 'owner-before-restart',
    } as PersistedMaintenanceBreak;

    await mb.start();

    for (const [id, e] of engines) {
      expect(e.paused, `${id} came back dealing under the overlay`).toBe(true);
    }

    // The break was announced at 18:53, so it ends at 19:00:00.000 exactly.
    // Written as the instant, not as a re-derivation of the production
    // arithmetic. boot + 5min would be 18:58:48.433 — the original bug, to
    // the millisecond.
    const hour = AT('2026-09-06T19:00:00.000Z');
    expect(boot + MaintenanceBreak.BREAK_DURATION_MS).toBeLessThan(hour);
    expect(mb.remainingMs()).toBe(hour - boot);

    // And it really does hold the fleet through 18:59, the minute that
    // produced all 366 hands.
    await vi.advanceTimersByTimeAsync(MaintenanceBreak.BREAK_DURATION_MS + 30_000);
    for (const [id, e] of engines) {
      expect(e.paused, `${id} resumed before the hour`).toBe(true);
    }

    // ...and resumes once the hour actually arrives.
    await vi.advanceTimersByTimeAsync(hour - Date.now() + 1_000);
    for (const [id, e] of engines) {
      expect(e.paused, `${id} never resumed`).toBe(false);
    }
  });

  /**
   * THE SIXTY-MINUTE FREEZE. The first fix computed "the next :00", and
   * `nextHourBoundary()` returned the FOLLOWING hour for a boot at exactly
   * :00:00.000 — while the staleness guard admits rows up to eight minutes
   * old, leaving a sixty-second window right after the hour in which an
   * adopted break would have parked the whole fleet for an hour.
   *
   * Nothing would have caught it in production: `fn_platform_frozen` only arms
   * within fifteen minutes of the end, so buy-ins would have flowed while
   * nothing dealt; `fn_thaw_platform` refuses anything over 900s, so every
   * in-flight deadline would have burned; and every fleet alarm is muted while
   * `poker_maintenance_break_active == 1`.
   */
  it('NEVER holds the fleet longer than a break, whatever instant it boots at', async () => {
    // Walk the whole admission window a second at a time, straddling the hour.
    for (const offsetS of [-2, -1, 0, 1, 2, 30, 59, 60, 61, 120]) {
      const boot = AT('2026-09-06T19:00:00.000Z') + offsetS * 1000;
      vi.setSystemTime(boot);
      const { mb, store } = build(2);
      store.row = {
        phase: 'last_hand',
        // Announced at :53 of the hour that has just ended - the row the
        // staleness guard still (correctly) admits for a few more minutes.
        announcedAt: AT('2026-09-06T18:53:00.000Z'),
        breakStartedAt: null,
        breakEndsAt: null,
        reason: 'Scheduled Engine Maintenance',
        ownershipToken: 'owner-before-restart',
      } as PersistedMaintenanceBreak;

      await mb.start();

      expect(
        mb.remainingMs(),
        `booting at :00 + ${offsetS}s held the fleet for ` +
          `${Math.round(mb.remainingMs() / 60000)} minutes. Tables are parked ` +
          'from the :53 announcement, so the longest an adopted break can ' +
          'legitimately hold is the whole :53 -> :00 span - seven minutes.'
      ).toBeLessThanOrEqual(
        MaintenanceBreak.LAST_HAND_LEAD_MS + MaintenanceBreak.BREAK_DURATION_MS
      );
      mb.stop();
    }
  });

  it('retains an expired durable row until its recovery runs', async () => {
    const boot = new Date('2026-09-06T21:07:00.000Z').getTime();
    vi.setSystemTime(boot);
    const { mb, engines, store } = build();
    // Announced at 18:53 and never cleared. Under the old arithmetic this
    // would have frozen every table on the platform for five minutes, at
    // 21:07, for a break nobody announced and no screen was showing.
    store.row = {
      phase: 'last_hand',
      announcedAt: new Date('2026-09-06T18:53:00.000Z').getTime(),
      breakStartedAt: null,
      breakEndsAt: null,
      reason: 'Scheduled Engine Maintenance',
      ownershipToken: 'stale-owner',
    } as PersistedMaintenanceBreak;

    await mb.start();

    for (const [id, e] of engines) {
      expect(e.paused, `${id} was frozen by a stale announcement`).toBe(true);
    }
    expect(mb.isActive()).toBe(true);
    expect(store.clears).toBe(0);
    expect(store.row).not.toBeNull();
  });

  it('still adopts a row from the hour it belongs to', async () => {
    // The guard must not eat the case the whole feature exists for: an engine
    // booting at ~:58 INSIDE the break it was restarted for.
    const boot = new Date('2026-09-06T18:58:00.000Z').getTime();
    vi.setSystemTime(boot);
    const { mb, engines, store } = build();
    store.row = {
      phase: 'last_hand',
      announcedAt: new Date('2026-09-06T18:53:00.000Z').getTime(),
      breakStartedAt: null,
      breakEndsAt: null,
      reason: 'Scheduled Engine Maintenance',
      ownershipToken: 'owner-before-restart',
    } as PersistedMaintenanceBreak;

    await mb.start();

    expect(mb.isActive()).toBe(true);
    for (const [id, e] of engines) {
      expect(e.paused, `${id} came back dealing at :58`).toBe(true);
    }
    // Announced 18:53, so it ends 19:00:00.000 — two minutes after this boot.
    expect(mb.remainingMs()).toBe(AT('2026-09-06T19:00:00.000Z') - boot);
    expect(mb.remainingMs()).toBeLessThanOrEqual(MaintenanceBreak.BREAK_DURATION_MS);
  });
});

describe('a counting-down break the previous engine already timed', () => {
  it('keeps the end instant it was given, rather than being re-anchored', async () => {
    // A `counting_down` row carries the wall-clock end the previous process
    // computed, usually a few seconds past the hour because the end timer
    // fires late. Clamping THAT to :00 would resume early for the same reason
    // the bug above did, so it is taken as it stands.
    const boot = new Date('2026-09-06T18:58:00.000Z').getTime();
    vi.setSystemTime(boot);
    const endsAt = new Date('2026-09-06T19:00:14.000Z').getTime();
    const { mb, store } = build(2);
    store.row = {
      phase: 'counting_down',
      announcedAt: new Date('2026-09-06T18:53:00.000Z').getTime(),
      breakStartedAt: new Date('2026-09-06T18:55:01.000Z').getTime(),
      breakEndsAt: endsAt,
      reason: 'Scheduled Engine Maintenance',
      ownershipToken: 'owner-before-restart',
    };

    await mb.start();

    expect(mb.remainingMs()).toBe(endsAt - boot);
  });
});
