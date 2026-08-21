#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ROUTE TARGET GATE — navigate() to a path no <Route> declares
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Third sibling to check-phantom-tables.mjs and check-bus-wiring.mjs. Those
 * catch a query pointing at nothing and a listener hearing nothing; this one
 * catches a navigation landing nowhere.
 *
 * WHY THIS EXISTS
 *
 * On 2026-08-20 the tournament result card was found to have NEVER rendered.
 * TablePage sent the result in router state to `/clubs/:clubId` and the only
 * component reading that state was ClubLobby, which is `/clubs/:clubId/lobby`.
 * Both paths exist, so a route check alone would not have caught that one —
 * but the same investigation showed how easily a target and a reader drift
 * apart, and a navigate() to a path with no <Route> at all is the loud version
 * of the same mistake: React Router renders nothing and the player is left on
 * a blank screen with no error anywhere.
 *
 * DETECTION
 *
 * Parses every `path="..."` out of App.tsx into matchers (`:param` becomes a
 * segment wildcard, `*` becomes a suffix wildcard), then checks every literal
 * `navigate('/...')` in the client against them. Template literals are checked
 * up to their first `${`, so `/clubs/${id}` is validated as `/clubs/<param>`.
 *
 * Dynamic targets built entirely from a variable (`navigate(dest)`) cannot be
 * checked and are skipped rather than guessed at.
 *
 * USAGE
 *   node scripts/ci/check-route-targets.mjs          # strict (exit 1)
 *   node scripts/ci/check-route-targets.mjs --warn   # advisory (always exit 0)
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const APP = 'src/App.tsx';
const ROOT = 'src';
const ALLOWLIST_PATH = 'scripts/ci/route-targets.allowlist.json';
const WARN_ONLY = process.argv.includes('--warn');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

// ── 1. Declared routes ──────────────────────────────────────────────────────
const app = readFileSync(APP, 'utf8');
const declared = [...app.matchAll(/path="([^"]+)"/g)].map((m) => m[1]);

/** "clubs/:clubId/lobby" -> /^clubs\/[^/]+\/lobby$/ */
function toMatcher(path) {
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '' || clean === '*') return /^.*$/;
  const body = clean
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) return '[^/]+';
      if (seg === '*') return '.*';
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${body}$`);
}
const matchers = declared.map(toMatcher);

// ── 2. navigate() targets ───────────────────────────────────────────────────
// Literal or template up to the first interpolation. `/a/${x}` -> `/a/<param>`.
const NAV = /navigate\(\s*(['"`])(\/[^'"`]*?)\1|navigate\(\s*`(\/[^`]*)`/g;

const targets = new Map(); // path -> [{file,line}]
for (const file of walk(ROOT)) {
  const text = readFileSync(file, 'utf8');
  const lineAt = (idx) => text.slice(0, idx).split('\n').length;
  for (const m of text.matchAll(NAV)) {
    let raw = m[2] ?? m[3] ?? '';
    // Strip query/hash, then replace every ${...} segment with a placeholder.
    raw = raw.split('?')[0].split('#')[0];
    const path = raw.replace(/\$\{[^}]*\}/g, '<param>');
    if (!path.startsWith('/')) continue;
    if (!targets.has(path)) targets.set(path, []);
    targets.get(path).push({ file: relative(process.cwd(), file), line: lineAt(m.index) });
  }
}

let allow = {};
try {
  allow = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
} catch {
  /* no allowlist yet */
}
const allowed = new Set(Object.keys(allow).filter((k) => !k.startsWith('_')));

function matches(path) {
  const clean = path.replace(/^\/+|\/+$/g, '').replace(/<param>/g, 'x');
  if (clean === '') return true; // "/" is the index route
  return matchers.some((r) => r.test(clean));
}

const broken = [...targets.keys()].filter((p) => !matches(p) && !allowed.has(p)).sort();

console.log(
  `[check-route-targets] ${declared.length} declared routes, ${targets.size} navigate() targets · allowlisted: ${allowed.size}`
);

if (broken.length === 0) {
  console.log('[check-route-targets] OK — every navigate() target matches a declared route.');
  process.exit(0);
}

console.log(`\nUNROUTED NAVIGATION TARGETS (${broken.length}):\n`);
for (const path of broken) {
  console.log(`  ${path}`);
  for (const { file, line } of targets.get(path)) console.log(`    ${file}:${line}`);
}
console.log(`
Fix an unrouted target:
  1. The page SHOULD exist -> add the <Route> in ${APP}.
  2. The path is wrong -> correct it to the route that exists.
  3. It is handled outside this router (the Hub owns it, a full page load)
     -> add it, WITH A REASON, to ${ALLOWLIST_PATH}.
`);

process.exit(WARN_ONLY ? 0 : 1);
