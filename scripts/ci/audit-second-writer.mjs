#!/usr/bin/env node
/**
 * THE SECOND WRITER IS AUDITED AGAINST THE REGISTER.
 *
 * Phase 7 of the chip-accounting programme, roadmap 9.6 (2026-09-07):
 *
 *   "Phase 5 registered every money door in the database. The World Hub
 *    carries its own money routes under pages/api/club-arena/, in another
 *    repo, and nothing has ever been checked against that register. A door
 *    is only closed if both repos agree it is closed."
 *
 * This is the check. It reads every route under the World Hub's
 * pages/api/club-arena/, pulls out each `.rpc('name', { ...literal })` call
 * with the PARAMETER NAMES the route sends, and every direct write to a money
 * table, and asks production - fn_ca_second_writer_check(jsonb), which reads
 * pg_proc and ca_money_rpc_registry - whether each call still agrees with the
 * database:
 *
 *   missing_function                  the door does not exist (PGRST202)
 *   closed_door                       the register closed it; the route still calls it
 *   not_executable_by_service_role    "permission denied" on every call
 *   signature_mismatch                no overload accepts these parameter NAMES -
 *                                     PostgREST resolves by name, so this is a
 *                                     404 and whatever the route does next is
 *                                     the only thing that has ever run
 *   unregistered_writer   (warning)   the door writes balance columns and is
 *                                     not in the register
 *
 * and, from the source alone:
 *
 *   direct_balance_write              the route updates or inserts a balance
 *                                     column on a money table itself, through
 *                                     PostgREST, with no door at all
 *
 * The first run (2026-09-07) found two routes calling doors closed on
 * 2026-09-04 and one route whose RPC call had never once matched a live
 * signature, so its JS-arithmetic "fallback" was the only path that had ever
 * run. None of it was visible from either repository on its own.
 *
 * COVERAGE TRAVELS WITH THE ANSWER (CLAUDE.md 10.86). A call whose payload is
 * not an object literal (a variable, a spread) cannot have its names read
 * here; it is reported as UNCHECKED, by file and line, never as fine.
 *
 * Usage:
 *   node scripts/ci/audit-second-writer.mjs --routes <dir>   # the World Hub's pages/api/club-arena
 *   env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Exit 1 on any error-severity finding or any direct balance write; exit 2
 * when it could not ask.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
function argValue(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const ROUTES = argValue('--routes', 'world-hub/pages/api/club-arena');
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('[second-writer] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(2);
}
let files;
try {
  files = readdirSync(ROUTES)
    .filter((f) => f.endsWith('.js') || f.endsWith('.ts'))
    .map((f) => join(ROUTES, f))
    .filter((f) => statSync(f).isFile())
    .sort();
} catch (e) {
  console.error(`[second-writer] cannot read ${ROUTES}: ${e.message}`);
  process.exit(2);
}
if (files.length === 0) {
  // An empty directory is not "no routes to check"; it is a checkout that
  // did not happen. Refuse rather than report a clean sweep of nothing.
  console.error(`[second-writer] ${ROUTES} holds no route files - refusing to call that clean.`);
  process.exit(2);
}

/** Money tables and the columns that are balances, in the register's words. */
const MONEY_TABLES = new Set([
  'club_members', 'club_wallets', 'union_wallets', 'unions', 'table_seats', 'bbj_pools',
  'clubs', 'agents', 'wallets', 'spin_bonus_pools', 'tournament_players',
]);
const BALANCE_COLS =
  /\b(chip_balance|held_chips|locked_chips|credit_used|credit_limit|stack|balance|chips|prize|bounty_winnings|promo_balance|main_balance|backup_balance|treasury_balance|business_balance)\s*:/;

export function scanRoute(source, file) {
  const calls = [];
  const directWrites = [];
  const lineOf = (idx) => source.slice(0, idx).split('\n').length;

  // .rpc('name', { keys }) - the payload must be an object literal to be read.
  const rpcRe = /\.rpc\(\s*['"]([A-Za-z0-9_]+)['"]\s*(?:,\s*(\{[^}]*\}|[A-Za-z_$][\w$.]*))?/gs;
  for (const m of source.matchAll(rpcRe)) {
    const fn = m[1];
    const payload = m[2];
    let keys = null;
    if (payload && payload.startsWith('{')) {
      keys = [];
      const body = payload.slice(1, -1);
      for (let part of body.split(/,(?![^(]*\))/)) {
        part = part.replace(/\/\/.*$/gm, '').trim();
        if (!part) continue;
        if (part.startsWith('...')) { keys = null; break; }
        const km = /^([A-Za-z_$][\w$]*)\s*(:|$)/.exec(part);
        if (!km) { keys = null; break; }
        keys.push(km[1]);
      }
    }
    calls.push({ file, line: lineOf(m.index), fn, keys });
  }

  // .from('money_table') ... .update({...}) / .insert({...}) / .upsert({...})
  // naming a balance column, all inside one statement.
  const fromRe = /\.from\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g;
  for (const m of source.matchAll(fromRe)) {
    const table = m[1];
    if (!MONEY_TABLES.has(table)) continue;
    const end = source.indexOf(';', m.index);
    const seg = source.slice(m.index, end === -1 ? m.index + 800 : end);
    const op = /\.(update|insert|upsert)\(/.exec(seg);
    if (!op) continue;
    if (!BALANCE_COLS.test(seg)) continue;
    directWrites.push({ file, line: lineOf(m.index), table, op: op[1] });
  }
  return { calls, directWrites };
}

const allCalls = [];
const allDirect = [];
for (const f of files) {
  const { calls, directWrites } = scanRoute(readFileSync(f, 'utf8'), basename(f));
  allCalls.push(...calls);
  allDirect.push(...directWrites);
}

const res = await fetch(`${url}/rest/v1/rpc/fn_ca_second_writer_check`, {
  method: 'POST',
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  body: JSON.stringify({ p_calls: allCalls }),
});
if (!res.ok) {
  console.error(`[second-writer] fn_ca_second_writer_check returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  console.error('[second-writer] refusing to treat an unreadable answer as a clean one.');
  process.exit(2);
}
const answer = await res.json();
if (typeof answer?.calls !== 'number' || !Array.isArray(answer?.findings)) {
  console.error('[second-writer] the answer carries no coverage; refusing to read it as clean.');
  process.exit(2);
}
if (answer.calls !== allCalls.length) {
  console.error(`[second-writer] sent ${allCalls.length} calls, the database counted ${answer.calls}.`);
  process.exit(2);
}

const errors = answer.findings.filter((f) => f.severity === 'error');
const warnings = answer.findings.filter((f) => f.severity !== 'error');

console.log(
  `[second-writer] ${files.length} route file(s), ${answer.calls} rpc call(s): ${answer.checked} checked, ` +
    `${answer.unchecked} UNCHECKED (payload not a literal), ${answer.errors} error(s), ${answer.warnings} warning(s), ` +
    `${allDirect.length} direct balance write(s). Register: ${answer.registry?.approved} approved, ${answer.registry?.closed} closed.`
);
const unchecked = allCalls.filter((c) => c.keys === null);
if (unchecked.length) {
  console.log('  unchecked (names could not be read from the source):');
  for (const c of unchecked) console.log(`    ${c.file}:${c.line}  ${c.fn}`);
}
for (const f of [...errors, ...warnings]) {
  console.log(`  ${f.severity.toUpperCase().padEnd(7)} ${f.file}:${f.line}  ${f.fn}  ${f.kind}`);
  console.log(`          ${f.detail}`);
  if (f.sent) console.log(`          sent: (${f.sent.join(', ')})   live: ${f.live}`);
}
for (const d of allDirect) {
  console.log(`  ERROR   ${d.file}:${d.line}  ${d.table}.${d.op}  direct_balance_write`);
  console.log('          the route writes a balance column itself, through PostgREST, with no door. Every chip moves through a registered function.');
}

if (errors.length > 0 || allDirect.length > 0) {
  console.error('');
  console.error('[second-writer] THE SECOND WRITER DISAGREES WITH THE REGISTER. A door is only closed if both repos agree it is closed.');
  process.exit(1);
}
console.log('[second-writer] every call the World Hub makes agrees with the register.');
