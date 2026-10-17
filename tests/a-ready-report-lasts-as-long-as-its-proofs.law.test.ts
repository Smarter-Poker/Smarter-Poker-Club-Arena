/**
 * A READY REPORT LASTS AS LONG AS THE PROOFS IT RESTS ON (2026-10-17)
 *
 * The weekly close handed a kept ready report on for 30 minutes. Every attempt
 * after that re-proved it, timed out and rolled back the receipt it was about
 * to keep, so the 2026-10-05 Midway close could not reach round 3. A ready
 * report is built from the week's certified evidence, which is itself reused
 * for fn_accounting_close_proof_lifetime(); it is handed on for exactly that
 * long, and never after any of that week's certificates is certified again.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20261017195000_a_ready_report_lasts_as_long_as_its_proofs.sql',
  'utf8'
);
const added = sql.split('$n$')[1];

describe('a ready report lasts as long as its proofs', () => {
  it('uses the certificates own lifetime, not a constant', () => {
    expect(added).toContain('r.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime()');
    expect(added).not.toMatch(/interval '\d+ (minutes|hours)'/);
  });

  it('never hands on a report once that week has been re-proved after it', () => {
    expect(added).toContain('NOT EXISTS(SELECT 1 FROM public.accounting_close_certificates c');
    expect(added).toContain('c.union_id=p_union_id AND c.period_start=p_start AND c.period_end=p_end');
    expect(added).toContain('c.certified_at>r.computed_at');
  });

  it('changes only the seed, from its installed body', () => {
    expect(sql).toContain("'e859e4e5a081fef8d6116f31ec45d72e'");
    expect(sql).toContain("'981a3fdf3bdba29ed736f8656a9e544b'");
    expect(sql.match(/c_old constant text/g)?.length).toBe(1);
    expect(sql).toContain('fn_ca_break_window_refuses_migrations(now())');
  });
});
