/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE POT'S COUNT-UP NEVER PRINTS A CHIP THAT DOES NOT EXIST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-23, screenshot of a live 1/2 Action table, five antes in the
 * middle and nothing else: "THE POT IS SOMEHOW SHOWING 4.97 WHEN THIS IS A
 * 1/2 GAME AND NO PLAYER HAS BET OR DONE ANYTHING AS A FRACTION."
 *
 * The pill tweens between pot totals. It interpolated the raw float and
 * printed every frame, and PotDisplay's formatter keeps a real fraction on
 * purpose (a 7.50 pot must read 7.50), so a count from 0 to 5 was drawn as
 * 3.41 -> 4.62 -> 4.97 -> 5. Each of those is a pot nobody built.
 *
 * Every frame now lands on the coarsest grid both ends sit on: whole chips
 * between whole numbers, cents otherwise. This drives the tween frame by
 * frame with a fake clock and asserts on what the formatter was handed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { AnimatedNumber, countGrid, snapToGrid } from '../../src/components/common/AnimatedNumber';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A hand-cranked requestAnimationFrame: every frame is ours to fire. */
function crankedFrames() {
  let now = 0;
  let queued: FrameRequestCallback | null = null;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    queued = cb;
    return 1;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
    queued = null;
  });
  return {
    step(ms: number) {
      now += ms;
      const cb = queued;
      queued = null;
      if (cb) act(() => cb(now));
    },
  };
}

describe('the grid', () => {
  it('two whole numbers count through whole numbers', () => {
    expect(countGrid(0, 5)).toBe(1);
    expect(countGrid(12, 40)).toBe(1);
  });

  it('float noise on a whole pot is not a fraction (2026-09-24)', () => {
    // The pill is fed mainPot - streetBets straight from the snapshot; a rake
    // split can hand it 5.000000000000001 and a subtraction 0.30000000000000004.
    expect(countGrid(0, 5.000000000000001)).toBe(1);
    expect(countGrid(0.1 + 0.2 - 0.3, 3)).toBe(1);
    expect(countGrid(11.999999999999998, 40)).toBe(1);
    // A real cent is still a real cent.
    expect(countGrid(0, 5.01)).toBe(0.01);
  });

  it('anything with a real fraction counts in cents, never finer', () => {
    expect(countGrid(0, 7.5)).toBe(0.01);
    expect(countGrid(3.5, 10)).toBe(0.01);
    expect(snapToGrid(4.9712345, 0.01)).toBe(4.97);
    expect(snapToGrid(4.9712345, 1)).toBe(5);
    // float noise from the multiply is squared off at the cent
    expect(snapToGrid(0.29 + 0.01, 0.01)).toBe(0.3);
  });
});

describe('the frames the formatter is handed', () => {
  it('0 -> 5 at 1/2 is drawn in whole chips, and lands on exactly 5', () => {
    const frames = crankedFrames();
    const seen: number[] = [];
    const format = (n: number) => {
      seen.push(n);
      return String(n);
    };
    const { rerender } = render(<AnimatedNumber value={0} duration={350} format={format} />);
    rerender(<AnimatedNumber value={5} duration={350} format={format} />);
    for (let i = 0; i < 40; i++) frames.step(16);
    const shown = seen.filter((n) => n !== 0);
    expect(shown.length).toBeGreaterThan(3);
    for (const n of shown) expect(Number.isInteger(n), `frame printed ${n}`).toBe(true);
    expect(seen[seen.length - 1]).toBe(5);
  });

  it('a fractional pot still counts, in cents, and lands on exactly its total', () => {
    const frames = crankedFrames();
    const seen: number[] = [];
    const format = (n: number) => {
      seen.push(n);
      return String(n);
    };
    const { rerender } = render(<AnimatedNumber value={0} duration={350} format={format} />);
    rerender(<AnimatedNumber value={7.5} duration={350} format={format} />);
    for (let i = 0; i < 40; i++) frames.step(16);
    for (const n of seen) {
      expect(Math.round(n * 100) / 100, `frame printed ${n}`).toBe(n);
    }
    expect(seen[seen.length - 1]).toBe(7.5);
  });
});
