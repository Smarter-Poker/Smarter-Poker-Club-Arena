import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Result = {
  releaseRequired: boolean;
  targetSha: string;
  runtimeChanged: boolean | null;
  controlChanged: boolean | null;
  beforeKnown: boolean;
};
type Classifier = {
  engineControlFiles: readonly string[];
  runtimePathspecs: readonly string[];
  classifyEngineRelease: (args: { cwd: string; beforeSha?: string; afterSha: string }) => Result;
};
const script = resolve(__dirname, '../../scripts/ci/classify-engine-release.mjs');
const temporary: string[] = [];
let classifier: Classifier;
beforeAll(async () => {
  classifier = (await import(script)) as Classifier;
});
afterAll(() => temporary.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function history() {
  const cwd = mkdtempSync(join(tmpdir(), 'engine-classifier-'));
  temporary.push(cwd);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q');
  git('config', 'user.email', 'classifier@example.invalid');
  git('config', 'user.name', 'Classifier fixture');
  const change = (path: string, content: string, message = path) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
    git('add', '--', path);
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  const base = change('server/src/runtime.ts', 'export const version = 1;\n');
  return { cwd, git, change, base };
}

describe('exact runtime identity and exact control release classification', () => {
  it('preserves the accepted runtime paths and only six control files', () => {
    expect(classifier.runtimePathspecs).toEqual([
      'server/**',
      ':(exclude)server/**/*.test.ts',
      ':(exclude)server/sim/**',
    ]);
    expect(classifier.engineControlFiles).toEqual([
      '.github/workflows/stage-engine-release.yml',
      '.github/workflows/auto-deploy-hetzner.yml',
      'scripts/ci/check-engine-doors-exist.mjs',
      'scripts/ci/engine-doors.allowlist.json',
      'scripts/ci/record-engine-deploy-attempt.mjs',
      'scripts/ci/classify-engine-release.mjs',
    ]);
  });

  it('stages each exact control change while retaining the existing runtime SHA', () => {
    const h = history();
    let before = h.base;
    for (const path of classifier.engineControlFiles) {
      const after = h.change(path, 'control generation 1\n');
      expect(
        classifier.classifyEngineRelease({ cwd: h.cwd, beforeSha: before, afterSha: after })
      ).toEqual({
        releaseRequired: true,
        targetSha: h.base,
        runtimeChanged: false,
        controlChanged: true,
        beforeKnown: true,
      });
      before = after;
    }
  });

  it('reproduces 07f20782: observer workflow plus its test stages the old runtime component', () => {
    // Actual07f20782 changed auto-deploy-hetzner.yml and its deadline test only.
    const h = history();
    h.change('.github/workflows/auto-deploy-hetzner.yml', 'bounded observer budget\n');
    const after = h.change(
      'tests/unit/engineReleaseAbsoluteDeadline.test.ts',
      'budget regression\n'
    );
    const result = classifier.classifyEngineRelease({
      cwd: h.cwd,
      beforeSha: h.base,
      afterSha: after,
    });
    expect(result).toMatchObject({
      releaseRequired: true,
      targetSha: h.base,
      runtimeChanged: false,
      controlChanged: true,
    });
  });

  it('ignores documentation, excluded runtime tests/simulations and similarly named controls', () => {
    const h = history();
    let before = h.base;
    for (const path of [
      'docs/release.md',
      'server/src/runtime.test.ts',
      'server/sim/run.ts',
      'scripts/ci/engine-doors.allowlist.json.backup',
    ]) {
      const after = h.change(path, 'irrelevant to this release\n');
      expect(
        classifier.classifyEngineRelease({ cwd: h.cwd, beforeSha: before, afterSha: after })
      ).toMatchObject({
        releaseRequired: false,
        targetSha: h.base,
        runtimeChanged: false,
        controlChanged: false,
      });
      before = after;
    }
  });

  it('finds runtime changes in the middle of a multi-commit mixed push', () => {
    const h = history();
    h.change('docs/before.md', 'before\n');
    const runtime = h.change('server/src/runtime.ts', 'export const version = 2;\n');
    h.change('scripts/ci/check-engine-doors-exist.mjs', 'new checker\n');
    const after = h.change('docs/after.md', 'after\n');
    expect(
      classifier.classifyEngineRelease({ cwd: h.cwd, beforeSha: h.base, afterSha: after })
    ).toEqual({
      releaseRequired: true,
      targetSha: runtime,
      runtimeChanged: true,
      controlChanged: true,
      beforeKnown: true,
    });
  });

  it('stages a reverted runtime change because the receiver requires the new component SHA', () => {
    const h = history();
    h.change('server/src/runtime.ts', 'export const version = 2;\n');
    const after = h.change('server/src/runtime.ts', 'export const version = 1;\n');
    expect(h.git('diff', '--name-only', h.base, after)).toBe('');
    expect(
      classifier.classifyEngineRelease({ cwd: h.cwd, beforeSha: h.base, afterSha: after })
    ).toMatchObject({
      releaseRequired: true,
      targetSha: after,
      runtimeChanged: true,
      controlChanged: false,
    });
  });

  it('does not miss removed control files', () => {
    const h = history();
    const before = h.change('scripts/ci/engine-doors.allowlist.json', '{}\n');
    h.git('rm', 'scripts/ci/engine-doors.allowlist.json');
    h.git('commit', '-qm', 'remove policy');
    expect(
      classifier.classifyEngineRelease({
        cwd: h.cwd,
        beforeSha: before,
        afterSha: h.git('rev-parse', 'HEAD'),
      })
    ).toMatchObject({
      releaseRequired: true,
      targetSha: h.base,
      controlChanged: true,
    });
  });

  it('fails closed for missing, zero, malformed, unreadable or non-ancestor before commits', () => {
    const h = history();
    const later = h.change('docs/next.md', 'next\n');
    for (const beforeSha of [undefined, '', '0'.repeat(40), 'not-a-sha', 'f'.repeat(40), later]) {
      expect(classifier.classifyEngineRelease({ cwd: h.cwd, beforeSha, afterSha: h.base })).toEqual(
        {
          releaseRequired: true,
          targetSha: h.base,
          runtimeChanged: null,
          controlChanged: null,
          beforeKnown: false,
        }
      );
    }
  });

  it('refuses invalid or absent after commits instead of claiming no release', () => {
    const h = history();
    for (const afterSha of ['', 'main', '0'.repeat(40), 'f'.repeat(40)]) {
      expect(() =>
        classifier.classifyEngineRelease({ cwd: h.cwd, beforeSha: h.base, afterSha })
      ).toThrow();
    }
  });

  it('runs the same importable classifier as the stage CLI', () => {
    const h = history();
    const after = h.change('.github/workflows/auto-deploy-hetzner.yml', 'control\n');
    const r = spawnSync(process.execPath, [script], {
      cwd: h.cwd,
      encoding: 'utf8',
      env: { ...process.env, BEFORE_SHA: h.base, AFTER_SHA: after },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('release_required=true\n');
    expect(r.stdout).toContain(`target_sha=${h.base}\n`);
    expect(r.stdout).toContain('runtime_changed=false\ncontrol_changed=true\n');
  });
});
