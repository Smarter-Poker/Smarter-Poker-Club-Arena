import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';
import {
  conservativeClientInput,
  runtimeInputPlugin,
  makeRuntimeInputs,
  qualifiesRuntimeInputs,
} from '../../scripts/ci/client-runtime-inputs.mjs';
import {
  compareClientBacklog,
  verifyImmutableBundle,
  readRetentionReceipt,
  receiptArtifactId,
} from '../../scripts/ci/client-runtime-retention.mjs';

const scratchParent = process.env.RUNNER_TEMP || process.env.TMPDIR;
if (
  !scratchParent ||
  (process.platform === 'darwin' && !scratchParent.startsWith('/Volumes/SmarterWork/agent-work/'))
)
  throw new Error('Tests require the owned external SSD scratch directory on this Mac.');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const temp = () => mkdtempSync(resolve(scratchParent, 'runtime-input-fixture-'));
const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args])
    .toString()
    .trim();
const put = (cwd, path, text) => {
  mkdirSync(resolve(cwd, path, '..'), { recursive: true });
  writeFileSync(resolve(cwd, path), text);
};
const commit = (cwd) => {
  git(cwd, 'add', '.');
  git(
    cwd,
    '-c',
    'user.name=Runtime fixture',
    '-c',
    'user.email=fixture@invalid.local',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'isolated fixture'
  );
  return git(cwd, 'rev-parse', 'HEAD');
};

test('actual lazy shared-server module/watch graph excludes engine-only churn and includes all shared inputs', async () => {
  const cwd = temp();
  try {
    git(cwd, 'init', '-q');
    put(cwd, '.gitignore', 'dist/\n.client-runtime-*.json\n');
    put(cwd, 'index.html', '<script type="module" src="/src/main.js"></script>');
    put(cwd, 'src/main.js', 'window.readShared = () => import("../server/shared.js");');
    put(cwd, 'server/shared.js', 'export const value = 7;');
    put(cwd, 'server/engine.js', 'export const engine = 1;');
    put(cwd, 'public/data.json', '{"value":1}');
    put(cwd, 'scripts/build.mjs', '// unchanged build authority');
    put(cwd, 'tests/protected-features.json', '{}');
    put(cwd, '.github/workflows/publish-club-arena.yml', 'publisher-control');
    const baseline = commit(cwd);
    const observations = [];
    for (const label of ['app', 'diamond', 'prerender']) {
      await build({
        root: cwd,
        configFile: false,
        logLevel: 'silent',
        plugins: [runtimeInputPlugin(label, cwd)],
        build: { outDir: resolve(cwd, 'dist'), emptyOutDir: true },
      });
      observations.push(
        JSON.parse(readFileSync(resolve(cwd, `.client-runtime-${label}.json`), 'utf8'))
      );
    }
    const inputs = makeRuntimeInputs(baseline, observations, cwd);
    assert.equal(inputs.complete, true);
    assert.ok(inputs.files.some((entry) => entry.path === 'server/shared.js'));
    assert.ok(!inputs.files.some((entry) => entry.path === 'server/engine.js'));
    put(cwd, 'docs/changelog/entry.md', 'verification change');
    put(cwd, 'tests/e2e/current.spec.ts', 'new current assertion');
    put(
      cwd,
      'scripts/verification-harness/leaderboard-delegated-role-matrix.mjs',
      '// current owner assertions'
    );
    put(cwd, 'scripts/qualification/cash-native-hosted.manifest.json', '{\"qualified\":true}');
    put(
      cwd,
      '.github/workflows/leaderboard-isolated-auth-qualification.yml',
      'current verification workflow'
    );
    put(cwd, 'scripts/qualification/current.json', '{"qualified":true}');
    put(cwd, 'scripts/ci/schema-manifest.d/current.json', '{}');
    put(cwd, 'scripts/ci/test-native.py', '# corrected native qualification');
    put(cwd, '.github/workflows/ci.yml', 'current verification wiring');
    put(cwd, 'supabase/migrations/20261007071300_rule.sql', '-- database delivery');
    put(cwd, 'server/engine.js', 'export const engine = 2;');
    const verification = commit(cwd);
    const backlog = compareClientBacklog(baseline, verification, cwd);
    // BEFORE: the previous publisher built unconditionally for this same
    // complete verification/database/engine backlog. AFTER: actual inputs equal.
    assert.equal(qualifiesRuntimeInputs(inputs, baseline, verification, backlog.paths, cwd), true);
    for (const path of [
      'src/new.js',
      'public/new.png',
      'package-lock.json',
      'vite.config.ts',
      'scripts/new-build.mjs',
      'tests/protected-features.json',
      '.github/workflows/post-deploy-e2e.yml',
    ]) {
      git(cwd, 'checkout', '-q', '--detach', verification);
      put(cwd, path, 'new actual runtime/build input');
      const candidate = commit(cwd);
      assert.equal(
        qualifiesRuntimeInputs(
          inputs,
          baseline,
          candidate,
          compareClientBacklog(baseline, candidate, cwd).paths,
          cwd
        ),
        false,
        path
      );
    }
    git(cwd, 'checkout', '-q', '--detach', verification);
    put(cwd, 'server/shared.js', 'export const value = 8;');
    const changedShared = commit(cwd);
    assert.equal(
      qualifiesRuntimeInputs(
        inputs,
        baseline,
        changedShared,
        compareClientBacklog(baseline, changedShared, cwd).paths,
        cwd
      ),
      false
    );
    // Comparing only the LAST push would miss the shared-module backlog.
    put(cwd, 'docs/changelog/later.md', 'later documentation');
    const later = commit(cwd);
    assert.equal(
      qualifiesRuntimeInputs(
        inputs,
        baseline,
        later,
        compareClientBacklog(baseline, later, cwd).paths,
        cwd
      ),
      false
    );
    assert.throws(() => compareClientBacklog(later, baseline, cwd));
    for (const path of [
      'src/new.js',
      'public/new.png',
      'package-lock.json',
      'vite.config.ts',
      'scripts/new-build.mjs',
      'tests/protected-features.json',
      '.github/workflows/post-deploy-e2e.yml',
    ])
      assert.equal(conservativeClientInput(path), true);
    assert.throws(() =>
      qualifiesRuntimeInputs(
        { ...inputs, complete: false },
        baseline,
        verification,
        backlog.paths,
        cwd
      )
    );
    assert.throws(() =>
      qualifiesRuntimeInputs(
        { ...inputs, files: inputs.files.filter((entry) => entry.path !== 'public/data.json') },
        baseline,
        verification,
        backlog.paths,
        cwd
      )
    );
    put(cwd, 'unknown/new.file', 'unclassified');
    const unknown = commit(cwd);
    assert.equal(
      qualifiesRuntimeInputs(
        inputs,
        baseline,
        unknown,
        compareClientBacklog(baseline, unknown, cwd).paths,
        cwd
      ),
      false
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('artifact seal covers every byte and refuses duplicate, missing, extra, unsafe and symlink paths', () => {
  const cwd = temp();
  try {
    put(cwd, 'index.html', 'real bytes');
    const manifest = `${hash('real bytes')}  ./index.html\n`;
    put(cwd, '.release-manifest.sha256', manifest);
    assert.equal(verifyImmutableBundle(cwd, manifest), hash(manifest));
    put(cwd, 'extra.txt', 'unsealed');
    assert.throws(() => verifyImmutableBundle(cwd, manifest));
    rmSync(resolve(cwd, 'extra.txt'));
    assert.throws(() => verifyImmutableBundle(cwd, manifest + manifest));
    assert.throws(() => verifyImmutableBundle(cwd, `${hash('real bytes')}  ./../escape\n`));
    put(cwd, 'index.html', 'changed bytes');
    assert.throws(() => verifyImmutableBundle(cwd, manifest));
    rmSync(resolve(cwd, 'index.html'));
    symlinkSync('outside', resolve(cwd, 'index.html'));
    assert.throws(() => verifyImmutableBundle(cwd, manifest));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('receipt source binding and metadata reject missing, expired, PR, foreign or truncated evidence', () => {
  const sha = 'a'.repeat(40);
  const receipt = {
    schema: 1,
    kind: 'retained-client-runtime',
    runtimeSha: sha,
    verificationSha: sha,
    sourceRunId: '12',
    sourceTriggerSha: sha,
    repositoryId: '34',
    originalPublisherRunId: '56',
    originalArtifactId: 78,
    manifestSHA256: 'b'.repeat(64),
    buildInfoSHA256: 'c'.repeat(64),
    paths: [],
    inputs: { sourceSha: sha, complete: true },
  };
  assert.equal(readRetentionReceipt(receipt, '12', sha, '34').runtimeSha, sha);
  for (const override of [
    { sourceRunId: '99' },
    { sourceTriggerSha: 'd'.repeat(40) },
    { repositoryId: '99' },
    { runtimeSha: 'short' },
    { inputs: null },
    { paths: ['../escape'] },
  ])
    assert.throws(() => readRetentionReceipt({ ...receipt, ...override }, '12', sha, '34'));
  const artifact = {
    id: 91,
    name: 'club-arena-retained-runtime',
    expired: false,
    workflow_run: {
      id: 12,
      head_sha: sha,
      head_branch: 'main',
      repository_id: 34,
      head_repository_id: 34,
    },
  };
  assert.equal(receiptArtifactId({ total_count: 1, artifacts: [artifact] }, '12', sha, '34'), 91);
  assert.throws(() =>
    receiptArtifactId({ total_count: 2, artifacts: [artifact] }, '12', sha, '34')
  );
  assert.throws(() =>
    receiptArtifactId({ total_count: 2, artifacts: [artifact, artifact] }, '12', sha, '34')
  );
  for (const override of [
    { expired: true },
    { workflow_run: { ...artifact.workflow_run, head_branch: 'feature' } },
    { workflow_run: { ...artifact.workflow_run, head_repository_id: 99 } },
  ])
    assert.throws(() =>
      receiptArtifactId(
        { total_count: 1, artifacts: [{ ...artifact, ...override }] },
        '12',
        sha,
        '34'
      )
    );
});
