/**
 * ===========================================================================
 *  LAW: A RECORD VARIABLE MUST NOT SHADOW A TABLE ALIAS
 * ===========================================================================
 *
 * `ca-ledger-replay-nightly` (cron `40 6 * * *`) was `critical` in
 * `fn_ca_cron_health()`: one run, zero successes. It raised
 *
 *   ERROR: record "w" is not assigned yet
 *   CONTEXT: SQL statement "SELECT COALESCE(sum(w.unkeyable), 0) FROM z..."
 *
 * `public.fn_ca_ledger_replay` declares two bare record variables on one line,
 * `r record; w record;`, and then uses `w` as a TABLE ALIAS in two statements
 * that run before the `FOR w IN ...` loop ever assigns it. PL/pgSQL resolves
 * `w.unkeyable` against the DECLARED VARIABLE rather than the alias, so the
 * first of those statements reads a record that has never been assigned and
 * the whole function dies there. The nightly ledger replay had therefore never
 * run, and neither had `fn_ca_currency_meter()`, which the same cron command
 * calls after it.
 *
 * It is a silent class of bug: the collision is harmless right up until a
 * statement using the alias happens to run before the loop, and then it is
 * fatal every time.
 *
 * MEASURED 2026-09-19 across all 3,174 migrations: exactly ONE carries this
 * collision, `20260910065825_the_journal_window_is_a_snapshot_not_a_clock.sql`,
 * which is the one that introduced it. One true positive, no false ones. So
 * the guard below binds from 20260911, the day after, and the whole history
 * before it is clean.
 *
 * WRITING THE DETECTOR TOOK THREE ATTEMPTS AND THAT IS WORTH RECORDING. The
 * first two reported zero. The declarations share a line (`r record; w
 * record;`), so a pattern anchored at line start sees only `r`, and a pattern
 * that consumes the separating `;` cannot then match the next declaration
 * after it. A guard that reports zero because it cannot see is worse than no
 * guard, so `detect()` is tested against that exact shape below before it is
 * trusted against the tree.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const FIX =
  'supabase/migrations/20260919160144_the_ledger_replay_reads_a_record_it_never_assigned.sql';

/** The single historical offender, which this law's migration fixes live. */
const THE_ONE = '20260910065825_the_journal_window_is_a_snapshot_not_a_clock.sql';
/** Binds from the day after it. Everything from here is clean today. */
const BINDS_FROM = '20260911';

const SQL = fs.readFileSync(path.join(ROOT, FIX), 'utf8');

/** Each function body in a migration, found by its own dollar-quote tag. */
function functionBodies(sql: string): string[] {
  const head =
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION[\s\S]{0,4000}?\sAS\s+(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/gi;
  const out: string[] = [];
  for (const m of sql.matchAll(head)) {
    const tag = m[1];
    const start = (m.index ?? 0) + m[0].length;
    const end = sql.indexOf(tag, start);
    if (end > start) out.push(sql.slice(start, end));
  }
  return out;
}

/**
 * The names declared `record` or `%ROWTYPE` that are ALSO used as a table
 * alias in the same body. Declarations are read by splitting on the statement
 * terminator rather than by one regex sweep: they share lines, and a sweep
 * that consumes the separator silently drops every declaration after the
 * first on its line, which is how the first two versions of this reported zero.
 */
export function detect(sql: string): string[] {
  const declared = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+(?:record\b|[\w.]+%ROWTYPE\b)/i;
  const hits: string[] = [];
  for (const body of functionBodies(sql)) {
    const code = body.replace(/--[^\n]*/g, '');
    const names = new Set<string>();
    for (const fragment of code.split(';')) {
      const m = declared.exec(fragment);
      if (m) names.add(m[1].toLowerCase());
    }
    for (const name of names) {
      const alias = new RegExp(
        `(?:FROM|JOIN)\\s+[A-Za-z_][\\w.]*\\s+(?:AS\\s+)?${name}(?![\\w.])`,
        'i'
      );
      if (alias.test(code)) hits.push(name);
    }
  }
  return [...new Set(hits)];
}

function migrations(): string[] {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

describe('a record variable must not shadow a table alias', () => {
  it('the detector sees a declaration that shares its line, which is the whole trick', () => {
    // The exact shape from fn_ca_ledger_replay. If this ever returns [], the
    // forward guard below is decoration.
    const sample = `
      CREATE OR REPLACE FUNCTION public.fn_sample() RETURNS void LANGUAGE plpgsql AS $fn$
      DECLARE
        v_now timestamptz := now();
        r record; w record;
      BEGIN
        SELECT COALESCE(sum(w.n), 0) INTO v_now FROM some_table w WHERE w.kind = 'x';
        FOR w IN SELECT * FROM other LOOP NULL; END LOOP;
      END
      $fn$;`;
    expect(detect(sample)).toEqual(['w']);
  });

  it('and does not accuse a declaration that shares no name with an alias', () => {
    const clean = `
      CREATE OR REPLACE FUNCTION public.fn_clean() RETURNS void LANGUAGE plpgsql AS $fn$
      DECLARE
        r record; w record;
      BEGIN
        SELECT count(*) INTO r FROM some_table t WHERE t.kind = 'x';
        FOR w IN SELECT * FROM other o LOOP NULL; END LOOP;
      END
      $fn$;`;
    expect(detect(clean)).toEqual([]);
  });

  it('the one historical offender is the one that caused this', () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS, THE_ONE), 'utf8');
    expect(detect(sql)).toEqual(['w']);
  });

  it('the migration renames the aliases and leaves the record loop alone', () => {
    expect(SQL).toContain('pg_temp.ca_patch');
    expect([...SQL.matchAll(/pg_temp\.ca_patch\('fn_ca_ledger_replay'/g)]).toHaveLength(2);
    expect(SQL).toContain('FROM zz_replay_window zw');
    // Removing the collision by removing the wrong half would also make the
    // error go away, and would break the loop. The count is the proof.
    expect(SQL).toMatch(/expected exactly 6 remaining w\. references/);
    expect(SQL).toMatch(/the record loop was altered; only the aliases should change/);
  });

  it('it declares a proof, because it creates nothing', () => {
    const proofs = [...SQL.matchAll(/^--\s*@live-proof:\s*(.+)$/gm)].map((m) => m[1]);
    expect(proofs.length).toBeGreaterThanOrEqual(2);
    expect(proofs.join('\n')).toContain('zz_replay_window w');
    expect(proofs.join('\n')).toContain('zz_replay_window zw');
  });

  /**
   * THE ONE THAT MATTERS LATER. The collision is invisible until the day a
   * statement using the alias runs before the loop, and then the function is
   * dead every single time.
   */
  it('no migration after the cutoff writes the collision', () => {
    const offenders: Record<string, string[]> = {};
    for (const file of migrations()) {
      if (file.slice(0, 8) < BINDS_FROM) continue;
      const found = detect(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
      if (found.length) offenders[file] = found;
    }
    expect(
      offenders,
      'these migrations declare a record (or %ROWTYPE) variable and then use the same name ' +
        'as a table alias in the same function. PL/pgSQL resolves the qualified reference ' +
        'against the VARIABLE, not the alias, so any statement using that alias before the ' +
        'variable is assigned raises "record is not assigned yet" and takes the whole ' +
        'function with it. That is what killed ca-ledger-replay-nightly, which had run once ' +
        'and never succeeded. Rename the alias.'
    ).toEqual({});
  });
});
