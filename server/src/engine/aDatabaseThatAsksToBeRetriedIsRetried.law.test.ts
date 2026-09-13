/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DATABASE THAT ASKS TO BE RETRIED IS RETRIED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-12)
 *
 * `postHandTasks` writes the record of a hand that has already been played.
 * In the two hours to 11:00 on 2026-09-12 it failed 412 times, every one of
 * them the same thing:
 *
 *     atomic hand commit refused (atomic_hand_rolled_back):
 *     F06_RETRY_CANONICAL_LANE      attempts: 1   retry_budget: 0
 *
 * 820 critical financial alerts in all. The hand was dealt and settled; only
 * its record was lost.
 *
 * That error comes from one place, and it spells out the remedy:
 *
 *     -- smarter_private.f06_try_lane
 *     IF t IS NOT NULL AND (NOT pg_try_advisory_xact_lock_shared(
 *          hashtextextended('ca:tournament-terminal-settlement:v1',0)) ...
 *       RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
 *
 * ERRCODE 40001 is `serialization_failure`: the one error Postgres itself
 * defines as "this conflicted, run it again". The lock is taken before any
 * work, so nothing was written, and the caller is told
 * `atomic_hand_rolled_back` - a retry re-runs a transaction that committed
 * nothing.
 *
 * ── BOTH GATES WERE SHUT ──────────────────────────────────────────────────
 *
 * `isTransientDbError` asks, in its own title, "did the database blink, as
 * opposed to the code being wrong?" Every entry in it was a TRANSPORT failure
 * - ECONNRESET, fetch failed, socket hang up - and a serialization failure was
 * not among them. So the textbook case of the database blinking was answered
 * "the code is wrong".
 *
 * And `STEP_RETRY` gave `hand_history` no budget at all, so `attempts > budget`
 * was true on the very first throw. Even a recognised blink would have been
 * terminal.
 *
 * ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────
 *
 * It does not make every refusal retryable. The rule that was already written
 * over that retry loop still holds: "Every refusal the database gives on
 * purpose is a decision, not a queue." A constraint violation, a missing
 * column, a type error are all still terminal, and the last case here pins
 * that.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ServerTableEngineBase } from './ServerTableEngineBase.js';

const is = (e: unknown) =>
  (
    ServerTableEngineBase as unknown as {
      isTransientDbError: (e: unknown) => boolean;
    }
  ).isTransientDbError(e);

describe('the one error Postgres defines as "run it again"', () => {
  it('recognises the sentinel f06_try_lane raises by name', () => {
    expect(
      is(
        new Error('atomic hand commit refused (atomic_hand_rolled_back): F06_RETRY_CANONICAL_LANE')
      )
    ).toBe(true);
  });

  it('recognises a serialization failure by its SQLSTATE, whatever it says', () => {
    expect(is(Object.assign(new Error('could not complete'), { code: '40001' }))).toBe(true);
  });

  it('recognises the wordings a driver may hand back instead of a code', () => {
    expect(is(new Error('could not serialize access due to concurrent update'))).toBe(true);
    expect(is(new Error('deadlock detected'))).toBe(true);
  });

  it('still treats a deliberate refusal as a decision, not a queue', () => {
    // The comment over the retry loop this feeds: "Every refusal the database
    // gives on purpose is a decision, not a queue." These must never retry.
    expect(is(new Error('duplicate key value violates unique constraint'))).toBe(false);
    expect(is(new Error('column tables.rake_cap does not exist'))).toBe(false);
    expect(is(new Error('new row violates row-level security policy'))).toBe(false);
    expect(is(new TypeError('this.handController.getStat is not a function'))).toBe(false);
    // A near-miss code must not be read as 40001.
    expect(is(Object.assign(new Error('nope'), { code: '400010' }))).toBe(false);
    expect(is(Object.assign(new Error('nope'), { code: '23505' }))).toBe(false);
  });

  it('keeps every transport wording it already had', () => {
    for (const msg of [
      'TypeError: fetch failed',
      'ECONNRESET',
      'ETIMEDOUT',
      'socket hang up',
      'supabase_timeout',
      'deal_step_timeout: load_seats exceeded 20s',
    ]) {
      expect(is(new Error(msg)), msg).toBe(true);
    }
  });
});

describe('the record of a hand is worth another try', () => {
  const settlement = () => readFileSync(join(__dirname, 'ServerTableEngineSettlement.ts'), 'utf8');

  it('gives hand_history a retry budget', () => {
    // Without this, recognising the blink changes nothing: `attempts > budget`
    // is true on the first throw when the budget is zero.
    expect(settlement()).toMatch(/STEP_RETRY[\s\S]{0,900}hand_history:\s*[1-9]/);
  });

  it('leaves the seats lane budget alone', () => {
    expect(settlement()).toMatch(/STEP_RETRY[\s\S]{0,900}leave_pending:\s*2/);
  });

  it('still bounds the retry: two short waits inside one hand boundary', () => {
    // The felt holds 2.1-3.5s between hands. 250ms + 1s is invisible; an
    // unbounded retry inside the hand boundary would not be.
    expect(settlement()).toMatch(/STEP_RETRY_BACKOFF_MS\s*=\s*\[250,\s*1_000\]/);
  });
});
