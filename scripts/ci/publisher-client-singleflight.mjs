import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBuildInfoSha, readPublisherArtifactSha } from './production-e2e-provenance.mjs';
import { mergePublisherReceipt, receiptName, PROOFS } from './publisher-verdict-receipt.mjs';
import { publisherJobKey } from './publisher-job-identity.mjs';
import { readImmutablePublisherClientShards } from './publisher-client-shards.mjs';
import { gitEnvironmentForCwd } from './classify-ci-changes.mjs';

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[1-9][0-9]*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CONTROL = [
  '.github/workflows/publish-club-arena.yml',
  '.github/workflows/publish-club-arena-client.yml',
  '.github/workflows/publish-club-arena-transaction.yml',
];
const fail = (message) => {
  throw Error(message);
};
const one = (values, predicate, label) => {
  const found = values.filter(predicate);
  if (found.length !== 1) fail(`Missing or ambiguous ${label}`);
  return found[0];
};
const step = (job, name) => {
  const found = one(job.steps || [], (s) => s.name === name, name);
  if (found.status !== 'completed' || found.conclusion !== 'success') fail(`Unsuccessful ${name}`);
  return found;
};

// Reserve admission-job time for checkout, the durable current-input receipt and output.
export function proofBudget(now = () => performance.now(), limitMs = 120_000) {
  const deadline = now() + limitMs;
  return (maximum = 30_000) => {
    const remaining = deadline - now();
    if (remaining <= 0) fail('Optional publication proof deadline exhausted');
    return Math.min(maximum, remaining);
  };
}

// This is a standdown after an ACTUAL successful publication, never an
// in-flight test cache or permission to borrow another run's production dist.
export async function publishedClientAtTarget({
  target,
  repositoryId,
  origins,
  run,
  artifacts,
  jobs,
  receipt,
  sameControls,
  ancestor,
  producerShards,
  budget = proofBudget(),
}) {
  try {
    const checked = async (operation) => {
      budget();
      const value = await operation();
      budget();
      return value;
    };
    if (!SHA.test(target) || !ID.test(String(repositoryId))) fail('Invalid target');
    const bodies = await checked(origins);
    if (!Array.isArray(bodies) || bodies.length !== 2 || bodies[0] !== bodies[1])
      fail('Origins disagree or are unreadable');
    if (readBuildInfoSha(bodies[0]) !== target) fail('Target is not already published');
    const info = JSON.parse(bodies[0]);
    if (info.built_by !== 'publish-club-arena.yml' || !ID.test(String(info.run_id)))
      fail('Missing original publisher');
    const source = await checked(() => run(String(info.run_id)));
    if (
      String(source.id) !== String(info.run_id) ||
      String(source.repository?.id) !== String(repositoryId) ||
      source.path !== '.github/workflows/publish-club-arena.yml' ||
      source.head_branch !== 'main' ||
      !['push', 'repository_dispatch'].includes(source.event) ||
      source.status !== 'completed' ||
      source.conclusion !== 'success' ||
      !SHA.test(source.head_sha) ||
      !ID.test(String(source.run_attempt))
    )
      fail('Original publisher is not complete successful protected-main authority');
    if (!(await checked(() => sameControls(source.head_sha, target))))
      fail('Publication controls differ');
    const metadata = await checked(() => artifacts(source.id));
    if (
      readPublisherArtifactSha(
        JSON.stringify(metadata),
        String(source.id),
        source.head_sha,
        String(repositoryId)
      ) !== target
    )
      fail('Foreign built target');
    const qualified = await checked(() => jobs(source.id));
    if (
      !Array.isArray(qualified.jobs) ||
      qualified.total_count !== qualified.jobs.length ||
      new Set(qualified.jobs.map((j) => j.id)).size !== qualified.jobs.length
    )
      fail('Incomplete original jobs');
    const owns = (job) =>
      job.status === 'completed' &&
      job.conclusion === 'success' &&
      String(job.run_id) === String(source.id) &&
      job.head_sha === source.head_sha &&
      String(job.run_attempt) === String(source.run_attempt);
    const plan = await checked(() => producerShards(source.head_sha));
    const prefix = plan.jobPrefix || '';
    const shards = qualified.jobs.filter((j) => /(?:^| \/ )client-tests(?: |$)/.test(j.name));
    if (shards.length !== plan.total || new Set(shards.map((j) => j.name)).size !== plan.total)
      fail('Missing, duplicate or mixed client shards');
    for (const index of plan.indices) {
      const shard = one(
        shards,
        (j) => j.name === `${prefix}client-tests (${index})`,
        'client shard'
      );
      if (!owns(shard)) fail('Unsuccessful or foreign client shard');
      step(shard, `Client tests must pass before the bundle ships (shard ${index}/${plan.total})`);
    }
    const build = one(qualified.jobs, (j) => j.name === `${prefix}build-and-store`, 'build');
    if (!owns(build)) fail('Unsuccessful or foreign build');
    for (const name of [
      'Build Club Arena',
      'Record the actual client module and build input closure',
      'Source maps never ship to players',
      'Stamp build provenance',
      'Seal the immutable release bytes',
      'Upload dist for the sync job',
      'Verify dist is complete',
    ])
      step(build, name);
    const bundle = one(
      metadata.artifacts,
      (a) => a.name === `club-arena-dist-${target}`,
      'sealed bundle'
    );
    if (!DIGEST.test(bundle.digest || '')) fail('Missing immutable bundle digest');
    const created = Date.parse(bundle.created_at);
    const start = Date.parse(build.started_at),
      end = Date.parse(build.completed_at);
    if (![created, start, end].every(Number.isFinite) || created < start || created > end)
      fail('Bundle was not created by the successful build');
    const admission = one(
      metadata.artifacts,
      (a) => a.name === `club-arena-client-inputs-attempt-${source.run_attempt}`,
      'input receipt'
    );
    if (
      admission.expired !== false ||
      !DIGEST.test(admission.digest || '') ||
      String(admission.workflow_run?.id) !== String(source.id) ||
      admission.workflow_run?.head_sha !== source.head_sha ||
      String(admission.workflow_run?.repository_id) !== String(repositoryId) ||
      String(admission.workflow_run?.head_repository_id) !== String(repositoryId) ||
      admission.workflow_run?.head_branch !== 'main'
    )
      fail('Foreign input receipt');
    const admit = one(qualified.jobs, (j) => j.name === `${prefix}admit`, 'original admission');
    if (!owns(admit)) fail('Unsuccessful original admission');
    step(admit, 'Recheck the original exact publication after target admission');
    step(admit, 'Preserve immutable selected qualification inputs');
    const admittedAt = Date.parse(admission.created_at);
    if (
      ![admittedAt, Date.parse(admit.started_at), Date.parse(admit.completed_at)].every(
        Number.isFinite
      ) ||
      admittedAt < Date.parse(admit.started_at) ||
      admittedAt > Date.parse(admit.completed_at)
    )
      fail('Input receipt was not created by the successful original admission');
    const inputs = await checked(() => receipt(admission.id, 'client-inputs.json'));
    if (
      !inputs ||
      Object.keys(inputs).sort().join() !==
        'repositoryId,runAttempt,runId,schema,selectionBase,targetSha,workflowSha' ||
      inputs.schema !== 1 ||
      inputs.targetSha !== target ||
      inputs.repositoryId !== String(repositoryId) ||
      inputs.runId !== String(source.id) ||
      inputs.runAttempt !== String(source.run_attempt) ||
      inputs.workflowSha !== source.head_sha ||
      typeof inputs.selectionBase !== 'string' ||
      (inputs.selectionBase !== '' && !SHA.test(inputs.selectionBase))
    )
      fail('Conflicting input receipt');
    if (inputs.selectionBase) await checked(() => ancestor(inputs.selectionBase, target));
    const origin = one(
      qualified.jobs,
      (j) => publisherJobKey(j.name) === 'publish-to-origin',
      'origin transaction'
    );
    if (!owns(origin)) fail('Unsuccessful or foreign origin transaction');
    const verdictArtifact = one(
      metadata.artifacts,
      (a) => a.name === receiptName('publish-to-origin', source.run_attempt),
      'original verdict'
    );
    if (!DIGEST.test(verdictArtifact.digest || '')) fail('Missing immutable verdict digest');
    const verdict = await checked(() => receipt(verdictArtifact.id, 'publisher-verdict.json'));
    if (
      verdict.verdict !== 'publish' ||
      verdict.selectedSha !== target ||
      verdict.runtimeSha !== target ||
      verdict.verifiedSha !== target
    )
      fail('Not an actual publication');
    const proven = mergePublisherReceipt(verdict, {
      run: source,
      job: origin,
      artifact: verdictArtifact,
      repositoryId: String(repositoryId),
      triggerSha: source.head_sha,
      workflowSha: source.head_sha,
    });
    for (const name of PROOFS['publish-to-origin']) step(proven, name);
    return {
      published: true,
      producerRunId: String(source.id),
      target,
      reason: 'Both URLs serve this exact fully qualified original publication',
    };
  } catch (error) {
    // Missing, failed, partial, in-flight or incompatible proof keeps the
    // existing complete qualification/build/publication path.
    return { published: false, reason: error.message };
  }
}

async function main() {
  const target = process.argv[2],
    selectionBase = process.argv[3] || '';
  const env = process.env,
    repo = env.GITHUB_REPOSITORY;
  if (
    repo !== 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena' ||
    env.GITHUB_REPOSITORY_ID !== '1132369872' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    env.GITHUB_WORKFLOW_REF !==
      `${repo}/.github/workflows/publish-club-arena.yml@refs/heads/main` ||
    !['push', 'repository_dispatch'].includes(env.GITHUB_EVENT_NAME) ||
    !SHA.test(target || '') ||
    (selectionBase !== '' && !SHA.test(selectionBase)) ||
    ![env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT].every((v) => ID.test(v || '')) ||
    !SHA.test(env.GITHUB_WORKFLOW_SHA || '') ||
    !env.GITHUB_OUTPUT
  )
    fail('Invalid protected publisher identity');
  const budget = proofBudget();
  const git = (...args) =>
    execFileSync('git', args, {
      encoding: 'utf8',
      timeout: budget(5000),
      env: gitEnvironmentForCwd(),
      maxBuffer: 600_000,
    }).trim();
  const api = (path) =>
    JSON.parse(
      execFileSync('gh', ['api', `repos/${repo}/${path}`], {
        encoding: 'utf8',
        timeout: budget(30000),
        maxBuffer: 8_000_000,
      })
    );
  const complete = (path, key) => {
    const payload = api(`${path}?per_page=100`);
    if (!Array.isArray(payload[key]) || payload.total_count !== payload[key].length)
      fail('Incomplete producer metadata');
    return payload;
  };
  const result = await publishedClientAtTarget({
    target,
    repositoryId: env.GITHUB_REPOSITORY_ID,
    budget,
    origins: async () =>
      [
        'https://ca-static.smarter.poker/build-info.json',
        'https://smarter.poker/hub/club-arena/build-info.json',
      ].map((url) =>
        execFileSync(
          'curl',
          [
            '--fail',
            '--silent',
            '--show-error',
            '--max-time',
            '15',
            `${url}?singleflight=${env.GITHUB_RUN_ID}`,
          ],
          { encoding: 'utf8', timeout: budget(17000), maxBuffer: 100_000 }
        )
      ),
    run: (id) => api(`actions/runs/${id}`),
    artifacts: (id) => complete(`actions/runs/${id}/artifacts`, 'artifacts'),
    jobs: (id) => complete(`actions/runs/${id}/jobs`, 'jobs'),
    receipt: (id, name) => {
      if (!ID.test(String(id)) || !['client-inputs.json', 'publisher-verdict.json'].includes(name))
        fail('Invalid receipt identity');
      const archive = execFileSync('gh', ['api', `repos/${repo}/actions/artifacts/${id}/zip`], {
        timeout: budget(30000),
        maxBuffer: 512_000,
      });
      return JSON.parse(
        execFileSync(
          'python3',
          [
            '-c',
            'import io,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); n=z.infolist(); assert len(n)==1 and n[0].filename==sys.argv[1] and n[0].file_size<=100000 and not n[0].is_dir(); sys.stdout.buffer.write(z.read(n[0]))',
            name,
          ],
          { input: archive, encoding: 'utf8', timeout: budget(5000), maxBuffer: 100_000 }
        )
      );
    },
    sameControls: (producer, selected) =>
      CONTROL.every(
        (path) =>
          git('rev-parse', `${producer}:${path}`) === git('rev-parse', `${selected}:${path}`)
      ),
    ancestor: (base, head) => git('merge-base', '--is-ancestor', base, head),
    producerShards: (sha) => readImmutablePublisherClientShards(process.cwd(), sha, budget(5000)),
  });
  writeFileSync(
    'client-inputs.json',
    `${JSON.stringify({
      schema: 1,
      targetSha: target,
      selectionBase,
      repositoryId: env.GITHUB_REPOSITORY_ID,
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      workflowSha: env.GITHUB_WORKFLOW_SHA,
    })}\n`,
    { flag: 'wx' }
  );
  appendFileSync(env.GITHUB_OUTPUT, `published=${result.published}\n`);
  console.log(JSON.stringify(result));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
