import { describe, it, expect, beforeEach } from 'vitest';
import { PreActionEngine } from './PreActionEngine.js';

/**
 * PreActionEngine had no test file at all, while deciding — with the player not
 * looking at the screen — how much of their money moves. These pin the contract
 * that matters: a pre-action is a PROMISE, and the engine may never commit more
 * than the player agreed to.
 */

const T = 'table-1';
const P = 'player-1';

describe('PreActionEngine — auto_call respects maxCallAmount (A9)', () => {
  let eng: PreActionEngine;
  beforeEach(() => {
    eng = new PreActionEngine();
  });

  it('THE A9 BUG: a shove larger than the stack no longer bypasses the cap', () => {
    eng.setPreAction(T, P, 'auto_call', 50);
    // Facing 5,000 with a 1,000 stack: this used to fall through to the all-in
    // branch, which never looked at maxCallAmount, and commit the WHOLE stack.
    const r = eng.executePreAction(T, P, false, 5000, 1000);

    expect(r.executed).toBe(false);
    expect(r.invalidated).toBe(true);
    expect(r.amount).toBeUndefined();
    expect(r.reason).toMatch(/exceeds pre-set max/i);
  });

  it('still calls normally when the bet is within the cap', () => {
    eng.setPreAction(T, P, 'auto_call', 50);
    const r = eng.executePreAction(T, P, false, 40, 1000);
    expect(r.executed).toBe(true);
    expect(r.action).toBe('call');
    expect(r.amount).toBe(40);
  });

  it('caps the committed amount at the stack for an in-cap all-in', () => {
    // Agreed to 500, faces 400, but only has 250 — a legitimate all-in call.
    eng.setPreAction(T, P, 'auto_call', 500);
    const r = eng.executePreAction(T, P, false, 400, 250);
    expect(r.executed).toBe(true);
    expect(r.action).toBe('call');
    expect(r.amount).toBe(250);
  });

  it('treats the cap as a limit on the BET, not on what gets committed', () => {
    // A player who agreed to 50 has not agreed to an all-in "for 50" against a
    // 5,000 bet — they have declined the hand.
    eng.setPreAction(T, P, 'auto_call', 50);
    const r = eng.executePreAction(T, P, false, 5000, 50);
    expect(r.invalidated).toBe(true);
    expect(r.executed).toBe(false);
  });

  it('checks for free rather than calling, cap or no cap', () => {
    eng.setPreAction(T, P, 'auto_call', 50);
    const r = eng.executePreAction(T, P, true, 0, 1000);
    expect(r.executed).toBe(true);
    expect(r.action).toBe('check');
  });

  it('with no cap set, an all-in call still commits the stack', () => {
    eng.setPreAction(T, P, 'auto_call');
    const r = eng.executePreAction(T, P, false, 5000, 1000);
    expect(r.executed).toBe(true);
    expect(r.action).toBe('call');
    expect(r.amount).toBe(1000);
  });

  it('emits PRE_ACTION_INVALIDATED with the call_exceeds_max reason', () => {
    const events: Array<{ type: string; reason?: string }> = [];
    const e2 = new PreActionEngine((ev) => events.push(ev as never));
    e2.setPreAction(T, P, 'auto_call', 50);
    e2.executePreAction(T, P, false, 5000, 1000);
    expect(events.some((ev) => ev.type === 'PRE_ACTION_INVALIDATED' && ev.reason === 'call_exceeds_max')).toBe(true);
  });
});

describe('PreActionEngine — auto_call_any is deliberately uncapped', () => {
  let eng: PreActionEngine;
  beforeEach(() => {
    eng = new PreActionEngine();
  });

  it('commits the whole stack against a shove, by design', () => {
    // 'auto_call_any' is documented "Call any amount (dangerous!)" — it has no
    // cap by definition, so this must NOT inherit the auto_call guard.
    eng.setPreAction(T, P, 'auto_call_any');
    const r = eng.executePreAction(T, P, false, 5000, 1000);
    expect(r.executed).toBe(true);
    expect(r.amount).toBe(1000);
  });
});

describe('PreActionEngine — lifecycle', () => {
  let eng: PreActionEngine;
  beforeEach(() => {
    eng = new PreActionEngine();
  });

  it('a pre-action fires at most once', () => {
    eng.setPreAction(T, P, 'auto_call', 500);
    expect(eng.executePreAction(T, P, false, 100, 1000).executed).toBe(true);
    expect(eng.executePreAction(T, P, false, 100, 1000).executed).toBe(false);
  });

  it('clearPreAction stops it from firing', () => {
    eng.setPreAction(T, P, 'auto_call', 500);
    eng.clearPreAction(T, P);
    expect(eng.executePreAction(T, P, false, 100, 1000).executed).toBe(false);
  });

  it('an unknown player is a no-op, not a throw', () => {
    expect(eng.executePreAction(T, 'nobody', false, 100, 1000).executed).toBe(false);
  });
});
