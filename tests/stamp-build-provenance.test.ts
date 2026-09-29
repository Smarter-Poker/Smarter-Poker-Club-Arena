import { parse } from 'yaml';
import { afterEach, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const sourceRoot = process.env.PROVENANCE_REVIEW_ROOT || process.cwd();
const source = readFileSync(path.join(sourceRoot, 'scripts/stamp-build-provenance.mjs'), 'utf8');
/**
 * The publisher's shell is this workflow PLUS the origin activation
 * transaction it pipes to the host. That transaction was a heredoc inside one
 * `run:` step until 2026-09-22, when the step outgrew the size GitHub Actions
 * accepts for a single `run` and the whole workflow stopped parsing. Reading
 * both keeps this pin on the same bytes it always guarded.
 */
const workflow =
  readFileSync(path.join(sourceRoot, '.github/workflows/publish-club-arena.yml'), 'utf8') +
  readFileSync(path.join(sourceRoot, '.github/scripts/publish-origin-activate.sh'), 'utf8');
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
      repository: { full_name: 'Smarter-Poker/Smarter-Poker-Club-Arena' },
      pull_request: {
        number: 42,
        state: 'open',
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
  expect(f.provenance()).toMatchObject({ validationOnly: false, pullRequest: null, behindMain: 1 });
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

function admittedPublisher() {
  const f = fixture();
  f.git('checkout', '-q', '--detach', f.mergeBase);
  writeFileSync(
    f.eventPath,
    JSON.stringify({
      ref: 'refs/heads/main',
      after: f.mergeBase,
      deleted: false,
      repository: { full_name: 'Smarter-Poker/Smarter-Poker-Club-Arena', default_branch: 'main' },
    })
  );
  const env = {
    CA_BUILD_PURPOSE: 'production-publish',
    CA_PUBLISH_TARGET_SHA: f.mergeBase,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_SHA: f.mergeBase,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_SHA: f.mergeBase,
    GITHUB_WORKFLOW_REF:
      'Smarter-Poker/Smarter-Poker-Club-Arena/.github/workflows/publish-club-arena.yml@refs/heads/main',
    GITHUB_RUN_ATTEMPT: '1',
  };
  return { ...f, publish: (overrides: NodeJS.ProcessEnv = {}) => f.run({ ...env, ...overrides }) };
}

test('the admitted protected-main target survives a real later main commit with truthful counters', () => {
  const f = admittedPublisher();
  const result = f.publish();
  expect(result.status, result.stderr).toBe(0);
  expect(f.provenance()).toMatchObject({
    commit: f.mergeBase,
    validationOnly: false,
    dirty: false,
    historyComplete: true,
    behindMain: 1,
    aheadMain: 0,
    publication: { admittedMain: f.mergeBase, observedMain: f.currentMain },
  });
  expect(f.git('rev-parse', 'origin/main')).toBe(f.currentMain);
});

test('the admitted target remains eligible in the native build directory and explicit strict mode', () => {
  const f = admittedPublisher();
  const result = f.publish({ STRICT_PROVENANCE: '1', CA_DIST: 'dist-native' });
  expect(result.status, result.stderr).toBe(0);
  expect(
    JSON.parse(readFileSync(path.join(f.outer, 'repo/dist-native/ca-provenance.json'), 'utf8'))
  ).toMatchObject({ behindMain: 1, aheadMain: 0, validationOnly: false });
});

test('publication authority refuses wrong workflow, target, branch, event, run and unreadable identity', () => {
  const f = admittedPublisher();
  for (const override of [
    { GITHUB_WORKFLOW_REF: 'wrong/workflow' },
    { CA_PUBLISH_TARGET_SHA: f.currentMain },
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_RUN_ID: '' },
    { GITHUB_WORKFLOW_SHA: f.head },
    { GITHUB_EVENT_PATH: 'relative.json' },
    { GITHUB_ACTIONS: 'false' },
  ])
    expect(f.publish(override).status, JSON.stringify(override)).not.toBe(0);
});

test('a requested explicit recovery target must match the actual admitted commit', () => {
  const f = admittedPublisher();
  const event = {
    action: 'publish-club-arena',
    repository: {
      full_name: 'Smarter-Poker/Smarter-Poker-Club-Arena',
      default_branch: 'main',
    },
    client_payload: { ref_sha: f.mergeBase },
  };
  writeFileSync(f.eventPath, JSON.stringify(event));
  expect(f.publish({ GITHUB_EVENT_NAME: 'repository_dispatch' }).status).toBe(0);
  event.client_payload.ref_sha = f.base;
  writeFileSync(f.eventPath, JSON.stringify(event));
  expect(f.publish({ GITHUB_EVENT_NAME: 'repository_dispatch' }).status).not.toBe(0);
});

test('a rewind or divergence after admission never becomes a protected forward publication', () => {
  const f = admittedPublisher();
  for (const main of [f.base, f.head]) {
    f.git('update-ref', 'refs/remotes/origin/main', main);
    expect(f.publish().status, main).not.toBe(0);
  }
});

test('both actual publisher predicates accept the qualified target but reject tampered admission', () => {
  const f = admittedPublisher();
  const result = f.publish();
  expect(result.status, result.stderr).toBe(0);
  const provenance = f.provenance();
  const expectedRun = 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/123';
  const expression = /const valid =\s*([\s\S]*?);\s*if \(!valid\)/.exec(workflow)![1];
  const evaluate = new Function(
    'provenance',
    'expectedSha',
    'expectedRun',
    `return (${expression});`
  );
  const transaction = readFileSync(
    path.join(sourceRoot, '.github/scripts/publish-origin-activate.sh'),
    'utf8'
  );
  const start = transaction.indexOf('verify_release_identity() {');
  const end = transaction.indexOf('\n}\n\n', start) + 2;
  const check = path.join(f.outer, 'identity.sh');
  writeFileSync(
    check,
    'set -euo pipefail\n' + transaction.slice(start, end) + '\nverify_release_identity "$@"\n'
  );
  const release = path.join(f.outer, 'repo/dist');
  writeFileSync(
    path.join(release, 'build-info.json'),
    JSON.stringify({
      ca_sha: f.mergeBase,
      built_at: '2026-09-27T17:00:00Z',
      built_by: 'publish-club-arena.yml',
      run_id: '123',
    })
  );
  for (const [value, good] of [
    [provenance, true],
    [{ ...provenance, publication: null }, false],
    [{ ...provenance, publication: { ...provenance.publication, admittedMain: f.base } }, false],
    [{ ...provenance, publication: { ...provenance.publication, workflowRef: 'wrong' } }, false],
    [{ ...provenance, publication: { ...provenance.publication, observedMain: 'unknown' } }, false],
    [{ ...provenance, aheadMain: 1 }, false],
    [{ ...provenance, behindMain: -1 }, false],
    [{ ...provenance, behindMain: null }, false],
    [{ ...provenance, validationOnly: true }, false],
    [{ ...provenance, ciRun: expectedRun + '4' }, false],
  ] as const) {
    expect(Boolean(evaluate(value, f.mergeBase, expectedRun)), JSON.stringify(value)).toBe(good);
    writeFileSync(path.join(release, 'ca-provenance.json'), JSON.stringify(value));
    const checked = spawnSync(
      'bash',
      [check, release, f.mergeBase, 'Smarter-Poker/Smarter-Poker-Club-Arena'],
      { encoding: 'utf8' }
    );
    expect(checked.status === 0, checked.stderr).toBe(good);
  }
});

test('only the existing web and native publisher build steps carry the admitted target', () => {
  const w = parse(
    readFileSync(path.join(sourceRoot, '.github/workflows/publish-club-arena.yml'), 'utf8')
  );
  for (const [job, command] of [
    ['build-and-store', 'npm run build'],
    ['publish-to-app', 'npm run build:native'],
  ]) {
    const step = w.jobs[job].steps.find((s: { run?: string }) => s.run === command);
    expect(step.env.CA_BUILD_PURPOSE).toBe('production-publish');
    expect(step.env.CA_PUBLISH_TARGET_SHA).toBe('${{ needs.publish-needed.outputs.target_sha }}');
  }
});

test('missing or incomplete history and failed counts cannot qualify a queued publication', () => {
  const f = admittedPublisher();
  const bin = path.join(f.outer, 'publisher-fault-bin');
  mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const shim = path.join(bin, 'git');
  for (const fault of ['count', 'shallow', 'missing-main']) {
    writeFileSync(
      shim,
      `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\n` +
        `const a=process.argv.slice(2), fault=${JSON.stringify(fault)};\n` +
        `if(fault==='count' && a[0]==='rev-list' && a[1]==='--count') process.exit(42);\n` +
        `if(fault==='shallow' && a[0]==='rev-parse' && a[1]==='--is-shallow-repository'){console.log('true');process.exit(0);}\n` +
        `if(fault==='missing-main' && a.includes('origin/main'))process.exit(43);\n` +
        `const r=spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status??1);\n`
    );
    chmodSync(shim, 0o700);
    expect(
      f.publish({ PATH: `${bin}${path.delimiter}${process.env.PATH}` }).status,
      fault
    ).not.toBe(0);
  }
});

test('dirty source and a changed push payload cannot reuse admission', () => {
  const f = admittedPublisher();
  writeFileSync(path.join(f.outer, 'repo/main'), 'changed after admission');
  expect(f.publish().status).not.toBe(0);
  f.git('restore', 'main');
  const event = JSON.parse(readFileSync(f.eventPath, 'utf8'));
  event.after = f.currentMain;
  writeFileSync(f.eventPath, JSON.stringify(event));
  expect(f.publish().status).not.toBe(0);
});

test('actual origin ordering and activation compare-and-swap still refuse backward or raced publication', () => {
  const f = admittedPublisher();
  const ordering = /case "\$STATUS" in([\s\S]*?)\n\s*esac/.exec(workflow)?.[0];
  expect(ordering).toBeTruthy();
  for (const [live, candidate, expected] of [
    [f.base, f.mergeBase, 'publish'],
    [f.currentMain, f.mergeBase, 'standdown'],
    [f.head, f.mergeBase, 'refuse'],
  ]) {
    const counts = f
      .git('rev-list', '--left-right', '--count', `${live}...${candidate}`)
      .split(/\s+/)
      .map(Number);
    const status = counts[0] === 0 ? 'ahead' : counts[1] === 0 ? 'behind' : 'diverged';
    const r = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail\nSTATUS="$1"\nVERDICT=publish\n${ordering}\nprintf '%s' "$VERDICT"`,
        'ordering',
        status,
      ],
      { encoding: 'utf8' }
    );
    expect(r.status === 0 ? r.stdout : 'refuse').toBe(expected);
  }
  const transaction = readFileSync(
    path.join(sourceRoot, '.github/scripts/publish-origin-activate.sh'),
    'utf8'
  );
  const cas =
    /if \[ "\$CURRENT_SHA" != "\$EXPECTED_SHA" \] && \[ "\$CURRENT_SHA" != "\$SHA" \]; then[\s\S]*?\nfi/.exec(
      transaction
    )?.[0];
  expect(cas).toBeTruthy();
  for (const [current, expectedExit] of [
    [f.base, 0],
    [f.mergeBase, 0],
    [f.currentMain, 75],
  ] as const) {
    const r = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail\nCURRENT_SHA="$1"\nEXPECTED_SHA="$2"\nSHA="$3"\n${cas}`,
        'cas',
        current,
        f.base,
        f.mergeBase,
      ],
      { encoding: 'utf8' }
    );
    expect(r.status, r.stderr).toBe(expectedExit);
  }
});
