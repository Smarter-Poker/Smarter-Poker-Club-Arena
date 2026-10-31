import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { publishedSelectionBase } from '../../scripts/ci/publisher-ui-selection-base.mjs';
import {
  publisherClientShardPlan,
  readImmutablePublisherClientShards,
} from '../../scripts/ci/publisher-client-shards.mjs';
import { selectionInputs } from '../../scripts/ci/ui-test-selection.mjs';
import {
  classifyChangedPaths,
  gitEnvironmentForCwd,
} from '../../scripts/ci/classify-ci-changes.mjs';

const base = '1'.repeat(40),
  target = '2'.repeat(40);
function inputs(baseline = base, selected = target) {
  const body = JSON.stringify({
    ca_sha: baseline,
    run_id: '7',
    built_by: 'publish-club-arena.yml',
  });
  const source = {
    id: 7,
    repository: { id: 9 },
    path: '.github/workflows/publish-club-arena.yml',
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_sha: baseline,
  };
  const artifact = {
    id: 8,
    name: `club-arena-dist-${baseline}`,
    expired: false,
    workflow_run: {
      id: 7,
      head_sha: baseline,
      head_branch: 'main',
      repository_id: 9,
      head_repository_id: 9,
    },
  };
  const job = {
    name: 'publish-to-origin',
    status: 'completed',
    conclusion: 'success',
    steps: [
      { name: 'Verify the origin serves this bundle', status: 'completed', conclusion: 'success' },
    ],
  };
  return {
    target: selected,
    repositoryId: '9',
    origins: async () => [body, body],
    run: async () => source,
    artifacts: async () => ({ total_count: 1, artifacts: [artifact] }),
    jobs: async () => ({ total_count: 1, jobs: [job] }),
    ancestor: async () => {},
    source,
    artifact,
    job,
  };
}

const producerWorkflow = (count = 4) => `name: Publish Club Arena
jobs:
  client-tests:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: true
      matrix:
        shard: [${Array.from({ length: count }, (_, i) => i + 1).join(', ')}]
    steps:
      - name: Client tests must pass before the bundle ships (shard \${{ matrix.shard }}/${count})
        run: node scripts/ci/ui-test-selection.mjs unit --shard=\${{ matrix.shard }}/${count}
  build-and-store:
    runs-on: ubuntu-latest
`;

// A real retained source qualifies financial/server changes without rebuilding
// client bytes. Every authority and executed shard remains independently bound.
function retainedInputs(published, verified, selected, root, git, shardCount = 4) {
  const i = inputs(published, selected);
  const repositoryId = '1132369872';
  const repository = 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena';
  i.repositoryId = repositoryId;
  i.cwd = root;
  i.source.repository = { id: Number(repositoryId), full_name: repository };
  i.artifact.workflow_run.repository_id = Number(repositoryId);
  i.artifact.workflow_run.head_repository_id = Number(repositoryId);
  const run = { ...i.source, id: 10, head_sha: verified, run_attempt: 2 };
  const ownership = {
    id: 10,
    run_id: 10,
    run_attempt: 2,
    head_sha: verified,
    status: 'completed',
    conclusion: 'success',
  };
  const step = (name) => ({ name, status: 'completed', conclusion: 'success' });
  const retention = {
    ...ownership,
    name: 'production / retain-runtime',
    started_at: '2026-10-29T10:00:00Z',
    completed_at: '2026-10-29T10:01:00Z',
    steps: [
      'Verify both origins still serve the qualified immutable runtime',
      'Record qualified retained runtime',
      'Preserve original retained runtime verdict evidence',
      'Upload immutable original retained verdict',
    ].map(step),
  };
  const shards = Array.from({ length: shardCount }, (_, n) => n + 1).map((n) => ({
    ...ownership,
    id: 20 + n,
    name: `client-tests (${n})`,
    steps: [step(`Client tests must pass before the bundle ships (shard ${n}/${shardCount})`)],
  }));
  const artifact = (id, name) => ({
    id,
    name,
    expired: false,
    created_at: '2026-10-29T10:00:30Z',
    workflow_run: {
      id: 10,
      head_sha: verified,
      head_branch: 'main',
      repository_id: Number(repositoryId),
      head_repository_id: Number(repositoryId),
    },
  });
  const metadata = {
    total_count: 2,
    artifacts: [
      artifact(11, 'club-arena-retained-runtime'),
      artifact(12, 'club-arena-publisher-verdict-retain-runtime-attempt-2'),
    ],
  };
  const body = JSON.stringify({
    ca_sha: published,
    run_id: '7',
    built_by: 'publish-club-arena.yml',
  });
  const hash = (v) => createHash('sha256').update(v).digest('hex');
  const manifest = 'immutable original manifest';
  const css = 'src/components/example/Control.module.css';
  const retained = {
    schema: 1,
    kind: 'retained-client-runtime',
    runtimeSha: published,
    verificationSha: verified,
    sourceRunId: '10',
    sourceTriggerSha: verified,
    repositoryId,
    originalPublisherRunId: '7',
    originalArtifactId: 8,
    buildInfoSHA256: hash(body),
    manifestSHA256: hash(manifest),
    paths: ['server/payment.ts'],
    inputs: {
      schema: 1,
      sourceSha: published,
      complete: true,
      files: [css, '.github/workflows/publish-club-arena.yml'].map((path) => ({
        path,
        mode: '100644',
        oid: git('rev-parse', `${published}:${path}`),
      })),
      directories: [],
      unknown: [],
    },
  };
  const verdict = {
    schema: 2,
    repository,
    repositoryId,
    workflowRef: `${repository}/.github/workflows/publish-club-arena.yml@refs/heads/main`,
    workflowSha: verified,
    runId: '10',
    runAttempt: '2',
    jobKey: 'retain-runtime',
    triggerSha: verified,
    selectedSha: verified,
    runtimeSha: published,
    verdict: 'retained',
    verifiedSha: '',
    steps: retention.steps.slice(0, 2).map((s) => ({ ...s, outcome: 'success' })),
  };
  i.run = async (id) => (String(id) === '7' ? i.source : run);
  i.artifacts = async (id) =>
    String(id) === '7' ? { total_count: 1, artifacts: [i.artifact] } : metadata;
  i.jobs = async (id) =>
    String(id) === '7'
      ? { total_count: 1, jobs: [i.job] }
      : { total_count: shards.length + 1, jobs: [...shards, retention] };
  i.origins = async () => [body, body];
  i.manifests = async () => [manifest, manifest];
  i.successfulRuns = async () => [{ id: 10 }];
  i.receipt = async (id, filename) => {
    assert.equal(filename, id === 11 ? 'retained-runtime.json' : 'publisher-verdict.json');
    return JSON.stringify(id === 11 ? retained : verdict);
  };
  i.ancestor = async (a, b) => {
    git('merge-base', '--is-ancestor', a, b);
  };
  return Object.assign(i, { retained, verdict, retention, shards, retainedRun: run, metadata });
}

test('only the original successful protected publisher and both matching origins supply a base', async () => {
  assert.equal(await publishedSelectionBase(inputs()), base);
  assert.equal(classifyChangedPaths(['scripts/ci/publisher-ui-selection-base.mjs']).server, true);
});

test('unreadable, divergent or malformed origin metadata never supplies a focused base', async () => {
  for (const origins of [
    async () => {
      throw Error('HTTP 503');
    },
    async () => ['{}', '{}'],
    async () => ['a', 'b'],
    async () => [],
  ])
    await assert.rejects(publishedSelectionBase({ ...inputs(), origins }));
});

test('failed, cancelled, untrusted or unrelated original runs refuse', async () => {
  for (const change of [
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { repository: { id: 10 } },
    { head_branch: 'feature' },
    { event: 'pull_request' },
    { path: 'other.yml' },
    { id: 8 },
    { head_sha: 'short' },
  ]) {
    const i = inputs();
    Object.assign(i.source, change);
    await assert.rejects(publishedSelectionBase(i));
  }
});

test('wrong, expired or incomplete immutable artifact evidence refuses', async () => {
  for (const change of [
    { name: `club-arena-dist-${target}` },
    { expired: true },
    { workflow_run: { id: 7 } },
  ]) {
    const i = inputs();
    Object.assign(i.artifact, change);
    await assert.rejects(publishedSelectionBase(i));
  }
  await assert.rejects(
    publishedSelectionBase({
      ...inputs(),
      artifacts: async () => ({ total_count: 2, artifacts: [] }),
    })
  );
});

test('a missing, failed or unverified origin job and unknown ancestry refuse', async () => {
  for (const change of [
    { conclusion: 'failure' },
    { status: 'in_progress' },
    { steps: [] },
    { name: 'validation' },
  ]) {
    const i = inputs();
    Object.assign(i.job, change);
    await assert.rejects(publishedSelectionBase(i));
  }
  await assert.rejects(
    publishedSelectionBase({ ...inputs(), jobs: async () => ({ total_count: 2, jobs: [] }) })
  );
  await assert.rejects(
    publishedSelectionBase({
      ...inputs(),
      ancestor: async () => {
        throw Error('not ancestor');
      },
    })
  );
});

async function retainedProducerBacklog(shardCount) {
  const root = mkdtempSync(join(tmpdir(), 'published-ui-backlog-'));
  const git = (...a) =>
    execFileSync('git', a, { cwd: root, env: gitEnvironmentForCwd(), encoding: 'utf8' }).trim();
  const write = (p, value) => {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), value);
  };
  const commit = (message) => {
    git('add', '.');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q');
    git('config', 'user.name', 'Selection fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    const css = 'src/components/example/Control.module.css';
    write(css, '.button { color: red }');
    write('server/payment.ts', 'export const amount=1;');
    write('.github/workflows/publish-club-arena.yml', producerWorkflow(shardCount));
    const published = commit('published baseline');
    write('server/payment.ts', 'export const amount=2;');
    const financial = commit('unpublished financial change');
    write(css, '.button { color: blue }');
    const current = commit('safe UI');
    assert.equal(
      selectionInputs(root, financial, current).focused,
      true,
      'a parent-only comparison misses the backlog'
    );
    const i = inputs(published, current);
    i.ancestor = async (a, b) => {
      git('merge-base', '--is-ancestor', a, b);
    };
    const verifiedBase = await publishedSelectionBase(i);
    assert.equal(verifiedBase, published);
    assert.equal(
      selectionInputs(root, verifiedBase, current).focused,
      false,
      'financial backlog must run the full suite'
    );
    const qualified = retainedInputs(published, financial, current, root, git, shardCount);
    const inheritedGitDir = process.env.GIT_DIR;
    // A push hook exports its outer repository; explicit fixture cwd must win.
    process.env.GIT_DIR = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      env: gitEnvironmentForCwd(),
      encoding: 'utf8',
    }).trim();
    try {
      assert.equal(await publishedSelectionBase(qualified), financial);
    } finally {
      if (inheritedGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = inheritedGitDir;
    }
    assert.equal(
      selectionInputs(root, financial, current).focused,
      true,
      'already executed financial-source qualification permits only the remaining UI diff'
    );
    const reject = async (mutate) => {
      const candidate = retainedInputs(published, financial, current, root, git, shardCount);
      mutate(candidate);
      assert.equal(
        await publishedSelectionBase(candidate),
        published,
        'rejected or unknown retained evidence cannot conceal financial backlog'
      );
    };
    for (const mutate of [
      (i) => {
        i.shards.push({ ...i.shards[0], id: 999, name: 'client-tests (99)' });
      },
      (i) => {
        i.shards.pop();
      },
      (i) => {
        i.shards.splice(0, i.shards.length, ...i.shards.slice(0, 4));
        // A four-job subset must refuse only for the new sixteen-job producer.
        if (shardCount === 4) i.shards.pop();
      },
      (i) => {
        i.shards[0].head_sha = published;
      },
      (i) => {
        i.shards[0].status = 'in_progress';
      },
      (i) => {
        i.shards[0].steps[0].name = 'Client tests must pass before the bundle ships (shard 1/99)';
      },
      (i) => {
        i.producerShards = () => {
          throw Error('immutable source unreadable');
        };
      },
      (i) => {
        i.shards[0].conclusion = 'skipped';
      },
      (i) => {
        i.shards[0].steps[0].conclusion = 'skipped';
      },
      (i) => {
        i.shards[0].name = 'client-tests (2)';
      },
      (i) => {
        i.shards[0].run_attempt = 1;
      },
      (i) => {
        i.shards[0].run_id = 99;
      },
      (i) => {
        i.retainedRun.conclusion = 'failure';
      },
      (i) => {
        i.retainedRun.event = 'repository_dispatch';
      },
      (i) => {
        i.retainedRun.path = '.github/workflows/ci.yml';
      },
      (i) => {
        i.retainedRun.repository = { id: 7, full_name: 'foreign/repo' };
      },
      (i) => {
        i.retained.verificationSha = current;
      },
      (i) => {
        i.retained.originalArtifactId = 99;
      },
      (i) => {
        i.retained.originalPublisherRunId = '99';
      },
      (i) => {
        i.retained.inputs.complete = false;
      },
      (i) => {
        i.retained.paths = [];
      },
      (i) => {
        i.retained.inputs.files = [];
      },
      (i) => {
        i.retained.buildInfoSHA256 = '0'.repeat(64);
      },
      (i) => {
        i.manifests = async () => ['wrong', 'wrong'];
      },
      (i) => {
        i.retention.steps[0].conclusion = 'failure';
      },
      (i) => {
        i.retention.steps.pop();
      },
      (i) => {
        i.retention.name = 'arbitrary / retain-runtime';
      },
      (i) => {
        i.verdict.runAttempt = '1';
      },
      (i) => {
        i.verdict.workflowSha = published;
      },
      (i) => {
        i.metadata.artifacts[0].created_at = '2026-10-29T09:00:00Z';
      },
      (i) => {
        i.metadata.artifacts[1].expired = true;
      },
      (i) => {
        const previous = i.jobs;
        i.jobs = async (id) => (String(id) === '7' ? previous(id) : { total_count: 5, jobs: [] });
      },
      (i) => {
        i.successfulRuns = async () => {
          throw Error('HTTP 503');
        };
      },
      (i) => {
        i.successfulRuns = async () => null;
      },
      (i) => {
        i.successfulRuns = async () => Array(11).fill({ id: 10 });
      },
      (i) => {
        i.receipt = async () => '{malformed';
      },
      (i) => {
        i.receipt = async () => {
          throw Error('unreadable');
        };
      },
    ])
      await reject(mutate);
    write('server/payment.ts', 'export const amount=3;');
    const laterFinancial = commit('another unqualified financial change');
    const stillQualified = await publishedSelectionBase(
      retainedInputs(published, financial, laterFinancial, root, git, shardCount)
    );
    assert.equal(stillQualified, financial);
    assert.equal(
      selectionInputs(root, stillQualified, laterFinancial).focused,
      false,
      'new financial work after a valid retained receipt still requires the full suite'
    );
    git('checkout', '-qb', 'ui-only', published);
    write(css, '.button { color: green }');
    const ui = commit('scoped style only');
    assert.equal(
      selectionInputs(root, await publishedSelectionBase(inputs(published, ui)), ui).focused,
      true
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const count of [4, 16])
  test(`a ${count}-shard immutable producer proves the financial backlog before scoped UI`, () =>
    retainedProducerBacklog(count));

test('immutable producer layout refuses unsupported, ambiguous or dynamic shapes', () => {
  assert.throws(() => publisherClientShardPlan(producerWorkflow(8)));
  for (const count of [4, 16]) {
    const source = producerWorkflow(count);
    assert.deepEqual(publisherClientShardPlan(source), {
      indices: Array.from({ length: count }, (_, i) => i + 1),
      total: count,
    });
    if (count === 4)
      assert.equal(
        publisherClientShardPlan(
          source.replace('node scripts/ci/ui-test-selection.mjs unit', 'npx vitest run tests/')
        ).total,
        4
      );
    for (const bad of [
      source.replace('shard: [1, 2', 'shard: [2, 2'),
      source.replace(
        '      matrix:',
        '      matrix: ${{ fromJSON(inputs.matrix) }}\n      unsupported:'
      ),
      source.replace('    strategy:', '    name: renamed\n    strategy:'),
      source.replace('        run:', '        continue-on-error: true\n        run:'),
      source.replace('        run:', '        if: false\n        run:'),
      source.replace('        run:', '        shell: bash\n        run:'),
      source.replace('      matrix:', '      max-parallel: 1\n      matrix:'),
      source.replace('    steps:', '        extra: [1, 2]\n    steps:'),
      source.replace('/' + count + '\n', '/99\n'),
      source.replace('unit --shard=', 'unit --passWithNoTests --shard='),
      source.replace('  client-tests:', '  client-tests: &hidden'),
      source + '\n  client-tests:\n',
      source.replace('jobs:', 'jobs: &hidden'),
      '',
    ])
      assert.throws(() => publisherClientShardPlan(bad));
  }
});

test('actual Git revision owns the producer layout, not dirty worktree content or inherited Git state', () => {
  const root = mkdtempSync(join(tmpdir(), 'publisher-shard-source-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, env: gitEnvironmentForCwd(), encoding: 'utf8' }).trim();
  const path = join(root, '.github/workflows/publish-club-arena.yml');
  try {
    git('init', '-q');
    git('config', 'user.name', 'Shard fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(path, producerWorkflow(4));
    git('add', '.');
    git('commit', '-qm', 'four shard producer');
    const four = git('rev-parse', 'HEAD');
    writeFileSync(path, producerWorkflow(16));
    git('add', '.');
    git('commit', '-qm', 'sixteen shard producer');
    const sixteen = git('rev-parse', 'HEAD');
    writeFileSync(path, producerWorkflow(4));
    assert.equal(readImmutablePublisherClientShards(root, four).total, 4);
    const inherited = process.env.GIT_DIR;
    process.env.GIT_DIR = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      env: gitEnvironmentForCwd(),
      encoding: 'utf8',
    }).trim();
    try {
      assert.equal(readImmutablePublisherClientShards(root, sixteen).total, 16);
    } finally {
      if (inherited === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = inherited;
    }
    assert.throws(() => readImmutablePublisherClientShards(root, '0'.repeat(40)));
    assert.throws(() => readImmutablePublisherClientShards(root, 'main'));
    writeFileSync(path, producerWorkflow(16).replace('shard: [1, 2', 'shard: [2, 2'));
    git('add', '.');
    git('commit', '-qm', 'unsupported producer');
    assert.throws(() => readImmutablePublisherClientShards(root, git('rev-parse', 'HEAD')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nested immutable producer retains exact matrix and only the maintained caller prefix', () => {
  const root = mkdtempSync(join(tmpdir(), 'publisher-nested-source-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, env: gitEnvironmentForCwd(), encoding: 'utf8' }).trim();
  const entry = join(root, '.github/workflows/publish-club-arena.yml');
  const helper = join(root, '.github/workflows/publish-club-arena-client.yml');
  const caller =
    'jobs:\n  client-publication:\n    needs: publish-needed\n    uses: ./.github/workflows/publish-club-arena-client.yml\n';
  try {
    git('init', '-q');
    git('config', 'user.name', 'Nested fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(entry, caller);
    for (const count of [4, 16]) {
      writeFileSync(
        helper,
        producerWorkflow(count).replace('jobs:', 'on:\n  workflow_call:\njobs:')
      );
      git('add', '.');
      git('commit', '-qm', `nested ${count}`);
      assert.deepEqual(readImmutablePublisherClientShards(root, git('rev-parse', 'HEAD')), {
        total: count,
        indices: Array.from({ length: count }, (_, i) => i + 1),
        jobPrefix: 'client-publication / ',
      });
    }
    for (const bad of [
      caller.replace('publish-club-arena-client.yml', 'arbitrary.yml'),
      caller.replace('needs: publish-needed', 'needs: other'),
      caller + '  client-publication:\n',
    ]) {
      writeFileSync(entry, bad);
      git('add', '.');
      git('commit', '-qm', 'unsupported caller');
      assert.throws(() => readImmutablePublisherClientShards(root, git('rev-parse', 'HEAD')));
    }
    writeFileSync(entry, caller);
    writeFileSync(
      helper,
      producerWorkflow(16).replace('jobs:', 'on:\n  push:\n  workflow_call:\njobs:')
    );
    git('add', '.');
    git('commit', '-qm', 'unapproved event entry');
    assert.throws(() => readImmutablePublisherClientShards(root, git('rev-parse', 'HEAD')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
