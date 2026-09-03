import { describe, it, expect, beforeEach } from 'vitest';
import { DisconnectEngine } from './DisconnectEngine.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
import { DeadlineScheduler } from './DeadlineScheduler.js';

/*
 * CONNECTIVITY HARDENING REGRESSIONS (2026-08-22)
 *
 * Pins the fixes from the connectivity/freeze deep-dive. Each block names the
 * production failure it guards against.
 */

function mkScheduler() {
  let now = 2_000_000;
  const sched = new DeadlineScheduler({
    tickMs: 100,
    now: () => now,
    setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => {},
  });
  sched.start();
  return {
    sched,
    nowFn: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('DisconnectEngine.registerPlayer is idempotent across hands', () => {
  let h: ReturnType<typeof mkScheduler>;
  let timer: PreciseActionTimer;
  let eng: DisconnectEngine;

  beforeEach(() => {
    h = mkScheduler();
    timer = new PreciseActionTimer(undefined, h.sched, h.nowFn);
    eng = new DisconnectEngine(timer);
    eng.configure('t1', {});
  });

  it('a disconnected player stays disconnected when re-registered at hand start', () => {
    // Hand 1 deals - player registered, then their transport drops.
    eng.registerPlayer('t1', 'p1');
    eng.markDisconnected('t1', 'p1');
    expect(eng.isConnected('t1', 'p1')).toBe(false);

    // Hand 2 deals - the per-hand register loop runs again. The old code
    // re-created the state with isConnected: true, so onPlayerTurn skipped the
    // fast 30s disconnect countdown and the table burned the full clock.
    eng.registerPlayer('t1', 'p1');
    expect(eng.isConnected('t1', 'p1')).toBe(false);
  });

  it('a sat-out player stays sat out when re-registered at hand start', () => {
    eng.registerPlayer('t1', 'p1');
    eng.sitOut('t1', 'p1', 'forced');
    expect(eng.isSittingOut('t1', 'p1')).toBe(true);

    // Tournament sit-outs ARE dealt in and re-registered every hand. The old
    // code wiped isSittingOut here, so a sat-out tournament seat burned a
    // full clock every orbit instead of insta-folding.
    eng.registerPlayer('t1', 'p1');
    expect(eng.isSittingOut('t1', 'p1')).toBe(true);
  });

  it('unregister + register produces a fresh state (leaving really resets)', () => {
    eng.registerPlayer('t1', 'p1');
    eng.sitOut('t1', 'p1', 'forced');
    eng.unregisterPlayer('t1', 'p1');
    eng.registerPlayer('t1', 'p1');
    expect(eng.isSittingOut('t1', 'p1')).toBe(false);
    expect(eng.isConnected('t1', 'p1')).toBe(true);
  });
});

describe('PreciseActionTimer.clearTable leaves namespaced countdowns alone', () => {
  let h: ReturnType<typeof mkScheduler>;
  let timer: PreciseActionTimer;

  beforeEach(() => {
    h = mkScheduler();
    timer = new PreciseActionTimer(undefined, h.sched, h.nowFn);
  });

  it('clears plain turn timers but not timebank:/disconnect: entries', () => {
    // TimeBankEngine and DisconnectEngine register through this same API
    // under namespaced ids. clearTable runs at every HAND_COMPLETE (and from
    // clearTurnTimer mid-hand); cancelling the namespaced entries left e.g. a
    // time bank flagged active with no countdown behind it, so
    // rearmTurnTimerIfCurrent bailed and a reconnecting player got no clock.
    timer.startTimer('t1', 'p1', 15_000);
    timer.startTimer('t1', 'timebank:p2', 20_000);
    timer.startTimer('t1', 'disconnect:p3', 30_000);

    timer.clearTable('t1');

    expect(timer.hasTimer('t1', 'p1')).toBe(false);
    expect(timer.hasTimer('t1', 'timebank:p2')).toBe(true);
    expect(timer.hasTimer('t1', 'disconnect:p3')).toBe(true);
  });

  it('dispose still cancels everything including namespaced entries', () => {
    timer.startTimer('t1', 'p1', 15_000);
    timer.startTimer('t1', 'timebank:p2', 20_000);
    timer.dispose();
    expect(timer.hasTimer('t1', 'p1')).toBe(false);
    expect(timer.hasTimer('t1', 'timebank:p2')).toBe(false);
  });
});

describe('hand-boundary countdown cleanup (2026-08-22 review)', () => {
  it('DisconnectEngine.cancelAllCountdowns cancels timers without touching state', () => {
    const h = mkScheduler();
    const timer = new PreciseActionTimer(undefined, h.sched, h.nowFn);
    const eng = new DisconnectEngine(timer);
    eng.configure('t1', {});
    eng.registerPlayer('t1', 'p1');
    eng.markDisconnected('t1', 'p1');
    // Simulate a pending countdown registered under the namespaced id.
    timer.startTimer('t1', 'disconnect:p1', 30_000);
    expect(timer.hasTimer('t1', 'disconnect:p1')).toBe(true);

    eng.cancelAllCountdowns('t1');

    // The countdown is gone (cannot fire a phantom strike into the next
    // hand)...
    expect(timer.hasTimer('t1', 'disconnect:p1')).toBe(false);
    // ...but connection state is untouched.
    expect(eng.isConnected('t1', 'p1')).toBe(false);
  });
});
