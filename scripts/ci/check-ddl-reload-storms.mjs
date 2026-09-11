#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A SCHEMA-RELOAD STORM STOPS EVERY TABLE ON THE FELT, AND NOTHING WATCHED IT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-06)
 *
 * Between 16:04 and 16:08 UTC the platform nearly stopped dealing:
 *
 *     15:24-15:52   420-500 hands per minute, steady all day
 *     16:00-16:02   279, 476, 444 - normal after the maintenance thaw
 *     16:05         119
 *     16:07          17
 *     16:08           6
 *
 * The engine was alive, leader, and dealing. The database was idle with no lock
 * waits. The engine log was full of one line, 970 times:
 *
 *     deal_step_timeout: load_seats exceeded 20s
 *
 * Every table's ordinary reads hitting a 20-second wall at once, plus
 * `refresh_rake`, the tournament context refresh, and elimination sweeps
 * overrunning 65 seconds. Nobody's code was broken.
 *
 * `ca_ddl_events` said what it was. In the single minute 16:14 there were 249
 * DDL statements, 133 of them reload-triggering, applied through Supavisor as
 * one long script. CLAUDE.md section 2 measured ONE PostgREST schema-cache
 * reload on this database at ~28 seconds - the whole reason rule 1 of that
 * section says a change goes in as ONE transaction, because Postgres coalesces
 * the reload NOTIFYs inside a transaction and does not across many.
 *
 * The rule was already written. Nothing measured it, so nobody knew it was
 * being broken, and the agent running the script had no way to see that it was
 * stopping every table on the felt.
 *
 * ─── WHAT IT COUNTS, AND WHY NOT THE OBVIOUS THING ─────────────────────────
 *
 * NOT raw statements. Measured over seven days, the single largest minute by
 * statement count was a `mgmt-api` migration: **147 reload-triggering
 * statements, and only 3 distinct query texts** - one transaction, coalesced,
 * about three reloads, harmless. Alarming on statement count would have paged
 * on the correctly-written migration and shrugged at the one that hurt.
 *
 * So this counts DISTINCT reload-triggering statement texts per minute. A
 * migration applied through the migration API carries the whole body as one
 * query text however many DDL statements are inside it; a hand-run script
 * gives each statement its own. Distinct texts is therefore a good proxy for
 * distinct transactions, which is a good proxy for actual reloads.
 *
 * The separation is not subtle:
 *
 *     minute        app         stmts   distinct   what it was
 *     08-31 20:27   mgmt-api      147          3   one migration, fine
 *     09-06 16:14   Supavisor     133        121   the incident
 *     09-06 12:32   Supavisor      72          1   one statement, fine
 *     09-06 11:48   Supavisor      49         27   a hand-run RLS sweep
 *
 * ─── THE THRESHOLD, DERIVED RATHER THAN GUESSED (CLAUDE.md 10.84) ──────────
 *
 * Distinct reload-triggering statements per minute, across the 938 minutes in
 * seven days that contained any:
 *
 *     avg 2.65   p50 2   p90 4   p99 25   max 121
 *     >=10: 34 minutes   >=15: 16   >=20: 13   >=30: 5
 *
 * **30** is the threshold. Above p99, five minutes in seven days (~0.7/day),
 * and every one of those five is the same shape - a long `ALTER TABLE ...
 * ENABLE ROW LEVEL SECURITY` sweep or schema change run straight through the
 * pooler. Not one is a scheduled job, so this can never fire on the ordinary
 * rhythm of the platform. An alarm that is always on is an alarm that gets
 * muted.
 *
 * Minutes in the 15-29 band are PRINTED as context and do not fail the check.
 * The trend is worth seeing; only the storm is worth stopping for.
 *
 * ─── WHO READS IT (CLAUDE.md 10.86 rule 3) ─────────────────────────────────
 *
 * The `ddl_reload_storms` job in the read-only
 * `.github/workflows/production-integrity-audit.yml`. A red run there is
 * picked up by `check-main-is-green.mjs` in the same workflow, which
 * raises one issue for any workflow red on `main` with nobody watching. It
 * reports; it never gates - it cannot, because the statements it is about do
 * not go through a pull request at all.
 *
 * ─── THREE OUTCOMES, NOT TWO (CLAUDE.md 10.86 rule 1) ──────────────────────
 *
 *     0   no storm in the window
 *     1   at least one minute at or over the threshold
 *     2   COULD NOT TELL - no credentials, an unreadable response, or a row
 *         cap that means the window was read only in part
 *
 * A truncated read is never reported as a clean one. That is the specific
 * failure this estate keeps re-deriving: `undefined || []` reading as good
 * news.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/ci/check-ddl-reload-storms.mjs [--hours=2] [--threshold=30] [--json]
 */
import { pathToFileURL } from 'node:url';

import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const AS_JSON = process.argv.includes('--json');
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Hours of history to read.
 *
 * TWO, not twenty-four, and the reason is 10.84's "an alarm that is always on
 * is an alarm that gets muted". The watchdog runs this every 15 minutes, so a
 * 2-hour window is seen by eight consecutive runs - a storm cannot slip
 * between them - and the alarm CLEARS two hours after the event instead of
 * re-reporting the same past minute for a day. An alarm that does not resolve
 * teaches everybody to ignore it long before the next real one.
 *
 * Pass `--hours=24` by hand when you want the wider look.
 */
export const DEFAULT_HOURS = 2;
/**
 * Distinct reload-triggering statements in ONE minute that constitute a storm.
 * Derived from seven days of ca_ddl_events; see the header. Do not raise this
 * to silence a run - the run is the point.
 */
export const DEFAULT_THRESHOLD = 30;
/**
 * How old the newest `ca_ddl_events` row may be before this check refuses to
 * answer at all.
 *
 * ═══ MY OWN 10.86 RULE 1, FOUND IN THE VERIFICATION PASS ═══════════════════
 *
 * Without this, "no storm in the window" and "the thing that records DDL has
 * stopped" are the SAME OBSERVATION. `ca_ddl_events` is written by two event
 * triggers, `ca_ddl_watchdog_log` and `ca_ddl_watchdog_drop_log`, and event
 * triggers on this database are created, replaced and dropped by agents all
 * day - I edited both of them myself the same afternoon I wrote this check.
 * Disable either one and this file reports a clean bill of health for ever,
 * which is exactly the failure it was written to stop somebody else making.
 *
 * TWENTY-FOUR HOURS, derived rather than guessed. Over seven days
 * `ca_ddl_events` took 14,223 rows; the gap between consecutive rows was
 * 5 minutes at p95, 6 minutes at p99, and **8.93 hours at its worst** - a
 * genuinely quiet night. 24h is 2.7x that worst observed quiet period, so it
 * cannot cry wolf on one; and if nothing at all has run DDL on this database
 * for a full day, that is worth being told regardless of why.
 */
export const STALE_HOURS = 24;
/** Below this, printed as context; at or above the threshold, it fails. */
export const CONTEXT_FLOOR = 15;

/** PostgREST refuses to return more than this many rows in one response. */
const PAGE = 1000;
/** Refuse to answer rather than answer from a partial window. */
const MAX_PAGES = 40;

/**
 * Group rows into minutes and count DISTINCT statement texts in each.
 *
 * Exported so the test can exercise the judgement without a database. Rows are
 * `{ occurred_at, query_snippet, application_name }` exactly as PostgREST
 * returns them.
 */
export function stormsByMinute(rows, threshold = DEFAULT_THRESHOLD) {
  const byMinute = new Map();
  for (const r of rows) {
    // Slice rather than parse: the value is ISO-8601 from Postgres and
    // `new Date()` would drag local-time behaviour into a pure grouping.
    const minute = String(r.occurred_at ?? '').slice(0, 16);
    if (minute.length !== 16) continue;
    let m = byMinute.get(minute);
    if (!m) {
      m = { minute, texts: new Set(), statements: 0, apps: new Set() };
      byMinute.set(minute, m);
    }
    m.texts.add(String(r.query_snippet ?? ''));
    m.statements += 1;
    if (r.application_name) m.apps.add(String(r.application_name));
  }

  return [...byMinute.values()]
    .map((m) => ({
      minute: m.minute,
      distinct: m.texts.size,
      statements: m.statements,
      apps: [...m.apps].sort(),
      storm: m.texts.size >= threshold,
    }))
    .filter((m) => m.distinct >= CONTEXT_FLOOR)
    .sort((a, b) => b.distinct - a.distinct);
}

/**
 * How old is the newest row in `ca_ddl_events`, in hours?
 *
 * `null` when the table holds no rows at all - which is not "quiet", it is
 * "the logger has never written or somebody emptied it", and the caller must
 * treat it the same way it treats a stale one.
 */
export function loggerAgeHours(newestIso, now = Date.now()) {
  if (!newestIso) return null;
  const t = Date.parse(newestIso);
  if (!Number.isFinite(t)) return null;
  return (now - t) / 3600_000;
}

/** True when the DDL logger looks dead and no verdict may be given. */
export function loggerIsStale(ageHours, staleHours = STALE_HOURS) {
  return ageHours === null || ageHours > staleHours;
}

async function readNewestEventAge() {
  const url =
    `${URL_BASE}/rest/v1/ca_ddl_events` +
    `?select=occurred_at&order=occurred_at.desc&limit=1`;
  const res = await fetch(url, { headers: supabaseServerHeaders(KEY) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ca_ddl_events liveness read returned ${res.status}. ${text.slice(0, 300)}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('ca_ddl_events liveness read did not return an array');
  return loggerAgeHours(rows[0]?.occurred_at ?? null);
}

async function readWindow(hours) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url =
      `${URL_BASE}/rest/v1/ca_ddl_events` +
      `?select=occurred_at,query_snippet,application_name` +
      `&triggers_pgrst_reload=is.true` +
      `&occurred_at=gte.${encodeURIComponent(since)}` +
      `&order=occurred_at.asc&limit=${PAGE}&offset=${page * PAGE}`;

    const res = await fetch(url, { headers: supabaseServerHeaders(KEY) });
    // res.ok FIRST, always. A 4xx body parsed as JSON is not an empty result
    // set, and `[] ` from an error reads as "nothing happened".
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ca_ddl_events returned ${res.status}. ${text.slice(0, 300)}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error('ca_ddl_events did not return an array');
    rows.push(...batch);
    if (batch.length < PAGE) return { rows, complete: true };
  }
  return { rows, complete: false };
}

async function main() {
  if (!URL_BASE || !KEY) {
    console.error('check-ddl-reload-storms: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(2);
  }

  const hours = arg('hours', DEFAULT_HOURS);
  const threshold = arg('threshold', DEFAULT_THRESHOLD);

  // The source has to be alive before its silence can mean anything.
  let age;
  try {
    age = await readNewestEventAge();
  } catch (err) {
    console.error(`check-ddl-reload-storms: COULD NOT TELL - ${err.message}`);
    process.exit(2);
  }
  if (loggerIsStale(age)) {
    console.error('');
    console.error('check-ddl-reload-storms: COULD NOT TELL - the DDL logger looks dead.');
    console.error('');
    console.error(
      age === null
        ? '  ca_ddl_events holds no rows at all.'
        : `  The newest ca_ddl_events row is ${age.toFixed(1)}h old; anything past ` +
          `${STALE_HOURS}h is stale (the worst quiet period measured over seven days was 8.93h).`
    );
    console.error('');
    console.error('  Without a live source, "no storm" and "nothing is recording DDL" are the');
    console.error('  same observation, so this refuses to report either. Check the two event');
    console.error('  triggers that fill the table:');
    console.error('');
    console.error("    select evtname, evtenabled from pg_event_trigger");
    console.error("     where evtname in ('ca_ddl_watchdog_log', 'ca_ddl_watchdog_drop_log');");
    console.error('');
    console.error("  evtenabled 'O' is enabled; 'D' is disabled. A missing row means dropped.");
    console.error('');
    process.exit(2);
  }

  let read;
  try {
    read = await readWindow(hours);
  } catch (err) {
    console.error(`check-ddl-reload-storms: COULD NOT TELL - ${err.message}`);
    process.exit(2);
  }

  if (!read.complete) {
    console.error(
      `check-ddl-reload-storms: COULD NOT TELL - the ${hours}h window did not fit in ` +
        `${MAX_PAGES * PAGE} rows, so any verdict would be from a partial read. ` +
        'Run it over a shorter window.'
    );
    process.exit(2);
  }

  const minutes = stormsByMinute(read.rows, threshold);
  const storms = minutes.filter((m) => m.storm);

  if (AS_JSON) {
    console.log(JSON.stringify({ hours, threshold, storms, context: minutes }, null, 1));
    process.exit(storms.length === 0 ? 0 : 1);
  }

  const context = minutes.filter((m) => !m.storm);
  if (context.length > 0) {
    console.log(
      `[ddl-reload-storms] ${context.length} minute(s) between ${CONTEXT_FLOOR} and ` +
        `${threshold - 1} distinct reload-triggering statements (context, not a failure):`
    );
    for (const m of context.slice(0, 10)) {
      console.log(
        `    ${m.minute}Z  ${String(m.distinct).padStart(3)} distinct / ` +
          `${String(m.statements).padStart(3)} statements  ${m.apps.join(', ')}`
      );
    }
    console.log('');
  }

  if (storms.length === 0) {
    console.log(
      `[ddl-reload-storms] OK - no minute in the last ${hours}h reached ${threshold} distinct ` +
        `reload-triggering DDL statements (${read.rows.length} such statements read).`
    );
    return;
  }

  console.error('');
  console.error('[ddl-reload-storms] FAILED: a PostgREST schema-reload storm.');
  console.error('');
  for (const m of storms) {
    console.error(
      `  ${m.minute}Z  ${m.distinct} distinct reload-triggering statements ` +
        `(${m.statements} total)  via ${m.apps.join(', ') || 'unknown'}`
    );
  }
  console.error('');
  console.error('  One PostgREST schema-cache reload takes ~28 SECONDS on this database');
  console.error('  (~970 relations, ~2,700 functions - CLAUDE.md section 2). Postgres');
  console.error('  coalesces the reload NOTIFYs inside ONE transaction and does not across');
  console.error('  many, so a run like this is not one reload, it is up to that many.');
  console.error('');
  console.error('  While it lasts, every ordinary read queues. On 2026-09-06 the fleet went');
  console.error('  from ~450 hands per minute to 6, with 970 "load_seats exceeded 20s" in the');
  console.error('  engine log and nothing at all wrong with the engine.');
  console.error('');
  console.error('  If this was you, and it is still running: STOP, and re-run the remainder');
  console.error('  as ONE transaction.');
  console.error('');
  console.error('    BEGIN;  ... every DDL statement for the change ...  COMMIT;');
  console.error('');
  console.error('  A migration applied through the migration API is already one transaction.');
  console.error('  Statements typed into psql or sent through the pooler one at a time are');
  console.error('  not, and that is the whole difference: the largest single migration in the');
  console.error('  last seven days held 147 reload-triggering statements and cost about three');
  console.error('  reloads, because it was one transaction.');
  console.error('');
  console.error('  This check reports and never blocks - the statements it is about do not go');
  console.error('  through a pull request. Read it, and change how the next one is applied.');
  console.error('');
  process.exit(1);
}

// Only when RUN, never when imported. The test imports this module for
// `stormsByMinute`, and without this guard the import itself executed main(),
// which read the environment, found no key and called process.exit(2) from
// inside the test worker. It still passed - vitest reported "1 error" beside
// 15 green tests - which is the shape of a failure nobody reads.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // Anything unforeseen is UNKNOWN, never green.
    console.error(`check-ddl-reload-storms: COULD NOT TELL - ${err.message}`);
    process.exit(2);
  });
}
