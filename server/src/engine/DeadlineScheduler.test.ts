import { describe, it, expect, beforeEach } from 'vitest';
import { DeadlineScheduler, DeadlineHeap } from './DeadlineScheduler.js';

// ─── Mocked time + interval harness ───────────────────────────────────────────

function makeHarness() {
  let now = 1_000_000;
  let intervalCb: (() => void) | null = null;
  let handleCount = 0;
  const setIntervalFn = (cb: () => void, _ms: number) => {
    intervalCb = cb;
    handleCount++;
    return handleCount as unknown as ReturnType<typeof setInterval>;
  };
  const clearIntervalFn = () => {
    intervalCb = null;
  };
  return {
    nowFn: () => now,
    advance(ms: number) {
      now += ms;
    },
    setNow(v: number) {
      now = v;
    },
    tick() {
      if (intervalCb) intervalCb();
    },
    get intervalRegistered() {
      return intervalCb !== null;
    },
    setIntervalFn,
    clearIntervalFn,
  };
}

// ─── DeadlineHeap ─────────────────────────────────────────────────────────────

describe('DeadlineHeap', () => {
  it('pops in deadline order', () => {
    const h = new DeadlineHeap();
    h.push({ tableId: 't', eventId: 'c', deadlineMs: 300, callback: () => {} });
    h.push({ tableId: 't', eventId: 'a', deadlineMs: 100, callback: () => {} });
    h.push({ tableId: 't', eventId: 'b', deadlineMs: 200, callback: () => {} });
    expect(h.pop()?.eventId).toBe('a');
    expect(h.pop()?.eventId).toBe('b');
    expect(h.pop()?.eventId).toBe('c');
    expect(h.pop()).toBeUndefined();
  });

  it('remove by (tableId, eventId) preserves heap property', () => {
    const h = new DeadlineHeap();
    for (let i = 10; i > 0; i--) {
      h.push({ tableId: 't', eventId: `e${i}`, deadlineMs: i * 100, callback: () => {} });
    }
    h.remove('t', 'e5');
    // Pop everything; should come out in order 100,200,300,400,600,700,800,900,1000
    const order: number[] = [];
    let d;
    while ((d = h.pop())) order.push(d.deadlineMs);
    expect(order).toEqual([100, 200, 300, 400, 600, 700, 800, 900, 1000]);
  });

  it('remove on unknown key is a no-op', () => {
    const h = new DeadlineHeap();
    h.push({ tableId: 't', eventId: 'a', deadlineMs: 100, callback: () => {} });
    expect(h.remove('t', 'unknown')).toBeUndefined();
    expect(h.size()).toBe(1);
  });

  it('removeTable drops every entry for that table', () => {
    const h = new DeadlineHeap();
    h.push({ tableId: 't1', eventId: 'a', deadlineMs: 100, callback: () => {} });
    h.push({ tableId: 't2', eventId: 'a', deadlineMs: 200, callback: () => {} });
    h.push({ tableId: 't1', eventId: 'b', deadlineMs: 300, callback: () => {} });
    expect(h.removeTable('t1')).toBe(2);
    expect(h.size()).toBe(1);
    expect(h.peek()?.tableId).toBe('t2');
  });

  it('listTable filters by tableId', () => {
    const h = new DeadlineHeap();
    h.push({ tableId: 't1', eventId: 'a', deadlineMs: 100, callback: () => {} });
    h.push({ tableId: 't2', eventId: 'a', deadlineMs: 200, callback: () => {} });
    expect(h.listTable('t1')).toHaveLength(1);
    expect(h.listTable('t2')).toHaveLength(1);
    expect(h.listTable('unknown')).toHaveLength(0);
  });
});

// ─── DeadlineScheduler ───────────────────────────────────────────────────────

describe('DeadlineScheduler', () => {
  let harness: ReturnType<typeof makeHarness>;
  let sched: DeadlineScheduler;

  beforeEach(() => {
    harness = makeHarness();
    sched = new DeadlineScheduler({
      tickMs: 100,
      now: harness.nowFn,
      setInterval: harness.setIntervalFn,
      clearInterval: harness.clearIntervalFn,
    });
    sched.start();
  });

  it('start registers the tick interval exactly once', () => {
    expect(harness.intervalRegistered).toBe(true);
    sched.start(); // idempotent
    expect(harness.intervalRegistered).toBe(true);
  });

  it('fires a deadline at or after its deadlineMs', () => {
    let fired = false;
    sched.schedule({
      tableId: 't',
      eventId: 'turn',
      deadlineMs: harness.nowFn() + 500,
      callback: () => {
        fired = true;
      },
    });
    expect(fired).toBe(false);
    // Tick at t+100: not yet
    harness.advance(100);
    harness.tick();
    expect(fired).toBe(false);
    // Tick at t+500: fires
    harness.advance(400);
    harness.tick();
    expect(fired).toBe(true);
  });

  it('re-scheduling same (tableId, eventId) replaces prior deadline', () => {
    let count = 0;
    const cb = () => {
      count++;
    };
    sched.schedule({
      tableId: 't',
      eventId: 'turn',
      deadlineMs: harness.nowFn() + 200,
      callback: cb,
    });
    // Re-schedule with later deadline and different callback
    let count2 = 0;
    const cb2 = () => {
      count2++;
    };
    sched.schedule({
      tableId: 't',
      eventId: 'turn',
      deadlineMs: harness.nowFn() + 600,
      callback: cb2,
    });
    harness.advance(300);
    harness.tick();
    expect(count).toBe(0); // original was replaced
    harness.advance(400);
    harness.tick();
    expect(count2).toBe(1);
  });

  it('cancel removes a pending deadline', () => {
    let fired = false;
    sched.schedule({
      tableId: 't',
      eventId: 'turn',
      deadlineMs: harness.nowFn() + 200,
      callback: () => {
        fired = true;
      },
    });
    sched.cancel('t', 'turn');
    harness.advance(500);
    harness.tick();
    expect(fired).toBe(false);
  });

  it('cancel on unknown key is a no-op', () => {
    expect(() => sched.cancel('nope', 'nope')).not.toThrow();
  });

  it('cancelAll drops every deadline for a table', () => {
    let fired = 0;
    for (let i = 0; i < 5; i++) {
      sched.schedule({
        tableId: 't1',
        eventId: `e${i}`,
        deadlineMs: harness.nowFn() + 100 * (i + 1),
        callback: () => {
          fired++;
        },
      });
    }
    sched.schedule({
      tableId: 't2',
      eventId: 'e',
      deadlineMs: harness.nowFn() + 100,
      callback: () => {
        fired++;
      },
    });
    const removed = sched.cancelAll('t1');
    expect(removed).toBe(5);
    harness.advance(1000);
    harness.tick();
    expect(fired).toBe(1); // only t2's one survived
  });

  it('tick fires no more than maxFirePerTick per tick', () => {
    const s = new DeadlineScheduler({
      tickMs: 100,
      maxFirePerTick: 3,
      now: harness.nowFn,
      setInterval: harness.setIntervalFn,
      clearInterval: harness.clearIntervalFn,
    });
    s.start();
    let fired = 0;
    for (let i = 0; i < 10; i++) {
      s.schedule({
        tableId: 't',
        eventId: `e${i}`,
        deadlineMs: harness.nowFn() + 10,
        callback: () => {
          fired++;
        },
      });
    }
    harness.advance(20);
    expect(s.tickNow()).toBe(3);
    expect(fired).toBe(3);
    expect(s.tickNow()).toBe(3);
    expect(s.tickNow()).toBe(3);
    expect(s.tickNow()).toBe(1);
    expect(fired).toBe(10);
  });

  it('throwing callback does not stop the scheduler', () => {
    let otherFired = false;
    sched.schedule({
      tableId: 't',
      eventId: 'bad',
      deadlineMs: harness.nowFn() + 100,
      callback: () => {
        throw new Error('boom');
      },
    });
    sched.schedule({
      tableId: 't',
      eventId: 'good',
      deadlineMs: harness.nowFn() + 200,
      callback: () => {
        otherFired = true;
      },
    });
    // Silence console
    const origErr = console.error;
    console.error = () => {};
    harness.advance(300);
    harness.tick();
    console.error = origErr;
    expect(otherFired).toBe(true);
  });

  it('persistPending returns JSON-ready entries for a table only', () => {
    sched.schedule({
      tableId: 't1',
      eventId: 'turn',
      deadlineMs: 5000,
      callback: () => {},
    });
    sched.schedule({
      tableId: 't1',
      eventId: 'timebank:u1',
      deadlineMs: 8000,
      callback: () => {},
    });
    sched.schedule({
      tableId: 't2',
      eventId: 'turn',
      deadlineMs: 6000,
      callback: () => {},
    });
    const t1 = sched.persistPending('t1');
    expect(t1).toEqual([
      { eventId: 'turn', deadlineMs: 5000 },
      { eventId: 'timebank:u1', deadlineMs: 8000 },
    ]);
    const t2 = sched.persistPending('t2');
    expect(t2).toEqual([{ eventId: 'turn', deadlineMs: 6000 }]);
  });

  it('rehydrate reinstalls with supplied callbacks; past-due fires on next tick', () => {
    harness.setNow(10_000);
    const persisted = [
      { eventId: 'past', deadlineMs: 9000 }, // already past
      { eventId: 'future', deadlineMs: 11_000 },
      { eventId: 'unknown', deadlineMs: 9500 }, // lookup returns undefined
    ];
    let firedPast = false;
    let firedFuture = false;
    sched.rehydrate('t', persisted, (eventId) => {
      if (eventId === 'past')
        return () => {
          firedPast = true;
        };
      if (eventId === 'future')
        return () => {
          firedFuture = true;
        };
      return undefined;
    });
    // Immediately: nothing has fired yet, scheduler needs a tick
    expect(firedPast).toBe(false);
    expect(firedFuture).toBe(false);
    // Next tick fires past (already due) and leaves future alone
    harness.tick();
    expect(firedPast).toBe(true);
    expect(firedFuture).toBe(false);
    // Advance to future deadline
    harness.advance(2000);
    harness.tick();
    expect(firedFuture).toBe(true);
  });

  it('stop clears the interval and drops pending deadlines', () => {
    sched.schedule({
      tableId: 't',
      eventId: 'e',
      deadlineMs: harness.nowFn() + 100,
      callback: () => {},
    });
    expect(sched.size()).toBe(1);
    sched.stop();
    expect(sched.size()).toBe(0);
    expect(harness.intervalRegistered).toBe(false);
  });

  it('size + nextDeadlineMs metrics', () => {
    expect(sched.size()).toBe(0);
    expect(sched.nextDeadlineMs()).toBeUndefined();
    sched.schedule({ tableId: 't', eventId: 'a', deadlineMs: 10_000, callback: () => {} });
    sched.schedule({ tableId: 't', eventId: 'b', deadlineMs: 5_000, callback: () => {} });
    expect(sched.size()).toBe(2);
    expect(sched.nextDeadlineMs()).toBe(5_000);
  });

  it('tick drift correction: deadline 1000ms past fires within the same tick', () => {
    let fired = false;
    sched.schedule({
      tableId: 't',
      eventId: 'late',
      deadlineMs: harness.nowFn() - 1000,
      callback: () => {
        fired = true;
      },
    });
    harness.tick();
    expect(fired).toBe(true);
  });

  it('multiple deadlines at the same time both fire in one tick', () => {
    let a = false,
      b = false,
      c = false;
    const t = harness.nowFn() + 100;
    sched.schedule({
      tableId: 't',
      eventId: 'a',
      deadlineMs: t,
      callback: () => {
        a = true;
      },
    });
    sched.schedule({
      tableId: 't',
      eventId: 'b',
      deadlineMs: t,
      callback: () => {
        b = true;
      },
    });
    sched.schedule({
      tableId: 't',
      eventId: 'c',
      deadlineMs: t,
      callback: () => {
        c = true;
      },
    });
    harness.advance(150);
    harness.tick();
    expect([a, b, c]).toEqual([true, true, true]);
  });
});
