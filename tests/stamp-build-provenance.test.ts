import { parse } from 'yaml';
import { afterEach, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const sourceRoot = process.env.PROVENANCE_REVIEW_ROOT || process.cwd();
const source = readFileSync(path.join(sourceRoot, 'scripts/stamp-build-provenance.mjs'), 'utf8');
const workflow = readFileSync(
  path.join(sourceRoot, '.github/workflows/publish-club-arena.yml'),
  'utf8'
);
const owned: string[] = [];
afterEach(() => {
  for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const outer = mkdtempSync(path.join(tmpdir(), 'build-provenance-'));
  owned.push(outer);
  const repo = path.join(outer, 'repo');
  mkdirSync(repo);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(GIT_|GITHUB_|CA_DIST$|CA_BUILD_PURPOSE$|STRICT_PROVENANCE$)/.test(key)
    )
  ) as NodeJS.ProcessEnv;
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
  });
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', path.join(outer, 'no-hooks'));
  mkdirSync(path.join(repo, 'scripts'));
  writeFileSync(path.join(repo, 'scripts/stamp-build-provenance.mjs'), source);
  writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'feature');
  writeFileSync(path.join(repo, 'feature'), 'feature');
  git('add', '.');
  git('commit', '-qm', 'feature');
  const head = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  writeFileSync(path.join(repo, 'main'), 'main');
  git('add', '.');
  git('commit', '-qm', 'main advances');
  const mergeBase = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'qualification');
  git('merge', '--no-ff', '-m', 'synthetic merge', 'feature');
  const control = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  writeFileSync(path.join(repo, 'later'), 'later');
  git('add', '.');
  git('commit', '-qm', 'main advances during CI');
  const currentMain = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', currentMain);
  git('switch', '-q', 'qualification');
  const eventPath = path.join(outer, 'event.json');
  writeFileSync(
    eventPath,
    JSON.stringify({
      number: 42,
      pull_request: {
        number: 42,
        head: { sha: head },
        base: {
          sha: base,
          ref: 'main',
          repo: { full_name: 'Smarter-Poker/Smarter-Poker-Club-Arena' },
        },
      },
    })
  );
  const context = {
    CA_BUILD_PURPOSE: 'ci-validation',
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REPOSITORY: 'Smarter-Poker/Smarter-Poker-Club-Arena',
    GITHUB_SHA: control,
    GITHUB_REF: 'refs/pull/42/merge',
    GITHUB_WORKFLOW_REF:
      'Smarter-Poker/Smarter-Poker-Club-Arena/.github/workflows/ci.yml@refs/pull/42/merge',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_RUN_ID: '123',
  };
  const run = (overrides: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, ['scripts/stamp-build-provenance.mjs'], {
      cwd: repo,
      env: { ...env, ...context, ...overrides },
      encoding: 'utf8',
    });
  const provenance = () =>
    JSON.parse(readFileSync(path.join(repo, 'dist/ca-provenance.json'), 'utf8'));
  return { git, run, provenance, base, head, control, mergeBase, currentMain, eventPath, outer };
}

test('a real captured PR merge builds after main advances and remains marked validation-only', () => {
  const f = fixture();
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(f.provenance()).toMatchObject({
    commit: f.control,
    validationOnly: true,
    historyComplete: true,
    behindMain: 1,
    dirty: false,
  });
});

test('the same stale tree remains refused for a production publisher', () => {
  const f = fixture();
  const result = f.run({
    CA_BUILD_PURPOSE: 'release-build',
    GITHUB_EVENT_NAME: 'repository_dispatch',
  });
  expect(result.status).toBe(1);
  expect(f.provenance()).toMatchObject({ validationOnly: false, behindMain: 1 });
});

test('explicit strict publication refuses a stale tree even in a valid PR context', () => {
  const f = fixture();
  const result = f.run({ STRICT_PROVENANCE: '1' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('1 commit(s) BEHIND origin/main');
  expect(f.provenance()).toMatchObject({ validationOnly: true, behindMain: 1 });
});

test('a failed ancestry count cannot qualify a PR snapshot as readable history', () => {
  const f = fixture();
  // Inject a command failure at the Git transport boundary. All other commands
  // still inspect the real fixture graph; unknown must not become fresh.
  const bin = path.join(f.outer, 'fault-bin');
  mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const shim = path.join(bin, 'git');
  writeFileSync(
    shim,
    `#!${process.execPath}\n` +
      `const {spawnSync}=require('node:child_process');\n` +
      `const args=process.argv.slice(2);\n` +
      `if(args[0]==='rev-list' && args[1]==='--count') process.exit(42);\n` +
      `const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});\n` +
      `process.exit(result.status ?? 1);\n`
  );
  chmodSync(shim, 0o700);
  const result = f.run({ PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Invalid PR build validation identity');
});

test('wrong workflow or source cannot acquire the CI validation exception', () => {
  const f = fixture();
  for (const override of [{ GITHUB_WORKFLOW_REF: 'wrong/workflow' }, { GITHUB_SHA: f.head }]) {
    const result = f.run(override);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid PR build validation identity');
  }
});

test('a protected-main rewind or non-ancestor event base fails validation', () => {
  const f = fixture();
  f.git('update-ref', 'refs/remotes/origin/main', f.base);
  expect(f.run().status).not.toBe(0);
  f.git('update-ref', 'refs/remotes/origin/main', f.currentMain);
  const event = JSON.parse(readFileSync(f.eventPath, 'utf8'));
  event.pull_request.base.sha = f.head;
  writeFileSync(f.eventPath, JSON.stringify(event));
  expect(f.run().status).not.toBe(0);
});

test('both executable publisher predicates reject CI markers even when ancestry counters are zero', () => {
  const expression = /const valid =\s*([\s\S]*?);\s*if \(!valid\)/.exec(workflow)?.[1];
  expect(expression).toBeTruthy();
  const evaluate = new Function(
    'provenance',
    'expectedSha',
    'expectedRun',
    `return (${expression});`
  );
  const expectedSha = 'a'.repeat(40),
    expectedRun = 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/123';
  const valid = {
    schema: 1,
    commit: expectedSha,
    builtBy: 'github-actions',
    dirty: false,
    historyComplete: true,
    behindMain: 0,
    aheadMain: 0,
    ciRun: expectedRun,
  };
  expect(evaluate(valid, expectedSha, expectedRun)).toBe(true);
  expect(evaluate({ ...valid, validationOnly: false }, expectedSha, expectedRun)).toBe(true);
  for (const marker of [true, 'true', 1, null])
    expect(evaluate({ ...valid, validationOnly: marker }, expectedSha, expectedRun)).toBe(false);
  const hostExpression =
    /require\(([^\n]+),\n\s*'CI validation bundles cannot be published'\)/.exec(workflow)?.[1];
  expect(hostExpression).toBeTruthy();
  for (const [provenance, expected] of [
    [{}, 'True'],
    [{ validationOnly: false }, 'True'],
    [{ validationOnly: true }, 'False'],
    [{ validationOnly: 'true' }, 'False'],
  ] as const) {
    const result = spawnSync(
      'python3',
      ['-c', `import json,sys\nprovenance=json.load(sys.stdin)\nprint(${hostExpression})`],
      { input: JSON.stringify(provenance), encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  }
});

test('only the two PR CI build steps select validation-only provenance', () => {
  const ci = parse(readFileSync(path.join(sourceRoot, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, { steps?: Array<{ run?: string; env?: Record<string, string> }> }>;
  };
  const builds = Object.values(ci.jobs)
    .flatMap((job) => job.steps || [])
    .filter((step) => step.run === 'npm run build:ci');
  expect(builds).toHaveLength(2);
  for (const step of builds) {
    const expression = step.env?.CA_BUILD_PURPOSE;
    expect(expression).toMatch(/^\$\{\{.*\}\}$/);
    const evaluate = new Function('github', `return (${expression!.slice(3, -2)});`);
    expect(evaluate({ event_name: 'pull_request' })).toBe('ci-validation');
    for (const event of [
      'push',
      'repository_dispatch',
      'workflow_dispatch',
      'pull_request_target',
    ]) {
      expect(evaluate({ event_name: event })).toBe('release-build');
    }
  }
});
