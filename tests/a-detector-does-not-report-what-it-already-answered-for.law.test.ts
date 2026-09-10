/**
 * A DETECTOR DOES NOT REPORT WHAT IT ALREADY ANSWERED FOR (2026-09-10).
 *
 * Incident 28119497 was resolved at 13:23 with a correction_ref naming the two
 * migrations that fixed the tournament-lease churn, and asserting the
 * measurement: zero "lease proof expired" hand-commit refusals in the eleven
 * hours since. At 13:52 the sweep opened 81150ce8 - same source, same 117
 * refusals, every one of them from 02:xx, every one of them from the cause that
 * had just been fixed.
 *
 * `fn_ca_hand_commit_refusals` reads a ROLLING 24-hour window with a floor of
 * 25, so those 117 would have re-opened the same incident once an hour until
 * they aged out the following morning. Resolving one only let the next sweep
 * open another - the same trap as the append-only notice closed forty minutes
 * earlier, and what CLAUDE.md 10.84 means by an alarm that is always on being
 * an alarm that gets muted.
 *
 * THE RULE: a detector's window starts at the LATER of its own rolling span and
 * the resolved_at of the most recent incident for its source that carries a
 * correction_ref. A correction_ref is a written assertion that the cause was
 * fixed at that instant; anything after it still counts, still clears the same
 * floor, and still raises. Only history stops being re-reported as news. A
 * resolution with no correction_ref (`verified:`, `no-change-needed:`) does not
 * move the window at all.
 *
 * This test pins the shape so the next detector that needs it copies a correct
 * one, and so nobody "simplifies" the watermark back out.
 *
 * docs/changelog/2026-09-10-a-detector-does-not-report-what-it-already-answered-for.md
 */
import { describe, it, expect } from 'vitest';
import { migrationCorpus } from './helpers/migrationCorpus';

const NAME = '20260910140538_a_detector_does_not_report_what_it_already_answered_for.sql';

const migration = () => {
  const hit = migrationCorpus().find((m) => m.name === NAME);
  expect(hit, `${NAME} must exist`).toBeDefined();
  return hit!.sql;
};

describe('a detector does not report what it already answered for', () => {
  it('the window starts at the later of the rolling span and the correction', () => {
    const sql = migration();
    expect(sql).toContain('AND a.created_at > GREATEST(');
    expect(sql).toContain('now() - make_interval(hours => GREATEST(COALESCE(p_hours, 24), 1))');
    expect(sql).toContain('SELECT max(i.resolved_at) FROM public.ca_drift_incidents i');
  });

  it('only a resolution that names a correction moves the window', () => {
    const sql = migration();
    expect(sql).toContain("i.status = ''resolved''");
    expect(sql).toContain("COALESCE(btrim(i.correction_ref), '''') <> ''''");
    // and an unresolved or uncorrected source leaves the rolling window alone
    expect(sql).toContain("''-infinity''::timestamptz");
  });

  it('it narrows WHEN the detector looks, never HOW LOUD it must be', () => {
    const sql = migration();
    expect(sql).toContain('the refusal detector lost its floor of 25');
    expect(sql).toContain('the refusal detector lost its rolling window');
  });

  it('the substitution is asserted, and the detector is proved quiet afterwards', () => {
    const sql = migration();
    // exactly one anchor, or the migration aborts rather than guessing
    expect(sql).toContain('the refusal detector carries % rolling-window clause(s), expected 1');
    // and zero findings after the change - which is what says the cause is gone
    // rather than merely hidden
    expect(sql).toContain('those are NEW refusals and the cause is not fixed');
  });
});
