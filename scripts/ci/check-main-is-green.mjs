/**
 * A CHECK THAT IS RED ON main AND BLOCKS NOBODY STOPS BEING A CHECK.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * `Global Footer E2E` failed on EVERY run on `main` from 2026-09-04 onward. It
 * was found on 2026-09-06, by accident, while looking at something else.
 *
 * Nothing was broken about the alerting, because there was none. The workflow
 * is not in the `main: no rewinds` ruleset, so a red run blocks no merge, opens
 * no issue and turns nothing a colour anyone looks at. Twenty-odd merges landed
 * on top of it.
 *
 * And when it was finally read, none of the three failures was in the footer.
 * Every footer assertion passed. They were marketplace tests that `npm run
 * build` runs before Next: a retired Daily Pass still pinned by a test, a
 * `annual` -> `yearly` rename applied to the code and not to its test, and two
 * em dashes. All three were changed correctly and left one half behind - which
 * is the ordinary way a repo goes red, and precisely why somebody has to be
 * told.
 *
 * REQUIRED checks cannot reach this state: a red one blocks the merge queue and
 * an agent finds out in minutes. So this detector exists for the others, and
 * the others are the majority.
 *
 * ── WHAT IT DOES ─────────────────────────────────────────────────────────────
 * Ask GitHub for every active workflow, then fetch completed `main` runs for
 * each workflow independently. A noisy workflow therefore cannot evict a
 * low-frequency workflow from one shared run window. Report any workflow whose
 * newest verdict FAILED, with how long it has been failing and over how many
 * consecutive verdicts. Exits non-zero when anything is over the threshold, so
 * the caller can raise one issue naming all of them.
 *
 * Deliberately NOT a list of blessed exceptions. A workflow allowed to be red
 * is a workflow that should be deleted or fixed, and an allowlist here would
 * become the place failures go to be forgotten - which is the bug.
 *
 * ── LOUD FAILURES ARE NOT THE TARGET ─────────────────────────────────────────
 * Some workflows fail ON PURPOSE: a production audit can exit non-zero to RAISE
 * an alarm, and when it does it opens or updates a tracked issue. Its red is the
 * product, not a defect, and the first run of this detector flagged it - which
 * would have taught everyone to ignore this detector inside a week.
 *
 * So the discriminator is not "is it red" but "is anybody being told". A
 * failing workflow with an open issue touched since the failures began is
 * already speaking for itself and is reported as `loud`. A failing workflow
 * with nothing open is `SILENT`, and silent is the only thing that alarms.
 * That is the distinction the Global Footer E2E case was made of.
 *
 * Usage:
 *   node scripts/ci/check-main-is-green.mjs                # 6h threshold
 *   MAIN_RED_HOURS=24 node scripts/ci/check-main-is-green.mjs
 *
 * Needs GITHUB_TOKEN (Actions: read) and GITHUB_REPOSITORY, both of which a
 * workflow already has.
 */
import process from 'node:process';

import {
  collectActiveWorkflowRuns,
  groupByWorkflow,
  issueCarriesWorkflowAlarm,
  MAIN_HEALTH_READER_LABEL,
  redWorkflows,
  workflowAlarmMarker,
} from './lib/workflowVerdicts.mjs';

const REPO = process.env.GITHUB_REPOSITORY || '';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const HOURS = Number(process.env.MAIN_RED_HOURS || 6);
const BRANCH = process.env.MAIN_RED_BRANCH || 'main';

/**
 * ── THREE OUTCOMES, BECAUSE TWO CLOSED A REAL ALARM (2026-09-07) ────────────
 *
 * This file used to exit 0 on every unreadable answer - no token, an API
 * error, an empty run list - with the reasoning that "a watchdog that cannot
 * ask is not a failure". That reasoning is sound about PAGING and wrong about
 * everything else, because exit 0 is not silence here. The workflow reads it:
 *
 *     - name: Close it when main is green again
 *       if: always() && steps.main-green.outputs.code == '0'
 *
 * So one HTTP 502 from `/actions/runs` CLOSED the open issue about a workflow
 * that was still red, with the comment "Every workflow's latest run on main is
 * green again." A watchdog that cannot look is not entitled to say the coast
 * is clear.
 *
 * 10.86 rule 1: "I could not tell" is a distinct outcome and must have its own
 * name. Exit 3 - never 0, never 1. The workflow reports it and touches no
 * issue either way.
 */
const UNKNOWN = 3;

if (!REPO) {
  console.error('COULD NOT TELL: no GITHUB_REPOSITORY, so no Club Arena run was read.');
  process.exit(UNKNOWN);
}

if (!TOKEN) {
  console.error('COULD NOT TELL: no GITHUB_TOKEN, so no run on main was read.');
  process.exit(UNKNOWN);
}

const api = async (path) => {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'smarter-poker-main-is-green',
    },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${res.statusText}`);
  return res.json();
};

let runs = [];
let activeWorkflows = [];
let notApplicable = [];
try {
  const inventory = await collectActiveWorkflowRuns(api, REPO, BRANCH);
  runs = inventory.runs;
  activeWorkflows = inventory.workflows;
  notApplicable = inventory.notApplicable;
} catch (err) {
  // NOT fail-open. It does not page (the workflow treats 3 as a warning), and
  // it does not close a standing alarm either, which exit 0 used to do.
  console.error(`COULD NOT TELL: could not read every active workflow verdict (${err.message}).`);
  process.exit(UNKNOWN);
}

// Newest first, then group by workflow.
//
// A SKIPPED OR CANCELLED RUN IS NOT A GREEN RUN. This used to read the single
// newest run per workflow and require `conclusion === 'failure'`, which made any
// workflow that interleaves skips with failures invisible - and an event-driven
// `workflow_run` listener with a concurrency group interleaves by construction.
// Measured 2026-09-09: Post-Deploy E2E (production) had failed 24 times in 21
// hours with no success, 7 of 7 verdicts in-window were failures, and the newest
// run - the only one read - was `cancelled`. See scripts/ci/lib/workflowVerdicts.mjs.
runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
const byWorkflow = groupByWorkflow(runs);

const now = Date.now();
const red = redWorkflows(runs, now);

// Open issues, so a workflow that already raised one is not double-reported.
let openIssues = [];
try {
  const d = await api(
    `/repos/${REPO}/issues?state=open&labels=${encodeURIComponent(MAIN_HEALTH_READER_LABEL)}` +
      '&per_page=100&sort=updated'
  );
  openIssues = Array.isArray(d) ? d.filter((i) => !i.pull_request) : [];
} catch {
  openIssues = []; // no issues readable -> treat everything as silent, which errs loud
}

/**
 * Is somebody already being told about this workflow?
 *
 * Human prose is not authority. The issue must carry the exact reader label and
 * exact per-workflow machine marker, and must have been touched since this
 * failure episode began. A similarly titled issue, a coincidental workflow name
 * in prose, or a stale marker cannot suppress an alarm.
 */
const hasOpenAlarm = (name, since) =>
  openIssues.some((issue) => issueCarriesWorkflowAlarm(issue, name, since));

const hrs = (h) => (h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h.toFixed(1)}h`);

console.log(
  `Scanned ${runs.length} completed runs on ${BRANCH} across ` +
    `${activeWorkflows.length} active workflows; ${notApplicable.length} had no completed ` +
    `${BRANCH} run and were not applicable.`
);

if (red.length === 0) {
  console.log(`OK - every workflow's latest VERDICT on ${BRANCH} is green.`);
  process.exit(0);
}

red.sort((a, b) => b.hours - a.hours);
for (const r of red) r.loud = hasOpenAlarm(r.name, r.since);

// Alarm only on SILENT failures that have outlived the threshold. Under it is a
// normal transient - somebody broke main a moment ago and is probably already
// fixing it.
const overdue = red.filter((r) => r.hours >= HOURS && !r.loud);

console.log('');
for (const r of red) {
  const mark = r.loud ? 'loud ' : r.hours >= HOURS ? 'SILENT' : 'fresh';
  console.log(
    `  ${mark} ${r.name} - ${r.consecutive} consecutive failed verdict(s) over ` +
      `${r.windowLimited ? 'at least ' : ''}${hrs(r.hours)}` +
      (r.lastGreen ? `, last green ${r.lastGreen}` : ', no green run in the window') +
      (r.loud ? ' [an open issue already names it]' : '')
  );
  // The workflow copies this log into its owned issue. These exact markers make
  // that issue authoritative for the workflows it is actually tracking.
  console.log(`  ${workflowAlarmMarker(r.name)}`);
}
console.log('');

if (overdue.length === 0) {
  const loud = red.filter((r) => r.loud).length;
  console.log(
    `Nothing silent past ${HOURS}h. ${loud} failing workflow(s) already have an open issue; ` +
      `${red.length - loud - overdue.length} are still fresh.`
  );
  process.exit(0);
}

const lines = overdue.map(
  (r) =>
    `- **${r.name}** - ${r.consecutive} consecutive failed verdicts over ` +
    `${r.windowLimited ? 'at least ' : ''}${hrs(r.hours)}` +
    (r.lastGreen ? `, last green \`${r.lastGreen}\`` : ', no green run in the scanned window') +
    `\n  ${r.url}`
);

console.log('::group::report');
console.log(lines.join('\n'));
console.log('::endgroup::');

console.error('');
console.error(
  `::error title=SILENTLY RED ON ${BRANCH.toUpperCase()}::${overdue.length} workflow(s) have been failing on ${BRANCH} for over ${HOURS}h with no open issue naming them: ${overdue
    .map((r) => r.name)
    .join(', ')}`
);
process.exit(1);
