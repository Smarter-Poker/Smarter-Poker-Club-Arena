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
 * just created or retired, drop a fragment in
 * scripts/ci/schema-manifest.d/<your-slug>.json:
 *
 *   { "tables":           ["ca_engine_deploy_attempts"],
 *     "functions":        ["fn_ca_record_engine_deploy_attempt"],
 *     "removedFunctions": ["legacy_repair_writer"],
 *     "columns":   { "tables": ["no_rathole"] } }
 *
 * Every key is optional. Your file is yours alone, so it cannot conflict with
 * anyone else's, and the CI gates read the base UNION every fragment.
 *
 * Additions let the branch reference a new object before the live snapshot
 * catches up. Explicit removal tombstones do the inverse: once a migration
 * retires a function/table, the stale live snapshot must not keep blessing a
 * reference to it until the next nightly refresh. What stops either direction
 * from lying is the nightly refresh (schema-manifest-refresh.yml): it
 * regenerates the base, deletes every absorbed declaration/tombstone, and goes
 * red when a promised addition is absent or a promised removal is still live.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const BASE_SCHEMA = 'scripts/ci/supabase-schema-manifest.json';
export const BASE_COLUMNS = 'scripts/ci/supabase-columns-manifest.json';
export const FRAGMENT_DIR = 'scripts/ci/schema-manifest.d';

const KNOWN_KEYS = new Set([
  'tables',
  'functions',
  'removedTables',
  'removedFunctions',
  'columns',
  '_comment',
  '_owner',
]);

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
          `manifest fragment ${name} has unknown key "${key}" - expected tables, functions, removal tombstones or columns`
        );
      }
    }
    for (const key of ['tables', 'functions', 'removedTables', 'removedFunctions']) {
      if (data[key] !== undefined && !Array.isArray(data[key])) {
        throw new Error(`manifest fragment ${name}: "${key}" must be an array of names`);
      }
    }
    if (data.columns !== undefined) {
      if (
        data.columns === null ||
        typeof data.columns !== 'object' ||
        Array.isArray(data.columns)
      ) {
        throw new Error(
          `manifest fragment ${name}: "columns" must be an object of table -> [columns]`
        );
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

/**
 * The effective table/function manifest: nightly base plus branch additions,
 * minus explicit branch retirement tombstones.
 */
export function loadSchemaManifest(repo = process.cwd()) {
  const basePath = join(repo, BASE_SCHEMA);
  if (!existsSync(basePath)) {
    throw new Error(`schema manifest not found at ${basePath}`);
  }
  const base = parse(basePath, 'schema manifest');
  const tables = new Set(base.tables || []);
  const functions = new Set(base.functions || []);
  const addedTables = new Set();
  const addedFunctions = new Set();
  /* A FRAGMENT IS A PROMISE, NOT AN OBSERVATION (2026-09-22).
     The base snapshot is generated FROM the live schema, so a name in it was
     seen in production. A fragment is a line an agent typed on their own
     branch. Unioning the two loses which is which, and every reader downstream
     then reports a promise as a fact - see check-migrations-applied.mjs, which
     printed "every object these migrations declare exists in the live schema"
     about fourteen tables production had never heard of. Keep the fragment-only
     names separate so a reader can tell the two apart. */
  const promisedTables = new Set();
  const promisedFunctions = new Set();
  const removedTables = new Set();
  const removedFunctions = new Set();
  let declared = 0;
  for (const { data } of readFragments(repo)) {
    for (const t of data.tables || []) {
      if (!tables.has(t)) {
        declared++;
        promisedTables.add(t);
      }
      tables.add(t);
      addedTables.add(t);
    }
    for (const f of data.functions || []) {
      if (!functions.has(f)) {
        declared++;
        promisedFunctions.add(f);
      }
      functions.add(f);
      addedFunctions.add(f);
    }
    for (const t of data.removedTables || []) removedTables.add(t);
    for (const f of data.removedFunctions || []) removedFunctions.add(f);
  }
  for (const t of removedTables) {
    if (addedTables.has(t)) {
      throw new Error(`schema fragments both add and remove table "${t}"`);
    }
    tables.delete(t);
  }
  for (const f of removedFunctions) {
    if (addedFunctions.has(f)) {
      throw new Error(`schema fragments both add and remove function "${f}"`);
    }
    functions.delete(f);
  }
  return {
    tables: [...tables].sort(),
    functions: [...functions].sort(),
    declaredByFragments: declared,
    removedByFragments: removedTables.size + removedFunctions.size,
    /* Names present ONLY because a fragment promised them. Anything here is
       unproved against production by construction. */
    promisedTables: [...promisedTables].sort(),
    promisedFunctions: [...promisedFunctions].sort(),
  };
}

/**
 * The effective column manifest: the nightly base union fragment additions,
 * minus every relation retired by a fragment tombstone.
 */
export function loadColumnsManifest(repo = process.cwd()) {
  const basePath = join(repo, BASE_COLUMNS);
  const columns = existsSync(basePath)
    ? { ...(parse(basePath, 'columns manifest').columns || {}) }
    : {};
  let declared = 0;
  const fragments = readFragments(repo);
  const removedTables = new Set();
  for (const { data } of fragments) {
    for (const table of data.removedTables || []) removedTables.add(table);
    for (const [table, cols] of Object.entries(data.columns || {})) {
      const merged = new Set(columns[table] || []);
      for (const c of cols) {
        if (!merged.has(c)) declared++;
        merged.add(c);
      }
      columns[table] = [...merged].sort();
    }
  }
  for (const table of removedTables) delete columns[table];
  return { columns, declaredByFragments: declared, removedByFragments: removedTables.size };
}
