#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PR-STATUS - answer "is my branch green, red, or still running" truthfully.
//
// Actions runs describe workflow jobs; standalone GitHub App checks also carry
// required verdicts. Read both on the exact commit and retain the ruleset's
// reporter binding. On 2026-09-27 PR5400's Money check succeeded from its required
// App, while this tool reported it absent because it searched only Actions jobs.
//
// A historically unreadable endpoint is not permanently unavailable. Any denied
// or malformed read is UNKNOWN, never an empty list or a successful check. The
// legacy aggregate /commits/:sha/status still cannot answer for check runs.
//
// USAGE
//   node scripts/ci/pr-status.mjs                 # PR for the current branch
//   node scripts/ci/pr-status.mjs 3163            # by PR number
//   node scripts/ci/pr-status.mjs --branch fix/x  # by branch name
//   node scripts/ci/pr-status.mjs --sha FULL_COMMIT_SHA  # exact 40-character SHA
//   node scripts/ci/pr-status.mjs --json          # machine-readable
//   node scripts/ci/pr-status.mjs --all           # every open PR, ranked
//
// EXIT CODES (branch on these, do not parse the prose)
//   0  GREEN    every required check passed; protected merge is a separate action
//   1  RED      at least one check failed - the job and step are named
//   2  RUNNING  something is genuinely still in progress, nothing failed yet
//   3  UNKNOWN  could not determine. NOT a synonym for pending. Read the note.
//   4  DIRTY    the branch conflicts with main; CI state is moot until resolved
//
// Use the configured credential with Actions, Checks, pull-request and rules
// read access. This helper performs observation only; it never merges or retries.
// ---------------------------------------------------------------------------

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};

const JSON_OUT = has('--json');
const ALL = has('--all');
// Fetch and distil the failing job's log in the same call. Cached on disk, so
// asking twice costs one request - repeated log reads are the heavy endpoint
// that exhausts the quota.
const WANT_LOG = has('--log');
/**
 * Which repository am I asking about?
 *
 * This used to default to `Smarter-Poker/Smarter-Poker-Club-Arena`. That is
 * fine in Club Arena and a trap everywhere else: AGENT-PLAYBOOK.md is
 * byte-identical in seven repos, so the moment it started naming this tool,
 * an agent in the World Hub running it with no arguments would have been told,
 * confidently and in the right format, about Club Arena's pull requests.
 *
 * A wrong answer that looks right is the whole subject of this file's header,
 * so the repo is DERIVED from the checkout instead. Explicit --repo or $REPO
 * still win; a directory with no git remote gets no guess at all.
 */
function repoFromGitRemote() {
  try {
    const url = execSync('git remote get-url origin', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // git@github.com:owner/name.git | https://github.com/owner/name(.git)
    const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

const REPO = argOf('--repo', process.env.REPO || repoFromGitRemote());
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

// A conclusion that is not one of these is a failure. Listing the GOOD ones
// rather than the bad ones means a conclusion GitHub adds later defaults to
// "tell the human" instead of "silently pass".
const GOOD = new Set(['success', 'skipped', 'neutral']);

const EXIT = { GREEN: 0, RED: 1, RED_NON_BLOCKING: 1, RUNNING: 2, UNKNOWN: 3, DIRTY: 4 };

function die(msg, code = EXIT.UNKNOWN) {
  if (JSON_OUT) console.log(JSON.stringify({ state: 'UNKNOWN', reason: msg }, null, 2));
  else console.error(`\n  UNKNOWN - ${msg}\n`);
  process.exit(code);
}

function assertConfigured() {
  if (!TOKEN) {
    die(
      'no GH_TOKEN / GITHUB_TOKEN in the environment.\n' +
        '  Use the GitHub client or credential store configured for this environment.\n' +
        '  Never scrape a token from a repository-adjacent .env file.'
    );
  }

  if (!REPO) {
    die(
      'could not tell which repository to ask about.\n' +
        '  There is no `origin` remote here and neither --repo nor $REPO was given.\n' +
        "  Guessing one would report, in a convincing format, on somebody else's\n" +
        '  pull requests. Run this inside a checkout, or pass --repo owner/name.'
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP. Every non-200 is surfaced, never coerced into an empty result. This is
// the whole point of the file: the 403 that started all this returned a
// perfectly good JSON body, and the caller read `.check_runs` off it.
// ---------------------------------------------------------------------------
// Quota as last observed, so the footer can warn before the next agent runs
// into the wall rather than after.
let lastQuota = null;

/**
 * A 403 has TWO completely different meanings here and telling them apart is
 * not optional. Missing scope is permanent and needs a different token; rate
 * limiting is temporary and needs a clock. On 2026-09-06 an agent polling a
 * failing job exhausted the quota, and a tool that blamed "missing scope"
 * would have sent them to rotate a credential that was fine. GitHub says which
 * it is in the headers: `x-ratelimit-remaining: 0`, or `retry-after` for the
 * secondary limit.
 */
function rateLimitOf(res) {
  const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? NaN);
  const limit = Number(res.headers.get('x-ratelimit-limit') ?? NaN);
  const reset = Number(res.headers.get('x-ratelimit-reset') ?? NaN);
  const retryAfter = Number(res.headers.get('retry-after') ?? NaN);
  if (Number.isFinite(remaining) && Number.isFinite(limit)) lastQuota = { remaining, limit, reset };
  const limited =
    res.status === 429 || (res.status === 403 && (remaining === 0 || Number.isFinite(retryAfter)));
  if (!limited) return null;
  const waitMin = Number.isFinite(retryAfter)
    ? retryAfter / 60
    : Number.isFinite(reset)
      ? Math.max(0, (reset * 1000 - Date.now()) / 60000)
      : null;
  return {
    resource: res.headers.get('x-ratelimit-resource') || 'core',
    waitMin,
    resetAt: Number.isFinite(reset)
      ? new Date(reset * 1000).toISOString().slice(11, 19) + ' UTC'
      : null,
  };
}

async function gh(path, { allow404 = false } = {}) {
  const url = path.startsWith('http') ? path : `https://api.github.com/repos/${REPO}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  rateLimitOf(res); // record quota even on success
  if (res.status === 404 && allow404) return null;
  if (!res.ok) {
    const rl = rateLimitOf(res);
    if (rl) {
      die(
        `RATE LIMITED on the "${rl.resource}" quota.\n` +
          `  This is NOT a permissions problem and NOT a broken token - do not\n` +
          `  rotate a credential over it.\n` +
          (rl.waitMin !== null
            ? `  The quota resets in ${rl.waitMin.toFixed(1)} minute(s)${rl.resetAt ? ` (${rl.resetAt})` : ''}.\n`
            : '') +
          '  You almost certainly got here by POLLING. Do not poll again. Preserve\n' +
          '  the PR URL and resume one read after the stated reset time. Protected\n' +
          '  checks remain authoritative; there is no retry watchdog.\n' +
          '  To read a failing job once, cheaply: node scripts/ci/pr-status.mjs <pr> --log'
      );
    }
    const body = await res.text().catch(() => '');
    let detail = '';
    try {
      detail = JSON.parse(body).message || '';
    } catch {
      detail = body.slice(0, 200);
    }
    die(
      `GitHub answered ${res.status} for ${url}\n  ${detail}\n\n` +
        (res.status === 403
          ? '  A 403 with quota remaining means the token lacks a scope. This tool\n' +
            '  needs readable Actions, Checks, pull requests and rules. Do NOT hide it\n' +
            '  by falling back to /commits/:sha/status - that endpoint reports\n' +
            '  "pending" for commits that have already failed. See the header.'
          : '')
    );
  }
  return res.json();
}

/**
 * Fetch a job's log ONCE and cache it. An agent reading the same failure twice
 * should pay for it once; log endpoints are heavy and repeated reads are what
 * exhausts the quota in the first place.
 */
async function jobLog(jobId) {
  const cache = `${tmpdir()}/ca-joblog-${jobId}.txt`;
  if (existsSync(cache)) return readFileSync(cache, 'utf8');
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/jobs/${jobId}/logs`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  const rl = rateLimitOf(res);
  if (rl)
    die(`RATE LIMITED fetching the log for job ${jobId}; resets in ${rl.waitMin?.toFixed(1)} min.`);
  if (!res.ok) die(`could not read the log for job ${jobId}: HTTP ${res.status}`);
  const text = await res.text();
  try {
    writeFileSync(cache, text);
  } catch {
    /* cache is a convenience, never a requirement */
  }
  return text;
}

/**
 * The lines that actually say what broke. A 1MB job log is mostly the stderr of
 * tests that PASS while deliberately exercising failure paths - on 2026-09-06
 * the real failure sat under ~40 lines of expected "[Supabase] FATAL" noise,
 * and grepping for /Error:/ finds the noise first.
 */
function failureLines(log) {
  const clean = log.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  const hits = [];
  for (let i = 0; i < clean.length; i++) {
    const l = clean[i];
    if (
      /^\s*\S*\s*(FAIL|✕|×)\s/.test(l) ||
      /Failed Tests/.test(l) ||
      /Test Files\s+\d+ failed/.test(l) ||
      /Tests\s+\d+ failed/.test(l) ||
      /Test timed out in/.test(l) ||
      /^\s*##\[error\]/.test(l) ||
      /AssertionError/.test(l)
    ) {
      hits.push(l.replace(/^\S+Z\s/, '').trimEnd());
    }
  }
  return [...new Set(hits)];
}

// A read whose absence is survivable: returns null instead of exiting.
async function ghSoft(path) {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// GitHub computes mergeability lazily. On a PR it has not looked at yet,
// `mergeable` is null and `mergeable_state` is "unknown" - which is NOT the
// same as mergeable, and must never be rendered as though it were. The list
// endpoint omits both fields entirely, which is the same trap one level down.
function mergeLabel(pr) {
  if (!pr) return 'UNCOMPUTED';
  if (pr.mergeable_state === 'dirty') return 'DIRTY';
  if (pr.mergeable === null || pr.mergeable_state === undefined || pr.mergeable_state === 'unknown')
    return 'UNCOMPUTED';
  return String(pr.mergeable_state).toUpperCase();
}

// ---------------------------------------------------------------------------
// Which checks does the ruleset actually require? Read it rather than
// hardcoding, so a check added to the ruleset is honoured here the same hour.
// If the token cannot read rulesets there is no honest green answer: the tool
// cannot prove which contexts GitHub requires.
// ---------------------------------------------------------------------------
async function requiredChecks() {
  const rules = await ghSoft('/rules/branches/main');
  if (!Array.isArray(rules)) return null;
  const list = rules
    .filter((rule) => rule.type === 'required_status_checks')
    .flatMap((rule) => rule.parameters?.required_status_checks ?? [null]);
  if (
    !list.length ||
    list.some((check) => !check || typeof check.context !== 'string' || !check.context)
  )
    return null;
  const required = new Map();
  for (const check of list) {
    const app = check.integration_id ?? null;
    if (app !== null && (!Number.isSafeInteger(app) || app <= 0)) return null;
    const reporters = required.get(check.context) ?? new Set();
    reporters.add(app);
    required.set(check.context, reporters);
  }
  return required;
}

// Counted endpoints must be read completely. Bound abnormal inventories and
// reject partial/changing pages instead of inferring absence from page one.
export async function readPages(path, key, read = gh) {
  const rows = [];
  let expected;
  const seen = new Set();
  for (let page = 1; page <= 10; page++) {
    const answer = await read(`${path}&per_page=100&page=${page}`);
    if (
      !Array.isArray(answer?.[key]) ||
      !Number.isSafeInteger(answer.total_count) ||
      answer.total_count < 0 ||
      answer.total_count > 1000 ||
      (expected !== undefined && answer.total_count !== expected)
    ) {
      throw new Error(`Incomplete or changing ${key} inventory for ${path}`);
    }
    expected = answer.total_count;
    for (const row of answer[key]) {
      if (!Number.isSafeInteger(row?.id) || seen.has(row.id)) {
        throw new Error(`Invalid or repeated ${key} identity for ${path}`);
      }
      seen.add(row.id);
      rows.push(row);
    }
    if (rows.length === expected) return rows;
    if (rows.length > expected || answer[key].length !== 100) {
      throw new Error(`Incomplete ${key} page for ${path}`);
    }
  }
  throw new Error(`Unbounded ${key} inventory for ${path}`);
}

/**
 * Name every required context for which this commit lacks a completed success.
 * A workflow-level success is not enough: a required job can be absent because
 * a path or job condition prevented it from being created, and GitHub will keep
 * the pull request blocked in exactly that state.
 */
export function requiredContextProblems(required, checks, sha) {
  if (!(required instanceof Map)) return null;
  if (!/^[a-f0-9]{40}$/.test(sha) || !Array.isArray(checks)) {
    throw new Error('Required checks need an exact commit and readable inventory');
  }
  for (const check of checks) {
    if (
      check.head_sha !== sha ||
      !Number.isSafeInteger(check.id) ||
      !Number.isSafeInteger(check.app?.id) ||
      typeof check.name !== 'string' ||
      !['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'].includes(
        check.status
      ) ||
      (check.status === 'completed' && typeof check.conclusion !== 'string')
    ) {
      throw new Error('Check identity, reporter or status is missing or belongs to another commit');
    }
  }
  const problems = [];
  for (const [context, reporters] of [...required].sort(([a], [b]) => a.localeCompare(b))) {
    for (const reporter of reporters) {
      const matching = checks.filter(
        (check) => check.name === context && (reporter === null || check.app.id === reporter)
      );
      // Newer attempts supersede old successes even if the old attempt finishes
      // later. IDs identify creation order; completed_at does not. For an
      // unbound context retain every reporter's latest verdict, never let a
      // foreign success mask a failing reporter with the same name.
      const latest = new Map();
      for (const check of matching) {
        if (!latest.has(check.app.id) || latest.get(check.app.id).id < check.id) {
          latest.set(check.app.id, check);
        }
      }
      const observed = [...latest.values()];
      if (
        observed.length &&
        observed.every((check) => check.status === 'completed' && check.conclusion === 'success')
      )
        continue;
      const failed = observed.some(
        (check) => check.status === 'completed' && check.conclusion !== 'success'
      );
      problems.push({
        context,
        ...(reporter !== null ? { integrationId: reporter } : {}),
        state: !observed.length ? 'missing' : failed ? 'not_successful' : 'running',
        conclusions: [...new Set(observed.map((check) => check.conclusion || check.status))].sort(),
      });
    }
  }
  return problems;
}

/** A green verdict is possible only with readable rules and zero context gaps. */
export function stateForChecks({ failures, activeRuns, requiredProblems }) {
  if (failures.some((failure) => failure.required)) return 'RED';
  if (requiredProblems?.some((problem) => problem.state === 'not_successful')) return 'RED';
  if (requiredProblems === null) return 'UNKNOWN';
  if (activeRuns.length || requiredProblems.some((problem) => problem.state === 'running'))
    return 'RUNNING';
  if (requiredProblems.length) return 'RED';
  if (failures.length) return 'RED_NON_BLOCKING';
  return 'GREEN';
}

// ---------------------------------------------------------------------------
// Workflow diagnostics and required App verdicts for one exact commit.
// ---------------------------------------------------------------------------
export async function commitState(sha, required, read = gh) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('An exact 40-character commit SHA is required');
  const runs = await readPages(`/actions/runs?head_sha=${sha}`, 'workflow_runs', read);
  if (runs.some((run) => run.head_sha !== sha || !Number.isSafeInteger(run.workflow_id))) {
    throw new Error('Actions run identity does not match the requested commit');
  }
  const checks = await readPages(`/commits/${sha}/check-runs?filter=all`, 'check_runs', read);

  if (runs.length === 0 && checks.length === 0) {
    return {
      state: 'UNKNOWN',
      reason:
        `no workflow run has ever been recorded for ${sha.slice(0, 9)}.\n` +
        'That is not "pending" - a queued run appears here within seconds.\n' +
        'Most likely the commit was never pushed, or was pushed to a fork, or\n' +
        'the workflows are gated off for this branch. Check:\n' +
        '  git rev-parse HEAD   and   git ls-remote origin <branch>',
      runs: [],
      failures: [],
      activeRuns: [],
    };
  }

  // One run per workflow: the newest. Re-runs create new rows, and an old
  // failure sitting beside a fresh success would otherwise read as red forever.
  const latest = new Map();
  for (const r of runs) {
    const prev = latest.get(r.workflow_id);
    if (!prev || r.id > prev.id) latest.set(r.workflow_id, r);
  }
  const list = [...latest.values()];

  const failedRuns = list.filter((r) => r.conclusion && !GOOD.has(r.conclusion));
  const activeRuns = list.filter((r) => r.status !== 'completed');

  // Keep workflow job/step diagnostics separate from required check-run proof.
  // A standalone App verdict has no Actions job, and a job name cannot prove
  // the App identity required by the ruleset.
  const jobsByRun = new Map();
  for (const run of list) {
    const jobs = await readPages(`/actions/runs/${run.id}/jobs?filter=latest`, 'jobs', read);
    if (jobs.some((job) => job.head_sha !== sha || job.run_id !== run.id)) {
      throw new Error(`Job identity does not match workflow run ${run.id}`);
    }
    jobsByRun.set(run.id, jobs);
  }

  const requiredProblems = requiredContextProblems(required, checks, sha);

  // Name the job and the step. This is the part an agent actually needs, and
  // the part /commits/:sha/status could never give even if it worked.
  const failures = [];
  for (const run of failedRuns) {
    const runJobs = jobsByRun.get(run.id);
    const badJobs = runJobs.filter((j) => j.conclusion && !GOOD.has(j.conclusion));
    if (badJobs.length === 0) {
      failures.push({
        workflow: run.name,
        job: '(run failed before any job started)',
        step: null,
        conclusion: run.conclusion,
        runId: run.id,
        url: run.html_url,
        required: false,
      });
      continue;
    }
    for (const j of badJobs) {
      const step = (j.steps || []).find((s) => s.conclusion && !GOOD.has(s.conclusion));
      failures.push({
        workflow: run.name,
        job: j.name,
        step: step?.name || null,
        conclusion: j.conclusion,
        runId: run.id,
        jobId: j.id,
        url: j.html_url || run.html_url,
        // The ruleset names JOBS, not workflows - "TypeScript Check" is a job
        // inside "CI - Build & Type Safety". Getting that backwards is why
        // agents mis-read which reds actually block a merge.
        required:
          requiredProblems === null ||
          requiredProblems.some(
            (problem) => problem.context === j.name && problem.state === 'not_successful'
          ),
      });
    }
  }

  const state = stateForChecks({ failures, activeRuns, requiredProblems });
  const reason =
    state === 'UNKNOWN'
      ? 'required status-check rules were unreadable or named no contexts; refusing to call this commit green.'
      : null;

  return { state, runs: list, failures, activeRuns, required, requiredProblems, reason };
}

/**
 * Say something BEFORE the wall, not after it. An agent who has burned 80% of
 * the hour's quota is one poll loop away from being unable to read CI at all,
 * and the failure mode when that happens is a 403 that looks like a broken
 * token.
 */
function quotaWarning(line) {
  if (!lastQuota || !Number.isFinite(lastQuota.limit) || lastQuota.limit === 0) return;
  const frac = lastQuota.remaining / lastQuota.limit;
  if (frac > 0.2) return;
  const mins = Number.isFinite(lastQuota.reset)
    ? Math.max(0, (lastQuota.reset * 1000 - Date.now()) / 60000).toFixed(0)
    : '?';
  line('');
  line(
    `  QUOTA LOW: ${lastQuota.remaining}/${lastQuota.limit} GitHub API calls left, resets in ${mins} min.`
  );
  line(
    '  Preserve the pending operation and use the remaining quota for necessary evidence reads.'
  );
}

// ---------------------------------------------------------------------------
function render(pr, st) {
  const line = (s) => console.log(s);
  const head = pr ? `PR #${pr.number}  ${pr.head.ref}` : `commit ${st.sha}`;
  line('');
  line('  ' + head);
  if (pr) line(`  ${pr.html_url}`);
  line('  ' + '-'.repeat(Math.max(20, head.length)));

  if (pr && mergeLabel(pr) === 'DIRTY') {
    line('  DIRTY - this branch conflicts with main. Resolve the conflict first;');
    line('  CI state is not the thing standing in your way.');
    line('  (Merge main in - do NOT rebase: CLAUDE.md 12 and a ref-guard hook.)');
    line('');
    return EXIT.DIRTY;
  }

  if (st.state === 'UNKNOWN') {
    line('  UNKNOWN - ' + st.reason.split('\n').join('\n  '));
    line('');
    return EXIT.UNKNOWN;
  }

  for (const r of st.runs) {
    const tag =
      r.status !== 'completed'
        ? 'RUNNING'
        : GOOD.has(r.conclusion)
          ? 'ok'
          : String(r.conclusion).toUpperCase();
    line(`  ${tag.padEnd(9)} ${r.name}`);
  }

  if (st.failures.length) {
    line('');
    line('  FAILING:');
    for (const f of st.failures) {
      line(`    ${f.required ? '[BLOCKS MERGE]' : '[not required]'} ${f.workflow} -> ${f.job}`);
      if (f.step) line(`        failed step: ${f.step}`);
      line(`        ${f.url}`);
      if (f.detail?.length) {
        line('        ---- what the log says ----');
        for (const d of f.detail.slice(-12)) line(`        ${d}`);
      } else if (f.jobId && !WANT_LOG) {
        line(`        re-run with --log to name the failing test (cached, one request)`);
      }
    }
  }

  if (st.requiredProblems?.length) {
    line('');
    line('  REQUIRED CHECKS NOT PROVEN SUCCESSFUL:');
    for (const problem of st.requiredProblems) {
      const detail =
        problem.state === 'missing'
          ? 'not observed'
          : problem.state === 'running'
            ? 'still running'
            : `completed as ${problem.conclusions.join(', ') || 'unknown'}`;
      line(`    [BLOCKS MERGE] ${problem.context} - ${detail}`);
    }
  }

  quotaWarning(line);
  line('');
  if (st.state === 'RED') {
    line('  RED - one or more required checks are not proven successful. This will not merge.');
    line('');
    return EXIT.RED;
  }
  if (st.state === 'RED_NON_BLOCKING') {
    line('  RED (non-blocking) - a check failed but the ruleset does not require it.');
    line('  Diagnose the failure; the authorized task still owns protected delivery.');
    line('');
    return EXIT.RED;
  }
  if (st.state === 'RUNNING') {
    line('  RUNNING - a workflow or required check is still in progress.');
    line('  Retain this operation, continue independent assigned work, then read its result.');
    line('');
    return EXIT.RUNNING;
  }
  line('  GREEN - every required check passed.');
  if (pr && mergeLabel(pr) === 'BLOCKED')
    line(
      '  (GitHub still says "blocked" - required check success does not establish mergeability.)'
    );
  if (pr && mergeLabel(pr) === 'UNCOMPUTED')
    line(
      '  (GitHub has not computed mergeability yet - that is not a problem, just not an answer.)'
    );
  line('');
  return EXIT.GREEN;
}

// ---------------------------------------------------------------------------
async function main() {
  assertConfigured();
  const required = await requiredChecks();

  if (ALL) {
    const list = await gh('/pulls?state=open&per_page=100');
    const rows = [];
    for (const stub of list) {
      // The LIST endpoint does not compute `mergeable_state` - it is only
      // filled in on a single-PR GET, and even then GitHub computes it
      // asynchronously. Reading it off the list row makes every conflicted
      // branch look clean, so the same PR reported DIRTY on its own and RED
      // in this table. Fetch the detail; treat an uncomputed answer as
      // uncomputed rather than as "fine".
      const pr = (await ghSoft(`/pulls/${stub.number}`)) || stub;
      const st = await commitState(pr.head.sha, required);
      if ((await gh(`/pulls/${pr.number}`))?.head?.sha !== pr.head.sha) {
        die(
          `PR #${pr.number} changed head while its checks were read; obtain a fresh observation.`
        );
      }
      rows.push({ pr, st, merge: mergeLabel(pr) });
    }
    const rank = { DIRTY: -1, RED: 0, RED_NON_BLOCKING: 1, UNKNOWN: 2, RUNNING: 3, GREEN: 4 };
    const stateOf = (r) => (r.merge === 'DIRTY' ? 'DIRTY' : r.st.state);
    rows.sort((a, b) => rank[stateOf(a)] - rank[stateOf(b)] || a.pr.number - b.pr.number);
    const states = rows.map(stateOf);
    const aggregateExit = states.some((state) =>
      ['DIRTY', 'RED', 'RED_NON_BLOCKING'].includes(state)
    )
      ? EXIT.RED
      : states.includes('UNKNOWN')
        ? EXIT.UNKNOWN
        : states.includes('RUNNING')
          ? EXIT.RUNNING
          : EXIT.GREEN;
    if (JSON_OUT) {
      console.log(
        JSON.stringify(
          rows.map(({ pr, st, merge }) => ({
            number: pr.number,
            branch: pr.head.ref,
            state: stateOf({ st, merge }),
            mergeable_state: merge,
            failures: st.failures,
            requiredProblems: st.requiredProblems,
          })),
          null,
          2
        )
      );
      return aggregateExit;
    }
    console.log('');
    for (const row of rows) {
      const { pr, st, merge } = row;
      const state = stateOf(row);
      const note =
        merge === 'UNCOMPUTED' && state !== 'DIRTY' ? '  (mergeability not yet computed)' : '';
      console.log(
        `  ${state.padEnd(18)} #${String(pr.number).padEnd(5)} ${pr.head.ref.slice(0, 56)}${note}`
      );
      if (state === 'DIRTY') continue; // the conflict is the finding; CI is moot
      for (const f of st.failures)
        console.log(`       ${f.required ? 'X' : '-'} ${f.job}${f.step ? ` :: ${f.step}` : ''}`);
      for (const problem of st.requiredProblems ?? [])
        console.log(`       X ${problem.context} :: ${problem.state}`);
    }
    console.log('');
    const dirty = rows.filter((r) => stateOf(r) === 'DIRTY').length;
    const red = rows.filter((r) => stateOf(r) === 'RED').length;
    console.log(
      `  ${rows.length} open, ${red} with a failing required check, ${dirty} conflicting with main.`
    );
    console.log('');
    return aggregateExit;
  }

  // Resolve what we were asked about.
  let pr = null;
  let sha = argOf('--sha', null);
  const positional = args.find((a) => /^\d+$/.test(a));
  const branch = argOf('--branch', null);

  if (positional) {
    pr = await gh(`/pulls/${positional}`);
  } else if (branch || !sha) {
    let ref = branch;
    if (!ref) {
      try {
        ref = sh('git rev-parse --abbrev-ref HEAD');
      } catch {
        die('not in a git repository and no PR number, --branch or --sha given.');
      }
      if (ref === 'main' || ref === 'HEAD')
        die(
          `the current branch is "${ref}". Give a PR number, --branch, or --sha.\n` +
            '  (Work never originates on main - CLAUDE.md 12.)'
        );
    }
    const owner = REPO.split('/')[0];
    const found = await gh(`/pulls?state=open&head=${owner}:${ref}&per_page=1`);
    if (found?.length) pr = found[0];
    else {
      // No PR yet. Judge the branch head itself rather than inventing a state.
      const b = await gh(`/branches/${encodeURIComponent(ref)}`, { allow404: true });
      if (!b)
        die(
          `no open PR for "${ref}" and origin has no such branch.\n` +
            '  Verify the owned branch and push through normal hooks, then find or create its PR.'
        );
      sha = b.commit.sha;
    }
  }

  if (pr) sha = pr.head.sha;
  const st = await commitState(sha, required);
  st.sha = sha;
  if (pr && (await gh(`/pulls/${pr.number}`))?.head?.sha !== sha) {
    die(`PR #${pr.number} changed head while its checks were read; obtain a fresh observation.`);
  }

  // --log: name the failing test, not just the failing job. Without this the
  // agent runs a second curl, and if they run it in a loop they land on the
  // rate limit - which is exactly how PR #3272 went three pushes with nobody
  // able to say which of its 6,192 tests had failed.
  if (WANT_LOG) {
    for (const f of st.failures ?? []) {
      if (!f.jobId) continue;
      f.detail = failureLines(await jobLog(f.jobId));
    }
  }

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          pr: pr?.number ?? null,
          branch: pr?.head.ref ?? branch ?? null,
          sha,
          state: pr && mergeLabel(pr) === 'DIRTY' ? 'DIRTY' : st.state,
          mergeable_state: pr ? mergeLabel(pr) : null,
          failures: st.failures,
          requiredProblems: st.requiredProblems,
          reason: st.reason ?? null,
        },
        null,
        2
      )
    );
    return pr && mergeLabel(pr) === 'DIRTY' ? EXIT.DIRTY : (EXIT[st.state] ?? EXIT.RED);
  }

  return render(pr, st);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => die(`unexpected: ${err?.stack || err}`));
}
