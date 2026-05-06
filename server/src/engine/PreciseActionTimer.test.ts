import { describe, it, expect, beforeEach } from 'vitest';
import { PreciseActionTimer } from './PreciseActionTimer.js';
import { DeadlineScheduler } from './DeadlineScheduler.js';

// Mocked time + interval so we can drive the scheduler deterministically.
function makeScheduler() {
  let now = 1_000_000;
  let intervalCb: (() => void) | null = null;
  const sched = new DeadlineScheduler({
    tickMs: 100,
    now: () => now,
    setInterval: (cb) => {
      intervalCb = cb;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {
      intervalCb = null;
    },
  });
  sched.start();
  return {
    sched,
    nowFn: () => now,
    advance(ms: number) {
      now += ms;
    },
    tick() {
      if (intervalCb) intervalCb();
    },
  };
}

describe('PreciseActionTimer (DeadlineScheduler backend)', () => {
  let h: ReturnType<typeof makeScheduler>;
  let events: Array<{ type: string; playerId: string }>;
  let timer: PreciseActionTimer;

  beforeEach(() => {
    h = makeScheduler();
    events = [];
    timer = new PreciseActionTimer(
      (e) => events.push({ type: e.type, playerId: e.playerId }),
      h.sched,
      h.nowFn
    );
  });

  it('startTimer emits TIMER_STARTED and registers a deadline with the scheduler', () => {
    timer.startTimer('t', 'p1', 500);
    expect(events.map((e) => e.type)).toEqual(['TIMER_STARTED']);
    expect(h.sched.size()).toBe(1);
    expect(h.sched.nextDeadlineMs()).toBe(h.nowFn() + 500);
  });

  it('expiry fires onExpiry callback at the deadline tick', () => {
    let fired = false;
    timer.startTimer('t', 'p1', 500, () => {
      fired = true;
    });
    h.advance(499);
    h.tick();
    expect(fired).toBe(false);
    h.advance(2);
    h.tick();
    expect(fired).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['TIMER_STARTED', 'TIMER_EXPIRED']);
    expect(h.sched.size()).toBe(0);
  });

  it('cancelTimer removes from scheduler and emits TIMER_CANCELLED', () => {
    let fired = false;
    timer.startTimer('t', 'p1', 500, () => {
      fired = true;
    });
    timer.cancelTimer('t', 'p1');
    expect(h.sched.size()).toBe(0);
    h.advance(1000);
    h.tick();
    expect(fired).toBe(false);
    expect(events.map((e) => e.type)).toEqual(['TIMER_STARTED', 'TIMER_CANCELLED']);
  });

  it('re-starting the same timer replaces the scheduler entry', () => {
    timer.startTimer('t', 'p1', 500);
    timer.startTimer('t', 'p1', 1000);
    // Only one deadline in scheduler; second replaces first
    expect(h.sched.size()).toBe(1);
    expect(h.sched.nextDeadlineMs()).toBe(h.nowFn() + 1000);
    // Events emitted: START, CANCEL (implicit by cancelTimer inside startTimer), START
    expect(events.map((e) => e.type)).toEqual([
      'TIMER_STARTED',
      'TIMER_CANCELLED',
      'TIMER_STARTED',
    ]);
  });

  it('extendTimer pushes the deadline out and re-schedules', () => {
    let fired = false;
    timer.startTimer('t', 'p1', 500, () => {
      fired = true;
    });
    h.advance(400);
    timer.extendTimer('t', 'p1', 1000);
    expect(h.sched.nextDeadlineMs()).toBe(h.nowFn() - 400 + 500 + 1000);
    // Should NOT fire at original deadline
    h.advance(200);
    h.tick();
    expect(fired).toBe(false);
    // Fires at new extended deadline
    h.advance(1000);
    h.tick();
    expect(fired).toBe(true);
  });

  it('pauseTimer cancels scheduler entry; resumeTimer re-registers at new deadline', () => {
    let fired = false;
    timer.startTimer('t', 'p1', 500, () => {
      fired = true;
    });
    h.advance(200);
    timer.pauseTimer('t', 'p1');
    expect(h.sched.size()).toBe(0);
    // Even if we advance past the original deadline, nothing fires
    h.advance(10_000);
    h.tick();
    expect(fired).toBe(false);
    // Resume: 300ms remaining from when we paused (500-200)
    timer.resumeTimer('t', 'p1');
    expect(h.sched.size()).toBe(1);
    expect(h.sched.nextDeadlineMs()).toBe(h.nowFn() + 300);
    h.advance(300);
    h.tick();
    expect(fired).toBe(true);
  });

  it('getRemainingMs reflects paused state', () => {
    timer.startTimer('t', 'p1', 500);
    h.advance(200);
    expect(timer.getRemainingMs('t', 'p1')).toBe(300);
    timer.pauseTimer('t', 'p1');
    h.advance(10_000);
    expect(timer.getRemainingMs('t', 'p1')).toBe(300);
    timer.resumeTimer('t', 'p1');
    h.advance(100);
    expect(timer.getRemainingMs('t', 'p1')).toBe(200);
  });

  it('clearTable cancels every timer for a tableId in both Map and scheduler', () => {
    timer.startTimer('t1', 'a', 1000);
    timer.startTimer('t1', 'b', 2000);
    timer.startTimer('t2', 'a', 3000);
    timer.clearTable('t1');
    expect(timer.hasTimer('t1', 'a')).toBe(false);
    expect(timer.hasTimer('t1', 'b')).toBe(false);
    expect(timer.hasTimer('t2', 'a')).toBe(true);
    expect(h.sched.size()).toBe(1);
  });

  it('dispose clears all without stopping the shared scheduler', () => {
    timer.startTimer('t', 'p1', 500);
    timer.startTimer('t', 'p2', 600);
    timer.dispose();
    expect(h.sched.size()).toBe(0);
    // Scheduler itself is still alive — register a new entry to prove it
    h.sched.schedule({
      tableId: 'x',
      eventId: 'y',
      deadlineMs: h.nowFn() + 100,
      callback: () => {},
    });
    expect(h.sched.size()).toBe(1);
  });

  it('expired timer with no onExpiry still emits TIMER_EXPIRED and cleans up', () => {
    timer.startTimer('t', 'p1', 500);
    h.advance(600);
    h.tick();
    expect(events.map((e) => e.type)).toEqual(['TIMER_STARTED', 'TIMER_EXPIRED']);
    expect(timer.hasTimer('t', 'p1')).toBe(false);
  });

  it('cancelled-between-schedule-and-tick: scheduler fires but onExpired returns early', () => {
    let fired = false;
    timer.startTimer('t', 'p1', 500, () => {
      fired = true;
    });
    // Simulate the scheduler still holding a pending entry (legitimate race
    // if cancel happens after scheduler peek but before fire). Directly
    // delete the Map entry but leave scheduler alone.
    (timer as any).deadlines.clear();
    h.advance(600);
    h.tick();
    expect(fired).toBe(false); // onExpired early-returned
  });
});
