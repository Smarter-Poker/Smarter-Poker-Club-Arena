/**
 * ===========================================================================
 *  A BALANCE NEVER MOVES WITHOUT ITS LEDGER ROW
 * ===========================================================================
 *
 * Dan, 2026-10-01: "chip drifts should not be possible and should never happen
 * when EVERY SINGLE TRANSACTION is logged, and on the same ledger."
 *
 * WHAT MADE DRIFT POSSIBLE. Every chip balance on the platform is written
 * directly by its door and journalled AFTER the fact by a trigger
 * (fn_club_members_ledger_writer, fn_ca_autoledger). Both triggers stand down
 * when a door sets app.ledger_autoskip_<table> and promises to write the leg
 * itself. Forty-five doors make that promise. Nothing verified it. And the
 * felt (table_seats.stack) and the pending add-on float had no journal trigger
 * at all. Every detector compared the balance to the journal hours later, by
 * snapshot: a net, never a constraint.
 *
 * THE LAW. Migration 20261001160611 installs one transaction-scoped tally
 * (setting ca.ledger_tally) fed by AFTER-row triggers on every covered balance
 * table and on chip_ledger, and a DEFERRABLE INITIALLY DEFERRED constraint
 * trigger that, at COMMIT, refuses the whole transaction by name -
 *
 *     REFUSED: balance_moved_without_its_ledger_row
 *
 * - when any covered account's balance delta is not exactly the net of the
 * chip_ledger legs written in the same transaction. A balance with no leg, a
 * leg with no balance, a stand-down whose leg is the wrong amount or names the
 * wrong wallet: all four are that refusal. Nothing is corrected, nothing is
 * swept up later (CLAUDE.md 10.11, 10.12).
 *
 * THE PROOF IS EXECUTED, NOT READ. scripts/dev/test-ledger-invariant.sh runs
 * the real migration file on an isolated PostgreSQL 17 against the real-shaped
 * fixture in tests/fixtures/ledger-invariant and plants eleven regressions
 * (the 2026-08-25 deleted seat, a stack that grows from nowhere, a stand-down
 * with no leg / the wrong amount / the wrong wallet, a leg with no balance, a
 * session-scoped stand-down leaking onto the next write, ...) and ten live
 * shapes (buy-in, raked hand with jackpot drop, cash-out, pending add-on,
 * treasury pair, rolled-back subtransaction, tournament and Diamond felt, seat
 * move, journal-only correction). CI runs it in the Server Engine lane; this
 * file pins what the migration and that harness must keep saying.
 *
 * STAGED. The migration installs ca_ledger_invariant_mode = 'observe' so one
 * hour of real traffic on every covered account is measured (findings land in
 * ca_ledger_invariant_findings) before a second migration flips the row to
 * 'refuse'. Until that migration exists this law pins observe as the installed
 * state and REFUSES a flip that is not its own named migration; once it exists
 * the law pins 'refuse' as the final state on main.
 *
 * THE HAND COMMITS IN TWO TRANSACTIONS, AND EACH ONE BALANCES ON ITS OWN
 * (20261001231409). Observe mode's first 28 minutes found 4,491 findings, all
 * on table_stack and all one pair: the accepted-hand transaction moves the
 * seats by inflow - rake - bbj with no leg, and a later obligations transaction
 * posts the fee legs with no felt move. The legs cannot be posted at commit
 * (atomic_distribute_rake holds the club wallet row to COMMIT; 1,122 statement
 * timeouts on that row in two hours), so the rule is applied the other way
 * round: the hand's receipt counts rake + bbj - inflow as FELT from the moment
 * its envelope is stored to the moment it completes, in the transaction that
 * posts the legs. Either half alone, or the pre-envelope shape, is refused by
 * name. Proved on production rows (4,074 of 4,074 completed cash hands:
 * receipt fees = felt legs, to the cent) and executed in the harness (P2b-P2f,
 * R12-R14).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIG_DIR = join(ROOT, 'supabase', 'migrations');
const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'ledger-invariant');

const migrations = readdirSync(MIG_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const installerName = migrations.find((f) =>
  f.endsWith('_a_balance_never_moves_without_its_ledger_row.sql')
);
const installer = installerName ? readFileSync(join(MIG_DIR, installerName), 'utf8') : '';
const installerVersion = installerName?.slice(0, 14) ?? '';
const receiptName = migrations.find((f) =>
  f.endsWith('_the_fees_a_hand_takes_stay_on_the_felt_until_their_legs_are_posted.sql')
);
const receipt = receiptName ? readFileSync(join(MIG_DIR, receiptName), 'utf8') : '';

const stripComments = (sql: string) =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');

const COVERED = [
  'club_members',
  'clubs',
  'table_seats',
  'table_pending_addons',
  'union_wallets',
  'bbj_pools',
] as const;

describe('a balance never moves without its ledger row', () => {
  it('the installing migration exists, is one transaction, and sets a lock timeout on the hot tables', () => {
    expect(
      installerName,
      'migration *_a_balance_never_moves_without_its_ledger_row.sql'
    ).toBeTruthy();
    const body = stripComments(installer);
    expect(body.trim().startsWith('BEGIN;')).toBe(true);
    expect(body.trim().endsWith('COMMIT;')).toBe(true);
    expect(body).toMatch(/SET LOCAL lock_timeout = '\d+s';/);
  });

  it('the refusal has one name, a check-violation SQLSTATE, and names its writer', () => {
    const body = stripComments(installer);
    expect(body).toContain(
      "RAISE EXCEPTION 'REFUSED: balance_moved_without_its_ledger_row account=% balance_delta=% ledger_net=%'"
    );
    expect(body).toContain("USING ERRCODE = '23514'");
    expect(body).toContain(
      "'; first written in this transaction by: ' || COALESCE(r.value ->> 'q'"
    );
  });

  it('the check is deferred to commit on every covered balance table and on the ledger itself', () => {
    const body = stripComments(installer);
    for (const table of COVERED) {
      const re = new RegExp(
        `CREATE CONSTRAINT TRIGGER zz_ca_balance_has_its_ledger_row\\s+AFTER [^;]*ON public\\.${table}\\s+DEFERRABLE INITIALLY DEFERRED\\s+FOR EACH ROW EXECUTE FUNCTION public\\.fn_ca_balance_has_its_ledger_row\\(\\);`
      );
      expect(body, `deferred check on ${table}`).toMatch(re);
      const tally = new RegExp(
        `CREATE TRIGGER zy_ca_tally_balance_move\\s+AFTER [^;]*ON public\\.${table}\\s+FOR EACH ROW EXECUTE FUNCTION public\\.fn_ca_tally_balance_move\\(\\);`
      );
      expect(body, `tally on ${table}`).toMatch(tally);
    }
    expect(body).toMatch(
      /CREATE CONSTRAINT TRIGGER zz_ca_ledger_row_has_its_balance\s+AFTER INSERT ON public\.chip_ledger\s+DEFERRABLE INITIALLY DEFERRED/
    );
    expect(body).toMatch(
      /CREATE TRIGGER zy_ca_tally_ledger_leg\s+AFTER INSERT ON public\.chip_ledger/
    );
  });

  it('the tally is transaction-local and both sides of a leg are counted', () => {
    const body = stripComments(installer);
    // transaction-local: undone with the transaction and with a rolled-back subtransaction
    expect(body).toContain("PERFORM set_config('ca.ledger_tally', t::text, true);");
    expect(body).not.toMatch(/set_config\('ca\.ledger_tally[^']*',\s*[^,]+,\s*false\)/);
    // + to the to-account, - to the from-account
    expect(body).toMatch(
      /fn_ca_ledger_tally_key\(NEW\.to_type, NEW\.to_entity_id, NEW\.club_id\), 'l', NEW\.amount\)/
    );
    expect(body).toMatch(
      /fn_ca_ledger_tally_key\(NEW\.from_type, NEW\.from_entity_id, NEW\.club_id\), 'l', -NEW\.amount\)/
    );
    // a fn_ca_post_correction journal-only restatement is outside the tally, as it is outside every meter
    expect(body).toContain(
      "IF NEW.category = 'correction' AND NEW.metadata ->> 'posted_via' = 'fn_ca_post_correction' THEN"
    );
  });

  it('the felt is one account: occupied seats on a chip cash table, plus the pending add-on float', () => {
    const body = stripComments(installer);
    expect(body).toMatch(
      /t\.tournament_id IS NULL\s+AND COALESCE\(c\.asset, 'chips'\) <> 'diamonds'/
    );
    expect(body).toContain("(o ->> 'left_at') IS NULL");
    expect(body).toContain("(o ->> 'resolved_at') IS NULL");
    // a vacated seat leaves the felt whether or not the row zeroes its stack
    expect(body).toMatch(/UPDATE OF stack, left_at, table_id OR DELETE ON public\.table_seats/);
  });

  it('every trigger on a money table declares itself, and every new guard is on the watchlist', () => {
    const body = stripComments(installer);
    for (const [table, trigger] of [
      ['club_members', 'zy_ca_tally_balance_move'],
      ['club_members', 'zz_ca_balance_has_its_ledger_row'],
      ['table_seats', 'zy_ca_tally_balance_move'],
      ['table_seats', 'zz_ca_balance_has_its_ledger_row'],
      ['union_wallets', 'zy_ca_tally_balance_move'],
      ['union_wallets', 'zz_ca_balance_has_its_ledger_row'],
      ['chip_ledger', 'zy_ca_tally_ledger_leg'],
      ['chip_ledger', 'zz_ca_ledger_row_has_its_balance'],
    ]) {
      expect(body).toMatch(new RegExp(`\\('${table}',\\s*'${trigger}',`));
    }
    for (const guard of [
      'fn_ca_ledger_tally_add',
      'fn_ca_ledger_tally_key',
      'fn_ca_felt_counts_table',
      'fn_ca_tally_balance_move',
      'fn_ca_tally_ledger_leg',
      'fn_ca_balance_has_its_ledger_row',
    ]) {
      expect(body).toContain(`SELECT public.fn_ca_declare_guard_redefinition('${guard}',`);
      expect(body).toMatch(new RegExp(`'${guard}'[,\\s]`)); // listed in fn_ca_guard_watchlist
    }
  });

  it('the writers are enumerated from the catalog, not from memory', () => {
    const body = stripComments(installer);
    expect(body).toContain('CREATE OR REPLACE VIEW public.v_ca_chip_balance_writers AS');
    expect(body).toMatch(/FROM pg_proc p JOIN pg_namespace n ON n\.oid = p\.pronamespace/);
    expect(body).toContain("s ~* 'ledger_autoskip_' AS stands_down");
    // the snapshot of that view on the day is kept beside the law
    expect(existsSync(join(ROOT, 'docs', 'evidence', 'chip-balance-writers-2026-10-01.md'))).toBe(
      true
    );
  });

  it('the one split-write the catalog found is fixed at its line and pinned to the live body', () => {
    const body = stripComments(installer);
    expect(body).toContain("IF v_live IS DISTINCT FROM 'ee9bcdf31b5f212b67e0ff536033f20c' THEN");
    // the promo release writes the one leg it is, inside the stand-down it already had
    const fixed = body.slice(
      body.indexOf('CREATE OR REPLACE FUNCTION public.promo_apply_playthrough')
    );
    expect(fixed).toMatch(
      /'promo_wallet', p_user_id, 'player_wallet', p_user_id,\s+v_released, 'promo_release', p_club_id/
    );
    const standDown = fixed.indexOf("set_config('app.ledger_autoskip_club_members', '1', true)");
    const leg = fixed.indexOf('INSERT INTO public.chip_ledger');
    const write = fixed.indexOf('UPDATE club_members');
    expect(standDown).toBeGreaterThan(-1);
    expect(leg).toBeGreaterThan(standDown);
    expect(write).toBeGreaterThan(leg);
  });

  it('the executable proof exists, runs the real migration, and plants the regression', () => {
    const script = readFileSync(join(ROOT, 'scripts', 'dev', 'test-ledger-invariant.sh'), 'utf8');
    expect(script).toContain('_a_balance_never_moves_without_its_ledger_row.sql');
    expect(script).toContain('tests/fixtures/ledger-invariant/regression.sql');
    const regression = readFileSync(join(FIXTURE_DIR, 'regression.sql'), 'utf8');
    // the negative proof: a direct felt write, the deleted seat, the empty stand-down, the leg with no balance
    expect(regression).toContain('UPDATE public.table_seats SET stack = stack + 48');
    expect(regression).toContain(
      "DELETE FROM public.table_seats WHERE id = '55555555-0000-0000-0000-000000000001'"
    );
    expect(regression).toContain(
      "set_config('app.ledger_autoskip_club_members', '1', true);\n      UPDATE public.club_members SET chip_balance = chip_balance + 10"
    );
    expect(regression).toContain("'R6 a leg with no balance movement behind it'");
    expect(regression).toContain(
      "'REFUSED: balance_moved_without_its_ledger_row account=' || p_account || ' %'"
    );
    // the positive proof: the live shapes commit
    for (const shape of [
      'P1 buy-in',
      'P2 raked hand',
      'P3 cash-out',
      'P4a pending add-on',
      'P5 the stand-down pair',
      'P6 a rolled-back subtransaction',
      'P7 tournament felt',
      'P8 a journal-only correction',
    ]) {
      expect(regression).toContain(shape);
    }
    // the deferred check is fired exactly as COMMIT would fire it
    expect(regression).toContain('SET CONSTRAINTS ALL IMMEDIATE;');
    // and CI runs it where the other real-PostgreSQL accounting proofs run
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toContain('run: bash scripts/dev/test-ledger-invariant.sh');
  });

  it('the hand commits in two transactions and each balances on its own: the receipt carries the fees as felt until their legs are posted', () => {
    expect(
      receiptName,
      'migration *_the_fees_a_hand_takes_stay_on_the_felt_until_their_legs_are_posted.sql'
    ).toBeTruthy();
    expect(receiptName! > (installerName ?? '')).toBe(true);
    const body = stripComments(receipt);
    expect(body.trim().startsWith('BEGIN;')).toBe(true);
    expect(body.trim().endsWith('COMMIT;')).toBe(true);
    expect(body).toMatch(/SET LOCAL lock_timeout = '\d+s';/);
    // the branch: while the envelope is stored and not completed, on the cash felt, rake + bbj - inflow
    expect(body).toContain("WHEN 'hand_atomic_commits' THEN");
    expect(body).toContain("k_old := 'table_stack'; k_new := 'table_stack';");
    for (const side of ['o', 'n']) {
      expect(body).toContain(`(${side} ->> 'post_commit_payload') IS NOT NULL`);
      expect(body).toContain(`(${side} ->> 'post_commit_completed_at') IS NULL`);
      expect(body).toContain(`public.fn_ca_felt_counts_table((${side} ->> 'table_id')::uuid)`);
      expect(body).toMatch(
        new RegExp(
          `COALESCE\\(\\(${side} -> 'stack_result' ->> 'rake'\\)::numeric, 0\\)\\s+\\+ COALESCE\\(\\(${side} -> 'stack_result' ->> 'bbj'\\)::numeric, 0\\)\\s+- COALESCE\\(\\(${side} -> 'stack_result' ->> 'inflow'\\)::numeric, 0\\)`
        )
      );
    }
    // the substitution is asserted on its anchor and read back, never retyped
    expect(body).toContain("v_sig constant text := 'public.fn_ca_tally_balance_move()';");
    expect(body).toMatch(/IF v_n IS DISTINCT FROM 1 THEN/);
    expect(body).toContain('does not read back with the hand receipt counted as felt');
    // both invariant triggers on the receipt, the check deferred to commit, nothing dropped
    expect(body).toMatch(
      /CREATE TRIGGER zy_ca_tally_balance_move\s+AFTER INSERT OR UPDATE OF post_commit_payload, post_commit_completed_at, stack_result, table_id OR DELETE\s+ON public\.hand_atomic_commits\s+FOR EACH ROW EXECUTE FUNCTION public\.fn_ca_tally_balance_move\(\);/
    );
    expect(body).toMatch(
      /CREATE CONSTRAINT TRIGGER zz_ca_balance_has_its_ledger_row\s+AFTER INSERT OR UPDATE OF post_commit_payload, post_commit_completed_at, stack_result, table_id OR DELETE\s+ON public\.hand_atomic_commits\s+DEFERRABLE INITIALLY DEFERRED\s+FOR EACH ROW EXECUTE FUNCTION public\.fn_ca_balance_has_its_ledger_row\(\);/
    );
    // no DROP statement (the refusal message that names the rule is not one)
    expect(body).not.toMatch(/^\s*DROP\s+(TRIGGER|POLICY)\b/im);
    expect(body).toMatch(/LOCK TABLE public\.hand_atomic_commits IN SHARE ROW EXCLUSIVE MODE;/);
    expect(body).toMatch(/set_config\('lock_timeout', '250ms', true\)/);
    // declared, and the redefinition of the tally function declared
    expect(body).toMatch(/\('hand_atomic_commits',\s*'zy_ca_tally_balance_move',/);
    expect(body).toMatch(/\('hand_atomic_commits',\s*'zz_ca_balance_has_its_ledger_row',/);
    expect(body).toContain(
      "SELECT public.fn_ca_declare_guard_redefinition('fn_ca_tally_balance_move', 'migration 20261001231409_the_fees_a_hand_takes_stay_on_the_felt_until_their_legs_are_posted');"
    );
    // nothing about the hand commit itself changes: no amount, receipt, refusal name or engine
    expect(body).not.toMatch(
      /fn_ca_commit_hand_settlement|fn_ca_process_hand_post_commit_obligations|atomic_distribute_rake/
    );
    // the executable proof applies it after the installer and plants both halves alone
    const script = readFileSync(join(ROOT, 'scripts', 'dev', 'test-ledger-invariant.sh'), 'utf8');
    expect(script).toContain(
      '_the_fees_a_hand_takes_stay_on_the_felt_until_their_legs_are_posted.sql'
    );
    expect(script.indexOf('-f "$receipt"')).toBeGreaterThan(script.indexOf('-f "$migration"'));
    const regression = readFileSync(join(FIXTURE_DIR, 'regression.sql'), 'utf8');
    for (const shape of [
      'P2b the accepted-hand transaction',
      'R12 the obligations transaction posts the fee legs but never completes the envelope',
      'R13 the envelope completes with no fee legs behind it',
      'R14 the pre-envelope shape',
      'P2c the obligations transaction',
      'P2d the restart path',
      'P2e a tournament hand receipt is not the cash felt',
      'P2f the eight-day retention prune',
    ]) {
      expect(regression).toContain(shape);
    }
    const bootstrap = readFileSync(join(FIXTURE_DIR, 'bootstrap.sql'), 'utf8');
    expect(bootstrap).toContain('CREATE TABLE public.hand_atomic_commits (');
  });

  it('observe is a measurement window with a named end: the installed mode, and the only hands that may change it', () => {
    const body = stripComments(installer);
    expect(body).toMatch(
      /INSERT INTO public\.ca_ledger_invariant_mode \(mode, reason\)\s+VALUES \('observe',/
    );
    const later = migrations.filter((f) => f > (installerName ?? ''));
    // a flip is a write to the one row; a migration that merely reads the mode
    // (20261001231409 reports it in its closing NOTICE) is not one
    const flips = later.filter((f) =>
      /UPDATE\s+(public\.)?ca_ledger_invariant_mode\b/i.test(
        stripComments(readFileSync(join(MIG_DIR, f), 'utf8'))
      )
    );
    for (const f of flips) {
      const sql = stripComments(readFileSync(join(MIG_DIR, f), 'utf8'));
      // the only sanctioned move is forward, to refuse, and never back
      expect(sql, `${f} may only set the invariant to refuse`).not.toMatch(
        /SET\s+mode\s*=\s*'observe'/i
      );
      expect(sql, `${f} must not drop or disable the invariant`).not.toMatch(
        /(DROP|ALTER)\s+TABLE\s+(public\.)?(club_members|clubs|table_seats|table_pending_addons|union_wallets|bbj_pools|hand_atomic_commits|chip_ledger)\s+DISABLE TRIGGER\s+z[yz]_ca_/i
      );
    }
    // once the flip has landed on main, refuse is the law; until then observe is pinned as stage 1
    const finalMode = flips.length > 0 ? 'refuse' : 'observe';
    const stateFile = join(
      ROOT,
      'docs',
      'laws.d',
      'a-balance-never-moves-without-its-ledger-row.md'
    );
    expect(readFileSync(stateFile, 'utf8')).toContain(`installed mode: ${finalMode}`);
  });

  it('no later migration drops a tally or check trigger, or stands the check down', () => {
    const later = migrations.filter((f) => f > (installerName ?? ''));
    for (const f of later) {
      const sql = stripComments(readFileSync(join(MIG_DIR, f), 'utf8'));
      expect(sql, f).not.toMatch(
        /DROP TRIGGER (IF EXISTS )?z[yz]_ca_(tally_balance_move|balance_has_its_ledger_row|tally_ledger_leg|ledger_row_has_its_balance)\b(?![\s\S]{0,400}CREATE (CONSTRAINT )?TRIGGER z[yz]_ca_)/
      );
      expect(sql, f).not.toMatch(/DISABLE TRIGGER\s+z[yz]_ca_/i);
      expect(sql, f).not.toMatch(
        /DROP FUNCTION (IF EXISTS )?(public\.)?fn_ca_(ledger_tally_add|ledger_tally_key|tally_balance_move|tally_ledger_leg|balance_has_its_ledger_row)\b/
      );
    }
    expect(installerVersion).toMatch(/^\d{14}$/);
  });
});
