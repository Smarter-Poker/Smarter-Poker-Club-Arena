/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A PREDICATE CALLED ONCE PER ROW MUST STAY INLINABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `get_club_home` was the single largest consumer of database time on this
 * platform: 40,670 calls, 2,143.8 ms mean, 87,187 seconds total, 28.0% of ALL
 * database execution time.
 *
 * Most of it was one predicate. `fn_club_home_in_scope` decides whether a
 * table belongs on a club's home page and is evaluated against every live
 * table on the platform - 1,243 rows, 1,090 of them then discarded. The
 * function was already LANGUAGE sql, IMMUTABLE, PARALLEL SAFE and a single
 * CASE over six scalar arguments with no table access, so Postgres should fold
 * it into the calling query and never call it at all.
 *
 * IT COULD NOT, BECAUSE IT CARRIED `SET search_path`. A SQL function with a
 * SET clause is not inlinable - the planner has to keep a real function call
 * so the setting can be established and torn down around each invocation.
 *
 * Measured on production, same query, same rows:
 *
 *     with the function call ...................... 491.5 ms
 *     with the body inlined by hand ................ 76.6 ms
 *
 * and end to end, get_club_home itself:
 *
 *     Deep Stack Society (1,090 tables)  843.9 ms -> 257.7 ms
 *     Midway Union (155 tables)          851.7 ms -> 109.0 ms
 *     a club with no tables at all       480.9 ms ->  12.8 ms
 *
 * This test exists because the SET clause looks like hardening. Re-adding it
 * would be an easy, well-meant change that quietly gives back a quarter of the
 * database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', '..', '..', 'supabase', 'migrations');

const migration = (needle: string): string => {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(needle));
  if (!file) throw new Error(`no migration matching ${needle}`);
  return readFileSync(join(MIGRATIONS, file), 'utf8');
};

/**
 * The EXECUTED declaration, not the one quoted in the ROLLBACK comment.
 *
 * The rollback section deliberately contains a full CREATE with the SET clause
 * still on it - that is the way back. A naive indexOf finds the commented copy
 * first and reads the old shape as though it had shipped, which is exactly
 * what the first draft of this test did.
 */
const executedDeclaration = (sql: string): string => {
  const lines = sql.split('\n');
  const start = lines.findIndex(
    (l) =>
      !l.trimStart().startsWith('--') &&
      l.includes('CREATE OR REPLACE FUNCTION public.fn_club_home_in_scope')
  );
  if (start < 0) throw new Error('no uncommented declaration found');
  const rest = lines.slice(start).join('\n');
  return rest.slice(0, rest.indexOf('$function$'));
};

describe('fn_club_home_in_scope stays foldable into its caller', () => {
  const sql = migration('a_set_clause_was_costing_the_database_a_quarter_of_itself');

  it('declares the function without a SET clause', () => {
    expect(executedDeclaration(sql)).not.toMatch(/\bSET\s+search_path\b/);
  });

  it('keeps the three properties that make inlining possible', () => {
    const decl = executedDeclaration(sql);
    expect(decl).toMatch(/LANGUAGE sql/);
    expect(decl).toMatch(/IMMUTABLE/);
    expect(decl).toMatch(/COST 1/);
  });

  it('and the rollback still carries the SET, because that is the way back', () => {
    expect(sql).toMatch(/--.*SET search_path TO 'public'/);
  });

  it('still touches no tables, which is what makes dropping the SET safe', () => {
    // The safety argument is precisely that the body references no objects:
    // only `=`, COALESCE and ANY over its own parameters, all from pg_catalog,
    // which is always on the path and cannot be shadowed. A body that grew a
    // FROM would need the SET back - and would stop being inlinable anyway.
    const decl = executedDeclaration(sql);
    const open = sql.indexOf('$function$', sql.indexOf(decl)) + '$function$'.length;
    const body = sql.slice(open, sql.indexOf('$function$', open));
    expect(body).not.toMatch(/\bFROM\b/i);
    expect(body).not.toMatch(/\bJOIN\b/i);
  });

  it('asserts its own inlinability at apply time, not just in prose', () => {
    expect(sql).toContain('the SET clause is still there');
    expect(sql).toContain('must stay IMMUTABLE to be inlinable');
  });

  it('re-checks the four scope answers so speed never buys a wrong page', () => {
    expect(sql).toContain('union match no longer in scope');
    expect(sql).toContain('a different union is in scope');
    expect(sql).toContain('own private club dropped out of scope');
    expect(sql).toContain('club-list fallback no longer matches');
  });
});
