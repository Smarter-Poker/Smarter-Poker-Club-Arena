#!/usr/bin/env node
/**
 * CI GATE — Phantom-reference detector (tables + RPCs)
 *
 * Phase U4 of `CLUB-ARENA-OFFICIAL-UPGRADE-INTEGRATION.md` §2.4:
 * every `.from('<name>')` must resolve to a real table/view and every
 * `.rpc('<name>')` to a real function — otherwise the call is a silent
 * 42P01 / PGRST202 failure (0 rows, no error) that ships to prod.
 *
 * SOURCE OF TRUTH: `scripts/ci/supabase-schema-manifest.json` — a snapshot of
 * the LIVE public schema (all tables/views + functions). This replaces the old
 * "parse supabase/migrations/*.sql" approach, which false-positived on every
 * table created straight in prod via the Supabase MCP (the migrations are
 * intentionally stale — see CLAUDE.md). Regenerate the manifest with
 * `node scripts/ci/gen-schema-manifest.mjs` whenever the schema changes.
 *
 * Because all orbs share ONE Supabase project, the manifest already contains
 * every cross-orb table — no per-orb allowlisting needed. The only allowlist
 * entries are genuine, reasoned exceptions (see supabase-invariants.allowlist.json):
 * non-public targets (catalogs/auth/storage) and unbuilt-feature refs that
 * degrade gracefully.
 *
 * Scans src/ and server/src/ (comments stripped first, so JSDoc examples like
 * `* .from('solver_strategies')` are not treated as references).
 *
 * Usage:
 *   node scripts/ci/check-phantom-tables.mjs            # strict (exit 1 on phantom)
 *   node scripts/ci/check-phantom-tables.mjs --warn     # non-blocking (exit 0)
 *
 * Exit codes: 0 clean/--warn · 1 phantoms found · 2 script error
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const REPO = process.cwd();
const MANIFEST = join(REPO, 'scripts/ci/supabase-schema-manifest.json');
const ALLOWLIST = join(REPO, 'scripts/ci/supabase-invariants.allowlist.json');
const SCAN_DIRS = ['src', 'server/src'];
const WARN_ONLY = process.argv.includes('--warn');

// ─── 1. Load the live-schema manifest + allowlist ───────────────────────────
function loadJson(path, label) {
  if (!existsSync(path)) {
    console.error(`ERROR: ${label} not found at ${path}`);
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`ERROR: cannot parse ${label}: ${err.message}`);
    process.exit(2);
  }
}

const manifest = loadJson(MANIFEST, 'schema manifest');
const allow = loadJson(ALLOWLIST, 'invariants allowlist');
const realTables = new Set(manifest.tables || []);
const realFns = new Set(manifest.functions || []);

// Flatten every string value from the allowlist's category objects into two sets.
function allowSet(...groups) {
  const s = new Set();
  for (const g of groups) {
    if (!g) continue;
    for (const k of Object.keys(g)) if (k !== '_comment') s.add(k);
  }
  return s;
}
const allowTables = allowSet(allow.nonPublicTargets, allow.unbuiltFeatureTables);
const allowRpcs = allowSet(allow.unbuiltFeatureRpcs);

// ─── 2. Scan code (comments stripped) for .from() / .rpc() ──────────────────
function listCodeFiles(dir) {
  const out = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) out.push(...listCodeFiles(full));
      else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry) && !/\.test\./.test(entry)) out.push(full);
    }
  } catch {
    /* dir may not exist (e.g. server/ absent) */
  }
  return out;
}

// Strip block and line comments but PRESERVE newlines so line numbers stay
// accurate. Not a full JS lexer (a `//` or `/*` inside a string literal would
// be mis-stripped) but robust enough for finding .from()/.rpc() call sites and
// it eliminates the JSDoc/comment false-positive class.
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code'; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') {
        state = 'line';
        i += 2;
      } else if (c === '/' && d === '*') {
        state = 'block';
        i += 2;
      } else if (c === "'") {
        state = 'sq';
        out += c;
        i++;
      } else if (c === '"') {
        state = 'dq';
        out += c;
        i++;
      } else if (c === '`') {
        state = 'tpl';
        out += c;
        i++;
      } else {
        out += c;
        i++;
      }
    } else if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
        i++;
      } else i++;
    } else if (state === 'block') {
      if (c === '*' && d === '/') {
        state = 'code';
        i += 2;
      } else {
        if (c === '\n') out += c; // keep line count
        i++;
      }
    } else {
      // inside a string literal — copy verbatim, honor escapes
      out += c;
      if (c === '\\') {
        out += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (
        (state === 'sq' && c === "'") ||
        (state === 'dq' && c === '"') ||
        (state === 'tpl' && c === '`')
      ) {
        state = 'code';
      }
      i++;
    }
  }
  return out;
}

function collect(regex) {
  const hits = new Map(); // name → [{file,line}]
  for (const dir of SCAN_DIRS) {
    for (const f of listCodeFiles(join(REPO, dir))) {
      const src = stripComments(readFileSync(f, 'utf8'));
      let m;
      regex.lastIndex = 0;
      while ((m = regex.exec(src))) {
        const name = m[1];
        const line = src.slice(0, m.index).split('\n').length;
        if (!hits.has(name)) hits.set(name, []);
        hits.get(name).push({ file: f.replace(REPO + '/', ''), line });
      }
    }
  }
  return hits;
}

// Match the opening `.from('name'` / `.rpc('name'` only — do NOT require a
// closing paren, since .rpc('fn', {args}) and .from('t') as a base for a
// chained query both continue past the name.
const fromRefs = collect(/\.from\s*\(\s*['"]([a-z_][a-z0-9_]*)['"]/g);
const rpcRefs = collect(/\.rpc\s*\(\s*['"]([a-z_][a-z0-9_]*)['"]/g);

// ─── 3. Diff against the manifest ───────────────────────────────────────────
const phantomTables = [];
for (const [name, sites] of fromRefs) {
  if (realTables.has(name) || allowTables.has(name)) continue;
  phantomTables.push({ name, sites });
}
const phantomRpcs = [];
for (const [name, sites] of rpcRefs) {
  if (realFns.has(name) || allowRpcs.has(name)) continue;
  phantomRpcs.push({ name, sites });
}

// ─── 4. Report ──────────────────────────────────────────────────────────────
console.log(
  `[check-phantom-refs] manifest: ${realTables.size} tables/views, ${realFns.size} functions`
);
console.log(
  `[check-phantom-refs] referenced: ${fromRefs.size} tables, ${rpcRefs.size} rpcs · allowlisted: ${allowTables.size} tables, ${allowRpcs.size} rpcs`
);
console.log(
  `[check-phantom-refs] phantoms: ${phantomTables.length} tables, ${phantomRpcs.length} rpcs`
);

if (phantomTables.length === 0 && phantomRpcs.length === 0) {
  console.log('OK — every .from() and .rpc() resolves to a live table/view/function.');
  process.exit(0);
}

const printGroup = (title, arr, kind) => {
  if (!arr.length) return;
  console.log('');
  console.log(title);
  for (const { name, sites } of arr) {
    console.log(`  ${name}`);
    for (const s of sites) console.log(`    ${s.file}:${s.line}`);
  }
  console.log('');
  console.log(`Fix a phantom ${kind}:`);
  console.log(`  1. It SHOULD exist -> add the migration and regenerate the manifest.`);
  console.log(`  2. The name is wrong -> correct it to the real ${kind}.`);
  console.log(
    `  3. It is an intentional unbuilt-feature ref -> add it (with a reason) to`
  );
  console.log(`     scripts/ci/supabase-invariants.allowlist.json.`);
};

printGroup('PHANTOM TABLES DETECTED (.from() → missing table/view):', phantomTables, 'table');
printGroup('PHANTOM RPCS DETECTED (.rpc() → missing function):', phantomRpcs, 'rpc');

if (WARN_ONLY) {
  console.log('[--warn] exiting 0 despite phantoms.');
  process.exit(0);
}
process.exit(1);
