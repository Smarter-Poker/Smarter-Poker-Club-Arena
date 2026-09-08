/**
 * LAW: A SCHEMA-CACHE RELOAD CANNOT LOSE A HAND.
 *
 * 2026-09-08. Two migrations, three minutes apart, made PostgREST reload its
 * schema cache. Every call answered 503 PGRST002 for the length of the reload,
 * and two retry ladders - both written expressly to survive that event - gave
 * up less than halfway through it:
 *
 *   syncStacks         5 attempts, 200ms doubling  -> ~11.5s
 *   queueUnbankedFee   4 attempts, 300ms tripling  -> ~10.7s
 *   PostgREST reload   measured on this database   ->  ~28s
 *
 * Eighteen hands' stack writes were dropped, carrying 155,335 chips of seat
 * movement, and 23 critical money alarms fired for fees that were all banked.
 *
 * THE SHAPE, AGAIN (CLAUDE.md 10.86): a guard that answers confidently about a
 * scope nobody stated. Both ladders named the reload in their own comments -
 * "buys the reload time to finish" - beside a number that never could, because
 * nobody wrote down how long a reload takes. It is written down now, in
 * SCHEMA_RELOAD_MEASURED_MS, and both halves are derived from it.
 *
 * Every pin below is a bug that actually shipped. Do not weaken one to make a
 * change pass; if you replace a mechanism, move the pin to the new one in the
 * same commit.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SCHEMA_RELOAD_MEASURED_MS,
  PENDING_WRITE_BUDGET_MS,
  PENDING_WRITE_MAX_DELAY_MS,
  MAX_PENDING_WRITES,
  enqueuePendingWrite,
  drainPendingWrites,
  pendingWriteCount,
  resetPendingWrites,
} from '../server/src/services/supabase/pendingWrites.js';

const ROOT = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
/**
 * Comments stripped, like tests/config does: a pin that a shape is ABSENT must
 * not be satisfied (or defeated) by prose describing the shape it replaced.
 */
const readCode = (p: string): string =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

describe('the off-path budget outlasts the event it exists for', () => {
  it('states what a reload costs on this database, measured, not guessed', () => {
    // CLAUDE.md section 2: ~970 relations, ~2,700 functions, ~28s per reload.
    expect(SCHEMA_RELOAD_MEASURED_MS).toBeGreaterThanOrEqual(28_000);
  });

  it('gives the off-path retry more patience than a single reload', () => {
    expect(PENDING_WRITE_BUDGET_MS).toBeGreaterThan(SCHEMA_RELOAD_MEASURED_MS);
  });

  it('covers consecutive reloads, because migrations arrive in batches', () => {
    // 2026-09-08 was two migrations three minutes apart; CLAUDE.md section 2
    // warns ten DDL statements outside a transaction cost ten reloads.
    expect(PENDING_WRITE_BUDGET_MS).toBeGreaterThanOrEqual(SCHEMA_RELOAD_MEASURED_MS * 5);
  });

  it('derives the budget from the measurement instead of re-typing a literal', () => {
    const src = read('server/src/services/supabase/pendingWrites.ts');
    expect(src).toMatch(/PENDING_WRITE_BUDGET_MS\s*=\s*SCHEMA_RELOAD_MEASURED_MS\s*\*/);
  });

  it('keeps retrying often enough that the budget buys many attempts', () => {
    expect(PENDING_WRITE_BUDGET_MS / PENDING_WRITE_MAX_DELAY_MS).toBeGreaterThanOrEqual(20);
  });

  it('is bounded, so an outage cannot grow the queue without limit', () => {
    expect(MAX_PENDING_WRITES).toBeGreaterThan(0);
    expect(MAX_PENDING_WRITES).toBeLessThanOrEqual(5_000);
  });
});

describe('the inline ladder stays inside the dealing budget', () => {
  it('does not try to span a reload on the path the next hand waits for', () => {
    const src = read('server/src/services/supabase/tables.ts');
    const attempts = Number(/const STACK_WRITE_ATTEMPTS = (\d+)/.exec(src)?.[1]);
    expect(attempts).toBeGreaterThan(0);

    // 200ms doubling: total sleep is 200 * (2^(n-1) - 1).
    const sleepMs = 200 * (2 ** (attempts - 1) - 1);
    // DEAL_STEP_BUDGET_MS is 20s; the dealing loop awaits postHandTasks. A
    // ladder that outgrows that budget parks the table instead of losing chips,
    // which is not an improvement.
    expect(sleepMs).toBeLessThan(20_000);
  });

  it('pins DEAL_STEP_BUDGET_MS, the ceiling the number above is measured against', () => {
    const base = read('server/src/engine/ServerTableEngineBase.ts');
    expect(base).toMatch(/DEAL_STEP_BUDGET_MS\s*=\s*20_000/);
  });

  it('hands the hand to the off-path retry instead of declaring it lost', () => {
    const src = read('server/src/services/supabase/tables.ts');
    expect(src).toContain('enqueuePendingWrite');
    // The alarm must be the give-up handler, not the exhaustion of the inline
    // ladder. Before 2026-09-08 it fired the moment five attempts were spent.
    const alarmIdx = src.indexOf("'DB.settle_hand_stacks_unreachable'");
    const giveUpIdx = src.indexOf('onGiveUp');
    expect(giveUpIdx).toBeGreaterThan(0);
    expect(alarmIdx).toBeGreaterThan(giveUpIdx);
  });

  it('retries a table&apos;s owed hands when that table next writes', () => {
    const src = read('server/src/services/supabase/tables.ts');
    expect(src).toMatch(/drainPendingWrites\(`stack:\$\{tableId\}:`\)/);
  });
});

describe('the fee queue gets the same two halves', () => {
  it('hands an unreachable queue insert off-path rather than alarming', () => {
    const src = read('server/src/services/FeeReconciler.ts');
    expect(src).toContain('enqueuePendingWrite');
  });

  it('never turns "could not ask" into "the fee was banked"', () => {
    const src = read('server/src/services/FeeReconciler.ts');
    // feeIsAccountedFor must be tri-state. As a boolean it discarded every
    // error and answered false while the database was unreachable - so it
    // could neither suppress a real alarm nor tell a blind guess from an
    // answer. Only a definite 'yes' may suppress the alarm.
    expect(src).toMatch(/type AccountedVerdict = 'yes' \| 'no' \| 'unknown'/);
    expect(src).toMatch(/return couldNotAsk \? 'unknown' : 'no';/);
    expect(src).toMatch(/if \(verdict === 'yes'\)/);
  });

  it('still fails CLOSED: unknown alarms, it just no longer lies about verifying', () => {
    const src = readCode('server/src/services/FeeReconciler.ts');
    // The pre-2026-09-08 rule stands - chips have left the pot and silence
    // about them is worse than a false alarm. What changed is that the alarm
    // is reached only after the off-path budget is spent, and that it now says
    // whether the verification actually ran.
    expect(src).toMatch(/const verified = verdict === 'no';/);
    expect(src).toMatch(/verifiedUnbanked: verified,/);
    expect(src).toMatch(/verificationUnavailable: !verified,/);
    expect(src).not.toMatch(/verifiedUnbanked: true/);
  });
});

describe('the off-path retry behaves', () => {
  beforeEach(() => {
    resetPendingWrites();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetPendingWrites();
  });

  it('lands a write that the dealing path could not, and stops trying', async () => {
    let calls = 0;
    enqueuePendingWrite({
      key: 'stack:t1:100',
      label: 'test',
      attempt: async () => {
        calls += 1;
        return calls >= 2 ? { done: true } : { done: false, error: 'PGRST002' };
      },
      onGiveUp: async () => {
        throw new Error('must not give up');
      },
    });
    expect(pendingWriteCount()).toBe(1);

    await drainPendingWrites('stack:t1:');
    expect(pendingWriteCount()).toBe(1); // first attempt failed, still owed
    await drainPendingWrites('stack:t1:');
    expect(calls).toBe(2);
    expect(pendingWriteCount()).toBe(0); // landed, and dropped
  });

  it('drains only the table it was asked about', async () => {
    const hit: string[] = [];
    for (const key of ['stack:t1:1', 'stack:t2:1']) {
      enqueuePendingWrite({
        key,
        label: key,
        attempt: async () => {
          hit.push(key);
          return { done: true };
        },
        onGiveUp: async () => undefined,
      });
    }
    await drainPendingWrites('stack:t1:');
    expect(hit).toEqual(['stack:t1:1']);
    expect(pendingWriteCount()).toBe(1);
  });

  it('refuses a second entry for the same hand', () => {
    const w = {
      key: 'stack:t1:7',
      label: 'x',
      attempt: async () => ({ done: true }) as const,
      onGiveUp: async () => undefined,
    };
    expect(enqueuePendingWrite(w)).toBe(true);
    expect(enqueuePendingWrite(w)).toBe(false);
    expect(pendingWriteCount()).toBe(1);
  });

  it('alarms exactly once, and only when the whole budget is spent', async () => {
    const gaveUp: string[] = [];
    enqueuePendingWrite({
      key: 'stack:t9:1',
      label: 'test',
      attempt: async () => ({ done: false, error: 'PGRST002' }),
      onGiveUp: async (err) => {
        gaveUp.push(err);
      },
    });

    // Inside the budget: keeps trying, says nothing.
    await drainPendingWrites('stack:t9:');
    expect(gaveUp).toEqual([]);
    expect(pendingWriteCount()).toBe(1);

    // Past it: gives up once, and the entry is gone so it cannot alarm twice.
    vi.setSystemTime(Date.now() + PENDING_WRITE_BUDGET_MS + 1_000);
    await drainPendingWrites('stack:t9:');
    expect(gaveUp).toEqual(['PGRST002']);
    expect(pendingWriteCount()).toBe(0);
    await drainPendingWrites('stack:t9:');
    expect(gaveUp).toHaveLength(1);
  });
});
