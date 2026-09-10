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
