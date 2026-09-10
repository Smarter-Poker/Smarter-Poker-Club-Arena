/**
 * THE MAINTENANCE BREAK LAW (Dan, 2026-09-01)
 *
 * Every assertion here is a way the restart could become visible to players
 * again. The feature is not "a countdown appears"; it is "no hand is
 * interrupted, no table deals during the break, and the break outlives the
 * process that declared it". Those three are what is pinned.
 */

import { describe, it, expect, beforeEach, beforeAll, vi, afterEach } from 'vitest';
import {
  MaintenanceBreak,
  type MaintenanceBreakStore,
  type PersistedMaintenanceBreak,
  type MaintenanceBreakOutcome,
} from './MaintenanceBreak.js';
import { thawReconnectClock } from './reconnectFreeze.js';
import { ThawAbandonedError, ThawRefusedError } from './thawInstallments.js';

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
  /** Set when another authority (a tournament break) is holding the table. */
  handForHandPaused = false;

  resumeFromMaintenance(): void {
    // MODELS THE REAL CONTRACT (ServerTableEngineBase.resumeFromMaintenance):
    // the maintenance flag is always cleared, but the GATE is only released
    // when no other authority holds the table. The old fake cleared `paused`
    // unconditionally, which is what made skipping such a table look correct.
    this.resumeCount++;
    if (this.handForHandPaused) return;
    this.paused = false;
    this.holdBeforeNextHand = false;
    this.atGate = false;
  }
  isParkedBetweenHands(): boolean {
    return this.atGate;
  }
  /** Cards in the air. The real engine: handController !== null. */
  handInFlight = false;
  isBetweenHands(): boolean {
    return !this.handInFlight;
  }
  /** A hand is dealt: cards in the air, the loop is nowhere near the gate. */
  deal(): void {
    this.handInFlight = true;
    this.atGate = false;
  }
  /** The hand settles. The loop is still in flight (sleep, seat read, broadcast). */
  finishHand(): void {
    this.handInFlight = false;
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
  releaseBoundary: number | null = null;
  saves = 0;
  clears = 0;
  async load() {
    return this.row;
  }
  async loadReleaseBoundary() {
    return this.releaseBoundary;
  }
  async save(s: PersistedMaintenanceBreak) {
    if (this.row && this.row.ownershipToken !== s.ownershipToken) {
      throw new Error('MAINTENANCE_OWNERSHIP_LOST');
    }
    this.row = { ...s };
    this.saves++;
  }
  async claim(expectedOwnershipToken: string, newOwnershipToken: string) {
    if (!this.row || this.row.ownershipToken !== expectedOwnershipToken) return null;
    this.row = { ...this.row, ownershipToken: newOwnershipToken };
    return this.row;
  }
  async clear(expected: PersistedMaintenanceBreak) {
    if (JSON.stringify(this.row) !== JSON.stringify(expected)) return;
    this.row = null;
    this.clears++;
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const noOpThaw = async () => {};

function build(engineCount = 3) {
  const engines = new Map<string, FakeEngine>();
  for (let i = 0; i < engineCount; i++) engines.set(`t${i}`, new FakeEngine());
  const store = new FakeStore();
  const emitted: Array<{ tableId: string; payload: Record<string, unknown> }> = [];
  const outcomes: MaintenanceBreakOutcome[] = [];
  const mb = new MaintenanceBreak({
    engines: () => engines.entries() as any,
    isRunning: () => true,
    emit: (tableId, payload) => emitted.push({ tableId, payload }),
    store,
    thaw: async () => {},
    recordOutcome: async (o) => {
      outcomes.push(o);
    },
  });
  return { mb, engines, store, emitted, outcomes };
}

const parkAll = (engines: Map<string, FakeEngine>) => engines.forEach((e) => e.park());

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// ───────────────────────────────────────────────────────────────────────────

describe('the announcement', () => {
  it('makes the durable promise before any player can see it', async () => {
    const { mb, store, emitted } = build(1);
    const saving = deferred<void>();
    store.save = async (state) => {
      await saving.promise;
      store.row = { ...state };
      store.saves++;
    };

    const announcing = mb.announceLastHand();
    await Promise.resolve();
    expect(emitted).toHaveLength(0);

    saving.resolve();
    await announcing;
    expect(store.row?.phase).toBe('last_hand');
    expect(emitted.map((frame) => frame.payload.phase)).toEqual(['last_hand']);
  });

  it('keeps the original seven-minute window when the durable save waits behind an entry', async () => {
    vi.setSystemTime(new Date('2026-09-07T18:53:00.000Z'));
    const announcedAt = Date.now();
    const { mb, store, emitted } = build(1);
    const saving = deferred<void>();
    store.save = async (state) => {
      await saving.promise;
      store.row = { ...state };
      store.saves++;
    };

    const announcing = mb.announceLastHand();
    await vi.advanceTimersByTimeAsync(30_000);
    saving.resolve();
    await announcing;

    const lastHand = emitted.at(-1)?.payload;
    expect(lastHand?.phase).toBe('last_hand');
    expect(lastHand?.restart_in_ms).toBe(90_000);
    expect(lastHand?.resume_expected_at).toBe(
      announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS + MaintenanceBreak.BREAK_DURATION_MS
    );

    await vi.advanceTimersByTimeAsync(89_999);
    expect(store.row?.phase).toBe('last_hand');
    await vi.advanceTimersByTimeAsync(1);

    expect(store.row).toMatchObject({
      phase: 'counting_down',
      announcedAt,
      breakStartedAt: announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS,
      breakEndsAt:
        announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS + MaintenanceBreak.BREAK_DURATION_MS,
    });
    expect(emitted.at(-1)?.payload).toMatchObject({
      phase: 'counting_down',
      break_ends_at:
        announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS + MaintenanceBreak.BREAK_DURATION_MS,
    });
  });

  it('keeps the last-hand gate through transient write failures and starts only after durable proof', async () => {
    vi.setSystemTime(new Date('2026-09-09T18:53:00.000Z'));
    const { mb, engines, store, emitted } = build(2);
    const save = store.save.bind(store);
    const attempts: number[] = [];
    store.save = async (state) => {
      attempts.push(Date.now());
      if (attempts.length < 3) throw new Error('database unavailable');
      await save(state);
    };

    const announcing = mb.announceLastHand();
    await Promise.resolve();
    await Promise.resolve();

    expect(attempts).toEqual([Date.now()]);
    expect(mb.snapshot()).toMatchObject({ active: true, phase: 'last_hand' });
    expect(emitted).toHaveLength(0);
    for (const engine of engines.values()) expect(engine.paused).toBe(true);

    const late = new FakeEngine();
    engines.set('late', late);
    mb.adopt('late', late);
    expect(late.paused).toBe(true);
    expect(emitted, 'a late table saw an announcement with no durable promise').toHaveLength(0);

    // A concurrent/manual countdown call cannot turn an unconfirmed
    // announcement into a player-visible five-minute promise.
    await mb.beginCountdown();
    expect(mb.snapshot()).toMatchObject({ active: true, phase: 'last_hand' });
    expect(attempts).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(MaintenanceBreak.LAST_HAND_PERSIST_RETRY_INITIAL_MS);
    expect(attempts).toHaveLength(2);
    expect(emitted).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(MaintenanceBreak.LAST_HAND_PERSIST_RETRY_INITIAL_MS * 2);
    await announcing;

    expect(store.row?.phase).toBe('last_hand');
    expect(emitted.map((frame) => frame.payload.phase)).toEqual([
      'last_hand',
      'last_hand',
      'last_hand',
    ]);
    expect(mb.snapshot()).toMatchObject({ active: true, phase: 'last_hand' });
    for (const engine of engines.values()) expect(engine.paused).toBe(true);
  });

  it('honors the fixed break silently when storage cannot prove the declaration absent', async () => {
    vi.setSystemTime(new Date('2026-09-09T18:53:00.000Z'));
    const { mb, engines, store, emitted } = build(2);
    const attempts: number[] = [];
    let thawCalls = 0;
    (mb as any).deps.thaw = async () => {
      thawCalls++;
    };
    store.save = async () => {
      attempts.push(Date.now());
      throw new Error('database unavailable');
    };

    const announcedAt = Date.now();
    const announcing = mb.announceLastHand();
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(MaintenanceBreak.LAST_HAND_LEAD_MS - 1);
    expect(mb.snapshot()).toMatchObject({ active: true, phase: 'last_hand' });
    expect(emitted).toHaveLength(0);
    for (const engine of engines.values()) expect(engine.paused).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await announcing;

    expect(Date.now()).toBe(announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS);
    expect(mb.snapshot()).toMatchObject({
      active: true,
      phase: 'counting_down',
      durableConfirmed: false,
      readyForRestart: false,
      breakEndsAt:
        announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS + MaintenanceBreak.BREAK_DURATION_MS,
    });
    expect(emitted).toHaveLength(0);
    for (const engine of engines.values()) expect(engine.paused).toBe(true);

    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts.at(-1)).toBeLessThan(announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS);
    const gaps = attempts.slice(1).map((at, index) => at - attempts[index]);
    expect(gaps[0]).toBe(MaintenanceBreak.LAST_HAND_PERSIST_RETRY_INITIAL_MS);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(MaintenanceBreak.LAST_HAND_PERSIST_RETRY_MAX_MS);

    await vi.advanceTimersByTimeAsync(MaintenanceBreak.BREAK_DURATION_MS);
    expect(mb.isActive()).toBe(false);
    expect(thawCalls, 'an authoritative null row still triggered a database-wide thaw').toBe(0);
    expect(
      emitted,
      'a silent hold emitted either a false promise or false ended frame'
    ).toHaveLength(0);
    for (const engine of engines.values()) expect(engine.paused).toBe(false);
  });

  it('honors a commit whose response hangs through the boundary, then exact-clears it at :00', async () => {
    vi.setSystemTime(new Date('2026-09-09T18:53:00.000Z'));
    const { mb, engines, store, emitted } = build(1);
    const saving = deferred<void>();
    store.save = async (state) => {
      // The transaction committed, but the HTTP response never returned. This
      // is the dangerous half of an ambiguous save: absence was not proved.
      store.row = { ...state };
      await saving.promise;
    };

    const announcedAt = Date.now();
    const announcing = mb.announceLastHand();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(MaintenanceBreak.LAST_HAND_LEAD_MS - 1);
    expect(mb.isActive()).toBe(true);
    expect([...engines.values()][0].paused).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await announcing;
    expect(Date.now()).toBe(announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS);
    expect(mb.snapshot()).toMatchObject({
      active: true,
      phase: 'counting_down',
      durableConfirmed: false,
      readyForRestart: false,
    });
    expect(store.row?.phase).toBe('last_hand');
    expect([...engines.values()][0].paused).toBe(true);
    expect(emitted).toHaveLength(0);

    // Resolving the transport after :55 is not permission to emit a late frame
    // or slide the schedule. The conservative hold ends at the original :00.
    saving.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(emitted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(MaintenanceBreak.BREAK_DURATION_MS);
    expect(store.row).toBeNull();
    expect(mb.isActive()).toBe(false);
    expect([...engines.values()][0].paused).toBe(false);
  });

  it('does not emit or arm a countdown when a save completion wins after the fixed boundary', async () => {
    type Timer = { fn: () => void; ms: number };
    const timers: Timer[] = [];
    const cleared = new Set<Timer>();
    const saving = deferred<void>();
    let clock = Date.parse('2026-09-09T18:53:00.000Z');
    const engines = new Map<string, FakeEngine>([['t0', new FakeEngine()]]);
    const store = new FakeStore();
    const emitted: Array<{ tableId: string; payload: Record<string, unknown> }> = [];
    store.save = async (state) => {
      await saving.promise;
      store.row = { ...state };
    };
    const mb = new MaintenanceBreak({
      engines: () => engines.entries() as any,
      isRunning: () => true,
      emit: (tableId, payload) => emitted.push({ tableId, payload }),
      store,
      thaw: noOpThaw,
      now: () => clock,
      setTimer: ((fn: () => void, ms: number) => {
        const timer = { fn, ms };
        timers.push(timer);
        return timer as unknown as NodeJS.Timeout;
      }) as any,
      clearTimer: ((timer: NodeJS.Timeout) => cleared.add(timer as unknown as Timer)) as any,
    });

    const announcedAt = clock;
    const announcing = mb.announceLastHand(announcedAt);
    await Promise.resolve();
    expect(timers).toHaveLength(1); // persistence boundary, not countdown

    clock = announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS;
    saving.resolve();
    await announcing;

    expect(emitted).toHaveLength(0);
    expect(mb.snapshot()).toMatchObject({
      phase: 'counting_down',
      durableConfirmed: false,
      readyForRestart: false,
      breakEndsAt:
        announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS + MaintenanceBreak.BREAK_DURATION_MS,
    });
    const liveTimers = timers.filter((timer) => !cleared.has(timer));
    expect(liveTimers).toHaveLength(1);
    expect(liveTimers[0].ms).toBe(MaintenanceBreak.BREAK_DURATION_MS);
  });

  it('accepts a lost save response only after exact durable read-back', async () => {
    const { mb, store, emitted } = build(1);
    store.save = async (state) => {
      store.row = { ...state };
      throw new Error('response lost after commit');
    };

    await mb.announceLastHand();
    expect(mb.isActive()).toBe(true);
    expect(store.row?.phase).toBe('last_hand');
    expect(emitted.map((frame) => frame.payload.phase)).toEqual(['last_hand']);
  });

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
    expect(mb.snapshot().durableConfirmed).toBe(false);
    await mb.announceLastHand();
    expect(store.row?.phase).toBe('last_hand');
    expect(mb.snapshot()).toMatchObject({
      active: true,
      phase: 'last_hand',
      durableConfirmed: true,
    });
    // No end time yet: the countdown has not started and we refuse to show a
    // number we would have to take back.
    expect(store.row?.breakEndsAt).toBeNull();
  });
});

describe('the countdown', () => {
  it('keeps countdown frames and the restart gate closed until the exact phase is durable', async () => {
    const { mb, engines, store, emitted } = build(1);
    await mb.announceLastHand();
    parkAll(engines);
    const saving = deferred<void>();
    const save = store.save.bind(store);
    store.save = async (state) => {
      if (state.phase === 'counting_down') await saving.promise;
      await save(state);
    };

    const beginning = mb.beginCountdown();
    await Promise.resolve();
    expect(mb.readyForRestart()).toBe(false);
    expect(mb.snapshot()).toMatchObject({
      phase: 'counting_down',
      durableConfirmed: false,
      readyForRestart: false,
    });
    expect(emitted.map((frame) => frame.payload.phase)).toEqual(['last_hand']);

    const late = new FakeEngine();
    late.park();
    engines.set('late-countdown', late);
    mb.adopt('late-countdown', late);
    expect(late.paused).toBe(true);
    expect(emitted, 'an uncommitted countdown leaked to a newly adopted table').toHaveLength(1);

    saving.resolve();
    await beginning;
    expect(mb.readyForRestart()).toBe(true);
    expect(mb.snapshot()).toMatchObject({
      phase: 'counting_down',
      durableConfirmed: true,
      readyForRestart: true,
    });
    expect(emitted.at(-1)?.payload.phase).toBe('counting_down');
    expect(
      emitted.some(
        (frame) => frame.tableId === 'late-countdown' && frame.payload.phase === 'counting_down'
      )
    ).toBe(true);
  });

  it('holds the visible break to its fixed end when countdown persistence is ambiguous', async () => {
    const { mb, engines, store, emitted } = build(1);
    await mb.announceLastHand();
    parkAll(engines);
    store.save = async () => {
      throw new Error('countdown write failed');
    };

    await mb.beginCountdown();
    expect(mb.snapshot()).toMatchObject({
      active: true,
      phase: 'counting_down',
      durableConfirmed: false,
      readyForRestart: false,
    });
    expect([...engines.values()][0].paused).toBe(true);
    expect(emitted.map((frame) => frame.payload.phase)).toEqual(['last_hand']);
    expect(store.row?.phase).toBe('last_hand');

    await vi.advanceTimersByTimeAsync(MaintenanceBreak.BREAK_DURATION_MS);
    expect(mb.isActive()).toBe(false);
    expect([...engines.values()][0].paused).toBe(false);
    expect(emitted.map((frame) => frame.payload.type)).toEqual([
      'maintenance_break',
      'maintenance_break_ended',
    ]);
    expect(store.row).toBeNull();
  });

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
  /**
   * PHASE 2 (2026-09-02): THE GATE COUNTS A LIVE HAND, NOT A RAISED HAND.
   *
   * The gate has been wrong three times (see unparkedTables). The third: it
   * asked "has the loop reached the pause-gate promise" - so a table in its
   * 5s sleep, its seat read, or its idle broadcast, with no cards out, held
   * the gate shut. On the 17:55 break of 2026-09-02, with ZERO hands dealt
   * inside it, 64-70 such tables kept readyForRestart false for the whole
   * five minutes; the deploy gave up at :00 and restarted on live tables at
   * 18:02. The gate had never once opened on a real break.
   *
   * The honest question is "are there cards in the air". These tests never
   * call park(): reaching the gate is not what matters.
   */
  it('stays shut while any table has a hand in flight, and opens the moment the last one settles', async () => {
    const { mb, engines } = build(3);
    const list = [...engines.values()];
    list.forEach((e) => e.deal());
    await mb.announceLastHand();
    await mb.beginCountdown();

    expect(mb.readyForRestart()).toBe(false);

    list[0].finishHand();
    list[1].finishHand();
    // One table still mid-hand is enough to refuse the restart. Losing a
    // deploy window costs an hour of slightly older code; restarting here
    // voids somebody's hand.
    expect(mb.readyForRestart()).toBe(false);

    list[2].finishHand();
    // No table has reached the pause gate. None needs to: nothing is in the
    // air, so nothing can be lost.
    expect(list.every((e) => !e.atGate)).toBe(true);
    expect(mb.readyForRestart()).toBe(true);
  });

  it('opens for a QUIET table that never reaches the gate at all', async () => {
    /**
     * The production bug. A quiet table waits in the start-up loop; it only
     * checks the pause every 5s and spends the rest in a seat read, an idle
     * broadcast and a sleep. Under the second gate it counted as unparked
     * the whole time. It has no hand; it holds nothing.
     */
    const { mb, engines } = build(2);
    await mb.announceLastHand();
    await mb.beginCountdown();
    expect([...engines.values()].every((e) => !e.atGate)).toBe(true);
    expect(mb.readyForRestart()).toBe(true);
  });

  it('does not open on a raised hand: a table AT the gate with cards still out keeps it shut', async () => {
    /**
     * Defensive: if a future refactor ever makes the gate flag and the hand
     * disagree, cards in the air must win. This is the "too loose" failure
     * of the first gate, pinned from the other side.
     */
    const { mb, engines } = build(1);
    const e = [...engines.values()][0];
    e.deal();
    e.park(); // claims to be at the gate
    await mb.announceLastHand();
    await mb.beginCountdown();
    expect(mb.readyForRestart()).toBe(false);
    e.finishHand();
    expect(mb.readyForRestart()).toBe(true);
  });

  it('ignores a stopped engine: it has no hand to protect', async () => {
    const { mb, engines } = build(2);
    const list = [...engines.values()];
    list[0].deal();
    list[0].running = false;
    await mb.announceLastHand();
    await mb.beginCountdown();
    expect(mb.readyForRestart()).toBe(true);
  });

  it('fails closed when an engine cannot prove whether cards are in the air', async () => {
    const { mb, engines } = build(1);
    const engine = [...engines.values()][0];
    engine.isBetweenHands = () => {
      throw new Error('inspection failed');
    };

    await mb.announceLastHand();
    await mb.beginCountdown();

    expect(mb.snapshot().durableConfirmed).toBe(true);
    expect(mb.snapshot().unparkedTables).toBe(1);
    expect(mb.readyForRestart()).toBe(false);
    expect(mb.snapshot().readyForRestart).toBe(false);
  });

  it('shuts again once too little break remains to finish a restart inside it', async () => {
    const { mb } = build(1);
    await mb.announceLastHand();
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

  it('measures itself: unparked at countdown, the peak, and when it first opened', async () => {
    const { mb, engines, outcomes } = build(3);
    const list = [...engines.values()];
    list[0].deal();
    list[1].deal();
    await mb.announceLastHand();
    await mb.beginCountdown();
    expect(mb.readyForRestart()).toBe(false); // 2 in flight
    list[2].deal(); // a third starts one (should not happen under maintenancePaused, but measure it)
    expect(mb.readyForRestart()).toBe(false); // 3 in flight - the peak
    list.forEach((e) => e.finishHand());
    expect(mb.readyForRestart()).toBe(true);
    vi.setSystemTime(Date.now() + MaintenanceBreak.BREAK_DURATION_MS + 1000);
    await mb.end();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].unparkedAtCountdown).toBe(2);
    expect(outcomes[0].peakUnparked).toBe(3);
    expect(outcomes[0].readyForRestartAtMs).not.toBeNull();
    expect(outcomes[0].tablesResumed).toBe(3);
  });
});

describe('the end of the break', () => {
  it('fails closed when the required database thaw dependency is absent', async () => {
    const engine = new FakeEngine();
    const store = new FakeStore();
    const mb = new MaintenanceBreak({
      engines: () => new Map([['t0', engine]]).entries() as any,
      isRunning: () => true,
      emit: () => {},
      store,
    } as any);
    await mb.announceLastHand();
    await mb.beginCountdown();

    await expect(mb.end()).rejects.toThrow('maintenance_thaw_dependency_missing');
    expect(mb.isActive()).toBe(true);
    expect(engine.paused).toBe(true);
    expect(store.row).not.toBeNull();
  });

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
    vi.setSystemTime(Date.now() + MaintenanceBreak.BREAK_DURATION_MS);
    await mb.end();

    expect(events).toEqual(['thaw', 'resume']);
    expect(thawArgs!.seconds).toBeGreaterThanOrEqual(299);
    expect(thawArgs!.seconds).toBeLessThanOrEqual(301);
    expect(thawArgs!.startedAt).toBeLessThanOrEqual(started);
  });

  it('waits through the credited-through boundary before clearing or resuming', async () => {
    const { mb, engines, store } = build(1);
    let releaseTarget = 0;
    (mb as any).deps.thaw = async () => {
      releaseTarget = Date.now() + 5_000;
      return { creditedThroughAtMs: releaseTarget };
    };
    await mb.announceLastHand();
    parkAll(engines);
    await mb.beginCountdown();

    const ending = mb.end();
    for (let i = 0; i < 8 && releaseTarget === 0; i++) await Promise.resolve();
    expect(releaseTarget).toBeGreaterThan(Date.now());
    expect(mb.isActive()).toBe(true);
    expect([...engines.values()][0].paused).toBe(true);
    expect(store.clears).toBe(0);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(mb.isActive()).toBe(true);
    expect([...engines.values()][0].paused).toBe(true);
    expect(store.clears).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await ending;
    expect(Date.now()).toBe(releaseTarget);
    expect(mb.isActive()).toBe(false);
    expect([...engines.values()][0].paused).toBe(false);
    expect(store.clears).toBe(1);
  });

  it('a thaw failure keeps play frozen and resumes only after the same checkpointed thaw succeeds', async () => {
    const { mb, engines } = build(2);
    let attempts = 0;
    (mb as any).deps.thaw = async () => {
      attempts++;
      if (attempts === 1) throw new Error('PGRST002');
    };
    await mb.announceLastHand();
    parkAll(engines);
    await mb.beginCountdown();
    const ending = mb.end();
    await Promise.resolve();
    await Promise.resolve();

    expect(attempts).toBe(1);
    expect(mb.isActive()).toBe(true);
    for (const [id, e] of engines) {
      expect(e.paused, `${id} resumed before its clocks were restored`).toBe(true);
    }

    await vi.advanceTimersByTimeAsync(MaintenanceBreak.THAW_RECOVERY_RETRY_MS);
    await ending;
    expect(attempts).toBe(2);
    for (const [id, e] of engines) {
      expect(e.paused, `${id} stayed frozen after the thaw completed`).toBe(false);
    }
    expect(mb.isActive()).toBe(false);
  });

  it('credits reconnect clocks through the exact release after a thaw retry', async () => {
    vi.setSystemTime(new Date('2099-09-09T18:53:00.000Z'));
    const { mb, engines } = build(1);
    let attempts = 0;
    (mb as any).deps.thaw = async () => {
      attempts++;
      if (attempts === 1) {
        vi.setSystemTime(Date.now() + 5_000);
        throw new Error('first installment transport failed');
      }
    };

    await mb.announceLastHand();
    vi.setSystemTime(new Date('2099-09-09T18:55:00.000Z'));
    parkAll(engines);
    await mb.beginCountdown();
    const freezeStartedAt = Date.now();
    const clock = { reconnectDeadlineMs: freezeStartedAt + 30_000 };
    vi.setSystemTime(new Date('2099-09-09T19:00:00.000Z'));

    const ending = mb.end();
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(MaintenanceBreak.THAW_RECOVERY_RETRY_MS);
    await ending;

    thawReconnectClock(clock);
    expect(clock.reconnectDeadlineMs).toBe(freezeStartedAt + 30_000 + 306_000);
  });

  it('backs off and retries a transient database-clock not-due receipt', async () => {
    vi.setSystemTime(new Date('2099-10-09T18:53:00.000Z'));
    const { mb, engines } = build(1);
    let attempts = 0;
    (mb as any).deps.thaw = async () => {
      attempts++;
      if (attempts === 1) throw new ThawRefusedError('maintenance_break_not_due');
    };
    await mb.announceLastHand();
    vi.setSystemTime(new Date('2099-10-09T18:55:00.000Z'));
    parkAll(engines);
    await mb.beginCountdown();
    vi.setSystemTime(new Date('2099-10-09T19:00:00.000Z'));

    const ending = mb.end();
    await Promise.resolve();
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(MaintenanceBreak.THAW_RECOVERY_RETRY_MS - 1);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await ending;
    expect(attempts).toBe(2);
    expect(mb.isActive()).toBe(false);
  });

  it('never treats an abandonment receipt as permission to reopen', async () => {
    const { mb, engines, store } = build(1);
    let attempts = 0;
    (mb as any).deps.thaw = async (
      freezeStartedAtMs: number,
      _frozenSeconds: number,
      _signal: AbortSignal,
      identity: { ownershipToken: string }
    ) => {
      attempts += 1;
      throw new ThawAbandonedError('recovery_window_expired', {
        ok: true,
        complete: true,
        released: true,
        abandoned: true,
        freeze_started_at: new Date(freezeStartedAtMs).toISOString(),
        ownership_token: identity.ownershipToken,
      });
    };
    await mb.announceLastHand();
    parkAll(engines);
    await mb.beginCountdown();

    const ending = mb.end();
    for (let i = 0; i < 8 && attempts === 0; i++) await Promise.resolve();
    expect(attempts).toBe(1);
    expect(mb.isActive()).toBe(true);
    expect([...engines.values()][0].paused).toBe(true);
    expect(store.clears).toBe(0);

    const stopping = mb.stop();
    await ending;
    await stopping;
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
      ownershipToken: 'owner-before-restart',
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

  it('releases its OWN flag on a table another authority is holding, without dealing it', async () => {
    // A tournament add-on break runs up to ten minutes, so one starting near
    // :55 outlives this five-minute break. That table must not deal.
    //
    // It must still be RESUMED though, and this pin moved on 2026-09-03
    // because the old one ("resumeCount === 0") pinned a deadlock. Skipping
    // the table meant maintenancePaused was never cleared - and the
    // tournament's own resumeDealing() early-returns while that flag is set,
    // so neither authority could ever release the table. It sat dark until
    // reviveDeadTableEngines tore the engine down after ten minutes.
    //
    // The correct split: the break clears the flag the break set, and the
    // other authority keeps holding the gate until IT is done.
    const engines = new Map<string, FakeEngine>([
      ['cash', new FakeEngine()],
      ['mtt', new FakeEngine()],
    ]);
    // The tournament break holds `mtt` through pauseAfterHand(), which sets
    // handForHandPaused - the same flag the real engine checks.
    engines.get('mtt')!.handForHandPaused = true;
    const mb = new MaintenanceBreak({
      engines: () => engines.entries() as any,
      isRunning: () => true,
      emit: () => {},
      store: new FakeStore(),
      thaw: noOpThaw,
      shouldStayPaused: (id) => id === 'mtt',
    });

    await mb.announceLastHand();
    await mb.beginCountdown();
    await mb.end();

    expect(engines.get('cash')!.paused).toBe(false);
    // Still held - it must not deal while its own break runs.
    expect(engines.get('mtt')!.paused).toBe(true);
    // But the break DID release its own flag, so the tournament can resume it.
    expect(engines.get('mtt')!.resumeCount).toBe(1);
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

  it('resumes at the fixed end when exact clear committed but its response was lost', async () => {
    const { mb, engines, store, emitted } = build(1);
    const clear = store.clear.bind(store);
    store.clear = async (expected) => {
      await clear(expected);
      throw new Error('clear response lost after commit');
    };

    await mb.announceLastHand();
    await mb.beginCountdown();
    const fixedEnd = mb.snapshot().breakEndsAt as number;
    await vi.advanceTimersByTimeAsync(MaintenanceBreak.BREAK_DURATION_MS);

    expect(Date.now()).toBe(fixedEnd);
    expect(mb.isActive()).toBe(false);
    expect(store.row).toBeNull();
    expect([...engines.values()][0].paused).toBe(false);
    expect(emitted.map((frame) => frame.payload.type)).toEqual([
      'maintenance_break',
      'maintenance_break',
      'maintenance_break_ended',
    ]);
  });

  it('can declare the next hour when its prior exact clear failed', async () => {
    const { mb, store, engines } = build(1);
    const clear = store.clear.bind(store);
    let refuseFirstClear = true;
    store.clear = async (expected) => {
      if (refuseFirstClear) {
        refuseFirstClear = false;
        throw new Error('lost connection before exact clear');
      }
      await clear(expected);
    };

    await mb.announceLastHand();
    const processToken = store.row!.ownershipToken;
    await mb.beginCountdown();
    const firstFixedEnd = mb.snapshot().breakEndsAt as number;
    vi.setSystemTime(firstFixedEnd);
    const ending = mb.end();
    await Promise.resolve();

    // A failed clear is not permission to reopen either local play or durable
    // admission. The same phase transition retries its exact CAS until a null
    // receipt proves the boundary is gone.
    expect(Date.now()).toBe(firstFixedEnd);
    expect(store.row?.ownershipToken).toBe(processToken);
    expect(mb.isActive()).toBe(true);
    expect([...engines.values()][0].paused).toBe(true);

    await vi.advanceTimersByTimeAsync(MaintenanceBreak.THAW_RECOVERY_RETRY_MS);
    await ending;
    expect(store.row).toBeNull();
    expect(mb.isActive()).toBe(false);

    await mb.announceLastHand();
    expect(mb.isActive()).toBe(true);
    expect(store.row?.ownershipToken).toBe(processToken);

    await mb.beginCountdown();
    await vi.advanceTimersByTimeAsync(MaintenanceBreak.BREAK_DURATION_MS);
    expect(store.row).toBeNull();
  });
});

describe('the resume arrives in installments (2026-09-05)', () => {
  /**
   * At 04:00 UTC on 2026-09-05 the break ended with 318 cash and 402
   * tournament tables parked; the one core the engine has saturated inside
   * thirty seconds and the container was replaced at 04:07. The fleet is now
   * dealt into RESUME_WAVES waves, RESUME_WAVE_GAP_MS apart, cash and
   * tournament interleaved, in a stable hash order that owes nothing to who
   * is seated. Uses a controllable setTimer so the waves can be driven by
   * hand, and a controllable clock so /health's timestamps are checkable.
   */
  class KindedEngine extends FakeEngine {
    constructor(private readonly tournament: boolean) {
      super();
    }
    isTournament(): boolean {
      return this.tournament;
    }
  }

  function buildFleet(cash: number, tournaments: number) {
    const engines = new Map<string, KindedEngine>();
    // Tournament tables are adopted FIRST after a restart, and this is the
    // insertion order the old stagger followed. The waves must not.
    for (let i = 0; i < tournaments; i++) engines.set(`mtt-${i}`, new KindedEngine(true));
    for (let i = 0; i < cash; i++) engines.set(`cash-${i}`, new KindedEngine(false));
    const store = new FakeStore();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let clock = 1_800_000_000_000;
    const mb = new MaintenanceBreak({
      engines: () => engines.entries() as any,
      isRunning: () => true,
      emit: () => {},
      store,
      thaw: noOpThaw,
      now: () => clock,
      setTimer: ((fn: () => void, ms: number) => {
        timers.push({ fn, ms });
        return 0 as unknown as NodeJS.Timeout;
      }) as any,
    });
    const tick = (ms: number) => {
      clock += ms;
    };
    return { mb, engines, timers, tick };
  }

  /** Run a break to its end and return the timers end() scheduled. */
  async function runBreak(f: ReturnType<typeof buildFleet>) {
    await f.mb.announceLastHand();
    // The countdown timer is the first one scheduled; fire it by hand.
    const countdown = f.timers.shift()!;
    f.tick(countdown.ms);
    countdown.fn();
    await Promise.resolve();
    await Promise.resolve();
    // The end timer.
    const endTimer = f.timers.shift()!;
    f.tick(endTimer.ms);
    const before = f.timers.length;
    await f.mb.end();
    return f.timers.slice(before);
  }

  it('deals 720 tables into 8 waves of ~90, 1.5s apart, and the whole spread is inside the minute', async () => {
    const f = buildFleet(318, 402);
    const waveTimers = await runBreak(f);
    const list = [...f.engines.values()];

    expect(MaintenanceBreak.RESUME_WAVES).toBe(8);
    // Wave 0 fired synchronously inside end(); seven are scheduled.
    expect(waveTimers).toHaveLength(MaintenanceBreak.RESUME_WAVES - 1);
    const wave0 = list.filter((e) => e.resumeCount > 0).length;
    expect(wave0).toBeGreaterThanOrEqual(Math.floor(720 / 8));
    expect(wave0).toBeLessThanOrEqual(Math.ceil(318 / 8) + Math.ceil(402 / 8));

    // Evenly spaced, RESUME_WAVE_GAP_MS apart, last one at RESUME_SPREAD_MS.
    waveTimers.forEach((t, i) => expect(t.ms).toBe((i + 1) * MaintenanceBreak.RESUME_WAVE_GAP_MS));
    expect(waveTimers[waveTimers.length - 1].ms).toBe(MaintenanceBreak.RESUME_SPREAD_MS);
    expect(MaintenanceBreak.RESUME_SPREAD_MS).toBeLessThanOrEqual(15_000);

    for (const t of waveTimers) {
      f.tick(MaintenanceBreak.RESUME_WAVE_GAP_MS);
      t.fn();
    }
    // Every table exactly once.
    expect(list.every((e) => e.resumeCount === 1)).toBe(true);
  });

  it('interleaves cash and tournament tables: no wave is all tournaments', async () => {
    const f = buildFleet(318, 402);
    const waveTimers = await runBreak(f);
    const kinds = (): { cash: number; mtt: number } => {
      let cash = 0;
      let mtt = 0;
      for (const [id, e] of f.engines) {
        if (e.resumeCount === 0) continue;
        if (id.startsWith('mtt-')) mtt++;
        else cash++;
        e.resumeCount = 0; // consume, so each wave is measured alone
      }
      return { cash, mtt };
    };
    const w0 = kinds();
    // The old stagger's first batch was 25 tournaments, because they were
    // adopted first. Each wave now carries its share of BOTH kinds.
    expect(w0.cash).toBeGreaterThanOrEqual(Math.floor(318 / 8));
    expect(w0.mtt).toBeGreaterThanOrEqual(Math.floor(402 / 8));
    for (const t of waveTimers) {
      t.fn();
      const w = kinds();
      expect(w.cash, 'a wave with no cash table').toBeGreaterThan(0);
      expect(w.mtt, 'a wave with no tournament table').toBeGreaterThan(0);
    }
  });

  it('orders by a stable hash of the table id, not by adoption order and not by who is seated', () => {
    const mk = (ids: string[], tournament = false) =>
      ids.map((id) => [id, new KindedEngine(tournament)] as [string, KindedEngine]);
    const ids = Array.from({ length: 60 }, (_, i) => `t-${i}`);
    const a = MaintenanceBreak.planResumeWaves(mk(ids));
    const b = MaintenanceBreak.planResumeWaves(mk([...ids].reverse()));
    const flat = (w: Array<Array<[string, unknown]>>) => w.map((x) => x.map((t) => t[0]));
    // Same fleet in the opposite insertion order: identical plan.
    expect(flat(a)).toEqual(flat(b));
    // ...and not simply insertion order.
    expect(flat(a).flat()).not.toEqual(ids);
    // 60 tables at a 25-table minimum: 3 waves of 20.
    expect(a).toHaveLength(3);
    expect(a.map((w) => w.length)).toEqual([20, 20, 20]);
    // CLAUDE.md 10.5: nothing about the seats is read. The plan for a fleet
    // where every table reports humans is the plan for one where none does -
    // the planner has no way to ask, and must never get one.
    const src = MaintenanceBreak.planResumeWaves.toString();
    expect(src).not.toMatch(/humansSeated|is_horse|isHorse/);
  });

  it('brings a small fleet up in one wave, synchronously, as before', async () => {
    const f = buildFleet(10, 10);
    const waveTimers = await runBreak(f);
    expect(waveTimers).toHaveLength(0);
    expect([...f.engines.values()].every((e) => e.resumeCount === 1)).toBe(true);
    expect((f.mb.snapshot().resumeWaves as any).total).toBe(1);
  });

  it('one table that throws on resume does not hold its wave or the waves behind it', async () => {
    const f = buildFleet(60, 60);
    const bad = [...f.engines.values()].filter((_, i) => i % 7 === 0);
    for (const e of bad) {
      e.resumeFromMaintenance = () => {
        e.resumeCount++;
        throw new Error('refuses to resume');
      };
    }
    const waveTimers = await runBreak(f);
    for (const t of waveTimers) t.fn();
    const list = [...f.engines.values()];
    expect(
      list.every((e) => e.resumeCount === 1),
      'every table was offered its resume'
    ).toBe(true);
    expect(list.filter((e) => !bad.includes(e)).every((e) => e.paused === false)).toBe(true);
  });

  it('publishes resumeWaves {total, done, startedAt} on /health while the waves run', async () => {
    const f = buildFleet(318, 402);
    expect(f.mb.snapshot().resumeWaves).toBeNull();
    const waveTimers = await runBreak(f);
    const startedAt = (f.mb.snapshot().resumeWaves as any).startedAt;
    let snap = f.mb.snapshot().resumeWaves as any;
    expect(snap).toMatchObject({
      total: 8,
      done: 1,
      tables: 720,
      finishedAt: null,
      gapMs: MaintenanceBreak.RESUME_WAVE_GAP_MS,
    });
    expect(snap.tablesResumed).toBeGreaterThan(0);
    waveTimers.forEach((t, i) => {
      f.tick(MaintenanceBreak.RESUME_WAVE_GAP_MS);
      t.fn();
      snap = f.mb.snapshot().resumeWaves;
      expect(snap.done).toBe(i + 2);
    });
    expect(snap).toMatchObject({ total: 8, done: 8, tables: 720, tablesResumed: 720 });
    expect(snap.finishedAt).toBe(startedAt + MaintenanceBreak.RESUME_SPREAD_MS);
    // The record stays readable until the next break is announced.
    await f.mb.announceLastHand();
    expect(f.mb.snapshot().resumeWaves).toBeNull();
  });

  it('does not drop a wave because the outcome insert is slow at :00', async () => {
    // Review fix 2026-09-03. The waves check phase === 'idle'. end() used to
    // reach 'idle' only after `await recordOutcome(...)` - a database insert
    // made at :00, the slowest instant of the hour. A wave firing during that
    // await was silently dropped, and a dropped table parks itself again
    // forever. The break must be idle before any table is woken, so a wave
    // can fire at any point during the insert.
    const N = MaintenanceBreak.RESUME_WAVE_MIN_TABLES * 3;
    const engines = new Map<string, FakeEngine>();
    for (let i = 0; i < N; i++) engines.set(`t${i}`, new FakeEngine());
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let releaseInsert: () => void = () => {};
    const insert = new Promise<void>((r) => {
      releaseInsert = r;
    });
    const mb = new MaintenanceBreak({
      engines: () => engines.entries() as any,
      isRunning: () => true,
      emit: () => {},
      store: new FakeStore(),
      thaw: noOpThaw,
      recordOutcome: () => insert,
      setTimer: ((fn: () => void, ms: number) => {
        timers.push({ fn, ms });
        return 0 as unknown as NodeJS.Timeout;
      }) as any,
    });
    await mb.announceLastHand();
    await mb.beginCountdown();
    vi.setSystemTime(Date.now() + MaintenanceBreak.BREAK_DURATION_MS + 1000);
    const beforeEnd = timers.length;
    const ending = mb.end(); // parks on the slow insert
    for (let i = 0; i < 10 && timers.length === beforeEnd; i++) await Promise.resolve();
    const waveTimers = timers.slice(beforeEnd);
    expect(waveTimers, 'the later waves are scheduled before the insert resolves').toHaveLength(2);
    // The insert is still pending. Fire the waves NOW.
    for (const t of waveTimers) t.fn();
    const list = [...engines.values()];
    expect(
      list.filter((e) => e.resumeCount > 0).length,
      'every table resumed while the outcome insert was still in flight'
    ).toBe(N);
    releaseInsert();
    await ending;
    expect(list.every((e) => e.resumeCount === 1)).toBe(true);
  });

  it('drops a scheduled wave from a superseded break', async () => {
    const f = buildFleet(25, 25);
    const waveTimers = await runBreak(f);
    expect(waveTimers).toHaveLength(1);
    // A new break begins (bumps the resume token) before the stale wave fires.
    await f.mb.announceLastHand();
    const before = [...f.engines.values()].map((e) => e.resumeCount);
    for (const t of waveTimers) t.fn(); // stale wave - must be dropped
    const after = [...f.engines.values()].map((e) => e.resumeCount);
    expect(after).toEqual(before);
  });
});

describe('surviving the restart', () => {
  it('rotates ownership so the retiring process cannot overwrite or clear the adopted row', async () => {
    const { mb, store } = build(1);
    await mb.announceLastHand();
    const retiredState = { ...store.row! };

    const replacement = new MaintenanceBreak({
      engines: () => new Map<string, FakeEngine>().entries() as any,
      isRunning: () => true,
      emit: () => {},
      store,
      thaw: noOpThaw,
    });
    await replacement.start();

    expect(store.row?.ownershipToken).not.toBe(retiredState.ownershipToken);
    await expect(store.save({ ...retiredState, phase: 'counting_down' })).rejects.toThrow(
      'MAINTENANCE_OWNERSHIP_LOST'
    );
    await store.clear(retiredState);
    expect(store.row?.ownershipToken).not.toBe(retiredState.ownershipToken);
  });

  it('re-parks every table for what is LEFT of a break the previous engine declared', async () => {
    const { mb, engines, store } = build(3);
    store.row = {
      phase: 'counting_down',
      announcedAt: Date.now() - 4 * 60 * 1000,
      breakStartedAt: Date.now() - 60_000,
      breakEndsAt: Date.now() + 2 * 60 * 1000,
      reason: 'Scheduled Engine Maintenance',
      ownershipToken: 'owner-before-restart',
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
      ownershipToken: 'owner-before-restart',
    };
    await mb.start();
    expect([...engines.values()][0].paused).toBe(true);
    expect(mb.snapshot()).toMatchObject({
      active: true,
      phase: 'counting_down',
      durableConfirmed: true,
    });

    await vi.advanceTimersByTimeAsync(31_000);
    for (const [id, e] of engines) {
      expect(e.paused, `${id} never resumed`).toBe(false);
    }
    expect(store.row).toBeNull();
  });

  it('recovers an exact row older than fifteen minutes through thaw before reopening', async () => {
    const { mb, engines, store } = build(2);
    const mutations: string[] = [];
    store.row = {
      phase: 'counting_down',
      announcedAt: Date.now() - 23 * 60 * 1000,
      breakStartedAt: Date.now() - 21 * 60 * 1000,
      breakEndsAt: Date.now() - 16 * 60 * 1000,
      reason: 'Scheduled Engine Maintenance',
      ownershipToken: 'expired-owner',
    };
    const clear = store.clear.bind(store);
    store.clear = async (expected) => {
      mutations.push('clear');
      await clear(expected);
    };
    (mb as any).deps.thaw = async (_start: number, frozenSeconds: number) => {
      mutations.push(`thaw:${frozenSeconds}`);
      // fn_thaw_platform's release is atomic with its exact row delete.
      store.row = null;
    };
    await mb.start();

    expect(mb.isActive()).toBe(false);
    expect([...engines.values()][0].paused).toBe(false);
    expect(mutations[0]).toMatch(/^thaw:/);
    expect(Number(mutations[0].split(':')[1])).toBeGreaterThan(15 * 60);
    // The post-thaw clear call is only an absent-row receipt recovery; the
    // old age-based direct CAS cleanup never runs.
    expect(store.clears).toBe(0);
  });

  it('owns an expired row and confirms its clear before admitting play', async () => {
    const { mb, store, engines } = build(1);
    store.row = {
      phase: 'counting_down',
      announcedAt: Date.now() - 10 * 60 * 1000,
      breakStartedAt: Date.now() - 7 * 60 * 1000,
      breakEndsAt: Date.now() - 3 * 60 * 1000,
      reason: 'Scheduled Engine Maintenance',
      ownershipToken: 'retired-process-token',
    };
    const clear = store.clear.bind(store);
    let refuseFirstClear = true;
    store.clear = async (expected) => {
      if (refuseFirstClear) {
        refuseFirstClear = false;
        throw new Error('cleanup connection lost');
      }
      await clear(expected);
    };

    const starting = mb.start();
    for (let i = 0; i < 8 && !mb.isActive(); i++) await Promise.resolve();
    expect(mb.isActive()).toBe(true);
    expect([...engines.values()][0].paused).toBe(true);
    expect(store.row?.ownershipToken).not.toBe('retired-process-token');

    await vi.advanceTimersByTimeAsync(MaintenanceBreak.THAW_RECOVERY_RETRY_MS);
    await starting;
    expect(mb.isActive()).toBe(false);
    expect(store.row).toBeNull();
    expect([...engines.values()][0].paused).toBe(false);

    await mb.announceLastHand();
    expect(mb.isActive()).toBe(true);
    await mb.beginCountdown();
    await mb.end();
    expect(store.row).toBeNull();
  });

  it('does not reopen or thaw even one second before the promised end', async () => {
    const end = Date.parse('2026-09-09T19:00:00.000Z');
    let clock = end - 999;
    const store = new FakeStore();
    store.row = {
      phase: 'counting_down',
      announcedAt: end - 7 * 60_000,
      breakStartedAt: end - 5 * 60_000,
      breakEndsAt: end,
      reason: 'Scheduled Engine Maintenance',
      ownershipToken: 'retired-owner',
    };
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const engine = new FakeEngine();
    let thawCalls = 0;
    const mb = new MaintenanceBreak({
      engines: () => new Map([['t0', engine]]).entries() as any,
      isRunning: () => true,
      emit: () => {},
      store,
      now: () => clock,
      setTimer: ((fn: () => void, ms: number) => {
        const timer = { fn, ms };
        timers.push(timer);
        return timer as unknown as NodeJS.Timeout;
      }) as any,
      thaw: async () => {
        thawCalls++;
      },
    });

    await mb.start();
    expect(mb.isActive()).toBe(true);
    expect(engine.paused).toBe(true);
    expect(engine.resumeCount).toBe(0);
    expect(thawCalls).toBe(0);
    expect(store.row).not.toBeNull();
    expect(timers.some((timer) => timer.ms === 999)).toBe(true);

    clock = end;
    const ending = mb.end();
    await ending;
    expect(thawCalls).toBe(1);
    expect(mb.isActive()).toBe(false);
  });

  it('adopts a committed ownership claim whose HTTP response was lost', async () => {
    const { mb, engines, store } = build(1);
    store.row = {
      phase: 'counting_down',
      announcedAt: Date.now() - 2 * 60 * 1000,
      breakStartedAt: Date.now() - 30_000,
      breakEndsAt: Date.now() + 3 * 60 * 1000,
      reason: 'Scheduled Engine Maintenance',
      ownershipToken: 'retired-process-token',
    };
    const claim = store.claim.bind(store);
    store.claim = async (expected, replacement) => {
      await claim(expected, replacement);
      throw new Error('claim response lost after commit');
    };

    await mb.start();

    expect(store.row?.ownershipToken).not.toBe('retired-process-token');
    expect(mb.isActive()).toBe(true);
    expect([...engines.values()][0].paused).toBe(true);
  });

  it('never adopts or clears a row another process changed during the claim', async () => {
    const { mb, engines, store } = build(1);
    store.row = {
      phase: 'counting_down',
      announcedAt: Date.now() - 2 * 60 * 1000,
      breakStartedAt: Date.now() - 30_000,
      breakEndsAt: Date.now() + 3 * 60 * 1000,
      reason: 'Scheduled Engine Maintenance',
      ownershipToken: 'observed-token',
    };
    store.claim = async () => {
      store.row = { ...store.row!, ownershipToken: 'newer-process-token' };
      return null;
    };

    await expect(mb.start()).rejects.toThrow('maintenance_break_ownership_changed_before_adoption');
    expect(store.row?.ownershipToken).toBe('newer-process-token');
    expect(store.clears).toBe(0);
    expect([...engines.values()][0].paused).toBe(false);
  });

  it('rejects startup when the break row cannot be read authoritatively', async () => {
    const { mb, engines, store } = build(2);
    let loads = 0;
    store.load = async () => {
      loads++;
      throw new Error('PGRST002');
    };
    const rejected = expect(mb.start()).rejects.toThrow(
      'maintenance_break_restore_unavailable_after_3_attempts'
    );
    // The read is retried, but unknown never becomes permission to deal.
    await vi.advanceTimersByTimeAsync(
      MaintenanceBreak.RESTORE_ATTEMPTS * MaintenanceBreak.RESTORE_RETRY_MS + 10
    );
    await rejected;
    expect(loads).toBe(MaintenanceBreak.RESTORE_ATTEMPTS);
    expect(mb.isActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect([...engines.values()][0].paused).toBe(false);
  });

  it('keeps restored tables parked across the exact-clear crash window until the database releases them', async () => {
    vi.setSystemTime(new Date('2026-09-09T18:59:00.000Z'));
    const { mb, engines, store, emitted } = build(1);
    const boundary = Date.now() + 2 * 60_000;
    store.releaseBoundary = boundary;
    let thawCalls = 0;
    (mb as any).deps.thaw = async () => {
      thawCalls++;
    };

    // Models a replacement process after fn_thaw_platform committed its
    // exact row delete and future release certificate, but before the former
    // owner survived long enough to observe the credited-through boundary.
    await mb.start();

    expect(store.row).toBeNull();
    expect(mb.snapshot()).toMatchObject({
      active: true,
      phase: 'counting_down',
      durableConfirmed: false,
      breakEndsAt: boundary,
      readyForRestart: false,
    });
    expect([...engines.values()][0].paused).toBe(true);
    expect([...engines.values()][0].resumeCount).toBe(0);
    expect(thawCalls).toBe(0);
    expect(store.clears).toBe(0);
    expect(emitted).toHaveLength(0);

    // Discovery continues after start() returns. Every table rebuilt inside
    // the certificate tail must inherit the same local gate.
    const restoredLate = new FakeEngine();
    engines.set('restored-late', restoredLate);
    mb.adopt('restored-late', restoredLate);
    expect(restoredLate.paused).toBe(true);
    expect(emitted).toHaveLength(0);

    // The local clock reaching the apparent end is not release authority.
    // The database still returning the boundary keeps both tables parked and
    // re-arms a bounded receipt check rather than spinning or re-thawing.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(mb.isActive()).toBe(true);
    expect([...engines.values()].every((engine) => engine.paused)).toBe(true);
    expect(thawCalls).toBe(0);

    // Only the authoritative null receipt may reopen the fleet.
    store.releaseBoundary = null;
    await vi.advanceTimersByTimeAsync(MaintenanceBreak.THAW_RECOVERY_RETRY_MS);
    expect(mb.isActive()).toBe(false);
    expect([...engines.values()].every((engine) => !engine.paused)).toBe(true);
    expect([...engines.values()].map((engine) => engine.resumeCount)).toEqual([1, 1]);
    expect(thawCalls).toBe(0);
    expect(store.clears).toBe(0);
  });

  it('does not trust a locally fast clock after thaw exact-clears the break row', async () => {
    vi.setSystemTime(new Date('2026-09-09T18:53:00.000Z'));
    const { mb, engines, store } = build(1);
    await mb.announceLastHand();
    await mb.beginCountdown();

    const databaseBoundary = Date.parse('2026-09-09T18:58:00.000Z');
    store.releaseBoundary = databaseBoundary;
    (mb as any).deps.thaw = async () => {
      // Models fn_thaw_platform's one-transaction exact clear + certificate.
      store.row = null;
      return { creditedThroughAtMs: databaseBoundary };
    };

    // The engine is five seconds ahead. The old local-time wait calculated
    // zero here and resumed straight into database PLATFORM_FROZEN refusals.
    vi.setSystemTime(new Date('2026-09-09T18:58:05.000Z'));
    const ending = mb.end();
    await Promise.resolve();
    await Promise.resolve();

    expect(mb.isActive()).toBe(true);
    expect([...engines.values()][0].paused).toBe(true);
    expect([...engines.values()][0].resumeCount).toBe(0);

    await vi.advanceTimersByTimeAsync(MaintenanceBreak.THAW_RECOVERY_RETRY_MS);
    expect(mb.isActive()).toBe(true);
    expect([...engines.values()][0].resumeCount).toBe(0);

    store.releaseBoundary = null;
    await vi.advanceTimersByTimeAsync(MaintenanceBreak.THAW_RECOVERY_RETRY_MS);
    await ending;

    expect(mb.isActive()).toBe(false);
    expect([...engines.values()][0].paused).toBe(false);
    expect([...engines.values()][0].resumeCount).toBe(1);
  });

  it('rejects startup when the exact-clear release certificate cannot be read', async () => {
    const { mb, engines, store } = build(2);
    let boundaryLoads = 0;
    store.loadReleaseBoundary = async () => {
      boundaryLoads++;
      throw new Error('release certificate transport unavailable');
    };

    const rejected = expect(mb.start()).rejects.toThrow(
      'maintenance_break_restore_unavailable_after_3_attempts'
    );
    await vi.advanceTimersByTimeAsync(
      MaintenanceBreak.RESTORE_ATTEMPTS * MaintenanceBreak.RESTORE_RETRY_MS + 10
    );
    await rejected;

    expect(boundaryLoads).toBe(MaintenanceBreak.RESTORE_ATTEMPTS);
    expect(mb.isActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect([...engines.values()].every((engine) => !engine.paused)).toBe(true);
  });

  it('finishes an expired persisted thaw before clearing the row or admitting play', async () => {
    vi.setSystemTime(new Date('2026-09-09T18:53:00.000Z'));
    const store = new FakeStore();
    const firstEngine = new FakeEngine();
    let thawCalls = 0;
    const first = new MaintenanceBreak({
      engines: () => new Map([['first', firstEngine]]).entries() as any,
      isRunning: () => true,
      emit: () => {},
      store,
      thaw: (_startedAt, _seconds, signal) => {
        thawCalls++;
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });

    await first.announceLastHand();
    await vi.advanceTimersByTimeAsync(MaintenanceBreak.LAST_HAND_LEAD_MS);
    await first.beginCountdown();
    await vi.advanceTimersByTimeAsync(MaintenanceBreak.BREAK_DURATION_MS);
    const interruptedEnd = first.end();
    await Promise.resolve();
    expect(thawCalls).toBe(1);
    await first.stop();
    await interruptedEnd;
    expect(store.row?.phase).toBe('counting_down');
    expect(store.clears).toBe(0);

    const replacementEngine = new FakeEngine();
    let recovered: { startedAt: number; seconds: number } | null = null;
    let recoveredSeconds = -1;
    const replacement = new MaintenanceBreak({
      engines: () => new Map([['replacement', replacementEngine]]).entries() as any,
      isRunning: () => true,
      emit: () => {},
      store,
      thaw: async (startedAt, seconds) => {
        thawCalls++;
        recovered = { startedAt, seconds };
        recoveredSeconds = seconds;
      },
    });

    await replacement.start();
    expect(thawCalls).toBe(2);
    expect(recovered).not.toBeNull();
    expect(recoveredSeconds).toBe(300);
    expect(store.row).toBeNull();
    expect(store.clears).toBe(1);
    expect(replacement.isActive()).toBe(false);
    expect(replacementEngine.resumeCount).toBe(1);
  });

  it('does not publish a past countdown when ownership claim crosses the fixed end', async () => {
    const end = Date.parse('2026-09-09T19:00:00.000Z');
    let clock = end - 2_000;
    const store = new FakeStore();
    store.row = {
      phase: 'counting_down',
      announcedAt: end - 7 * 60_000,
      breakStartedAt: end - 5 * 60_000,
      breakEndsAt: end,
      reason: 'Scheduled Engine Maintenance',
      ownershipToken: 'retired-owner',
    };
    const realClaim = store.claim.bind(store);
    store.claim = async (expected, replacement) => {
      const claimed = await realClaim(expected, replacement);
      clock = end + 1;
      return claimed;
    };
    const emitted: Array<Record<string, unknown>> = [];
    let thawSeconds = 0;
    const engine = new FakeEngine();
    const mb = new MaintenanceBreak({
      engines: () => new Map([['t0', engine]]).entries() as any,
      isRunning: () => true,
      emit: (_tableId, payload) => emitted.push(payload),
      store,
      now: () => clock,
      thaw: async (_startedAt, seconds) => {
        thawSeconds = seconds;
      },
    });

    await mb.start();
    expect(thawSeconds).toBe(300);
    expect(emitted).toHaveLength(0);
    expect(store.row).toBeNull();
    expect(mb.isActive()).toBe(false);
    expect(engine.resumeCount).toBe(1);
  });

  it('does not publish a past countdown when a last-hand upgrade crosses the fixed end', async () => {
    const end = Date.parse('2026-09-09T19:00:00.000Z');
    let clock = end - 2_000;
    const store = new FakeStore();
    store.row = {
      phase: 'last_hand',
      announcedAt: end - 7 * 60_000,
      breakStartedAt: null,
      breakEndsAt: null,
      reason: 'Scheduled Engine Maintenance',
      ownershipToken: 'retired-owner',
    };
    const realSave = store.save.bind(store);
    store.save = async (state) => {
      await realSave(state);
      clock = end + 1;
    };
    const emitted: Array<Record<string, unknown>> = [];
    let thawSeconds = 0;
    const mb = new MaintenanceBreak({
      engines: () => new Map([['t0', new FakeEngine()]]).entries() as any,
      isRunning: () => true,
      emit: (_tableId, payload) => emitted.push(payload),
      store,
      now: () => clock,
      thaw: async (_startedAt, seconds) => {
        thawSeconds = seconds;
      },
    });

    await mb.start();
    expect(thawSeconds).toBe(300);
    expect(emitted).toHaveLength(0);
    expect(store.row).toBeNull();
    expect(mb.isActive()).toBe(false);
  });

  it('retries a boot-time read that fails once, and honours the break it then finds', async () => {
    // Review fix 2026-09-03. The engine boots at ~:55-:58 BECAUSE of the
    // restart, which is when the database is at its slowest; one timed-out
    // read used to mean the fleet came back dealing into a break every screen
    // was still showing. A single blip must not un-freeze the platform.
    const { mb, engines, store } = build(2);
    const realLoad = store.load.bind(store);
    store.row = {
      phase: 'counting_down',
      announcedAt: Date.now() - 3 * 60 * 1000,
      breakStartedAt: Date.now() - 60_000,
      breakEndsAt: Date.now() + 4 * 60 * 1000,
      reason: 'Scheduled Engine Maintenance',
      ownershipToken: 'owner-before-retry',
    };
    let loads = 0;
    store.load = async () => {
      loads++;
      if (loads === 1) throw new Error('canceling statement due to statement timeout');
      return realLoad();
    };
    const starting = mb.start();
    await vi.advanceTimersByTimeAsync(MaintenanceBreak.RESTORE_RETRY_MS + 10);
    await starting;
    expect(loads).toBe(2);
    expect(mb.isActive()).toBe(true);
    for (const [id, e] of engines) expect(e.paused, `${id} came back dealing`).toBe(true);
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
  it.each([
    ['America/Chicago', '2026-11-01T07:54:00.000Z', '2026-11-01T08:53:00.000Z'],
    ['America/Chicago', '2026-11-01T07:52:00.000Z', '2026-11-01T07:53:00.000Z'],
    ['Europe/Berlin', '2026-10-25T01:54:00.000Z', '2026-10-25T02:53:00.000Z'],
    ['Asia/Kathmandu', '2026-09-10T00:52:00.000Z', '2026-09-10T00:53:00.000Z'],
    ['UTC', '2026-09-10T00:53:00.000Z', '2026-09-10T01:53:00.000Z'],
    ['UTC', '2026-12-31T23:54:00.000Z', '2027-01-01T00:53:00.000Z'],
  ])('targets the next UTC :53 in %s at %s', (zone, now, expected) => {
    vi.stubEnv('TZ', zone);
    try {
      vi.setSystemTime(new Date(now));
      const { mb } = build(0);
      // @ts-expect-error - verify the actual private scheduler.
      const ms = mb.msUntilNextAnnouncement();
      expect(ms).toBe(Date.parse(expected) - Date.parse(now));
      expect(ms).toBeGreaterThan(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

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

  it('skips a scheduler callback that wakes at or after its fixed :55 boundary', async () => {
    type Timer = { fn: () => void; ms: number };
    const timers: Timer[] = [];
    let clock = Date.parse('2026-09-09T18:52:50.000Z');
    const engine = new FakeEngine();
    const store = new FakeStore();
    const emitted: Array<{ tableId: string; payload: Record<string, unknown> }> = [];
    const mb = new MaintenanceBreak({
      engines: () => new Map([['t0', engine]]).entries() as any,
      isRunning: () => true,
      emit: (tableId, payload) => emitted.push({ tableId, payload }),
      store,
      thaw: noOpThaw,
      now: () => clock,
      setTimer: ((fn: () => void, ms: number) => {
        const timer = { fn, ms };
        timers.push(timer);
        return timer as unknown as NodeJS.Timeout;
      }) as any,
    });

    await mb.start();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(10_000);

    // Event-loop pressure delayed the :53 callback beyond :55. Invoking it
    // must not turn 18:55 into a new 18:57/19:02 maintenance window.
    clock = Date.parse('2026-09-09T18:55:00.000Z');
    timers[0].fn();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.saves).toBe(0);
    expect(engine.paused).toBe(false);
    expect(emitted).toHaveLength(0);
    expect(mb.isActive()).toBe(false);
    expect(timers, 'the skipped hour did not re-arm the next fixed :53').toHaveLength(2);
    expect(clock + timers[1].ms).toBe(Date.parse('2026-09-09T19:53:00.000Z'));
  });

  it('re-arms the next wall-clock hour after retries reach the absolute boundary', async () => {
    vi.setSystemTime(new Date('2026-09-09T18:52:59.000Z'));
    const mb = new MaintenanceBreak({
      engines: () => new Map([['t0', new FakeEngine()]]).entries() as any,
      isRunning: () => true,
      emit: () => {},
      thaw: noOpThaw,
      store: {
        load: async () => null,
        loadReleaseBoundary: async () => null,
        save: async () => {
          throw new Error('database refused the announcement');
        },
        claim: async () => null,
        clear: async () => {},
      },
    });

    await mb.start();
    expect(vi.getTimerCount(), 'the first :53 was not armed').toBe(1);
    await vi.advanceTimersByTimeAsync(1000);

    expect(mb.isActive(), 'the failed first write immediately lifted the safe gate').toBe(true);
    await vi.advanceTimersByTimeAsync(MaintenanceBreak.LAST_HAND_LEAD_MS);
    expect(
      vi.getTimerCount(),
      'one exhausted persistence window cancelled every future maintenance break'
    ).toBe(2);
    expect(mb.snapshot()).toMatchObject({
      active: true,
      phase: 'counting_down',
      durableConfirmed: false,
      readyForRestart: false,
    });

    await vi.advanceTimersByTimeAsync(MaintenanceBreak.BREAK_DURATION_MS);
    expect(mb.isActive(), 'the conservative hold outlived the fixed :00 boundary').toBe(false);
    expect(vi.getTimerCount(), 'the next fixed :53 was lost at :00').toBe(1);
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
describe('the dealing loop parks for the break, not only the wait loop', () => {
  /**
   * PHASE 2 (2026-09-02). #2537 gave the break its own authority
   * (maintenancePaused) so hand-for-hand could not lift it, and wired the new
   * flag into the start-up wait loop and (via #2695) into isPausedByDesign().
   * It did NOT wire it into the two park gates in the DEALING loop, which
   * still read handForHandPaused alone - so a table that was dealing never
   * parked, only quiet tables did. Measured 21:53-21:57 on the build carrying
   * #2695: 722 / 738 / 663 / 423 hands a minute through the last-hand call,
   * against 161 / 5 / 0 on the last build that parked via hand-for-hand.
   *
   * Source-level, like the other pause laws: every park gate in the dealing
   * loop must consult maintenancePaused.
   */
  it('every awaitPauseGate call is owned by a pause authority and both maintenance gates stay wired', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '../engine/ServerTableEngineDealing.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const sites = [...src.matchAll(/await this\.awaitPauseGate\(\)/g)];
    expect(sites.length, 'the dealing loop has two park gates').toBeGreaterThanOrEqual(2);
    let maintenanceSites = 0;
    let terminalOnlySites = 0;
    for (const m of sites) {
      // Pause ownership gained an exact tournament-move owner in front of the
      // existing maintenance condition. Inspect the complete local guard, not
      // a formatting-sized fragment that can silently stop at a longer list
      // of authorities while the runtime condition remains correctly wired.
      const guard = src.slice(Math.max(0, m.index! - 500), m.index!);
      const hasMaintenance = /maintenancePaused/.test(guard);
      const hasTerminalCloseout = /terminalCloseoutPaused/.test(guard);
      expect(
        guard,
        'an awaitPauseGate call without a named pause authority can park or release the wrong hand: ' +
          guard.trim().slice(-120)
      ).toMatch(/maintenancePaused|terminalCloseoutPaused/);
      if (hasMaintenance) maintenanceSites++;
      if (hasTerminalCloseout && !hasMaintenance) terminalOnlySites++;
    }
    expect(
      maintenanceSites,
      'both between-hand maintenance gates remain wired'
    ).toBeGreaterThanOrEqual(2);
    expect(
      terminalOnlySites,
      'the final-table closeout rechecks may be terminal-only and must remain explicit'
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('the maintenance owner cannot outlive shutdown', () => {
  const deferred = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  };

  it('joins an in-progress boot and cannot arm its schedule after stop wins', async () => {
    const loading = deferred<PersistedMaintenanceBreak | null>();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const engine = new FakeEngine();
    const mb = new MaintenanceBreak({
      engines: () => new Map([['t0', engine]]).entries() as any,
      isRunning: () => true,
      emit: () => {},
      thaw: noOpThaw,
      store: {
        load: () => loading.promise,
        loadReleaseBoundary: async () => null,
        save: async () => {},
        claim: async () => null,
        clear: async () => {},
      },
      setTimer: ((fn: () => void, ms: number) => {
        timers.push({ fn, ms });
        return { fn, ms } as unknown as NodeJS.Timeout;
      }) as any,
    });

    const firstStart = mb.start();
    expect(mb.start()).toBe(firstStart);
    const firstStop = mb.stop();
    expect(mb.stop()).toBe(firstStop);
    let stopped = false;
    void firstStop.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped, 'stop returned while the boot read was still alive').toBe(false);

    loading.resolve(null);
    await Promise.all([firstStart, firstStop]);
    expect(timers, 'the losing starter armed a post-shutdown announcement').toHaveLength(0);

    mb.adopt('late', engine);
    expect(engine.paused, 'a stopped owner still adopted a late engine').toBe(false);
    await expect(mb.start()).rejects.toThrow(/cannot be restarted/i);
  });

  it('joins an announced break persist and cannot arm the countdown after stop', async () => {
    const saving = deferred<void>();
    type Timer = { fn: () => void; ms: number };
    const timers: Timer[] = [];
    const cleared = new Set<Timer>();
    let saveStarted = false;
    const mb = new MaintenanceBreak({
      engines: () => new Map([['t0', new FakeEngine()]]).entries() as any,
      isRunning: () => true,
      emit: () => {},
      thaw: noOpThaw,
      store: {
        load: async () => null,
        loadReleaseBoundary: async () => null,
        save: () => {
          saveStarted = true;
          return saving.promise;
        },
        claim: async () => null,
        clear: async () => {},
      },
      setTimer: ((fn: () => void, ms: number) => {
        const timer = { fn, ms };
        timers.push(timer);
        return timer as unknown as NodeJS.Timeout;
      }) as any,
      clearTimer: ((timer: NodeJS.Timeout) => cleared.add(timer as unknown as Timer)) as any,
    });

    await mb.start();
    expect(timers).toHaveLength(1);
    timers[0].fn();
    expect(saveStarted).toBe(true);

    const stopping = mb.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped, 'stop returned while the scheduled save was still alive').toBe(false);
    expect(timers, 'the in-flight save did not own an absolute boundary timer').toHaveLength(2);
    expect(cleared.has(timers[1]), 'stop left the persistence deadline armed').toBe(true);

    saving.resolve();
    await stopping;
    expect(
      timers,
      'the announcement armed either its countdown or the next wall-clock pass after shutdown'
    ).toHaveLength(2);
  });

  it('joins a thaw already in flight and never resumes an engine after stop', async () => {
    type Timer = { fn: () => void; ms: number };
    const timers: Timer[] = [];
    const cleared = new Set<Timer>();
    const engines = new Map<string, FakeEngine>([['t0', new FakeEngine()]]);
    let thawStarted = false;
    let thawAborted = false;
    const mb = new MaintenanceBreak({
      engines: () => engines.entries() as any,
      isRunning: () => true,
      emit: () => {},
      store: new FakeStore(),
      thaw: (_startedAt, _seconds, signal) => {
        thawStarted = true;
        return new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            thawAborted = true;
            reject(signal.reason);
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              thawAborted = true;
              reject(signal.reason);
            },
            { once: true }
          );
          void resolve;
        });
      },
      setTimer: ((fn: () => void, ms: number) => {
        const timer = { fn, ms };
        timers.push(timer);
        return timer as unknown as NodeJS.Timeout;
      }) as any,
      clearTimer: ((timer: NodeJS.Timeout) => cleared.add(timer as unknown as Timer)) as any,
    });

    await mb.announceLastHand();
    const countdown = timers.find(
      (timer) => timer.ms === MaintenanceBreak.LAST_HAND_LEAD_MS && !cleared.has(timer)
    );
    expect(countdown).toBeDefined();
    countdown!.fn();
    await Promise.resolve();
    await Promise.resolve();
    const endTimer = timers.find(
      (timer) => timer.ms === MaintenanceBreak.BREAK_DURATION_MS && !cleared.has(timer)
    );
    expect(endTimer).toBeDefined();
    endTimer!.fn();
    expect(thawStarted).toBe(true);

    const stopping = mb.stop();
    await stopping;
    expect(thawAborted, 'stop did not cancel the maintenance-owned thaw request').toBe(true);
    expect(
      engines.get('t0')!.resumeCount,
      'shutdown allowed the thaw continuation to wake play'
    ).toBe(0);
  });

  it('aborts a stalled outcome receipt and releases shutdown ownership', async () => {
    type Timer = { fn: () => void; ms: number };
    const timers: Timer[] = [];
    const cleared = new Set<Timer>();
    const engine = new FakeEngine();
    const store = new FakeStore();
    const emitted: Array<Record<string, unknown>> = [];
    let outcomeStarted = false;
    let outcomeAborted = false;
    const mb = new MaintenanceBreak({
      engines: () => new Map([['t0', engine]]).entries() as any,
      isRunning: () => true,
      emit: (_tableId, payload) => emitted.push(payload),
      store,
      thaw: noOpThaw,
      recordOutcome: (_outcome, signal) => {
        outcomeStarted = true;
        return new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            outcomeAborted = true;
            reject(signal.reason);
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              outcomeAborted = true;
              reject(signal.reason);
            },
            { once: true }
          );
        });
      },
      setTimer: ((fn: () => void, ms: number) => {
        const timer = { fn, ms };
        timers.push(timer);
        return timer as unknown as NodeJS.Timeout;
      }) as any,
      clearTimer: ((timer: NodeJS.Timeout) => cleared.add(timer as unknown as Timer)) as any,
    });

    await mb.announceLastHand();
    await mb.beginCountdown();
    const endTimer = timers.find(
      (timer) => timer.ms === MaintenanceBreak.BREAK_DURATION_MS && !cleared.has(timer)
    );
    expect(endTimer).toBeDefined();
    const ending = mb.end();
    for (let i = 0; i < 8 && !outcomeStarted; i++) await Promise.resolve();
    expect(outcomeStarted).toBe(true);
    expect(store.clears, 'the durable freeze was not released before the resume').toBe(1);

    await mb.stop();
    await ending;
    expect(outcomeAborted, 'stop did not cancel the outcome receipt request').toBe(true);
    expect(engine.resumeCount, 'the outcome receipt delayed the table resume').toBe(1);
    expect(
      emitted.some((payload) => payload.type === 'maintenance_break_ended'),
      'the stopped owner emitted an ended frame'
    ).toBe(false);
    expect(store.clears, 'the stopped owner mutated the store after shutdown').toBe(1);
    expect(store.row).toBeNull();
  });

  it('clears and invalidates every pending resume-wave timer', async () => {
    type Timer = { fn: () => void; ms: number };
    const timers: Timer[] = [];
    const cleared = new Set<Timer>();
    const engines = new Map<string, FakeEngine>();
    for (let i = 0; i < 60; i++) engines.set(`t${i}`, new FakeEngine());
    const mb = new MaintenanceBreak({
      engines: () => engines.entries() as any,
      isRunning: () => true,
      emit: () => {},
      store: new FakeStore(),
      thaw: noOpThaw,
      setTimer: ((fn: () => void, ms: number) => {
        const timer = { fn, ms };
        timers.push(timer);
        return timer as unknown as NodeJS.Timeout;
      }) as any,
      clearTimer: ((timer: NodeJS.Timeout) => {
        cleared.add(timer as unknown as Timer);
      }) as any,
    });

    await mb.announceLastHand();
    await mb.beginCountdown();
    await mb.end();
    const waveTimers = timers.filter(
      (timer) =>
        timer.ms > 0 &&
        timer.ms <= MaintenanceBreak.RESUME_SPREAD_MS &&
        timer.ms % MaintenanceBreak.RESUME_WAVE_GAP_MS === 0
    );
    expect(waveTimers).toHaveLength(2);
    const resumedBeforeStop = [...engines.values()].reduce(
      (n, engine) => n + engine.resumeCount,
      0
    );

    await mb.stop();
    expect(waveTimers.every((timer) => cleared.has(timer))).toBe(true);
    for (const timer of waveTimers) timer.fn();
    expect([...engines.values()].reduce((n, engine) => n + engine.resumeCount, 0)).toBe(
      resumedBeforeStop
    );
  });
});

describe('the real engine treats a maintenance pause as paused', () => {
  const TBL = 'aaaaaaaa-1111-2222-3333-444444444444';

  // Loading the real engine is the expensive part, not the assertions. On a
  // busy CI runner the first dynamic import alone has taken longer than the
  // 10s test budget, so the first case in this block timed out while the four
  // behind it (module already cached) passed. Pay the load once, in setup,
  // with a budget that is about loading and not about the pause predicate.
  // The FIRST construction is expensive too: the constructor pulls in the
  // Supabase client and the rest of the engine's lazily-initialised services,
  // and on the shared 4-vCPU runner box that alone has exceeded the 10s budget
  // (2026-09-02 22:33 UTC, run 33689794287: the import was already hoisted and
  // the first case still timed out). Pay it here, once, so every case below
  // measures the pause predicate and nothing else.
  let ServerTableEngine: any;
  beforeAll(async () => {
    ({ ServerTableEngine } = await import('../engine/ServerTableEngine.js'));
    new ServerTableEngine(TBL);
  }, 120_000);

  // A generous per-case budget for the same reason: none of these cases does
  // any real work, but a saturated runner can stall any of them for seconds.
  const SLOW_RUNNER_MS = 60_000;

  it(
    'is not paused before anything asks it to be',
    async () => {
      const e = new ServerTableEngine(TBL) as any;
      expect(e.isPausedByDesign()).toBe(false);
    },
    SLOW_RUNNER_MS
  );

  it(
    'is paused by design while the maintenance break holds it',
    async () => {
      const e = new ServerTableEngine(TBL) as any;
      e.pauseForMaintenance(300_000);
      expect(
        e.isPausedByDesign(),
        'the turn loop and the table watchdog both read this. False here means the ' +
          'break deals hands through itself and the watchdog rebuilds every parked table.'
      ).toBe(true);
    },
    SLOW_RUNNER_MS
  );

  it(
    'stops being paused when the break lifts',
    async () => {
      const e = new ServerTableEngine(TBL) as any;
      e.pauseForMaintenance(300_000);
      e.resumeFromMaintenance();
      expect(e.isPausedByDesign()).toBe(false);
    },
    SLOW_RUNNER_MS
  );

  it(
    'still reports the hand-for-hand pause it always did',
    async () => {
      // The maintenance authority is additive; it must not shadow the original.
      const e = new ServerTableEngine(TBL) as any;
      e.pauseAfterHand(120_000);
      expect(e.isPausedByDesign()).toBe(true);
    },
    SLOW_RUNNER_MS
  );

  it(
    'a hand-for-hand resume cannot unpause a table the break is holding',
    async () => {
      // The reason the break got its own authority in the first place.
      const e = new ServerTableEngine(TBL) as any;
      e.pauseForMaintenance(300_000);
      e.resumeDealing();
      expect(e.isPausedByDesign()).toBe(true);
    },
    SLOW_RUNNER_MS
  );
});
