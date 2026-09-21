import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';

// Subprocess contract suite: these tests drive REAL child processes, so their
// wall time scales with machine load, not with the code under test. vitest's
// 5000ms default is a UNIT-test budget: the slowest test here measures 299ms
// solo, and the pre-push hook runs this file in a 90-file suite at full width,
// where contention has been measured to stretch these runs by 7.1x and time
// them out. 90s is 301x the measured solo runtime - past anything observed,
// and still a real bound, so a genuinely hung child still fails the suite.
// File-scoped on purpose: no global testTimeout, no --no-file-parallelism.
vi.setConfig({ testTimeout: 90_000 });
import {
  classifyChangedPaths,
  gitEnvironmentForCwd,
} from '../../scripts/ci/classify-ci-changes.mjs';

const root = resolve(__dirname, '../..');
const workflow = (name: string) =>
  parse(readFileSync(join(root, '.github/workflows', name), 'utf8'));
const stage = workflow('stage-engine-release.yml');
const publisher = workflow('publish-club-arena.yml');

describe('client delivery never inherits the engine activation window', () => {
  it.each([
    ['client behavior', ['src/pages/ClubHomePage.tsx'], false],
    ['client styling', ['src/components/table/Table.css'], false],
    ['client assets', ['public/assets/table.webp'], false],
    ['instructions', ['PUBLISHING.md'], false],
    ['server tests only', ['server/src/maintenance/new.test.ts'], false],
    ['server simulations only', ['server/sim/example.ts'], false],
    ['server implementation', ['server/src/GameServer.ts'], true],
    ['server release control', ['server/scripts/engine-release-transaction.sh'], true],
    ['mixed client and engine', ['src/pages/ClubHomePage.tsx', 'server/src/GameServer.ts'], true],
    [
      'large client diff',
      Array.from({ length: 310 }, (_, i) => `src/fixtures/route-${i}.ts`),
      false,
    ],
  ] as const)('executes the actual staging detector for %s', (_name, paths, expected) => {
    const cwd = mkdtempSync(join(tmpdir(), 'ca-release-routing-'));
    const env = {
      ...gitEnvironmentForCwd(),
      GIT_AUTHOR_NAME: 'Routing fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Routing fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    };
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
    const put = (path: string, content: string) => {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    };
    try {
      git('init', '-q');
      put('server/src/GameServer.ts', 'baseline');
      git('add', '.');
      git('commit', '-qm', 'baseline');
      const before = git('rev-parse', 'HEAD');
      for (const path of paths) put(path, 'changed');
      git('add', '.');
      git('commit', '-qm', 'candidate');
      const after = git('rev-parse', 'HEAD');
      const output = join(cwd, 'github-output');
      const detector = stage.jobs.detect.steps.find(
        (step: { id?: string }) => step.id === 'change'
      );
      execFileSync('bash', ['-c', detector.run], {
        cwd,
        env: { ...env, BEFORE_SHA: before, AFTER_SHA: after, GITHUB_OUTPUT: output },
        timeout: 10000,
        stdio: 'pipe',
      });
      expect(readFileSync(output, 'utf8')).toContain(`release_required=${expected}\n`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('routes ordinary client changes away from server and native fixture checks', () => {
    for (const path of [
      'src/pages/ClubHomePage.tsx',
      'src/components/table/Table.css',
      'public/logo.png',
    ]) {
      expect(classifyChangedPaths([path])).toMatchObject({
        server: false,
        phase4: false,
        fixture: false,
      });
    }
    // Financial client changes can require database/server tests without an engine deployment.
    expect(classifyChangedPaths(['src/services/DiamondGamesService.ts']).server).toBe(true);
  });

  it('keeps client publication gated only by its own build and tests', () => {
    expect(publisher.on.push.branches).toEqual(['main']);
    expect(publisher.on).not.toHaveProperty('schedule');
    expect(publisher.on).not.toHaveProperty('workflow_run');
    expect(publisher.jobs['publish-to-origin'].needs).toEqual([
      'publish-needed',
      'build-and-store',
      'client-tests',
    ]);
    const executable = Object.values(publisher.jobs)
      .flatMap((job: any) => job.steps ?? [])
      .map((step: any) => step.run ?? '')
      .join('\n');
    expect(executable).not.toMatch(
      /maintenance_certificate|readyForRestart|engine-release-transaction|deploy-club-arena-engine|\bdate\s+(?:-[a-zA-Z]+\s+)*['"]?\+%M(?:['"\s;)]|$)/
    );
    expect(publisher.concurrency.group).not.toBe(
      workflow('auto-deploy-hetzner.yml').concurrency.group
    );
  });
});
