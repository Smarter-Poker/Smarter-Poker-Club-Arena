import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      !['STRICT_PROVENANCE', 'CA_DIST'].includes(key)
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

const repositoryName = 'Smarter-Poker/Smarter-Poker-Club-Arena';

function pullRequestSnapshot(advanced = true) {
  const dir = repository('current');
  git(dir, 'checkout', '--quiet', '-b', 'feature');
  git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'fixture PR head');
  const head = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '--quiet', 'main');
  git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'fixture PR base');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'update-ref', 'refs/remotes/origin/main', base);
  git(dir, 'checkout', '--quiet', '-b', 'pr');
  git(dir, 'merge', '--quiet', '--no-ff', 'feature', '-m', 'fixture event merge');
  const merge = git(dir, 'rev-parse', 'HEAD');
  if (advanced) {
    git(dir, 'checkout', '--quiet', 'main');
    git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'main advanced while PR queued');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  }
  git(dir, 'checkout', '--quiet', '--detach', merge);
  const eventPath = path.join(directory(), 'event.json');
  const event = {
    number: 4778,
    repository: { full_name: repositoryName },
    pull_request: {
      number: 4778,
      base: { sha: base, ref: 'main', repo: { full_name: repositoryName } },
      head: { sha: head },
      merge_commit_sha: merge as string | null,
    },
  };
  const saveEvent = () => writeFileSync(eventPath, JSON.stringify(event));
  saveEvent();
  return {
    dir,
    base,
    head,
    merge,
    event,
    saveEvent,
    env: {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: repositoryName,
      GITHUB_RUN_ID: '12345',
      GITHUB_REF: 'refs/pull/4778/merge',
      GITHUB_BASE_REF: 'main',
      GITHUB_SHA: merge,
    },
  };
}

// Execute the publisher's actual admission expression, rather than copying its
// conditions into an oracle which could drift along with the implementation.
function publisherAccepts(provenance: unknown, expectedSha: string) {
  const workflow = readFileSync('.github/workflows/publish-club-arena.yml', 'utf8');
  const expressions = [...workflow.matchAll(/const valid =([\s\S]*?);/g)];
  expect(expressions).toHaveLength(1);
  const admit = new Function(
    'provenance',
    'expectedSha',
    'expectedRun',
    `return (${expressions[0][1]});`
  );
  return admit(provenance, expectedSha, `https://github.com/${repositoryName}/actions/runs/12345`);
}

describe('actual build provenance subprocess', () => {
  it.each([false, true])('validates the event merge when newer main exists: %s', (advanced) => {
    const fixture = pullRequestSnapshot(advanced);
    const result = stamp(fixture.dir, fixture.env);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.info).toMatchObject({
      commit: fixture.merge,
      dirty: false,
      historyComplete: true,
      behindMain: advanced ? 1 : 0,
      aheadMain: 2,
      validationSnapshot: {
        purpose: 'pull-request-test-only',
        pullRequest: 4778,
        base: fixture.base,
        head: fixture.head,
        merge: fixture.merge,
      },
    });
    expect(publisherAccepts(result.info, fixture.merge)).toBe(false);
  });

  it('binds through the event SHA and parents when merge_commit_sha is not populated', () => {
    const fixture = pullRequestSnapshot();
    fixture.event.pull_request.merge_commit_sha = null;
    fixture.saveEvent();
    expect(stamp(fixture.dir, fixture.env).status).toBe(0);
  });

  it.each(['push', 'workflow_dispatch', 'repository_dispatch', 'pull_request_target'])(
    'does not apply PR test semantics to a %s release',
    (eventName) => {
      const fixture = pullRequestSnapshot();
      const result = stamp(fixture.dir, { ...fixture.env, GITHUB_EVENT_NAME: eventName });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('1 commit(s) BEHIND origin/main');
      expect(result.info.validationSnapshot).toBeUndefined();
    }
  );

  it('keeps explicit strict publication stronger than a valid PR test context', () => {
    const fixture = pullRequestSnapshot();
    const result = stamp(fixture.dir, { ...fixture.env, STRICT_PROVENANCE: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('1 commit(s) BEHIND origin/main');
    expect(publisherAccepts(result.info, fixture.merge)).toBe(false);
  });

  it.each([
    'missing-event',
    'malformed-event',
    'repository',
    'base-repository',
    'number',
    'ref',
    'base-ref',
    'base-sha',
    'head-sha',
    'merge-sha',
    'checkout-sha',
    'branch-checkout',
    'head-checkout',
    'reversed-parents',
    'missing-main',
    'unrelated-main',
    'shallow',
    'missing-head-object',
  ])('refuses an unbound PR snapshot: %s', (fault) => {
    const fixture = pullRequestSnapshot();
    switch (fault) {
      case 'repository':
        fixture.event.repository.full_name = 'another/repository';
        break;
      case 'base-repository':
        fixture.event.pull_request.base.repo.full_name = 'another/repository';
        break;
      case 'number':
        fixture.event.pull_request.number++;
        break;
      case 'ref':
        fixture.env.GITHUB_REF = 'refs/heads/main';
        break;
      case 'base-ref':
        fixture.event.pull_request.base.ref = 'other';
        break;
      case 'base-sha':
        fixture.event.pull_request.base.sha = fixture.head;
        break;
      case 'head-sha':
        fixture.event.pull_request.head.sha = fixture.base;
        break;
      case 'merge-sha':
        fixture.event.pull_request.merge_commit_sha = fixture.head;
        break;
      case 'checkout-sha':
        fixture.env.GITHUB_SHA = fixture.head;
        break;
      case 'branch-checkout':
        git(fixture.dir, 'checkout', '--quiet', 'pr');
        break;
      case 'head-checkout':
        git(fixture.dir, 'checkout', '--quiet', '--detach', fixture.head);
        fixture.env.GITHUB_SHA = fixture.head;
        fixture.event.pull_request.merge_commit_sha = fixture.head;
        break;
      case 'reversed-parents':
        fixture.event.pull_request.base.sha = fixture.head;
        fixture.event.pull_request.head.sha = fixture.base;
        break;
      case 'missing-main':
        git(fixture.dir, 'update-ref', '-d', 'refs/remotes/origin/main');
        break;
      case 'unrelated-main':
        git(fixture.dir, 'update-ref', 'refs/remotes/origin/main', fixture.head);
        break;
      case 'missing-head-object':
        rmSync(
          path.join(fixture.dir, '.git/objects', fixture.head.slice(0, 2), fixture.head.slice(2))
        );
        break;
      case 'shallow':
        writeFileSync(path.join(fixture.dir, '.git/shallow'), fixture.merge + '\n');
        break;
    }
    fixture.saveEvent();
    if (fault === 'missing-event') rmSync(fixture.env.GITHUB_EVENT_PATH);
    if (fault === 'malformed-event') writeFileSync(fixture.env.GITHUB_EVENT_PATH, '{');
    const result = stamp(fixture.dir, fixture.env);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('snapshot cannot be verified');
    expect(result.info.validationSnapshot).toBeUndefined();
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
    expect(publisherAccepts(result.info, git(dir, 'rev-parse', 'HEAD'))).toBe(true);
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
