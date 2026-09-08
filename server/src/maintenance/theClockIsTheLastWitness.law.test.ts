/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A BREAK WITH NO ROW IS STILL A BREAK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CLAUDE.md 13: the break runs :55 -> :00 and the WHOLE platform freezes for
 * it. `anAdoptedBreakEndsOnTheHour.law.test.ts` pins what happens when a
 * booting engine finds a row. This pins what happens when it finds nothing,
 * which until 2026-09-08 was: it dealt.
 *
 * WHAT HAPPENED (2026-09-08, twice in two hours). The deploy cuts the engine
 * over INSIDE the break by design - that is what the window is for - and on
 * this day the replacement came up with nothing to read, twice:
 *
 *     engine_leader.acquired_at    13:55:48        14:56:33
 *     engine_maintenance_break     (no row)        (no row)
 *     first hand after cutover     13:56:01        14:57:0x
 *     engine_maintenance_thaws     nothing         nothing
 *     engine_maintenance_break_log nothing         nothing
 *
 * Per-minute hand counts show the break STARTING correctly both times - the
 * :53 wind-down dealt one last hand on each of 115 and 175 tables, :54 dealt
 * 6, :55 dealt 1 and 0 - and then the replacement engine dealing straight
 * through the rest of the window: 945 hands across 111 tables inside
 * 13:55-14:00. No thaw ran either hour, so every in-flight deadline burned.
 * The only thing that noticed was `fn_ca_record_break_scorecard`, twelve
 * minutes later, and with no break log row to measure it fell back to the
 * nominal window and reported `measured_actual_break: false`.
 *
 * WHY IT COULD HAPPEN. `restoreFromStore()` decided whether this process
 * stood inside a break by reading ONE ROW, and both of its no-row exits -
 * `!loaded` after the read retries, and `!saved` - returned silently into a
 * dealing engine. Failing open on the ROW is correct and stays: an unreadable
 * database must not become a platform outage. Failing open on the SCHEDULE is
 * not, and there is no blip to blame for it. The timeline is fixed and
 * carries no time zone, so a process booting at 14:56:33 can tell from the
 * wall clock alone that it is standing in the middle of a break.
 *
 * FOUR PINS:
 *   1. an engine booting inside the window with NO row holds the fleet to the
 *      hour anyway, and the thaw runs;
 *   2. so does one that cannot READ the row - the retries are exhausted, and
 *      the clock is still the clock;
 *   3. it never holds the fleet outside [:53, :00), at any minute of the
 *      hour, including the boundaries;
 *   4. a row that CAN be adopted still wins - the clock is the last witness,
 *      not the first;
 *   5. a break that EXPIRED while nobody was alive to end it is thawed before
 *      its row is cleared. `end()` is the only other caller of the thaw and it
 *      only runs on a process still holding the break, so an engine that dies
 *      inside its own break used to take the frozen minutes with it. All three
 *      failed breaks on 2026-09-08 recorded `thaw_ran: false`, and by the
 *      16:00 one that was the ONLY remaining fault - zero hands in the window,
 *      the fleet held cleanly from 15:54 to 16:00, and every in-flight
 *      deadline burned anyway.
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
  row: PersistedMaintenanceBreak | null = null;
  /** Make load() throw, the way a database at its slowest does at :56. */
  unreadable = false;
  loads = 0;
  async load() {
    this.loads++;
    if (this.unreadable) throw new Error('statement timeout');
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
  }
}

interface Thawed {
  breakStartedAt: number;
  frozenSeconds: number;
}

function build(engineCount = 3) {
  const engines = new Map<string, FakeEngine>();
  for (let i = 0; i < engineCount; i++) engines.set(`t${i}`, new FakeEngine());
  const store = new FakeStore();
  const thaws: Thawed[] = [];
  const mb = new MaintenanceBreak({
    engines: () => engines.entries() as any,
    isRunning: () => true,
    emit: () => {},
    store,
    thaw: async (breakStartedAt: number, frozenSeconds: number) => {
      thaws.push({ breakStartedAt, frozenSeconds });
    },
    recordOutcome: async () => {},
  } as any);
  return { mb, engines, store, thaws };
}

/**
 * LITERAL INSTANTS, NOT A TRANSCRIPTION OF THE CODE UNDER TEST - the same rule
 * `anAdoptedBreakEndsOnTheHour` states, for the same reason. Every expectation
 * below is an instant a human can check against the timeline (announce :53,
 * park :55, resume :00).
 */
const AT = (iso: string): number => new Date(iso).getTime();

/** The exact instant the replacement engine took leadership on 2026-09-08. */
const CUTOVER = AT('2026-09-08T14:56:33.929Z');
/** The hour its countdown was pointing at on every screen. */
const HOUR = AT('2026-09-08T15:00:00.000Z');

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('an engine that boots inside the window with nothing to adopt', () => {
  it('holds the fleet to the hour anyway, instead of dealing', async () => {
    vi.setSystemTime(CUTOVER);
    const { mb, engines, store } = build();
    store.row = null; // exactly what production held at 14:57:15

    await mb.start();

    for (const [id, e] of engines) {
      expect(e.paused, `${id} dealt inside the break, the 2026-09-08 defect`).toBe(true);
    }

    // Ends on the hour, not a break's length from the boot instant: CUTOVER
    // plus five minutes would be 15:01:33.929, past the hour every screen was
    // counting down to.
    expect(CUTOVER + MaintenanceBreak.BREAK_DURATION_MS).toBeGreaterThan(HOUR);
    expect(mb.remainingMs()).toBe(HOUR - CUTOVER);

    // Still parked through 14:59, the minute that produced 127 hands.
    await vi.advanceTimersByTimeAsync(HOUR - Date.now() - 1_000);
    for (const [id, e] of engines) {
      expect(e.paused, `${id} resumed before the hour`).toBe(true);
    }
  });

  it('declares the break durably, so the database half freezes too', async () => {
    vi.setSystemTime(CUTOVER);
    // The store starts empty - exactly what production held at 14:57:15.
    const { mb, store } = build();

    await mb.start();

    // fn_platform_frozen reads this row. Without it the engine half holds the
    // felt while buy-ins and chip movements flow - which is how circulation
    // moved 21,507.11 chips inside the 14:00 window.
    const declared: PersistedMaintenanceBreak | null = store.row;
    expect(declared, 'the clock-derived break was never written down').not.toBeNull();
    expect(declared?.phase).toBe('counting_down');
    expect(declared?.breakEndsAt).toBe(HOUR);
  });

  it('runs the thaw, and measures only the freeze it can actually evidence', async () => {
    vi.setSystemTime(CUTOVER);
    const { mb, engines, thaws } = build();

    await mb.start();
    await vi.advanceTimersByTimeAsync(HOUR - Date.now() + 1_000);

    // The thaw ran at all - it did not on 2026-09-08, either hour.
    expect(thaws, 'no thaw ran, so every in-flight deadline burned').toHaveLength(1);

    /* Measured from the BOOT instant, not from the scheduled :55. A derived
       break has no evidence that anything was frozen before this process
       started holding: the engine may simply have been down across the
       announcement. fn_thaw_platform shifts every deadline by the duration it
       is handed, so over-claiming would move every clock on the platform on an
       assumption, on every cold boot inside the window. */
    expect(thaws[0].breakStartedAt).toBe(CUTOVER);
    expect(thaws[0].frozenSeconds).toBe(Math.round((HOUR - CUTOVER) / 1000));

    for (const [id, e] of engines) {
      expect(e.paused, `${id} never resumed`).toBe(false);
    }
  });

  it('holds even when the row cannot be READ, not merely when it is absent', async () => {
    vi.setSystemTime(CUTOVER);
    const { mb, engines, store } = build();
    store.unreadable = true;

    /* The retry loop sleeps on a timer between attempts, so under fake timers
       start() cannot settle until they are advanced. Drive them rather than
       awaiting a promise that is waiting on us. */
    const started = mb.start();
    await vi.advanceTimersByTimeAsync(
      MaintenanceBreak.RESTORE_ATTEMPTS * MaintenanceBreak.RESTORE_RETRY_MS + 1_000
    );
    await started;

    // The read retries are exhausted and the database is still unhappy. That
    // is a reason to distrust the row. It is not a reason to distrust the
    // clock.
    expect(store.loads).toBe(MaintenanceBreak.RESTORE_ATTEMPTS);
    for (const [id, e] of engines) {
      expect(e.paused, `${id} dealt because the database was slow`).toBe(true);
    }
  });
});

describe('and never freezes anything it should not', () => {
  /**
   * THE FALSE POSITIVE IS THE EXPENSIVE ONE. A missed break deals for a few
   * minutes; a window computed wrongly parks every table on the platform. The
   * deleted `nextHourBoundary()` did exactly that - it returned the FOLLOWING
   * hour for a boot at :00:00.000 - so this walks the whole hour rather than
   * spot-checking the happy path.
   */
  it('parks nothing outside [:53, :00), at any minute of the hour', async () => {
    for (let minute = 0; minute < 60; minute++) {
      for (const second of [0, 30, 59]) {
        const boot = AT('2026-09-08T14:00:00.000Z') + minute * 60_000 + second * 1000;
        vi.setSystemTime(boot);
        const { mb, engines } = build(2);

        await mb.start();

        /* :53 is a literal from the timeline, not a re-derivation. The one
           refinement: with a second or less left there is nothing worth
           holding, and `enterBreakFromTheClock` declines it on the same
           `remaining <= 1000` floor `restoreFromStore` has always used for an
           adopted row. 14:59:59 is the only instant sampled here that hits
           it. */
        const insideTheWindow = minute >= 53 && HOUR - boot > 1000;
        for (const [id, e] of engines) {
          expect(
            e.paused,
            `booting at 14:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')} ` +
              `${e.paused ? 'froze' : 'did not freeze'} ${id}; the window is :53 -> :00`
          ).toBe(insideTheWindow);
        }
        mb.stop();
      }
    }
  });

  it('NEVER holds the fleet longer than the whole :53 -> :00 span', async () => {
    // Straddle the hour a second at a time. Tables are parked from the
    // announcement, so seven minutes is the longest legitimate hold; anything
    // more is the sixty-minute freeze in a new costume.
    for (const offsetS of [-121, -61, -60, -2, -1, 0, 1, 2, 60, 121]) {
      const boot = HOUR + offsetS * 1000;
      vi.setSystemTime(boot);
      const { mb } = build(2);

      await mb.start();

      expect(
        mb.remainingMs(),
        `booting at :00 + ${offsetS}s held the fleet for ` +
          `${Math.round(mb.remainingMs() / 60000)} minute(s)`
      ).toBeLessThanOrEqual(
        MaintenanceBreak.LAST_HAND_LEAD_MS + MaintenanceBreak.BREAK_DURATION_MS
      );
      mb.stop();
    }
  });

  it('lets a row that can be adopted win - the clock is the LAST witness', async () => {
    // A real countdown row from the engine this process is replacing. Its
    // breakEndsAt is the authority, because it is the instant the countdown on
    // every screen is pointing at - including the few seconds it usually sits
    // past the hour. The derived window must not overwrite it.
    const adoptedEnd = HOUR + 6_000;
    vi.setSystemTime(CUTOVER);
    const { mb, engines, store } = build();
    store.row = {
      phase: 'counting_down',
      announcedAt: AT('2026-09-08T14:53:00.000Z'),
      breakStartedAt: AT('2026-09-08T14:55:01.000Z'),
      breakEndsAt: adoptedEnd,
      reason: 'Scheduled Engine Maintenance',
      ownershipToken: 'owner-before-restart',
    } as PersistedMaintenanceBreak;

    await mb.start();

    for (const [id, e] of engines) {
      expect(e.paused, `${id} came back dealing under the overlay`).toBe(true);
    }
    expect(mb.remainingMs(), 'the derived window overrode an adoptable row').toBe(
      adoptedEnd - CUTOVER
    );
  });
});

describe('a break nobody was alive to end', () => {
  /** The engine that declared the 15:55 break died inside it; its replacement
      took leadership at 16:00:08, eight seconds past the hour. */
  const ABANDONED_START = AT('2026-09-08T15:55:00.001Z');
  const ABANDONED_END = AT('2026-09-08T16:00:00.001Z');
  const LATE_BOOT = AT('2026-09-08T16:00:08.484Z');

  function expiredRow(
    overrides: Partial<PersistedMaintenanceBreak> = {}
  ): PersistedMaintenanceBreak {
    return {
      phase: 'counting_down',
      announcedAt: AT('2026-09-08T15:53:00.001Z'),
      breakStartedAt: ABANDONED_START,
      breakEndsAt: ABANDONED_END,
      reason: 'Scheduled Engine Maintenance',
      ownershipToken: 'owner-that-died-inside-its-own-break',
      ...overrides,
    } as PersistedMaintenanceBreak;
  }

  it('hands the frozen minutes back before clearing the row', async () => {
    vi.setSystemTime(LATE_BOOT);
    const { mb, engines, store, thaws } = build();
    store.row = expiredRow();

    await mb.start();

    // The thaw ran at all - it did not for 14:00, 15:00 or 16:00.
    expect(thaws, 'the frozen minutes were never handed back').toHaveLength(1);
    // Measured from the row's own countdown start to its own end: the freeze
    // that actually happened, not anything derived from this boot instant.
    expect(thaws[0].breakStartedAt).toBe(ABANDONED_START);
    expect(thaws[0].frozenSeconds).toBe(300);

    // And the platform still comes back: the row goes, nothing stays parked.
    expect(store.row, 'the expired row was left behind').toBeNull();
    for (const [id, e] of engines) {
      expect(e.paused, `${id} was held by a break that had already ended`).toBe(false);
    }
  });

  it('still clears the row when the thaw itself fails', async () => {
    vi.setSystemTime(LATE_BOOT);
    const engines = new Map<string, FakeEngine>();
    engines.set('t0', new FakeEngine());
    const store = new FakeStore();
    store.row = expiredRow();
    const mb = new MaintenanceBreak({
      engines: () => engines.entries() as any,
      isRunning: () => true,
      emit: () => {},
      store,
      thaw: async () => {
        throw new Error('PGRST002');
      },
      recordOutcome: async () => {},
    } as any);

    await mb.start();

    /* end() makes the same call for the same reason: five minutes of clock
       drift is a wrong that heals, a platform that stays frozen is not. */
    expect(store.row, 'a failed thaw stranded the break row').toBeNull();
    expect(engines.get('t0')!.paused).toBe(false);
  });

  it('does not invent a freeze for a last-hand row that never counted down', async () => {
    vi.setSystemTime(AT('2026-09-08T16:00:30.000Z'));
    const { mb, store, thaws } = build();
    // Announced, then the engine died before :55. Nothing was ever frozen by a
    // countdown, so there is nothing to give back.
    store.row = expiredRow({ phase: 'last_hand', breakStartedAt: null, breakEndsAt: null });

    await mb.start();

    expect(
      thaws,
      'shifted every deadline on the platform for a freeze that never ran'
    ).toHaveLength(0);
    expect(store.row).toBeNull();
  });

  it('refuses a freeze longer than fn_thaw_platform will accept', async () => {
    // A skewed clock, or a row from a break that was never bounded. The RPC
    // answers `implausible_frozen_seconds` past 900s; this declines first so
    // the refusal is a log line rather than a silent ok:false.
    const absurdStart = ABANDONED_END - (MaintenanceBreak.MAX_THAWABLE_SECONDS + 60) * 1000;
    vi.setSystemTime(LATE_BOOT);
    const { mb, store, thaws } = build();
    store.row = expiredRow({ breakStartedAt: absurdStart });

    await mb.start();

    expect(thaws).toHaveLength(0);
    expect(store.row).toBeNull();
  });
});
