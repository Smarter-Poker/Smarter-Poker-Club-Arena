/**
 * AN AUDIT RUNS UNDER THE BUDGET IT WAS MEASURED AGAINST (2026-10-03).
 *
 * Pinned on migration 20261003025058. Eight cron jobs still ran under the
 * postgres role's 2-minute limit because their budget lived where it never
 * applies (a function SET, a set_config inside the statement, or a SET LOCAL
 * of 120 s). Each now opens with a separate SET statement_timeout = '300s'.
 * Two windows that re-read far more than one run needs are narrowed while
 * every row is still checked many times over.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sql = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261003025058_an_audit_runs_under_the_budget_it_was_measured_against.sql'
  ),
  'utf8'
);

describe('an audit runs under the budget it was measured against', () => {
  it('is one transaction with a live proof', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toMatch(/^-- @live-proof: /m);
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/);
  });

  it('pins every command it rewrites before rewriting it', () => {
    for (const id of [76, 123, 128, 134, 143, 157, 178, 231]) {
      expect(sql).toMatch(new RegExp(`\\(${id},\\s+'[a-z0-9_-]+',`));
    }
    expect(sql).toMatch(/RAISE EXCEPTION 'preimage: job 227/);
    expect(sql).toMatch(/RAISE EXCEPTION 'preimage: job 144/);
  });

  it('puts the budget in the first statement, where it takes effect', () => {
    expect(sql).toMatch(
      /cron\.alter_job\(jobid, command := 'SET statement_timeout = ''300s''; ' \|\| command\)\s+FROM cron\.job WHERE jobid IN \(76, 123, 128, 134, 143, 157, 178\);/
    );
    expect(sql).toMatch(
      /replace\(ltrim\(command\), 'SET LOCAL statement_timeout = ''120s'';', ''\)/
    );
    expect(sql).toMatch(/command LIKE 'SET statement_timeout = ''300s''; %'\) <> 8/);
  });

  it('narrows two windows and still covers every row many times', () => {
    expect(sql).toMatch(
      /replace\(command, 'fn_payout_guarantee_check\(\)',\s+'fn_payout_guarantee_check\(2\)'\)/
    );
    expect(sql).toMatch(
      /replace\(command, 'fn_tournament_money_conservation\(2, 1\.0, 200\)',\s+'fn_tournament_money_conservation\(1, 1\.0, 200\)'\)/
    );
  });

  it('changes no function body, schedule, grant or index', () => {
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i);
    expect(sql).not.toMatch(/schedule\s*:=/i);
    expect(sql).not.toMatch(/^\s*(GRANT|REVOKE|DROP)\b/im);
  });
});
