/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE UNUSED-INDEX EVIDENCE COULD NEVER ARRIVE (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The 2026-08-26 mechanism got the hard part right: it refused to call an index
 * unused from `idx_scan` alone, because that counter resets on restart, and it
 * built a snapshot table so the claim could be evidenced. Its rule was "two
 * snapshots spanning the requested days with NO postmaster restart between
 * them".
 *
 * Correct, and in this environment unsatisfiable. Measured five days later:
 *
 *     captures ................. 6
 *     distinct server epochs ... 6      <- one capture per epoch, every time
 *     uninterrupted history .... 0.000 days in EVERY epoch
 *
 * The snapshot ran daily (pg_cron 140, `41 4 * * *`) and this server restarts
 * about daily, so every capture landed in a fresh epoch. fn_truly_unused_indexes
 * returned nothing for any n > 0 and always would have. Fail-safe machinery that
 * can never reach a verdict is not a safeguard, it is a permanent abstention -
 * and it left ~1.4 GB of possibly-dead index on the ledger tables unexaminable.
 *
 * Two changes, and NOT ONE DROPPED INDEX: snapshot every two hours (faster than
 * the restarts) and sum per-epoch deltas (a restart resets the counter, so the
 * deltas either side ADD; they cannot be subtracted end to end).
 *
 * These pin the shape so it cannot regress to the version that could not answer.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/* BOTH halves of the change. The second file exists because two defects were
   found by RUNNING the first against production - a sum() that returned the
   wrong type on every call, and the cron cadence that is the actual fix. The
   repo must carry what production runs, so the tests read both. */
const MIGRATION = [
  '20260831_index_evidence_that_can_actually_accumulate.sql',
  '20260831b_index_evidence_cron_and_bigint_cast.sql',
]
  .map((f) => readFileSync(resolve(__dirname, '../../supabase/migrations/', f), 'utf8'))
  .join('\n');
/* The migration quotes the old rule to explain it, so comment lines are
   stripped before asserting on code - the same trap the definer gate
   documents in its own stripComments(). */
const CODE = MIGRATION.split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');

describe('the reader sums across epochs instead of demanding one long one', () => {
  it('groups by postmaster_start, so a restart bounds a delta rather than voiding it', () => {
    expect(CODE).toMatch(/GROUP BY[^;]*postmaster_start/i);
    expect(CODE).toMatch(/max\(s\.idx_scan\) - min\(s\.idx_scan\)/);
  });

  it('ADDS the per-epoch deltas rather than subtracting across a reset', () => {
    // Subtracting a later reading from an earlier one across a restart yields
    // a negative or meaningless number - that is the whole reason for summing.
    expect(CODE).toMatch(/sum\(p\.scans\)/);
    expect(CODE).toMatch(/sum\(p\.span_seconds\)/);
  });

  it('still FAILS CLOSED on insufficient evidence', () => {
    // The original's best property. An index must be watched for p_min_days
    // before it can be called dead, so a new index is never mistaken for one.
    expect(CODE).toMatch(/t\.total_scans = 0/);
    expect(CODE).toMatch(/t\.observed_days >= p_min_days/);
  });
});

describe('the counters are captured faster than the server resets them', () => {
  it('does not leave the snapshot on a daily cadence', () => {
    // Daily capture against daily restart is what produced 0.000 days of
    // uninterrupted history six times in a row.
    expect(MIGRATION).toMatch(/every two hours|41 \*\/2 \* \* \*/);
  });

  it('prunes, because the faster cadence would otherwise cost real storage', () => {
    // 3,076 indexes x 12 captures a day is ~448 MB in sixty days. Only the
    // first and last capture of a finished epoch carry delta information.
    expect(CODE).toMatch(/fn_prune_index_usage_snapshots/);
    expect(CODE).toMatch(/s\.taken_at <> b\.lo/);
    expect(CODE).toMatch(/s\.taken_at <> b\.hi/);
  });

  it('never prunes the epoch still in progress', () => {
    // Its latest capture is still moving; collapsing it would discard the
    // reading the next delta is measured from.
    expect(CODE).toMatch(/postmaster_start <> \(SELECT max\(postmaster_start\)/);
  });
});

describe('the type bug that made every call fail', () => {
  /* MIGRATIONS ARE APPEND-ONLY, so the buggy line still exists in the first
     file and must - that is the history of what was applied. What matters is
     the LAST definition, which is the one Postgres is running. Asserting the
     bad text is absent from the whole directory would demand editing history,
     the same trap the definer gate hit on 2026-08-31. */
  const FINAL = readFileSync(
    resolve(
      __dirname,
      '../../supabase/migrations/20260831b_index_evidence_cron_and_bigint_cast.sql'
    ),
    'utf8'
  );

  it('the FINAL definition casts the summed scans back to bigint', () => {
    // sum(bigint) returns NUMERIC and the RETURNS TABLE column is bigint, so
    // the first revision raised "Returned type numeric does not match expected
    // type bigint in column 5" on EVERY call. plpgsql does not check a RETURN
    // QUERY's shape until it runs, so CREATE FUNCTION accepted it happily.
    expect(FINAL).toMatch(/sum\(p\.scans\)::bigint/);
    expect(FINAL).toMatch(/max\(p\.bytes\)::bigint/);
  });

  it('asserts the function RUNS, not merely that it was created', () => {
    // The only check that could have caught the type error.
    expect(FINAL).toMatch(
      /SELECT count\(\*\) INTO v_n FROM public\.fn_truly_unused_indexes\(9999\)/
    );
  });
});
