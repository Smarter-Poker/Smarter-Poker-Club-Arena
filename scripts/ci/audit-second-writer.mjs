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
 *   not_executable_by_authenticated   the same, for a route that forwards
 *                                     the caller's token instead of holding
 *                                     the service key (see clientRoleOf)
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
 *   node scripts/ci/audit-second-writer.mjs [--routes <dir>]...   # default: world-hub/pages/api, src/lib, lib
 *   Every .js/.ts under each root, recursively. The SECOND WRITER is the whole
 *   World Hub server side, not one directory: the phase 7 deep dive found the
 *   legacy poker engine under src/lib calling two closed doors from outside
 *   pages/api/club-arena.
 *   env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Exit 1 on any error-severity finding or any direct balance write; exit 2
 * when it could not ask.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

import { pathToFileURL } from 'node:url';

/** Every .js/.ts/.mjs file under a directory, recursively, tests excluded. */
export function walkRoutes(dir) {
  const out = [];
  const seen = new Set();
  (function walk(d) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|ts|mjs|cjs)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) && !seen.has(p)) { seen.add(p); out.push(p); }
    }
  })(dir);
  return out.sort();
}

/** Money tables and the columns that are balances, in the register's words. */
const MONEY_TABLES = new Set([
  'club_members', 'club_wallets', 'union_wallets', 'unions', 'table_seats', 'bbj_pools',
  'clubs', 'agents', 'wallets', 'spin_bonus_pools', 'tournament_players',
]);


/** The text between the brace at `open` and its balanced close, skipping
 *  strings and comments; null when the braces never balance. */
function objectBody(src, open) {
  let depth = 0;
  let quote = null;
  for (let j = open; j < src.length; j++) {
    const ch = src[j];
    if (quote) {
      if (ch === '\\') { j++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '/' && src[j + 1] === '/') { const e = src.indexOf('\n', j); j = e === -1 ? src.length : e; continue; }
    if (ch === '/' && src[j + 1] === '*') { const e = src.indexOf('*/', j); j = e === -1 ? src.length : e + 1; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') { depth--; if (depth === 0) return src.slice(open + 1, j); }
  }
  return null;
}

/** The top-level keys of an object literal's body; null when any entry is not
 *  a plain `key:` / shorthand `key` (a spread, a computed key). */
function topLevelKeys(body) {
  // comments first, so a comma inside one cannot split an entry
  body = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const parts = [];
  let part = '';
  let depth = 0;
  let quote = null;
  for (let k = 0; k < body.length; k++) {
    const ch = body[k];
    if (quote) { part += ch; if (ch === '\\') { part += body[++k] ?? ''; continue; } if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; part += ch; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    if (ch === '}' || ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { parts.push(part); part = ''; continue; }
    part += ch;
  }
  parts.push(part);
  const keys = [];
  for (let raw of parts) {
    raw = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!raw) continue;
    if (raw.startsWith('...')) return null;
    const km = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*(:|$)/.exec(raw);
    if (!km) return null;
    keys.push(km[1] || km[2] || km[3]);
  }
  return keys;
}

/**
 * WHICH ROLE A CALL ACTUALLY RUNS AS.
 *
 * Every verdict about EXECUTE used to be asked of `service_role`, because the
 * World Hub's API routes are server side and almost all of them hold the
 * service key. Five of them do not. They build a client from the ANON key and
 * forward the caller's `Authorization` header, so the RPC runs as
 * `authenticated` and the function reads `auth.uid()` to know who is asking.
 *
 * MEASURED 2026-09-19, and it is wrong in both directions:
 *
 *   FALSE POSITIVE. `pages/api/store/diamond-transfer.js` calls
 *     `send_wallet_diamond_transfer`, granted to `authenticated` and
 *     deliberately not to `service_role` (its first statement is
 *     `auth.uid()`). The audit called it "permission denied on every call"
 *     and had been red on it alone, keeping Schema Integrity Audit red.
 *
 *   FALSE NEGATIVE, which is the one that matters. `mint-chips.js` calls
 *     `fn_mint_chips_from_diamonds` and `live/gift.js` calls
 *     `send_stream_gift`, both approved money doors, both user scoped. The
 *     grant that has to hold for those routes to work is `authenticated`, and
 *     nothing was ever asking about it. Revoking it would have broken the
 *     mint with the audit still green.
 *
 * Unresolvable receivers return null and the check falls back to
 * `service_role`, which is the behaviour every other call already had.
 */
export function clientRoleOf(source, receiver) {
  if (!receiver) return null;
  const decl = new RegExp(
    `(?:const|let|var)\\s+${receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(?:await\\s+)?[A-Za-z_$][\\w$]*\\s*\\(`
  );
  const m = decl.exec(source);
  if (!m) return null;
  // The whole argument list, read with balanced brackets. A fixed-size window
  // would cut a multi-line client construction in half, and
  // tests/unit/noFixedSizeSourceWindows.test.ts forbids one anyway.
  const args = objectBody(source, m.index + m[0].length - 1);
  if (args === null) return null;
  if (/SERVICE_ROLE|serviceRole/i.test(args)) return 'service_role';
  if (/ANON_KEY|anonKey/i.test(args) && /Authorization/i.test(args)) return 'authenticated';
  return null;
}

export function scanRoute(source, file) {
  const calls = [];
  const directWrites = [];
  const lineOf = (idx) => source.slice(0, idx).split('\n').length;

  // .rpc('name', { keys }) - the payload must be an object literal to be read.
  // The object is walked with balanced braces, and only its TOP-LEVEL keys are
  // taken: a nested `p_details: { hand, equity }` used to leak `hand` and
  // `equity` into the key list and report a correct call as a mismatch (found
  // by the phase 7 deep dive, 2026-09-07, on LobbyManager.js).
  const rpcRe = /\.rpc\(\s*['"]([A-Za-z0-9_]+)['"]\s*(,\s*)?/g;
  for (const m of source.matchAll(rpcRe)) {
    const fn = m[1];
    let keys = null;
    const i = m.index + m[0].length;
    if (m[2] && source[i] === '{') {
      const body = objectBody(source, i);
      keys = body === null ? null : topLevelKeys(body);
    }
    // `second-writer-exempt: <reason>` on the call or the line above it:
    // a deliberate disagreement, written down. Reported, never counted as fine.
    const line = lineOf(m.index);
    const above = source.split('\n').slice(Math.max(0, line - 2), line).join('\n');
    const ex = /second-writer-exempt:\s*([^\n*]+)/.exec(above);
    // The receiver is whatever identifier the call was made on. Read backwards
    // from the match rather than folded into the rpc pattern above, because
    // widening that pattern is how a call stops being seen at all.
    const recv = /([A-Za-z_$][\w$]*)\s*$/.exec(source.slice(0, m.index));
    calls.push({
      file,
      line,
      fn,
      keys,
      role: clientRoleOf(source, recv ? recv[1] : null),
      exempt: ex ? ex[1].trim() : null,
    });
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
    // A balance column named in the payload. On an insert/upsert, a literal
    // zero is provisioning (the table defaults it anyway) and is not counted;
    // anything else - a value, an expression, an update - is a movement with
    // no door.
    const named = [...seg.matchAll(/\b(chip_balance|held_chips|locked_chips|credit_used|credit_limit|stack|balance|chips|prize|bounty_winnings|promo_balance|main_balance|backup_balance|treasury_balance|business_balance)\s*:\s*([^,}\n]+)/g)];
    const moving = named.filter((n) => !(op[1] !== 'update' && /^0(\.0+)?$/.test(n[2].trim())));
    if (moving.length === 0) continue;
    directWrites.push({ file, line: lineOf(m.index), table, op: op[1], columns: moving.map((n) => n[1]) });
  }
  return { calls, directWrites };
}

async function main() {
  const args = process.argv.slice(2);
  const roots = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--routes' && args[i + 1]) roots.push(args[++i]);
  if (roots.length === 0) roots.push('world-hub/pages/api', 'world-hub/src/lib', 'world-hub/lib');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('[second-writer] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
    process.exit(2);
  }
  const files = roots.flatMap((r) => walkRoutes(r));
  if (files.length === 0) {
    // An empty tree is not "no routes to check"; it is a checkout that did
    // not happen. Refuse rather than report a clean sweep of nothing.
    console.error(`[second-writer] ${roots.join(', ')} holds no route files - refusing to call that clean.`);
    process.exit(2);
  }

  const allCalls = [];
  const allDirect = [];
  for (const f of files) {
    const rel = f.replace(/^.*?world-hub\//, '');
    const { calls, directWrites } = scanRoute(readFileSync(f, 'utf8'), rel);
    allCalls.push(...calls);
    allDirect.push(...directWrites);
  }
  const exempt = allCalls.filter((c) => c.exempt);
  const sent = allCalls
    .filter((c) => !c.exempt)
    .map(({ file, line, fn, keys, role }) => ({ file, line, fn, keys, role }));

  const res = await fetch(`${url}/rest/v1/rpc/fn_ca_second_writer_check`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-smarter-data-actor': 'service',
      'x-smarter-data-protocol': '1',
    },
    body: JSON.stringify({ p_calls: sent }),
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
  if (answer.calls !== sent.length) {
    console.error(`[second-writer] sent ${sent.length} calls, the database counted ${answer.calls}.`);
    process.exit(2);
  }

  const errors = answer.findings.filter((f) => f.severity === 'error');
  const warnings = answer.findings.filter((f) => f.severity !== 'error');

  console.log(
    `[second-writer] ${files.length} file(s) under ${roots.join(', ')}; ${allCalls.length} rpc call(s): ${answer.checked} checked, ` +
      `${answer.unchecked} UNCHECKED (payload not a literal), ${exempt.length} exempt by annotation, ` +
      `${answer.errors} error(s) on money doors, ${answer.warnings} warning(s), ${allDirect.length} direct balance write(s). ` +
      `Register: ${answer.registry?.approved} approved, ${answer.registry?.closed} closed.`
  );
  const unchecked = sent.filter((c) => c.keys === null);
  if (unchecked.length) {
    console.log('  unchecked (names could not be read from the source):');
    for (const c of unchecked) console.log(`    ${c.file}:${c.line}  ${c.fn}`);
  }
  if (exempt.length) {
    console.log('  exempt (a written reason on the call; still a disagreement):');
    for (const c of exempt) console.log(`    ${c.file}:${c.line}  ${c.fn}  - ${c.exempt}`);
  }
  for (const f of [...errors, ...warnings]) {
    console.log(`  ${f.severity.toUpperCase().padEnd(7)} ${f.file}:${f.line}  ${f.fn}  ${f.kind}${f.money ? '' : '  (not a money door)'}`);
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
  console.log('[second-writer] every money door the World Hub calls agrees with the register.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
