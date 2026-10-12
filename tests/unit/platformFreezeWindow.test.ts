import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  awaitPlatformThaw,
  describeThaw,
  freezeBudgetMs,
  PLATFORM_FREEZE_CEILING_MS,
  PLATFORM_FREEZE_MEASUREMENT,
  PLATFORM_FREEZE_POLL_MS,
  PLATFORM_FREEZE_THAW_TAIL_MS,
  PLATFORM_FREEZE_WORST_CASE_MS,
} from '../../scripts/ci/platform-freeze-window.mjs';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('the platform freeze is waited out, not counted down', () => {
  it('records why the old 37 x 10s budget could never work', () => {
    // 370s. Measured: not one of 435 breaks finished that fast.
    expect(PLATFORM_FREEZE_MEASUREMENT.minMs).toBeGreaterThan(370_000);
    expect(PLATFORM_FREEZE_MEASUREMENT.breaksThatFinishedInsideTheOldBudget).toBe(0);
    // And not one of them fitted the documented :55 to :00 window either.
    expect(PLATFORM_FREEZE_MEASUREMENT.breaksThatFinishedInsideTheDocumentedWindow).toBe(0);
    expect(PLATFORM_FREEZE_MEASUREMENT.breaks).toBe(435);
  });

  it('covers the longest ordinary break and refuses to chase the outlier', () => {
    expect(PLATFORM_FREEZE_WORST_CASE_MS).toBeGreaterThan(
      PLATFORM_FREEZE_MEASUREMENT.longestOrdinaryMs
    );
    // The 4222s incident on 2026-09-18 is not a break, and waiting for it
    // would be waiting through an outage.
    expect(PLATFORM_FREEZE_WORST_CASE_MS).toBeLessThan(
      PLATFORM_FREEZE_MEASUREMENT.longestObservedMs
    );
    // The ceiling is the database's own: fn_platform_frozen ignores a
    // counting-down row whose window exceeds announced_at + 15 minutes.
    expect(PLATFORM_FREEZE_CEILING_MS).toBe(900_000);
  });

  it('sizes the wait from the break row, not from a constant', () => {
    const now = Date.parse('2026-09-30T18:55:00.000Z');
    const wholeWindow = freezeBudgetMs({ break_ends_at: '2026-09-30T19:00:00.000Z' }, now);
    expect(wholeWindow).toBe(300_000 + PLATFORM_FREEZE_THAW_TAIL_MS);

    const nearlyOver = freezeBudgetMs(
      { break_ends_at: '2026-09-30T19:00:00.000Z' },
      Date.parse('2026-09-30T18:59:00.000Z')
    );
    expect(nearlyOver).toBe(60_000 + PLATFORM_FREEZE_THAW_TAIL_MS);
    expect(nearlyOver).toBeLessThan(wholeWindow);

    // Past break_ends_at the engine is still thawing: the measured tail is
    // 95s to 278s, never zero.
    const pastTheWindow = freezeBudgetMs(
      { break_ends_at: '2026-09-30T19:00:00.000Z' },
      Date.parse('2026-09-30T19:02:00.000Z')
    );
    expect(pastTheWindow).toBe(PLATFORM_FREEZE_THAW_TAIL_MS);
  });

  it('falls back to the database ceiling when the row cannot be read', () => {
    expect(freezeBudgetMs(null, Date.now())).toBe(PLATFORM_FREEZE_CEILING_MS);
    expect(freezeBudgetMs({ break_ends_at: null }, Date.now())).toBe(PLATFORM_FREEZE_CEILING_MS);
    expect(freezeBudgetMs({ break_ends_at: 'not a time' }, Date.now())).toBe(
      PLATFORM_FREEZE_CEILING_MS
    );
  });

  it('returns as soon as the freeze lifts', async () => {
    let reads = 0;
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await awaitPlatformThaw({
      isFrozen: async () => {
        reads += 1;
        return reads < 3;
      },
      budgetMs: 600_000,
      sleep,
    });
    expect(result.outcome).toBe('thawed');
    expect(reads).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(PLATFORM_FREEZE_POLL_MS);
    expect(describeThaw(result)).toContain('the platform freeze lifted');
  });

  it('spends the whole budget and then says the freeze outlived it', async () => {
    const result = await awaitPlatformThaw({
      isFrozen: async () => true,
      budgetMs: 60_000,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    expect(result.outcome).toBe('exhausted');
    expect(result.polls).toBeLessThanOrEqual(60_000 / PLATFORM_FREEZE_POLL_MS + 1);
    expect(describeThaw(result)).toContain('still enforced');
  });

  it('never reads an unreadable freeze as a thaw', async () => {
    const result = await awaitPlatformThaw({
      isFrozen: async () => {
        throw new Error('503 schema cache');
      },
      budgetMs: 30_000,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    expect(result.outcome).toBe('unreadable');
    expect(result.failedReads).toBe(result.polls);
    expect(describeThaw(result)).toContain('UNKNOWN, not a thaw');
  });

  it('leaves no blind tick budget in either cleanup path', () => {
    const helper = source('tests/e2e/support/temporaryCustomizationAccount.ts');
    const script = source('scripts/ci/production-e2e-account.mjs');
    for (const text of [helper, script]) {
      expect(text).toContain('awaitPlatformThaw');
      expect(text).toContain('fn_platform_frozen');
      expect(text).toContain('engine_maintenance_break');
      expect(text).not.toContain('PLATFORM_FREEZE_CLEANUP_ATTEMPTS');
      expect(text).not.toMatch(/attempt\s*(===|==)\s*36/);
    }
  });
});
