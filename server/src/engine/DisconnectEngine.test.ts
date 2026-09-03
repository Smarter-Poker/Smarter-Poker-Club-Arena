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
    setInterval: (fn) => {
      cb = fn;
      return 1 as any;
    },
    clearInterval: () => {
      cb = null;
    },
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

/**
 * B10 — restoring the FSM after a crash.
 *
 * disconnect_states has been written into every hand snapshot for a long time
 * and read back only to be counted in a log line. The engine restarted
 * believing every seated player was CONNECTED, so anyone who had dropped
 * before the crash was handed a full turn clock on every orbit until the
 * heartbeat checker re-detected them — the table paying that absent player's
 * entire think-time, every hand.
 */
describe('DisconnectEngine.restoreFsmStates (B10)', () => {
  let h: ReturnType<typeof mkScheduler>;
  let timer: PreciseActionTimer;
  let eng: DisconnectEngine;

  beforeEach(() => {
    h = mkScheduler();
    timer = new PreciseActionTimer(undefined, h.sched, h.nowFn);
    eng = new DisconnectEngine(timer);
  });

  it('restores a DISCONNECTED player instead of assuming they are back', () => {
    const droppedAt = Date.now() - 10 * 60_000; // long past any grace window
    const n = eng.restoreFsmStates('t', {
      p1: { state: 'DISCONNECTED', sinceMs: droppedAt, graceDeadlineMs: droppedAt + 30_000 },
    });
    expect(n).toBe(1);
    expect(eng.getFsmState('t', 'p1')?.state).toBe('DISCONNECTED');
  });

  it('continues the ORIGINAL grace window rather than granting a fresh one', () => {
    // Dropped a moment ago: still inside grace, so MISSING, not DISCONNECTED.
    const justDropped = Date.now() - 1_000;
    eng.restoreFsmStates('t', {
      p1: { state: 'MISSING', sinceMs: justDropped, graceDeadlineMs: justDropped + 30_000 },
    });
    const fsm = eng.getFsmState('t', 'p1');
    expect(fsm?.state).toBe('MISSING');
    // The window is anchored to when the player actually dropped — a restart
    // must not hand an absent player a brand-new grace period.
    expect(fsm!.graceDeadlineMs!).toBeLessThan(Date.now() + 30_000);
  });

  it('restores CONNECTED and SAT_OUT verbatim', () => {
    const n = eng.restoreFsmStates('t', {
      p1: { state: 'CONNECTED', sinceMs: Date.now(), graceDeadlineMs: null },
      p2: { state: 'SAT_OUT', sinceMs: Date.now(), graceDeadlineMs: null },
    });
    expect(n).toBe(2);
    expect(eng.getFsmState('t', 'p1')?.state).toBe('CONNECTED');
    expect(eng.getFsmState('t', 'p2')?.state).toBe('SAT_OUT');
  });

  it('never clobbers a player who has already reconnected', () => {
    // Live observation first — this player is demonstrably back.
    eng.registerPlayer('t', 'p1');
    eng.heartbeat('t', 'p1');
    expect(eng.getFsmState('t', 'p1')?.state).toBe('CONNECTED');

    const n = eng.restoreFsmStates('t', {
      p1: { state: 'DISCONNECTED', sinceMs: Date.now() - 60_000, graceDeadlineMs: null },
    });
    expect(n).toBe(0);
    expect(eng.getFsmState('t', 'p1')?.state).toBe('CONNECTED');
  });

  it('is a safe no-op on empty or malformed input', () => {
    expect(eng.restoreFsmStates('t', {})).toBe(0);
    expect(eng.restoreFsmStates('t', { p1: undefined as never })).toBe(0);
    expect(eng.getFsmState('t', 'p1')).toBeNull();
  });

  it('round-trips through getFsmStatesForTable', () => {
    const dropped = Date.now() - 5_000;
    eng.restoreFsmStates('t', {
      p1: { state: 'MISSING', sinceMs: dropped, graceDeadlineMs: dropped + 30_000 },
      p2: { state: 'CONNECTED', sinceMs: Date.now(), graceDeadlineMs: null },
    });
    const projected = eng.getFsmStatesForTable('t');
    expect(Object.keys(projected).sort()).toEqual(['p1', 'p2']);
    expect(projected.p1.state).toBe('MISSING');
    expect(projected.p2.state).toBe('CONNECTED');
  });
});
