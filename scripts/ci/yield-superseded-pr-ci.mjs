#!/usr/bin/env node
// A HEAVY CI JOB YIELDS ITS RUNNER WHEN ITS SHA IS NO LONGER THE PR HEAD
// (2026-10-25).
//
// ci.yml keys its concurrency group on the head sha and never cancels in
// progress, so a newer push can never strand the run a required check is
// evaluated against (six pull requests were stranded that way, see ci.yml).
// Two mechanisms retire a superseded sha instead: `changes` skips the heavy
// matrix when the head has already moved, and the NEWER run's `changes` job
// cancels older runs of the same PR (retire-superseded-pr-ci.mjs).
//
// Both act at classification time. Hosted runners are capped, so a heavy job
// waits in the queue AFTER that decision: measured 2026-10-24 21:02Z to
// 2026-10-25 03:02Z, the median CI job waited 22 minutes for a runner (p90 46),
// and the newer run's own `changes` job waited just as long before it could
// retire anything. In those six hours 118 heavy jobs (accounting, server and
// client shards, build, browser suites) STARTED after their PR head had already
// been replaced and used 1,099 runner-minutes, about 9% of every runner-minute
// the repository spent, on commits nobody would merge.
//
// So each heavy job asks once, when it finally holds a runner. It cancels its
// own run only when ALL of these are proven, and reads them again immediately
// before the write:
//   - this is a pull_request run of ci.yml for exactly this sha and this PR;
//   - the PR is open, same-repository, and its head is a DIFFERENT sha;
//   - that newer head already has its own, newer ci.yml pull_request run, which
//     is the run that carries the required checks.
// The run for the current head can never satisfy the second condition, so it
// can never cancel itself.
//
// FAILS OPEN. Any unreadable or unexpected answer means "keep running": a cost
// control must never be able to remove a verdict.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const WORKFLOW_PATH = '.github/workflows/ci.yml';

export async function yieldIfSuperseded({
  eventName,
  repository,
  runId,
  prNumber,
  headSha,
  request,
  log = console.log,
}) {
  if (eventName !== 'pull_request') return { yielded: false, reason: 'not-a-pull-request-run' };
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !/^[0-9a-f]{40}$/.test(headSha) ||
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
    !Number.isSafeInteger(prNumber) ||
    prNumber <= 0
  ) {
    throw new Error('Current CI event identity is invalid');
  }
  const root = `/repos/${repository}`;
  const current = await request('GET', `${root}/actions/runs/${runId}`);
  if (
    current.id !== runId ||
    current.event !== 'pull_request' ||
    current.head_sha !== headSha ||
    current.path !== WORKFLOW_PATH ||
    !Number.isSafeInteger(current.workflow_id) ||
    !current.pull_requests?.some((p) => p.number === prNumber)
  ) {
    throw new Error('Current run does not prove the expected PR workflow identity');
  }
  const readHead = async () => {
    const pr = await request('GET', `${root}/pulls/${prNumber}`);
    const sameRepository =
      pr.state === 'open' &&
      pr.head?.repo?.full_name === repository &&
      pr.base?.repo?.full_name === repository &&
      /^[0-9a-f]{40}$/.test(pr.head?.sha ?? '');
    return sameRepository ? pr.head.sha : null;
  };
  const head = await readHead();
  if (head === null) return { yielded: false, reason: 'not-an-open-same-repository-pr' };
  if (head === headSha) return { yielded: false, reason: 'still-the-pull-request-head' };

  const successors = await request(
    'GET',
    `${root}/actions/workflows/${current.workflow_id}/runs?event=pull_request&head_sha=${head}&per_page=20`
  );
  if (!Array.isArray(successors.workflow_runs))
    throw new Error('Successor inventory is unreadable');
  const successor = successors.workflow_runs.find(
    (run) =>
      Number.isSafeInteger(run.id) &&
      run.id > runId &&
      run.workflow_id === current.workflow_id &&
      run.event === 'pull_request' &&
      run.head_sha === head &&
      run.pull_requests?.some((p) => p.number === prNumber)
  );
  if (!successor) return { yielded: false, reason: 'no-newer-run-for-the-new-head' };

  // Re-read immediately before the write. Any movement ends this authority.
  if ((await readHead()) !== head) return { yielded: false, reason: 'head-moved-while-checking' };

  log(
    `Superseded: run ${runId} tests ${headSha}; PR #${prNumber} head is ${head}, ` +
      `tested by newer run ${successor.id}. Yielding this run's runners.`
  );
  // Cancel, then force-cancel the same proven-obsolete run straight away. A
  // plain cancel lets this run's always() aggregators start on fresh runners and
  // report a cancellation on a sha nobody will merge; retire-superseded-pr-ci
  // reaches the same end state for the same reason. Nothing outside the run is
  // touched, and the current head's run is a different run.
  await request('POST', `${root}/actions/runs/${runId}/cancel`);
  await request('POST', `${root}/actions/runs/${runId}/force-cancel`);
  return { yielded: true, reason: 'superseded', successor: successor.id, head };
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventName !== 'pull_request') return;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('Configured Actions authorization is unavailable');
  const deadline = AbortSignal.timeout(30000);
  const request = async (method, path) => {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.any([AbortSignal.timeout(10000), deadline]),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path} returned ${response.status}`);
    return response.status === 204 || response.status === 202 ? {} : response.json();
  };
  // The runner answers the cancel by signalling this step. Hold the signal for
  // the two writes so the force-cancel is always sent.
  const hold = () => {};
  process.on('SIGINT', hold);
  process.on('SIGTERM', hold);
  const result = await yieldIfSuperseded({
    eventName,
    repository: process.env.GITHUB_REPOSITORY,
    runId: Number(process.env.GITHUB_RUN_ID),
    prNumber: Number(event.number),
    headSha: event.pull_request?.head?.sha,
    request,
  });
  process.off('SIGINT', hold);
  process.off('SIGTERM', hold);
  if (!result.yielded) {
    console.log(`Running: ${result.reason}.`);
    return;
  }
  // The run is cancelled; the runner stops this job. If it has not within a
  // minute, carry on with the job rather than leave it hanging.
  await new Promise((resolve) => setTimeout(resolve, 60000));
  console.log('::warning::Cancellation was requested but this job is still running; continuing.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(`::warning::Superseded-run check could not decide (${error.message}); running.`);
  });
}
