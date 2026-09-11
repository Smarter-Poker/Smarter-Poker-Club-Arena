import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyClubArenaComponents,
  controlClosure,
  controlRoot,
  isolatedGitEnvironment,
  nonFrontendControls,
} from '../../scripts/ci/classify-club-arena-components.mjs';
import {
  hash,
  proveExistingArtifact,
  publicDocuments,
  requirePriorPublication,
} from '../../scripts/ci/prove-retained-frontend.mjs';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    env: isolatedGitEnvironment(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'ca-frontend-proof-'));
  dirs.push(base);
  const control = path.join(base, 'control'),
    source = path.join(base, 'source');
  mkdirSync(control);
  git(control, 'init', '-q');
  git(control, 'config', '--local', 'user.name', 'Isolated frontend fixture');
  git(control, 'config', '--local', 'user.email', 'fixture@example.invalid');
  const put = (root: string, file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  for (const file of nonFrontendControls) put(control, file, 'control\n');
  for (const file of controlClosure)
    put(control, file, readFileSync(path.join(controlRoot, file), 'utf8'));
  put(control, 'server/src/runtime.ts', 'runtime\n');
  const commit = (root: string) => {
    git(root, 'add', '.');
    git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
    return git(root, 'rev-parse', 'HEAD');
  };
  const beforeSha = commit(control);
  git(base, 'clone', '-q', '--no-hardlinks', control, source);
  git(source, 'config', '--local', 'user.name', 'Isolated frontend fixture');
  git(source, 'config', '--local', 'user.email', 'fixture@example.invalid');
  return {
    base,
    control,
    source,
    beforeSha,
    put: (file: string, text: string) => put(source, file, text),
    commit: () => commit(source),
    classify: (targetSha: string, before = beforeSha, controlSha = beforeSha) =>
      classifyClubArenaComponents({
        sourceRoot: source,
        beforeSha: before,
        targetSha,
        controlSha,
        trustedRoot: control,
      }),
  };
}
describe('exact component input classification', () => {
  it('reuses the six reviewed controls and retains a multi-commit control-only range', () => {
    const f = fixture();
    f.put(nonFrontendControls[0], 'first\n');
    f.commit();
    f.put(nonFrontendControls[1], 'second\n');
    const target = f.commit();
    const result = f.classify(target);
    expect(result.retained).toBe(true);
    expect(result.engine.controlChanged).toBe(true);
    expect(result.engine.runtimeChanged).toBe(false);
    expect(result.engine.targetSha).toBe(f.beforeSha);
    expect(result.changed).toHaveLength(2);
  });
  it.each([
    'src/page.ts',
    'public/asset.png',
    'server/src/domain/ArenaContext.ts',
    'tests/protected-features.json',
    'vite.config.ts',
    'package-lock.json',
    'scripts/self-host-fonts.mjs',
    'unknown-file',
  ])('never excludes frontend or unknown input %s', (file) => {
    const f = fixture();
    f.put(nonFrontendControls[0], 'changed\n');
    f.put(file, 'changed\n');
    expect(f.classify(f.commit()).retained).toBe(false);
  });
  it('refuses unknown/missing before and mismatched target/control identities', () => {
    const f = fixture();
    f.put(nonFrontendControls[0], 'changed\n');
    const target = f.commit();
    expect(f.classify(target, '0'.repeat(40)).retained).toBe(false);
    expect(f.classify(target, 'f'.repeat(40)).retained).toBe(false);
    expect(() => f.classify(f.beforeSha)).toThrow('Exact target');
    expect(() => f.classify(target, f.beforeSha, target)).toThrow('Exact control');
  });
  it.each(['delete', 'rename', 'mode', 'symlink'])('refuses control %s changes', (kind) => {
    const f = fixture(),
      file = nonFrontendControls[0],
      absolute = path.join(f.source, file);
    if (kind === 'delete') rmSync(absolute);
    if (kind === 'rename') git(f.source, 'mv', file, `${file}.renamed`);
    if (kind === 'mode') chmodSync(absolute, 0o755);
    if (kind === 'symlink') {
      rmSync(absolute);
      symlinkSync('elsewhere', absolute);
    }
    expect(f.classify(f.commit()).retained).toBe(false);
  });
  it('refuses dirty control code even when the target is an eligible edit', () => {
    const f = fixture();
    f.put(nonFrontendControls[0], 'changed\n');
    const target = f.commit();
    writeFileSync(path.join(f.control, controlClosure[0]), 'forged control');
    expect(() => f.classify(target)).toThrow('Control closure');
  });
  it('ignores hostile inherited Git config/ref/hook destinations without changing them', () => {
    const outside = fixture(),
      f = fixture();
    f.put(nonFrontendControls[0], 'changed\n');
    const target = f.commit();
    const config = readFileSync(path.join(outside.control, '.git/config'), 'utf8');
    const outsideHead = git(outside.control, 'rev-parse', 'HEAD');
    const hook = path.join(outside.base, 'hooks');
    mkdirSync(hook);
    const marker = path.join(outside.base, 'OUTSIDE');
    writeFileSync(path.join(hook, 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, {
      mode: 0o755,
    });
    const before = process.env;
    try {
      process.env = {
        ...before,
        GIT_DIR: path.join(outside.control, '.git'),
        GIT_WORK_TREE: outside.control,
        GIT_COMMON_DIR: path.join(outside.control, '.git'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: hook,
        GIT_TEMPLATE_DIR: hook,
        GIT_INDEX_FILE: path.join(outside.base, 'outside-index'),
        git_config_count: '9',
      };
      expect(f.classify(target).retained).toBe(true);
      const hostile = fixture();
      hostile.put(nonFrontendControls[0], 'safe inside hostile hook context\n');
      expect(hostile.classify(hostile.commit()).retained).toBe(true);
      const clean = isolatedGitEnvironment();
      expect(clean).not.toHaveProperty('GIT_CONFIG_COUNT');
      expect(clean).not.toHaveProperty('GIT_DIR');
      expect(clean).not.toHaveProperty('git_config_count');
    } finally {
      process.env = before;
    }
    expect(readFileSync(path.join(outside.control, '.git/config'), 'utf8')).toBe(config);
    expect(git(outside.control, 'rev-parse', 'HEAD')).toBe(outsideHead);
    expect(() => readFileSync(marker)).toThrow();
    expect(() => readFileSync(path.join(outside.base, 'outside-index'))).toThrow();
  });
});

function proofFixture() {
  const source = 'a'.repeat(40);
  const build = { ca_sha: source, run_id: '123' },
    provenance = {
      ciRun: 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/123',
    };
  const docs = () =>
    Object.fromEntries(
      ['origin', 'public'].map((side) => [
        side,
        {
          'build-info.json': { value: build, sha256: hash(JSON.stringify(build)) },
          'ca-provenance.json': { value: provenance, sha256: hash(JSON.stringify(provenance)) },
        },
      ])
    );
  const native = {
    schema: 1,
    source_sha: source,
    manifest_sha256: 'b'.repeat(64),
    file_count: 1797,
    build_info_sha256: hash(JSON.stringify(build)),
    provenance_sha256: hash(JSON.stringify(provenance)),
    build_info: build,
    provenance,
    lock: { device: 2049, inode: 2987241 },
    release: { device: 2049, inode: 17 },
    observed_at: new Date().toISOString(),
  };
  const run = {
    id: 123,
    path: '.github/workflows/publish-club-arena.yml',
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'failure',
    run_attempt: 1,
    repository: { full_name: 'Smarter-Poker/Smarter-Poker-Club-Arena' },
    head_repository: { full_name: 'Smarter-Poker/Smarter-Poker-Club-Arena' },
  };
  const jobs = {
    total_count: 1,
    jobs: [
      {
        name: 'publish-to-origin',
        id: 1,
        status: 'completed',
        conclusion: 'success',
        steps: [
          {
            name: 'Verify the origin serves this bundle',
            status: 'completed',
            conclusion: 'success',
          },
        ],
      },
    ],
  };
  return {
    docs,
    native,
    run,
    jobs,
    args: {
      readPublic: async () => docs(),
      readNative: async () => structuredClone(native),
      priorPublication: async () => requirePriorPublication(run, jobs, native),
    },
  };
}
describe('existing immutable artifact retention', () => {
  it('proves twice and retains the old source/artifact despite optional downstream failure', async () => {
    const f = proofFixture();
    let nativeReads = 0,
      publicReads = 0;
    const result = await proveExistingArtifact({
      ...f.args,
      expected: f.native,
      readPublic: async () => {
        publicReads++;
        return f.docs();
      },
      readNative: async () => {
        nativeReads++;
        return structuredClone(f.native);
      },
    });
    expect(result.native.source_sha).toBe('a'.repeat(40));
    expect(result.native.manifest_sha256).toBe('b'.repeat(64));
    expect(nativeReads).toBe(2);
    expect(publicReads).toBe(2);
  });
  it.each(['source', 'manifest', 'lock', 'document'])(
    'refuses changed %s between preview and authority',
    async (change) => {
      const f = proofFixture(),
        next = structuredClone(f.native);
      if (change === 'source') next.source_sha = 'c'.repeat(40);
      if (change === 'manifest') next.manifest_sha256 = 'c'.repeat(64);
      if (change === 'lock') next.lock.inode++;
      if (change === 'document') next.build_info_sha256 = 'c'.repeat(64);
      await expect(
        proveExistingArtifact({ ...f.args, expected: f.native, readNative: async () => next })
      ).rejects.toThrow();
    }
  );
  it('refuses source mutation during the proof and public/origin disagreement', async () => {
    const f = proofFixture();
    let count = 0;
    await expect(
      proveExistingArtifact({
        ...f.args,
        readPublic: async () => {
          const docs = structuredClone(f.docs());
          if (++count > 1) docs.public['build-info.json'].value.ca_sha = 'c'.repeat(40);
          return docs;
        },
      })
    ).rejects.toThrow('disagree');
  });
  it('requires the complete successful original publisher proof, not skipped/malformed metadata', () => {
    const f = proofFixture();
    expect(() =>
      requirePriorPublication({ ...f.run, path: '.github/workflows/ci.yml' }, f.jobs, f.native)
    ).toThrow();
    expect(() =>
      requirePriorPublication({ ...f.run, head_branch: 'feature' }, f.jobs, f.native)
    ).toThrow();
    expect(() =>
      requirePriorPublication(f.run, { ...f.jobs, total_count: 101 }, f.native)
    ).toThrow();
    const skipped = structuredClone(f.jobs);
    skipped.jobs[0].steps[0].conclusion = 'skipped';
    expect(() => requirePriorPublication(f.run, skipped, f.native)).toThrow();
  });
  it('uses cache-free bounded GETs for both exact provenance documents and refuses redirects/errors', async () => {
    const calls: { url: string; options: RequestInit }[] = [];
    await publicDocuments(async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      return new Response('{}', { status: 200 });
    });
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((call) => call.url)).size).toBe(4);
    for (const call of calls) {
      expect(call.options.cache).toBe('no-store');
      expect(call.options.redirect).toBe('error');
      expect(call.options.headers).toEqual({ 'Cache-Control': 'no-cache' });
    }
    await expect(
      publicDocuments(async () => new Response('{}', { status: 503 }))
    ).rejects.toThrow();
  });
});
