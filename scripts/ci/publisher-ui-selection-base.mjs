import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBuildInfoSha, readPublisherArtifactSha } from './production-e2e-provenance.mjs';

import {
  readRetentionReceipt,
  receiptArtifactId,
  assertReceiptOrigins,
  compareClientBacklog,
} from './client-runtime-retention.mjs';
import { qualifiesRuntimeInputs } from './client-runtime-inputs.mjs';
import { mergePublisherReceipt, receiptName, PROOFS } from './publisher-verdict-receipt.mjs';
import { publisherJobKey } from './publisher-job-identity.mjs';
import { readImmutablePublisherClientShards } from './publisher-client-shards.mjs';

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[1-9][0-9]*$/;

// A parent is not necessarily published: the entire unpublished backlog must
// qualify, including any intervening financial change. Uncertainty runs all tests.
export async function publishedSelectionBase({
  target,
  repositoryId,
  origins,
  run,
  artifacts,
  jobs,
  ancestor,
  successfulRuns,
  receipt,
  manifests,
  cwd = process.cwd(),
  producerShards = (sha) => readImmutablePublisherClientShards(cwd, sha),
}) {
  if (!SHA.test(target) || !ID.test(String(repositoryId))) throw Error('Invalid target identity');
  const bodies = await origins();
  if (!Array.isArray(bodies) || bodies.length !== 2 || bodies[0] !== bodies[1])
    throw Error('Published origins disagree');
  const base = readBuildInfoSha(bodies[0]);
  const info = JSON.parse(bodies[0]);
  if (info.built_by !== 'publish-club-arena.yml' || !ID.test(String(info.run_id)))
    throw Error('Missing original publisher identity');
  await ancestor(base, target);
  const source = await run(String(info.run_id));
  if (
    String(source.id) !== String(info.run_id) ||
    String(source.repository?.id) !== String(repositoryId) ||
    source.path !== '.github/workflows/publish-club-arena.yml' ||
    source.head_branch !== 'main' ||
    !['push', 'repository_dispatch'].includes(source.event) ||
    source.status !== 'completed' ||
    source.conclusion !== 'success' ||
    !SHA.test(source.head_sha)
  )
    throw Error('Original publisher is not successful protected-main authority');
  const originalArtifacts = await artifacts(source.id);
  if (
    readPublisherArtifactSha(
      JSON.stringify(originalArtifacts),
      String(source.id),
      source.head_sha,
      String(repositoryId)
    ) !== base
  )
    throw Error('Original publisher selected another runtime');
  const evidence = await jobs(source.id);
  if (!Array.isArray(evidence.jobs) || evidence.total_count !== evidence.jobs.length)
    throw Error('Incomplete original publisher jobs');
  const origin = evidence.jobs.filter((job) => publisherJobKey(job.name) === 'publish-to-origin');
  if (
    origin.length !== 1 ||
    origin[0].status !== 'completed' ||
    origin[0].conclusion !== 'success' ||
    origin[0].steps?.filter(
      (step) =>
        step.name === 'Verify the origin serves this bundle' &&
        step.status === 'completed' &&
        step.conclusion === 'success'
    ).length !== 1
  )
    throw Error('Original publisher never verified this runtime');
  // Retained bytes can have newer, fully qualified source. Never infer that
  // qualification from a skipped shard or a filename/component exemption.
  if (!successfulRuns || !receipt || !manifests) return base;
  let candidates;
  try {
    candidates = await successfulRuns();
    if (!Array.isArray(candidates) || candidates.length > 10) return base;
  } catch {
    return base;
  }
  const originalArtifact = originalArtifacts.artifacts.find(
    (entry) => entry.name === `club-arena-dist-${base}`
  );
  for (const candidate of candidates) {
    try {
      if (!ID.test(String(candidate?.id))) continue;
      const retainedRun = await run(String(candidate.id));
      if (
        String(retainedRun.id) !== String(candidate.id) ||
        String(retainedRun.repository?.id) !== String(repositoryId) ||
        retainedRun.repository?.full_name !== source.repository?.full_name ||
        retainedRun.path !== '.github/workflows/publish-club-arena.yml' ||
        retainedRun.head_branch !== 'main' ||
        retainedRun.event !== 'push' ||
        retainedRun.status !== 'completed' ||
        retainedRun.conclusion !== 'success' ||
        !SHA.test(retainedRun.head_sha) ||
        !ID.test(String(retainedRun.run_attempt))
      )
        continue;
      const metadata = await artifacts(retainedRun.id);
      const artifactId = receiptArtifactId(
        metadata,
        String(retainedRun.id),
        retainedRun.head_sha,
        String(repositoryId)
      );
      const retained = readRetentionReceipt(
        await receipt(artifactId, 'retained-runtime.json'),
        String(retainedRun.id),
        retainedRun.head_sha,
        String(repositoryId)
      );
      if (
        retained.runtimeSha !== base ||
        retained.originalPublisherRunId !== String(source.id) ||
        retained.originalArtifactId !== originalArtifact.id ||
        retained.verificationSha === target ||
        retained.verificationSha === base
      )
        continue;
      await ancestor(base, retained.verificationSha);
      await ancestor(retained.verificationSha, target);
      assertReceiptOrigins(retained, bodies, await manifests());
      const comparison = compareClientBacklog(base, retained.verificationSha, cwd);
      if (
        JSON.stringify(comparison.paths) !== JSON.stringify(retained.paths) ||
        !qualifiesRuntimeInputs(
          retained.inputs,
          base,
          retained.verificationSha,
          comparison.paths,
          cwd
        )
      )
        continue;
      const qualified = await jobs(retainedRun.id);
      if (!Array.isArray(qualified.jobs) || qualified.total_count !== qualified.jobs.length)
        continue;
      const ownsJob = (job) =>
        job.status === 'completed' &&
        job.conclusion === 'success' &&
        String(job.run_id) === String(retainedRun.id) &&
        job.head_sha === retainedRun.head_sha &&
        String(job.run_attempt) === String(retainedRun.run_attempt);
      // Exact producer source owns the complete matrix. A historical four-shard
      // producer stays valid, but four successful jobs cannot prove a sixteen-
      // shard producer. Missing source is uncertainty, never permission to reuse.
      const plan = await producerShards(retainedRun.head_sha);
      const shards = qualified.jobs.filter((job) => /^client-tests(?: |$)/.test(job.name));
      if (
        shards.length !== plan.total ||
        new Set(shards.map((job) => job.name)).size !== plan.total ||
        !plan.indices.every((index) => {
          const matches = shards.filter((job) => job.name === `client-tests (${index})`);
          if (matches.length !== 1) return false;
          const job = matches[0];
          return (
            ownsJob(job) &&
            job.steps?.filter(
              (step) =>
                step.name ===
                  `Client tests must pass before the bundle ships (shard ${index}/${plan.total})` &&
                step.status === 'completed' &&
                step.conclusion === 'success'
            ).length === 1
          );
        })
      )
        continue;
      const retention = qualified.jobs.filter(
        (job) => publisherJobKey(job.name) === 'retain-runtime'
      );
      if (retention.length !== 1 || !ownsJob(retention[0])) continue;
      const verdictArtifacts = metadata.artifacts.filter(
        (entry) => entry.name === receiptName('retain-runtime', retainedRun.run_attempt)
      );
      if (verdictArtifacts.length !== 1) continue;
      const verdict = JSON.parse(await receipt(verdictArtifacts[0].id, 'publisher-verdict.json'));
      if (
        verdict.runAttempt !== String(retainedRun.run_attempt) ||
        verdict.selectedSha !== retained.verificationSha ||
        verdict.runtimeSha !== base ||
        verdict.jobKey !== 'retain-runtime'
      )
        continue;
      const proven = mergePublisherReceipt(verdict, {
        run: retainedRun,
        job: { ...retention[0], name: 'retain-runtime' },
        artifact: verdictArtifacts[0],
        repositoryId: String(repositoryId),
        triggerSha: retainedRun.head_sha,
        workflowSha: retainedRun.head_sha,
      });
      const required = [
        ...PROOFS['retain-runtime'],
        'Preserve original retained runtime verdict evidence',
        'Upload immutable original retained verdict',
      ];
      if (
        !required.every(
          (name) =>
            proven.steps.filter(
              (step) =>
                step.name === name && step.status === 'completed' && step.conclusion === 'success'
            ).length === 1
        )
      )
        continue;
      // The unversioned retention artifact must belong to this successful attempt.
      const retainedArtifact = metadata.artifacts.find((entry) => entry.id === artifactId);
      const start = Date.parse(retention[0].started_at),
        end = Date.parse(retention[0].completed_at);
      const created = Date.parse(retainedArtifact.created_at);
      if (![start, end, created].every(Number.isFinite) || created < start || created > end)
        continue;
      return retained.verificationSha;
    } catch {
      // Unreadable, malformed, stale or unqualified evidence cannot advance base.
    }
  }
  return base;
}

async function main() {
  let base = '';
  try {
    const target = process.argv[2];
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 30000 });
    if (!SHA.test(target || '') || git('rev-parse', 'HEAD').trim() !== target)
      throw Error('Selection checkout differs from the protected target');
    const repo = process.env.GITHUB_REPOSITORY;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')) throw Error('Invalid repository');
    // Optional reuse evidence must never add an unbounded admission wait.
    let retainedDeadline;
    const budget = () => {
      const remaining = retainedDeadline === undefined ? 30000 : retainedDeadline - Date.now();
      if (remaining <= 0) throw Error('Retained qualification lookup exhausted its budget');
      return Math.min(30000, remaining);
    };
    const api = (path) =>
      JSON.parse(
        execFileSync('gh', ['api', `repos/${repo}/${path}`], {
          encoding: 'utf8',
          timeout: budget(),
          maxBuffer: 16 * 1024 * 1024,
        })
      );
    base = await publishedSelectionBase({
      target,
      repositoryId: process.env.GITHUB_REPOSITORY_ID,
      origins: () =>
        Promise.all(
          ['https://ca-static.smarter.poker', 'https://smarter.poker/hub/club-arena'].map(
            async (url) => {
              const response = await fetch(
                `${url}/build-info.json?selection=${process.env.GITHUB_RUN_ID}`,
                {
                  headers: { 'Cache-Control': 'no-cache' },
                  signal: AbortSignal.timeout(15000),
                }
              );
              if (!response.ok) throw Error(`Published provenance HTTP ${response.status}`);
              return response.text();
            }
          )
        ),
      run: (id) => api(`actions/runs/${id}`),
      artifacts: (id) => api(`actions/runs/${id}/artifacts?per_page=100`),
      jobs: (id) => api(`actions/runs/${id}/jobs?filter=latest&per_page=100`),
      successfulRuns: () => {
        retainedDeadline = Date.now() + 20000;
        const payload = api(
          'actions/workflows/publish-club-arena.yml/runs?branch=main&status=success&per_page=10'
        );
        if (!Array.isArray(payload.workflow_runs) || !Number.isSafeInteger(payload.total_count))
          throw Error('Unreadable retained publisher lookup');
        return payload.workflow_runs.slice(0, 10);
      },
      manifests: () =>
        Promise.all(
          ['https://ca-static.smarter.poker', 'https://smarter.poker/hub/club-arena'].map(
            async (url) => {
              const response = await fetch(
                `${url}/.release-manifest.sha256?selection=${process.env.GITHUB_RUN_ID}`,
                {
                  headers: { 'Cache-Control': 'no-cache' },
                  signal: AbortSignal.timeout(Math.min(15000, budget())),
                  redirect: 'error',
                }
              );
              if (!response.ok) throw Error(`Published manifest HTTP ${response.status}`);
              return response.text();
            }
          )
        ),
      receipt: (id, filename) => {
        if (
          !ID.test(String(id)) ||
          !['retained-runtime.json', 'publisher-verdict.json'].includes(filename)
        )
          throw Error('Invalid receipt artifact request');
        const archive = execFileSync('gh', ['api', `repos/${repo}/actions/artifacts/${id}/zip`], {
          timeout: budget(),
          maxBuffer: 4 * 1024 * 1024,
        });
        return execFileSync(
          'python3',
          [
            '-c',
            'import io,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); n=z.infolist(); assert len(n)==1 and n[0].filename==sys.argv[1] and n[0].file_size<=2097152 and not n[0].is_dir(); sys.stdout.buffer.write(z.read(n[0]))',
            filename,
          ],
          {
            input: archive,
            encoding: 'utf8',
            timeout: Math.min(10000, budget()),
            maxBuffer: 2 * 1024 * 1024,
          }
        );
      },
      producerShards: (sha) => readImmutablePublisherClientShards(process.cwd(), sha, budget()),
      ancestor: (from, to) => git('merge-base', '--is-ancestor', from, to),
    });
    console.log(`UI selection covers the complete unqualified backlog ${base}..${target}`);
  } catch (error) {
    console.log(`UI selection requires the full suite: ${error.message}`);
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `base_sha=${base}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
