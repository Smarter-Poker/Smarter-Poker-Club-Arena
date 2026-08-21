/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AFK SIT-OUT — every timeout counts, and tournaments still deal you in.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two live-observed bugs pinned here (2026-08-21):
 *
 * 1. TIME-BANK EXPIRY NEVER COUNTED A STRIKE. The 2026-07-19 audit fix wired
 *    recordConnectedTimeout into the PLAIN timer-expiry path only. An AFK
 *    player with time-bank uses left never reaches that path — the bank
 *    auto-activates and expiry resolves in the time-bank block instead. Result
 *    observed live: one player's timers grinding at four stale tables at once,
 *    burning a full time bank every hand, never sat out. BOTH expiry paths
 *    must record the timeout.
 *
 * 2. A SAT-OUT TOURNAMENT PLAYER WAS EXCLUDED FROM THE DEAL. Cash semantics
 *    (skip the hand entirely) applied to tournaments would freeze the sat-out
 *    stack: no blind-off, no elimination, a tournament that can never end.
 *    Tournament sit-outs are dealt in, post blinds, and are insta-folded by
 *    DisconnectEngine.onPlayerTurn when action reaches them.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DisconnectEngine } from './DisconnectEngine.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
import { DeadlineScheduler } from './DeadlineScheduler.js';

const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8');

// ── Behavioral: the strike/auto-sit-out machinery itself ─────────────────────

function mkEngine() {
  let now = 2_000_000;
  const sched = new DeadlineScheduler({
    tickMs: 100,
    now: () => now,
    setInterval: () => 1 as any,
    clearInterval: () => {},
  });
  sched.start();
  const timer = new PreciseActionTimer(undefined, sched, () => now);
  return new DisconnectEngine(timer);
}

describe('AFK strikes and forced sit-out', () => {
  let eng: DisconnectEngine;

  beforeEach(() => {
    eng = mkEngine();
    eng.configure('t', { disconnectTimeoutSeconds: 30 });
    eng.registerPlayer('t', 'p1');
  });

  it('three connected timeouts force a sit-out', () => {
    eng.recordConnectedTimeout('t', 'p1');
    eng.recordConnectedTimeout('t', 'p1');
    expect(eng.isSittingOut('t', 'p1')).toBe(false);
    eng.recordConnectedTimeout('t', 'p1');
    expect(eng.isSittingOut('t', 'p1')).toBe(true);
    expect(eng.getFsmState('t', 'p1')?.state).toBe('SAT_OUT');
  });

  it('a voluntary action resets the streak', () => {
    eng.recordConnectedTimeout('t', 'p1');
    eng.recordConnectedTimeout('t', 'p1');
    eng.recordPlayerActed('t', 'p1');
    eng.recordConnectedTimeout('t', 'p1');
    eng.recordConnectedTimeout('t', 'p1');
    expect(eng.isSittingOut('t', 'p1')).toBe(false);
  });

  it("a sat-out player's turn is auto-resolved instantly, not timed", () => {
    const actions: Array<{ playerId: string; action: string; reason: string }> = [];
    eng.onAutoAction('t', (a) => actions.push(a));
    eng.sitOut('t', 'p1', 'forced');
    const canAct = eng.onPlayerTurn('t', 'p1', /* canCheck */ false);
    expect(canAct).toBe(false);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ playerId: 'p1', action: 'fold', reason: 'sitting_out' });
  });

  it('sitBack clears both the flag and the streak', () => {
    eng.recordConnectedTimeout('t', 'p1');
    eng.recordConnectedTimeout('t', 'p1');
    eng.recordConnectedTimeout('t', 'p1');
    expect(eng.isSittingOut('t', 'p1')).toBe(true);
    eng.sitBack('t', 'p1');
    expect(eng.isSittingOut('t', 'p1')).toBe(false);
    eng.recordConnectedTimeout('t', 'p1');
    eng.recordConnectedTimeout('t', 'p1');
    expect(eng.isSittingOut('t', 'p1')).toBe(false); // streak restarted from 0
  });
});

// ── Source pins: the wiring that history shows drifts ────────────────────────

describe('both timer-expiry paths count the timeout (bug 1)', () => {
  it('ServerTableEngineTurns records a strike on plain-timer AND time-bank expiry', () => {
    const turns = strip(read('src/engine/ServerTableEngineTurns.ts'));
    const hits = turns.match(/disconnectEngine\.recordConnectedTimeout\(/g) || [];
    expect(
      hits.length,
      'expected recordConnectedTimeout in BOTH the plain-timer and time-bank expiry paths'
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('tournament sit-outs are dealt in and blinded off (bug 2)', () => {
  it('the deal roster only excludes sit-outs at CASH tables', () => {
    const dealing = strip(read('src/engine/ServerTableEngineDealing.ts'));
    expect(dealing).toMatch(/dealInWhileSittingOut\s*=\s*this\.isTournamentTable\(\)/);
    expect(dealing).toMatch(
      /dealInWhileSittingOut\s*\|\|\s*!this\.disconnectEngine\.isSittingOut/
    );
  });

  it('dealableCount, blind rotation, and the watchdog all agree', () => {
    const base = strip(read('src/engine/ServerTableEngineBase.ts'));
    const turns = strip(read('src/engine/ServerTableEngineTurns.ts'));
    // Each gated exclusion reads: (isTournamentTable() || !isSittingOut(...))
    const gated = /this\.isTournamentTable\(\)\s*\|\|\s*!this\.disconnectEngine\.isSittingOut/g;
    expect((base.match(gated) || []).length, 'Base: dealableCount + getBBSeatIndex').toBe(2);
    expect((turns.match(gated) || []).length, 'Turns: watchdog dealable count').toBe(1);
  });

  it('the dealt hand state carries a truthful is_sitting_out flag', () => {
    const dealing = strip(read('src/engine/ServerTableEngineDealing.ts'));
    expect(dealing).toMatch(
      /is_sitting_out:\s*this\.disconnectEngine\.isSittingOut\(this\.tableId,\s*p\.user_id\)/
    );
  });
});
