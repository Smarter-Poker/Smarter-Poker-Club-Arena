import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/*
 * Dan 2026-10-17: is "paid at issue" the right rule for weekly statements?
 * Decided: yes, for a record nobody owes, and only for that record. The rule
 * was installed by 20261015180754 with no reviewed source; this pins the
 * reviewed record of it so the scope cannot widen silently.
 */
const MIGRATION = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261017104853_the_weekly_statement_paid_at_issue_is_a_record_rule.sql'
  ),
  'utf8'
);
const code = MIGRATION.replace(/^--.*$/gm, '');

describe('the weekly statement paid-at-issue rule is a reviewed record rule', () => {
  it('asserts the exact live trigger: BEFORE INSERT on settlement_invoices, enabled', () => {
    expect(code).toContain(
      "'CREATE TRIGGER trg_weekly_statement_issue_settled BEFORE INSERT ON public.settlement_invoices FOR EACH ROW EXECUTE FUNCTION fn_weekly_statement_issue_settled()'"
    );
    expect(code).toContain("v_enabled IS DISTINCT FROM 'O'");
  });

  it('asserts the exact live function body by md5 and refuses if it moved', () => {
    expect(code).toContain("md5(v_src) IS DISTINCT FROM '9a23bbfc5575db47afe7cd9067f65d82'");
    expect(code).toContain('RAISE EXCEPTION');
    expect(MIGRATION).toMatch(/@live-proof: \(SELECT md5\(p\.prosrc\) = '9a23bbfc/);
  });

  it('documents the scope: one invoice type, generated to paid, insert only', () => {
    expect(MIGRATION).toContain("IF NEW.invoice_type = 'club_weekly_accounting'");
    expect(MIGRATION).toContain("COALESCE(NEW.status, 'generated') = 'generated'");
    expect(code).toContain('never touches any receivable or payable invoice type');
  });

  it('changes no row and no behaviour', () => {
    expect(code).not.toMatch(
      /\b(UPDATE|INSERT INTO|DELETE FROM|CREATE OR REPLACE FUNCTION|DROP)\b/i
    );
  });
});
