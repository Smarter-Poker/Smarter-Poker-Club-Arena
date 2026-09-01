import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE SHUTDOWN BUDGET HAS TO NEST.
 *
 * Three numbers decide whether a restart voids the hands in flight:
 *
 *   docker stop -t 45   Docker's grace before SIGKILL  (server/scripts/engine-up.sh)
 *   SHUTDOWN_CAP_MS     the outer race in server/src/index.ts
 *   DRAIN_BUDGET_MS     time spent parking tables at a hand boundary
 *
 * They must nest, drain < cap < grace, with room left for the state flush. Get
 * the order wrong and a clean shutdown becomes a SIGKILL mid-flush -- which is
 * the failure the drain exists to prevent, arriving by a different door.
 *
 * This is pinned because the numbers have been wrong twice. 8s was raised to
 * 18s on 2026-08-28 against an estimate that "a hand runs ~20s". Measured over
 * 41,269 real hands the median is 17.2s and the p90 is 48.2s, so an 18s budget
 * was still expiring on 47% of hands -- and chip drift across a deploy restart
 * ran at 8.05% against a 1.50% baseline (issue #2406).
 */
const SRC = readFileSync(join(__dirname, '../../server/src/index.ts'), 'utf8');
const UP = readFileSync(join(__dirname, '../../server/scripts/engine-up.sh'), 'utf8');

function num(name: string): number {
  const m = SRC.match(new RegExp(`const ${name} = ([0-9_]+);`));
  if (!m) throw new Error(`${name} is not declared in server/src/index.ts`);
  return Number(m[1].replace(/_/g, ''));
}

describe('the shutdown budget nests', () => {
  const drain = num('DRAIN_BUDGET_MS');
  const cap = num('SHUTDOWN_CAP_MS');

  const graceMatch = UP.match(/docker stop -t (\d+)/);
  const graceMs = graceMatch ? Number(graceMatch[1]) * 1000 : 0;

  it('reads a real stop grace out of engine-up.sh', () => {
    expect(graceMs).toBeGreaterThan(0);
  });

  it('drains for less than the outer cap, leaving time to flush state', () => {
    expect(drain).toBeLessThan(cap);
    // the flush needs room; 10s was proven too short for the whole shutdown
    expect(cap - drain).toBeGreaterThanOrEqual(10_000);
  });

  it('finishes before Docker would SIGKILL', () => {
    expect(cap).toBeLessThan(graceMs);
  });

  it('gives the drain comfortably longer than a median hand', () => {
    // p50 is 17.2s over 41,269 sampled hands.
    //
    // The bar is 1.5x the median, not the median. A budget that merely EQUALS
    // p50 expires on half the tables by definition, and the first draft of
    // this test asserted `> 17_200` -- which the old, broken 18s budget passed
    // with 800ms to spare. A pin that green-lights the bug it was written for
    // is worse than no pin.
    const MEDIAN_HAND_MS = 17_200;
    expect(drain).toBeGreaterThanOrEqual(MEDIAN_HAND_MS * 1.5);
  });

  it('uses the named constants rather than re-introducing magic numbers', () => {
    expect(SRC).toContain('drainHands(DRAIN_BUDGET_MS)');
    expect(SRC).toContain('setTimeout(r, SHUTDOWN_CAP_MS)');
  });
});
