/**
 * The engine's Sentry budget on the free plan (docs/SENTRY-FREE-TIER-POLICY.md).
 *
 * 5,000 errors a MONTH for the whole org; the engine's share is 60 a DAY, 3 per
 * fingerprint, reset at 00:00 UTC. On 2026-08-24 engine error loops burned the
 * (then much larger) org quota and every project was blind for three weeks.
 * Sentry's own per-key limit is not honoured on this plan, so the SDK-side
 * budget in sentryEventBudget.ts is the guard. These pins are its contract.
 */
import { describe, it, expect } from 'vitest';
import {
  SentryEventBudget,
  fingerprintOf,
  budgetFromEnv,
  DEFAULT_BUDGET,
  utcDayOf,
} from './sentryEventBudget.js';

function clock(start = Date.UTC(2026, 8, 4, 12, 0, 0)) {
  let t = start;
  return {
    now: () => t,
    tick: (ms: number) => {
      t += ms;
    },
  };
}

describe('fingerprintOf', () => {
  it('collapses one reportError call site to one key even when the tail varies', () => {
    const a = fingerprintOf(
      '[HandController.dealFlop] table 42 stalled at 12:00:01 (hand 3f9a0c7e1b2d4e5f)'
    );
    const b = fingerprintOf(
      '[HandController.dealFlop] table 43 stalled at 12:00:02 (hand 9a8b7c6d5e4f3a2b)'
    );
    const u = fingerprintOf('[Seat] user 8d3e2c1a-1111-4222-8333-444455556666 vanished');
    const c = fingerprintOf(
      '[HandController.dealFlop] table 42 stalled at 12:00:02'.padEnd(400, 'x')
    );
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

describe('SentryEventBudget - the policy numbers are the defaults', () => {
  it('60 a day, 3 per fingerprint', () => {
    expect(DEFAULT_BUDGET).toMatchObject({ globalLimit: 60, perKeyLimit: 3 });
  });

  it('the fourth identical fingerprint in a day is dropped and counted', () => {
    const c = clock();
    const b = new SentryEventBudget({ now: c.now });
    const verdicts = Array.from({ length: 5 }, () => b.admit('loop'));
    expect(verdicts.map((v) => v.allow)).toEqual([true, true, true, false, false]);
    expect(verdicts[4]).toMatchObject({ reason: 'per_key', droppedForKey: 2, sentToday: 3 });
    expect(b.dropped).toBe(2);
    expect(b.droppedToday).toBe(2);
    expect(b.sentToday).toBe(3);
    expect(b.topDropped()).toEqual([{ key: 'loop', sent: 3, dropped: 2 }]);
  });

  it('the 61st event in a day is dropped even when every fingerprint is distinct', () => {
    const c = clock();
    const b = new SentryEventBudget({ now: c.now });
    const verdicts = Array.from({ length: 100 }, (_, i) => b.admit(`Table.${i}|x`));
    expect(verdicts.filter((v) => v.allow)).toHaveLength(60);
    expect(verdicts[60]).toMatchObject({ allow: false, reason: 'global', sentToday: 60 });
    expect(b.dropped).toBe(40);
  });

  it('resets at the UTC day boundary, and the lifetime drop counter does not', () => {
    const c = clock(Date.UTC(2026, 8, 4, 23, 59, 30));
    const b = new SentryEventBudget({ now: c.now });
    for (let i = 0; i < 70; i++) b.admit(`Site.${i}|x`);
    expect(b.sentToday).toBe(60);
    expect(b.dropped).toBe(10);
    expect(b.currentDay).toBe('2026-09-04');

    c.tick(60_000); // 00:00:30 on the 5th, UTC
    expect(b.currentDay).toBe('2026-09-05');
    expect(b.sentToday).toBe(0);
    expect(b.droppedToday).toBe(0);
    expect(b.dropped, 'lifetime drops are a counter, never reset').toBe(10);
    expect(b.admit('Site.0|x')).toMatchObject({ allow: true, droppedForKey: 0, sentToday: 1 });
    expect(b.trackedKeys).toBe(1);
  });

  it('a message-mutating loop cannot grow memory without bound', () => {
    const c = clock();
    const b = new SentryEventBudget({ maxKeys: 50, now: c.now });
    for (let i = 0; i < 5_000; i++) b.admit(`Loop.${i}`);
    expect(b.trackedKeys).toBeLessThanOrEqual(50);
    expect(b.dropped, 'every drop is still counted').toBe(5_000 - 60);
  });

  it('worst case throughput is bounded by the defaults, not by the defect', () => {
    // A defect firing 10,000 times a minute across 100 call sites, for three
    // days, gets through at most 60 a day. That is the whole cost.
    const c = clock(Date.UTC(2026, 8, 4, 0, 0, 0));
    const b = new SentryEventBudget({ now: c.now });
    let sent = 0;
    for (let day = 0; day < 3; day++) {
      for (let minute = 0; minute < 24 * 60; minute += 60) {
        for (let i = 0; i < 10_000; i++) if (b.admit(`Site.${i % 100}|x`).allow) sent++;
        c.tick(60 * 60_000);
      }
    }
    expect(sent).toBe(3 * DEFAULT_BUDGET.globalLimit);
  });

  it('reads env overrides and ignores garbage', () => {
    expect(
      budgetFromEnv({
        SENTRY_BUDGET_PER_KEY: '5',
        SENTRY_BUDGET_GLOBAL: 'abc',
      } as NodeJS.ProcessEnv)
    ).toMatchObject({ perKeyLimit: 5, globalLimit: DEFAULT_BUDGET.globalLimit });
    expect(utcDayOf(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01');
  });
});
