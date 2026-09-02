#!/usr/bin/env node
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  EMBED RELATIONSHIP CHECK — every PostgREST embed must actually resolve
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 *
 * A supabase-js `select()` that embeds a related table — `profiles(username)`,
 * `tables:table_id(name)` — needs a real FOREIGN KEY in the database. Without
 * one PostgREST answers **400 PGRST200** and returns no rows at all. Not a
 * partial result: the whole query fails.
 *
 * Nothing in this codebase notices, because every call site handles the error
 * the same way — `if (error) return []`, `if (!error && data)`, a rejected
 * promise inside `Promise.allSettled`. An empty list is indistinguishable from
 * "there is nothing to show", so the feature is simply blank, forever, for
 * everyone, and no alert fires.
 *
 * On 2026-08-22 a sweep of all 37 embeds in src/ found SEVEN broken this way,
 * some for as long as they had existed:
 *
 *   - the admin seat list for every table          (table_seats -> profiles)
 *   - friend suggestions from recent opponents     (table_seats -> profiles)
 *   - every cashout detail view                    (cashout_requests -> agent_id)
 *   - the blocked-players list, AND unblocking     (user_blocks -> blocked_id)
 *   - hand replay                                  (hand_history -> tables)
 *   - transaction history                          (chip_transactions -> clubs)
 *   - achievements and claimed promotions          (fixed 2026-08-20)
 *
 * This is the only bug class in this repo that is 100% mechanically detectable,
 * so it is checked mechanically.
 *
 * HOW IT WORKS
 *
 * Every embed is replayed against the live database with `limit=0`, sending the
 * select string **exactly as @supabase/postgrest-js sends it** (all whitespace
 * outside double quotes stripped — PostgrestQueryBuilder.ts). Replicating that
 * is not optional: collapsing whitespace to single spaces instead produced 17
 * false positives, and leaving the raw source newlines in produced 6 false
 * negatives. Only the exact transform gives the true answer.
 *
 *   400  -> the query is malformed against the real schema. FAIL.
 *   401/403 -> RLS or column grants. The SHAPE is valid; that is all we test.
 *   2xx  -> fine.
 *
 * With no credentials (a fork, a local run) it skips, exactly like
 * check-phantom-tables.mjs.
 *
 * FIXING A FAILURE — check the consumer first, and do not reach for a migration
 * by reflex:
 *   - the embedded data is never read      -> delete the embed (this was the
 *                                             right fix for promotion_claims)
 *   - the relationship is real and enforced -> add the FK
 *   - the child deliberately OUTLIVES the parent -> do NOT add an FK. It would
 *     assert an invariant the schema does not hold, and ON DELETE CASCADE would
 *     destroy data. hand_history (10 GB, rows outlive their `tables` row) is
 *     exactly this case — resolved with a second lookup instead.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const SRC = 'src';
const EXTS = new Set(['.ts', '.tsx']);

/** Selects that cannot be replayed verbatim, with the reason. */
const skipped = [];

// ─── 1. Collect (table, select) pairs ────────────────────────────────────────

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.has(extname(p))) out.push(p);
  }
  return out;
}

/**
 * Pair each `.from('x')` with its OWN `.select(...)`.
 *
 * The naive "next .select() within N characters" pairs `.from('tables')
 * .update(...)` with a completely unrelated select further down the file, which
 * invents failures that are not real. So the search stops at the first token
 * that proves the select belongs to someone else.
 */
function extractEmbeds(file) {
  const src = readFileSync(file, 'utf8');
  const found = [];
  const fromRe = /\.from\(\s*['"`]([a-zA-Z0-9_]+)['"`]\s*\)/g;
  let m;
  while ((m = fromRe.exec(src))) {
    const table = m[1];
    const rest = src.slice(m.index + m[0].length);

    const selectAt = rest.search(/\.select\(\s*['"`]/);
    if (selectAt === -1) continue;

    // Anything of these before the select means the select is not ours.
    const boundary = rest.search(/\.(from|update|delete|insert|upsert|rpc)\(/);
    if (boundary !== -1 && boundary < selectAt) continue;

    const sm = /\.select\(\s*(['"`])([\s\S]*?)\1/.exec(rest.slice(selectAt));
    if (!sm) continue;
    const raw = sm[2];
    if (!raw.includes('(')) continue; // no embed, nothing to resolve

    const line = src.slice(0, m.index).split('\n').length;
    if (raw.includes('${')) {
      skipped.push({ file, line, table, why: 'interpolated select' });
      continue;
    }
    found.push({ file, line, table, select: raw });
  }
  return found;
}

// ─── 2. Send it the way postgrest-js sends it ────────────────────────────────

/** Verbatim port of @supabase/postgrest-js PostgrestQueryBuilder.select(). */
function stripWhitespaceOutsideQuotes(columns) {
  let quoted = false;
  return columns
    .split('')
    .map((c) => {
      if (/\s/.test(c) && !quoted) return '';
      if (c === '"') quoted = !quoted;
      return c;
    })
    .join('');
}

// ─── 3. Run ──────────────────────────────────────────────────────────────────

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const all = walk(SRC).flatMap(extractEmbeds);
const seen = new Set();
const cases = all.filter((c) => {
  const k = `${c.table}|${c.select}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

console.log(`[check-embeds] ${cases.length} distinct embedded selects in ${SRC}/`);
if (skipped.length) {
  console.log(`[check-embeds] ${skipped.length} skipped (cannot be replayed verbatim):`);
  for (const s of skipped) console.log(`    ${s.file}:${s.line}  ${s.table}  — ${s.why}`);
}

if (!url || !key) {
  console.log('[check-embeds] no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — skipping.');
  process.exit(0);
}

const broken = [];
const unverified = [];
let unreachable = 0;

/** `limit=0` returns no rows, so each probe is cheap — but 34 of them in
 *  sequence is still ~40s of pure latency on a job everybody waits for. Six at
 *  a time keeps it well inside the API's rate limit and finishes in seconds. */
const CONCURRENCY = 6;

async function probe(c) {
  const sel = stripWhitespaceOutsideQuotes(c.select);
  const target = `${url}/rest/v1/${c.table}?select=${encodeURIComponent(sel)}&limit=0`;
  /* 45s and a retry, because this database is not always quiet. Measured
     2026-08-22 while it was under load: a single `limit=0` probe on
     table_seats took 17.2s (GET) and 19.6s (HEAD). A gate that reddens
     somebody else's unrelated commit because the DB was busy is worse than no
     gate — that is exactly what had to be fixed in check-phantom-tables.

     Note that a BROKEN select answers in ~150-360ms: PostgREST rejects it from
     its schema cache before touching the database. The slow case is the
     healthy one, so this budget is spent almost entirely on passes. */
  let res;
  for (let attempt = 1; attempt <= 2 && !res; attempt++) {
    try {
      res = await fetch(target, {
        headers: supabaseServerHeaders(key),
        signal: AbortSignal.timeout(45000),
      });
    } catch (err) {
      if (attempt === 2) {
        console.log(`[check-embeds] could not reach the API for ${c.table} (${err.message})`);
        unreachable++;
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!res) return;
  /* 401/403 means PostgREST rejected us on the ROLE before it ever parsed the
     select, so nothing was validated. Counting that as a pass is the exact
     silent-skip this gate exists to end — a run against the anon key would
     report "every embed resolves" while checking nothing behind RLS, which is
     most of them. Service role bypasses RLS, so with the right credential this
     list is always empty. */
  if (res.status === 401 || res.status === 403) {
    unverified.push({ ...c, status: res.status });
    return;
  }
  if (res.status !== 400) return;
  let body = {};
  try {
    body = JSON.parse(await res.text());
  } catch {
    /* keep the empty object */
  }
  broken.push({ ...c, sel, code: body.code, message: body.message, hint: body.hint });
}

const queue = [...cases];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await probe(next);
  })
);

// Stable output regardless of which worker happened to finish first.
const byLocation = (a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`);
broken.sort(byLocation);
unverified.sort(byLocation);

if (unreachable) {
  console.log('');
  console.log(`[check-embeds] WARNING: ${unreachable} of ${cases.length} select(s) could not be`);
  console.log('  checked — the API did not answer. Those embeds are UNVERIFIED by this run.');
  console.log('  Not failing the build for it: a busy database must not red somebody');
  console.log("  else's commit. If this number is not small, the gate is not doing its job.");
}

if (unverified.length) {
  console.log('');
  console.log(`[check-embeds] ${unverified.length} select(s) were NOT CHECKED — the API`);
  console.log('  answered 401/403, which means it rejected the ROLE before parsing the');
  console.log('  select. SUPABASE_SERVICE_ROLE_KEY bypasses RLS; an anon or publishable');
  console.log('  key does not, and would let this gate report success while validating');
  console.log('  nothing. Supply the service-role key.');
  for (const u of unverified.slice(0, 12)) {
    console.log(`    ${u.status}  ${u.table}  (${u.file}:${u.line})`);
  }
  if (unverified.length > 12) console.log(`    …and ${unverified.length - 12} more`);
  process.exit(1);
}

if (!broken.length) {
  console.log(`[check-embeds] every embed resolves against the live schema.`);
  process.exit(0);
}

console.log('');
console.log('BROKEN EMBEDS DETECTED');
console.log('(these selects return HTTP 400 and NO ROWS, on every call, in production)');
console.log('');
for (const b of broken) {
  console.log(`  ${b.file}:${b.line}  —  ${b.table}`);
  console.log(`    sent: ${b.sel.slice(0, 200)}`);
  console.log(`    ${b.code || ''} ${(b.message || '').replace(/\s+/g, ' ')}`);
  if (b.hint) console.log(`    hint: ${b.hint}`);
  console.log('');
}
console.log('Before adding a foreign key, read the consumer:');
console.log('  - the embedded data is never used      -> delete the embed');
console.log('  - the relationship is real             -> add the FK (and APPLY it)');
console.log('  - the child outlives the parent        -> do NOT add an FK; look');
console.log('    the value up separately. An FK here asserts something untrue and');
console.log('    ON DELETE CASCADE would destroy data.');
process.exit(1);
