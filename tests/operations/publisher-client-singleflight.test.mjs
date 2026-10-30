import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  publishedClientAtTarget,
  proofBudget,
} from '../../scripts/ci/publisher-client-singleflight.mjs';
import { createReceipt, receiptName, PROOFS } from '../../scripts/ci/publisher-verdict-receipt.mjs';
import { readFileSync } from 'node:fs';

const target = 'a'.repeat(40),
  trigger = 'b'.repeat(40),
  base = 'c'.repeat(40);
const repository = 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena',
  repositoryId = '1132369872';
const prefix = 'client-publication / ';
const success = (name) => ({ name, status: 'completed', conclusion: 'success' });
function fixture(total = 16) {
  const run = {
    id: 20,
    run_attempt: 1,
    head_sha: trigger,
    head_branch: 'main',
    repository: { id: Number(repositoryId), full_name: repository },
    path: '.github/workflows/publish-club-arena.yml',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
  };
  let nextJobId = 1;
  const job = (name, steps) => ({
    id: nextJobId++,
    name,
    status: 'completed',
    conclusion: 'success',
    run_id: 20,
    run_attempt: 1,
    head_sha: trigger,
    started_at: '2026-10-30T00:00:00Z',
    completed_at: '2026-10-30T00:10:00Z',
    steps: steps.map(success),
  });
  const jobs = Array.from({ length: total }, (_, i) =>
    job(`${prefix}client-tests (${i + 1})`, [
      `Client tests must pass before the bundle ships (shard ${i + 1}/${total})`,
    ])
  );
  jobs.push(
    job(`${prefix}build-and-store`, [
      'Build Club Arena',
      'Record the actual client module and build input closure',
      'Source maps never ship to players',
      'Stamp build provenance',
      'Seal the immutable release bytes',
      'Upload dist for the sync job',
      'Verify dist is complete',
    ])
  );
  jobs.push(
    job(`${prefix}admit`, [
      'Recheck the original exact publication after target admission',
      'Preserve immutable selected qualification inputs',
    ])
  );
  jobs.push(job(`${prefix}production / publish-to-origin`, PROOFS['publish-to-origin']));
  const artifact = (id, name) => ({
    id,
    name,
    digest: `sha256:${'d'.repeat(64)}`,
    expired: false,
    created_at: '2026-10-30T00:05:00Z',
    workflow_run: {
      id: 20,
      repository_id: Number(repositoryId),
      head_repository_id: Number(repositoryId),
      head_sha: trigger,
      head_branch: 'main',
    },
  });
  const artifacts = [
    artifact(31, `club-arena-dist-${target}`),
    artifact(32, 'club-arena-client-inputs-attempt-1'),
    artifact(33, receiptName('publish-to-origin', 1)),
  ];
  const verdict = createReceipt({
    GITHUB_JOB: 'publish-to-origin',
    GITHUB_REPOSITORY: repository,
    GITHUB_REPOSITORY_ID: repositoryId,
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/publish-club-arena.yml@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: trigger,
    GITHUB_SHA: trigger,
    GITHUB_RUN_ID: '20',
    GITHUB_RUN_ATTEMPT: '1',
    RECEIPT_SELECTED_SHA: target,
    RECEIPT_RUNTIME_SHA: target,
    RECEIPT_VERIFIED_SHA: target,
    RECEIPT_VERDICT: 'publish',
    RECEIPT_CONCLUSIONS: '["success","success","success"]',
    RECEIPT_OUTCOMES: '["success","success","success"]',
  });
  const inputs = {
    schema: 1,
    targetSha: target,
    selectionBase: base,
    repositoryId,
    runId: '20',
    runAttempt: '1',
    workflowSha: trigger,
  };
  const info = JSON.stringify({ ca_sha: target, built_by: 'publish-club-arena.yml', run_id: '20' });
  const data = { run, jobs, artifacts, verdict, inputs, bodies: [info, info] };
  const options = {
    target,
    repositoryId,
    origins: async () => data.bodies,
    run: async () => data.run,
    artifacts: async () => ({ total_count: data.artifacts.length, artifacts: data.artifacts }),
    jobs: async () => ({ total_count: data.jobs.length, jobs: data.jobs }),
    receipt: async (id) => (id === 32 ? data.inputs : data.verdict),
    sameControls: async () => true,
    ancestor: async () => {},
    producerShards: async () => ({
      total,
      indices: Array.from({ length: total }, (_, i) => i + 1),
      jobPrefix: prefix,
    }),
  };
  return { data, options };
}
for (const total of [4, 16])
  test(`accepts only complete ${total}-shard original publication`, async () => {
    const { options } = fixture(total);
    assert.equal((await publishedClientAtTarget(options)).published, true);
  });
const mutations = {
  'in-flight publisher': (d) => {
    d.run.status = 'in_progress';
    d.run.conclusion = null;
  },
  'failed publisher': (d) => {
    d.run.conclusion = 'failure';
  },
  'foreign repository': (d) => {
    d.run.repository.id = 42;
  },
  'non-main producer': (d) => {
    d.run.head_branch = 'feature';
  },
  'different origin': (d) => {
    d.bodies[1] = '{}';
  },
  'missing shard': (d) => {
    d.jobs.splice(0, 1);
  },
  'duplicate shard': (d) => {
    d.jobs[1].name = d.jobs[0].name;
  },
  'duplicate job id': (d) => {
    d.jobs[1].id = d.jobs[0].id;
  },
  'mixed caller shard': (d) => {
    d.jobs[0].name = 'client-tests (1)';
  },
  'duplicate conflicting test step': (d) => {
    d.jobs[0].steps.push({ ...d.jobs[0].steps[0], conclusion: 'failure' });
  },
  'mixed run shard': (d) => {
    d.jobs[0].run_id = 21;
  },
  'mixed attempt shard': (d) => {
    d.jobs[0].run_attempt = 2;
  },
  'mixed head shard': (d) => {
    d.jobs[0].head_sha = target;
  },
  'skipped shard': (d) => {
    d.jobs[0].conclusion = 'skipped';
  },
  'missing actual test step': (d) => {
    d.jobs[0].steps = [];
  },
  'failed actual test step': (d) => {
    d.jobs[0].steps[0].conclusion = 'failure';
  },
  'missing seal': (d) => {
    d.jobs.find((j) => j.name.endsWith('build-and-store')).steps = [];
  },
  'missing bundle digest': (d) => {
    delete d.artifacts[0].digest;
  },
  'expired bundle': (d) => {
    d.artifacts[0].expired = true;
  },
  'bundle outside build': (d) => {
    d.artifacts[0].created_at = '2026-10-29T00:00:00Z';
  },
  'foreign admission': (d) => {
    d.inputs.runId = '21';
  },
  'different selected target': (d) => {
    d.inputs.targetSha = base;
  },
  'malformed baseline': (d) => {
    d.inputs.selectionBase = 'main';
  },
  'unexpected admission field': (d) => {
    d.inputs.proved = true;
  },
  'foreign admission artifact': (d) => {
    d.artifacts[1].workflow_run.id = 21;
  },
  'expired admission artifact': (d) => {
    d.artifacts[1].expired = true;
  },
  'missing successful admission': (d) => {
    d.jobs.find((j) => j.name.endsWith(' / admit')).conclusion = 'failure';
  },
  'missing origin receipt': (d) => {
    d.artifacts.splice(2, 1);
  },
  'foreign original receipt': (d) => {
    d.verdict.runId = '21';
  },
  'different verified target': (d) => {
    d.verdict.verifiedSha = base;
  },
  'skipped original publication': (d) => {
    d.jobs.at(-1).steps[1].conclusion = 'skipped';
  },
};
for (const [name, mutate] of Object.entries(mutations))
  test(`keeps full qualification for ${name}`, async () => {
    const { data, options } = fixture();
    mutate(data);
    assert.equal((await publishedClientAtTarget(options)).published, false);
  });
for (const key of [
  'origins',
  'run',
  'artifacts',
  'jobs',
  'receipt',
  'sameControls',
  'ancestor',
  'producerShards',
])
  test(`unreadable ${key} cannot stand down`, async () => {
    const { options } = fixture();
    options[key] = async () => {
      throw Error('unreadable');
    };
    assert.equal((await publishedClientAtTarget(options)).published, false);
  });
test('changed immutable controls cannot reuse an original publication', async () => {
  const { options } = fixture();
  options.sameControls = async () => false;
  assert.equal((await publishedClientAtTarget(options)).published, false);
});
test('the caller singleflights one exact target before all existing work', () => {
  const entry = readFileSync('.github/workflows/publish-club-arena.yml', 'utf8');
  const helper = readFileSync('.github/workflows/publish-club-arena-client.yml', 'utf8');
  assert.match(
    entry,
    /group: publish-club-arena-client-\$\{\{ github.repository_id \}\}-\$\{\{ needs.publish-needed.outputs.target_sha \}\}/
  );
  assert.match(entry, /uses: \.\/\.github\/workflows\/publish-club-arena-client.yml/);
  assert.match(helper, /workflow_call:/);
  assert.doesNotMatch(helper, /^  (push|schedule|workflow_dispatch|repository_dispatch):/m);
  assert.match(helper, /needs: \[admit, client-tests, build-and-store, publication-floor\]/);
  assert.match(helper, /needs.publication-floor.result == 'success'/);
  assert.match(helper, /group: publish-club-arena-production\n      cancel-in-progress: false/);
  assert.match(helper, /needs.admit.outputs.published != 'true'/);
});

test('exhausted optional proof budget conservatively keeps complete qualification', async () => {
  let clock = 0;
  const budget = proofBudget(() => clock, 120_000);
  const { options } = fixture();
  const original = options.origins;
  options.origins = async () => {
    const result = await original();
    clock = 120_000;
    return result;
  };
  options.run = async () => {
    throw Error('must not read after exhaustion');
  };
  const result = await publishedClientAtTarget({ ...options, budget });
  assert.equal(result.published, false);
  assert.match(result.reason, /deadline exhausted/);
  assert.throws(() => budget(), /deadline exhausted/);
});
