/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE OVERRUN REPORT THAT DROWNED EVERY OTHER REPORT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Tournament.spin_reveal_window_overrun` fired once per spin. Production
 * runs ~2,500 spins a day and 88-97% of them overran, so one call site
 * produced well over a thousand identical error reports daily. Every one of
 * them was TRUE, and together they were noise.
 *
 * These tests execute the decision on real numbers rather than asserting on
 * source text, because the thing that can regress is the arithmetic.
 */
import { describe, expect, it } from 'vitest';
import {
  SpinOverrunReporter,
  describeOverrun,
  OVERRUN_FLUSH_INTERVAL_MS,
} from './spinOverrunReporter.js';

const T0 = 1_700_000_000_000;

describe('SpinOverrunReporter', () => {
  it('reports the very first overrun immediately — an incident never opens in silence', () => {
    const r = new SpinOverrunReporter();
    const out = r.record(4200, T0);
    expect(out).not.toBeNull();
    expect(out!.count).toBe(1);
    expect(out!.worstMs).toBe(4200);
    expect(out!.first).toBe(true);
  });

  it('says nothing for the rest of the window', () => {
    const r = new SpinOverrunReporter();
    r.record(4200, T0);
    for (let i = 1; i <= 50; i++) {
      expect(r.record(1000 + i, T0 + i * 1000)).toBeNull();
    }
    expect(r.suppressed).toBe(50);
  });

  /** THE REGRESSION PIN. The old form emitted one report per spin. */
  it('turns a day of production into a handful of reports, not thirteen hundred', () => {
    const r = new SpinOverrunReporter();
    let reports = 0;
    // 2,400 spins spread evenly over 24h, every one of them overrunning.
    const spacing = (24 * 60 * 60 * 1000) / 2400;
    for (let i = 0; i < 2400; i++) {
      if (r.record(3000, T0 + i * spacing)) reports++;
    }
    expect(reports).toBeLessThanOrEqual(24 * (60 / 10) + 1); // <= one per 10m
    expect(reports).toBeGreaterThan(0); // ...but never zero: silence is not the fix
  });

  it('carries the count and the worst lag once the window closes', () => {
    const r = new SpinOverrunReporter();
    r.record(1000, T0);
    r.record(9000, T0 + 1000);
    r.record(2000, T0 + 2000);
    const out = r.record(5000, T0 + OVERRUN_FLUSH_INTERVAL_MS);
    expect(out).not.toBeNull();
    // The opening report consumed the 1000. Two were suppressed after it,
    // and this call is the third in the group.
    expect(out!.count).toBe(3);
    expect(out!.worstMs).toBe(9000);
    expect(out!.first).toBe(false);
    expect(out!.windowMs).toBeGreaterThan(0);
  });

  it('counts an unreadable lag rather than dropping the overrun', () => {
    const r = new SpinOverrunReporter();
    const out = r.record(Number.NaN, T0);
    expect(out!.count).toBe(1);
    expect(out!.worstMs).toBe(0);
    expect(Number.isFinite(out!.worstMs)).toBe(true);
  });

  it('a negative lag is recorded as zero, never as a negative duration', () => {
    const r = new SpinOverrunReporter();
    expect(r.record(-500, T0)!.worstMs).toBe(0);
  });

  it('re-opens loudly after a quiet period', () => {
    const r = new SpinOverrunReporter();
    r.record(1000, T0);
    expect(r.record(1000, T0 + 60_000)).toBeNull();
    // A day later, a fresh incident must not wait for a window to elapse.
    expect(r.record(1000, T0 + 24 * 60 * 60 * 1000)).not.toBeNull();
  });

  it('two reporters never share suppression state', () => {
    const a = new SpinOverrunReporter();
    const b = new SpinOverrunReporter();
    a.record(1000, T0);
    expect(b.record(1000, T0)).not.toBeNull();
  });

  it('honours a custom flush interval', () => {
    const r = new SpinOverrunReporter(1000);
    r.record(1, T0);
    expect(r.record(1, T0 + 500)).toBeNull();
    expect(r.record(1, T0 + 1000)).not.toBeNull();
  });
});

describe('describeOverrun', () => {
  it('reads naturally for a single spin', () => {
    const msg = describeOverrun({ count: 1, worstMs: 4200, windowMs: 0, first: true });
    expect(msg).toContain('4200ms');
    expect(msg).not.toContain('spin starts overran');
  });

  it('names the count, the window and where the per-spin detail now lives', () => {
    const msg = describeOverrun({ count: 87, worstMs: 27039, windowMs: 600_000, first: false });
    expect(msg).toContain('87 spin starts');
    expect(msg).toContain('600s');
    expect(msg).toContain('27039ms');
    // The detail did not disappear, it MOVED. Say where.
    expect(msg).toContain('poker_spin_reveal_lag_p50_ms');
  });
});
