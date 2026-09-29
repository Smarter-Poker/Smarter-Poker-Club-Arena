/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE GATE THAT STOPS THE NEXT DELETE POSTGREST WILL REFUSE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `20260906150328` put `delete from tmp_agg31;` inside `fn_aggregate_gto_v31_next`
 * to stop the function churning temp-table DDL every cron tick. It worked every
 * time it was run from a migration, because a migration runs as `postgres`, and
 * it broke the function completely on the only path anything uses:
 *
 *     [GtoAggregationDriverV31.tick] Error: DELETE requires a WHERE clause
 *
 * PostgREST connects as `authenticator`, which carries
 * `session_preload_libraries=safeupdate`; safeupdate refuses an UPDATE or
 * DELETE with no WHERE, and a later `SET ROLE service_role` does not unload it.
 * The sweep that followed found TEN live functions in the same shape.
 *
 * A gate nobody has watched fail is a gate nobody knows works. These feed the
 * checker the exact statement that shipped and assert on its VERDICT rather
 * than on its wording, so rephrasing the help text cannot quietly disarm it.
 *
 * THE DANGEROUS DIRECTION for this gate is crying wolf: every migration that
 * FIXES one of these quotes the broken statement in its header to explain it,
 * and a checker that reads comments and string literals as code would block the
 * repair while allowing the defect. Half the cases below are about that.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

type Finder = (sql: string) => string[];
let unqualifiedDeletes: Finder;
let unqualifiedUpdates: Finder;
let declaredExceptions: (sql: string) => Map<string, string>;
let offenders: (sql: string) => { verb: string; table: string }[];

beforeAll(async () => {
  const href = pathToFileURL(
    resolve(__dirname, '..', 'scripts/ci/check-unqualified-writes.mjs')
  ).href;
  const mod = await import(/* @vite-ignore */ href);
  unqualifiedDeletes = mod.unqualifiedDeletes;
  unqualifiedUpdates = mod.unqualifiedUpdates;
  declaredExceptions = mod.declaredExceptions;
  offenders = mod.offenders;
});

describe('the statement that shipped', () => {
  it('names the exact delete that stopped the GTO driver', () => {
    const sql = `
CREATE OR REPLACE FUNCTION public.fn_aggregate_gto_v31_next(p_batch integer DEFAULT 25)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $function$
begin
  create temp table if not exists tmp_agg31 (like public.gto_postflop_v31 including all)
    on commit delete rows;
  delete from tmp_agg31;
end;
$function$;
`;
    expect(unqualifiedDeletes(sql)).toEqual(['tmp_agg31']);
    expect(offenders(sql)).toEqual([{ verb: 'DELETE', table: 'tmp_agg31' }]);
  });

  it('clears the same function once the predicate is there', () => {
    expect(unqualifiedDeletes('delete from tmp_agg31 where true;')).toEqual([]);
    expect(offenders('delete from tmp_agg31 where true;')).toEqual([]);
  });

  it('reads a function body, not just top-level statements', () => {
    // The dangerous one is ALWAYS in a body: it does not fail until something
    // calls it, so the migration that introduced it went green.
    const sql = `
CREATE OR REPLACE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.ca_rake_schedule_caps;
END;
$$;`;
    expect(unqualifiedDeletes(sql)).toEqual(['public.ca_rake_schedule_caps']);
  });
});

describe('the shapes a bare form would miss', () => {
  it('catches a DELETE ... USING with no WHERE', () => {
    expect(unqualifiedDeletes('delete from a using b;')).toEqual(['a']);
  });

  it('catches a DELETE ... RETURNING with no WHERE', () => {
    expect(unqualifiedDeletes('delete from a returning *;')).toEqual(['a']);
  });

  it('catches an unqualified UPDATE', () => {
    expect(unqualifiedUpdates('update public.clubs set member_count = 0;')).toEqual([
      'public.clubs',
    ]);
  });

  it('passes an UPDATE that carries a predicate', () => {
    expect(unqualifiedUpdates('update public.clubs set member_count = 0 where id = p_id;')).toEqual(
      []
    );
  });

  it('passes UPDATE ... FROM ... WHERE', () => {
    expect(unqualifiedUpdates('update a set x = b.x from b where b.id = a.id;')).toEqual([]);
  });

  it('reads a quoted identifier and a schema qualifier as one table', () => {
    expect(unqualifiedDeletes('delete from "public"."ca_ddl_events";')).toEqual([
      '"public"."ca_ddl_events"',
    ]);
  });

  it('is not fooled by case or by newlines inside the statement', () => {
    expect(unqualifiedUpdates('UPDATE\n  a\n  SET\n    x = 1\n;')).toEqual(['a']);
    expect(unqualifiedDeletes('DELETE\nFROM\n  a\n;')).toEqual(['a']);
  });
});

describe('the checker does not block the migration that repairs it', () => {
  it('ignores the broken statement quoted in a line comment', () => {
    // Every one of these fixes explains itself by quoting the defect. A gate
    // that reads its own remedy as the defect blocks the repair and allows the
    // original - the worst possible direction to be wrong in.
    const sql = `
-- It used to say: delete from tmp_agg31;
-- and safeupdate refused it on the PostgREST path.
delete from tmp_agg31 where true;
`;
    expect(offenders(sql)).toEqual([]);
  });

  it('ignores it inside a block comment', () => {
    expect(offenders('/* was: DELETE FROM zz_backfill_units; */\nselect 1;')).toEqual([]);
  });

  it('ignores it inside a string literal, which is how the fix is written', () => {
    // The in-place patch builds the search pattern as a literal and EXECUTEs
    // the result. Nothing there is a statement.
    const sql = `
DO $$
DECLARE v_new text;
BEGIN
  v_new := regexp_replace(v_def, 'delete\\s+from\\s+tmp_agg31\\s*;',
                          'delete from tmp_agg31 where true;', 'gi');
  EXECUTE v_new;
END $$;`;
    expect(offenders(sql)).toEqual([]);
  });

  it('is not confused by an escaped quote inside a literal', () => {
    expect(offenders(`select 'it''s fine: delete from a;';`)).toEqual([]);
  });

  it('does not let a semicolon inside a literal end an UPDATE early', () => {
    const sql = `update a set note = 'x; y' where id = 1;`;
    expect(unqualifiedUpdates(sql)).toEqual([]);
  });
});

describe('a deliberate one is written down, with a reason', () => {
  it('accepts a declared exception that names the table and says why', () => {
    const sql = `
-- unqualified-write-ok: _scratch because this table is created TEMP inside the
--   function and every row of it is rebuilt on the next line
delete from _scratch;
`;
    expect(declaredExceptions(sql).has('_scratch')).toBe(true);
    expect(offenders(sql)).toEqual([]);
  });

  it('refuses a reason too short to be a reason', () => {
    const sql = `
-- unqualified-write-ok: _scratch because temp
delete from _scratch;
`;
    expect(declaredExceptions(sql).size).toBe(0);
    expect(offenders(sql)).toEqual([{ verb: 'DELETE', table: '_scratch' }]);
  });

  it('does not let one exception cover a different table', () => {
    // Otherwise the marker gets pasted once and silently covers whatever the
    // file grows into later.
    const sql = `
-- unqualified-write-ok: _scratch because this is a temp table rebuilt in full
--   on the very next statement of the same function
delete from _scratch;
delete from public.ca_treasury_baseline;
`;
    expect(offenders(sql)).toEqual([{ verb: 'DELETE', table: 'public.ca_treasury_baseline' }]);
  });
});

describe('the gate is actually wired to something', () => {
  it('runs in CI as a blocking step', async () => {
    const { readFileSync } = await import('fs');
    const ci = readFileSync(resolve(__dirname, '..', '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('node scripts/ci/check-unqualified-writes.mjs');
  });

  it('runs on pre-push, where the author still has the context', async () => {
    const { readFileSync } = await import('fs');
    const hook = readFileSync(resolve(__dirname, '..', '.husky/pre-push'), 'utf8');
    expect(hook).toContain('check-unqualified-writes.mjs');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE COMMENT STRIPPER THAT ATE ITS OWN CLOSING QUOTE (2026-09-25)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The checker stripped comments and literals with two independent regexes, and
 * neither knew about the other. The project's standard idiom for stripping
 * comments FROM SQL
 *
 *     regexp_replace(pg_get_functiondef(...), '--[^' || chr(10) || ']*', '', 'g')
 *
 * is a string literal CONTAINING `--`. The comment pass ate from that `--` to
 * end of line, took the closing quote with it, and orphaned the opening one.
 * Five such lines in `20260921151618` inverted quote parity for the rest of the
 * file, so a genuine literal further down
 *
 *     IF v_begin ~ 'UPDATE public\.table_seats|DELETE FROM public\.table_seats'
 *
 * survived into the "clean" SQL and was reported as `DELETE on public` - a
 * table nobody writes, in a migration with no DELETE in it at all. The gate
 * blocked a branch over a statement that was not there.
 *
 * THE DIRECTION THAT MATTERS HERE IS THE OPPOSITE ONE. A stripper made quiet
 * enough to stop crying wolf is a stripper that can be talked into swallowing a
 * real unqualified write, and a false negative on this gate is what took the
 * GTO driver down. So every case below that proves the false positive is gone
 * is paired with one that proves the genuine article is still caught, and both
 * halves have to hold.
 */
describe('one left-to-right scan, not two regexes that disagree', () => {
  // The exact idiom, character for character, as the migration writes it.
  const IDIOM = `regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g')`;

  it('still catches the bare forms — this is what stops the fix being a loosening', () => {
    expect(offenders('DELETE FROM t;')).toEqual([{ verb: 'DELETE', table: 't' }]);
    expect(offenders('UPDATE t SET x = 1;')).toEqual([{ verb: 'UPDATE', table: 't' }]);
  });

  it('clears the same two once they carry a predicate', () => {
    expect(offenders('DELETE FROM t WHERE id = 1;')).toEqual([]);
    expect(offenders('UPDATE t SET x = 1 WHERE id = 1;')).toEqual([]);
  });

  it('does not let the comment-stripping idiom eat its own closing quote', () => {
    // Five of them, because five is what it took to invert parity for the rest
    // of the file. The literal below is the one that was misread as code.
    const sql = `
DO $$
DECLARE
  v_tick   text := ${IDIOM};
  v_bal    text := ${IDIOM};
  v_begin  text := ${IDIOM};
  v_abort  text := ${IDIOM};
  v_commit text := ${IDIOM};
BEGIN
  IF v_begin ~ 'UPDATE public\\.table_seats|UPDATE table_seats|DELETE FROM public\\.table_seats'
     OR v_abort ~ 'UPDATE public\\.table_seats|DELETE FROM public\\.table_seats' THEN
    RAISE EXCEPTION 'the seat writer moved';
  END IF;
END $$;`;
    expect(offenders(sql)).toEqual([]);
  });

  it('still reads the statement AFTER the idiom as code', () => {
    // The pairing that matters: the idiom must stop the guard mis-reading, not
    // stop it reading. If this ever goes green the parity bug has been traded
    // for a blind spot in the same place.
    const sql = `
DO $$
DECLARE
  v_tick text := ${IDIOM};
BEGIN
  DELETE FROM public.ca_treasury_baseline;
END $$;`;
    expect(offenders(sql)).toEqual([{ verb: 'DELETE', table: 'public.ca_treasury_baseline' }]);
  });

  it('clears the Phase 5 migration the two-regex stripper blocked', async () => {
    // The file itself, not a reconstruction of it: this is the regression, and
    // a paraphrase of it would not have caught the original.
    const { readFileSync, readdirSync } = await import('fs');
    const dir = resolve(__dirname, '..', 'supabase/migrations');
    const file = readdirSync(dir).find((f) => f.startsWith('20260921151618_'));
    expect(file, 'the Phase 5 conversion migration').toBeTruthy();
    const sql = readFileSync(resolve(dir, file as string), 'utf8');
    // It contains the idiom six times and no DELETE statement whatsoever.
    expect(sql).toContain(`'--[^' || chr(10) || ']*'`);
    expect(offenders(sql)).toEqual([]);
  });
});

describe('the scanner reads SQL the way the lexer does', () => {
  it('judges an unqualified write inside a $$ body on its merits', () => {
    // Bodies are KEPT, not skipped. The dangerous statement lives in one.
    const sql = `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.ca_ddl_events;
END $$;`;
    expect(offenders(sql)).toEqual([{ verb: 'DELETE', table: 'public.ca_ddl_events' }]);
  });

  it('judges one inside a $tag$ body too, and clears it once it has a predicate', () => {
    const body = (stmt: string) => `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  ${stmt}
END $function$;`;
    expect(offenders(body('UPDATE public.clubs SET member_count = 0;'))).toEqual([
      { verb: 'UPDATE', table: 'public.clubs' },
    ]);
    expect(offenders(body('UPDATE public.clubs SET member_count = 0 WHERE id = p_id;'))).toEqual(
      []
    );
  });

  it('does not let a -- comment inside a body run on past the body', () => {
    const sql = `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  -- it used to say DELETE FROM tmp_agg31; and safeupdate refused it
  DELETE FROM tmp_agg31 WHERE true;
END $fn$;
DELETE FROM public.zz_real;`;
    expect(offenders(sql)).toEqual([{ verb: 'DELETE', table: 'public.zz_real' }]);
  });

  it('does not let a quote inside a -- comment open a literal', () => {
    // An apostrophe in prose used to flip parity for everything after it.
    const sql = `-- the driver's own tick, which is where it broke
DELETE FROM public.zz_real;`;
    expect(offenders(sql)).toEqual([{ verb: 'DELETE', table: 'public.zz_real' }]);
  });

  it('does not let a -- inside a literal open a comment', () => {
    const sql = `SELECT 'a -- b' AS x;
DELETE FROM public.zz_real;`;
    expect(offenders(sql)).toEqual([{ verb: 'DELETE', table: 'public.zz_real' }]);
  });

  it('ignores a write quoted inside a literal but not the one beside it', () => {
    const sql = `SELECT 'delete from public.zz_hidden;' AS pattern;
UPDATE public.zz_real SET x = 1;`;
    expect(offenders(sql)).toEqual([{ verb: 'UPDATE', table: 'public.zz_real' }]);
  });

  it('reads a nested block comment to its real end, as Postgres does', () => {
    // Postgres nests /* */. A stripper that stops at the first */ hands the
    // rest of the comment back to the guard as code.
    const sql = `/* outer /* inner */ DELETE FROM public.zz_hidden; */
DELETE FROM public.zz_real;`;
    expect(offenders(sql)).toEqual([{ verb: 'DELETE', table: 'public.zz_real' }]);
  });

  it('is not confused by a backslash-escaped quote in an E string', () => {
    const sql = `SELECT e'a\\'b delete from public.zz_hidden;' AS x;
DELETE FROM public.zz_real;`;
    expect(offenders(sql)).toEqual([{ verb: 'DELETE', table: 'public.zz_real' }]);
  });

  it('is not opened by a $ inside an identifier or by a positional parameter', () => {
    const sql = `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('select %I', a$b) USING $1;
  DELETE FROM public.zz_real;
END $$;`;
    expect(offenders(sql)).toEqual([{ verb: 'DELETE', table: 'public.zz_real' }]);
  });

  it('does not let a quote inside a quoted identifier open a literal', () => {
    const sql = `DELETE FROM "it's_a_table";`;
    // The name is squashed of whitespace on the way out, as it always has
    // been, so this asserts the quote and not the spacing.
    expect(offenders(sql)).toEqual([{ verb: 'DELETE', table: `"it's_a_table"` }]);
  });
});
