/**
 * The engine can never burn the Sentry org quota again (2026-09-04).
 *
 * On 2026-08-24 engine error loops exhausted the org-wide error quota and every
 * project in the org - including Club Commander during its 2026-09-03 login
 * outage - was blind for three weeks. Sentry's own per-key limit is not
 * honoured on this plan, so the SDK-side budget in sentryEventBudget.ts is the
 * guard. These pins are its contract.
 */
import { describe, it, expect } from 'vitest';
import { SentryEventBudget, fingerprintOf, budgetFromEnv, DEFAULT_BUDGET } from './sentryEventBudget.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
}

describe('fingerprintOf', () => {
  it('collapses one reportError call site to one key even when the tail varies', () => {
    const a = fingerprintOf('[HandController.dealFlop] table 42 stalled at 12:00:01 (hand 3f9a0c7e1b2d4e5f)');
    const b = fingerprintOf('[HandController.dealFlop] table 43 stalled at 12:00:02 (hand 9a8b7c6d5e4f3a2b)');
    const u = fingerprintOf('[Seat] user 8d3e2c1a-1111-4222-8333-444455556666 vanished');
    const c = fingerprintOf('[HandController.dealFlop] table 42 stalled at 12:00:02'.padEnd(400, 'x'));
    expect(a, 'ids, numbers and timestamps must not split one loop into many keys').toBe(b);
    expect(a).toBe('HandController.dealFlop|table # stalled at #:#:# (hand <hex>)');
    expect(u).toBe('Seat|user <uuid> vanished');
    expect(c.length).toBeLessThanOrEqual(120 + 1 + 80);
    expect(c.startsWith('HandController.dealFlop|')).toBe(true);
  });

  it('prefers the errorContext source over the message prefix', () => {
    expect(fingerprintOf('[Ctx] boom', 'Explicit.source')).toBe('Explicit.source|boom');
  });

  it('never produces an empty key for uncaught exceptions with no context', () => {
    expect(fingerprintOf('')).toBe('(empty)');
    expect(fingerprintOf('TypeError: x is not a function')).toBe('TypeError: x is not a function');
  });
});

describe('SentryEventBudget', () => {
  it('admits up to perKeyLimit per fingerprint per window, then drops and counts', () => {
    const c = clock();
    const b = new SentryEventBudget({ perKeyLimit: 3, globalLimit: 100, windowMs: 60_000, now: c.now });
    const verdicts = Array.from({ length: 5 }, () => b.admit('loop'));
    expect(verdicts.map((v) => v.allow)).toEqual([true, true, true, false, false]);
    expect(verdicts[4]).toMatchObject({ reason: 'per_key', droppedForKey: 2 });
    expect(b.drainSummary()).toEqual({ total: 2, byKey: [{ key: 'loop', dropped: 2 }] });
    // Drained: nothing more to report until something else is dropped.
    expect(b.drainSummary()).toBeNull();
  });

  it('opens a fresh window after windowMs and reports drops from the old one', () => {
    const c = clock();
    const b = new SentryEventBudget({ perKeyLimit: 1, globalLimit: 100, windowMs: 1_000, now: c.now });
    expect(b.admit('k').allow).toBe(true);
    expect(b.admit('k').allow).toBe(false);
    c.tick(1_000);
    const v = b.admit('k');
    expect(v.allow).toBe(true);
    expect(v.droppedForKey, 'a new window starts with a clean drop count').toBe(0);
    expect(b.drainSummary()?.total).toBe(1);
  });

  it('the global cap holds even when every event has a different fingerprint', () => {
    const c = clock();
    const b = new SentryEventBudget({ perKeyLimit: 10, globalLimit: 5, windowMs: 60_000, now: c.now });
    const allowed = Array.from({ length: 20 }, (_, i) => b.admit(`Table.${i}`)).filter((v) => v.allow).length;
    expect(allowed).toBe(5);
    const s = b.drainSummary();
    expect(s?.total).toBe(15);
    expect(s?.byKey.every((r) => r.dropped === 1)).toBe(true);
  });

  it('a message-mutating loop cannot grow memory without bound', () => {
    const c = clock();
    const b = new SentryEventBudget({ perKeyLimit: 1, globalLimit: 1, windowMs: 60_000, maxKeys: 50, now: c.now });
    for (let i = 0; i < 5_000; i++) b.admit(`Loop.${i}`);
    expect(b.trackedKeys).toBeLessThanOrEqual(50);
    const s = b.drainSummary();
    expect(s?.total, 'every drop is still counted').toBe(4_999);
    expect(s?.byKey.length).toBeLessThanOrEqual(50);
    expect(s?.byKey.find((r) => r.key === '(other)')?.dropped).toBeGreaterThan(0);
  });

  it('worst case throughput is bounded by the defaults, not by the defect', () => {
    // A defect firing 10,000 times/minute across 100 call sites gets through at
    // most globalLimit per minute. 1 summary/10min on top is the whole cost.
    const c = clock();
    const b = new SentryEventBudget({ ...DEFAULT_BUDGET, now: c.now });
    let sent = 0;
    for (let minute = 0; minute < 3; minute++) {
      for (let i = 0; i < 10_000; i++) if (b.admit(`Site.${i % 100}|x`).allow) sent++;
      c.tick(60_000);
    }
    expect(sent).toBe(3 * DEFAULT_BUDGET.globalLimit);
    expect(b.drainSummary()?.total).toBe(30_000 - sent);
  });

  it('reads env overrides and ignores garbage', () => {
    expect(budgetFromEnv({ SENTRY_BUDGET_PER_KEY: '5', SENTRY_BUDGET_GLOBAL: 'abc', SENTRY_BUDGET_WINDOW_MS: '-1' } as NodeJS.ProcessEnv))
      .toMatchObject({ perKeyLimit: 5, globalLimit: DEFAULT_BUDGET.globalLimit, windowMs: DEFAULT_BUDGET.windowMs });
  });
});
