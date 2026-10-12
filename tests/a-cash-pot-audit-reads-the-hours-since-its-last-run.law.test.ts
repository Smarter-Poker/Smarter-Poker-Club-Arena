/**
 * A CASH POT AUDIT READS THE HOURS SINCE ITS LAST RUN (2026-10-03).
 *
 * Pinned on migration 20261003044110. ca-cash-pot-conservation-hourly (job
 * 259) runs every 6 hours and read 24 hours each time; it was cancelled at
 * its 600 s budget in 3 of 5 runs. It now reads 8 hours, so every cash hand
 * is still inside the window of the first run after it is written, and the
 * failure intake's pinned command moves in the same transaction so a failed
 * run is still delivered.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const sql = read(
  'supabase/migrations/20261003044110_a_cash_pot_audit_reads_the_hours_since_its_last_run.sql'
);
const NEW_COMMAND =
  "SET statement_timeout = '600s'; SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-cash-pot-conservation')) THEN (SELECT count(*)::int FROM public.fn_cash_pot_conservation_check(8)) ELSE -1 END;";

describe('a cash pot audit reads the hours since its last run', () => {
  it('is one transaction with a live proof and bounded locks', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toMatch(/^-- @live-proof: /m);
    expect(sql).toMatch(/SET LOCAL lock_timeout = '3s';/);
  });

  it('pins the job it rewrites and keeps its schedule', () => {
    expect(sql).toMatch(/md5\(command\) = '72b3dc33b68f7354a0282c676315bc84'/);
    expect(sql).toMatch(/md5\(command\) = '574ffca254298b8638eb4f4ff048894e'/);
    expect(sql).not.toMatch(/schedule :=/);
    expect(sql).toMatch(/schedule = '34 \*\/6 \* \* \*'/);
  });

  it('reads 8 hours every 6 hours, so every hand is still read at least once', () => {
    expect(sql).toMatch(
      /replace\(command,\s+'public\.fn_cash_pot_conservation_check\(\)\)',\s+'public\.fn_cash_pot_conservation_check\(8\)\)'\)/
    );
  });

  it('moves the failure intake pin with the command, by pinned substitution', () => {
    expect(sql).toMatch(/'public\.fn_ca_cash_failed_run_intake\(\)',/);
    expect(sql).toMatch(/'3ef722e8990b508b8741ee2e558f19c1', '23c2e46cf1e251d5e665056a2c1f09a6'/);
    expect(sql).toMatch(/owner, security, settings or grants moved/);
    expect(sql).toMatch(/the failure intake does not pin the live command/);
  });

  it('changes no checker body, index or grant', () => {
    expect(sql).not.toMatch(/fn_cash_pot_conservation_check\(integer\)/);
    expect(sql).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i);
    expect(sql).not.toMatch(/^\s*(GRANT|REVOKE)\b/im);
  });

  it('the CI scheduler fixture schedules the same command the intake pins', () => {
    const fixture = read('scripts/ci/test-cash-failure-pgcron.py');
    expect(fixture).toContain(`COMMAND="${NEW_COMMAND}"`);
    const literal = NEW_COMMAND.replace(/'/g, "''");
    for (const p of [
      'supabase/components/cash-failed-run-intake.sql',
      'supabase/components/cash-failed-run-intake.rollback.sql',
    ]) {
      const c = read(p);
      expect(c.split(`v_command constant text := '${literal}';`).length - 1).toBe(2);
      expect(c).toContain("md5(command)='574ffca254298b8638eb4f4ff048894e'");
      expect(c).not.toContain('fn_cash_pot_conservation_check())');
    }
  });
});
