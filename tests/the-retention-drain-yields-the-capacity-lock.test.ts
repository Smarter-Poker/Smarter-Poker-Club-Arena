import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import * as yieldPolicy from '../scripts/ci/horse-adaptive-drain-yield.mjs';

const { pauseAfterCallMs, READY_WORK_SQL, DRAIN_MIN_PAUSE_MS, DRAIN_MAX_PAUSE_MS } =
  yieldPolicy as {
    pauseAfterCallMs: (ms: number) => number;
    READY_WORK_SQL: string;
    DRAIN_MIN_PAUSE_MS: number;
    DRAIN_MAX_PAUSE_MS: number;
  };

// 2026-10-15: a drain calling fn_prune_horse_adaptive_journal back to back held
// the adaptive capacity lock almost continuously. The engine's enqueue and
// append only TRY that lock, so no horse observation was recorded while a
// drain ran, and one batch failed 91 times.
describe('the retention drain yields the adaptive capacity lock', () => {
  it('stays off the lock at least as long as a call held it', () => {
    for (const held of [1200, 2500, 4900, 5700, 9000]) {
      expect(pauseAfterCallMs(held)).toBeGreaterThanOrEqual(held);
    }
  });

  it('always pauses, and never for unbounded time', () => {
    expect(pauseAfterCallMs(0)).toBe(DRAIN_MIN_PAUSE_MS);
    expect(pauseAfterCallMs(Number.NaN)).toBe(DRAIN_MIN_PAUSE_MS);
    expect(pauseAfterCallMs(-5)).toBe(DRAIN_MIN_PAUSE_MS);
    expect(pauseAfterCallMs(120000)).toBe(DRAIN_MAX_PAUSE_MS);
    expect(DRAIN_MIN_PAUSE_MS).toBeGreaterThan(0);
  });

  it('treats queued-and-due and actively leased work as ready, never finished or quarantined work', () => {
    expect(READY_WORK_SQL).toMatch(/state = 'queued'/);
    expect(READY_WORK_SQL).toMatch(/available_at <= now\(\)/);
    expect(READY_WORK_SQL).toMatch(/state = 'leased' AND lease_until > now\(\)/);
    expect(READY_WORK_SQL).not.toMatch(/quarantined/);
    expect(READY_WORK_SQL).not.toMatch(/state <> 'completed'/);
  });

  it('checks for ready work before every owner call and pauses after it', () => {
    const script = readFileSync('scripts/ci/drain-horse-adaptive-retention.mjs', 'utf8');
    const loop = script.slice(script.indexOf('while (Date.now() < deadline)'));
    const ready = loop.indexOf('client.query(READY_WORK_SQL)');
    const call = loop.indexOf('fn_prune_horse_adaptive_journal()');
    const pause = loop.indexOf('pauseAfterCallMs(');
    expect(ready).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(ready);
    expect(pause).toBeGreaterThan(call);
  });
});
