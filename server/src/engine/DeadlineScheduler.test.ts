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

// ═══════════════════════════════════════════════════════════════════════════════
// C18 — indexed heap + tick budget
//
// Every heap mutation used to be O(n) in the TOTAL pending deadlines across all
// tables: remove() did an Array.findIndex, removeTable()/listTable() a full
// filter. That is the hottest path in the engine — arming a turn timer calls
// schedule(), which is remove-then-push, and every table re-arms a heartbeat
// every 10s — so the cost grew with the square of the table count.
//
// The risk in adding an index is that it silently drifts out of step with the
// array during a sift, which would turn cancel() into a no-op and leave a
// cancelled timer to fire. So these tests assert the invariant directly via
// assertConsistent() rather than inferring it from behaviour.
// ═══════════════════════════════════════════════════════════════════════════════

function mkDeadline(tableId: string, eventId: string, deadlineMs: number, onFire?: () => void) {
  return { tableId, eventId, deadlineMs, callback: onFire ?? (() => {}) };
}

describe('DeadlineHeap - C18 index integrity', () => {
  it('stays consistent through pushes, removes and pops', () => {
    const h = new DeadlineHeap();
    for (let i = 0; i < 50; i++) h.push(mkDeadline(`t${i % 7}`, `e${i}`, 1000 + ((i * 37) % 100)));
    h.assertConsistent();

    for (let i = 0; i < 50; i += 3) h.remove(`t${i % 7}`, `e${i}`);
    h.assertConsistent();

    while (h.size() > 10) h.pop();
    h.assertConsistent();
  });

  it('pops in deadline order after heavy churn', () => {
    const h = new DeadlineHeap();
    // Deterministic pseudo-shuffle — no Math.random, so a failure reproduces.
    let x = 12345;
    const next = () => (x = (x * 1103515245 + 12345) & 0x7fffffff);

    const live = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const t = `t${next() % 12}`;
      const e = `e${next() % 500}`;
      const ms = 1000 + (next() % 5000);
      h.push(mkDeadline(t, e, ms));
      live.set(`${t}|${e}`, ms);
      if (i % 5 === 0 && live.size > 0) {
        const victim = [...live.keys()][next() % live.size];
        const [vt, ve] = victim.split('|');
        h.remove(vt, ve);
        live.delete(victim);
      }
    }
    h.assertConsistent();
    expect(h.size()).toBe(live.size);

    const order: number[] = [];
    let d = h.pop();
    while (d) {
      order.push(d.deadlineMs);
      d = h.pop();
    }
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order).toHaveLength(live.size);
    h.assertConsistent();
  });

  it('a re-push of the same key replaces rather than duplicating', () => {
    const h = new DeadlineHeap();
    h.push(mkDeadline('t1', 'turn', 5000));
    h.push(mkDeadline('t1', 'turn', 2000));
    expect(h.size()).toBe(1);
    expect(h.peek()!.deadlineMs).toBe(2000);
    h.assertConsistent();
  });

  it('removeTable drops exactly one table and leaves the rest intact', () => {
    const h = new DeadlineHeap();
    for (let i = 0; i < 30; i++)
      h.push(mkDeadline(i % 3 === 0 ? 'doomed' : `t${i}`, `e${i}`, 1000 + i));
    const doomed = h.listTable('doomed').length;
    expect(doomed).toBe(10);

    expect(h.removeTable('doomed')).toBe(10);
    expect(h.listTable('doomed')).toEqual([]);
    expect(h.size()).toBe(20);
    expect(h.listAll().some((d) => d.tableId === 'doomed')).toBe(false);
    h.assertConsistent();

    // Idempotent on an unknown / already-cleared table
    expect(h.removeTable('doomed')).toBe(0);
    expect(h.removeTable('never-existed')).toBe(0);
    h.assertConsistent();
  });

  it('listTable returns only that table, without scanning everyone', () => {
    const h = new DeadlineHeap();
    h.push(mkDeadline('a', 'e1', 1000));
    h.push(mkDeadline('b', 'e1', 1001));
    h.push(mkDeadline('a', 'e2', 1002));
    const a = h.listTable('a');
    expect(a.map((d) => d.eventId).sort()).toEqual(['e1', 'e2']);
    expect(h.listTable('nobody')).toEqual([]);
  });

  it('removing the last remaining entry empties every index', () => {
    const h = new DeadlineHeap();
    h.push(mkDeadline('t', 'only', 1000));
    expect(h.remove('t', 'only')).toBeDefined();
    expect(h.size()).toBe(0);
    expect(h.listTable('t')).toEqual([]);
    h.assertConsistent();
    // and a second remove is a safe no-op
    expect(h.remove('t', 'only')).toBeUndefined();
  });

  it('clear() wipes the indexes too', () => {
    const h = new DeadlineHeap();
    for (let i = 0; i < 10; i++) h.push(mkDeadline('t', `e${i}`, 1000 + i));
    h.clear();
    expect(h.size()).toBe(0);
    expect(h.listTable('t')).toEqual([]);
    h.assertConsistent();
  });
});

describe('DeadlineScheduler - C18 tick budget', () => {
  it('fires a large burst without the old 128-per-tick ceiling', () => {
    const harness = makeHarness();
    const s = new DeadlineScheduler({
      now: harness.nowFn,
      setInterval: harness.setIntervalFn,
      clearInterval: harness.clearIntervalFn,
    });
    s.start();

    let fired = 0;
    for (let i = 0; i < 1000; i++) {
      s.schedule({
        tableId: `t${i}`,
        eventId: 'turn',
        deadlineMs: harness.nowFn() + 50,
        callback: () => {
          fired++;
        },
      });
    }
    harness.advance(100);
    harness.tick();
    // The old default (128) would have left 872 deadlines late.
    expect(fired).toBe(1000);
  });

  it('stops early once the wall-clock budget is spent, and resumes next tick', () => {
    const harness = makeHarness();
    // Each callback costs 5 virtual ms; a 20 ms budget therefore admits a
    // handful per tick, not the whole queue.
    const s = new DeadlineScheduler({
      now: harness.nowFn,
      setInterval: harness.setIntervalFn,
      clearInterval: harness.clearIntervalFn,
      maxTickBudgetMs: 20,
    });
    s.start();

    let fired = 0;
    for (let i = 0; i < 50; i++) {
      s.schedule({
        tableId: `t${i}`,
        eventId: 'turn',
        deadlineMs: harness.nowFn() + 10,
        callback: () => {
          fired++;
          harness.advance(5);
        },
      });
    }

    harness.advance(20);
    harness.tick();
    const afterFirst = fired;
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterFirst).toBeLessThan(50); // budget bit

    // Nothing is lost — subsequent ticks drain the rest.
    for (let i = 0; i < 40 && fired < 50; i++) harness.tick();
    expect(fired).toBe(50);
  });

  it('always fires at least one deadline per tick, even with a zero budget', () => {
    const harness = makeHarness();
    const s = new DeadlineScheduler({
      now: harness.nowFn,
      setInterval: harness.setIntervalFn,
      clearInterval: harness.clearIntervalFn,
      maxTickBudgetMs: 0,
    });
    s.start();
    let fired = 0;
    for (let i = 0; i < 3; i++) {
      s.schedule({
        tableId: `t${i}`,
        eventId: 'turn',
        deadlineMs: harness.nowFn() + 10,
        callback: () => {
          fired++;
          harness.advance(1);
        },
      });
    }
    harness.advance(20);
    harness.tick();
    // Forward progress is guaranteed — a zero budget must not deadlock the queue.
    expect(fired).toBe(1);
    harness.tick();
    expect(fired).toBe(2);
  });
});
