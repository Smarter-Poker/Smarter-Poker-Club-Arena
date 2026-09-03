/**
 * THE TIME BANK MUST NOT WRITE A VALUE THAT DID NOT CHANGE
 * ═══════════════════════════════════════════════════════════════════════════
 * `syncStacks` persisted `time_bank_remaining` for EVERY seated player after
 * EVERY hand. A time bank only moves on the hands where somebody burns it, so
 * the overwhelming majority of those were an UPDATE setting a column to the
 * value it already held.
 *
 * Postgres shrugs at that. Realtime does not. `table_seats` is in the
 * `supabase_realtime` publication, so each no-op write produced a WAL record
 * that `realtime.apply_rls` decoded and RLS-filtered for every subscriber.
 *
 * Measured 2026-09-02:
 *   - 408,121 of these calls, 98.7% of ALL table_seats writes;
 *   - table_seats is 36% of every write Realtime decodes;
 *   - `realtime.list_changes` was the largest single consumer of the database
 *     at 17.5% of total execution time, mean 460 ms - felt at the table as lag.
 *
 * The guard is a PostgREST filter rather than an in-memory diff: no cache to go
 * stale, correct across an engine restart and against any concurrent writer.
 *
 * THE DANGEROUS DIRECTION HERE IS NOT "WRITES TOO OFTEN". It is a filter that
 * fails to match when a value HAS changed, which drops a real write and, after
 * a restart, hands a player back a time bank they already spent. Every pin
 * below is aimed at that.
 */
import { describe, it, expect } from 'vitest';
import { timeBankChangedFilter } from './tables.js';

describe('timeBankChangedFilter', () => {
  it('matches when the remaining seconds differ', () => {
    expect(timeBankChangedFilter({ time_bank_remaining: 30 })).toContain(
      'time_bank_remaining.neq.30'
    );
  });

  it('matches when either column differs, never demanding both', () => {
    const f = timeBankChangedFilter({
      time_bank_remaining: 30,
      time_bank_uses_remaining: 3,
    });
    // PostgREST `or=` is a disjunction: one differing column is enough.
    expect(f).toContain('time_bank_remaining.neq.30');
    expect(f).toContain('time_bank_uses_remaining.neq.3');
    expect(f.split(',').length).toBe(4);
  });

  it('always carries an is.null arm for every column it filters', () => {
    // PostgREST `neq` uses SQL three-valued logic, so NULL does NOT satisfy
    // `neq` and a NULL row would be filtered out - silently skipping a write
    // that is needed. This arm is what keeps the guard correct if either
    // column ever loses its NOT NULL default.
    expect(timeBankChangedFilter({ time_bank_remaining: 30 })).toContain(
      'time_bank_remaining.is.null'
    );
    expect(timeBankChangedFilter({ time_bank_uses_remaining: 3 })).toContain(
      'time_bank_uses_remaining.is.null'
    );
  });

  it('only filters on a column it is actually writing', () => {
    const f = timeBankChangedFilter({ time_bank_remaining: 30 });
    expect(f).not.toContain('time_bank_uses_remaining');
  });

  it('handles zero, which is a real time bank value and not absence', () => {
    // 28% of live seats sit at 0. `if (x)` would treat that as missing and
    // drop the guard; the code tests `!== undefined` for exactly this reason.
    const f = timeBankChangedFilter({ time_bank_remaining: 0, time_bank_uses_remaining: 0 });
    expect(f).toContain('time_bank_remaining.neq.0');
    expect(f).toContain('time_bank_uses_remaining.neq.0');
  });

  it('is empty when there is nothing to write, so no filter is applied', () => {
    expect(timeBankChangedFilter({})).toBe('');
  });
});
