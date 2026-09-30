/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A SKIPPED RUN IS NOT A GREEN RUN
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `check-main-is-green.mjs` grouped every completed run on `main` by workflow,
 * took the newest one, and reported the workflow only when THAT run had
 * `conclusion === 'failure'`. Its own success line said the quiet part:
 *
 *     "OK - every workflow's latest run on main is green or neutral."
 *
 * Neutral was being counted as health. It is not health, it is the absence of
 * evidence, and the two are only the same when nothing ever skips.
 *
 * ── MEASURED, 2026-09-09 ─────────────────────────────────────────────────────
 * `Post-Deploy E2E (production)` had failed **24 times in 21 hours with no
 * success at all**, and the detector had never once named it. It is a
 * `workflow_run` listener with a concurrency group, so most of its runs end
 * `skipped` (the publish it listens for concluded something other than success)
 * or `cancelled` (a newer run took the lock). In a 300-run window it had 46
 * runs, of which **7 carried a verdict and all 7 were failures** - and the
 * newest run, the only one the detector read, was `cancelled`.
 *
 * That is not a tuning problem. Any workflow whose runs interleave skips with
 * failures is STRUCTURALLY invisible to "is the newest run a failure", and
 * event-driven workflows interleave by construction. The consecutive-failure
 * walk had the same hole one line further down: it `break`s on any non-failure,
 * so a single skip between two failures reset the clock to zero and put the
 * workflow back under the threshold.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 * Only a run that reached a VERDICT is evidence about a workflow's health.
 * `success` says green. `failure`, `timed_out` and `startup_failure` say red -
 * the last two were also invisible before, because only the literal string
 * 'failure' counted. `skipped`, `cancelled`, `neutral`, `action_required` and
 * `stale` say nothing at all, and are stepped over rather than believed.
 *
 * ── WHY THE DURATION SAYS "AT LEAST" ─────────────────────────────────────────
 * The caller reads a fixed window of recent runs. A noisy workflow can fill it
 * on its own - Post-Deploy E2E was 46 of 300 - so the oldest failure visible is
 * often not the first one. When the walk consumes every verdict in the window
 * without finding a success, the true duration is longer than measured, and the
 * report says so instead of quoting a number it cannot support. It errs toward
 * under-reporting, never toward a louder alarm than the evidence carries.
 */

/** A run that reached one of these told us something about the workflow. */
export const GREEN = 'success';

/**
 * Red verdicts. `timed_out` and `startup_failure` are failures that the old
 * equality check on the literal 'failure' let through untouched.
 */
export const BAD_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);

/** Everything that counts as evidence either way. */
export const VERDICT_CONCLUSIONS = new Set([GREEN, ...BAD_CONCLUSIONS]);

/**
 * The durable main-health issue records, in two independent machine-readable
 * facts, which workflows THIS detector is currently reporting: the exact label
 * and the exact per-workflow marker below. A title/body substring is human
 * prose, not durable ownership.
 *
 * IT IS A RECEIPT, NOT A MUTE SWITCH. See `classifyRedState` below - a marker
 * this detector wrote is never a reason for this detector to go quiet.
 */
export const MAIN_HEALTH_READER_LABEL = 'main-health-reader';
const MAIN_HEALTH_MARKER_PREFIX = '<!-- club-arena:main-health-reader:v1 workflow=';

export function workflowAlarmMarker(name) {
  const identity = Buffer.from(String(name), 'utf8').toString('base64url');
  return `${MAIN_HEALTH_MARKER_PREFIX}${identity} -->`;
}

export function issueCarriesWorkflowAlarm(issue, workflowName, since) {
  const sinceMs = new Date(since).getTime();
  const touchedMs = new Date(issue?.updated_at).getTime();
  if (!Number.isFinite(sinceMs) || !Number.isFinite(touchedMs) || touchedMs < sinceMs) {
    return false;
  }

  const labels = Array.isArray(issue?.labels)
    ? issue.labels.map((label) => (typeof label === 'string' ? label : label?.name))
    : [];
  if (!labels.includes(MAIN_HEALTH_READER_LABEL)) return false;

  return String(issue?.body || '').includes(workflowAlarmMarker(workflowName));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  "TRACKED" IS NOT "FINE", AND A DETECTOR MAY NOT MUTE ITSELF (2026-09-30)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `check-main-is-green.mjs` used to write one line:
 *
 *     for (const r of red) r.loud = hasOpenAlarm(r.name, r.since);
 *
 * and then alarm only on `!r.loud`. The exemption was written for ONE case
 * (CLAUDE.md 10.83): a production audit that exits non-zero in order to RAISE
 * an alarm is doing its job, and reporting it as a defect would teach everyone
 * to ignore this detector inside a week. That reasoning is sound. Inferring it
 * from "an open issue names this workflow" is not.
 *
 * ── THE LOOP, MEASURED 2026-09-30 ───────────────────────────────────────────
 * `hasOpenAlarm` only ever matches the `main-health-reader` label and the
 * marker in `workflowAlarmMarker` - and THIS DETECTOR IS THE ONLY THING THAT
 * WRITES EITHER. The alarm step copies the whole detector log into issue
 * #4332, the log prints a marker for every red workflow, and the next run reads
 * those markers back as "somebody is already being told".
 *
 * So the detector suppressed itself with its own output. Issue #4332 carried
 * markers for TEN workflows, every one of them consequently muted:
 *
 *     Applied Migrations Are Recorded      50 consecutive, >=29.9 days, never green in window
 *     Estate Integrity                     65 consecutive, 21.5 days
 *     Production Integrity Audit           96 consecutive, >=19.0 days
 *     Trusted Money Trigger Recovery       11 consecutive, 12.4 days
 *     Telemetry Exposure                   14 consecutive,  6.8 days
 *     Post-Deploy E2E (production)         58 consecutive, >=36.8 hours
 *     Cron Health                           9 consecutive,  2.8 days
 *     Schema Integrity Audit               14 consecutive,  2.5 days
 *     Auto-Deploy Hetzner Engine, Settlement Lane Doctrine
 *
 * The job printed "At least one failure is fresh or already tracked; retaining
 * the alarm" and exited 0. `Nothing is silently red on main` was GREEN while
 * ten workflows were red and one of them had not been green in a month.
 *
 * Not one of those ten is an audit whose red is merely its product. Every one
 * is a real defect or a real un-cleared backlog. The exemption had no
 * legitimate beneficiary at all; it was pure suppression.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * A marker THIS detector wrote is a RECEIPT - "I am reporting this" - and is
 * never a reason for this detector to stay quiet. It is kept, because knowing
 * a failure is not new is worth reporting, but it is reported and never
 * subtracted.
 *
 * The 10.83 exemption survives, narrowed to exactly what it was always for and
 * written down instead of inferred: a workflow whose red IS how it delivers a
 * finding to a reader declares itself in `SELF_ALARMING_WORKFLOWS`, naming the
 * label of the issue IT files, and is exempt only while such an issue is open
 * and has been touched since this failure episode began. Declared but not
 * currently speaking is not exempt - a self-alarming workflow that has gone
 * quiet is the 10.83 bug itself.
 *
 * AGE ESCALATES, IT NEVER MUTES. `check-main-is-green.mjs` orders the report
 * oldest-first and the annotation names the worst, so a month-old failure
 * reads louder than a fresh one instead of disappearing behind it.
 */
export const RED_STATE = {
  /** Declared self-alarming AND currently carrying its own open issue. */
  SELF_ALARMING: 'self-alarming',
  /** Past the threshold, and the durable main-health issue already names it. */
  TRACKED: 'tracked',
  /** Past the threshold with nothing naming it at all. */
  SILENT: 'SILENT',
  /** Red, but not yet past the threshold - somebody is probably mid-fix. */
  FRESH: 'fresh',
};

/**
 * Workflows whose red run is itself the delivery of a finding to a named
 * reader, and which therefore must not be reported as a defect.
 *
 * DELIBERATELY EMPTY, and that is a measurement rather than an oversight. All
 * ten workflows the inferred exemption was muting on 2026-09-30 are real
 * defects or real backlogs; none qualified. An entry here is a reviewed
 * repository change that must state:
 *
 *     name -> { reason, declaredOn, alarmLabel }
 *
 * `alarmLabel` is the label on the issue THAT WORKFLOW files. It may never be
 * MAIN_HEALTH_READER_LABEL: this detector's own issue cannot be the evidence
 * that somebody else is watching.
 *
 * The bar is high on purpose. A workflow that files its own issue for ONE of
 * its failure modes is still silent for the others - a script that exits 2
 * because it could not reach the database files nothing - and exempting the
 * workflow wholesale is how the Deploy Monitoring refusal in 10.83 reached
 * nobody.
 */
export const SELF_ALARMING_WORKFLOWS = new Map([]);

/**
 * How a red workflow should be reported, and whether it alarms.
 *
 * `tracked` says the durable main-health issue already names it; it changes
 * the WORD in the report and nothing else. `selfAlarmed` says an open issue
 * carrying this workflow's own declared `alarmLabel` was touched since the
 * episode began.
 */
export function classifyRedState(
  red,
  { tracked = false, selfAlarmed = false, thresholdHours, registry = SELF_ALARMING_WORKFLOWS } = {}
) {
  const declared = registry.get(red?.name) || null;
  if (declared && selfAlarmed) {
    return { state: RED_STATE.SELF_ALARMING, alarms: false, declared };
  }
  if (!(red?.hours >= thresholdHours)) {
    return { state: RED_STATE.FRESH, alarms: false, declared: null };
  }
  return {
    state: tracked ? RED_STATE.TRACKED : RED_STATE.SILENT,
    alarms: true,
    declared: null,
  };
}

/** Did this run actually decide anything? */
export function isVerdict(run) {
  return VERDICT_CONCLUSIONS.has(run?.conclusion);
}

/** Newest-first list of only the runs that carry a verdict. */
export function verdictRuns(list) {
  return list.filter(isVerdict);
}

/**
 * Classify one workflow's runs (newest first). Returns null when the workflow
 * is healthy or when the window holds no verdict for it at all - "no evidence"
 * is not an alarm, it is a question, and this detector does not page on
 * questions.
 */
export function classifyWorkflow(name, list, now = Date.now()) {
  const verdicts = verdictRuns(list);
  const latest = verdicts[0];
  if (!latest || !BAD_CONCLUSIONS.has(latest.conclusion)) return null;

  let consecutive = 0;
  let firstBad = latest;
  for (const run of verdicts) {
    if (!BAD_CONCLUSIONS.has(run.conclusion)) break;
    consecutive += 1;
    firstBad = run;
  }

  const lastGreen = verdicts.find((r) => r.conclusion === GREEN);

  return {
    name,
    consecutive,
    hours: (now - new Date(firstBad.created_at).getTime()) / 3_600_000,
    since: firstBad.created_at,
    url: latest.html_url,
    lastGreen: lastGreen ? lastGreen.created_at : null,
    seen: list.length,
    verdicts: verdicts.length,
    // Every verdict in the window was bad, so the first one we can see is
    // probably not the first one there was.
    windowLimited: consecutive === verdicts.length,
  };
}

/** Group a flat newest-first run list by workflow name. */
export function groupByWorkflow(runs) {
  const byWorkflow = new Map();
  for (const run of runs) {
    if (!byWorkflow.has(run.name)) byWorkflow.set(run.name, []);
    byWorkflow.get(run.name).push(run);
  }
  return byWorkflow;
}

/** Every workflow whose latest VERDICT was red. */
export function redWorkflows(runs, now = Date.now()) {
  const out = [];
  for (const [name, list] of groupByWorkflow(runs)) {
    const verdict = classifyWorkflow(name, list, now);
    if (verdict) out.push(verdict);
  }
  return out;
}

/**
 * Enumerate the repository's active workflows first, then read a private run
 * window for each one. A single repository-wide run window lets noisy jobs
 * evict a low-frequency workflow completely, which can turn an old red into a
 * false all-clear.
 *
 * An active workflow with zero completed main runs is not applicable (for
 * example, a pull-request-only workflow) and is reported separately. A
 * nonempty run history with no success/failure verdict is unknown, never green.
 * The caller maps that thrown outcome to its distinct UNKNOWN exit code so it
 * cannot close a durable alarm.
 */
export async function collectActiveWorkflowRuns(api, repository, branch) {
  const perPage = 100;
  const maxInventoryPages = 100;
  const maxRunPages = 3;
  const discovered = [];

  for (let page = 1; page <= maxInventoryPages; page += 1) {
    const payload = await api(
      `/repos/${repository}/actions/workflows?per_page=${perPage}&page=${page}`
    );
    if (!Array.isArray(payload?.workflows)) {
      throw new Error(`active workflow inventory page ${page} was unreadable`);
    }
    discovered.push(...payload.workflows);
    if (payload.workflows.length < perPage) break;
    if (page === maxInventoryPages) {
      throw new Error('active workflow inventory exceeded the safe pagination bound');
    }
  }

  const byId = new Map();
  for (const workflow of discovered) {
    if (workflow?.state !== 'active') continue;
    const name = typeof workflow?.name === 'string' ? workflow.name.trim() : '';
    if ((typeof workflow?.id !== 'number' && typeof workflow?.id !== 'string') || !name) {
      throw new Error('active workflow inventory contained an unreadable identity');
    }
    byId.set(String(workflow.id), { ...workflow, name });
  }
  const workflows = [...byId.values()];
  if (workflows.length === 0) {
    throw new Error('active workflow inventory was empty');
  }

  const runs = [];
  const notApplicable = [];
  for (const workflow of workflows) {
    const workflowRuns = [];
    for (let page = 1; page <= maxRunPages; page += 1) {
      const payload = await api(
        `/repos/${repository}/actions/workflows/${encodeURIComponent(String(workflow.id))}` +
          `/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=${perPage}&page=${page}`
      );
      if (!Array.isArray(payload?.workflow_runs)) {
        throw new Error(`completed runs for active workflow "${workflow.name}" were unreadable`);
      }
      const batch = payload.workflow_runs.map((run) => ({ ...run, name: workflow.name }));
      workflowRuns.push(...batch);
      if (batch.length < perPage) break;
    }

    if (workflowRuns.length === 0) {
      notApplicable.push(workflow);
      continue;
    }
    if (!workflowRuns.some(isVerdict)) {
      throw new Error(`active workflow "${workflow.name}" has no completed verdict on ${branch}`);
    }
    runs.push(...workflowRuns);
  }

  runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return { workflows, notApplicable, runs };
}
