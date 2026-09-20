/**
 * ===========================================================================
 *  LAW: AN AMOUNT THAT CANNOT BE COMPUTED IS NOT A NUMBER
 * ===========================================================================
 *
 * `fn_ca_cron_health()` calls a scheduled job that has run and never once
 * succeeded `critical`, and Cron Health fails the run on one. Measured
 * 2026-09-19, two of them were the same bug:
 *
 *   rake-law-wide-daily        1 run,   0 successes   critical
 *   rake-law-adherence-hourly  24 runs, 1 success     warn
 *
 * Both died on `null value in column "ledger_balance" of relation
 * "ledger_reconcile_log" violates not-null constraint`.
 *
 * `fn_rake_law_violations` returns eight kinds of finding, and three of them
 * return NULL for the allowed rake ON PURPOSE: `board_not_recorded`,
 * `players_not_recorded` and `impossible_showdown` are all "the hand record is
 * incomplete", and the amount the spec allows cannot be computed from an
 * incomplete record. The writer put that NULL into a NOT NULL column, the
 * INSERT raised, and because the whole check is a single statement EVERY
 * finding in that window died with it. A warn-level row about a missing board
 * was destroying the `over_spec` and `under_spec` violations beside it. The
 * last rake_law row the estate recorded was 2026-09-17 04:40.
 *
 * THE FIX THAT WOULD HAVE BEEN WRONG is COALESCE(v.allowed, 0). Zero is a
 * number, and this one either invents a drift that did not happen or erases a
 * violation that did. The amount is absent, so the row records it as absent
 * and says why, and a CHECK makes sure it always says why.
 *
 * That is the whole law: in an accounting log, "I could not compute this" and
 * "this is zero" are different facts, and only one of them may be written as
 * a number.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const FIX =
  'supabase/migrations/20260919153843_a_rake_violation_nobody_can_price_still_gets_logged.sql';
const READER = '.github/workflows/cron-health.yml';

/** This law lands here; anything newer is bound by the forward guard. */
const THIS_VERSION = '20260919153843';

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read(FIX);

/** The migration with its prose taken out, for assertions about the DDL. */
const DDL = SQL.replace(/--[^\n]*/g, '');

describe('an amount that cannot be computed is not a number', () => {
  it('the two amounts may be absent', () => {
    expect(DDL).toContain('ALTER COLUMN ledger_balance DROP NOT NULL');
    // stored_balance gets the same treatment although no NULL has been seen in
    // it: the failure was one unfillable column taking down every other
    // finding in the batch, and leaving the second able to do it next week is
    // not a fix.
    expect(DDL).toContain('ALTER COLUMN stored_balance DROP NOT NULL');
  });

  it('but only when the row names the column and says why', () => {
    expect(DDL).toContain('ledger_reconcile_log_unknowable_is_explained');
    expect(DDL).toMatch(
      /ledger_balance IS NOT NULL OR COALESCE\(metadata->'unknowable' \? 'ledger_balance', false\)/
    );
    expect(DDL).toMatch(
      /stored_balance IS NOT NULL OR COALESCE\(metadata->'unknowable' \? 'stored_balance', false\)/
    );
    // COALESCE, because a CHECK whose expression is NULL PASSES. Without it
    // the constraint would admit exactly the rows it exists to refuse.
    expect(DDL).toContain('COALESCE(metadata->');
  });

  it('the writer explains the absence instead of filling it in', () => {
    // The wrong fix, asserted against the CODE. The header names it on
    // purpose, so that the next reader meets it already argued against, and a
    // bare not.toContain fails on that sentence. It did, on the first run of
    // this law, which is the third time in a day a guard here has been
    // satisfied or broken by prose about itself.
    expect(DDL).not.toContain('COALESCE(v.allowed');
    expect(DDL).not.toMatch(/COALESCE\(v\.rake,/);
    expect(SQL, 'the header must still name the fix it refused').toContain(
      'COALESCE(v.allowed, 0)'
    );
    // The note is prose and may say "an amount this record does not carry";
    // that is a sentence, not a balance.
    expect(SQL).toContain("COALESCE(v.rake::text, 'an amount this record does not carry')");
    expect(SQL).toMatch(/jsonb_build_object\('unknowable'/);
    expect(SQL).toContain('the amount the spec allows cannot be computed');
  });

  it('it proves both directions before it commits', () => {
    // Running the check is not proof on its own: a constraint that accepts
    // everything would also let it run.
    expect(SQL).toMatch(/INSERT INTO public\.ledger_reconcile_log \(entity_type, ledger_balance/);
    expect(SQL).toMatch(/EXCEPTION WHEN check_violation THEN/);
    expect(SQL).toMatch(/failed: a null balance with no explanation was accepted/);
    expect(SQL).toMatch(/v_rows := public\.fn_rake_law_check\('2 hours'::interval\)/);
    expect(SQL).toMatch(/failed: a rake_law row carries an unexplained absent balance/);
  });

  it('the finding has a reader, or none of this is watched', () => {
    const reader = read(READER);
    expect(reader).toContain('fn_ca_cron_health');
    expect(reader).toContain("steps.cron.outputs.status != '0'");
  });

  /**
   * THE ONE THAT MATTERS LATER. The next person to meet this failure will meet
   * it as a red job and a NOT NULL error, and the one-line fix that makes the
   * error go away is the one that puts a fabricated zero in an accounting log.
   */
  it('no later migration restores the constraint or fills the gap with a number', () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(MIGRATIONS).sort()) {
      if (!file.endsWith('.sql')) continue;
      if (file.slice(0, file.indexOf('_')) <= THIS_VERSION) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');
      if (
        /ALTER\s+COLUMN\s+(ledger_balance|stored_balance)\s+SET\s+NOT\s+NULL/i.test(sql) ||
        /COALESCE\s*\(\s*v\.allowed\s*,/i.test(sql) ||
        /COALESCE\s*\(\s*v\.rake\s*,/i.test(sql)
      ) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      'a migration either puts NOT NULL back on ledger_reconcile_log, or fills an ' +
        'uncomputable rake with a number. Three of the eight findings ' +
        'fn_rake_law_violations returns carry NULL on purpose, because the hand record ' +
        'is incomplete and the spec amount cannot be derived from it. A zero there ' +
        'either invents a drift or erases a violation, and the NOT NULL is what made a ' +
        'warn-level row destroy every critical violation found beside it, for two days. ' +
        'Record the absence and explain it, as 20260919153843 does.'
    ).toEqual([]);
  });
});
