#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readBuildInfoSha, readPublisherArtifactSha } from './production-e2e-provenance.mjs';
import { readRetentionReceipt, receiptArtifactId } from './client-runtime-retention.mjs';

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[1-9][0-9]*$/;
const PREFIX = 'club-arena-release-verdict-';
const WORKFLOW = '.github/workflows/publish-club-arena.yml';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJSON = (file) => JSON.parse(readFileSync(file, 'utf8'));
const requireThat = (condition, message) => {
  if (!condition) throw new Error(message);
};
const exactResult = (step, result) => step?.outcome === result && step?.conclusion === result;

export function validateSource(source) {
  requireThat(
    source &&
      ['runId', 'attempt', 'repositoryId', 'triggerSha'].every(
        (field) => typeof source[field] === 'string'
      ) &&
      ID.test(source.runId) &&
      ID.test(source.attempt) &&
      ID.test(source.repositoryId) &&
      SHA.test(source.triggerSha) &&
      source.branch === 'main' &&
      source.workflow === WORKFLOW,
    'The verdict requires exact protected publisher run, attempt and repository provenance.'
  );
  return source;
}

export function makeReleaseVerdict({
  source,
  producerJob,
  mode,
  selectedSha,
  runtimeSha,
  steps,
  verifiedSha,
  buildInfo,
  manifest,
  retention,
}) {
  validateSource(source);
  requireThat(SHA.test(selectedSha) && SHA.test(runtimeSha), 'Release verdict SHAs are malformed.');
  if (mode === 'retained') {
    requireThat(
      producerJob === 'retain-runtime' &&
        exactResult(steps?.finalized, 'success') &&
        exactResult(steps?.recorded, 'success'),
      'Retention steps did not both actually succeed.'
    );
    const retained = readRetentionReceipt(
      retention,
      source.runId,
      source.triggerSha,
      source.repositoryId
    );
    requireThat(
      retained.verificationSha === selectedSha && retained.runtimeSha === runtimeSha,
      'The finalized retention receipt names a different release.'
    );
    return {
      schema: 1,
      kind: 'client-release-verdict',
      source,
      producerJob,
      mode,
      selectedSha,
      runtimeSha,
      steps,
      retentionSHA256: hash(retention),
    };
  }
  requireThat(
    producerJob === 'publish-to-origin' && exactResult(steps?.verdict, 'success'),
    'The origin release decision did not actually succeed.'
  );
  requireThat(
    readBuildInfoSha(buildInfo) === selectedSha && manifest?.length > 0,
    'The release verdict does not bind the downloaded immutable bundle.'
  );
  if (mode === 'publish') {
    requireThat(
      exactResult(steps?.published, 'success') &&
        exactResult(steps?.verified, 'success') &&
        verifiedSha === selectedSha &&
        runtimeSha === selectedSha,
      'Publication and both-origin verification must actually succeed for the selected SHA.'
    );
  } else {
    requireThat(
      mode === 'standdown' &&
        exactResult(steps?.published, 'skipped') &&
        exactResult(steps?.verified, 'skipped') &&
        selectedSha !== runtimeSha &&
        !verifiedSha,
      'A stand-down requires a forward decision with publication and verification skipped.'
    );
  }
  return {
    schema: 1,
    kind: 'client-release-verdict',
    source,
    producerJob,
    mode,
    selectedSha,
    runtimeSha,
    steps,
    verifiedSha: verifiedSha || null,
    buildInfoSHA256: hash(buildInfo),
    manifestSHA256: hash(manifest),
  };
}

export function inspectPublisherJobs(payload) {
  requireThat(
    payload &&
      Array.isArray(payload.jobs) &&
      Number.isSafeInteger(payload.total_count) &&
      payload.total_count === payload.jobs.length,
    'Source job metadata is incomplete.'
  );
  const origin = payload.jobs.filter((job) => job?.name === 'publish-to-origin');
  const retained = payload.jobs.filter((job) => job?.name === 'retain-runtime');
  if (
    !origin.length &&
    payload.jobs.every((job) => ['cancelled', 'skipped'].includes(job?.conclusion))
  ) {
    return null; // Superseded before an origin job existed: no certificate verdict.
  }
  requireThat(
    origin.length === 1 && retained.length <= 1,
    'The publisher job selection is ambiguous.'
  );
  const succeeded = (job) => job?.status === 'completed' && job?.conclusion === 'success';
  if (succeeded(retained[0])) {
    requireThat(
      origin[0].status === 'completed' && origin[0].conclusion === 'skipped',
      'Retention cannot coexist with an origin transaction.'
    );
    return retained[0];
  }
  requireThat(
    succeeded(origin[0]) &&
      (!retained.length ||
        (retained[0].status === 'completed' && retained[0].conclusion === 'skipped')),
    'The source publisher has no successful unique origin or retention operation.'
  );
  return origin[0];
}

export function validateRun(run, source) {
  validateSource(source);
  requireThat(
    run &&
      String(run.id) === source.runId &&
      String(run.run_attempt) === source.attempt &&
      run.head_sha === source.triggerSha &&
      run.head_branch === 'main' &&
      run.path === WORKFLOW &&
      String(run.repository?.id) === source.repositoryId &&
      String(run.head_repository?.id) === source.repositoryId,
    'Source workflow metadata does not bind this exact protected publisher attempt.'
  );
}

function validateJob(job, source) {
  requireThat(
    Number.isSafeInteger(job.id) &&
      job.id > 0 &&
      String(job.run_id) === source.runId &&
      String(job.run_attempt) === source.attempt &&
      job.head_sha === source.triggerSha,
    'The producer job does not belong to the exact source run and attempt.'
  );
}

export function verdictArtifact(payload, source) {
  validateSource(source);
  requireThat(
    payload &&
      Array.isArray(payload.artifacts) &&
      Number.isSafeInteger(payload.total_count) &&
      payload.total_count === payload.artifacts.length,
    'Release artifact metadata is incomplete.'
  );
  const name = PREFIX + source.attempt;
  const artifacts = payload.artifacts.filter((item) => item?.name === name);
  requireThat(
    artifacts.length === 1,
    'Exactly one release-verdict receipt for this attempt is required.'
  );
  // The existing validator verifies the authenticated artifact envelope, not just its name.
  readPublisherArtifactSha(
    JSON.stringify({
      total_count: 1,
      artifacts: [{ ...artifacts[0], name: 'club-arena-dist-' + source.triggerSha }],
    }),
    source.runId,
    source.triggerSha,
    source.repositoryId
  );
  return artifacts[0];
}

export function admitReleaseVerdict({
  source,
  run,
  jobs,
  artifacts,
  receipt,
  retention,
  isProtected = (sha) => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
      return true;
    } catch {
      return false;
    }
  },
  isAncestor = (before, after) => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', before, after]);
      return true;
    } catch {
      return false;
    }
  },
}) {
  validateRun(run, source);
  const job = inspectPublisherJobs(jobs);
  if (!job) return { shouldRun: false };
  validateJob(job, source);
  verdictArtifact(artifacts, source);
  requireThat(
    receipt?.schema === 1 &&
      receipt.kind === 'client-release-verdict' &&
      receipt.source &&
      Object.keys(receipt.source).length === Object.keys(source).length &&
      Object.keys(source).every((field) => receipt.source[field] === source[field]) &&
      receipt.producerJob === job.name &&
      SHA.test(receipt.selectedSha) &&
      SHA.test(receipt.runtimeSha),
    'The release-verdict receipt does not bind the selected source job.'
  );
  requireThat(
    isProtected(source.triggerSha) &&
      isProtected(receipt.selectedSha) &&
      isProtected(receipt.runtimeSha) &&
      isAncestor(source.triggerSha, receipt.selectedSha),
    'The release-verdict SHAs are not protected-main ancestors.'
  );
  if (receipt.mode === 'retained') {
    requireThat(
      job.name === 'retain-runtime' &&
        exactResult(receipt.steps?.finalized, 'success') &&
        exactResult(receipt.steps?.recorded, 'success') &&
        hash(retention || '') === receipt.retentionSHA256,
      'The finalized retained-runtime proof does not match the release verdict.'
    );
    receiptArtifactId(artifacts, source.runId, source.triggerSha, source.repositoryId);
    const retained = readRetentionReceipt(
      retention,
      source.runId,
      source.triggerSha,
      source.repositoryId
    );
    requireThat(
      retained.verificationSha === receipt.selectedSha &&
        retained.runtimeSha === receipt.runtimeSha &&
        isAncestor(receipt.runtimeSha, receipt.selectedSha),
      'Retained runtime lineage does not match.'
    );
    return { shouldRun: true, retained: true };
  }
  requireThat(
    job.name === 'publish-to-origin' &&
      readPublisherArtifactSha(
        JSON.stringify(artifacts),
        source.runId,
        source.triggerSha,
        source.repositoryId
      ) === receipt.selectedSha &&
      /^[0-9a-f]{64}$/.test(receipt.buildInfoSHA256) &&
      /^[0-9a-f]{64}$/.test(receipt.manifestSHA256) &&
      exactResult(receipt.steps?.verdict, 'success'),
    'The receipt does not bind the actual publisher bundle.'
  );
  if (receipt.mode === 'publish') {
    requireThat(
      exactResult(receipt.steps?.published, 'success') &&
        exactResult(receipt.steps?.verified, 'success') &&
        receipt.verifiedSha === receipt.selectedSha &&
        receipt.runtimeSha === receipt.selectedSha,
      'Publication did not actually verify its selected bundle.'
    );
  } else {
    requireThat(
      receipt.mode === 'standdown' &&
        exactResult(receipt.steps?.published, 'skipped') &&
        exactResult(receipt.steps?.verified, 'skipped') &&
        receipt.verifiedSha === null &&
        receipt.selectedSha !== receipt.runtimeSha &&
        isAncestor(receipt.selectedSha, receipt.runtimeSha),
      'The stand-down receipt does not prove a safe forward release.'
    );
  }
  return { shouldRun: true, retained: false };
}

function sourceFromEnvironment(environment, producer) {
  return validateSource({
    runId: producer ? environment.GITHUB_RUN_ID : environment.SOURCE_RUN_ID,
    attempt: producer ? environment.GITHUB_RUN_ATTEMPT : environment.SOURCE_RUN_ATTEMPT,
    repositoryId: producer ? environment.GITHUB_REPOSITORY_ID : environment.REPOSITORY_ID,
    triggerSha: producer ? environment.GITHUB_SHA : environment.SOURCE_TRIGGER_SHA,
    branch: 'main',
    workflow: WORKFLOW,
  });
}

export function main(args = process.argv.slice(2), environment = process.env) {
  const [command, ...files] = args;
  const source = sourceFromEnvironment(
    environment,
    command === 'produce-origin' || command === 'produce-retained'
  );
  if (command === 'produce-origin' || command === 'produce-retained') {
    requireThat(
      environment.GITHUB_REF === 'refs/heads/main',
      'Only protected-main publisher runs emit verdicts.'
    );
    const steps = JSON.parse(environment.RELEASE_STEP_RESULTS);
    const retained = command === 'produce-retained';
    const retention = retained ? readFileSync(files[1], 'utf8') : undefined;
    const existing = retained
      ? readRetentionReceipt(retention, source.runId, source.triggerSha, source.repositoryId)
      : null;
    const receipt = makeReleaseVerdict({
      source,
      producerJob: environment.GITHUB_JOB,
      mode: retained ? 'retained' : environment.RELEASE_VERDICT,
      selectedSha: retained ? existing.verificationSha : environment.SELECTED_SHA,
      runtimeSha: retained ? existing.runtimeSha : environment.RUNTIME_SHA,
      verifiedSha: environment.VERIFIED_SHA,
      steps,
      retention,
      buildInfo: retained ? undefined : readFileSync('dist/build-info.json'),
      manifest: retained ? undefined : readFileSync('dist/.release-manifest.sha256'),
    });
    writeFileSync(files[0], JSON.stringify(receipt) + '\n', { flag: 'wx' });
    return;
  }
  const [runFile, jobsFile, artifactsFile, receiptFile, retentionFile] = files;
  const run = readJSON(runFile),
    jobs = readJSON(jobsFile),
    artifacts = readJSON(artifactsFile);
  validateRun(run, source);
  const job = inspectPublisherJobs(jobs);
  if (command === 'select') {
    if (job) validateJob(job, source);
    console.log(job ? verdictArtifact(artifacts, source).name : 'none');
    return;
  }
  requireThat(command === 'admit', 'Unknown release-verdict operation.');
  const result = admitReleaseVerdict({
    source,
    run,
    jobs,
    artifacts,
    receipt: readJSON(receiptFile),
    retention: retentionFile ? readFileSync(retentionFile, 'utf8') : undefined,
  });
  if (result.shouldRun) {
    appendFileSync(
      environment.GITHUB_OUTPUT,
      'should_run=true\n' + (result.retained ? 'retained=true\n' : '')
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
