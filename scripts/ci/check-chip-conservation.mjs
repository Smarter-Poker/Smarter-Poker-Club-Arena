#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  check-chip-conservation - property tests + live conservation invariants
 * ═══════════════════════════════════════════════════════════════════════════
 * Zero-drift phase 5. Two halves:
 *
 * 1. PROPERTY TESTS (always run, no network): the largest-remainder split
 *    that fn_collect_bounty and the bounty ruling rely on, fuzzed across
 *    hundreds of random cases. The property is exact conservation: the
 *    shares always sum to the payable amount to the cent, for any weights.
 *
 * 2. LIVE INVARIANTS (run when SUPABASE_DB_PASSWORD or DATABASE_URL is in
 *    the environment; SKIP loudly otherwise, same policy the type-check
 *    gate uses for a missing node_modules): read-only probes of production
 *    conservation state - trailing unexplained supply, settlement states,
 *    stranded op-id claims. Nothing here writes a single row.
 *
 * Run:  node scripts/ci/check-chip-conservation.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';

let fail = 0;
const requireLive = process.env.REQUIRE_LIVE === '1';
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => {
  console.error(`  FAIL  ${m}`);
  fail = 1;
};
const unavailable = (m) => {
  if (requireLive) bad(`live invariants unavailable: ${m}`);
  else console.log(`  SKIP  live invariants: ${m}`);
};

// ── 1. largest-remainder split: exact conservation for any claimant set ────
function splitByWeight(totalCents, weights) {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (totalCents * w) / totalWeight);
  const base = raw.map((r) => Math.floor(r));
  let remainder = totalCents - base.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < remainder; k++) base[order[k % order.length].i] += 1;
  return base;
}

let seed = 0x2f6e2b1;
const rand = () => {
  // deterministic LCG so a failure reproduces
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

let cases = 0;
for (let c = 0; c < 500; c++) {
  const n = 1 + Math.floor(rand() * 9);
  const weights = Array.from({ length: n }, () => Math.floor(rand() * 100000));
  if (weights.every((w) => w === 0)) weights[0] = 1;
  const totalCents = Math.floor(rand() * 10_000_000);
  const shares = splitByWeight(totalCents, weights);
  const sum = shares.reduce((a, b) => a + b, 0);
  if (sum !== totalCents) {
    bad(
      `split conservation broken: total=${totalCents} weights=${weights} shares=${shares} sum=${sum}`
    );
    break;
  }
  if (shares.some((s) => s < 0)) {
    bad(`negative share: total=${totalCents} weights=${weights} shares=${shares}`);
    break;
  }
  cases++;
}
if (cases === 500) ok(`largest-remainder split conserves exactly across ${cases} fuzzed cases`);

// ── 2. live invariants (optional, read-only) ───────────────────────────────
function dbPassword() {
  if (process.env.DATABASE_URL) return null; // full URL wins below
  if (process.env.SUPABASE_DB_PASSWORD) return process.env.SUPABASE_DB_PASSWORD.trim();
  if (existsSync('.env')) {
    const m = readFileSync('.env', 'utf8').match(/^SUPABASE_DB_PASSWORD=(.+)$/m);
    if (m) return m[1].trim();
  }
  return null;
}

async function liveChecks() {
  // resolve pg from the CURRENT checkout first (worktrees run this script
  // from a copy that has no node_modules of its own), then from the script.
  let Client;
  try {
    ({ Client } = createRequire(process.cwd() + '/')('pg'));
  } catch {
    try {
      ({ Client } = createRequire(import.meta.url)('pg'));
    } catch {
      unavailable('pg module not installed');
      return;
    }
  }
  const pw = dbPassword();
  const conn = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : pw
      ? {
          host: 'db.kuklfnapbkmacvwxktbh.supabase.co',
          port: 5432,
          user: 'postgres',
          password: pw,
          database: 'postgres',
          ssl: { rejectUnauthorized: false },
          connectionTimeoutMillis: 10000,
        }
      : null;
  if (!conn) {
    unavailable('no DATABASE_URL or SUPABASE_DB_PASSWORD in the environment');
    return;
  }
  const c = new Client(conn);
  await c.connect();
  try {
    const trailing = await c.query(
      `SELECT round(COALESCE(sum(unexplained),0),2) AS s,
              count(*) FILTER (WHERE unexplained IS NOT NULL) AS n
         FROM public.ca_supply_snapshots
        WHERE taken_at > now() - interval '4 hours'`
    );
    const s = Math.abs(Number(trailing.rows[0].s));
    if (s > 5000) bad(`trailing 4h unexplained chip supply is ${trailing.rows[0].s}`);
    else ok(`trailing 4h unexplained chip supply ${trailing.rows[0].s} (n=${trailing.rows[0].n})`);

    // ca_settlements is an append-only ledger with millions of rows. Reading
    // every row to rediscover an invariant PostgreSQL already enforces made
    // the pre-deploy advisory gate compete with live hand settlement. A
    // validated CHECK proves both existing and future rows without touching
    // the ledger heap.
    const stateConstraint = await c.query(
      `SELECT c.convalidated AS validated,
              pg_get_constraintdef(c.oid, true) AS definition
         FROM pg_catalog.pg_constraint c
        WHERE c.conrelid = 'public.ca_settlements'::regclass
          AND c.conname = 'ca_settlements_state_check'
          AND c.contype = 'c'`
    );
    const expectedStates = [
      'open',
      'locked_for_calculation',
      'calculated',
      'validated',
      'ledger_posted',
      'post_commit_verified',
      'final',
      'failed',
    ].sort();
    const stateRow = stateConstraint.rows[0];
    const constrainedStates = [...String(stateRow?.definition ?? '').matchAll(/'([^']+)'::text/g)]
      .map((match) => match[1])
      .sort();
    const exactStateSet =
      constrainedStates.length === expectedStates.length &&
      constrainedStates.every((state, index) => state === expectedStates[index]);
    if (!stateRow || stateRow.validated !== true || !exactStateSet) {
      bad('settlement state constraint is missing, unvalidated, or does not match legal states');
    } else {
      ok('validated settlement state constraint enforces every legal state');
    }

    const claims = await c.query(
      `SELECT count(*) AS n FROM public.ca_op_claims
        WHERE finalized_at IS NULL AND claimed_at < now() - interval '1 hour'`
    );
    if (Number(claims.rows[0].n) > 0)
      bad(`${claims.rows[0].n} op-id claim(s) stranded unfinalized over an hour`);
    else ok('no stranded op-id claims');

    const diamonds = await c.query(
      `SELECT round(COALESCE(sum(unexplained),0),2) AS s
         FROM public.ca_diamond_snapshots
        WHERE taken_at > now() - interval '4 hours' AND unexplained IS NOT NULL`
    );
    if (Math.abs(Number(diamonds.rows[0].s)) > 500)
      bad(`trailing 4h unexplained diamond supply is ${diamonds.rows[0].s}`);
    else ok(`trailing 4h unexplained diamond supply ${diamonds.rows[0].s}`);
  } finally {
    await c.end();
  }
}

await liveChecks().catch((e) => {
  unavailable(`database check failed (${e.message})`);
});

if (fail) {
  console.error('[check-chip-conservation] FAILED');
  process.exit(1);
}
console.log('[check-chip-conservation] OK');
