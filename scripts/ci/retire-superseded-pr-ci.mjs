#!/usr/bin/env node
// One bounded action of the current PR event, never a watcher or release owner.
// Retire only this workflow's obsolete heads of this exact same-repository PR.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function retireSupersededPrCi({
  repository,
  runId,
  prNumber,
  headSha,
  request,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
}) {
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
    current.path !== '.github/workflows/ci.yml' ||
    !current.pull_requests?.some((p) => p.number === prNumber)
  ) {
    throw new Error('Current run does not prove the expected PR workflow identity');
  }
  const stillOwnsHead = async () => {
    const pr = await request('GET', `${root}/pulls/${prNumber}`);
    return (
      pr.state === 'open' &&
      pr.head?.sha === headSha &&
      pr.head?.repo?.full_name === repository &&
      pr.base?.repo?.full_name === repository
    );
  };
  if (!(await stillOwnsHead())) return { retired: [], reason: 'not-current-same-repository-head' };
  const eligible = (run) =>
    run.id !== runId &&
    run.workflow_id === current.workflow_id &&
    run.event === 'pull_request' &&
    run.head_sha !== headSha &&
    /^[0-9a-f]{40}$/.test(run.head_sha) &&
    run.status !== 'completed' &&
    run.pull_requests?.some((p) => p.number === prNumber);
  const listed = await request(
    'GET',
    `${root}/actions/workflows/${current.workflow_id}/runs?event=pull_request&per_page=100`
  );
  if (!Array.isArray(listed.workflow_runs)) throw new Error('CI run inventory is unreadable');
  const candidates = listed.workflow_runs.filter(eligible).slice(0, 10);
  const retired = [];
  const cancelled = [];
  const forced = [];
  const confirm = (observed) => {
    retired.push(observed.id);
    log(
      `Confirmed obsolete PR #${prNumber} CI run ${observed.id} is terminal (${observed.conclusion ?? 'completed'})`
    );
  };
  for (const candidate of candidates) {
    // Re-read both identities immediately before each write. A newer push ends
    // this older event's authority; it can never cancel that newer head.
    const observed = await request('GET', `${root}/actions/runs/${candidate.id}`);
    if (!eligible(observed) || !(await stillOwnsHead())) continue;
    await request('POST', `${root}/actions/runs/${candidate.id}/cancel`);
    cancelled.push(candidate.id);
  }
  if (cancelled.length) await wait(5000);
  for (const id of cancelled) {
    const observed = await request('GET', `${root}/actions/runs/${id}`);
    if (observed.status !== 'completed') {
      // always() validation/cleanup jobs can ignore normal cancellation. The
      // force endpoint is allowed only after that failed attempt, and only for
      // the same reverified obsolete head. Current required checks stay intact.
      if (!eligible(observed) || !(await stillOwnsHead())) continue;
      await request('POST', `${root}/actions/runs/${id}/force-cancel`);
      forced.push(id);
    } else {
      confirm(observed);
    }
  }
  // GitHub can acknowledge force cancellation before the run readback turns
  // terminal. Observe the whole batch within one finite request budget, rather
  // than abandoning the remaining obsolete runs after the first delayed one.
  // These reads never repeat a cancellation or acquire new write authority.
  const pending = new Set(forced);
  for (let attempt = 0; attempt < 6 && pending.size; attempt++) {
    await wait(5000);
    for (const id of pending) {
      const observed = await request('GET', `${root}/actions/runs/${id}`);
      if (observed.status === 'completed') {
        confirm(observed);
        pending.delete(id);
      }
    }
  }
  if (pending.size) {
    throw new Error(
      `Obsolete CI run ${[...pending].join(', ')} has not confirmed terminal cancellation`
    );
  }
  return { retired, reason: 'bounded-current-event-complete' };
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('Configured Actions authorization is unavailable');
  // Leave half the existing five-minute job for checkout and classification.
  const operationDeadline = AbortSignal.timeout(150000);
  const request = async (method, path) => {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.any([AbortSignal.timeout(10000), operationDeadline]),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path} returned ${response.status}`);
    return response.status === 204 || response.status === 202 ? {} : response.json();
  };
  await retireSupersededPrCi({
    repository: process.env.GITHUB_REPOSITORY,
    runId: Number(process.env.GITHUB_RUN_ID),
    prNumber: Number(event.number),
    headSha: event.pull_request?.head?.sha,
    request,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Cancellation cannot classify a diff as safe or replace any required test.
    // Report its precise failure; the existing classifier and gates still run.
    console.error(`::warning::Obsolete CI retirement incomplete: ${error.message}`);
  });
}
