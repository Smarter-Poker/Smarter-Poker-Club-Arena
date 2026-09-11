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
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import {
  FROM_REFERENCE,
  RPC_REFERENCE,
  namesNeedingLiveProof,
} from './phantom-live-proof-policy.mjs';
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';
import { loadSchemaManifest } from './schema-manifest.mjs';

const REPO = process.cwd();
const MANIFEST = join(REPO, 'scripts/ci/supabase-schema-manifest.json');
const ALLOWLIST = join(REPO, 'scripts/ci/supabase-invariants.allowlist.json');
const SCAN_DIRS = ['src', 'server/src'];
const WARN_ONLY = process.argv.includes('--warn');
const BASE_REF_ARG = process.argv.find((arg) => arg.startsWith('--base-ref='));

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

/* The base snapshot UNION scripts/ci/schema-manifest.d/*.json, so an agent
   declaring a table it just created never has to edit the file every other
   agent is editing. See scripts/ci/schema-manifest.mjs. */
let manifest;
try {
  manifest = loadSchemaManifest(REPO);
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(2);
}
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

function gitText(args) {
  return execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolveBaseTree() {
  const requested =
    BASE_REF_ARG?.slice('--base-ref='.length) ||
    process.env.PHANTOM_BASE_REF ||
    (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main');
  try {
    gitText(['rev-parse', '--verify', `${requested}^{commit}`]);
    return gitText(['merge-base', 'HEAD', requested]).trim();
  } catch (err) {
    throw new Error(
      `cannot resolve phantom-reference comparison tree ${requested}; fetch the target branch or pass --base-ref=<target>: ${err.message}`
    );
  }
}

function gitTreePaths(tree, ...prefixes) {
  return gitText(['ls-tree', '-r', '--name-only', tree, '--', ...prefixes])
    .split('\n')
    .filter(Boolean);
}

function gitTreeFile(tree, path) {
  return gitText(['show', `${tree}:${path}`]);
}

const gitTreeSourceCache = new Map();

function loadGitTreeSources(tree) {
  if (gitTreeSourceCache.has(tree)) return gitTreeSourceCache.get(tree);
  let matchedPaths = '';
  try {
    matchedPaths = gitText([
      'grep',
      '-F',
      '-Il',
      '-e',
      '.rpc',
      '-e',
      '.from',
      tree,
      '--',
      ...SCAN_DIRS,
    ]);
  } catch (err) {
    if (err.status !== 1) throw err;
  }
  const candidatePaths = matchedPaths
    .split('\n')
    .filter(Boolean)
    .map((entry) => entry.slice(entry.indexOf(':') + 1));
  const paths = candidatePaths.filter(
    (path) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path) && !/\.test\./.test(path)
  );
  if (paths.length === 0) {
    gitTreeSourceCache.set(tree, []);
    return [];
  }
  const request = `${paths.map((path) => `${tree}:${path}`).join('\n')}\n`;
  const batch = execFileSync('git', ['cat-file', '--batch'], {
    cwd: REPO,
    input: request,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sources = [];
  let offset = 0;
  for (const path of paths) {
    const headerEnd = batch.indexOf(10, offset);
    if (headerEnd < 0) throw new Error(`git cat-file omitted the header for ${path}`);
    const header = batch.subarray(offset, headerEnd).toString('utf8');
    const match = header.match(/^[0-9a-f]+ blob (\d+)$/);
    if (!match) throw new Error(`git cat-file returned an invalid header for ${path}: ${header}`);
    const size = Number(match[1]);
    const start = headerEnd + 1;
    const end = start + size;
    sources.push({ path, source: batch.subarray(start, end).toString('utf8') });
    offset = end + 1;
  }
  gitTreeSourceCache.set(tree, sources);
  return sources;
}

function collectGitTree(tree, regex) {
  const names = new Set();
  for (const { source } of loadGitTreeSources(tree)) {
    const src = stripComments(source);
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(src))) names.add(match[1]);
  }
  return names;
}

function loadBaseManifest(tree) {
  const base = JSON.parse(gitTreeFile(tree, 'scripts/ci/supabase-schema-manifest.json'));
  // Fragments are merge-conflict avoidance declarations, not deployment
  // receipts. A fragment already present in the base can still be awaiting the
  // nightly live-schema refresh, so it cannot certify a newly added caller.
  return {
    tables: new Set(base.tables || []),
    functions: new Set(base.functions || []),
  };
}

// Match the opening `.from('name'` / `.rpc('name'` only — do NOT require a
// closing paren, since .rpc('fn', {args}) and .from('t') as a base for a
// chained query both continue past the name.
// AUDIT 2026-08-20: the negative lookbehind is the difference between a table
// and a STORAGE BUCKET. `supabase.storage.from('images')` is a bucket, not a
// relation, and matching it reported `images` as a phantom table with no way
// to resolve it except allowlisting a bucket as if it were a table. Any new
// bucket would have redded the build the same way.
const fromRefs = collect(FROM_REFERENCE);
const rpcRefs = collect(RPC_REFERENCE);

let baseProof;
try {
  const tree = resolveBaseTree();
  const baseManifest = loadBaseManifest(tree);
  const baseAllow = JSON.parse(gitTreeFile(tree, 'scripts/ci/supabase-invariants.allowlist.json'));
  baseProof = {
    tree,
    tables: namesNeedingLiveProof({
      currentNames: fromRefs.keys(),
      baseSourceNames: collectGitTree(tree, FROM_REFERENCE),
      baseManifestNames: baseManifest.tables,
      baseAllowNames: allowSet(baseAllow.nonPublicTargets),
    }),
    rpcs: namesNeedingLiveProof({
      currentNames: rpcRefs.keys(),
      baseSourceNames: collectGitTree(tree, RPC_REFERENCE),
      baseManifestNames: baseManifest.functions,
      baseAllowNames: [],
    }),
  };
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(2);
}

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
const pendingTableProof = new Set(baseProof.tables);
const pendingRpcProof = new Set(baseProof.rpcs);

function addMissingEntries(target, names, sitesByName) {
  const present = new Set(target.map((entry) => entry.name));
  for (const name of names) {
    if (present.has(name)) continue;
    target.push({ name, sites: sitesByName.get(name) || [] });
    present.add(name);
  }
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
console.log(
  `[check-phantom-refs] branch-new names needing live proof from ${baseProof.tree.slice(0, 12)}: ` +
    `${pendingTableProof.size} tables, ${pendingRpcProof.size} rpcs`
);

if (
  phantomTables.length === 0 &&
  phantomRpcs.length === 0 &&
  pendingTableProof.size === 0 &&
  pendingRpcProof.size === 0
) {
  console.log('OK — every .from() and .rpc() resolves to a live table/view/function.');
  process.exit(0);
}

/**
 * ─── Stale-snapshot rescue ──────────────────────────────────────────────────
 * Dan 2026-08-20: this gate broke CI THREE times in one day, every time on a
 * commit that had nothing to do with the reference it flagged. The cause was
 * never a bad reference — it was the snapshot. Schema is applied straight to
 * prod via the Supabase MCP, the manifest is refreshed by a DAILY job, so any
 * RPC added between refreshes fails everyone else's build until somebody
 * hand-regenerates it. A gate that goes red when a colleague does the right
 * thing is a gate people learn to ignore.
 *
 * So: before failing, ASK THE LIVE SCHEMA (the same fn_schema_manifest() RPC
 * the generator uses) when credentials are available. Anything that really
 * exists means the snapshot is stale, not the code — say so clearly and pass.
 * Anything still missing is a genuine phantom and still fails the build. With
 * no credentials (forks, local runs) behavior is exactly as before.
 */
/** Credentials were present but the database did not answer. Distinct from
 *  `null`, which means there were never any credentials (a fork, a local run). */
const UNAVAILABLE = Symbol('live-schema-unavailable');

async function liveSchema() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  // fn_schema_manifest returns ~800 tables and ~1900 functions; 20s was tight
  // enough that ordinary load could trip it, and a single attempt turned any
  // momentary blip into a hard build failure.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${url}/rest/v1/rpc/fn_schema_manifest`, {
        method: 'POST',
        headers: supabaseServerHeaders(key, { 'Content-Type': 'application/json' }),
        body: '{}',
        // Measured 2026-08-21: this RPC returned in 0.6s warm and 30.7s under
        // load, against a 30s budget — so on a slow day all three attempts can
        // expire and the gate loses its live evidence exactly when the database
        // is busiest. The wait costs nothing when the database is healthy.
        signal: AbortSignal.timeout(75000),
      });
      if (res.ok) {
        const data = await res.json();
        return {
          tables: new Set(data?.tables || []),
          functions: new Set(data?.functions || []),
        };
      }
      console.log(
        `[check-phantom-refs] live re-check attempt ${attempt}/3 failed (HTTP ${res.status})`
      );
    } catch (err) {
      console.log(
        `[check-phantom-refs] live re-check attempt ${attempt}/3 failed (${err.message})`
      );
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 3000));
  }
  return UNAVAILABLE;
}

const live = await liveSchema();

// 2026-08-21: the outage case. Supabase stopped answering, the live re-check
// timed out, and the gate fell back to the snapshot and failed the build on 42
// rpcs and 4 tables — almost all of which exist. Every PR in the repo was
// blocked by a database blip, on the same day branch protection started
// REQUIRING this check.
//
// The outage exception is intentionally narrow. References already present in
// the comparison tree remain nonblocking because this branch did not create
// their snapshot drift. A table/RPC first called by this branch has no such
// history: an outage means its deployment cannot be proved, so strict mode
// fails it closed. A current fragment or allowlist cannot widen that boundary.
// With no credentials, inherited behavior still follows the snapshot while a
// branch-new caller likewise requires schema-first proof.
if (live === UNAVAILABLE) {
  if (pendingTableProof.size || pendingRpcProof.size) {
    phantomTables.length = 0;
    phantomRpcs.length = 0;
    addMissingEntries(phantomTables, pendingTableProof, fromRefs);
    addMissingEntries(phantomRpcs, pendingRpcProof, rpcRefs);
    console.log('');
    console.log(
      '[check-phantom-refs] Live schema proof is unavailable for a reference introduced on this branch.'
    );
    console.log(
      '    Current-branch manifest fragments and allowlist edits cannot certify their own callers.'
    );
    console.log('    Apply and verify the schema first, then rerun this gate.');
  } else {
    console.log('');
    console.log(
      '[check-phantom-refs] The live schema could not be reached after 3 attempts; every'
    );
    console.log('    unresolved reference was already present in the comparison tree, so this');
    console.log('    outage does not turn inherited snapshot drift into an unrelated failure.');
    for (const { name } of phantomTables) console.log(`      inherited table  ${name}`);
    for (const { name } of phantomRpcs) console.log(`      inherited rpc    ${name}`);
    process.exit(0);
  }
}

if (live) {
  addMissingEntries(
    phantomTables,
    [...pendingTableProof].filter((name) => !live.tables.has(name)),
    fromRefs
  );
  addMissingEntries(
    phantomRpcs,
    [...pendingRpcProof].filter((name) => !live.functions.has(name)),
    rpcRefs
  );
  const stale = [];
  const keepTables = [];
  const keepRpcs = [];
  for (const entry of phantomTables) {
    if (live.tables.has(entry.name)) stale.push(entry.name);
    else keepTables.push(entry);
  }
  for (const entry of phantomRpcs) {
    if (live.functions.has(entry.name)) stale.push(entry.name);
    else keepRpcs.push(entry);
  }
  if (stale.length) {
    console.log('');
    console.log(
      `[check-phantom-refs] ${stale.length} reference(s) are MISSING FROM THE SNAPSHOT but ` +
        `PRESENT IN THE LIVE SCHEMA — the manifest is stale, the code is fine:`
    );
    for (const n of stale) console.log(`    ${n}`);
    console.log('    Refresh it with:  node scripts/ci/gen-schema-manifest.mjs');
    console.log('    (the Schema Manifest Refresh workflow does this daily)');
    phantomTables.length = 0;
    phantomTables.push(...keepTables);
    phantomRpcs.length = 0;
    phantomRpcs.push(...keepRpcs);
    if (phantomTables.length === 0 && phantomRpcs.length === 0) {
      console.log('');
      console.log('OK — every reference resolves against the LIVE schema.');
      process.exit(0);
    }
  }
  if (phantomTables.length === 0 && phantomRpcs.length === 0) {
    console.log('');
    console.log('OK — every branch-new reference resolves against the LIVE schema.');
    process.exit(0);
  }
} else if (live === null) {
  addMissingEntries(phantomTables, pendingTableProof, fromRefs);
  addMissingEntries(phantomRpcs, pendingRpcProof, rpcRefs);
  if (pendingTableProof.size || pendingRpcProof.size) {
    console.log('');
    console.log(
      '[check-phantom-refs] A reference introduced on this branch has no base-schema or live proof.'
    );
    console.log('    Apply and verify the schema before merging its caller.');
  }
}

const printGroup = (title, arr, kind, pendingProof) => {
  if (!arr.length) return;
  console.log('');
  console.log(title);
  for (const { name, sites } of arr) {
    const proofLabel = pendingProof.has(name) ? ' [BRANCH-NEW: LIVE PROOF REQUIRED]' : '';
    console.log(`  ${name}${proofLabel}`);
    for (const s of sites) console.log(`    ${s.file}:${s.line}`);
  }
  console.log('');
  console.log(`Fix a phantom ${kind}:`);
  console.log(`  1. It SHOULD exist -> add the migration and regenerate the manifest.`);
  console.log(`  2. The name is wrong -> correct it to the real ${kind}.`);
  if ([...pendingProof].some((name) => arr.some((entry) => entry.name === name))) {
    console.log('  3. Branch-new references cannot be allowlisted or fragment-certified;');
    console.log('     publish and verify the schema before merging the caller.');
  } else {
    console.log(`  3. An inherited intentional unbuilt-feature ref may remain in the`);
    console.log(`     reasoned invariants allowlist.`);
  }
};

printGroup(
  'PHANTOM TABLES DETECTED (.from() → missing table/view):',
  phantomTables,
  'table',
  pendingTableProof
);
printGroup(
  'PHANTOM RPCS DETECTED (.rpc() → missing function):',
  phantomRpcs,
  'rpc',
  pendingRpcProof
);

if (WARN_ONLY) {
  console.log('[--warn] exiting 0 despite phantoms.');
  process.exit(0);
}
process.exit(1);
