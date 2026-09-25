/**
 * ===========================================================================
 *  LAW: THE RAKE AUDIT NEVER ASKS A REPAIR JOB WHEN TO LOOK (2026-09-22)
 * ===========================================================================
 *
 * fn_rake_bbj_invariants is the money alarm behind
 * rake-bbj-invariant-audit-hourly (fn_rake_bbj_audit(2)). Two of its money
 * checks used to take their grace period from a repair job's schedule:
 * I5 (a BBJ drop not banked to its pool) read cron.job_run_details for
 * ca-bbj-repair-unbanked-15m, and I7 (a raked hand never banked) read it for
 * rake-repair-unbanked-hourly. A job that is gone answers NULL, the fallback
 * was now() - 2 hours, and the audit passes p_hours = 2: an EMPTY window.
 * ca-bbj-repair-unbanked-15m had already been retired, so I5 read zero by
 * construction, and retiring rake-repair-unbanked-hourly would have blinded
 * I7 - the alarm that says whether that retirement was safe.
 *
 * The rake of an accepted hand is owed by its post-commit envelope, which
 * commits with the hand, and fn_ca_process_hand_post_commit_obligations banks
 * it in one transaction. So the grace is the writer's own five minutes, a
 * hand still owed by a pending envelope is I9 (late, not lost), and a hand
 * owed by nothing is I7 (lost).
 *
 * This pins the declaration in force (the LAST migration that declares the
 * function), so a later rewrite is judged too, and it refuses any later
 * migration that reaches for the scheduler from inside this function by a
 * textual patch instead of a declaration.
 *
 * Negatives are asserted against the body with SQL comments removed: the
 * function's own comment explains the scheduler it no longer reads.
 */
import { describe, expect, it } from 'vitest';
import { functionBody, latestDeclaring, migrationFiles, readMigration } from './helpers/migrations';
import { sliceBetween } from './helpers/sourceWindow';

const FIXED_IN = '20260922142525_the_rake_audit_reads_the_envelope_not_a_repair_schedule.sql';

/** SQL with its comments blanked. String literals stay: a check name is code. */
const withoutComments = (sql: string): string =>
  sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

const invariants = () => {
  const { name, sql } = latestDeclaring('fn_rake_bbj_invariants');
  return { name, body: withoutComments(functionBody(sql, 'fn_rake_bbj_invariants')) };
};

/** One check's branch of the UNION: from its name to the next check's name. */
const branch = (body: string, check: string, next: string): string => {
  expect(body, `${check} is in the audit`).toContain(`'${check}'`);
  expect(body, `${next} follows ${check}`).toContain(`'${next}'`);
  return sliceBetween(body, `'${check}'`, `'${next}'`);
};

describe('the rake audit takes its grace from the writer, never from a schedule', () => {
  it('is in force from the migration that removed the schedule lookup onward', () => {
    expect(migrationFiles()).toContain(FIXED_IN);
    expect(invariants().name >= FIXED_IN, invariants().name).toBe(true);
  });

  it('never reads the job scheduler and never waits for a repair job', () => {
    const { body } = invariants();
    expect(body).not.toMatch(/\bcron\s*\./i);
    expect(body).not.toMatch(/job_run_details/i);
    expect(body).not.toMatch(/repair[-_]unbanked/i);
    expect(body).not.toMatch(/_heal\b/i);
  });

  it('bounds its scope by its own five-minute grace', () => {
    const { body } = invariants();
    expect(body).toContain("v_grace timestamptz := now() - interval '5 minutes'");
    expect(body).toContain('AND r.created_at >= v_since AND r.created_at < v_grace');
  });

  it('I5 names the writer as its grace, and adds no bound of its own', () => {
    const i5 = branch(invariants().body, 'I5_drop_not_banked_to_pool', 'I6_ledger_not_reconciled');
    expect(i5).toContain("'grace_until', v_grace, 'grace_source', 'writer'");
    expect(i5).not.toMatch(/created_at\s*</);
  });

  it('I7 counts a raked hand with no rake record that no pending envelope still owes', () => {
    const i7 = branch(
      invariants().body,
      'I7_raked_hand_never_banked',
      'I9_rake_owed_by_a_pending_envelope'
    );
    expect(i7).toContain("'grace_until', v_grace, 'grace_source', 'writer'");
    expect(i7).toContain('AND hh.created_at >= v_since');
    expect(i7).toContain('AND hh.created_at < v_grace');
    expect(i7).toContain('NOT EXISTS (SELECT 1 FROM rake_records rr WHERE rr.hand_id = hh.id)');
    expect(i7).toMatch(
      /NOT EXISTS \(SELECT 1 FROM hand_atomic_commits c\s+WHERE c\.hand_id = hh\.id\s+AND c\.post_commit_payload IS NOT NULL\s+AND c\.post_commit_completed_at IS NULL\)/
    );
  });

  it('I9 counts every envelope still owing rake past the grace, however old', () => {
    const i9 = branch(
      invariants().body,
      'I9_rake_owed_by_a_pending_envelope',
      'I8_rake_banked_late'
    );
    expect(i9).toContain('FROM hand_atomic_commits c');
    expect(i9).toContain('c.post_commit_payload IS NOT NULL');
    expect(i9).toContain('c.post_commit_completed_at IS NULL');
    expect(i9).toContain('c.committed_at < v_grace');
    expect(i9).toMatch(/jsonb_typeof\(c\.post_commit_payload->'rake'\) = 'object'/);
    // No lower bound: a stuck envelope must never age out of the alarm.
    expect(i9).not.toContain('v_since');
    expect(i9).toMatch(/count\(\*\)::bigint/);
  });

  it('I8 no longer claims a healer banked the late rake', () => {
    const { body } = invariants();
    expect(body).toContain("'I8_rake_banked_late'");
    expect(body).not.toContain('by_a_healer');
  });

  it('fn_rake_bbj_audit still raises I5 and I7 as money', () => {
    const { sql } = latestDeclaring('fn_rake_bbj_audit');
    const body = withoutComments(functionBody(sql, 'fn_rake_bbj_audit'));
    expect(body).toContain(
      "('I3_deductions_exceed_pot','I5_drop_not_banked_to_pool','I7_raked_hand_never_banked')"
    );
    expect(body).toContain('FROM public.fn_rake_bbj_invariants(p_hours)');
  });

  it('no later migration patches the scheduler back into the audit', () => {
    const later = migrationFiles().filter((f) => f > FIXED_IN);
    const offenders = later.filter((f) => {
      const sql = withoutComments(readMigration(f));
      return (
        sql.includes('fn_rake_bbj_invariants') && /job_run_details|cron\s*\.\s*job\b/i.test(sql)
      );
    });
    expect(offenders).toEqual([]);
  });

  it('the fixing migration proves itself at apply time', () => {
    const sql = readMigration(FIXED_IN);
    expect(sql).toContain('-- @live-proof:');
    expect(sql).toContain('failed: fn_rake_bbj_invariants still reads the job scheduler');
    expect(sql).toContain('failed: I7 counted a hand whose envelope still owes it');
    expect(sql).toContain("RAISE EXCEPTION 'failed: the block starting % changed");
    expect(withoutComments(sql).trim().startsWith('BEGIN;')).toBe(true);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
  });
});
