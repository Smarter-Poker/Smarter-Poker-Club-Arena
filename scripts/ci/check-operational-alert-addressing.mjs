#!/usr/bin/env node
/**
 * Every operational alert must be addressed to the production-alerts fleet.
 *
 * The fleet lane triages public.operational_alert_events by
 * payload.target_task_id. A row without it reaches the store but never reaches
 * the lane that must fix it: on 2026-09-26 the smarter-poker-workers writers
 * (workers.scraper-watchdog, workers.scraper, workers.deploy-error-poll) and
 * video-library-scraper had been doing exactly that for days.
 *
 * This check runs after each hourly Production Integrity Audit and looks at
 * the last two hours only (history before the fix is custody, not a new
 * fault). A row is unaddressed when its payload.target_task_id is missing,
 * null or names another task. When it finds any, it records ONE incident,
 * itself addressed to the fleet, and exits 1 so its own workflow run is red.
 * While that incident is open, later runs reuse its identity; once a window
 * is clean it records the matching recovery through the same route. It never
 * edits, re-addresses or deletes the offending rows. An answer it could not
 * get (no DATABASE_URL, a database error) exits 3 and says COULD NOT TELL
 * (CLAUDE.md 10.86): unknown is never reported as clean.
 *
 * Run:  DATABASE_URL=... node scripts/ci/check-operational-alert-addressing.mjs
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const FLEET_TASK_ID = '01a09b86-5ba8-7290-8657-1041f13dd3ca';
export const SOURCE = 'production-integrity-audit';
export const ALERT_NAME = 'OperationalAlertMissingTargetTaskId';
export const WINDOW = '2 hours';
export const UNKNOWN = 3;
export const CLOSED = ['verified_fixed', 'historical'];

/** Pure decision, exported for the regression test. */
export function decide(unaddressed, previous) {
  if (unaddressed.length > 0) {
    const sources = Object.fromEntries(unaddressed.map((r) => [r.source, Number(r.rows)]));
    const identity = unaddressed.map((r) => `${r.source}:${r.first_id}`).sort().join('|')
      + (previous && previous.status === 'firing' && CLOSED.includes(previous.investigation_status)
        ? `|after:${previous.event_key}` : '');
    // One episode keeps one identity while it is firing, even as the window
    // slides past the rows that opened it; a recovery then closes that episode.
    // A firing row the lane already closed is never reused: a recurrence must
    // reach the lane as a new open incident, not bump a closed one.
    const reusable = previous && previous.status === 'firing'
      && !CLOSED.includes(previous.investigation_status);
    const eventKey = reusable
      ? previous.event_key
      : createHash('sha256').update(identity).digest('hex');
    return {
      action: 'fire',
      exitCode: 1,
      eventKey,
      payload: { target_task_id: FLEET_TASK_ID, window: WINDOW, sources,
        oldest: unaddressed.map((r) => r.oldest).sort()[0] },
    };
  }
  if (previous && previous.status === 'firing' && !CLOSED.includes(previous.investigation_status)) {
    return {
      action: 'resolve',
      exitCode: 0,
      eventKey: `${previous.event_key}:resolved`,
      payload: { target_task_id: FLEET_TASK_ID, window: WINDOW, resolves: previous.event_key },
    };
  }
  return { action: 'none', exitCode: 0 };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('COULD NOT TELL  DATABASE_URL is missing; an unavailable answer is not a pass');
    process.exit(UNKNOWN);
  }
  let Client;
  try {
    ({ Client } = createRequire(process.cwd() + '/')('pg'));
  } catch {
    ({ Client } = createRequire(import.meta.url)('pg'));
  }
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    await db.query("SET statement_timeout = '20s'");
    const { rows: unaddressed } = await db.query(
      `SELECT source, count(*) AS rows, min(id) AS first_id, min(received_at)::text AS oldest
         FROM public.operational_alert_events
        WHERE last_received_at > now() - $1::interval
          AND payload->>'target_task_id' IS DISTINCT FROM $2
        GROUP BY source ORDER BY source`, [WINDOW, FLEET_TASK_ID]);
    const { rows: [previous] } = await db.query(
      `SELECT event_key, status, investigation_status FROM public.operational_alert_events
        WHERE source = $1 AND alertname = $2
        ORDER BY last_received_at DESC, id DESC LIMIT 1`, [SOURCE, ALERT_NAME]);
    const verdict = decide(unaddressed, previous);
    if (verdict.action !== 'none') {
      const status = verdict.action === 'fire' ? 'firing' : 'resolved';
      const severity = verdict.action === 'fire' ? 'warning' : 'info';
      const { rows: [receipt] } = await db.query(
        'SELECT public.fn_record_operational_alert($1,$2,$3,$4,$5,$6::jsonb) AS id',
        [SOURCE, verdict.eventKey, ALERT_NAME, status, severity, JSON.stringify(verdict.payload)]);
      if (!receipt || !(Number(receipt.id) > 0)) throw new Error('operational inbox returned no receipt');
      console.log(`${status}: operational alert ${receipt.id}`);
    }
    for (const r of unaddressed) console.error(`FAIL  ${r.rows} alert row(s) from ${r.source} are not addressed to the fleet`);
    if (verdict.exitCode === 0) console.log(`ok    every operational alert in the last ${WINDOW} is addressed to the fleet`);
    process.exitCode = verdict.exitCode;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`COULD NOT TELL  ${error.message}`); process.exit(UNKNOWN); });
}
