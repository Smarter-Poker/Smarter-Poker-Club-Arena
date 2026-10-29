import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { publishedSelectionBase } from '../../scripts/ci/publisher-ui-selection-base.mjs';
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

test('an unpublished financial predecessor keeps the full suite even when the last commit is safe UI', async () => {
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
});
