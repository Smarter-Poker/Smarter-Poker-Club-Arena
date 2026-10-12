/**
 * ===========================================================================
 *  A LEDGER REFUSAL IS RECORDED OUTSIDE ITS ROLLBACK
 * ===========================================================================
 *
 * Dan's launch plan, phase 1a: a ledger-invariant refusal must never fail
 * silently.
 *
 * fn_ca_balance_has_its_ledger_row refuses a transaction at COMMIT with
 * SQLSTATE 23514 (REFUSED: balance_moved_without_its_ledger_row /
 * REFUSED: balance_moved_against_settlement_suspense). The refusal rolls the
 * whole transaction back, so nothing it writes survives, and a refused hand,
 * payout, cron job, World Hub route or client RPC used to leave only a
 * Postgres log line. Migration 20261002135708 makes the refusing session
 * record the refusal itself, before it raises, on a loopback dblink
 * connection that commits on its own (one place, so every caller is covered),
 * and counts it on a sequence that no rollback can undo, so "no record" can
 * never be read as "no refusal".
 *
 * This law pins, on the LATEST definition of each function across every
 * migration (a later redefinition replaces it, as it does on the database):
 *
 *   * every REFUSED raise in the judgement is preceded, in its own branch, by
 *     a call to the recorder, wrapped so the recorder can never fail it;
 *   * the recorder counts first (nextval before any connection), writes over
 *     dblink with the connection string kept in Vault, never with
 *     dblink_connect_u, never raises, and raises the incident in a separate
 *     remote statement after the record;
 *   * no migration carries the recorder's password - the only PASSWORD for
 *     that role is a format() placeholder fed by a generated value;
 *   * the reader exists: fn_ca_cron_failure_watch (ca-cron-health-30m) runs
 *     fn_ca_ledger_invariant_refusal_watch, which files every counted
 *     refusal without a record as an explicit row and a critical incident;
 *   * the executable proof runs in CI: scripts/dev/test-ledger-invariant.sh
 *     applies the migration and runs refusal-regression.sql, where a real
 *     transaction is refused and rolled back and its record, count and
 *     incident are read afterwards.
 *
 * The negative proofs plant a judgement whose second refusal no longer
 * records, and a recorder that connects before it counts, and both go red.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIG_DIR = join(ROOT, 'supabase', 'migrations');
const MIGRATION_SUFFIX = '_a_ledger_refusal_is_recorded_outside_its_rollback.sql';

const migrations = readdirSync(MIG_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (f: string) => readFileSync(join(MIG_DIR, f), 'utf8');
const all = migrations.map(read);

const stripComments = (sql: string) =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');

function latestBody(sqlFiles: string[], fn: string): string {
  let body = '';
  for (const raw of sqlFiles) {
    const sql = stripComments(raw);
    const i = sql.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    if (i >= 0) body = sql.slice(i, sql.indexOf('$function$;', i));
  }
  return body;
}

/** Each REFUSED raise whose own branch does not record it first; [] when whole. */
function unrecordedRefusals(judgement: string): string[] {
  const gaps: string[] = [];
  const raises = [...judgement.matchAll(/RAISE EXCEPTION 'REFUSED: (\w+)/g)];
  if (raises.length < 2) gaps.push(`expected both refusals, found ${raises.length}`);
  for (const m of raises) {
    const branchStart = judgement.lastIndexOf("IF v_mode = 'refuse' THEN", m.index);
    const branch = judgement.slice(branchStart < 0 ? 0 : branchStart, m.index);
    const record = branch.search(
      new RegExp(
        `BEGIN\\s+PERFORM public\\.fn_ca_ledger_refusal_record\\(jsonb_build_object\\(\\s*'kind',\\s*'${m[1]}'`
      )
    );
    if (branchStart < 0 || record < 0) {
      gaps.push(`REFUSED: ${m[1]} is raised without being recorded first`);
      continue;
    }
    if (!/EXCEPTION WHEN OTHERS THEN\s+NULL;\s+END;\s*$/.test(branch)) {
      gaps.push(`REFUSED: ${m[1]}: the recorder call is not isolated from the refusal`);
    }
  }
  return gaps;
}

/** What the recorder gets wrong; [] when whole. */
function recorderGaps(recorder: string): string[] {
  const gaps: string[] = [];
  const count = recorder.indexOf("nextval('public.ca_ledger_invariant_refusal_counter')");
  const connect = recorder.indexOf('public.dblink_connect(v_conn, v_info)');
  if (count < 0) gaps.push('the recorder does not count the refusal');
  if (connect < 0) gaps.push('the recorder does not write over its own connection');
  if (count >= 0 && connect >= 0 && count > connect)
    gaps.push(
      'the recorder connects before it counts, so a failed connection is an uncounted refusal'
    );
  if (
    !/FROM vault\.decrypted_secrets s\s+WHERE s\.name = 'ca_ledger_refusal_recorder_conninfo'/.test(
      recorder
    )
  )
    gaps.push('the recorder does not read its connection string from Vault');
  if (/dblink_connect_u/.test(recorder)) gaps.push('the recorder uses dblink_connect_u');
  if (/RAISE EXCEPTION/.test(recorder)) gaps.push('the recorder can raise');
  const file = recorder.indexOf('fn_ca_ledger_refusal_file(');
  const raise = recorder.indexOf('fn_ca_ledger_refusal_raise(');
  if (file < 0 || raise < 0 || raise < file)
    gaps.push('the incident is not raised in its own statement after the record');
  if ((recorder.match(/EXCEPTION WHEN OTHERS THEN/g) ?? []).length < 3)
    gaps.push('a recorder step is not isolated');
  return gaps;
}

describe('a ledger refusal is recorded outside its rollback', () => {
  const name = migrations.find((f) => f.endsWith(MIGRATION_SUFFIX));

  it('the migration exists and installs the record, the counter and the recorder', () => {
    expect(name, `a migration named *${MIGRATION_SUFFIX}`).toBeTruthy();
    const sql = stripComments(read(name!));
    expect(sql).toMatch(
      /CREATE SEQUENCE IF NOT EXISTS public\.ca_ledger_invariant_refusal_counter/
    );
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.ca_ledger_invariant_refusals/);
    expect(sql).not.toMatch(/ca_ledger_invariant_refusals[\s\S]{0,2000}REFERENCES/);
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });

  it('every refusal in the latest judgement is recorded first, and the recorder cannot fail it', () => {
    expect(unrecordedRefusals(latestBody(all, 'fn_ca_balance_has_its_ledger_row'))).toEqual([]);
  });

  it('the latest recorder counts first, writes through Vault over dblink, and never raises', () => {
    expect(recorderGaps(latestBody(all, 'fn_ca_ledger_refusal_record'))).toEqual([]);
  });

  it('no migration carries the recorder password', () => {
    for (const [i, raw] of all.entries()) {
      const sql = stripComments(raw);
      // the only accepted form is a format() placeholder fed by a generated value
      for (const m of sql.matchAll(
        /ca_ledger_refusal_recorder\s+(?:WITH\s+)?(?:LOGIN\s+)?PASSWORD\s+(\S{1,2})/gi
      )) {
        expect(m[1], `${migrations[i]} sets the recorder password from a literal`).toBe('%L');
      }
      expect(sql, migrations[i]).not.toMatch(/user=ca_ledger_refusal_recorder password=(?!%s)/);
    }
  });

  it('the reader exists: the cron health watch files a counted refusal with no record', () => {
    expect(latestBody(all, 'fn_ca_cron_failure_watch')).toMatch(
      /public\.fn_ca_ledger_invariant_refusal_watch\(\)/
    );
    const watch = latestBody(all, 'fn_ca_ledger_invariant_refusal_watch');
    expect(watch).toMatch(
      /INSERT INTO public\.ca_ledger_invariant_refusals \(counter_no, kind, message\)/
    );
    expect(watch).toMatch(/'unrecorded'/);
    expect(watch).toMatch(/PERFORM public\.fn_ca_ledger_refusal_raise\(v_id\)/);
    const raise = latestBody(all, 'fn_ca_ledger_refusal_raise');
    expect(raise).toMatch(/p_severity\s+:= 'critical'/);
    expect(raise).toMatch(/p_source\s+:= 'ledger_invariant\.refused'/);
    expect(raise).toMatch(
      /'ledger-invariant-refused:' \|\| r\.kind \|\| ':' \|\| COALESCE\(r\.rpc/
    );
  });

  it('the executable proof runs in CI', () => {
    const script = readFileSync(join(ROOT, 'scripts', 'dev', 'test-ledger-invariant.sh'), 'utf8');
    expect(script).toMatch(/_a_ledger_refusal_is_recorded_outside_its_rollback\.sql/);
    expect(script).toMatch(/refusal-bootstrap\.sql/);
    expect(script).toMatch(/refusal-regression\.sql/);
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toMatch(/bash scripts\/dev\/test-ledger-invariant\.sh/);
    const regression = readFileSync(
      join(ROOT, 'tests', 'fixtures', 'ledger-invariant', 'refusal-regression.sql'),
      'utf8'
    );
    // a real top-level transaction is refused at COMMIT, then its record is read
    expect(regression).toMatch(
      /\\set ON_ERROR_STOP off\s+BEGIN;\s+UPDATE[^;]+;\s+COMMIT;\s+\\set ON_ERROR_STOP on/
    );
    expect(regression).toMatch(/F1 the refused transaction was not rolled back/);
  });

  it('NEGATIVE: a judgement whose suspense refusal stopped recording goes red', () => {
    const judgement = latestBody(all, 'fn_ca_balance_has_its_ledger_row');
    const planted = judgement.replace(
      /PERFORM public\.fn_ca_ledger_refusal_record\(jsonb_build_object\(\s*'kind',\s*'balance_moved_against_settlement_suspense'/,
      "PERFORM public.fn_ca_something_else(jsonb_build_object('kind', 'x'"
    );
    expect(planted).not.toBe(judgement);
    expect(unrecordedRefusals(planted)).toEqual([
      'REFUSED: balance_moved_against_settlement_suspense is raised without being recorded first',
    ]);
  });

  it('NEGATIVE: a recorder that connects before it counts goes red', () => {
    const recorder = latestBody(all, 'fn_ca_ledger_refusal_record');
    const planted = recorder
      .replace("v_no := nextval('public.ca_ledger_invariant_refusal_counter');", 'v_no := NULL;')
      .replace(
        'PERFORM public.dblink_connect(v_conn, v_info);',
        "PERFORM public.dblink_connect(v_conn, v_info); v_no := nextval('public.ca_ledger_invariant_refusal_counter');"
      );
    expect(recorderGaps(planted)).toContain(
      'the recorder connects before it counts, so a failed connection is an uncounted refusal'
    );
  });
});
