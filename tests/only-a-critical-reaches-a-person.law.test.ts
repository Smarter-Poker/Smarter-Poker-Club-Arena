/**
 * ONLY A CRITICAL THAT NEEDS A PERSON REACHES A PERSON.
 *
 * Dan, 2026-09-06: "HAVE THE PUSH NOTIFICATIONS STOP UPDATING ME FOR 0.00 OR
 * FIXES, ONLY CRITICAL ERRORS THAT NEED MY ATTENTION ONLY SHOULD BE SENT TO MY
 * PHONE."
 *
 * Two things were paging him several times an hour for money that was correct:
 *
 * 1. fn_ca_escrow_on_close judged the escrow balance at the instant a
 *    tournament reached COMPLETED - before the reconciler pays the prizes - so
 *    it reported the prize pool itself as chips still in escrow. Eight of its
 *    ten most recent incidents now read prize_balance 0.00, and three checked
 *    against tournament_payouts had prize_out equal to the sum of their payout
 *    rows exactly. It stamps closed_at and close_note now and raises nothing;
 *    fn_ca_escrow_vs_counter_check asks the same question after settlement has
 *    had time to happen.
 *
 * 2. fn_ca_incident_notify pushed on warnings, on incidents carrying 0.00, and
 *    on RESOLUTIONS. Three gates now sit on the push only - the incident is
 *    still filed and the board still shows everything.
 *
 * The migration that shipped this proves itself: it files a warning, a 0.00
 * critical and a resolution and asserts none of them page, then files a real
 * critical carrying 12,345.67 chips and asserts that one still does. Both
 * directions, because a gate drawn too tight silences a genuine loss.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const file = readdirSync(MIGRATIONS).find((f) =>
  f.includes('only_a_critical_that_needs_a_person_reaches_a_person')
);
const sql = file ? readFileSync(join(MIGRATIONS, file), 'utf8') : '';

describe('only a critical that needs a person reaches a person', () => {
  it('the migration exists', () => {
    expect(file, 'the notification-gate migration must not be deleted').toBeTruthy();
  });

  it('a fix never pages, and it is checked first', () => {
    expect(sql).toContain("IF v_kind = 'resolved' THEN");
    expect(sql).toContain("v_withheld := 'a fix is not a page'");
    // resolved is checked before severity, or a resolved critical slips through
    expect(sql.indexOf("v_kind = 'resolved'")).toBeLessThan(sql.indexOf("<> 'critical'"));
  });

  it('anything below critical never pages', () => {
    expect(sql).toMatch(/lower\(COALESCE\(inc\.severity,''\)\) <> 'critical'/);
  });

  it('a zero never pages', () => {
    expect(sql).toMatch(/COALESCE\(inc\.discrepancy_amount, 0\) = 0/);
  });

  it('a withheld push is recorded, not silently dropped', () => {
    expect(sql).toContain("'notify_withheld'");
    expect(sql).toContain("jsonb_build_object('reason', v_withheld");
    // and the events table can actually hold that kind - the first version
    // could not, the insert threw, and the swallow-all handler hid it
    expect(sql).toContain('ca_incident_events_kind_check');
  });

  it('the close trigger records and no longer guesses', () => {
    const fn = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_close()'),
      sql.indexOf('-- Close the ones it already filed')
    );
    expect(fn).toContain('close_note');
    expect(fn).not.toContain('fn_ca_raise_drift_incident');
  });

  it('the migration proves both directions against the real table', () => {
    expect(sql).toContain('VERIFY FAILED: a warning paged');
    expect(sql).toContain('VERIFY FAILED: a 0.00 critical paged');
    expect(sql).toContain('VERIFY FAILED: a resolution paged');
    // the one that stops the gates being drawn too tight
    expect(sql).toContain('was WITHHELD');
    expect(sql).toContain('ca_verify_rollback');
  });
});
