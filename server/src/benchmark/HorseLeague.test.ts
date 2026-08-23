/**
 * V12 HORSE LEAGUE — duplicate-deal self-play harness.
 * Pins the properties that make its numbers trustworthy: chip conservation
 * (every hand's nets sum to zero, side pots included), zero illegal actions
 * across a real run, seed determinism, and duplicate symmetry (a config
 * playing against itself measures ~0 by construction of the seat swap).
 */

import { describe, it, expect } from 'vitest';
import { playHand, runMatchup } from './HorseLeague.js';

describe('HorseLeague V12 — simulator integrity', () => {
  it('conserves chips on every hand (side pots included)', () => {
    for (let h = 0; h < 300; h++) {
      const net = playHand(1000 + h * 7919, (h % 6) + 1, () => ({}));
      const sum = net.reduce((a, b) => a + b, 0);
      expect(Math.abs(sum), `hand ${h} leaked ${sum} chips`).toBeLessThan(1e-6);
    }
  });

  it('produces zero illegal actions across a full matchup', () => {
    const r = runMatchup({ name: 't', a: {}, b: { v11: false } }, 150, 42);
    expect(r.illegalActions).toBe(0);
    expect(r.hands).toBe(300);
    expect(Number.isFinite(r.bb100)).toBe(true);
    expect(Number.isFinite(r.stderr)).toBe(true);
  });

  it('is deterministic for a given seed', () => {
    const r1 = runMatchup({ name: 't', a: {}, b: { v10: false } }, 60, 777);
    const r2 = runMatchup({ name: 't', a: {}, b: { v10: false } }, 60, 777);
    expect(r1.bb100).toBe(r2.bb100);
    expect(r1.stderr).toBe(r2.stderr);
  });

  it('self-play (identical configs) measures near zero', () => {
    // Not exactly zero — decision RNG diverges after the deal — but the
    // duplicate seat swap must kill any systematic edge.
    const r = runMatchup({ name: 'mirror', a: {}, b: {} }, 400, 1234);
    expect(Math.abs(r.bb100)).toBeLessThan(Math.max(30, 4 * r.stderr));
  });
});
