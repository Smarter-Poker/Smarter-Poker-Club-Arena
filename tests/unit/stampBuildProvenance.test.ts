import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const script = path.resolve('scripts/stamp-build-provenance.mjs');
const fixtures: string[] = [];

// Each subprocess sees only its temporary repository. Runner git context and
// CI flags must not change the scenario or expose the enclosing worktree.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith('GIT_') &&
      !key.startsWith('GITHUB_') &&
      !['STRICT_PROVENANCE', 'CA_DIST', 'CA_BUILD_PURPOSE'].includes(key)
  )
);
const fixtureEnv = {
  ...cleanEnv,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directory() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ca-provenance-test-'));
  fixtures.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]) {
  const result = spawnSync('git', args, {
    cwd: dir,
    env: fixtureEnv,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Fixture git ${args[0]} failed: ${result.error ?? result.stderr}`);
  }
  return result.stdout.trim();
}

function repository(state: 'current' | 'behind' | 'ahead' | 'diverged' | 'no-remote') {
  const dir = directory();
  git(dir, 'init', '--quiet', '--initial-branch=main');
  git(dir, 'config', 'user.name', 'Smarter-Poker');
  git(dir, 'config', 'user.email', '254329056+Smarter-Poker@users.noreply.github.com');
  git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'fixture base');
  const base = git(dir, 'rev-parse', 'HEAD');
  if (state !== 'no-remote') git(dir, 'update-ref', 'refs/remotes/origin/main', base);
  if (state === 'behind' || state === 'diverged') {
    git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'fixture main advancement');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'checkout', '--quiet', '--detach', base);
  }
  if (state === 'ahead' || state === 'diverged') {
    git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'fixture branch advancement');
  }
  return dir;
}

function shallowMerge(mainDepth: 'shallow' | 'full') {
  const source = repository('current');
  for (let i = 0; i < 3; i++) {
    git(source, 'commit', '--quiet', '--allow-empty', '-m', `fixture main ${i}`);
  }
  git(source, 'checkout', '--quiet', '-b', 'feature');
  git(source, 'commit', '--quiet', '--allow-empty', '-m', 'fixture feature');
  git(source, 'checkout', '--quiet', 'main');
  git(source, 'commit', '--quiet', '--allow-empty', '-m', 'fixture main parent');
  const main = git(source, 'rev-parse', 'HEAD');
  git(source, 'checkout', '--quiet', '-b', 'pr');
  git(source, 'merge', '--quiet', '--no-ff', 'feature', '-m', 'fixture PR merge');
  const dir = directory();
  git(
    dir,
    '-c',
    'protocol.file.allow=always',
    'clone',
    '--quiet',
    '--depth=1',
    '--single-branch',
    '--branch=pr',
    pathToFileURL(source).href,
    '.'
  );
  git(
    dir,
    '-c',
    'protocol.file.allow=always',
    'fetch',
    '--quiet',
    ...(mainDepth === 'shallow' ? ['--depth=1'] : []),
    'origin',
    'main:refs/remotes/origin/main'
  );
  expect(git(dir, 'cat-file', '-p', 'HEAD')).toContain(`parent ${main}`);
  expect(git(dir, 'rev-parse', '--is-shallow-repository')).toBe('true');
  return { source, dir };
}

function stamp(dir: string, overrides: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [script], {
    cwd: dir,
    env: { ...fixtureEnv, ...overrides },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  const artifact = path.join(dir, overrides.CA_DIST || 'dist', 'ca-provenance.json');
  expect(existsSync(artifact)).toBe(true);
  return { ...result, info: JSON.parse(readFileSync(artifact, 'utf8')) };
}

function pullRequestBuild() {
  const dir = repository('current');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '--quiet', '-b', 'feature');
  git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'assigned client change');
  const head = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '--quiet', 'main');
  git(dir, 'merge', '--quiet', '--no-ff', 'feature', '-m', 'immutable PR merge');
  const merge = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '--quiet', '--detach', base);
  git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'unrelated newer database merge');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'checkout', '--quiet', '--detach', merge);
  const eventPath = path.join(directory(), 'pull-request.json');
  const repositoryName = 'Smarter-Poker/Smarter-Poker-Club-Arena';
  const event = {
    number: 4788,
    repository: { full_name: repositoryName },
    pull_request: {
      number: 4788,
      state: 'open',
      base: { ref: 'main', sha: base, repo: { full_name: repositoryName } },
      head: { sha: head },
    },
  };
  writeFileSync(eventPath, JSON.stringify(event));
  const env = {
    CA_BUILD_PURPOSE: 'ci-validation',
    GITHUB_WORKFLOW_REF: `${repositoryName}/.github/workflows/ci.yml@refs/pull/4788/merge`,
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: repositoryName,
    GITHUB_REF: 'refs/pull/4788/merge',
    GITHUB_SHA: merge,
    GITHUB_RUN_ID: '12345',
  };
  return { dir, base, head, merge, eventPath, event, env };
}

describe('actual build provenance subprocess', () => {
  it('validates the immutable PR merge when unrelated main moves, retaining non-publishable provenance', () => {
    const { dir, env, base, head, merge } = pullRequestBuild();
    const result = stamp(dir, env);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.info).toMatchObject({
      commit: merge,
      behindMain: 1,
      aheadMain: 2,
      validationOnly: true,
      pullRequest: { number: 4788, base, head, merge },
    });
  });

  it.each(['push', 'repository_dispatch', 'workflow_dispatch', 'pull_request_target'])(
    'still refuses the identical stale tree for the %s release context',
    (eventName) => {
      const { dir, env } = pullRequestBuild();
      const result = stamp(dir, {
        ...env,
        GITHUB_EVENT_NAME: eventName,
        CA_BUILD_PURPOSE: 'release-build',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('BEHIND origin/main');
      expect(result.info.validationOnly).toBe(false);
    }
  );

  it('keeps an explicit strict release strict even in a PR environment', () => {
    const { dir, env } = pullRequestBuild();
    const result = stamp(dir, { ...env, STRICT_PROVENANCE: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BEHIND origin/main');
  });

  it.each([
    'wrong-head',
    'wrong-base',
    'wrong-merge',
    'wrong-ref',
    'wrong-repository',
    'closed',
    'unreadable',
  ])('refuses a PR validation context with %s', (problem) => {
    const { dir, env, event, eventPath, base, head } = pullRequestBuild();
    if (problem === 'wrong-head') event.pull_request.head.sha = base;
    if (problem === 'wrong-base') event.pull_request.base.sha = head;
    if (problem === 'wrong-merge') env.GITHUB_SHA = head;
    if (problem === 'wrong-ref') env.GITHUB_REF = 'refs/heads/main';
    if (problem === 'wrong-repository') env.GITHUB_REPOSITORY = 'unrelated/repository';
    if (problem === 'closed') event.pull_request.state = 'closed';
    writeFileSync(eventPath, problem === 'unreadable' ? 'not JSON' : JSON.stringify(event));
    const result = stamp(dir, env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid PR build validation identity');
    expect(result.info.validationOnly).toBe(false);
  });

  it.each([
    ['GitHub Actions', { GITHUB_ACTIONS: 'true' }],
    ['strict local release', { STRICT_PROVENANCE: '1' }],
  ])('refuses stale source in %s and retains its diagnostic artifact', (_name, env) => {
    const dir = repository('behind');
    const result = stamp(dir, env);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('1 commit(s) BEHIND origin/main');
    expect(result.stdout).not.toContain('bypassed');
    expect(result.info).toMatchObject({
      commit: git(dir, 'rev-parse', 'HEAD'),
      behindMain: 1,
      aheadMain: 0,
    });
  });

  it('refuses a divergent CI checkout despite an additional branch commit', () => {
    const result = stamp(repository('diverged'), { GITHUB_ACTIONS: 'true' });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.info).toMatchObject({ behindMain: 1, aheadMain: 1 });
  });

  it.each([{}, { STRICT_PROVENANCE: '0' }])(
    'keeps a stale local diagnostic build usable: %j',
    (env) => {
      const result = stamp(repository('behind'), env);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('1 commit(s) BEHIND origin/main');
      expect(result.info).toMatchObject({ behindMain: 1, builtBy: 'local' });
    }
  );

  it('accepts current CI source with the exact source and run identity', () => {
    const dir = repository('current');
    const result = stamp(dir, {
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'Smarter-Poker/Smarter-Poker-Club-Arena',
      GITHUB_RUN_ID: '12345',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.info).toMatchObject({
      schema: 1,
      commit: git(dir, 'rev-parse', 'HEAD'),
      commitTime: git(dir, 'show', '-s', '--format=%cI', 'HEAD'),
      branch: 'main',
      dirty: false,
      behindMain: 0,
      aheadMain: 0,
      builtBy: 'github-actions',
      ciRun: 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/12345',
    });
  });

  it('accepts an ahead-only strict build and preserves the native output directory', () => {
    const dir = repository('ahead');
    const result = stamp(dir, { STRICT_PROVENANCE: '1', CA_DIST: 'dist-native' });
    expect(result.status).toBe(0);
    expect(result.info).toMatchObject({ behindMain: 0, aheadMain: 1 });
    expect(existsSync(path.join(dir, 'dist'))).toBe(false);
  });

  it.each(['shallow', 'full'] as const)(
    'refuses incomplete PR ancestry with %s main history, then accepts the same unshallowed merge',
    (mainDepth) => {
      const { source, dir } = shallowMerge(mainDepth);
      // Both runner histories falsely count main as behind its own merge.
      expect(Number(git(dir, 'rev-list', '--count', 'HEAD..origin/main'))).toBeGreaterThan(0);
      const incomplete = stamp(dir, { GITHUB_ACTIONS: 'true' });
      expect(incomplete.status).toBe(1);
      expect(incomplete.stderr).toContain('incomplete Git history');
      expect(incomplete.stderr).not.toContain('commit(s) BEHIND');
      expect(incomplete.info).toMatchObject({
        historyComplete: false,
        behindMain: null,
        aheadMain: null,
      });
      git(dir, '-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--unshallow', 'origin');
      const complete = stamp(dir, { GITHUB_ACTIONS: 'true' });
      expect(complete.status, complete.stdout + complete.stderr).toBe(0);
      expect(complete.info).toMatchObject({
        commit: incomplete.info.commit,
        historyComplete: true,
        behindMain: 0,
      });
      // Complete history must still reject real subsequent main advancement.
      git(source, 'checkout', '--quiet', 'main');
      git(source, 'commit', '--quiet', '--allow-empty', '-m', 'fixture newer main');
      git(
        dir,
        '-c',
        'protocol.file.allow=always',
        'fetch',
        '--quiet',
        'origin',
        'main:refs/remotes/origin/main'
      );
      const stale = stamp(dir, { GITHUB_ACTIONS: 'true' });
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain('1 commit(s) BEHIND origin/main');
    },
    30_000
  );

  it('warns on shallow local diagnostics but refuses a strict local release', () => {
    const { dir } = shallowMerge('shallow');
    const local = stamp(dir);
    expect(local.status).toBe(0);
    expect(local.stderr).toContain('incomplete Git history');
    expect(local.info).toMatchObject({ historyComplete: false, behindMain: null });
    const strict = stamp(dir, { STRICT_PROVENANCE: '1' });
    expect(strict.status).toBe(1);
    expect(strict.stderr).toContain('incomplete Git history');
  });

  it('preserves unknown-distance diagnostics when origin/main is unavailable', () => {
    const result = stamp(repository('no-remote'), { STRICT_PROVENANCE: '1' });
    expect(result.status).toBe(0);
    expect(result.info).toMatchObject({ behindMain: null, aheadMain: null });
    expect(result.stdout).toContain('behind-main=?');
  });

  it('preserves the documented non-git diagnostic artifact', () => {
    const result = stamp(directory(), { GITHUB_ACTIONS: 'true' });
    expect(result.status).toBe(0);
    expect(result.info).toMatchObject({
      commit: 'unknown',
      commitTime: 'unknown',
      branch: 'unknown',
      behindMain: null,
      aheadMain: null,
    });
  });
});

/**
 * The publisher as the origin runs it. The host-owned activation transaction
 * moved into `.github/scripts/publish-origin-activate.sh` on 2026-09-22,
 * because `jobs.<job_id>.steps[*].run` may not exceed 21,000 characters and
 * the inlined heredoc took that step to 24,626, at which point GitHub stops
 * LOADING the workflow instead of failing the step. The publishing job checks
 * the repository out at the SHA it publishes and pipes the file to `bash -s`,
 * byte for byte what the heredoc fed it, so splicing it back in at the pipe
 * reads the publisher exactly as before.
 */
const spliceActivationTransaction = (workflow: string, root: string) => {
  const pipe = '            < "$GITHUB_WORKSPACE/.github/scripts/publish-origin-activate.sh"';
  if (!workflow.includes(pipe)) {
    throw new Error('the publisher no longer pipes .github/scripts/publish-origin-activate.sh');
  }
  const transaction = readFileSync(
    path.join(root, '.github/scripts/publish-origin-activate.sh'),
    'utf8'
  )
    .split('\n')
    .map((line) => (line === '' ? line : `          ${line}`))
    .join('\n');
  return workflow.replace(pipe, transaction);
};
describe('actual client publisher provenance admission', () => {
  const workflow = spliceActivationTransaction(
    readFileSync(path.resolve('.github/workflows/publish-club-arena.yml'), 'utf8'),
    process.cwd()
  );
  const blocks = [...workflow.matchAll(/<<'NODE'\n([\s\S]*?)^\s*NODE$/gm)];
  const courier = blocks.find((block) =>
    block[1].includes("fs.readFileSync('dist/ca-provenance.json'")
  )?.[1];
  const origin = workflow.match(
    /<<'PYTHON_RELEASE_IDENTITY'\n([\s\S]*?)^\s*PYTHON_RELEASE_IDENTITY$/m
  )?.[1];
  const dedent = (source: string) => source.replace(/^ {10}/gm, '');

  const cases: [string, Record<string, unknown>, number][] = [
    ['current publisher', { validationOnly: false }, 0],
    ['retained legacy publisher', {}, 0],
    ['PR validation artifact even with otherwise matching metadata', { validationOnly: true }, 1],
    ['string validation marker', { validationOnly: 'false' }, 1],
    ['null validation marker', { validationOnly: null }, 1],
    ['stale main artifact', { behindMain: 1 }, 1],
    ['unmerged artifact', { aheadMain: 1 }, 1],
    ['wrong source', { commit: 'b'.repeat(40) }, 1],
    [
      'wrong run',
      { ciRun: 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/999' },
      1,
    ],
    ['dirty source', { dirty: true }, 1],
    ['incomplete ancestry', { historyComplete: false }, 1],
  ];
  it.each(cases)('both maintained admission gates judge %s', (_name, changes, expected) => {
    expect(courier).toBeTruthy();
    expect(origin).toBeTruthy();
    const dir = directory();
    const dist = path.join(dir, 'dist');
    mkdirSync(dist);
    const sha = 'a'.repeat(40);
    const repositoryName = 'Smarter-Poker/Smarter-Poker-Club-Arena';
    const provenance = {
      schema: 1,
      commit: sha,
      builtBy: 'github-actions',
      dirty: false,
      historyComplete: true,
      behindMain: 0,
      aheadMain: 0,
      ciRun: `https://github.com/${repositoryName}/actions/runs/12345`,
      ...changes,
    };
    const provenancePath = path.join(dist, 'ca-provenance.json');
    const buildInfoPath = path.join(dist, 'build-info.json');
    writeFileSync(provenancePath, JSON.stringify(provenance));
    writeFileSync(
      buildInfoPath,
      JSON.stringify({
        ca_sha: sha,
        built_by: 'publish-club-arena.yml',
        built_at: '2026-09-17T20:00:00Z',
        run_id: '12345',
      })
    );
    const envelope = spawnSync(process.execPath, ['-', sha, repositoryName, '12345'], {
      cwd: dir,
      env: fixtureEnv,
      input: dedent(courier!),
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(envelope.status, envelope.stderr).toBe(expected);
    const retained = spawnSync(
      'python3',
      ['-', provenancePath, buildInfoPath, sha, repositoryName],
      {
        cwd: dir,
        env: fixtureEnv,
        input: dedent(origin!),
        encoding: 'utf8',
        timeout: 10000,
      }
    );
    expect(retained.status, retained.stderr).toBe(expected);
  });
});
