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
 * TWO NON-VERDICTS THAT ARE NOT INCOMPLETE VERIFICATION (2026-10-07).
 *
 * PostDeployVerificationIncomplete was open from 2026-10-06T00:07Z with more
 * than one hundred deliveries, because two lane shapes that verify nothing AND
 * hide nothing were counted as "unverified" on almost every run:
 *
 *   replaced  A lane GitHub cancelled while it was still QUEUED: a newer run
 *             entered the same concurrency group (cancel-in-progress false
 *             keeps one running and one pending job and replaces the pending
 *             one). It has no runner and no steps, so it never touched
 *             production; the run that replaced it re-targets onto what is
 *             live and carries the verdict. Measured 2026-10-06/07: 41 of 41
 *             cancelled client lanes and 12 of 12 cancelled live-table lanes
 *             had runner_id 0 and zero steps.
 *   not owed  A lane whose own `if:` precondition was false, named by the
 *             workflow in UNOWED_LANES. The Phase 1 cutover seal is the case:
 *             it runs only after both browser lanes certify one exact release,
 *             so a run that did not certify one skips it by design.
 *
 * Neither is a pass either: a run whose only outcome is a replaced lane writes
 * nothing and cannot close an episode. "Replaced" is proved from the run's own
 * job record (runner and steps), never assumed from the word cancelled. When
 * that record cannot be read, the lane is COULD NOT TELL (CLAUDE.md 10.86): it
 * stays counted as unverified, and the payload names it as such, because an
 * unknown is never reported as clean.
 *
 * AN OLDER SUCCESS NEVER CLOSES A NEWER FAILURE (2026-10-07).
 *
 * Run 37620236888, triggered by the publish of b6a260b4, failed at 12:30:18Z and bumped
 * the open episode 240356. Five minutes later run 37616370268, which had been
 * verifying the OLDER release 365b5f5f since 11:46, finished green and wrote
 * row 243237 resolving 240356. Nothing had verified b6a260b4; the newer failure
 * was erased by an older success because "resolve" asked only whether the
 * episode was open, never what the success had covered.
 *
 * Runs finish in any order, so the order of verdicts is read from the release
 * lineage, never the clock. Every failure now leaves an occurrence receipt
 * (status info, kind failed-release) naming the release it failed on, written in
 * the same transaction as the episode bump. A success closes the episode only
 * when its release is the same as, or a descendant of, EVERY release the episode
 * has failed on (git merge-base --is-ancestor, via
 * production-e2e-provenance.mjs). Otherwise it is one of two receipts, never a
 * resolution:
 *
 *   stale          the success covered a release OLDER than one that failed.
 *                  Recorded as kind stale-success; the episode stays open.
 *   could not tell the lineage could not be read, the success named no
 *                  release, or the episode holds deliveries whose release was
 *                  never recorded (an episode opened before this receipt
 *                  existed and bumped more than once). Recorded as kind
 *                  could-not-tell; the episode stays open (CLAUDE.md 10.86).
 *
 * Run:  DATABASE_URL=... WORKFLOW_LABEL=... ALERT_SOURCE=... ALERT_NAME=... RUN_ID=...
 *       GATE_RESULT=... LANES=$'success|Lane A\nskipped|Lane B' \
 *       [UNOWED_LANES=$'Lane B'] [GH_TOKEN=... GITHUB_REPOSITORY=owner/repo] \
 *       node scripts/ci/record-post-deploy-verdict.mjs
 */
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { classifyRepositoryLineage } from './production-e2e-provenance.mjs';

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
 * previous = { event_key, status, investigation_status, head_sha, delivery_count }
 *            | undefined
 * history  = { failedReleases: [{ head_sha, delivery_count }],
 *              relate(failedSha, verdictSha) -> 'same' | 'ancestor' | 'descendant',
 *                throwing when it cannot tell }
 *            The occurrence receipts of the open episode and the lineage
 *            evidence. Without them a success can never close an episode.
 */
export function decide(verdict, previous, history = {}) {
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
  const replaced = [];
  const notOwed = [];
  const couldNotTell = [];
  if (gate && gate.result !== SUCCESS) failed.push(gate.name);
  if (!gateStoodDown) {
    for (const lane of lanes) {
      if (lane.result === SUCCESS) continue;
      // Only a skip can be "not owed": a lane that ran and failed, or was
      // cancelled, failed whatever its precondition says.
      if (lane.result === 'skipped' && lane.owed === false) notOwed.push(lane.name);
      else if (lane.result === 'cancelled' && lane.start === 'replaced') replaced.push(lane.name);
      else if (lane.result === 'skipped') skipped.push(lane.name);
      else {
        failed.push(lane.name);
        if (lane.result === 'cancelled' && lane.start === 'unknown') couldNotTell.push(lane.name);
      }
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
    const eventKey = reusable ? previous.event_key : createHash('sha256').update(identity).digest('hex');
    return {
      action: 'fire',
      exitCode: 0,
      severity: gateFailed ? 'critical' : 'warning',
      eventKey,
      // The episode row keeps its FIRST occurrence's payload, so the release
      // each later failure covered has to be recorded beside it, or a success
      // cannot tell whether it is newer than the failure it would close.
      occurrence: occurrenceReceipt(verdict, eventKey),
      payload: {
        target_task_id: FLEET_TASK_ID,
        workflow: verdict.workflow,
        run_id: String(verdict.runId),
        run_attempt: String(verdict.runAttempt ?? ''),
        run_url: verdict.runUrl || null,
        head_sha: verdict.headSha || null,
        failed_jobs: failed.slice().sort(),
        skipped_jobs: skipped.slice().sort(),
        // Named so a reader can tell "it broke" from "I could not read whether
        // it ever started": both stay loud, only one is a defect on production.
        could_not_tell_jobs: couldNotTell.slice().sort(),
        replaced_jobs: replaced.slice().sort(),
        not_owed_jobs: notOwed.slice().sort(),
        // The 2026-10-05 shape: the gate fails and every lane below it is
        // skipped, so nothing about production was verified at all.
        nothing_verified: gateFailed && skipped.length > 0 && failed.length === 1,
      },
    };
  }

  // Nothing failed, but a lane that never started verified nothing either. It
  // must not close an episode: only a run whose owed lanes all PASSED can say
  // production is verified again.
  if (replaced.length > 0) {
    return {
      action: 'none',
      exitCode: 0,
      reason: `replaced before it started (${replaced.slice().sort().join(', ')}); the run that replaced it carries the verdict`,
    };
  }

  if (previous && previous.status === 'firing' && !CLOSED.includes(previous.investigation_status)) {
    const coverage = coverageOf(verdict.headSha, previous, history);
    const receipt = {
      target_task_id: FLEET_TASK_ID,
      workflow: verdict.workflow,
      run_id: String(verdict.runId),
      run_attempt: String(verdict.runAttempt ?? ''),
      head_sha: verdict.headSha || null,
      not_owed_jobs: notOwed.slice().sort(),
    };
    if (coverage.verdict === 'covers') {
      return {
        action: 'resolve',
        exitCode: 0,
        severity: 'info',
        eventKey: `${previous.event_key}:resolved`,
        payload: { ...receipt, resolves: previous.event_key, covers_failed_releases: coverage.failed },
      };
    }
    const kind = coverage.verdict === 'stale' ? 'stale-success' : 'could-not-tell';
    return {
      action: coverage.verdict === 'stale' ? 'stale' : 'could-not-tell',
      exitCode: 0,
      severity: 'info',
      eventKey: `${previous.event_key}:${kind}:${verdict.runId}:${verdict.runAttempt || '1'}`,
      reason: coverage.reason,
      payload: {
        ...receipt,
        kind,
        episode: previous.event_key,
        // Named so nobody reads this receipt as a resolution: it closes nothing.
        resolves: null,
        reason: coverage.reason,
        newer_failed_releases: coverage.newer || [],
      },
    };
  }

  return { action: 'none', exitCode: 0, reason: 'verification complete; no open episode to close' };
}

/** The receipt a failure leaves for the release it failed on. */
export function occurrenceReceipt(verdict, episodeKey) {
  const head = verdict.headSha || null;
  return {
    eventKey: `${episodeKey}:failed-release:${head || `unknown:${verdict.runId}`}`,
    severity: 'info',
    payload: {
      target_task_id: FLEET_TASK_ID,
      kind: 'failed-release',
      episode: episodeKey,
      workflow: verdict.workflow,
      run_id: String(verdict.runId),
      run_attempt: String(verdict.runAttempt ?? ''),
      head_sha: head,
    },
  };
}

/**
 * Does a success on `headSha` cover every release the open episode failed on?
 *
 *   covers  headSha is the same as, or a descendant of, every failed release.
 *   stale   some failed release is a descendant of headSha: the success is
 *           older than a failure, and must not erase it.
 *   unknown anything that cannot be proved from lineage. Never a pass.
 */
export function coverageOf(headSha, previous, history) {
  const unknown = (reason) => ({ verdict: 'unknown', reason });
  if (!headSha) return unknown('the success names no release, so it cannot be ordered against the failure');
  const relate = history && history.relate;
  const occurrences = history && Array.isArray(history.failedReleases) ? history.failedReleases : null;
  if (typeof relate !== 'function' || occurrences === null) {
    return unknown('the episode history or the lineage evidence was not read');
  }
  // Every delivery of the episode must have a recorded release. An episode
  // opened before occurrence receipts existed has exactly one delivery that
  // its own payload names; any more are failures whose release nobody wrote.
  // A KNOWN newer failure still proves the success stale; the unknowns only
  // ever stop it from covering.
  const recorded = occurrences.reduce((sum, row) => sum + Math.max(0, Number(row.delivery_count) || 0), 0);
  const deliveries = Number(previous.delivery_count);
  const doubts = [];
  let unrecorded = 0;
  if (!Number.isSafeInteger(deliveries) || deliveries < 1) {
    doubts.push('the episode delivery count could not be read');
  } else {
    unrecorded = deliveries - recorded;
    if (unrecorded > 1 || (unrecorded === 1 && !previous.head_sha)) {
      doubts.push(`${unrecorded} failed deliveries of this episode name no release`);
    }
  }
  const failed = [...new Set([
    ...(unrecorded >= 1 && previous.head_sha ? [previous.head_sha] : []),
    ...occurrences.map((row) => row.head_sha),
  ])];
  if (failed.length === 0) doubts.push('the episode records no failed release');
  const newer = [];
  for (const sha of failed) {
    if (!sha) { doubts.push('a failure of this episode named no release'); continue; }
    let relation;
    try {
      relation = relate(sha, headSha);
    } catch (error) {
      doubts.push(`lineage of ${sha} against ${headSha} could not be read: ${error.message}`);
      continue;
    }
    if (relation === 'descendant') newer.push(sha);
    else if (relation !== 'same' && relation !== 'ancestor') {
      doubts.push(`lineage of ${sha} against ${headSha} is ${relation}`);
    }
  }
  if (newer.length > 0) {
    newer.sort();
    return {
      verdict: 'stale',
      newer,
      reason: `the success covered ${headSha}, older than failed release ${newer.join(', ')}`,
    };
  }
  if (doubts.length > 0) return unknown(doubts.join('; '));
  return { verdict: 'covers', failed: failed.filter(Boolean).sort() };
}

/**
 * A SUCCESS SETTLES EVERY OPEN EPISODE IT COVERS, NOT ONLY THE NEWEST (2026-10-07).
 *
 * decide() reads the newest episode. An older episode can still be open beside
 * it: on 2026-10-07 the 13:53Z failure (run 37625799569) minted episode 57e641b3
 * while e951244 (opened 13:12Z on 68b28e5b) was still firing, because the
 * recorder of that hour read an info receipt as "the newest row" and saw no
 * open episode. Nothing would ever have closed e951244. Each other open
 * episode is judged on its own failed releases, by the same rule: only a
 * success that covers all of them resolves it; otherwise it is recorded stale
 * or could-not-tell, and stays open. A failing or non-verdict run settles
 * nothing here.
 *
 * episodes = [{ episode, history }], episode shaped as decide()'s previous.
 */
export function settleOtherEpisodes(verdict, episodes) {
  const settled = [];
  for (const { episode, history } of episodes || []) {
    if (!episode || episode.status !== 'firing' || CLOSED.includes(episode.investigation_status)) continue;
    const outcome = decide(verdict, episode, history);
    if (['resolve', 'stale', 'could-not-tell'].includes(outcome.action)) settled.push(outcome);
  }
  return settled;
}

/**
 * Did each CANCELLED lane ever start? Read from the run's own job record.
 *
 * Returns { [laneName]: 'replaced' | 'started' | 'unknown' } for every name
 * asked about. 'replaced' needs all of: exactly one job by that name in the
 * record, conclusion cancelled, no steps, and no runner. Anything else that
 * ran is 'started'; a missing, duplicated or malformed record is 'unknown'.
 */
export function classifyCancelledLanes(jobsPayload, names) {
  const out = {};
  const jobs = jobsPayload && Array.isArray(jobsPayload.jobs) ? jobsPayload.jobs : null;
  const complete = jobs !== null && Number.isSafeInteger(jobsPayload.total_count)
    && jobsPayload.total_count === jobs.length;
  for (const name of names) {
    if (!complete) { out[name] = 'unknown'; continue; }
    const matches = jobs.filter((job) => job && job.name === name);
    if (matches.length !== 1) { out[name] = 'unknown'; continue; }
    const job = matches[0];
    if (job.conclusion !== 'cancelled' || !Array.isArray(job.steps)) { out[name] = 'unknown'; continue; }
    const noRunner = !(Number(job.runner_id) > 0) && !String(job.runner_name ?? '').trim();
    out[name] = job.steps.length === 0 && noRunner ? 'replaced' : 'started';
  }
  return out;
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
  const unowed = new Set((env.UNOWED_LANES || '').split('\n').map((line) => line.trim()).filter(Boolean));
  for (const name of unowed) {
    if (!lanes.some((lane) => lane.name === name)) throw new Error(`UNOWED_LANES names no lane: ${name}`);
  }
  for (const lane of lanes) if (unowed.has(lane.name)) lane.owed = false;
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

/** Read this run's job record so a cancelled lane can be told apart. */
async function readJobRecord(env) {
  const token = (env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  const repo = (env.GITHUB_REPOSITORY || '').trim();
  const runId = (env.RUN_ID || '').trim();
  const attempt = (env.RUN_ATTEMPT || '1').trim();
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[0-9]+$/.test(runId) || !/^[0-9]+$/.test(attempt)) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(20000) });
    // CLAUDE.md 10.86 rule 2: an unreadable answer is never an empty one.
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function main() {
  const verdict = readVerdict(process.env);
  const cancelled = verdict.lanes.filter((lane) => lane.result === 'cancelled').map((lane) => lane.name);
  if (cancelled.length > 0) {
    const starts = classifyCancelledLanes(await readJobRecord(process.env), cancelled);
    for (const lane of verdict.lanes) if (starts[lane.name]) lane.start = starts[lane.name];
    for (const name of cancelled) console.log(`      cancelled lane ${name}: ${starts[name]}`);
  }
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
    await db.query("SET lock_timeout = '10s'");
    // One transaction: the episode bump and its occurrence receipt land
    // together, and the open episode is locked while a success decides
    // whether it covers it, so a failure cannot slip in between.
    await db.query('BEGIN');
    const { rows: [previous] } = await db.query(
      `SELECT id, event_key, status, investigation_status, delivery_count,
              payload->>'head_sha' AS head_sha
         FROM public.operational_alert_events
        WHERE source = $1 AND alertname = $2 AND status IN ('firing', 'resolved')
        ORDER BY last_received_at DESC, id DESC LIMIT 1
        FOR UPDATE`, [verdict.source, verdict.alertName]);
    const historyOf = async (episodeKey) => {
      const { rows } = await db.query(
        `SELECT payload->>'head_sha' AS head_sha, delivery_count
           FROM public.operational_alert_events
          WHERE source = $1 AND alertname = $2 AND status = 'info'
            AND payload->>'kind' = 'failed-release' AND payload->>'episode' = $3`,
        [verdict.source, verdict.alertName, episodeKey]);
      return { failedReleases: rows, relate: classifyRepositoryLineage };
    };
    const history = previous && previous.status === 'firing' ? await historyOf(previous.event_key) : {};
    const outcome = decide(verdict, previous, history);

    // Every other episode still open beside the newest one (see settleOtherEpisodes).
    const { rows: others } = await db.query(
      `SELECT e.id, e.event_key, e.status, e.investigation_status, e.delivery_count,
              e.payload->>'head_sha' AS head_sha
         FROM public.operational_alert_events e
        WHERE e.source = $1 AND e.alertname = $2 AND e.status = 'firing'
          AND e.investigation_status <> ALL($3::text[])
          AND e.event_key <> $4
          AND NOT EXISTS (SELECT 1 FROM public.operational_alert_events r
                           WHERE r.source = e.source AND r.event_key = e.event_key || ':resolved')
        ORDER BY e.id
        FOR UPDATE OF e`,
      [verdict.source, verdict.alertName, CLOSED, previous ? previous.event_key : '']);
    const earlier = [];
    for (const episode of others) earlier.push({ episode, history: await historyOf(episode.event_key) });
    const settled = settleOtherEpisodes(verdict, earlier);

    const record = async (eventKey, status, severity, payload) => {
      const { rows: [receipt] } = await db.query(
        'SELECT public.fn_record_operational_alert($1,$2,$3,$4,$5,$6::jsonb) AS id',
        [verdict.source, eventKey, verdict.alertName, status, severity, JSON.stringify(payload)]);
      if (!receipt || !(Number(receipt.id) > 0)) throw new Error('operational inbox returned no receipt');
      return receipt.id;
    };
    const statusOf = (action) => (action === 'fire' ? 'firing' : action === 'resolve' ? 'resolved' : 'info');
    const labelOf = (action) => (action === 'stale' ? 'STALE (closes nothing)'
      : action === 'could-not-tell' ? 'COULD NOT TELL (closes nothing)' : statusOf(action));

    let id = null;
    let occurrenceId = null;
    if (outcome.action !== 'none') {
      id = await record(outcome.eventKey, statusOf(outcome.action), outcome.severity, outcome.payload);
      if (outcome.occurrence) {
        occurrenceId = await record(outcome.occurrence.eventKey, 'info', outcome.occurrence.severity,
          outcome.occurrence.payload);
      }
    }
    const settledIds = [];
    for (const other of settled) {
      settledIds.push(await record(other.eventKey, statusOf(other.action), other.severity, other.payload));
    }
    await db.query('COMMIT');

    if (outcome.action === 'none') console.log(`ok    ${outcome.reason}`);
    else console.log(`${labelOf(outcome.action)}: operational alert ${id} (${verdict.source}/${verdict.alertName})`);
    if (outcome.action !== 'none' && outcome.reason) console.log(`      ${outcome.reason}`);
    if (outcome.action === 'fire') {
      console.log(`      failed release receipt: ${occurrenceId} (${outcome.occurrence.payload.head_sha || 'release unknown'})`);
      console.log(`      failed: ${outcome.payload.failed_jobs.join(', ') || 'none'}`);
      console.log(`      skipped: ${outcome.payload.skipped_jobs.join(', ') || 'none'}`);
      console.log(`      could not tell: ${outcome.payload.could_not_tell_jobs.join(', ') || 'none'}`);
    }
    settled.forEach((other, i) => {
      console.log(`${labelOf(other.action)}: earlier open episode ${other.payload.resolves || other.payload.episode} -> alert ${settledIds[i]}`);
      if (other.reason) console.log(`      ${other.reason}`);
    });
    const unclosed = [outcome, ...settled].filter((o) => o.action === 'stale' || o.action === 'could-not-tell');
    if (process.env.GITHUB_STEP_SUMMARY && unclosed.length > 0) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, unclosed
        .map((o) => `${labelOf(o.action)}: this success did not close episode ${o.payload.episode}. ${o.reason}\n`)
        .join(''));
    }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`COULD NOT TELL  ${error.message}`); process.exit(UNKNOWN); });
}
