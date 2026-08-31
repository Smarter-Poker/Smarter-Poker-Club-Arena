#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DATABASE MIRRORS MUST EQUAL THE CODE THEY MIRROR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-01)
 *
 * This repo has good file-to-file parity gates. check-rake-schedule-parity
 * holds the two RAKE_SCHEDULE copies together, check-rakeconfig-parity holds
 * the two STAKES_TIERS copies together, tests/config/spinSpec.test.ts holds the
 * two spinSpec copies together, and tests/config/spinSpecMatchesDatabase.test.ts
 * compares SPIN_TIERS against the TEXT of the migration that seeds
 * spin_tier_spec.
 *
 * NOTHING compared a DATABASE MIRROR against the code it mirrors. Four tables
 * exist for no reason except to be that mirror:
 *
 *   public.ca_rake_schedule   RAKE_SCHEDULE   (server/src/config/RakeConfig.ts)
 *   public.ca_rake_tier       STAKES_TIERS    (server/src/config/RakeConfig.ts)
 *   public.bbj_stakes_tiers   STAKES_TIERS    (the BBJ-facing projection)
 *   public.spin_tier_spec     SPIN_TIERS      (src/config/spinSpec.ts)
 *
 * ca_rake_schedule's own COMMENT says it is read by the rake-law alarm and by
 * nothing else. An alarm measuring a stale mirror is not an alarm; it is a
 * machine for certifying the bug it exists to catch. On 2026-09-01 the code
 * half of the 5/5 deletion shipped while the DB half sat unapplied for hours,
 * and every gate stayed green because every gate was comparing a file to a
 * file.
 *
 * WHAT IT DOES
 *
 *   1. Reads the four tables from PRODUCTION over PostgREST with the service
 *      key (the same credential every other live-schema gate here uses).
 *   2. Parses the code arrays out of the TypeScript as TEXT — no build step,
 *      no TS loader, exactly like check-rake-schedule-parity.mjs.
 *   3. Diffs them STRUCTURALLY, field by field, keyed on the thing that
 *      identifies a row (stake, tier label, multiplier).
 *   4. Probes public.fn_effective_rake_cap(sb, bb) — the function the rake-law
 *      alarm prices with — against the engine's own pricing rule, over every
 *      scheduled stake plus a set of unscheduled ones. That is the check that
 *      catches a DB function whose ARITHMETIC has drifted from the engine even
 *      while every row still matches.
 *
 * WHERE IT RUNS
 *
 *   IN CI. ci.yml already passes secrets.SUPABASE_URL and
 *   secrets.SUPABASE_SERVICE_ROLE_KEY to four other steps, so this needs no new
 *   secret. With no credentials (a local run, a fork) it SKIPS and says so —
 *   the same contract as check-embed-relationships.mjs. It is read-only: four
 *   GETs and a STABLE function call. It never writes.
 *
 * WHAT IT CANNOT CATCH
 *
 *   - Drift in a mirror nobody listed here. It knows about four tables.
 *   - A mirror that is correct but READ BY NOTHING. That is a different gate.
 *   - Whether the JS restatement of the pricing rule below still equals the
 *     TypeScript. That is pinned separately, by
 *     tests/config/dbMirrorParityRule.test.ts, which imports the real
 *     getFullRakeConfig and asserts it agrees with `engineCapFor` here across
 *     the same grid. Gate: DB == this rule. Test: this rule == the engine.
 *     Transitively: DB == the engine. Do not delete either half.
 *
 * Usage:  node scripts/ci/check-db-mirror-parity.mjs
 * Exit:   0 clean or skipped · 1 drift · 2 script error
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

const SERVER_RAKE = resolve(REPO, 'server/src/config/RakeConfig.ts');
const CLIENT_SPIN = resolve(REPO, 'src/config/spinSpec.ts');

// ── parsing the code side ───────────────────────────────────────────────────

/** Strip line comments so prose numbers cannot be read as data. */
function decomment(src) {
  return src.replace(/^[ \t]*\/\/[^\n]*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** `{ a: 1, b: 2_000 }` -> { a: 1, b: 2000 }. Numeric fields only. */
function fieldsOf(objectBody) {
  const row = {};
  for (const f of objectBody.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(-?[\d_.]+|Infinity)/g)) {
    row[f[1]] = f[2] === 'Infinity' ? Infinity : Number(f[2].replace(/_/g, ''));
  }
  return row;
}

/** Bound a top-level `[ ... ];` or `{ ... };` literal by matching brackets. */
function literalAfter(src, anchor, open, close) {
  const at = src.indexOf(anchor);
  if (at === -1) throw new Error(`${anchor} not found`);
  /* Skip EMPTY bracket pairs. `export const RAKE_SCHEDULE: RakeScheduleEntry[] = [`
     puts a `[]` between the anchor and the literal, and taking the first `[`
     parses the type annotation instead of the data — silently, as zero rows. */
  let start = -1;
  for (let i = src.indexOf(open, at); i !== -1; i = src.indexOf(open, i + 1)) {
    const rest = src.slice(i + 1);
    if (rest.replace(/^\s*/, '')[0] !== close) {
      start = i;
      break;
    }
  }
  if (start === -1) throw new Error(`${anchor}: no opening ${open}`);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${anchor}: unterminated ${open}`);
}

export function parseRakeSchedule(src) {
  const body = literalAfter(decomment(src), 'RAKE_SCHEDULE', '[', ']');
  const rows = [...body.matchAll(/\{([^}]*)\}/g)].map((m) => fieldsOf(m[1]));
  const out = rows.filter((r) => Number.isFinite(r.sb) && Number.isFinite(r.bb));
  if (out.length === 0) throw new Error('parsed zero RAKE_SCHEDULE entries');
  return out;
}

export function parseStakesTiers(src) {
  const clean = decomment(src);
  const body = literalAfter(clean, 'STAKES_TIERS', '{', '}');
  const out = {};
  for (const m of body.matchAll(/([a-z_][a-z0-9_]*)\s*:\s*\{/gi)) {
    const label = m[1];
    const inner = literalAfter(body.slice(m.index), label, '{', '}');
    out[label] = fieldsOf(inner);
  }
  if (Object.keys(out).length === 0) throw new Error('parsed zero STAKES_TIERS');
  return out;
}

export function parseSpinTiers(src) {
  const body = literalAfter(decomment(src), 'SPIN_TIERS', '[', ']');
  const rows = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (body[i] === '}') {
      depth--;
      if (depth === 0) rows.push(fieldsOf(body.slice(start, i + 1)));
    }
  }
  const out = rows.filter((r) => Number.isFinite(r.multiplier));
  if (out.length === 0) throw new Error('parsed zero SPIN_TIERS');
  return out;
}

// ── the pricing rule, restated ──────────────────────────────────────────────
//
// A restatement of server/src/config/RakeConfig.ts's getFullRakeConfig cap
// path: exact schedule row, else the tier's dollar cap held to the ladder's
// most generous BB proportion. Pinned against the real function by
// tests/config/dbMirrorParityRule.test.ts.

const TIER_ORDER = ['nano', 'micro', 'small', 'mid', 'high', 'nosebleeds'];

export function unscheduledCapBB(schedule) {
  return schedule.reduce((worst, r) => (r.bb > 0 ? Math.max(worst, r.rakeCap / r.bb) : worst), 0);
}

export function engineCapFor(sb, bb, schedule, tiers) {
  const exact = schedule.find((r) => Math.abs(r.sb - sb) < 0.001 && Math.abs(r.bb - bb) < 0.001);
  if (exact) return exact.rakeCap;
  const label = TIER_ORDER.find((t) => bb <= tiers[t].maxBB) || 'nosebleeds';
  const tierCap = tiers[label].rakeCap;
  if (!(bb > 0)) return tierCap;
  return Math.min(tierCap, Math.round(bb * unscheduledCapBB(schedule) * 100) / 100);
}

// ── structural diffs ────────────────────────────────────────────────────────

/** Numeric equality with a cent-scale tolerance. Infinity is compared by
 *  identity: the open top end is a real value on both sides, and |Inf - Inf|
 *  is NaN, which would report "maxBB=Infinity but max_bb=Infinity" forever. */
const near = (a, b) => {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return x === y;
  return Math.abs(x - y) < 1e-6;
};

function compare({ what, codeRows, dbRows, key, fields, describe }) {
  const problems = [];
  const codeBy = new Map(codeRows.map((r) => [key(r), r]));
  const dbBy = new Map(dbRows.map((r) => [key(r), r]));

  for (const [k, code] of codeBy) {
    const db = dbBy.get(k);
    if (!db) {
      problems.push(`${what}: ${describe(k)} is in the CODE and not in the database mirror`);
      continue;
    }
    for (const [codeField, dbField] of fields) {
      if (!near(code[codeField], db[dbField])) {
        problems.push(
          `${what}: ${describe(k)} ${codeField}=${code[codeField]} but ${dbField}=${db[dbField]}`
        );
      }
    }
  }
  for (const k of dbBy.keys()) {
    if (!codeBy.has(k)) {
      problems.push(
        `${what}: ${describe(k)} is in the database mirror and not in the code — the mirror ` +
          'would price or measure something the engine has never heard of'
      );
    }
  }
  return problems;
}

export function diffRakeSchedule(schedule, rows) {
  return compare({
    what: 'ca_rake_schedule vs RAKE_SCHEDULE',
    codeRows: schedule,
    dbRows: rows,
    key: (r) => `${Number(r.sb)}/${Number(r.bb)}`,
    fields: [
      ['rakePercent', 'rake_percent'],
      ['rakeCap', 'rake_cap'],
      ['bbjFeeBB', 'bbj_fee_bb'],
    ],
    describe: (k) => `stake ${k}`,
  });
}

export function diffRakeTier(tiers, rows) {
  // max_bb NULL is the open top end, which the code writes as Infinity.
  const db = rows.map((r) => ({ ...r, max_bb: r.max_bb === null ? Infinity : Number(r.max_bb) }));
  return compare({
    what: 'ca_rake_tier vs STAKES_TIERS',
    codeRows: Object.entries(tiers).map(([label, t]) => ({ label, ...t })),
    dbRows: db,
    key: (r) => String(r.label).toLowerCase(),
    fields: [
      // min_bb is DELIBERATELY NOT COMPARED. fn_effective_rake_cap selects a
      // tier with `ORDER BY max_bb ASC NULLS LAST LIMIT 1` over `p_bb <=
      // max_bb`, so min_bb decides nothing on either side and the two encode
      // the gaps between tiers differently on purpose. Comparing it would fail
      // this gate forever over a column no code path reads. See the migration
      // that comments it as dead data.
      ['maxBB', 'max_bb'],
      ['rakePercent', 'rake_percent'],
      ['rakeCap', 'rake_cap'],
      ['bbjFeeBB', 'bbj_fee_bb'],
    ],
    describe: (k) => `tier ${k}`,
  });
}

export function diffBbjTiers(tiers, rows) {
  // bbj_stakes_tiers stores the open top end as a sentinel 99999 rather than
  // NULL, and its min_bb is a CONTIGUOUS band (0.21, 0.81, 3.01 ...) where
  // STAKES_TIERS leaves gaps. Neither selects anything — the engine's
  // getTierForBB is a max_bb cascade — so max_bb, the money fields and the
  // payout split are what must agree.
  const db = rows.map((r) => ({
    ...r,
    max_bb: Number(r.max_bb) >= 99999 ? Infinity : Number(r.max_bb),
  }));
  return compare({
    what: 'bbj_stakes_tiers vs STAKES_TIERS',
    codeRows: Object.entries(tiers).map(([label, t]) => ({ label, ...t })),
    dbRows: db,
    key: (r) => String(r.id ?? r.label).toLowerCase(),
    fields: [
      ['maxBB', 'max_bb'],
      ['rakePercent', 'rake_percent'],
      ['rakeCapBB', 'rake_cap_bb'],
      ['bbjFeeBB', 'bbj_fee_bb'],
      ['bbjPayoutTotalPercent', 'payout_total_pct'],
    ],
    describe: (k) => `tier ${k}`,
  });
}

export function diffSpinTiers(spinTiers, rows) {
  return compare({
    what: 'spin_tier_spec vs SPIN_TIERS',
    codeRows: spinTiers,
    dbRows: rows,
    key: (r) => String(Number(r.multiplier)),
    fields: [
      ['freq', 'freq'],
      ['reserveThresholdX', 'reserve_threshold_x'],
    ],
    describe: (k) => `${k}x`,
  });
}

/** The stakes the cap probe asks about: every scheduled row, plus unscheduled
 *  points either side of every tier boundary — which is where a DB-only bound
 *  or a DB-only tier cascade shows up. */
export function capProbeStakes(schedule) {
  const scheduled = schedule.map((r) => [r.sb, r.bb]);
  const unscheduled = [
    [0.03, 0.07],
    [0.07, 0.15],
    [0.15, 0.3],
    [0.2, 0.45],
    [0.35, 0.7],
    [0.4, 0.9],
    [0.75, 1.5],
    [1.5, 3],
    [1.75, 3.5],
    [3.5, 7],
    [4.5, 9],
    [7.5, 15],
    [15, 30],
    [20, 45],
    [30, 60],
    [100, 200],
  ];
  return [...scheduled, ...unscheduled];
}

// ── the live half ───────────────────────────────────────────────────────────

const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function getRows(table, select) {
  const res = await fetch(`${URL_BASE}/rest/v1/${table}?select=${select}`, {
    headers: supabaseServerHeaders(KEY),
  });
  if (!res.ok) {
    throw new Error(`GET ${table} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

async function effectiveCap(sb, bb) {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/fn_effective_rake_cap`, {
    method: 'POST',
    headers: supabaseServerHeaders(KEY, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ p_sb: sb, p_bb: bb }),
  });
  if (!res.ok) {
    throw new Error(
      `fn_effective_rake_cap(${sb}, ${bb}) -> ${res.status} ${(await res.text()).slice(0, 300)}`
    );
  }
  return Number(await res.json());
}

async function main() {
  const rakeSrc = readFileSync(SERVER_RAKE, 'utf8');
  const schedule = parseRakeSchedule(rakeSrc);
  const tiers = parseStakesTiers(rakeSrc);
  const spins = parseSpinTiers(readFileSync(CLIENT_SPIN, 'utf8'));

  console.log(
    `[db-mirror-parity] code: ${schedule.length} schedule rows, ` +
      `${Object.keys(tiers).length} stakes tiers, ${spins.length} spin tiers.`
  );

  if (!URL_BASE || !KEY) {
    console.log(
      '[db-mirror-parity] no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — SKIPPING the live half.\n' +
        '  This gate compares production tables against the code; it cannot run without\n' +
        '  the service-role credential. In CI both are supplied by repository secrets.'
    );
    return;
  }

  const [schedRows, tierRows, bbjRows, spinRows] = await Promise.all([
    getRows('ca_rake_schedule', 'sb,bb,rake_percent,rake_cap,bbj_fee_bb,source'),
    getRows('ca_rake_tier', 'label,min_bb,max_bb,rake_percent,rake_cap,bbj_fee_bb'),
    getRows(
      'bbj_stakes_tiers',
      'id,label,min_bb,max_bb,rake_percent,rake_cap_bb,bbj_fee_bb,payout_total_pct'
    ),
    getRows('spin_tier_spec', 'multiplier,freq,reserve_threshold_x'),
  ]);

  const problems = [
    ...diffRakeSchedule(schedule, schedRows),
    ...diffRakeTier(tiers, tierRows),
    ...diffBbjTiers(tiers, bbjRows),
    ...diffSpinTiers(spins, spinRows),
  ];

  // The arithmetic half. Rows can all match while the FUNCTION that reads them
  // prices differently from the engine — which is a false alarm on legal play,
  // filed against a table that did nothing wrong.
  const probes = capProbeStakes(schedule);
  let capChecked = 0;
  for (const [sb, bb] of probes) {
    const live = await effectiveCap(sb, bb);
    const engine = engineCapFor(sb, bb, schedule, tiers);
    capChecked++;
    if (!near(live, engine)) {
      problems.push(
        `fn_effective_rake_cap(${sb}, ${bb}) = ${live} but the engine caps at ${engine} — ` +
          'the rake-law alarm would file over_cap against legal engine behaviour'
      );
    }
  }

  console.log(
    `[db-mirror-parity] live: ${schedRows.length} ca_rake_schedule, ${tierRows.length} ca_rake_tier, ` +
      `${bbjRows.length} bbj_stakes_tiers, ${spinRows.length} spin_tier_spec; ` +
      `${capChecked} cap probes.`
  );

  if (problems.length > 0) {
    console.error('\n═══════════════════════════════════════════════════════════════');
    console.error('  A DATABASE MIRROR HAS DRIFTED FROM THE CODE IT MIRRORS');
    console.error('═══════════════════════════════════════════════════════════════\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\n  These tables exist ONLY to be a copy of the code. A stale copy does not\n' +
        '  sit there harmlessly: fn_effective_rake_cap prices from ca_rake_schedule\n' +
        '  and fn_spin_fairness_check measures the live wheel against spin_tier_spec,\n' +
        '  so a drifted mirror makes an alarm certify the wrong thing as correct.\n\n' +
        '  Fix it by APPLYING the migration that moves the DB half, in the same pull\n' +
        '  request as the code half. Never by editing the code to match the database.\n'
    );
    process.exit(1);
  }

  console.log('DB MIRROR PARITY: OK — every mirrored row and every probed cap matches the code.');
}

/* Run only when invoked as a script. The parsers and diffs above are imported
   by tests/config/dbMirrorParityRule.test.ts, and a module that runs its own
   main() on import would hit the network from a unit test. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[db-mirror-parity] script error:', err?.message || err);
    process.exit(2);
  });
}
