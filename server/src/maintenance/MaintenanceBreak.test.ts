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
  const outcomes: MaintenanceBreakOutcome[] = [];
  const mb = new MaintenanceBreak({
    engines: () => engines.entries() as any,
    isRunning: () => true,
    emit: (tableId, payload) => emitted.push({ tableId, payload }),
    store,
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
    vi.advanceTimersByTime(MaintenanceBreak.BREAK_DURATION_MS + 1000);
    await mb.end();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].unparkedAtCountdown).toBe(2);
    expect(outcomes[0].peakUnparked).toBe(3);
    expect(outcomes[0].readyForRestartAtMs).not.toBeNull();
    expect(outcomes[0].tablesResumed).toBe(3);
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
      recordOutcome: () => insert,
      setTimer: ((fn: () => void, ms: number) => {
        timers.push({ fn, ms });
        return 0 as unknown as NodeJS.Timeout;
      }) as any,
    });
    await mb.announceLastHand();
    await mb.beginCountdown();
    vi.advanceTimersByTime(MaintenanceBreak.BREAK_DURATION_MS + 1000);
    const beforeEnd = timers.length;
    const ending = mb.end(); // parks on the slow insert
    await Promise.resolve();
    await Promise.resolve();
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
    let loads = 0;
    store.load = async () => {
      loads++;
      throw new Error('PGRST002');
    };
    const starting = mb.start();
    // The read is retried before the engine gives up (review fix 2026-09-03).
    await vi.advanceTimersByTimeAsync(
      MaintenanceBreak.RESTORE_ATTEMPTS * MaintenanceBreak.RESTORE_RETRY_MS + 10
    );
    await starting;
    expect(loads).toBe(MaintenanceBreak.RESTORE_ATTEMPTS);
    expect(mb.isActive()).toBe(false);
    expect([...engines.values()][0].paused).toBe(false);
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
  it('every awaitPauseGate call in the dealing loop is guarded by maintenancePaused', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '../engine/ServerTableEngineDealing.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const sites = [...src.matchAll(/await this\.awaitPauseGate\(\)/g)];
    expect(sites.length, 'the dealing loop has two park gates').toBeGreaterThanOrEqual(2);
    for (const m of sites) {
      const guard = src.slice(Math.max(0, m.index! - 220), m.index!);
      expect(
        guard,
        'a park gate that ignores maintenancePaused deals through the break: ' +
          guard.trim().slice(-120)
      ).toMatch(/maintenancePaused/);
    }
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
