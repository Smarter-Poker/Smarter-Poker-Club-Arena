#!/usr/bin/env node
/**
 * The World Hub's openclaw-cron-dispatcher.py ALL_CRONS list and this
 * database's ca_retired_cron_jobs registry must agree, in both directions.
 *
 * On 2026-09-16 World Hub PR #1812 removed /api/clawbot/orchestrator from
 * ALL_CRONS but never added a ca_retired_cron_jobs row, so
 * v_openclaw_job_staleness treated a deliberately-retired job as newly
 * silent for eight days (fixed in
 * 20260926171100_a_retired_error_providers_orchestrator_stays_retired.sql).
 * This check is the general form of that fix: it catches BOTH that class of
 * miss (a job the dispatcher dropped that the registry never heard about)
 * AND its mirror (a job this registry calls retired that the dispatcher
 * quietly brought back), so neither direction can go unnoticed again.
 *
 * It reads the dispatcher source straight from GitHub (both repos are
 * public, so no cross-repo credential is needed) and compares it against
 * two live reads: every ca_retired_cron_jobs row that recorded a
 * dispatcher_path, and every job v_openclaw_job_staleness currently reports
 * is_stale with real history (successes_30d >= 5).
 *
 * The "unregistered" direction is a best-effort presence check (a job's
 * dispatch path is not always syntactically derivable from its job_name --
 * clawbot-orchestrator itself is the counterexample), so it can miss a
 * renamed job; it does not fabricate a match, so it does not false-positive
 * on one either. The "reactivated" direction is exact: it only fires on a
 * dispatcher_path this migration or a later one explicitly recorded.
 *
 * Exit 0: both directions agree. Exit 1: a mismatch was found (and recorded
 * as one fleet-addressed incident, resolving the same way once clean).
 * Exit 3: COULD NOT TELL (CLAUDE.md 10.86) -- the dispatcher fetch failed or
 * the database was unreachable; never reported as a pass.
 *
 * Run: DATABASE_URL=... node scripts/ci/check-retired-cron-jobs-match-dispatcher.mjs
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const FLEET_TASK_ID = '01a09b86-5ba8-7290-8657-1041f13dd3ca';
export const SOURCE = 'production-integrity-audit';
export const ALERT_NAME = 'OpenClawRetiredRegistryDispatcherMismatch';
export const UNKNOWN = 3;
export const CLOSED = ['verified_fixed', 'historical'];
export const DISPATCHER_URL =
  'https://raw.githubusercontent.com/Smarter-Poker/Smarter-Poker-World-Hub/main/scripts/openclaw-cron-dispatcher.py';

/** True when `path` is dispatched as a live ALL_CRONS entry in `source`. */
export function isActiveInDispatcher(source, path) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[ \\t]*\\(\\s*'${escaped}'`, 'm').test(source);
}

/** Loose best-effort presence check for a job's slug in the dispatcher text. */
export function slugAppearsAnywhere(source, jobName) {
  const slug = jobName.split('/').filter(Boolean).pop();
  const candidates = [jobName, jobName.replace(/^\/cron\//, '/api/cron/'), slug];
  return candidates.some((c) => c && source.includes(c));
}

/** Pure decision, exported for the regression test. */
export function diff(dispatcherSource, retiredRows, staleCandidates) {
  const reactivated = retiredRows
    .filter((r) => r.dispatcher_path && isActiveInDispatcher(dispatcherSource, r.dispatcher_path))
    .map((r) => r.job_name);
  const unregistered = staleCandidates
    .filter((c) => !slugAppearsAnywhere(dispatcherSource, c.job_name))
    .map((c) => c.job_name);
  return { reactivated, unregistered };
}

/** Pure decision, exported for the regression test. */
export function decide(mismatch, previous) {
  const total = mismatch.reactivated.length + mismatch.unregistered.length;
  if (total > 0) {
    const identity = [
      ...mismatch.reactivated.map((j) => `reactivated:${j}`),
      ...mismatch.unregistered.map((j) => `unregistered:${j}`),
    ].sort().join('|');
    const reusable = previous && previous.status === 'firing'
      && !CLOSED.includes(previous.investigation_status);
    const eventKey = reusable
      ? previous.event_key
      : createHash('sha256').update(identity).digest('hex');
    return {
      action: 'fire',
      exitCode: 1,
      eventKey,
      payload: { target_task_id: FLEET_TASK_ID, ...mismatch },
    };
  }
  if (previous && previous.status === 'firing' && !CLOSED.includes(previous.investigation_status)) {
    return {
      action: 'resolve',
      exitCode: 0,
      eventKey: `${previous.event_key}:resolved`,
      payload: { target_task_id: FLEET_TASK_ID, resolves: previous.event_key },
    };
  }
  return { action: 'none', exitCode: 0 };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('COULD NOT TELL  DATABASE_URL is missing; an unavailable answer is not a pass');
    process.exit(UNKNOWN);
  }

  let dispatcherSource;
  try {
    const res = await fetch(DISPATCHER_URL);
    if (!res.ok) throw new Error(`dispatcher fetch returned HTTP ${res.status}`);
    dispatcherSource = await res.text();
    if (!dispatcherSource.includes('ALL_CRONS = [')) {
      throw new Error('fetched dispatcher source has no ALL_CRONS list -- wrong content or a bad fetch');
    }
  } catch (error) {
    console.error(`COULD NOT TELL  ${error.message}`);
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
    const { rows: retiredRows } = await db.query(
      `SELECT job_name, dispatcher_path FROM public.ca_retired_cron_jobs WHERE dispatcher_path IS NOT NULL`);
    const { rows: staleCandidates } = await db.query(
      `SELECT job_name FROM public.v_openclaw_job_staleness WHERE is_stale AND successes_30d >= 5`);
    const mismatch = diff(dispatcherSource, retiredRows, staleCandidates);
    const { rows: [previous] } = await db.query(
      `SELECT event_key, status, investigation_status FROM public.operational_alert_events
        WHERE source = $1 AND alertname = $2
        ORDER BY last_received_at DESC, id DESC LIMIT 1`, [SOURCE, ALERT_NAME]);
    const verdict = decide(mismatch, previous);
    if (verdict.action !== 'none') {
      const status = verdict.action === 'fire' ? 'firing' : 'resolved';
      const severity = verdict.action === 'fire' ? 'warning' : 'info';
      const { rows: [receipt] } = await db.query(
        'SELECT public.fn_record_operational_alert($1,$2,$3,$4,$5,$6::jsonb) AS id',
        [SOURCE, verdict.eventKey, ALERT_NAME, status, severity, JSON.stringify(verdict.payload)]);
      if (!receipt || !(Number(receipt.id) > 0)) throw new Error('operational inbox returned no receipt');
      console.log(`${status}: operational alert ${receipt.id}`);
    }
    for (const j of mismatch.reactivated) {
      console.error(`FAIL  ${j} is registered retired but is live again in the dispatcher`);
    }
    for (const j of mismatch.unregistered) {
      console.error(`FAIL  ${j} has gone silent and is absent from the dispatcher but has no retirement row`);
    }
    if (verdict.exitCode === 0) console.log('ok    the retired-cron registry and the World Hub dispatcher agree');
    process.exitCode = verdict.exitCode;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`COULD NOT TELL  ${error.message}`); process.exit(UNKNOWN); });
}
