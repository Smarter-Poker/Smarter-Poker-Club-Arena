import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialLoadBoundary, initialLoadTransfer } from '../scripts/ci/initial-load-bytes.mjs';

/**
 * The route-performance 3MB transfer budget measures the initial load, not
 * whatever speculative idle work happened to land before the snapshot.
 * 2026-10-25: /hub/club-arena/health measured 1096kB on mobile and 3173kB on
 * tablet in one run of the same build (PR #7972); a re-run passed.
 */
const MB = 1_000_000;
const nav = (loadEventStart: number, transferSize = 4_000) => ({ loadEventStart, transferSize });
const res = (startTime: number, transferSize: number) => ({ startTime, transferSize });

describe('the route transfer budget is the initial load', () => {
  it('counts the document and everything requested before load', () => {
    const t = initialLoadTransfer(nav(800), [res(10, 300_000), res(120, 200_000), res(799, 1_000)]);
    expect(t.boundaryMs).toBe(800);
    expect(t.initialBytes).toBe(4_000 + 300_000 + 200_000 + 1_000);
    expect(t.lateBytes).toBe(0);
  });

  it('excludes what started after load, and still reports it in the total', () => {
    const t = initialLoadTransfer(nav(800), [
      res(10, 1 * MB),
      res(800, 1.5 * MB),
      res(2_400, 0.7 * MB),
    ]);
    expect(t.initialBytes).toBe(4_000 + 1 * MB);
    expect(t.lateBytes).toBe(2.2 * MB);
    expect(t.lateCount).toBe(2);
    expect(t.totalBytes).toBe(4_000 + 3.2 * MB);
  });

  it('gives the same verdict whether the idle prefetch landed before the snapshot or not', () => {
    const initial = [res(5, 600_000), res(40, 400_000)];
    const idle = [res(1_300, 900_000), res(1_450, 800_000), res(4_300, 500_000)];
    const quiet = initialLoadTransfer(nav(1_000), initial);
    const busy = initialLoadTransfer(nav(1_000), [...initial, ...idle]);
    expect(busy.initialBytes).toBe(quiet.initialBytes);
    expect(busy.totalBytes).toBeGreaterThan(3 * MB);
    expect(busy.initialBytes).toBeLessThan(3 * MB);
  });

  it('ends the initial set at the first idle callback when idle opens before load', () => {
    expect(initialLoadBoundary(nav(2_000), 1_200)).toBe(1_200);
    expect(initialLoadBoundary(nav(2_000), 2_600)).toBe(2_000);
    const t = initialLoadTransfer(nav(2_000), [res(30, 500_000), res(1_250, 900_000)], 1_200);
    expect(t.initialBytes).toBe(4_000 + 500_000);
  });

  it('still fails a genuinely bloated initial load', () => {
    const t = initialLoadTransfer(nav(1_500), [res(10, 1.8 * MB), res(15, 1.3 * MB)], 1_600);
    expect(t.initialBytes).toBeGreaterThan(3 * MB);
  });

  it('fails closed: with no load timestamp every byte counts', () => {
    for (const navigation of [null, undefined, nav(0), { transferSize: 4_000 }]) {
      const t = initialLoadTransfer(navigation, [res(10, 1 * MB), res(9_000, 2.5 * MB)], 500);
      expect(t.boundaryMs).toBeNull();
      expect(t.lateBytes).toBe(0);
      expect(t.initialBytes).toBe(((navigation && navigation.transferSize) || 0) + 3.5 * MB);
    }
  });

  it('counts an entry with an unreadable start time rather than dropping it', () => {
    const t = initialLoadTransfer(nav(800), [
      { transferSize: 2_000 } as never,
      res(Number.NaN, 3_000),
    ]);
    expect(t.initialBytes).toBe(4_000 + 5_000);
  });

  it('the gate enforces the budget on the initial-load figure, with the timing it needs', () => {
    const gate = readFileSync(join(__dirname, '..', 'scripts/ci/route-performance.mjs'), 'utf8');
    expect(gate).toContain("import { initialLoadTransfer } from './initial-load-bytes.mjs'");
    expect(gate).toContain(
      "if (transfer.initialBytes > 3_000_000) violations.push('transfer > 3MB')"
    );
    expect(gate).toContain('performance.setResourceTimingBufferSize(10_000)');
    expect(gate).toContain('firstIdleCallbackAt = performance.now()');
    expect(gate).not.toMatch(/resources\.reduce\(/);
  });
});
