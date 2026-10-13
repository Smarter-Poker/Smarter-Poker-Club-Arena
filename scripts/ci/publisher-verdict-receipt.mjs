import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[1-9][0-9]*$/;
export const PROOFS = Object.freeze({
  'publish-to-origin': [
    'Stand down if the origin already serves a newer bundle',
    'Publish through the host-owned immutable transaction',
    'Verify the origin serves this bundle',
  ],
  'retain-runtime': [
    'Verify both origins still serve the qualified immutable runtime',
    'Record qualified retained runtime',
  ],
});
const fail = (message) => {
  throw new Error(`Publisher verdict receipt: ${message}`);
};
export function receiptName(jobKey, attempt) {
  if (!PROOFS[jobKey] || !ID.test(String(attempt))) fail('invalid artifact identity');
  return `club-arena-publisher-verdict-${jobKey}-attempt-${attempt}`;
}
export function validateReceipt(receipt) {
  const keys = [
    'schema',
    'repository',
    'repositoryId',
    'workflowRef',
    'workflowSha',
    'runId',
    'runAttempt',
    'jobKey',
    'triggerSha',
    'selectedSha',
    'runtimeSha',
    'verdict',
    'steps',
  ];
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Object.keys(receipt).sort().join() !== keys.sort().join() ||
    receipt.schema !== 1
  )
    fail('invalid schema');
  if (
    receipt.repository !== 'Smarter-Poker/Smarter-Poker-Club-Arena' ||
    receipt.workflowRef !==
      `${receipt.repository}/.github/workflows/publish-club-arena.yml@refs/heads/main` ||
    ![receipt.repositoryId, receipt.runId, receipt.runAttempt].every(
      (v) => typeof v === 'string' && ID.test(v)
    ) ||
    ![receipt.workflowSha, receipt.triggerSha, receipt.selectedSha, receipt.runtimeSha].every(
      (v) => typeof v === 'string' && SHA.test(v)
    )
  )
    fail('invalid source identity');
  const names = PROOFS[receipt.jobKey];
  if (!names || !Array.isArray(receipt.steps) || receipt.steps.length !== names.length)
    fail('invalid proof set');
  receipt.steps.forEach((step, index) => {
    if (
      !step ||
      Object.keys(step).sort().join() !== 'conclusion,name,status' ||
      step.name !== names[index] ||
      step.status !== 'completed' ||
      !['success', 'skipped'].includes(step.conclusion)
    )
      fail('invalid original step');
  });
  const conclusions = receipt.steps.map((s) => s.conclusion).join();
  if (receipt.jobKey === 'retain-runtime') {
    if (receipt.verdict !== 'retained' || conclusions !== 'success,success')
      fail('retention proof failed');
  } else if (receipt.verdict === 'publish') {
    if (conclusions !== 'success,success,success' || receipt.runtimeSha !== receipt.selectedSha)
      fail('publication proof failed');
  } else if (receipt.verdict === 'standdown') {
    if (conclusions !== 'success,skipped,skipped' || receipt.runtimeSha === receipt.selectedSha)
      fail('standdown proof failed');
  } else fail('invalid verdict');
  return receipt;
}

/** Producer consumes GitHub's original step conclusions, never logs or a job badge. */
export function createReceipt(env) {
  const jobKey = env.GITHUB_JOB;
  const names = PROOFS[jobKey];
  if (!names) fail('unsupported producer job');
  const conclusions = JSON.parse(env.RECEIPT_CONCLUSIONS);
  if (!Array.isArray(conclusions) || conclusions.length !== names.length)
    fail('missing conclusions');
  return validateReceipt({
    schema: 1,
    repository: env.GITHUB_REPOSITORY,
    repositoryId: env.GITHUB_REPOSITORY_ID,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    jobKey,
    triggerSha: env.GITHUB_SHA,
    selectedSha: env.RECEIPT_SELECTED_SHA,
    runtimeSha: env.RECEIPT_RUNTIME_SHA,
    verdict: env.RECEIPT_VERDICT,
    steps: names.map((name, i) => ({ name, status: 'completed', conclusion: conclusions[i] })),
  });
}

/** Only the caller's authenticated, complete same-attempt metadata supplies ownership. */
export function mergePublisherReceipt(
  receipt,
  { run, job, artifact, repositoryId, triggerSha, workflowSha }
) {
  validateReceipt(receipt);
  if (
    !run ||
    run.status !== 'completed' ||
    !['success', 'failure', 'cancelled'].includes(run.conclusion) ||
    String(run.id) !== receipt.runId ||
    !ID.test(String(run.run_attempt)) ||
    Number(receipt.runAttempt) > Number(run.run_attempt) ||
    run.head_branch !== 'main' ||
    run.head_sha !== triggerSha ||
    run.path !== '.github/workflows/publish-club-arena.yml' ||
    String(run.repository?.id) !== String(repositoryId) ||
    run.repository?.full_name !== receipt.repository ||
    receipt.repositoryId !== String(repositoryId) ||
    receipt.triggerSha !== triggerSha ||
    receipt.workflowSha !== workflowSha ||
    !SHA.test(workflowSha)
  )
    fail('foreign or unsuccessful run');
  if (
    !job ||
    !ID.test(String(job.id)) ||
    String(job.run_id) !== receipt.runId ||
    job.name !== receipt.jobKey ||
    job.status !== 'completed' ||
    job.conclusion !== 'success' ||
    job.head_sha !== triggerSha ||
    String(job.run_attempt) !== receipt.runAttempt ||
    !Array.isArray(job.steps)
  )
    fail('foreign or unsuccessful job');
  if (
    !artifact ||
    !ID.test(String(artifact.id)) ||
    artifact.expired !== false ||
    artifact.name !== receiptName(receipt.jobKey, receipt.runAttempt) ||
    String(artifact.workflow_run?.id) !== receipt.runId ||
    String(artifact.workflow_run?.repository_id) !== String(repositoryId) ||
    String(artifact.workflow_run?.head_repository_id) !== String(repositoryId) ||
    artifact.workflow_run?.head_sha !== triggerSha ||
    artifact.workflow_run?.head_branch !== 'main'
  )
    fail('foreign or expired artifact');
  // Present metadata is authoritative. Any missing, duplicate or conflicting named
  // proof in a nonempty response refuses fallback rather than hiding corruption.
  if (job.steps.length) {
    for (const proof of receipt.steps) {
      const matches = job.steps.filter((s) => s.name === proof.name);
      if (
        matches.length !== 1 ||
        matches[0].status !== proof.status ||
        matches[0].conclusion !== proof.conclusion
      )
        fail('conflicting present step metadata');
    }
    return job;
  }
  return { ...job, steps: receipt.steps.map((step) => ({ ...step })) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'write' || !process.argv[3]) fail('unsupported command');
  writeFileSync(process.argv[3], `${JSON.stringify(createReceipt(process.env), null, 2)}\n`, {
    flag: 'wx',
  });
}
