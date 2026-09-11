#!/usr/bin/env node
import { readFile, writeFile, mkdir, appendFile, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { githubTransport } from '../../operations/release/adapters/github.mjs';
import { GitHubStaticAdapter } from '../../operations/release/adapters/github-static.mjs';
import {
  requireCertificate as need,
  uuid,
  sameFacts,
} from '../../operations/release/component-certificate.mjs';
import { nativeRead } from './prove-retained-frontend.mjs';
import { jsonResponse } from '../../operations/release/certification-client.mjs';

// A controlled static run waits for native staging, the semantic matrix and
// any owned engine cutover. The corresponding 145-minute job leaves 25
// minutes for preparation, publication/readback and failure recovery. These
// are bounded initial limits; the release's earlier deadline always wins.
export const controlledStaticWaitMilliseconds = 120 * 60 * 1000;
export const controlledStaticPublicationReserveMilliseconds = 20 * 60 * 1000;

export function staticRequest(environment) {
  const request = JSON.parse(environment.RELEASE_STATIC_REQUEST || 'null');
  const operation = environment.RELEASE_STATIC_BUILD_OPERATION;
  need(
    request?.phase === 'BUILD' &&
      uuid.test(operation) &&
      environment.GITHUB_EVENT_NAME === 'repository_dispatch' &&
      request.repository === environment.GITHUB_REPOSITORY &&
      String(request.repository_id) === environment.GITHUB_REPOSITORY_ID &&
      request.control_sha === environment.GITHUB_SHA &&
      environment.GITHUB_RUN_ATTEMPT === '1' &&
      request.static_authority?.url === environment.RELEASE_STATIC_AUTHORITY_URL &&
      request.static_authority?.installation_receipt ===
        environment.RELEASE_STATIC_INGRESS_RECEIPT &&
      request.static_authority?.audience === 'club-arena-static-publication' &&
      /^https:\/\/[a-z0-9.-]+\/static-publication$/.test(request.static_authority.url)
  );
  new GitHubStaticAdapter({
    repo: request.repository,
    repositoryId: request.repository_id,
    controlSha: request.control_sha,
    workflowId: request.workflow_id,
  }).validate(request);
  return request;
}
async function staticAuthority(request, body, environment, fetchImpl) {
  need(
    environment.ACTIONS_ID_TOKEN_REQUEST_URL && environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    'RELEASE_STATIC_IDENTITY_NOT_INSTALLED'
  );
  const url = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL);
  need(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.hostname.endsWith('.actions.githubusercontent.com')
  );
  url.searchParams.set('audience', request.static_authority.audience);
  const tokenResponse = await fetchImpl(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
      'Cache-Control': 'no-cache',
    },
  });
  const token = await jsonResponse(tokenResponse);
  need(typeof token.value === 'string' && token.value.length <= 16384);
  const response = await fetchImpl(request.static_authority.url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: `Bearer ${token.value}`,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    },
    body: JSON.stringify(body),
  });
  return jsonResponse(response);
}
export async function staticPublicationJournal({
  phase,
  environment = process.env,
  directory = path.join(environment.RUNNER_TEMP, 'release-static'),
  github = githubTransport(environment.GH_TOKEN),
  readNative = nativeRead,
  fetchImpl = fetch,
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  now = Date.now,
}) {
  const request = staticRequest(environment),
    buildOperation = environment.RELEASE_STATIC_BUILD_OPERATION;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (phase === 'wait') {
    // Repeating an unanswered read is allowed; repeating a granted effect is not.
    const filename = path.join(directory, 'claim-key.json');
    let claim;
    try {
      const file = await open(filename, 'wx', 0o600);
      try {
        claim = { claim_key: randomUUID(), build_operation_id: buildOperation };
        await file.writeFile(JSON.stringify(claim));
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      claim = JSON.parse(await readFile(filename, 'utf8'));
    }
    need(claim.build_operation_id === buildOperation && uuid.test(claim.claim_key));
    const deadline = Math.min(
      request.not_after_epoch * 1000 - controlledStaticPublicationReserveMilliseconds,
      now() + controlledStaticWaitMilliseconds
    );
    while (now() < deadline) {
      const grant = await staticAuthority(request, claim, environment, fetchImpl);
      if (!grant.ready) {
        await wait(10000);
        continue;
      }
      need(now() < deadline, 'RELEASE_STATIC_AUTHORIZATION_DEADLINE');
      need(
        grant.may_publish === true &&
          uuid.test(grant.operation_id) &&
          uuid.test(grant.claim_receipt),
        'RELEASE_STATIC_GRANT_ALREADY_CONSUMED'
      );
      need(
        grant.request.build_operation_id === buildOperation &&
          grant.request.build_run_id === environment.GITHUB_RUN_ID &&
          grant.request.source_sha === request.source_sha &&
          grant.request.control_sha === request.control_sha &&
          grant.request.manifest_digest === request.manifest_digest
      );
      const manifest = await readFile('dist/.release-manifest.sha256');
      need(
        createHash('sha256').update(manifest).digest('hex') ===
          grant.request.artifact.manifest_digest
      );
      await writeFile(path.join(directory, 'publication.json'), JSON.stringify(grant), {
        flag: 'wx',
        mode: 0o600,
      });
      await appendFile(environment.GITHUB_OUTPUT, `operation_id=${grant.operation_id}\n`);
      return grant;
    }
    throw new Error('RELEASE_STATIC_AUTHORIZATION_DEADLINE');
  }
  need(['build', 'publish'].includes(phase));
  const jobs = await github(
    `/repos/${request.repository}/actions/runs/${environment.GITHUB_RUN_ID}/jobs?filter=latest&per_page=100`
  );
  need(
    Array.isArray(jobs.jobs) && jobs.total_count === jobs.jobs.length && jobs.total_count <= 100
  );
  const name = phase === 'build' ? 'build-and-store' : 'publish-to-origin';
  const selected = jobs.jobs.filter((j) => j.name === name);
  need(selected.length === 1);
  let operation = buildOperation,
    exactRequest = request,
    fields;
  if (phase === 'build') {
    const artifact = await github(
      `/repos/${request.repository}/actions/artifacts/${environment.STATIC_DIST_ARTIFACT_ID}`
    );
    need(
      String(artifact.id) === environment.STATIC_DIST_ARTIFACT_ID &&
        artifact.name === `club-arena-dist-${request.source_sha}` &&
        !artifact.expired &&
        /^sha256:[0-9a-f]{64}$/.test(artifact.digest) &&
        String(artifact.workflow_run?.id) === environment.GITHUB_RUN_ID
    );
    const manifest_digest = createHash('sha256')
      .update(await readFile('dist/.release-manifest.sha256'))
      .digest('hex');
    const build = JSON.parse(await readFile('dist/build-info.json', 'utf8'));
    need(build.ca_sha === request.source_sha && build.run_id === environment.GITHUB_RUN_ID);
    fields = {
      artifact: {
        components: {
          'club-arena-web': {
            identity: `sha256:${manifest_digest}`,
            manifest_digest,
            source_sha: request.source_sha,
            github_artifact_id: String(artifact.id),
            github_archive_digest: artifact.digest,
            github_archive_bytes: artifact.size_in_bytes,
            build_operation_id: buildOperation,
            build_run_id: environment.GITHUB_RUN_ID,
          },
        },
      },
    };
  } else {
    const grant = JSON.parse(await readFile(path.join(directory, 'publication.json'), 'utf8'));
    need(grant.may_publish === true && grant.request.build_operation_id === buildOperation);
    operation = grant.operation_id;
    exactRequest = grant.request;
    const native = await readNative(request.source_sha);
    need(
      native.source_sha === exactRequest.source_sha &&
        native.manifest_sha256 === exactRequest.artifact.manifest_digest &&
        native.build_info.run_id === environment.GITHUB_RUN_ID &&
        sameFacts(native.build_info, JSON.parse(await readFile('dist/build-info.json', 'utf8')))
    );
    fields = { component: exactRequest.artifact, native, publication_claim: grant.claim_receipt };
  }
  const result = {
    operation_id: operation,
    request: exactRequest,
    control_sha: request.control_sha,
    run_id: environment.GITHUB_RUN_ID,
    run_attempt: 1,
    job_id: String(selected[0].id),
    success: true,
    ...fields,
  };
  await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(result), {
    flag: 'wx',
    mode: 0o600,
  });
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await staticPublicationJournal({ phase: process.argv[2] });
