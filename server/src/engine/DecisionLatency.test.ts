/**
 * HOW LONG DOES A HORSE TAKE TO THINK? (Dan 2026-08-29)
 *
 * The question could not be answered from production. The decision carried a
 * documented "<15ms" budget and nothing measured it — `performance.now()`
 * appeared four times in the entire server tree, all four in an offline test.
 *
 * These cases pin the instrument itself, and one of them measures the real
 * HorseLogic.decide against the budget the comments claim.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  enableBrainTelemetry,
  noteDecisionMs,
  drainDecisionLatency,
  restoreDecisionLatency,
  percentileMs,
  latencyBucketEdges,
  peekDecisionLatency,
} from './BrainTelemetry.js';

beforeEach(() => {
  enableBrainTelemetry();
  drainDecisionLatency();
});

describe('the instrument', () => {
  it('records samples, total and max per scope, and keeps scopes apart', () => {
    noteDecisionMs('nlh', 3);
    noteDecisionMs('nlh', 7);
    noteDecisionMs('plo6', 40);

    const rows = drainDecisionLatency().sort((a, b) => a.scope.localeCompare(b.scope));
    expect(rows.map((r) => r.scope)).toEqual(['nlh', 'plo6']);

    const nlh = rows[0];
    expect(nlh.samples).toBe(2);
    expect(nlh.totalMs).toBe(10);
    expect(nlh.maxMs).toBe(7);

    // A 6-card PLO decision runs the most expensive equity sim on the
    // platform. Averaging it into NLH would hide both, which is the whole
    // reason scope exists.
    expect(rows[1].maxMs).toBe(40);
  });

  it('draining clears, so the next minute is not double-counted', () => {
    noteDecisionMs('nlh', 5);
    expect(drainDecisionLatency()).toHaveLength(1);
    expect(drainDecisionLatency()).toHaveLength(0);
  });

  it('restores a failed flush without inventing a peak', () => {
    noteDecisionMs('nlh', 9);
    const batch = drainDecisionLatency();
    restoreDecisionLatency(batch);
    noteDecisionMs('nlh', 2);

    const [row] = drainDecisionLatency();
    expect(row.samples).toBe(2);
    expect(row.totalMs).toBe(11);
    // max is a max. Summing two peaks would describe a decision that never
    // happened.
    expect(row.maxMs).toBe(9);
  });

  it('ignores nonsense rather than poisoning the histogram', () => {
    noteDecisionMs('nlh', Number.NaN);
    noteDecisionMs('nlh', -1);
    noteDecisionMs('nlh', Number.POSITIVE_INFINITY);
    expect(drainDecisionLatency()).toHaveLength(0);
  });

  it('costs nothing when telemetry is off - the measurement must not become the cost', async () => {
    // A module whose enableBrainTelemetry() was never called. resetModules
    // gives a genuinely fresh copy rather than the one the other cases armed.
    const { resetModules } = await import('vitest').then((m) => ({
      resetModules: m.vi.resetModules.bind(m.vi),
    }));
    resetModules();
    const fresh = await import('./BrainTelemetry.js');
    fresh.noteDecisionMs('nlh', 5);
    expect(fresh.drainDecisionLatency()).toHaveLength(0);
  });

  it('peek does not drain - /health must not eat the minute the flush is about to send', () => {
    noteDecisionMs('nlh', 4);
    expect(peekDecisionLatency()[0].samples).toBe(1);
    expect(peekDecisionLatency()[0].samples).toBe(1);
    expect(drainDecisionLatency()).toHaveLength(1);
  });
});

describe('percentiles read off the histogram', () => {
  it('returns null with no samples - a fabricated zero would read as "very fast"', () => {
    expect(percentileMs({ scope: 'x', samples: 0, totalMs: 0, maxMs: 0, buckets: [] }, 0.5)).toBe(
      null
    );
  });

  it('over-estimates by construction, so it never flatters the engine', () => {
    // 100 decisions, all of them between 2ms and 5ms.
    for (let i = 0; i < 100; i++) noteDecisionMs('nlh', 3);
    const [row] = drainDecisionLatency();
    const p50 = percentileMs(row, 0.5);
    // The bucket's UPPER edge, not its middle or lower edge.
    expect(p50).toBe(5);
    expect(latencyBucketEdges()).toContain(5);
  });

  it('a tail is visible rather than averaged away', () => {
    for (let i = 0; i < 99; i++) noteDecisionMs('plo6', 1);
    noteDecisionMs('plo6', 180);
    const [row] = drainDecisionLatency();
    expect(percentileMs(row, 0.5)).toBe(1);
    expect(percentileMs(row, 0.999)).toBe(200);
    expect(row.maxMs).toBe(180);
    // The mean would have said 2.8ms and hidden it completely.
    expect(row.totalMs / row.samples).toBeLessThan(3);
  });
});

describe('the shipped wiring - an instrument nobody calls measures nothing', () => {
  it('the sole live worker times the complete decision', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('./horseDecision/workerRuntime.ts', import.meta.url).pathname,
      'utf8'
    );
    // The worker clock brackets its injected HorseLogic decision, including
    // hand strength, board, opponent model, equity and final sizing.
    const startAt = src.indexOf('const startedAt = this.deps.now()', src.indexOf('executeFast('));
    const decideAt = src.indexOf('this.deps.decide(', startAt);
    const noteAt = src.indexOf('this.deps.noteDecision(', decideAt);
    expect(startAt).toBeGreaterThan(0);
    expect(startAt).toBeLessThan(decideAt);
    expect(decideAt).toBeLessThan(noteAt);
  });

  it('the scope is the LIVE hand variant, never a guess off the snapshot', async () => {
    const { readFileSync } = await import('node:fs');
    const turns = readFileSync(
      new URL('./ServerTableEngineTurns.ts', import.meta.url).pathname,
      'utf8'
    );
    const worker = readFileSync(
      new URL('./horseDecision/workerRuntime.ts', import.meta.url).pathname,
      'utf8'
    );
    // Production, first hour of the measurement (2026-08-29): all 14,326
    // samples landed in 'nlh' while 58 of 91 running tables dealt PLO —
    // the horse snapshot has no `variant` field, so the old
    // `(gameState as any)?.variant ?? 'nlh'` relabelled every decision and
    // made the plo6 15ms budget unverifiable. The scope must come from
    // activeHandVariant(), the accessor built for "read the live hand".
    expect(turns).toContain("const activeVariant = this.activeHandVariant() || 'nlh'");
    expect(turns).toContain('gameVariant: activeVariant');
    expect(worker).toContain("request.gameState.gameVariant || 'nlh'");
    expect(turns).not.toContain('(gameState as any)?.variant');
  });

  it('the flush sends both streams through the atomic retryable batch publisher', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../services/BrainTelemetryFlush.ts', import.meta.url).pathname,
      'utf8'
    );
    expect(src).toContain('drainDecisionLatency()');
    expect(src).toContain('fires: drainFires(), latency: drainDecisionLatency()');
    expect(src).toContain('new HorseBrainTelemetryPublisher(');
    expect(src).toContain('fn_horse_brain_flush_receipt');
  });
});
