#!/usr/bin/env node
/**
 * CI GATE — Phantom-column detector
 *
 * Extends the Phase-U4 silent-failure invariants. The phantom-TABLE gate catches
 * `.from('missing_table')`; this one catches `.from('real_table').select('missing_col')`
 * — a PostgREST 42703 that returns an error the caller usually swallows, so the UI
 * silently shows nothing. This exact class caused this session's biggest finds:
 * promotions invisible platform-wide (`.select('title, image_url, …')` on a table
 * whose columns are name/banner_url/status), and credit requests broken
 * (`requester_name`/`approver_name` columns that don't exist).
 *
 * Source of truth: scripts/ci/supabase-columns-manifest.json  {table: [columns]}.
 * Regenerate with scripts/ci/gen-schema-manifest.mjs when the schema changes.
 *
 * CONSERVATIVE BY DESIGN — to never fail CI wrongly, it SKIPS anything it cannot
 * statically resolve: `*`, embedded resources (`related(col)`), jsonb paths
 * (`col->>x`), aggregates (`count`), template-literal selects (dynamic), and any
 * table not in the manifest (that is a phantom TABLE, the other gate's job). It
 * only flags a bare column that is provably absent from a known table.
 *
 * Usage:
 *   node scripts/ci/check-phantom-columns.mjs          # strict (exit 1)
 *   node scripts/ci/check-phantom-columns.mjs --warn    # non-blocking
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const REPO = process.cwd();
const MANIFEST = join(REPO, 'scripts/ci/supabase-columns-manifest.json');
const ALLOWLIST = join(REPO, 'scripts/ci/supabase-invariants.allowlist.json');
const SCAN_DIRS = ['src', 'server/src'];
const WARN_ONLY = process.argv.includes('--warn');

function loadJson(p, label) {
  if (!existsSync(p)) {
    console.error(`ERROR: ${label} not found at ${p}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

const cols = loadJson(MANIFEST, 'columns manifest').columns || {};
const allow = loadJson(ALLOWLIST, 'invariants allowlist');
// A table→Set(columns) lookup. PostgREST also always allows these virtual cols.
const VIRTUAL = new Set(['count']);
const tableCols = new Map(Object.entries(cols).map(([t, c]) => [t, new Set(c)]));

// Optional per-table column allowlist for legitimately-dynamic or view-projected
// names. Shape in the allowlist file: "phantomColumns": { "table": ["col", ...] }.
const colAllow = new Map(
  Object.entries(allow.phantomColumns || {}).map(([t, c]) => [t, new Set(c)])
);

function listCodeFiles(dir) {
  const out = [];
  try {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const full = join(dir, e);
      const s = statSync(full);
      if (s.isDirectory()) out.push(...listCodeFiles(full));
      else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e) && !/\.test\./.test(e)) out.push(full);
    }
  } catch {
    /* dir absent */
  }
  return out;
}

// Split a select string on TOP-LEVEL commas only (embeds keep their inner commas).
function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// Resolve a select token to the bare base column on THIS table, or null if it
// should be skipped (embed / star / aggregate / renamed embed / jsonb-on-embed).
function baseColumn(token) {
  let t = token.trim();
  if (!t || t === '*') return null;
  if (t.includes('(')) return null; // embedded resource — different table
  // alias:column  →  column   (PostgREST rename syntax)
  if (t.includes(':')) t = t.slice(t.indexOf(':') + 1).trim();
  // jsonb path: settings->>'k' or col->a->>b  → base col
  if (t.includes('->')) t = t.slice(0, t.indexOf('->')).trim();
  // strip ::cast and .modifiers
  t = t.split('::')[0].trim();
  if (!/^[a-z_][a-z0-9_]*$/i.test(t)) return null; // not a plain identifier — skip
  if (VIRTUAL.has(t)) return null;
  return t;
}

// Find .from('table')...select('literal') pairs. The select is attributed to the
// nearest preceding .from(...) whose scope hasn't been closed by another .from(.
const fromRx = /\.from\s*\(\s*['"]([a-z_][a-z0-9_]*)['"]\s*\)/g;
// select with a STRING literal only (skip template-literal / dynamic selects).
const selectRx = /\.select\s*\(\s*(['"])([^'"]*)\1/g;

const phantoms = new Map(); // "table.col" → [{file,line}]

for (const dir of SCAN_DIRS) {
  for (const f of listCodeFiles(join(REPO, dir))) {
    const src = readFileSync(f, 'utf8');
    // Index every .from() with its position + table.
    const froms = [];
    fromRx.lastIndex = 0;
    let m;
    while ((m = fromRx.exec(src))) froms.push({ pos: m.index, table: m[1] });
    if (!froms.length) continue;
    // For each select literal, attribute it to the nearest preceding .from().
    selectRx.lastIndex = 0;
    let s;
    while ((s = selectRx.exec(src))) {
      const selPos = s.index;
      let owner = null;
      for (const fr of froms) {
        if (fr.pos < selPos) owner = fr;
        else break;
      }
      if (!owner) continue;
      const table = owner.table;
      const known = tableCols.get(table);
      if (!known) continue; // unknown table → phantom-table gate's job
      const line = src.slice(0, selPos).split('\n').length;
      for (const tok of splitTopLevel(s[2])) {
        const col = baseColumn(tok);
        if (!col) continue;
        if (known.has(col)) continue;
        if (colAllow.get(table)?.has(col)) continue;
        const key = `${table}.${col}`;
        if (!phantoms.has(key)) phantoms.set(key, []);
        phantoms.get(key).push({ file: f.replace(REPO + '/', ''), line });
      }
    }
  }
}

console.log(`[check-phantom-columns] tables in manifest: ${tableCols.size}`);
console.log(`[check-phantom-columns] phantom columns: ${phantoms.size}`);

if (phantoms.size === 0) {
  console.log('OK — every resolvable .select() column exists on its table.');
  process.exit(0);
}

console.log('');
console.log('PHANTOM COLUMNS DETECTED (.select() names a column the table does not have):');
console.log('');
for (const [key, sites] of phantoms) {
  console.log(`  ${key}`);
  for (const st of sites.slice(0, 4)) console.log(`    ${st.file}:${st.line}`);
  if (sites.length > 4) console.log(`    ... ${sites.length - 4} more`);
}
console.log('');
console.log('Fix: correct the column name, alias the real column (alias:real_col),');
console.log('add the migration + regenerate the manifest, or (for a view-projected or');
console.log('dynamic name) allowlist it under "phantomColumns" in');
console.log('scripts/ci/supabase-invariants.allowlist.json.');

if (WARN_ONLY) {
  console.log('[--warn] exiting 0 despite phantoms.');
  process.exit(0);
}
process.exit(1);
