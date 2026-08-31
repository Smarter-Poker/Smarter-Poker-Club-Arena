/**
 * V12 HORSE LEAGUE — duplicate-deal self-play harness.
 * Pins the properties that make its numbers trustworthy: chip conservation
 * (every hand's nets sum to zero, side pots included), zero illegal actions
 * across a real run, seed determinism, and duplicate symmetry (a config
 * playing against itself measures ~0 by construction of the seat swap).
 */

import { describe, it, expect } from 'vitest';
import { playHand, runMatchup } from './HorseLeague.js';

/* ── WHY THIS FILE STATES ITS OWN BUDGET (2026-08-27) ────────────────────
   These are CPU-bound simulations - hundreds of real hands per spec - and
   they take ~8.5s of the suite-wide 10s `testTimeout` when run ALONE.
   That leaves no headroom, so under a parallel `vitest run` they lose the
   race and time out: measured on main, a full run failed 2, then 4, then 5
   specs across DIFFERENT files on three consecutive runs, while every one of
   those files passed on its own. A suite that reddens at random teaches
   everyone to re-run it until it is green, which is how a REAL failure gets
   waved through.

   The budget is stated per-describe rather than raised globally on purpose:
   a global bump would also hide a genuine hang in the ~1,900 specs that
   legitimately finish in milliseconds. 60s is ~7x the measured solo cost, so
   it absorbs a loaded machine without ever masking a wedge. */
describe('HorseLeague V12 - simulator integrity', { timeout: 60_000 }, () => {
  it('conserves chips on every hand (side pots included)', async () => {
    for (let h = 0; h < 300; h++) {
      const net = playHand(1000 + h * 7919, (h % 6) + 1, () => ({}));
      const sum = net.reduce((a, b) => a + b, 0);
      expect(Math.abs(sum), `hand ${h} leaked ${sum} chips`).toBeLessThan(1e-6);
    }
  });

  it('produces zero illegal actions across a full matchup', async () => {
    const r = await runMatchup({ name: 't', a: {}, b: { v11: false } }, 150, 42);
    expect(r.illegalActions).toBe(0);
    expect(r.hands).toBe(300);
    expect(Number.isFinite(r.bb100)).toBe(true);
    expect(Number.isFinite(r.stderr)).toBe(true);
  });

  it('is deterministic for a given seed', async () => {
    const r1 = await runMatchup({ name: 't', a: {}, b: { v10: false } }, 60, 777);
    const r2 = await runMatchup({ name: 't', a: {}, b: { v10: false } }, 60, 777);
    expect(r1.bb100).toBe(r2.bb100);
    expect(r1.stderr).toBe(r2.stderr);
  });

  it('self-play (identical configs) measures near zero', async () => {
    // Not exactly zero — decision RNG diverges after the deal — but the
    // duplicate seat swap must kill any systematic edge.
    const r = await runMatchup({ name: 'mirror', a: {}, b: {} }, 400, 1234);
    expect(Math.abs(r.bb100)).toBeLessThan(Math.max(30, 4 * r.stderr));
  });
});
