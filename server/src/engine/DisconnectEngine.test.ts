import { describe, it, expect, beforeEach } from 'vitest';
import { DisconnectEngine } from './DisconnectEngine.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
import { DeadlineScheduler } from './DeadlineScheduler.js';

/*
 * PR-E specifically tests the FSM projection (getFsmState,
 * getFsmStatesForTable). The existing PreciseActionTimer + DeadlineScheduler
 * unit tests cover the timer behaviors underneath.
 */

function mkScheduler() {
  let now = 2_000_000;
  let cb: (() => void) | null = null;
  const sched = new DeadlineScheduler({
    tickMs: 100,
    now: () => now,
    setInterval: (fn) => { cb = fn; return 1 as any; },
    clearInterval: () => { cb = null; },
  });
  sched.start();
  return {
    sched,
    nowFn: () => now,
    advance(ms: number) { now += ms; },
  };
}

describe('DisconnectEngine FSM projection (PR-E)', () => {
  let h: ReturnType<typeof mkScheduler>;
  let timer: PreciseActionTimer;
  let eng: DisconnectEngine;

  beforeEach(() => {
    h = mkScheduler();
    timer = new PreciseActionTimer(undefined, h.sched, h.nowFn);
    eng = new DisconnectEngine(timer);
    eng.configure('t', { disconnectTimeoutSeconds: 30 });
    eng.registerPlayer('t', 'p1');
  });

  it('CONNECTED by default after register', () => {
    const fsm = eng.getFsmState('t', 'p1');
    expect(fsm?.state).toBe('CONNECTED');
    expect(fsm?.graceDeadlineMs).toBeNull();
  });

  it('MISSING immediately after markDisconnected, within grace', () => {
    eng.markDisconnected('t', 'p1');
    const fsm = eng.getFsmState('t', 'p1');
    expect(fsm?.state).toBe('MISSING');
    expect(fsm?.graceDeadlineMs).toBeGreaterThan(0);
  });

  it('DISCONNECTED once grace window has elapsed', () => {
    // DisconnectEngine uses Date.now() internally. Monkey-patch it BEFORE
    // markDisconnected so disconnectedAt is stored on the mocked clock, then
    // advance past the grace window on that same clock.
    const realNow = Date.now;
    try {
      (Date as any).now = () => h.nowFn();
      eng.markDisconnected('t', 'p1');
      h.advance(31_000);
      const fsm = eng.getFsmState('t', 'p1');
      expect(fsm?.state).toBe('DISCONNECTED');
    } finally {
      (Date as any).now = realNow;
    }
  });

  it('SAT_OUT overrides connection state', () => {
    eng.sitOut('t', 'p1');
    expect(eng.getFsmState('t', 'p1')?.state).toBe('SAT_OUT');
    eng.markDisconnected('t', 'p1');
    expect(eng.getFsmState('t', 'p1')?.state).toBe('SAT_OUT');
  });

  it('getFsmStatesForTable returns a map keyed by userId', () => {
    eng.registerPlayer('t', 'p2');
    eng.registerPlayer('t', 'p3');
    eng.markDisconnected('t', 'p2');
    eng.sitOut('t', 'p3');
    const map = eng.getFsmStatesForTable('t');
    expect(Object.keys(map).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(map.p1.state).toBe('CONNECTED');
    expect(map.p2.state).toBe('MISSING');
    expect(map.p3.state).toBe('SAT_OUT');
  });

  it('scopes to the given tableId only', () => {
    eng.registerPlayer('t2', 'p1');
    const map = eng.getFsmStatesForTable('t');
    expect(Object.keys(map)).toEqual(['p1']);
    expect(map.p1.state).toBe('CONNECTED');
    const map2 = eng.getFsmStatesForTable('t2');
    expect(Object.keys(map2)).toEqual(['p1']);
  });

  it('unknown (tableId, playerId) returns null', () => {
    expect(eng.getFsmState('t', 'ghost')).toBeNull();
    expect(eng.getFsmState('ghostTable', 'p1')).toBeNull();
  });

  it('heartbeat restores CONNECTED from MISSING', () => {
    eng.markDisconnected('t', 'p1');
    expect(eng.getFsmState('t', 'p1')?.state).toBe('MISSING');
    eng.heartbeat('t', 'p1');
    expect(eng.getFsmState('t', 'p1')?.state).toBe('CONNECTED');
  });
});
