import {isClubArenaRepository} from './repository-identity.mjs';
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
    'verifiedSha',
    'steps',
  ];
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Object.keys(receipt).sort().join() !== keys.sort().join() ||
    receipt.schema !== 2
  )
    fail('invalid schema');
  if (
    !isClubArenaRepository(receipt.repository, receipt.repositoryId) ||
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
      Object.keys(step).sort().join() !== 'conclusion,name,outcome,status' ||
      step.name !== names[index] ||
      step.status !== 'completed' ||
      !['success', 'skipped'].includes(step.conclusion) ||
      step.outcome !== step.conclusion
    )
      fail('invalid original step');
  });
  if (typeof receipt.verifiedSha !== 'string') fail('missing actual verification output');
  const conclusions = receipt.steps.map((s) => s.conclusion).join();
  if (receipt.jobKey === 'retain-runtime') {
    if (
      receipt.verdict !== 'retained' ||
      conclusions !== 'success,success' ||
      receipt.verifiedSha !== ''
    )
      fail('retention proof failed');
  } else if (receipt.verdict === 'publish') {
    if (
      conclusions !== 'success,success,success' ||
      receipt.runtimeSha !== receipt.selectedSha ||
      receipt.verifiedSha !== receipt.selectedSha
    )
      fail('publication proof failed');
  } else if (receipt.verdict === 'standdown') {
    if (
      conclusions !== 'success,skipped,skipped' ||
      receipt.runtimeSha === receipt.selectedSha ||
      receipt.verifiedSha !== ''
    )
      fail('standdown proof failed');
  } else fail('invalid verdict');
  return receipt;
}

/** Inspect original metadata without replacing any present proof or accepting corruption. */
export function missingPublisherProofs(jobKey, steps) {
  const names = PROOFS[jobKey];
  if (!names || !Array.isArray(steps)) fail('invalid present step metadata');
  const seen = new Set();
  for (const step of steps) {
    if (
      !step ||
      typeof step !== 'object' ||
      Array.isArray(step) ||
      typeof step.name !== 'string' ||
      !step.name ||
      typeof step.status !== 'string' ||
      !(step.conclusion === null || typeof step.conclusion === 'string')
    )
      fail('invalid present step metadata');
    if (!names.includes(step.name)) continue;
    if (
      seen.has(step.name) ||
      step.status !== 'completed' ||
      !['success', 'skipped'].includes(step.conclusion)
    )
      fail('conflicting present step metadata');
    seen.add(step.name);
  }
  return names.filter((name) => !seen.has(name));
}

/** Original outcomes and conclusions must agree; actual verification supplies the published SHA. */
export function createReceipt(env) {
  const jobKey = env.GITHUB_JOB;
  const names = PROOFS[jobKey];
  if (!names) fail('unsupported producer job');
  const conclusions = JSON.parse(env.RECEIPT_CONCLUSIONS);
  const outcomes = JSON.parse(env.RECEIPT_OUTCOMES);
  if (!Array.isArray(conclusions) || conclusions.length !== names.length)
    fail('missing conclusions');
  if (!Array.isArray(outcomes) || outcomes.length !== names.length) fail('missing outcomes');
  return validateReceipt({
    schema: 2,
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
    verifiedSha: env.RECEIPT_VERIFIED_SHA,
    steps: names.map((name, i) => ({
      name,
      status: 'completed',
      outcome: outcomes[i],
      conclusion: conclusions[i],
    })),
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
  // Present original proofs remain authoritative; only absent names may be filled.
  const missing = missingPublisherProofs(job.name, job.steps);
  for (const proof of receipt.steps) {
    const present = job.steps.find((step) => step.name === proof.name);
    if (present && (present.status !== proof.status || present.conclusion !== proof.conclusion))
      fail('conflicting present step metadata');
  }
  if (!missing.length) return job;
  return {
    ...job,
    steps: [
      ...job.steps,
      ...receipt.steps.filter((step) => missing.includes(step.name)).map((step) => ({ ...step })),
    ],
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'write' || !process.argv[3]) fail('unsupported command');
  writeFileSync(process.argv[3], `${JSON.stringify(createReceipt(process.env), null, 2)}\n`, {
    flag: 'wx',
  });
}
