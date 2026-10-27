#!/usr/bin/env node
/**
 * ===========================================================================
 *  INSTALL THE QUEUED DAILY-MAINTENANCE MIGRATIONS INSIDE THE 04:00 BREAK
 * ===========================================================================
 *
 * Read maintenance-window-migrations.mjs first: it says why a migration may
 * declare "-- @install-window: daily-maintenance" and what the transaction it
 * is sent in carries.
 *
 * WHO RUNS THIS. Only the window-migrations job of stage-engine-release.yml,
 * on its admitted daily schedule (03:30 America/Chicago, the owner-requested
 * daily engine preparation, CLAUDE.md section 13). It adds no schedule, sends
 * no dispatch, and publishes nothing.
 *
 * WHAT ONE RUN DOES, at most once per daily window:
 *   1. Lists the declared files on this checkout of protected main and reads
 *      schema_migrations. Declared and not recorded = queued. Nothing queued:
 *      it says so and exits 0 without waiting.
 *   2. Checks each queued file against the static window rules before waiting,
 *      so a file that can never install is named at 03:30, not at 04:00.
 *   3. Sleeps ONCE until just before today's 04:00 window, then reads the
 *      database's own window predicate every 2 s until it is open or the
 *      window can no longer admit an install (START_RESERVE before its end).
 *      That is one bounded wait for one event, not a watcher: the run ends at
 *      the window either way.
 *   4. Sends each queued file, oldest version first, through
 *      apply-recorded-migration.mjs --maintenance-window: one transaction per
 *      file, one attempt per file. The first refusal stops the run; that file
 *      and every later one stay queued for the next day's window.
 *
 * OUTCOMES (CLAUDE.md 10.86): 0 nothing queued or every queued file installed;
 * 1 refused, missed or the break never opened (still queued, nothing half
 * applied); 3 UNKNOWN - read schema_migrations before anything else. The job
 * summary names each file and its outcome; a red run on main is read by the
 * red-main detector in production-integrity-audit.yml (CLAUDE.md 10.83).
 */
import { readOwnerMigrationWindow, ownerWindowState } from './owner-window-migration.mjs';
import { readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  declaresMaintenanceWindow,
  validateWindowMigration,
  windowToServe,
  WINDOW_STATE_QUERY,
  START_RESERVE_SECONDS,
} from './maintenance-window-migrations.mjs';
import { splitConcurrentPreamble } from './migration-concurrent-preamble.mjs';
import { supersededBy } from './check-migrations-are-live.mjs';

const DIR = 'supabase/migrations';
const APPLIER = fileURLToPath(new URL('./apply-recorded-migration.mjs', import.meta.url));
const args = process.argv.slice(2);
const argValue = (n) => {
  const i = args.indexOf(n);
  return i === -1 ? null : args[i + 1] || null;
};
const POLL_MS = 2000;
const LEAD_MS = 15_000;
const lines = [];
const say = (line) => {
  console.log(`[window] ${line}`);
  lines.push(line);
};
function finish(code, verdict) {
  say(`result: ${verdict}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      ['### Daily Maintenance Window Migrations', '', ...lines.map((l) => `- ${l}`), ''].join('\n')
    );
  }
  process.exit(code);
}

let ownerWindow = null;
if (args.includes('--owner-window')) {
  try {
    ownerWindow = readOwnerMigrationWindow(argValue('--owner-window'));
  } catch (e) {
    finish(1, `REFUSED - ${e.message}`);
  }
}
// A file marked "-- SUPERSEDED BY <version>" (naming a file in this tree) is
// never queued: the applier refuses it anyway, and queuing it would only wait
// for the break, fail red and hold every later file. Same parser as the applier.
const dirFiles = readdirSync(DIR);
const declared = dirFiles
  .filter((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f))
  .sort()
  .filter((f) => {
    const sql = readFileSync(join(DIR, f), 'utf8');
    if (!declaresMaintenanceWindow(sql)) return false;
    const by = supersededBy(sql, dirFiles);
    if (by) say(`skipped \`${f}\`: SUPERSEDED BY ${by}, never installed`);
    return !by;
  })
  .filter((f) => !ownerWindow || ownerWindow.migrations.includes(f));
if (declared.length === 0) finish(0, 'NOTHING QUEUED (no migration declares the window)');

const CONN = process.env.DATABASE_URL;
if (!CONN) finish(3, 'UNKNOWN - DATABASE_URL is not set');
let connectionURL;
try {
  connectionURL = new URL(CONN);
} catch {
  finish(3, 'UNKNOWN - configured database connection syntax is invalid');
}
const sslRoot = argValue('--ssl-root-cert') || process.env.PGSSLROOTCERT || 'system';
const ssl = { rejectUnauthorized: true };
if (sslRoot !== 'system') {
  try {
    ssl.ca = readFileSync(sslRoot, 'utf8');
  } catch {
    finish(3, 'UNKNOWN - configured provider CA certificate is unavailable');
  }
}
for (const key of ['sslmode', 'ssl', 'sslrootcert']) connectionURL.searchParams.delete(key);
const { default: pg } = await import('pg');

async function read(sql, params = []) {
  const client = new pg.Client({
    connectionString: connectionURL.toString(),
    ssl,
    application_name: 'install-window-migrations',
    statement_timeout: 5000,
  });
  client.on('error', () => {});
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end().catch(() => {});
  }
}

let queued;
try {
  const recorded = await read(
    `SELECT version, name FROM supabase_migrations.schema_migrations
      WHERE version = ANY($1::text[]) OR name = ANY($2::text[]) OR name = ANY($3::text[])`,
    [
      declared.map((f) => f.slice(0, 14)),
      declared.map((f) => f.slice(15, -4)),
      declared.map((f) => f.slice(15, -4).slice(0, 55)),
    ]
  );
  const versions = new Set(recorded.map((r) => r.version));
  const names = new Set(recorded.map((r) => r.name));
  queued = declared.filter((f) => {
    const slug = f.slice(15, -4);
    return !versions.has(f.slice(0, 14)) && !names.has(slug) && !names.has(slug.slice(0, 55));
  });
} catch (e) {
  finish(3, `UNKNOWN - could not read schema_migrations: ${e.message}`);
}
if (queued.length === 0)
  finish(0, `NOTHING QUEUED (${declared.length} declared migration(s), all recorded)`);
say(`queued: ${queued.map((f) => `\`${f}\``).join(', ')}`);

for (const f of queued) {
  const sql = readFileSync(join(DIR, f), 'utf8');
  const shape = splitConcurrentPreamble(sql);
  try {
    if (!shape.ok) throw new Error(`${f}: ${shape.reason}`);
    validateWindowMigration(f, sql, { preamble: shape.indexes });
  } catch (e) {
    finish(1, `REFUSED before waiting - ${e.message}. Nothing was sent; fix it in a pull request.`);
  }
}

// Explicit controller admission checks exact history and static SQL BEFORE
// reserving any announcement. This branch never waits or sends a migration.
if (args.includes('--preflight-only'))
  finish(0, 'PREFLIGHT QUEUED (history and static SQL checked; nothing sent)');

const window = ownerWindow
  ? {
      startsAt: Date.now(),
      endsAt: Math.min(Date.parse(ownerWindow.notAfter), Date.now() + 70 * 60_000),
    }
  : windowToServe(Date.now());
if (!window)
  finish(
    1,
    `MISSED - no 04:00 America/Chicago window can still admit an install within 3 hours of ${new Date().toISOString()}. ` +
      `${queued.length} migration(s) stay queued for the next daily run.`
  );
const startIso = new Date(window.startsAt).toISOString();
say(`window: ${startIso} to ${new Date(window.endsAt).toISOString()}`);
const sleepMs = window.startsAt - LEAD_MS - Date.now();
if (sleepMs > 0) {
  say(`waiting once, ${Math.round(sleepMs / 1000)} s, for the window`);
  await new Promise((r) => setTimeout(r, sleepMs));
}

// One bounded wait for this window's confirmed freeze. Unreadable is not
// "closed": three consecutive unreadable answers end the run as UNKNOWN.
const lastAdmit = window.endsAt - START_RESERVE_SECONDS * 1000;
let open = null;
let unreadable = 0;
let lastState = null;
while (Date.now() < lastAdmit) {
  try {
    const [state] = await read(
      ownerWindow ? ownerWindowState(ownerWindow, START_RESERVE_SECONDS) : WINDOW_STATE_QUERY
    );
    unreadable = 0;
    lastState = state;
    if (state?.open === true) {
      open = state;
      break;
    }
  } catch (e) {
    if (++unreadable >= 3) finish(3, `UNKNOWN - the window state was unreadable: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
if (!open)
  finish(
    1,
    `BREAK NEVER OPENED - the 04:00 break did not reach a confirmed freeze with ${START_RESERVE_SECONDS}s to spare ` +
      `(last state: frozen=${lastState?.frozen}, break=${lastState?.break_row ?? 'none'}). ` +
      `${queued.length} migration(s) stay queued; nothing was sent.`
  );
say(`freeze confirmed at ${new Date(open.observed_at).toISOString()}: ${open.break_row}`);

const passthrough = argValue('--ssl-root-cert')
  ? ['--ssl-root-cert', argValue('--ssl-root-cert')]
  : [];
for (const f of queued) {
  const started = Date.now();
  const run = spawnSync(
    process.execPath,
    [
      APPLIER,
      '--migration',
      f,
      '--maintenance-window',
      ...(ownerWindow ? ['--owner-window', ownerWindow.id] : []),
      ...passthrough,
    ],
    { stdio: 'inherit', env: process.env, timeout: 60_000 }
  );
  const ms = Date.now() - started;
  if (run.status === 0) {
    say(`INSTALLED \`${f}\` (${ms} ms, override recorded in ca_break_window_migration_overrides)`);
    continue;
  }
  const rest = queued.slice(queued.indexOf(f) + 1);
  if (run.status === 1)
    finish(
      1,
      `REFUSED \`${f}\` after ${ms} ms - rolled back, nothing committed, see the log above. ` +
        `It${rest.length ? ` and ${rest.length} later migration(s)` : ''} stay queued for the next daily window. Not retried.`
    );
  finish(
    3,
    `UNKNOWN \`${f}\` (exit ${run.status ?? run.signal}) - read schema_migrations for it before anything else. Not retried.`
  );
}
finish(0, `INSTALLED ${queued.length} migration(s) inside the daily maintenance freeze`);
