#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ENGINE SHIPS ONLY WITH ITS DOORS (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Twice in two days a build went live calling a database function that
 * production did not have, and each time the failure was a silent loop:
 *
 *   2026-09-10  fn_move_tournament_player (7 args) - the engine half of PR
 *               #3716 deployed at the 20:55 break; the database half was never
 *               applied. Every tournament seat move failed, the lease loop
 *               starved, and the fleet wound down each hour
 *               (20260910051125_the_seat_move_door_the_engine_calls_exists).
 *   2026-09-11  fn_ca_reprice_unpaid_tournament_place - called by the engine's
 *               prize recalculation since #4066/#4105 and defined only in the
 *               unapplied M6 cutover 20260910000905. Any event whose prizes
 *               needed recertifying could never finish
 *               (20260911090347_the_prize_reprice_door_the_engine_calls_exists).
 *
 * The phantom-reference gate (check-phantom-tables.mjs) could not see either:
 * it checks names against a manifest that a branch may extend with a fragment
 * declaring the function it is about to create, and nothing checks that the
 * creation ever happened before the code that calls it goes live.
 *
 * So the deploy asks the one witness that cannot be declared into existence:
 * production's pg_proc, read immediately before the break gate. Every
 * `.rpc('<name>')` in server/src (tests excluded), and every literal assigned
 * to an `...rpcName` variable, must name a function in schema public. A
 * missing one fails the run before the SHA is handed to the durable Hetzner
 * intake. The build is not safe to ship until its migration is applied; it
 * can be dispatched again after the database has caught up.
 *
 * Deliberately NOT a blocker:
 *   - an unreadable database (no DATABASE_URL, pg missing, network): a
 *     warning. This guard exists for one class of defect; it must never be
 *     the reason an urgent fix cannot ship because a connection blinked.
 *   - a rollback (ROLLBACK_REQUESTED=true): a warning. A rollback restores a
 *     build production already ran, and an emergency must not wait on this.
 *   - a name in scripts/ci/engine-doors.allowlist.json, each with a reason.
 *
 * Usage:  node scripts/ci/check-engine-doors-exist.mjs
 * Exit:   0 all present / unreadable / rollback,  1 a door is missing
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SCAN_ROOT = join(ROOT, 'server', 'src');
const ALLOWLIST = join(ROOT, 'scripts', 'ci', 'engine-doors.allowlist.json');

/** Removes // and /* *\/ comments so a JSDoc example is not a call site. */
export function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const RPC_CALL = /\.rpc\(\s*(['"`])([A-Za-z_][A-Za-z0-9_]*)\1/g;
const RPC_NAME_ASSIGNMENT = /\b\w*[Rr]pc[Nn]ame\w*\s*=\s*([^;\n]+)/g;
// A literal compared against (`kind === 'mini' ? ...`) is a condition, not a
// door; only the literals the variable can take are.
const QUOTED_IDENT = /(?<![=!]==?\s*)(['"`])([A-Za-z_][A-Za-z0-9_]*)\1/g;

/** The database function names one source file calls. */
export function doorsIn(source) {
  const src = stripComments(source);
  const names = new Set();
  for (const m of src.matchAll(RPC_CALL)) names.add(m[2]);
  for (const m of src.matchAll(RPC_NAME_ASSIGNMENT)) {
    for (const q of m[1].matchAll(QUOTED_IDENT)) names.add(q[2]);
  }
  return names;
}

function isTestFile(path) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /[\\/]__tests__[\\/]/.test(path);
}

/** name -> the engine files that call it. */
export function engineDoors(root = SCAN_ROOT) {
  const doors = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const path = join(dir, entry);
      const st = statSync(path);
      if (st.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.[cm]?[jt]s$/.test(entry) || isTestFile(path)) continue;
      for (const name of doorsIn(readFileSync(path, 'utf8'))) {
        const files = doors.get(name) ?? [];
        files.push(relative(ROOT, path));
        doors.set(name, files);
      }
    }
  };
  walk(root);
  return doors;
}

async function liveFunctions(names) {
  // Test seam: a JSON array of the function names "production" has, so the
  // law test can run the real script end to end without a database.
  const fixture = process.env.ENGINE_DOORS_LIVE_FIXTURE;
  if (fixture) return { found: new Set(JSON.parse(readFileSync(fixture, 'utf8'))) };
  const url = process.env.DATABASE_URL;
  if (!url) return { unreadable: 'DATABASE_URL is not set' };
  let Client;
  try {
    ({ Client } = (await import('pg')).default ?? (await import('pg')));
  } catch {
    return { unreadable: 'the pg client is not installed' };
  }
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 15000,
    statement_timeout: 15000,
  });
  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT DISTINCT p.proname
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
      [names]
    );
    return { found: new Set(rows.map((r) => r.proname)) };
  } catch (err) {
    return { unreadable: `production could not be asked: ${err?.message || err}` };
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const doors = engineDoors();
  const names = [...doors.keys()].sort();
  const allow = existsSync(ALLOWLIST) ? JSON.parse(readFileSync(ALLOWLIST, 'utf8')) : {};
  const rollback = process.env.ROLLBACK_REQUESTED === 'true';
  const live = await liveFunctions(names);
  if (live.unreadable) {
    console.log(
      `::warning title=DATABASE DOORS UNCHECKED::${live.unreadable}. The ${names.length} functions this build calls were not verified against production.`
    );
    return 0;
  }
  const missing = names.filter((n) => !live.found.has(n) && !allow[n]);
  if (missing.length === 0) {
    console.log(`OK - all ${names.length} database functions this build calls exist in production.`);
    return 0;
  }
  const level = rollback ? 'warning' : 'error';
  for (const name of missing) {
    console.log(
      `::${level} title=MISSING DATABASE DOOR::${name}() is called by ${doors.get(name).join(', ')} and does not exist in production. Apply its migration before this build ships.`
    );
  }
  if (rollback) {
    console.log('Rollback: reported, not blocked. A rollback restores a build production already ran.');
    return 0;
  }
  console.log(
    `${missing.length} of ${names.length} database functions this build calls are missing in production. Nothing was deployed.`
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.log(`::warning title=DATABASE DOORS UNCHECKED::${err?.message || err}`);
      process.exit(0);
    }
  );
}
