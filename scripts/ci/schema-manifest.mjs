/**
 * ONE SNAPSHOT, MANY WRITERS - the schema manifests stop being a merge queue.
 *
 * `supabase-schema-manifest.json` was the single most-changed file on main:
 * 25 commits in 24 hours, ahead of every source file in the repo, with
 * `supabase-columns-manifest.json` third at 14. They are sorted JSON arrays
 * that EVERY agent shipping a migration has to append its own names to, so any
 * two such branches conflict by construction. Main takes a commit every seven
 * minutes here; a branch that has to merge main, re-resolve the manifest, wait
 * three minutes for the pre-push hook and twenty-five for CI loses that race
 * about half the time, and loses it again on the retry.
 *
 * This is the same failure the repo already fixed once. CLAUDE.md rule 10.9:
 * MIGRATION-CHANGELOG.md was 18 of 108 conflicting pull requests because every
 * agent appended to the last line of one file, and the fix was to give each
 * agent its own file. "Two files written independently cannot conflict."
 *
 * So the base snapshot is now READ-ONLY to agents. To declare something you
 * just created, drop a fragment in scripts/ci/schema-manifest.d/<your-slug>.json:
 *
 *   { "tables":    ["ca_engine_deploy_attempts"],
 *     "functions": ["fn_ca_engine_deploy_truth_watch"],
 *     "columns":   { "tables": ["no_rathole"] } }
 *
 * Every key is optional. Your file is yours alone, so it cannot conflict with
 * anyone else's, and the CI gates read the base UNION every fragment.
 *
 * The overlay only ever ADDS names, so the phantom-reference gates stay exactly
 * as strict about everything nobody has declared. What stops a fragment from
 * lying is the nightly refresh (schema-manifest-refresh.yml): it regenerates
 * the base from the live database, deletes every fragment the base has absorbed,
 * and goes red on any fragment naming something production does not have.
 * A wrong fragment therefore survives at most one day and announces itself.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const BASE_SCHEMA = 'scripts/ci/supabase-schema-manifest.json';
export const BASE_COLUMNS = 'scripts/ci/supabase-columns-manifest.json';
export const FRAGMENT_DIR = 'scripts/ci/schema-manifest.d';

const KNOWN_KEYS = new Set(['tables', 'functions', 'columns', '_comment', '_owner']);

function parse(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot parse ${label} (${path}): ${err.message}`);
  }
}

/**
 * Every fragment, parsed and validated. A malformed or misspelled fragment
 * THROWS rather than being skipped: a declaration that silently does nothing
 * would send its author back to editing the base file, which is the thing this
 * exists to stop.
 */
export function readFragments(repo = process.cwd()) {
  const dir = join(repo, FRAGMENT_DIR);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const data = parse(join(dir, name), `manifest fragment ${name}`);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`manifest fragment ${name} must be a JSON object`);
    }
    for (const key of Object.keys(data)) {
      if (!KNOWN_KEYS.has(key)) {
        throw new Error(
          `manifest fragment ${name} has unknown key "${key}" - expected tables, functions or columns`
        );
      }
    }
    for (const key of ['tables', 'functions']) {
      if (data[key] !== undefined && !Array.isArray(data[key])) {
        throw new Error(`manifest fragment ${name}: "${key}" must be an array of names`);
      }
    }
    if (data.columns !== undefined) {
      if (data.columns === null || typeof data.columns !== 'object' || Array.isArray(data.columns)) {
        throw new Error(`manifest fragment ${name}: "columns" must be an object of table -> [columns]`);
      }
      for (const [table, cols] of Object.entries(data.columns)) {
        if (!Array.isArray(cols)) {
          throw new Error(`manifest fragment ${name}: columns.${table} must be an array`);
        }
      }
    }
    out.push({ file: name, data });
  }
  return out;
}

/** The table/function manifest: the nightly base snapshot union every fragment. */
export function loadSchemaManifest(repo = process.cwd()) {
  const basePath = join(repo, BASE_SCHEMA);
  if (!existsSync(basePath)) {
    throw new Error(`schema manifest not found at ${basePath}`);
  }
  const base = parse(basePath, 'schema manifest');
  const tables = new Set(base.tables || []);
  const functions = new Set(base.functions || []);
  let declared = 0;
  for (const { data } of readFragments(repo)) {
    for (const t of data.tables || []) {
      if (!tables.has(t)) declared++;
      tables.add(t);
    }
    for (const f of data.functions || []) {
      if (!functions.has(f)) declared++;
      functions.add(f);
    }
  }
  return {
    tables: [...tables].sort(),
    functions: [...functions].sort(),
    declaredByFragments: declared,
  };
}

/** The column manifest: the nightly base snapshot union every fragment's columns. */
export function loadColumnsManifest(repo = process.cwd()) {
  const basePath = join(repo, BASE_COLUMNS);
  const columns = existsSync(basePath) ? { ...(parse(basePath, 'columns manifest').columns || {}) } : {};
  let declared = 0;
  for (const { data } of readFragments(repo)) {
    for (const [table, cols] of Object.entries(data.columns || {})) {
      const merged = new Set(columns[table] || []);
      for (const c of cols) {
        if (!merged.has(c)) declared++;
        merged.add(c);
      }
      columns[table] = [...merged].sort();
    }
  }
  return { columns, declaredByFragments: declared };
}
