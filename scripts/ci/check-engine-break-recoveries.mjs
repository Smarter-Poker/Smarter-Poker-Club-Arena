#!/usr/bin/env node
/**
 * Every engine break fault the fleet is told about is followed by its
 * recovery: the reader that does not trust the code it checks.
 *
 * 20260928155739 makes the hourly break scorecard's pass (pg_cron job
 * ca-break-scorecard, fn_ca_record_break_scorecard() with no argument) send one
 * engine_break_recovered per route for every engine_break_failed notice sent
 * since OWNED_FROM that no recovery names yet, and record for the Production
 * Alerts task whatever it could not deliver. That record is written by the
 * same code it reports on, in the same transaction, so it cannot see the ways
 * that code stops running: a recorder replaced without the recovery branch, a
 * job changed to pass the recorder an hour, a store that refuses the record, a
 * receipt left pending. This reads production instead.
 *
 * It runs after each hourly Production Integrity Audit (no new schedule,
 * CLAUDE.md 10.85). A fault is OVERDUE when its notice (engine_break_failed,
 * sent on or after OWNED_FROM, key 'break-failed:<UTC hour>') has no recovery
 * the task can see - for the owner account, only a resolved receipt addressed
 * to the task naming it counts (a recovery in his personal inbox does not);
 * for any other account, an engine_break_recovered in their inbox naming it -
 * although the hourly job has since recorded a pass for a later hour, at least
 * SETTLE ago and after the notice was sent. The hourly job's pass is read from
 * pg_cron's own log, not from the code under audit: a pass row recorded during
 * a run cron.job_run_details holds as succeeded for a job calling the recorder
 * (whatever hour that run scored, so a job changed to pass an hour or to score
 * an earlier one is seen too). An explicit re-score is never such a row. A row
 * older than the log (pg_cron keeps 14 days) counts when it was recorded inside
 * its own hour. With no succeeded run of that job in RUN_EVIDENCE the audit
 * cannot tell the hourly job's passes from anyone else's: COULD NOT TELL.
 * When any fault is overdue it records ONE incident addressed to the fleet
 * (payload.target_task_id) and exits 1 so its own run is red; while that
 * incident is open later runs reuse its identity; once nothing is overdue it
 * records the matching recovery on the same key. It never sends, edits or
 * deletes anything else. An answer it could not get exits 3 COULD NOT TELL
 * (CLAUDE.md 10.86): unknown is never reported as clean.
 *
 * Run:  DATABASE_URL=... node scripts/ci/check-engine-break-recoveries.mjs
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const FLEET_TASK_ID = '01a09b86-5ba8-7290-8657-1041f13dd3ca';
export const OWNER_ACCOUNT = '47965354-0e56-43ef-931c-ddaab82af765';
export const SOURCE = 'engine-break-recovery-audit';
export const ALERT_NAME = 'NotifiedFaultWithoutRecovery';
/** The instant 20260928155739 owns faults from (its c_owned_from). */
export const OWNED_FROM = '2026-09-28 00:00:00+00';
export const SETTLE = '5 minutes';
/** Without a succeeded run of the scorecard job this recent, the audit cannot tell. */
export const RUN_EVIDENCE = '3 hours';
export const UNKNOWN = 3;
export const CLOSED = ['verified_fixed', 'historical'];
/** Faults listed in one incident's payload; the count is always complete. */
export const LISTED = 100;

/** $1 owned from, $2 settle, $3 fleet task id, $4 the owner account. */
export const OVERDUE_SQL = `
WITH notices AS (
  SELECT n.user_id AS route, n.id::text AS notice, n.data->>'key' AS fault_key, n.created_at AS sent_at
    FROM public.notifications n
   WHERE n.type = 'engine_break_failed' AND n.created_at >= $1::timestamptz
  UNION ALL
  SELECT d.recipient_user_id, d.notification_id::text, d.original_notification->'data'->>'key', d.captured_at
    FROM public.operational_notification_destinations d
   WHERE d.original_notification->>'type' = 'engine_break_failed' AND d.captured_at >= $1::timestamptz
), faults AS (
  SELECT route, fault_key, min(sent_at) AS sent_at, array_agg(DISTINCT notice ORDER BY notice) AS notices
    FROM notices
   WHERE fault_key ~ '^break-failed:[0-9]{8}T[0-9]{4}$'
   GROUP BY route, fault_key
), runs AS MATERIALIZED (
  SELECT d.start_time, d.end_time
    FROM cron.job_run_details d
   WHERE d.start_time >= $1::timestamptz - interval '1 hour' AND d.status = 'succeeded'
     AND d.end_time IS NOT NULL AND d.command ~* 'fn_ca_record_break_scorecard'
), kept AS MATERIALIZED (
  SELECT min(d.start_time) AS kept_from
    FROM cron.job_run_details d
   WHERE d.command ~* 'fn_ca_record_break_scorecard'
)
SELECT f.route::text AS route, f.fault_key, f.notices,
       to_char(f.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') || ' UTC' AS sent_at,
       to_char(p.passed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC' AS passed_at
  FROM faults f
 CROSS JOIN kept k
 CROSS JOIN LATERAL (
       SELECT min(s.break_ended_at) AS passed_at
         FROM public.ca_break_scorecards s
        WHERE s.verdict = 'pass'
          AND to_char(s.break_ended_at AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MI') > substr(f.fault_key, 14)
          AND s.recorded_at > f.sent_at
          AND s.recorded_at < now() - $2::interval
          AND (EXISTS (SELECT 1 FROM runs r
                        WHERE s.recorded_at >= r.start_time - interval '1 second'
                          AND s.recorded_at <= r.end_time)
               OR (s.recorded_at < k.kept_from
                   AND s.recorded_at >= s.break_ended_at
                   AND s.recorded_at < s.break_ended_at + interval '1 hour'))) p
 WHERE p.passed_at IS NOT NULL
   AND NOT CASE WHEN f.route = $4::uuid
     THEN EXISTS (SELECT 1 FROM public.operational_notification_destinations x
                    JOIN public.operational_alert_events e ON e.id = x.inbox_event_id
                   WHERE x.original_notification->>'type' = 'engine_break_recovered'
                     AND x.recipient_user_id = f.route
                     AND x.original_notification->'data'->'resolves' ? f.fault_key
                     AND e.status = 'resolved' AND e.payload->>'target_task_id' = $3)
     ELSE EXISTS (SELECT 1 FROM public.notifications x
                   WHERE x.type = 'engine_break_recovered' AND x.user_id = f.route
                     AND x.data->'resolves' ? f.fault_key) END
 ORDER BY f.fault_key, f.route`;

/** $1 how recent. */
export const RUNS_SQL = `
SELECT count(*)::int AS n FROM cron.job_run_details d
 WHERE d.start_time > now() - $1::interval AND d.status = 'succeeded'
   AND d.command ~* 'fn_ca_record_break_scorecard'`;

/** $1 source, $2 alert name. */
export const PREVIOUS_SQL = `
SELECT event_key, status, investigation_status FROM public.operational_alert_events
 WHERE source = $1 AND alertname = $2
 ORDER BY last_received_at DESC, id DESC LIMIT 1`;

/** $1 source, $2 event key, $3 fleet task id. */
export const KEPT_SQL = `
SELECT count(*)::int AS n FROM public.operational_alert_events
 WHERE source = $1 AND event_key = $2 AND payload->>'target_task_id' = $3`;

/** Who a fault went to, as a public log may say it: never another account's id. */
export const recipient = (route) =>
  route === OWNER_ACCOUNT ? 'the owner account' : 'another recipient';

/** Pure decision, exported for the regression test. */
export function decide(overdue, previous) {
  const open =
    previous && previous.status === 'firing' && !CLOSED.includes(previous.investigation_status);
  if (overdue.length > 0) {
    // One episode keeps one identity while it is firing, as faults join it or
    // recover. A firing row the lane already closed is never reused: a
    // recurrence must reach the lane as a new open incident.
    const identity =
      overdue
        .map((r) => `${r.route}:${r.fault_key}`)
        .sort()
        .join('|') +
      (previous && previous.status === 'firing' && CLOSED.includes(previous.investigation_status)
        ? `|after:${previous.event_key}`
        : '');
    return {
      action: 'fire',
      exitCode: 1,
      eventKey: open ? previous.event_key : createHash('sha256').update(identity).digest('hex'),
      payload: {
        target_task_id: FLEET_TASK_ID,
        owned_from: OWNED_FROM,
        overdue: overdue.length,
        faults: overdue.slice(0, LISTED).map((r) => ({
          route: r.route,
          fault_key: r.fault_key,
          notices: r.notices,
          sent_at: r.sent_at,
          passed_at: r.passed_at,
        })),
      },
    };
  }
  if (open) {
    return {
      action: 'resolve',
      exitCode: 0,
      eventKey: `${previous.event_key}:resolved`,
      payload: {
        target_task_id: FLEET_TASK_ID,
        owned_from: OWNED_FROM,
        resolves: previous.event_key,
      },
    };
  }
  return { action: 'none', exitCode: 0 };
}

/**
 * One read and, when needed, one record, through `db` (anything with
 * query(text, params) -> { rows }). Returns the exit code. `settle` exists for
 * the probe, which cannot wait five minutes per case; the job never passes it.
 */
export async function run(db, { settle = SETTLE } = {}) {
  await db.query("SET statement_timeout = '20s'");
  const {
    rows: [runs],
  } = await db.query(RUNS_SQL, [RUN_EVIDENCE]);
  if (!runs || !(Number(runs.n) > 0))
    throw new Error(
      `cron.job_run_details holds no succeeded run of the break scorecard job in the last ${RUN_EVIDENCE}, ` +
        "so the hourly job's passes cannot be told from anyone else's"
    );
  const { rows: overdue } = await db.query(OVERDUE_SQL, [
    OWNED_FROM,
    settle,
    FLEET_TASK_ID,
    OWNER_ACCOUNT,
  ]);
  const {
    rows: [previous],
  } = await db.query(PREVIOUS_SQL, [SOURCE, ALERT_NAME]);
  const verdict = decide(overdue, previous);
  if (verdict.action !== 'none') {
    const status = verdict.action === 'fire' ? 'firing' : 'resolved';
    const severity = verdict.action === 'fire' ? 'warning' : 'info';
    const {
      rows: [receipt],
    } = await db.query(
      'SELECT public.fn_record_operational_alert($1,$2,$3,$4,$5,$6::jsonb) AS id',
      [SOURCE, verdict.eventKey, ALERT_NAME, status, severity, JSON.stringify(verdict.payload)]
    );
    if (!receipt || !(Number(receipt.id) > 0))
      throw new Error('operational inbox returned no receipt');
    // Re-read what it filed: a store that drops the row without an error must
    // not read as a recorded incident.
    const {
      rows: [kept],
    } = await db.query(KEPT_SQL, [SOURCE, verdict.eventKey, FLEET_TASK_ID]);
    if (!kept || Number(kept.n) !== 1)
      throw new Error(`operational inbox did not keep ${verdict.eventKey}`);
    console.log(`${status}: operational alert ${receipt.id}`);
  }
  for (const r of overdue) {
    console.error(
      `FAIL  ${r.fault_key}, notified to ${recipient(r.route)}, has no recovery the task can see ` +
        `although the hourly job passed ${r.passed_at}`
    );
  }
  if (verdict.exitCode === 0) {
    console.log(
      `ok    every engine break fault notified since ${OWNED_FROM} and followed by a pass has its recovery`
    );
  }
  return verdict.exitCode;
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
  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();
  try {
    process.exitCode = await run(db);
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`COULD NOT TELL  ${error.message}`);
    process.exit(UNKNOWN);
  });
}
