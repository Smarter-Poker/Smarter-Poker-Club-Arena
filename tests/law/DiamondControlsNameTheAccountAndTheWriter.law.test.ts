/**
 * ==============================================================================
 *  THE DIAMOND CONTROLS NAME THE ACCOUNT AND THE WRITER (2026-09-03, Lane G)
 * ==============================================================================
 *
 * docs/DIAMOND-ACCOUNTING-STANDARD.md 3.3 DR6, DR10, DR11, DR12, DR13 and 3.4
 * layers 4 and 6.
 *
 * Before Lane G the diamond economy had one number per hour and no account
 * names: fn_ca_trial_balance knew fourteen CHIP accounts and no diamond
 * account, ca_manual_adjustments had eleven chip target kinds and no asset
 * column, ca_payout_freeze accepted one scope, and every one of the 603 rows
 * in ca_diamond_balance_audit said db_role = postgres, journaled = false and
 * nothing about who moved the diamonds.
 *
 * This law pins the SHAPE of the two migrations that fixed that, because each
 * pin is a thing that was actually missing:
 *
 *   1. the trial balance names its accounts, including the suspense row DR12
 *      needs and a total that is the sum of its own rows;
 *   2. the watch files DR11 and DR12 and files them as INCIDENTS, never as a
 *      freeze (an automatic opener can refuse a legitimate movement on a false
 *      alarm; the threshold is Dan's, standard 6.13);
 *   3. four eyes knows the asset, so a diamond back-pay cannot be proposed
 *      against a chip account;
 *   4. the kill switch knows the three diamond scopes;
 *   5. the audit fires on INSERT as well as UPDATE, names the writer and the
 *      money path, files DR6, and still cannot block a diamond movement.
 *
 * If you are here because a pin went red: do not weaken it. Every one of them
 * is a control that did not exist twelve hours before it was written, and the
 * economy it watches is 1,030,092 diamonds across 1,308 players.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const CONTROLS = '20260903003128_diamond_g_controls.sql';
const AUDIT = '20260903003714_diamond_g_the_audit_names_the_writer.sql';

const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');

/** The account names a trial-balance body returns, in the order it returns them. */
function accountsNamed(sql: string): string[] {
  const out: string[] = [];
  const re = /RETURN QUERY SELECT\s*\n?\s*'([a-z_]+)'::text/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Every value inside a CHECK (<col> IN (...)) list in the file. */
function checkListFor(sql: string, column: string): string[] {
  const re = new RegExp(`CHECK\\s*\\(${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i');
  const m = sql.match(re);
  if (!m) return [];
  return Array.from(m[1].matchAll(/'([a-z_]+)'/g)).map((x) => x[1]);
}

describe('the diamond controls name the account and the writer', () => {
  const controls = read(CONTROLS);
  const audit = read(AUDIT);

  it('both migrations exist and are one transaction each with a lock timeout', () => {
    for (const [name, sql] of [
      [CONTROLS, controls],
      [AUDIT, audit],
    ] as const) {
      expect(existsSync(join(MIGRATIONS, name)), `${name} is missing`).toBe(true);
      expect(sql, `${name} is not one transaction`).toMatch(/^\s*BEGIN;/m);
      expect(sql, `${name} does not commit`).toMatch(/COMMIT;\s*$/);
      expect(sql, `${name} has no lock_timeout`).toMatch(/SET LOCAL lock_timeout = '4s'/);
    }
  });

  // ---- DR11: the trial balance names the account -------------------------

  it('the trial balance names player_diamonds, diamond_house, suspense and total', () => {
    const named = accountsNamed(controls);
    for (const account of ['player_diamonds', 'diamond_house', 'suspense', 'total']) {
      expect(named, `fn_ca_diamond_trial_balance does not name ${account}`).toContain(account);
    }
    // and the four supporting rows the standard's chart asks for
    for (const account of [
      'diamond_debts',
      'promo_budgets_spent',
      'mirror_mismatch',
      'dead_stores',
    ]) {
      expect(named, `fn_ca_diamond_trial_balance does not name ${account}`).toContain(account);
    }
  });

  it('the total is the sum of the rows this call returned, never a stored column', () => {
    // ca_supply_snapshots.total was re-based on 2026-09-01 and the chip trial
    // balance read that re-basing as a 4,364,262.71 mint. ca_diamond_snapshots
    // .total double-counts the mirrors today. Neither may be read for a total.
    const totalRow = controls.slice(controls.indexOf("RETURN QUERY SELECT 'total'::text"));
    expect(totalRow).toMatch(/v_tot_now/);
    expect(totalRow).not.toMatch(/s0\.total|s1\.total/);
  });

  it('every account is guarded so a table another lane has not landed is a note, not an error', () => {
    expect(controls).toMatch(/'table absent'/);
    expect(controls).toMatch(/to_regclass\('public\.diamond_debts'\)/);
    expect(controls).toMatch(/to_regclass\('public\.ca_diamond_house'\)/);
  });

  // ---- DR11 + DR12: the watch --------------------------------------------

  it('the watch names DR11 and DR12 and files them as incidents', () => {
    expect(controls).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_ca_diamond_trial_balance_watch\(\)/
    );
    expect(controls).toMatch(/'DR11:trial_balance_break', 'warning'/);
    expect(controls).toMatch(/'DR12:suspense_nonzero', 'info'/);
    expect(controls).toMatch(/'DR11:trial_balance_summary', 'info'/);
    expect(controls).toMatch(/fn_ca_diamond_incident\(/);
  });

  it('the watch is scheduled hourly and never opens the payout freeze', () => {
    expect(controls).toMatch(
      /cron\.schedule\(\s*\n?\s*'ca-diamond-trial-balance-hourly',\s*\n?\s*'20 \* \* \* \*'/
    );
    const watchAt = controls.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_ca_diamond_trial_balance_watch()'
    );
    const watchBody = controls.slice(watchAt, controls.indexOf('$fn$;', watchAt));
    expect(watchBody, 'the watch opens the freeze; only a person may').not.toMatch(
      /fn_ca_open_payout_freeze\s*\(|INSERT\s+INTO\s+(?:public\.)?ca_payout_freeze/i
    );
  });

  // ---- DR13: four eyes knows the asset -----------------------------------

  it('ca_manual_adjustments gains asset with a chips-or-diamonds CHECK', () => {
    expect(controls).toMatch(/ADD COLUMN asset text NOT NULL DEFAULT 'chips'/);
    expect(checkListFor(controls, 'asset')).toEqual(['chips', 'diamonds']);
  });

  it('the target kinds gain the two diamond accounts and keep all eleven chip ones', () => {
    const kinds = checkListFor(controls, 'target_kind');
    for (const kind of [
      'player_wallet',
      'promo_wallet',
      'club_treasury',
      'union_bank',
      'union_wallet',
      'agent_wallet',
      'club_wallet',
      'bbj_pool',
      'spin_reserve',
      'prize_liability',
      'bounty_liability',
      'diamond_wallet',
      'diamond_house',
    ]) {
      expect(kinds, `target_kind CHECK lost or never gained ${kind}`).toContain(kind);
    }
    // the proposer carries its own copy of the list and must agree with the CHECK
    expect(controls).toMatch(/'diamond_wallet','diamond_house'/);
  });

  // ---- The kill switch ---------------------------------------------------

  it('the freeze accepts the three diamond scopes and still accepts tournament_payouts', () => {
    const scopes = checkListFor(controls, 'scope');
    for (const scope of [
      'tournament_payouts',
      'diamond_issuance',
      'diamond_tournament_payouts',
      'arena_withdrawals',
    ]) {
      expect(scopes, `ca_payout_freeze scope CHECK does not accept ${scope}`).toContain(scope);
    }
    expect(controls).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_ca_open_payout_freeze\(/);
    expect(controls).toMatch(/'tournament_payouts', 'diamond_issuance',/);
  });

  // ---- DR6: the audit names the writer -----------------------------------

  it('the audit trigger fires on INSERT as well as UPDATE and is one trigger, not two', () => {
    expect(audit).toMatch(/DROP TRIGGER IF EXISTS zz_ca_audit_diamond_change ON public\.profiles;/);
    expect(audit).toMatch(
      /CREATE TRIGGER zz_ca_audit_diamond_change\s*\n?\s*AFTER INSERT OR UPDATE OF diamonds ON public\.profiles/
    );
  });

  it('the audit names DR6, the writer and the money path', () => {
    expect(audit).toMatch(/'DR6:balance_changed_without_journal', 'warning'/);
    expect(audit).toMatch(/ADD COLUMN writer\s+text/);
    expect(audit).toMatch(/ADD COLUMN money_path text/);
    expect(audit).toMatch(/GET DIAGNOSTICS v_stack = PG_CONTEXT/);
    expect(audit).toMatch(/current_setting\('app\.money_path', true\)/);
  });

  it('the audit still cannot block a diamond movement', () => {
    // the failure sink and the unconditional RETURN NEW are the whole reason
    // this trigger is allowed to exist on the hottest table in the database
    expect(audit).toMatch(/EXCEPTION WHEN OTHERS THEN/);
    expect(audit).toMatch(/INSERT INTO public\.ca_ledger_write_failures/);
    expect(audit).toMatch(/RETURN NEW;\s*\nEND;/);
    const fnAt = audit.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_audit_diamond_change()');
    const fnBody = audit.slice(fnAt, audit.indexOf('$fn$;', fnAt));
    expect(fnBody, 'the audit raises; it must never block a diamond write').not.toMatch(
      /RAISE EXCEPTION/
    );
  });

  it('neither migration refuses anything on a live diamond path', () => {
    for (const [name, sql] of [
      [CONTROLS, controls],
      [AUDIT, audit],
    ] as const) {
      // RAISE EXCEPTION is allowed ONLY inside the post-apply assertion block,
      // which runs once at apply time and guards the migration itself.
      const assertAt = sql.indexOf('DO $assert$');
      const beforeAssertions = assertAt >= 0 ? sql.slice(0, assertAt) : sql;
      expect(beforeAssertions, `${name} raises outside its post-apply assertions`).not.toMatch(
        /RAISE EXCEPTION/
      );
    }
  });

  // ---- NEGATIVE CONTROLS -------------------------------------------------

  it('NEGATIVE CONTROL: the checkers catch a weakened copy of each file', () => {
    // (a) an account dropped from the trial balance
    const noSuspense = controls.replace(
      /RETURN QUERY SELECT 'suspense'::text/g,
      "RETURN QUERY SELECT 'x_gone'::text"
    );
    expect(accountsNamed(noSuspense)).not.toContain('suspense');
    expect(accountsNamed(controls)).toContain('suspense');

    // (b) the diamond target kinds removed from four eyes
    const chipsOnly = controls.replace(
      /'diamond_wallet', 'diamond_house'\)\)/,
      "'bounty_liability'))"
    );
    expect(checkListFor(chipsOnly, 'target_kind')).not.toContain('diamond_house');
    expect(checkListFor(controls, 'target_kind')).toContain('diamond_house');

    // (c) the freeze narrowed back to one scope
    const oneScope = controls.replace(
      /CHECK \(scope IN \([^)]*\)\)/,
      "CHECK (scope IN ('tournament_payouts'))"
    );
    expect(checkListFor(oneScope, 'scope')).not.toContain('diamond_issuance');
    expect(checkListFor(controls, 'scope')).toContain('diamond_issuance');

    // (d) the audit trigger put back to UPDATE only
    const updateOnly = audit.replace(
      'AFTER INSERT OR UPDATE OF diamonds ON public.profiles',
      'AFTER UPDATE OF diamonds ON public.profiles'
    );
    expect(updateOnly).not.toMatch(/AFTER INSERT OR UPDATE OF diamonds/);
    expect(audit).toMatch(/AFTER INSERT OR UPDATE OF diamonds/);

    // (e) the failure sink removed from the audit
    const noSink = audit.replace(/INSERT INTO public\.ca_ledger_write_failures/g, '-- removed');
    expect(noSink).not.toMatch(/INSERT INTO public\.ca_ledger_write_failures/);
    expect(audit).toMatch(/INSERT INTO public\.ca_ledger_write_failures/);
  });
});
