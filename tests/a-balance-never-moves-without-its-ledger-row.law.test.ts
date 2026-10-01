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

  it('observe is a measurement window with a named end: the installed mode, and the only hands that may change it', () => {
    const body = stripComments(installer);
    expect(body).toMatch(
      /INSERT INTO public\.ca_ledger_invariant_mode \(mode, reason\)\s+VALUES \('observe',/
    );
    const later = migrations.filter((f) => f > (installerName ?? ''));
    const flips = later.filter((f) =>
      /ca_ledger_invariant_mode/.test(readFileSync(join(MIG_DIR, f), 'utf8'))
    );
    for (const f of flips) {
      const sql = stripComments(readFileSync(join(MIG_DIR, f), 'utf8'));
      // the only sanctioned move is forward, to refuse, and never back
      expect(sql, `${f} may only set the invariant to refuse`).not.toMatch(
        /SET\s+mode\s*=\s*'observe'/i
      );
      expect(sql, `${f} must not drop or disable the invariant`).not.toMatch(
        /(DROP|ALTER)\s+TABLE\s+(public\.)?(club_members|clubs|table_seats|table_pending_addons|union_wallets|bbj_pools|chip_ledger)\s+DISABLE TRIGGER\s+z[yz]_ca_/i
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
