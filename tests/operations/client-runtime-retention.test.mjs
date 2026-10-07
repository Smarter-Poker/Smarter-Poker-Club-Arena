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
  assertReceiptOrigins,
  publicationDecision,
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
    const realLock = JSON.parse(
      readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')
    );
    put(cwd, 'package.json', '{\"name\":\"runtime-fixture\"}');
    put(
      cwd,
      'package-lock.json',
      JSON.stringify({ packages: { 'node_modules/vite': realLock.packages['node_modules/vite'] } })
    );
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

test('missing evidence, origin disagreement and same-SHA repair events use normal publication', async () => {
  for (const error of [
    new Error('missing original inventory'),
    new Error('incomplete immutable bytes'),
  ]) {
    assert.equal(
      (
        await publicationDecision(async () => {
          throw error;
        })
      ).publish,
      true
    );
  }
  const info = Buffer.from(
    JSON.stringify({ ca_sha: 'a'.repeat(40), run_id: '56', built_by: 'publish-club-arena.yml' })
  );
  const manifest = Buffer.from('complete actual immutable manifest');
  const receipt = {
    runtimeSha: 'a'.repeat(40),
    originalPublisherRunId: '56',
    buildInfoSHA256: hash(info),
    manifestSHA256: hash(manifest),
  };
  assertReceiptOrigins(receipt, [info, info], [manifest, manifest]);
  assert.equal(
    (
      await publicationDecision(async () => {
        assertReceiptOrigins(receipt, [info, Buffer.from('{}')], [manifest, manifest]);
        return receipt;
      })
    ).publish,
    true
  );
  const cwd = temp();
  try {
    const output = resolve(cwd, 'output');
    execFileSync(
      process.execPath,
      [
        new URL('../../scripts/ci/client-runtime-retention.mjs', import.meta.url).pathname,
        'admit',
        'a'.repeat(40),
      ],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          GITHUB_EVENT_NAME: 'repository_dispatch',
          GITHUB_OUTPUT: output,
          TMPDIR: scratchParent,
        },
      }
    );
    assert.equal(readFileSync(output, 'utf8'), 'publish=true\n');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('unknown virtual producers and foreign node_modules cannot qualify an actual Vite build', async () => {
  const cwd = temp();
  const foreign = temp();
  try {
    git(cwd, 'init', '-q');
    put(cwd, '.gitignore', 'dist/\n.client-runtime-*.json\n');
    const realLock = JSON.parse(
      readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')
    );
    put(cwd, 'package.json', '{"name":"runtime-fixture"}');
    put(
      cwd,
      'package-lock.json',
      JSON.stringify({ packages: { 'node_modules/vite': realLock.packages['node_modules/vite'] } })
    );
    put(foreign, 'node_modules/foreign/input.js', 'export const foreign = 3;');
    put(cwd, 'index.html', '<script type="module" src="/src/main.js"></script>');
    put(
      cwd,
      'src/main.js',
      `import { foreign } from '${resolve(foreign, 'node_modules/foreign/input.js')}'; import custom from 'virtual:unknown'; console.log(foreign, custom);`
    );
    const baseline = commit(cwd);
    const plugin = {
      name: 'unsupported-fixture-producer',
      resolveId(id) {
        if (id === 'virtual:unknown') return '\0unsupported:custom';
      },
      load(id) {
        if (id === '\0unsupported:custom') return 'export default 4';
      },
    };
    await build({
      root: cwd,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin, runtimeInputPlugin('app', cwd)],
      build: { outDir: resolve(cwd, 'dist') },
    });
    const graph = JSON.parse(readFileSync(resolve(cwd, '.client-runtime-app.json'), 'utf8'));
    assert.ok(graph.unknown.includes('unqualified-or-external-dependency-input'));
    assert.ok(graph.unknown.some((entry) => entry.startsWith('unsupported-virtual-input:')));
    assert.throws(() => makeRuntimeInputs(baseline, [graph, graph, graph], cwd));
    const inputs = makeRuntimeInputs(
      baseline,
      ['app', 'diamond', 'prerender'].map((build) => ({ ...graph, build })),
      cwd
    );
    assert.equal(inputs.complete, false);
    assert.throws(() =>
      makeRuntimeInputs(baseline, [{ ...graph, sourceSha: 'a'.repeat(40) }, graph, graph], cwd)
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});

test('sealed external font inputs require exact allowed URLs, request identity and every byte', async () => {
  const { FONT_UA, validateFontInputs, verifyFontInputs } =
    await import('../../scripts/ci/client-runtime-font-inputs.mjs');
  const url = 'https://fonts.gstatic.com/s/inter/v19/font.woff2';
  const css = Buffer.from(`@font-face{src:url(${url})}`);
  const font = Buffer.from('original font input');
  const receipt = {
    schema: 1,
    userAgent: FONT_UA,
    files: [
      {
        url: 'https://fonts.googleapis.com/css2?family=Inter',
        sha256: hash(css),
        bytes: css.length,
      },
      { url, sha256: hash(font), bytes: font.length },
    ],
  };
  let calls = 0;
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['User-Agent'], FONT_UA);
    calls++;
    return new Response(url.includes('googleapis') ? css : font);
  };
  await verifyFontInputs(receipt, fetcher);
  assert.equal(calls, 2);
  for (const invalid of [
    undefined,
    { ...receipt, userAgent: 'different' },
    { ...receipt, files: [receipt.files[0]] },
    {
      ...receipt,
      files: [receipt.files[0], { ...receipt.files[1], url: 'https://evil.invalid/font' }],
    },
    {
      ...receipt,
      files: [receipt.files[0], { ...receipt.files[1], url: 'https://fonts.gstatic.com/unknown' }],
    },
    {
      ...receipt,
      files: [
        receipt.files[0],
        { ...receipt.files[1], url: 'https://user@fonts.gstatic.com/s/font' },
      ],
    },
  ])
    assert.throws(() => validateFontInputs(invalid));
  await assert.rejects(verifyFontInputs(receipt, async () => new Response('changed')));
  await assert.rejects(verifyFontInputs(receipt, async () => new Response('', { status: 503 })));
  await assert.rejects(
    verifyFontInputs(receipt, async () => {
      throw new Error('timeout');
    })
  );
  const incompleteCss = Buffer.from(
    `@font-face{src:url(${url})} @font-face{src:url(https://fonts.gstatic.com/s/inter/v19/other.woff2)}`
  );
  await assert.rejects(
    verifyFontInputs(
      {
        ...receipt,
        files: [
          { ...receipt.files[0], sha256: hash(incompleteCss), bytes: incompleteCss.length },
          receipt.files[1],
        ],
      },
      async (url) => new Response(url.includes('googleapis') ? incompleteCss : font)
    )
  );
  assert.equal(
    (
      await publicationDecision(() =>
        verifyFontInputs(receipt, async () => new Response('changed'))
      )
    ).publish,
    true
  );
});
