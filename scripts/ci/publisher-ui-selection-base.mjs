import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBuildInfoSha, readPublisherArtifactSha } from './production-e2e-provenance.mjs';

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
  if (
    readPublisherArtifactSha(
      JSON.stringify(await artifacts(source.id)),
      String(source.id),
      source.head_sha,
      String(repositoryId)
    ) !== base
  )
    throw Error('Original publisher selected another runtime');
  const evidence = await jobs(source.id);
  if (!Array.isArray(evidence.jobs) || evidence.total_count !== evidence.jobs.length)
    throw Error('Incomplete original publisher jobs');
  const origin = evidence.jobs.filter((job) => job.name === 'publish-to-origin');
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
    const api = (path) =>
      JSON.parse(
        execFileSync('gh', ['api', `repos/${repo}/${path}`], {
          encoding: 'utf8',
          timeout: 30000,
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
      ancestor: (from, to) => git('merge-base', '--is-ancestor', from, to),
    });
    console.log(`UI selection covers the complete published backlog ${base}..${target}`);
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
