/**
 * ONE CHECK RED ON EVERY BRANCH IS A DIFFERENT SIGNAL FROM ONE BRANCH FAILING.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * On 2026-09-07, twelve consecutive `CI - Build & Type Safety` runs failed -
 * every one a different agent, on an unrelated branch, for hours. One cause:
 * `bbj_drill_arms.club_id` shipped with no index, so the invariant
 * `Supabase Invariants - A Club Stays Deletable` went red on EVERY branch at
 * once. Nobody could merge anything.
 *
 * Every part of that worked as designed. The gate was correct, it named its
 * offender in its own output, and it failed loudly on each pull request. What
 * was missing is that nothing looks ACROSS pull requests, so the estate-wide
 * shape was invisible: each agent saw one red check on their own branch, read
 * it as their own problem, and went looking in their own diff.
 *
 * `check-main-is-green.mjs` next door watches `main`. This failure never
 * touched `main` - it lived entirely on production database state that the
 * pull-request checks read - so `main` stayed green while nothing could land.
 * That is the gap this closes, and it is the one my own changelog for the
 * incident named and left open.
 *
 * ── THE DISCRIMINATOR IS CONCENTRATION, NOT COUNT ────────────────────────────
 * Measured against the live repository on 2026-09-07, 36 open pull requests:
 *
 *   window   fresh PRs   with any failure   most-shared real step
 *   3h       20          17                 5 PRs  (29%)
 *
 * Five branches sharing a failing step is ORDINARY - old branches rot
 * independently, and a shared step name says little. During the incident the
 * same step was red on 12 of 12 fresh pull requests: 100%.
 *
 * So the alarm is a SHARE of the failing pull requests, floored by a count:
 *   - at least MIN_PRS distinct pull requests (a 2-of-2 repo cannot trip it), and
 *   - at least MIN_SHARE of the fresh pull requests that have any failure.
 * 29% against 100% is the separation those two numbers were chosen from. An
 * alarm that is always on is an alarm that gets muted (10.84).
 *
 * ── STALE BRANCHES ARE EXCLUDED, DELIBERATELY ────────────────────────────────
 * A pull request nobody has touched in three days is failing for its own
 * reasons and has been for three days. Including those buries the signal under
 * a permanent floor of rot, which is how a detector becomes wallpaper. Only
 * pull requests updated inside the window count.
 *
 * ── SUMMARY STEPS SAY NOTHING AND ARE DROPPED ────────────────────────────────
 * `Fail if a suite that ran did not pass` appeared on 25 of 36 open pull
 * requests and `Every shard passed` on 9. Neither names a cause: they exist to
 * turn another job's result into a failing status. Grouping on them would
 * report 100% concentration on every quiet day of the week.
 *
 * ── THREE OUTCOMES ───────────────────────────────────────────────────────────
 *   0  no failure is estate-wide (or nothing is failing at all)
 *   1  one failing check spans the estate - nobody can merge, raise the alarm
 *   2  COULD NOT TELL - no token, an unreadable answer, or the request budget
 *      ran out before the window was fully read
 *
 * Exit 2 is never folded into 0. A partial read reported as clean is the exact
 * coercion 10.86 rules 1 and 2 exist about, and this file would otherwise be
 * the third place in the estate to make it.
 *
 * Usage:
 *   node scripts/ci/check-open-prs-are-green.mjs
 *   PR_RED_WINDOW_HOURS=12 PR_RED_MIN_PRS=4 node scripts/ci/check-open-prs-are-green.mjs
 *
 * Needs GITHUB_TOKEN (Actions: read, Pull requests: read) and
 * GITHUB_REPOSITORY, both of which a workflow already has.
 */
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_WINDOW_HOURS = 6;
export const DEFAULT_MIN_PRS = 4;
export const DEFAULT_MIN_SHARE = 0.6;

/**
 * Steps that restate another job's outcome instead of naming a cause. Measured
 * as echoes on 2026-09-07: 25 and 9 of 36 open pull requests respectively, on
 * branches whose actual failures were unrelated to each other.
 *
 * Compared case-insensitively against the STEP half of "job / step".
 */
export const SUMMARY_STEPS = [
  'fail if a suite that ran did not pass',
  'every shard passed',
];

/** "Client Unit Tests (vitest) / Every shard passed" -> true */
export function isSummaryStep(key) {
  if (typeof key !== 'string') return false;
  const step = key.includes(' / ') ? key.slice(key.indexOf(' / ') + 3) : key;
  const norm = step.trim().toLowerCase();
  return SUMMARY_STEPS.includes(norm);
}

/**
 * Age in hours of the most recent timestamp in a list, or null when there is
 * nothing readable. NULL IS NOT ZERO: an empty list means "no idea how fresh",
 * and returning 0 would silently promote it to the freshest thing here.
 */
export function hoursSinceNewest(timestamps, now = Date.now()) {
  const times = (timestamps || [])
    // `new Date(null).getTime()` is 0, not NaN - a missing timestamp parses as
    // 1970 and reads as the OLDEST thing here rather than as "no idea". Only a
    // non-empty string is a timestamp.
    .filter((t) => typeof t === 'string' && t.trim() !== '')
    .map((t) => new Date(t).getTime())
    .filter((t) => Number.isFinite(t));
  if (times.length === 0) return null;
  return (now - Math.max(...times)) / 3_600_000;
}

/** A pull request counts when it was touched inside the window. Unknown age never counts. */
export function isFresh(pr, windowHours = DEFAULT_WINDOW_HOURS, now = Date.now()) {
  const age = hoursSinceNewest([pr?.updated_at], now);
  return age !== null && age <= windowHours;
}

/**
 * Newest run per workflow NAME. A branch that has been pushed several times
 * carries several runs of the same workflow; only the newest describes what is
 * true now, and counting the older ones would report a failure somebody has
 * already fixed.
 */
export function newestRunPerWorkflow(runs) {
  const byName = new Map();
  for (const r of runs || []) {
    if (!r || typeof r.name !== 'string') continue;
    const prev = byName.get(r.name);
    if (!prev || new Date(r.created_at) > new Date(prev.created_at)) byName.set(r.name, r);
  }
  return [...byName.values()];
}

/** "job / step" keys for every FAILING step of a failing job; the job itself when it names no step. */
export function failingStepKeys(jobs) {
  const keys = new Set();
  for (const j of jobs || []) {
    if (j?.conclusion !== 'failure') continue;
    const bad = (j.steps || []).filter((s) => s?.conclusion === 'failure');
    if (bad.length === 0) keys.add(`${j.name} / (job)`);
    else for (const s of bad) keys.add(`${j.name} / ${s.name}`);
  }
  return [...keys];
}

/**
 * Group the failing step keys of several pull requests.
 * Input: [{ number, keys: [...] }]  Output: Map<key, number[]>
 */
export function groupFailures(perPr) {
  const groups = new Map();
  for (const { number, keys } of perPr || []) {
    for (const key of new Set(keys || [])) {
      if (isSummaryStep(key)) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(number);
    }
  }
  for (const list of groups.values()) list.sort((a, b) => a - b);
  return groups;
}

/**
 * The ruling. `failingPrs` is the denominator: pull requests inside the window
 * that have ANY failure. A step shared by four of four is estate-wide; the same
 * four out of seventeen is a Tuesday.
 */
export function verdict({
  groups,
  failingPrs,
  minPrs = DEFAULT_MIN_PRS,
  minShare = DEFAULT_MIN_SHARE,
}) {
  const offenders = [];
  for (const [key, prs] of groups || new Map()) {
    const share = failingPrs > 0 ? prs.length / failingPrs : 0;
    if (prs.length >= minPrs && share >= minShare) offenders.push({ key, prs, share });
  }
  offenders.sort((a, b) => b.prs.length - a.prs.length || a.key.localeCompare(b.key));
  return { estateWide: offenders.length > 0, offenders };
}

// ── everything below this line only runs when the file is RUN ────────────────
// Imported for its exports, it must do nothing. `check-ddl-reload-storms.mjs`
// shipped without this guard on 2026-09-06 and its own test suite called
// process.exit(2) inside the vitest worker, which reported as "15 passed" with
// a stray error beside it.

const REPO = process.env.GITHUB_REPOSITORY || 'Smarter-Poker/Smarter-Poker-Club-Arena';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const WINDOW_HOURS = Number(process.env.PR_RED_WINDOW_HOURS || DEFAULT_WINDOW_HOURS);
const MIN_PRS = Number(process.env.PR_RED_MIN_PRS || DEFAULT_MIN_PRS);
const MIN_SHARE = Number(process.env.PR_RED_MIN_SHARE || DEFAULT_MIN_SHARE);
/**
 * A GITHUB_TOKEN gets 1,000 REST requests per hour per repository, shared with
 * every other job in the repo. This scan costs one call per fresh pull request
 * plus one per failing workflow run; the cap keeps a busy hour bounded, and
 * hitting it is reported as COULD NOT TELL rather than as a clean window.
 */
const REQUEST_BUDGET = Number(process.env.PR_RED_REQUEST_BUDGET || 120);

const UNKNOWN = 2;

async function main() {
  if (!TOKEN) {
    console.error('COULD NOT TELL: no GITHUB_TOKEN, so no pull request was read.');
    return UNKNOWN;
  }

  let spent = 0;
  let budgetExhausted = false;

  /** Three attempts before an unreadable answer is believed; a 502 is not an outage. */
  const api = async (path) => {
    if (spent >= REQUEST_BUDGET) {
      budgetExhausted = true;
      throw new Error(`request budget of ${REQUEST_BUDGET} exhausted before ${path}`);
    }
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      spent++;
      let res;
      try {
        res = await fetch(`https://api.github.com${path}`, {
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'smarter-poker-open-prs-are-green',
          },
        });
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      // res.ok FIRST, always. `(await res.json()).workflow_runs` on a 403 body
      // is undefined, and `undefined || []` reads as "nothing failed".
      if (res.ok) return res.json();
      lastErr = new Error(`${path} -> ${res.status} ${res.statusText}`);
      if (res.status < 500 && res.status !== 429) break;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    throw lastErr;
  };

  let open;
  try {
    open = await api(`/repos/${REPO}/pulls?state=open&sort=updated&direction=desc&per_page=100`);
  } catch (err) {
    console.error(`COULD NOT TELL: could not list open pull requests (${err.message}).`);
    return UNKNOWN;
  }
  if (!Array.isArray(open)) {
    console.error('COULD NOT TELL: the pull request list was not an array.');
    return UNKNOWN;
  }

  const now = Date.now();
  const fresh = open.filter((pr) => isFresh(pr, WINDOW_HOURS, now));
  console.log(
    `${open.length} open pull request(s); ${fresh.length} updated inside ${WINDOW_HOURS}h.`
  );
  if (fresh.length === 0) {
    console.log('OK - no pull request has moved inside the window, so nothing to compare.');
    return 0;
  }

  const perPr = [];
  for (const pr of fresh) {
    let runs;
    try {
      const d = await api(`/repos/${REPO}/actions/runs?head_sha=${pr.head.sha}&per_page=100`);
      runs = d.workflow_runs;
    } catch (err) {
      console.error(`COULD NOT TELL: runs for #${pr.number} (${err.message}).`);
      return UNKNOWN;
    }
    if (!Array.isArray(runs)) {
      console.error(`COULD NOT TELL: #${pr.number} returned no workflow_runs array.`);
      return UNKNOWN;
    }
    const failed = newestRunPerWorkflow(runs).filter((r) => r.conclusion === 'failure');
    const keys = [];
    for (const run of failed) {
      try {
        const jd = await api(`/repos/${REPO}/actions/runs/${run.id}/jobs?per_page=100`);
        if (!Array.isArray(jd.jobs)) {
          console.error(`COULD NOT TELL: run ${run.id} returned no jobs array.`);
          return UNKNOWN;
        }
        keys.push(...failingStepKeys(jd.jobs));
      } catch (err) {
        if (budgetExhausted) {
          console.error(
            `COULD NOT TELL: ${err.message}. Part of the window was never read, and a part ` +
              'is not a window.'
          );
          return UNKNOWN;
        }
        console.error(`COULD NOT TELL: jobs for run ${run.id} (${err.message}).`);
        return UNKNOWN;
      }
    }
    perPr.push({ number: pr.number, ref: pr.head.ref, keys });
  }

  const failingPrs = perPr.filter((p) => p.keys.length > 0).length;
  const groups = groupFailures(perPr);
  console.log(
    `${failingPrs} of ${fresh.length} fresh pull request(s) have a failing check; ` +
      `${groups.size} distinct failing step(s) after dropping summary steps. ` +
      `(${spent} API calls)`
  );

  if (groups.size === 0) {
    console.log('OK - nothing is failing on a fresh pull request.');
    return 0;
  }

  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log('');
  for (const [key, prs] of ranked.slice(0, 10)) {
    const share = failingPrs > 0 ? (100 * prs.length) / failingPrs : 0;
    console.log(
      `  ${String(prs.length).padStart(3)} PR(s)  ${share.toFixed(0).padStart(3)}%  ${key}` +
        `\n         ${prs.map((n) => `#${n}`).join(' ')}`
    );
  }
  console.log('');

  const { estateWide, offenders } = verdict({
    groups,
    failingPrs,
    minPrs: MIN_PRS,
    minShare: MIN_SHARE,
  });

  if (!estateWide) {
    console.log(
      `OK - no single check accounts for ${Math.round(MIN_SHARE * 100)}% or more of the ` +
        `${failingPrs} failing pull request(s) (floor ${MIN_PRS}). Branches are red for their own reasons.`
    );
    return 0;
  }

  const lines = offenders.map(
    (o) =>
      `- **${o.key}** - failing on ${o.prs.length} of ${failingPrs} fresh pull requests ` +
      `(${Math.round(o.share * 100)}%): ${o.prs.map((n) => `#${n}`).join(', ')}`
  );
  console.log('::group::report');
  console.log(lines.join('\n'));
  console.log('::endgroup::');
  console.error('');
  console.error(
    `::error title=NOBODY CAN MERGE::${offenders.length} check(s) are failing across the estate, ` +
      `not on one branch: ${offenders.map((o) => o.key).join(', ')}. Read the check's own output - ` +
      'it names the offender, and it is almost never in the branch it stopped.'
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`COULD NOT TELL: ${err?.stack || err}`);
      process.exit(UNKNOWN);
    });
}
