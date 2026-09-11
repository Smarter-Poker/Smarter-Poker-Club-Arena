#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const authority = Object.freeze({
  repository: 'Smarter-Poker/Smarter-Poker-Club-Arena',
  repositoryId: 1132369872,
  workflowId: 247739539,
  workflowPath: '.github/workflows/ci.yml',
  baseBranch: 'main',
});
const prefix = `repos/${authority.repository}`;
const workflowEndpoint = `${prefix}/actions/workflows/ci.yml`;
const maximumRuns = 20;
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const repo = (value) =>
  value?.id === authority.repositoryId && value?.full_name === authority.repository;
const ensure = (condition, reason) => {
  if (!condition) throw new Error(reason);
};

function checkWorkflow(workflow) {
  ensure(workflow?.id === authority.workflowId, 'workflow-id-mismatch');
  ensure(workflow.path === authority.workflowPath, 'workflow-path-mismatch');
  ensure(workflow.state === 'active', 'workflow-not-active');
}
function checkRun(run) {
  ensure(positiveId(run?.id) && positiveId(run.run_attempt), 'invalid-run-identity');
  ensure(repo(run.repository) && repo(run.head_repository), 'foreign-run-repository');
  ensure(run.workflow_id === authority.workflowId, 'foreign-run-workflow');
  ensure(run.path === authority.workflowPath, 'foreign-run-path');
  ensure(run.event === 'pull_request', 'not-pull-request-ci');
  ensure(sha(run.head_sha), 'invalid-run-head');
  ensure(Array.isArray(run.pull_requests) && run.pull_requests.length === 1, 'ambiguous-run-pr');
  const association = run.pull_requests[0];
  ensure(positiveId(association?.id) && positiveId(association.number), 'invalid-pr-association');
  ensure(
    association.base?.repo?.id === authority.repositoryId &&
      association.head?.repo?.id === authority.repositoryId,
    'foreign-pr-association'
  );
  ensure(association.base.ref === authority.baseBranch, 'foreign-base-branch');
  ensure(
    typeof run.head_branch === 'string' &&
      run.head_branch.length > 0 &&
      association.head.ref === run.head_branch &&
      sha(association.head.sha),
    'inconsistent-run-head'
  );
  return association;
}
function checkPr(pr, association) {
  ensure(positiveId(pr?.id) && pr.id === association.id, 'pr-id-mismatch');
  ensure(pr.number === association.number && pr.state === 'open', 'pr-not-open');
  ensure(repo(pr.base?.repo) && repo(pr.head?.repo), 'foreign-live-pr');
  ensure(pr.base.ref === authority.baseBranch, 'live-base-moved');
  ensure(sha(pr.head.sha) && pr.head.ref === association.head.ref, 'live-head-moved');
}
const active = (run) => ['queued', 'in_progress'].includes(run.status) && run.conclusion === null;
const successorReady = (run) =>
  (run.status === 'in_progress' && run.conclusion === null) ||
  (run.status === 'completed' && run.conclusion === 'success');

/** No caller-provided branch name or workflow display name authorizes a cancel. */
export function cancellationDecision({ workflow, pr, successor, candidate }) {
  try {
    checkWorkflow(workflow);
    const nextPr = checkRun(successor);
    const oldPr = checkRun(candidate);
    checkPr(pr, nextPr);
    checkPr(pr, oldPr);
    ensure(candidate.id !== successor.id, 'successor-is-never-a-target');
    ensure(successor.head_sha === pr.head.sha, 'successor-is-not-current-head');
    ensure(candidate.head_sha !== pr.head.sha, 'current-head-is-never-a-target');
    ensure(successorReady(successor), 'successor-is-not-active-or-successful');
    ensure(active(candidate), 'candidate-is-not-active');
    return { eligible: true, reason: 'superseded-pr-ci' };
  } catch (error) {
    return { eligible: false, reason: error.message };
  }
}

// Run status may advance normally, but a new attempt or changed identity invalidates
// the preview. Mutable PR state is checked anew, with its head read last.
const runIdentity = (run) =>
  JSON.stringify({
    id: run.id,
    attempt: run.run_attempt,
    repository: [run.repository?.id, run.repository?.full_name],
    headRepository: [run.head_repository?.id, run.head_repository?.full_name],
    workflow: run.workflow_id,
    path: run.path,
    event: run.event,
    head: run.head_sha,
    branch: run.head_branch,
    // GitHub returns the CURRENT PR head/base snapshot even for an older run.
    // That mutable snapshot is not the run's source; run.head_sha is.
    associations: run.pull_requests?.map((pr) => [
      pr.id,
      pr.number,
      pr.base?.repo?.id,
      pr.base?.ref,
      pr.head?.repo?.id,
      pr.head?.ref,
    ]),
  });

export async function inspectSupersededPrCi({ api, sourceRunId, apply = false }) {
  ensure(positiveId(sourceRunId), 'invalid-source-run-id');
  ensure(typeof apply === 'boolean', 'invalid-apply-mode');
  const workflow = await api.get(workflowEndpoint);
  checkWorkflow(workflow);
  const successor = await api.get(`${prefix}/actions/runs/${sourceRunId}`);
  const association = checkRun(successor);
  ensure(successor.id === sourceRunId, 'source-run-id-mismatch');
  const pr = await api.get(`${prefix}/pulls/${association.number}`);
  checkPr(pr, association);
  ensure(successor.head_sha === pr.head.sha, 'source-is-not-current-head');
  ensure(successorReady(successor), 'source-is-not-active-or-successful');

  // Scope discovery to this branch and this exact CI workflow. Read every bounded
  // page before considering any mutation; overflow or API failure cancels nothing.
  const pages = await Promise.all(
    ['queued', 'in_progress'].map((status) =>
      api.get(
        `${prefix}/actions/workflows/${authority.workflowId}/runs?event=pull_request` +
          `&branch=${encodeURIComponent(successor.head_branch)}&status=${status}` +
          `&per_page=${maximumRuns + 1}&page=1`
      )
    )
  );
  const candidates = new Map();
  for (const page of pages) {
    ensure(
      Number.isSafeInteger(page?.total_count) &&
        page.total_count >= 0 &&
        page.total_count <= maximumRuns &&
        Array.isArray(page.workflow_runs) &&
        page.workflow_runs.length === page.total_count,
      'incomplete-or-overflowed-run-inventory'
    );
    for (const run of page.workflow_runs) {
      ensure(positiveId(run?.id), 'invalid-inventory-run-id');
      const prior = candidates.get(run.id);
      ensure(!prior || runIdentity(prior) === runIdentity(run), 'inconsistent-duplicate-run');
      candidates.set(run.id, run);
    }
  }
  ensure(candidates.size <= maximumRuns, 'run-inventory-limit');
  const receipt = {
    mode: apply ? 'apply' : 'dry-run',
    sourceRunId,
    pr: pr.number,
    headSha: pr.head.sha,
    decisions: [],
  };
  for (const candidate of candidates.values()) {
    const preview = cancellationDecision({ workflow, pr, successor, candidate });
    if (!preview.eligible) {
      receipt.decisions.push({ runId: candidate.id, action: 'refused', reason: preview.reason });
      continue;
    }

    // Re-read ALL authorization records for each target; never apply a preview
    // list. PR is the last read, directly before the decision and possible POST.
    const freshWorkflow = await api.get(workflowEndpoint);
    const freshCandidate = await api.get(`${prefix}/actions/runs/${candidate.id}`);
    const freshSuccessor = await api.get(`${prefix}/actions/runs/${sourceRunId}`);
    const freshPr = await api.get(`${prefix}/pulls/${pr.number}`);
    const fresh = cancellationDecision({
      workflow: freshWorkflow,
      pr: freshPr,
      successor: freshSuccessor,
      candidate: freshCandidate,
    });
    if (
      !fresh.eligible ||
      runIdentity(freshCandidate) !== runIdentity(candidate) ||
      runIdentity(freshSuccessor) !== runIdentity(successor)
    ) {
      receipt.decisions.push({
        runId: candidate.id,
        action: 'refused',
        reason: fresh.eligible ? 'run-identity-changed' : fresh.reason,
      });
      continue;
    }
    if (apply) await api.cancel(candidate.id);
    receipt.decisions.push({
      runId: candidate.id,
      action: apply ? 'cancel-requested' : 'would-cancel',
      reason: fresh.reason,
    });
  }
  return receipt;
}

/** Uses existing gh authentication; does not read, create, print, or copy tokens. */
export function githubClient(execute = promisify(execFile)) {
  async function request(method, endpoint) {
    try {
      const result = await execute(
        'gh',
        ['api', '--hostname', 'github.com', '--method', method, endpoint],
        {
          encoding: 'utf8',
          timeout: 15_000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_DEBUG: '' },
        }
      );
      return method === 'GET' ? JSON.parse(result.stdout) : undefined;
    } catch {
      // Do not replay authentication diagnostics or arbitrary API bodies into logs.
      throw new Error(`github-api-${method.toLowerCase()}-failed`);
    }
  }
  return {
    get: (endpoint) => {
      ensure(endpoint.startsWith(`${prefix}/`), 'foreign-api-endpoint');
      return request('GET', endpoint);
    },
    cancel: (runId) => {
      ensure(positiveId(runId), 'invalid-cancel-run-id');
      return request('POST', `${prefix}/actions/runs/${runId}/cancel`);
    },
  };
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const source = args.filter((arg) => arg !== '--apply');
    ensure(source.length === 2 && source[0] === '--source-run-id', 'invalid-cli-arguments');
    ensure(/^[1-9][0-9]*$/.test(source[1]), 'invalid-source-run-id');
    ensure(args.filter((arg) => arg === '--apply').length <= 1, 'duplicate-apply-argument');
    const result = await inspectSupersededPrCi({
      api: githubClient(),
      sourceRunId: Number(source[1]),
      apply,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`PR CI supersession refused: ${error.message}`);
    process.exitCode = 1;
  }
}
