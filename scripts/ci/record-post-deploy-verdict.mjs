#!/usr/bin/env node
/**
 * A production-verification run must admit its own verdict to the operational
 * inbox before it ends.
 *
 * On 2026-10-05 post-deploy-e2e.yml failed four times in 69 minutes — runs
 * 37361302553, 37363764720, 37365802796 and 37368847647 — at the job
 * "Confirm The Hetzner Web Publish Reached Production", step
 * "Read The Origin Job Verdict". That failure left every downstream lane
 * (client browser, live-table and engine, SEO contract, cutover seal) SKIPPED,
 * so the publish on main 6953271d stood 69 minutes with no confirmation it had
 * reached production and no live verification at all. public.operational_alert_events
 * received NOTHING for any of the four: a later run went green and the whole
 * episode cleared itself without one person or one fleet lane ever learning it
 * had happened. deploy-monitoring.yml has the same hole and reports a red
 * monitoring deploy only as a red check run.
 *
 * This records that verdict. It is gated on always() so a FAILED, CANCELLED or
 * wholly SKIPPED verification still admits — if: failure() would have missed
 * three of the four 2026-10-05 runs, whose downstream jobs did not fail, they
 * never ran. It adds no timer and no watcher (CLAUDE.md 10.85): it rides the
 * run whose verdict it is reporting.
 *
 * It is a reporter, not a gate. It never turns a green run red and never
 * suppresses the real failure, which is already red on its own job. It exits
 * non-zero only when it could not record — an unadmitted verdict is the one
 * failure this file exists to prevent (CLAUDE.md 10.86: unknown is never
 * reported as clean).
 *
 * While an episode is firing and the fleet has not closed it, later occurrences
 * reuse its identity, so a repeated failure bumps delivery_count instead of
 * minting another open row; fn_record_operational_alert's ON CONFLICT updates
 * last_received_at and delivery_count only, so the payload is the first
 * occurrence's and later run ids are in this job's own log. A recovery is
 * recorded ONLY to close an episode that is actually open: a green run against
 * no open episode writes nothing, because a store that mints a row every time
 * something succeeds is the reason 78.9 pct of the open backlog is already
 * status=resolved.
 *
 * Run:  DATABASE_URL=... WORKFLOW_LABEL=... ALERT_SOURCE=... ALERT_NAME=... RUN_ID=...
 *       GATE_RESULT=... LANES=$'success|Lane A\nskipped|Lane B' \
 *       node scripts/ci/record-post-deploy-verdict.mjs
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const FLEET_TASK_ID = '01a09b86-5ba8-7290-8657-1041f13dd3ca';
export const UNKNOWN = 3;
export const CLOSED = ['verified_fixed', 'historical'];
/** A lane that reached none of these did not verify anything. */
export const SUCCESS = 'success';

/**
 * Pure decision, exported for the regression test.
 *
 * verdict = { workflow, source, alertName, runId, runAttempt, runUrl, headSha,
 *             gate: { name, result, shouldRun } | null,
 *             lanes: [{ name, result }] }
 * previous = { event_key, status, investigation_status } | undefined
 */
export function decide(verdict, previous) {
  const lanes = verdict.lanes || [];
  const gate = verdict.gate || null;

  // A publisher that stood down because the origin already serves a newer
  // bundle is not a fault: the gate SUCCEEDS and simply never sets should_run,
  // and every lane skips by design. Reporting that would alarm on every
  // supersede. A gate that FAILED or was CANCELLED is the opposite case — it is
  // exactly the 2026-10-05 incident — and it never gets to write should_run at
  // all, which is why this cannot be keyed on should_run alone.
  const gateStoodDown = gate && gate.result === SUCCESS && gate.shouldRun !== 'true';

  const failed = [];
  const skipped = [];
  if (gate && gate.result !== SUCCESS) failed.push(gate.name);
  if (!gateStoodDown) {
    for (const lane of lanes) {
      if (lane.result === SUCCESS) continue;
      if (lane.result === 'skipped') skipped.push(lane.name);
      else failed.push(lane.name);
    }
  }

  const unverified = failed.length > 0 || skipped.length > 0;

  if (gateStoodDown && !failed.length) {
    return { action: 'none', exitCode: 0, reason: 'publisher stood down; nothing to verify' };
  }

  if (unverified) {
    const gateFailed = Boolean(gate) && gate.result !== SUCCESS;
    // Identity carries run id, head sha and the failing jobs, as the intake
    // record of 2026-10-05T22:01:53Z requires, so two distinct occurrences are
    // two incidents and never collapse onto one another.
    const identity = [verdict.source, verdict.runId, verdict.headSha,
      failed.slice().sort().join(','), skipped.slice().sort().join(',')].join(':');
    const reusable = previous && previous.status === 'firing'
      && !CLOSED.includes(previous.investigation_status);
    return {
      action: 'fire',
      exitCode: 0,
      severity: gateFailed ? 'critical' : 'warning',
      eventKey: reusable ? previous.event_key : createHash('sha256').update(identity).digest('hex'),
      payload: {
        target_task_id: FLEET_TASK_ID,
        workflow: verdict.workflow,
        run_id: String(verdict.runId),
        run_attempt: String(verdict.runAttempt ?? ''),
        run_url: verdict.runUrl || null,
        head_sha: verdict.headSha || null,
        failed_jobs: failed.slice().sort(),
        skipped_jobs: skipped.slice().sort(),
        // The 2026-10-05 shape: the gate fails and every lane below it is
        // skipped, so nothing about production was verified at all.
        nothing_verified: gateFailed && skipped.length > 0 && failed.length === 1,
      },
    };
  }

  if (previous && previous.status === 'firing' && !CLOSED.includes(previous.investigation_status)) {
    return {
      action: 'resolve',
      exitCode: 0,
      severity: 'info',
      eventKey: `${previous.event_key}:resolved`,
      payload: {
        target_task_id: FLEET_TASK_ID,
        workflow: verdict.workflow,
        run_id: String(verdict.runId),
        head_sha: verdict.headSha || null,
        resolves: previous.event_key,
      },
    };
  }

  return { action: 'none', exitCode: 0, reason: 'verification complete; no open episode to close' };
}

/**
 * Env -> verdict. Exported so the test exercises the real parsing.
 *
 * Discrete variables on purpose. An earlier draft built one VERDICT_JSON in the
 * workflow with fromJSON(format(...)); a reporter whose own template can be
 * malformed is a reporter that goes silent exactly when something else is
 * already broken, which is the defect this file exists to remove.
 *
 * LANES is one lane per line, "result|name", because a job result never
 * contains a pipe and a job name may contain spaces.
 */
export function readVerdict(env) {
  const need = (key) => {
    const value = (env[key] || '').trim();
    if (!value) throw new Error(`${key} is missing`);
    return value;
  };
  const lanes = (env.LANES || '').split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const cut = line.indexOf('|');
      if (cut < 1 || cut === line.length - 1) throw new Error(`LANES line is not result|name: ${line}`);
      return { result: line.slice(0, cut).trim(), name: line.slice(cut + 1).trim() };
    });
  const gateResult = (env.GATE_RESULT || '').trim();
  return {
    workflow: need('WORKFLOW_LABEL'),
    source: need('ALERT_SOURCE'),
    alertName: need('ALERT_NAME'),
    runId: need('RUN_ID'),
    runAttempt: (env.RUN_ATTEMPT || '').trim(),
    runUrl: (env.RUN_URL || '').trim() || null,
    headSha: (env.HEAD_SHA || '').trim() || null,
    gate: gateResult
      ? { name: (env.GATE_NAME || '').trim() || 'gate', result: gateResult, shouldRun: (env.GATE_SHOULD_RUN || '').trim() }
      : null,
    lanes,
  };
}

async function main() {
  const verdict = readVerdict(process.env);
  if (!process.env.DATABASE_URL) {
    console.error('COULD NOT TELL  DATABASE_URL is missing; a verdict that was not admitted is not a pass');
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
    const { rows: [previous] } = await db.query(
      `SELECT event_key, status, investigation_status FROM public.operational_alert_events
        WHERE source = $1 AND alertname = $2
        ORDER BY last_received_at DESC, id DESC LIMIT 1`, [verdict.source, verdict.alertName]);
    const outcome = decide(verdict, previous);
    if (outcome.action === 'none') {
      console.log(`ok    ${outcome.reason}`);
      return;
    }
    const status = outcome.action === 'fire' ? 'firing' : 'resolved';
    const { rows: [receipt] } = await db.query(
      'SELECT public.fn_record_operational_alert($1,$2,$3,$4,$5,$6::jsonb) AS id',
      [verdict.source, outcome.eventKey, verdict.alertName, status, outcome.severity,
        JSON.stringify(outcome.payload)]);
    if (!receipt || !(Number(receipt.id) > 0)) throw new Error('operational inbox returned no receipt');
    console.log(`${status}: operational alert ${receipt.id} (${verdict.source}/${verdict.alertName})`);
    if (outcome.action === 'fire') {
      console.log(`      failed: ${outcome.payload.failed_jobs.join(', ') || 'none'}`);
      console.log(`      skipped: ${outcome.payload.skipped_jobs.join(', ') || 'none'}`);
    }
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`COULD NOT TELL  ${error.message}`); process.exit(UNKNOWN); });
}
