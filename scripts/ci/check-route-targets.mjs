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

/**
 * "clubs/:clubId/lobby" -> /^clubs\/[^/]+\/lobby$/
 *
 * Returns null for a route that must NOT count as a match. There are two, and
 * between them they made this gate VACUOUS until 2026-09-05:
 *
 *   path="*"  is the NotFound catch-all. React Router does match it, and that
 *             is exactly WHY the failure this gate exists to catch is silent -
 *             the player lands on NotFound instead of the surface the button
 *             promised. Counting it as a match means the gate can never fail.
 *   path="/"  reduced to `clean === ''` and fell into the SAME `/^.*$/` branch,
 *             so the index route also matched every path in the app.
 *
 * Proven on this tree before the fix: a planted
 * `navigate('/this-route-does-not-exist-anywhere-xyz')` was reported OK and the
 * gate exited 0. It had been unable to fail since `path="*"` was added.
 *
 * The index route is still honoured - `matches()` answers true for the empty
 * path directly, which is "/" and nothing else.
 */
function toMatcher(path) {
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '' || clean === '*') return null;
  const body = clean
    .split('/')
    .map((seg, index) => {
      const separator = index === 0 ? '' : '/';
      if (seg.startsWith(':')) {
        return seg.endsWith('?')
          ? `(?:${separator}[^/]+)?`
          : `${separator}[^/]+`;
      }
      // A NESTED splat ("legal/*") is a real prefix route and stays a matcher.
      if (seg === '*') return `${separator}.*`;
      return `${separator}${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    })
    .join('');
  return new RegExp(`^${body}$`);
}
const matchers = declared.map(toMatcher).filter(Boolean);

// ── 2. Every clickable target ───────────────────────────────────────────────
// Literal or template up to the first interpolation. `/a/${x}` -> `/a/<param>`.
//
// A <Link to> is exactly as clickable as a navigate(), lands the player on the
// same NotFound when it is wrong, and was NOT checked here until 2026-09-05 -
// 30 of them (24 Link, 6 NavLink) went past this gate every run.
const NAV = /navigate\(\s*(['"`])(\/[^'"`]*?)\1|navigate\(\s*`(\/[^`]*)`/g;
const LINK = /<(?:Link|NavLink)\b[^>]*?\bto=(?:(['"])(\/[^'"]*?)\1|\{\s*`(\/[^`]*)`)/g;
// An <a href="/..."> is a FULL page load. The app mounts under
// basename="/hub/club-arena" (src/main.tsx), so a bare "/clubs/x" href leaves
// the SPA and asks the origin for a path it does not serve. Both
// ClubFinancialDashboard and CashierPage carry comments about having been bitten
// by precisely this, so it is a known house bug shape and gets its own list.
const HREF = /href=(?:(['"])(\/[^'"]*?)\1|\{\s*`(\/[^`]*)`)/g;

/** Paths the Hub owns. The SPA cannot route them and is not meant to. */
const isHubOwned = (p) => p.startsWith('/hub/') && !p.startsWith('/hub/club-arena');

const targets = new Map(); // path -> [{file,line,kind}]
const basenameEscapes = new Map(); // path -> [{file,line}]

const cleanPath = (raw) =>
  raw.split('?')[0].split('#')[0].replace(/\$\{[^}]*\}/g, '<param>');

/**
 * Blank out comments, preserving every byte position and newline so the line
 * numbers this gate reports still point at the real line.
 *
 * This is not tidiness. On 2026-09-05, the first run of the widened gate
 * reported six failures and ALL SIX were comment prose - `navigate('/hub/...')`
 * and `<a href="/clubs/...">` quoted inside the block comments that record
 * those exact bugs being FIXED. A gate that fails on the changelog of its own
 * bug gets allowlisted by the next agent, and then it is vacuous a second way.
 * Comments describe code that is gone; only live code can strand a player.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code'; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; } else out += ' ';
      i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? c : ' ';
      i += 1; continue;
    }
    // inside a string: copy through, honouring escapes, and close on the quote
    if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code';
    }
    out += c; i += 1;
  }
  return out;
}

for (const file of walk(ROOT)) {
  const source = readFileSync(file, 'utf8');
  const text = stripComments(source);
  const lineAt = (idx) => text.slice(0, idx).split('\n').length;
  const record = (path, idx, kind) => {
    if (!targets.has(path)) targets.set(path, []);
    targets.get(path).push({ file: relative(process.cwd(), file), line: lineAt(idx), kind });
  };

  for (const m of text.matchAll(NAV)) {
    const path = cleanPath(m[2] ?? m[3] ?? '');
    if (path.startsWith('/')) record(path, m.index, 'navigate');
  }
  for (const m of text.matchAll(LINK)) {
    const path = cleanPath(m[2] ?? m[3] ?? '');
    if (path.startsWith('/')) record(path, m.index, 'Link');
  }
  for (const m of text.matchAll(HREF)) {
    const path = cleanPath(m[2] ?? m[3] ?? '');
    if (!path.startsWith('/')) continue;
    if (isHubOwned(path)) continue; // the Hub serves it; leaving the SPA is the point
    // Anything else reachable by this router should be a <Link>, not an <a>.
    if (!basenameEscapes.has(path)) basenameEscapes.set(path, []);
    basenameEscapes.get(path).push({ file: relative(process.cwd(), file), line: lineAt(m.index) });
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
const escapes = [...basenameEscapes.keys()].filter((p) => !allowed.has(p)).sort();

const byKind = (k) =>
  [...targets.values()].flat().filter((t) => t.kind === k).length;

console.log(
  `[check-route-targets] ${declared.length} declared routes · ` +
    `${byKind('navigate')} navigate() + ${byKind('Link')} <Link>/<NavLink> targets ` +
    `(${targets.size} distinct paths) · allowlisted: ${allowed.size}`
);

if (escapes.length > 0) {
  console.log(`\nHREF THAT LEAVES THE ROUTER (${escapes.length}):\n`);
  for (const path of escapes) {
    console.log(`  ${path}`);
    for (const { file, line } of basenameEscapes.get(path)) console.log(`    ${file}:${line}`);
  }
  console.log(`
The app mounts at basename="/hub/club-arena" (src/main.tsx). A plain
<a href="/x"> is a full page load to the ORIGIN's /x, which does not exist -
the player gets a 404 from the server, not a route from this router.
  Fix: use <Link to="/x"> so the basename is applied, or, if the Hub really
  owns the destination, address it as /hub/<page> and it is skipped here.`);
}

if (broken.length === 0 && escapes.length === 0) {
  console.log('[check-route-targets] OK — every clickable target matches a declared route.');
  process.exit(0);
}

if (broken.length === 0) {
  if (WARN_ONLY) process.exit(0);
  process.exit(1);
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
