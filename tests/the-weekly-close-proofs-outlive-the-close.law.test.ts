/**
 * THE WEEKLY CLOSE'S PROOFS OUTLIVE THE CLOSE (2026-10-16).
 *
 * Pinned on migration 20261016123337_the_weekly_close_proofs_outlive_the_close.sql.
 *
 * Dan, 2026-10-16: "GIVE THE RAKE BACK MORE TIME (UNLIMITED IF POSSIBLE)".
 *
 * The union week 2026-10-05..12 sat in 'running' for four days and 154
 * attempts. Job 272 proves a close in pieces and trusted each piece for 12
 * hours, but a union week takes longer than that to prove inside 240 s ticks,
 * so the first pieces expired before the last were proved and it began again.
 *
 * The tick did not get longer: 240 s is the Realtime replication bound
 * (tests/the-weekly-close-never-holds-replication.law.test.ts). The pieces now
 * last 72 hours. If you are here to shorten the lifetime again, measure how
 * long the largest close takes end to end first; it must fit with room.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261016123337_the_weekly_close_proofs_outlive_the_close.sql'
  ),
  'utf8'
);

const rewired = [
  'fn_accounting_close_certificate',
  'fn_accounting_close_windows_advance_due',
  'fn_accounting_close_windows_pending',
  'fn_accounting_union_earned_plan_advance',
  'fn_accounting_union_earned_plan_combine',
  'fn_settle_accounting_commission_advance',
  'fn_settle_accounting_commission_combine',
  'fn_settle_accounting_rakeback_advance',
  'fn_settle_accounting_rakeback_pairs',
  'fn_settle_accounting_rakeback_plan_get',
];

describe("the weekly close's proofs outlive the close", () => {
  it('is one transaction with live proofs and a lock timeout', () => {
    expect(sql.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(2);
  });

  it('trusts a proved piece for 72 hours, through one named helper', () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_accounting_close_proof_lifetime\(\)\s+RETURNS interval[\s\S]*?SELECT interval '72 hours'/
    );
    expect(sql).toContain(
      "new_text constant text := 'clock_timestamp()-public.fn_accounting_close_proof_lifetime()';"
    );
  });

  it('rewires all ten close functions from pinned preimages with exact counts', () => {
    for (const name of rewired) {
      expect(sql).toMatch(new RegExp(`'public\\.${name}\\([^']*\\)', '[0-9a-f]{32}', [1-3]\\)`));
    }
    expect(sql).toContain("IF md5(d) <> r.preimage THEN");
    expect(sql).toContain('IF n <> r.occurrences THEN');
    // 14 freshness tests across the ten functions
    const counts = [...sql.matchAll(/', '[0-9a-f]{32}', ([1-3])\)/g)].map((m) => Number(m[1]));
    expect(counts.length).toBe(10);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(14);
  });

  it('leaves the replication bound and the recompute rule alone', () => {
    expect(sql).not.toMatch(/statement_timeout/);
    expect(sql).not.toMatch(/cron\./);
    expect(sql).toContain("fn_rakeback_recompute_split was not meant to change");
  });
});
