/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  READING THE MIGRATION CORPUS, ONCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * supabase/migrations holds 2,917 files and 32MB. A law that wants to know what
 * is DEPLOYED has to find the last migration that declares a function, which
 * means scanning all of them, and the obvious way to write that scans them
 * again for every name: a law asking about four functions reads 128MB.
 *
 * On 2026-09-11 that put roughly seventy-five migration-scanning laws over
 * vitest's 5 second budget whenever the machine was busy. Every one of them a
 * TIMEOUT, not an assertion failure, and every one green when run alone, which
 * is the shape that makes a red suite easy to wave away. The Diamond Games laws
 * went from 5.5 seconds to 47, 33, 17 and 13 milliseconds on this cache alone.
 *
 * WHY BY DECLARATION, NOT BY NAME. A law that pins `latest('some_slug')` goes
 * stale the moment a later migration rewrites the function: it keeps reading
 * the old file and keeps passing while production contradicts it. That happened
 * twice in this branch. The last migration to DECLARE a function is the one
 * Postgres is running, so that is what these resolve.
 *
 * 331 test files still read this directory their own way. This is where they
 * should come, and converting them is the remaining work.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { catalogSQLUnits } from './migrationSQLUnits';

export const MIGRATIONS_DIR = resolve(__dirname, '..', '..', 'supabase/migrations');

let names: string[] | null = null;
const contents = new Map<string, string>();

/** Every migration, sorted, which is the order Postgres applied them in. */
export function migrationFiles(): string[] {
  if (!names)
    names = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  return names;
}

/** One migration's text, read at most once per test file. */
export function readMigration(name: string): string {
  const hit = contents.get(name);
  if (hit !== undefined) return hit;
  const sql = readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8');
  contents.set(name, sql);
  return sql;
}

const catalogUnits = new Map<string, ReturnType<typeof catalogSQLUnits>>();

/** JSON catalog pre-images are data, not the migration's active declaration.
 * Dynamic JSON-carried DDL is ambiguous to this source-only reader: refuse it
 * rather than silently reading an older function and manufacturing a pass.
 */
export function authoritativeMigrationSQL(sql: string, fn: string): string {
  let units = catalogUnits.get(sql);
  if (!units) {
    units = catalogSQLUnits(sql);
    catalogUnits.set(sql, units);
  }
  const escaped = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${escaped}\\s*\\(`,
    'i'
  );
  if (units.slice(1).some((unit) => header.test(unit.sql))) {
    const outer = units[0].sql
      .replace(/'(?:''|[^'])*'/g, (literal) => literal.replace(/[^\n]/g, ' '))
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const dynamic = [...outer.matchAll(/\bEXECUTE\b/gi)].some(
      (match) => !/(?:GRANT|REVOKE)\s+$/i.test(outer.slice(0, match.index))
    );
    if (dynamic)
      throw new Error(`${fn}: dynamic JSON-carried DDL requires an explicit source reader`);
  }
  return units[0].sql;
}

const declaring = new Map<string, { name: string; sql: string }>();

/**
 * The migration currently in force for `fn`: the last one that declares it.
 * Throws rather than returning nothing, because a law that silently found no
 * migration would assert on an empty string and pass.
 */
export function latestDeclaring(fn: string): { name: string; sql: string } {
  const hit = declaring.get(fn);
  if (hit) return hit;
  const hits = migrationFiles().filter((f) => {
    const sql = authoritativeMigrationSQL(readMigration(f), fn);
    return (
      sql.includes(`CREATE OR REPLACE FUNCTION public.${fn}(`) ||
      sql.includes(`CREATE FUNCTION public.${fn}(`)
    );
  });
  if (hits.length === 0) throw new Error(`no migration declares public.${fn}`);
  const name = hits[hits.length - 1];
  const found = { name, sql: readMigration(name) };
  declaring.set(fn, found);
  return found;
}

/** The most recent migration whose filename contains `fragment`. */
export function latestNamed(fragment: string): { name: string; sql: string } {
  const hits = migrationFiles().filter((f) => f.includes(fragment));
  if (hits.length === 0) throw new Error(`no migration named like ${fragment}`);
  const name = hits[hits.length - 1];
  return { name, sql: readMigration(name) };
}

/** The body of `fn` as declared in `sql`, between its dollar quotes. */
export function functionBody(sql: string, fn: string): string {
  sql = authoritativeMigrationSQL(sql, fn);
  const escaped = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declarations = [
    ...sql.matchAll(
      new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${escaped}\\s*\\(`, 'gi')
    ),
  ];
  const declaration = declarations.at(-1);
  if (!declaration || declaration.index === undefined)
    throw new Error(`${fn} is not declared in this migration`);
  const rest = sql.slice(declaration.index);
  const delimiter = /\bAS\s+(\$\w*\$)/i.exec(rest);
  const nextDeclaration = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i.exec(
    rest.slice(declaration[0].length)
  );
  if (
    !delimiter ||
    (nextDeclaration && delimiter.index >= declaration[0].length + nextDeclaration.index)
  ) {
    throw new Error(`${fn} has no dollar-quoted body`);
  }
  const bodyStart = delimiter.index + delimiter[0].length;
  const bodyEnd = rest.indexOf(delimiter[1], bodyStart);
  if (bodyEnd < 0) throw new Error(`${fn} has no closing dollar quote`);
  return rest.slice(bodyStart - delimiter[1].length, bodyEnd);
}
