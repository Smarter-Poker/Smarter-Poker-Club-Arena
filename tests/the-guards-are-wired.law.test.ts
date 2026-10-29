/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: A GUARD THAT IS NOT WIRED IN IS A FILE, NOT A GUARD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `estate-integrity.sh` puts it exactly right, about a different failure:
 *
 *   "Every loss this estate has taken came from a protection that existed
 *    somewhere and was not actually in force where it mattered: hooks that
 *    guarded one machine because they were untracked; an Autopilot rolled to
 *    seven repos that queued nothing in six; a required check that could not be
 *    required because the gate behind it was red for an unrelated reason."
 *
 * `scripts/guard-merged-branch.sh` is one HTTP request standing between an
 * agent and work that disappears while git reports success. It only does that
 * from `.husky/pre-push`. Deleting the call is a one-line diff that reads like
 * tidying, and nothing else in the repo would notice.
 *
 * So this pins the wiring, not the implementation - the script may be rewritten
 * freely, but it must still be invoked and fail closed when GitHub cannot
 * provide an authenticated verdict.
 */
import { describe, it, expect } from 'vitest';
import {
  readFileSync,
  existsSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const GUARD_PATH = 'scripts/guard-merged-branch.sh';
const HOOK_PATH = '.husky/pre-push';

describe('LAW - the merged-branch guard is wired into the push path', () => {
  it('the guard exists and is executable', () => {
    expect(existsSync(resolve(root, GUARD_PATH)), `${GUARD_PATH} is missing`).toBe(true);
    // A hook calls it with `bash <path>`, so the mode bit is not load-bearing
    // for correctness - but a non-executable guard is a sign it was recreated
    // by a copy that also lost something else.
    const mode = statSync(resolve(root, GUARD_PATH)).mode;
    expect(mode & 0o111, `${GUARD_PATH} is not executable`).toBeGreaterThan(0);
  });

  it('pre-push actually invokes it', () => {
    const hook = read(HOOK_PATH);
    expect(hook, 'the pre-push hook no longer calls guard-merged-branch.sh').toMatch(
      /guard-merged-branch\.sh/
    );
    expect(hook).toContain('"$REMOTE" "$URL"');
  });

  it('it runs BEFORE the expensive suites, so a doomed push fails in seconds', () => {
    const hook = read(HOOK_PATH);
    const guardAt = hook.indexOf('guard-merged-branch.sh');
    // The first thing in this hook that costs real time. If the guard sits
    // after it, an agent waits three minutes to be told the push cannot land.
    const testsAt = hook.search(/vitest|npx tsc|running the tests/);
    expect(guardAt, 'guard not found').toBeGreaterThan(-1);
    if (testsAt > -1) {
      expect(guardAt, 'the guard must run before the test suites').toBeLessThan(testsAt);
    }
  });

  it('fails closed when GitHub cannot provide an authenticated verdict', () => {
    const guard = read(GUARD_PATH);
    expect(guard).toContain('GitHub CLI is required');
    expect(guard).toMatch(/if \[\[ -z "\$RESP" \]\]; then[\s\S]*?exit 1/);
    expect(guard).toContain('GitHub returned an unreadable branch verdict');
  });

  it('uses the GitHub CLI credential store and never scrapes token candidates', () => {
    const guard = read(GUARD_PATH);
    expect(guard).toMatch(/gh api -X GET/);
    expect(guard).not.toMatch(/CANDIDATES|for TOKEN|Bad credentials/);
  });

  it('checks the repository receiving this push, not remote.origin by habit', () => {
    const guard = read(GUARD_PATH);
    expect(guard).toContain('REMOTE_URL="${3:-}"');
    expect(guard).toContain('SLUG="$OWNER/$REPO"');
    expect(guard).toContain('head=$HEAD_OWNER:$BRANCH');
    expect(guard).not.toMatch(/remote\.origin\.url/);
  });

  function runDestinationGuard(owner: string, identity: unknown, prs: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'merged-transfer-'));
    try {
      const trace = join(dir, 'trace');
      writeFileSync(
        join(dir, 'gh'),
        `#!/bin/bash
printf '%s\\n' "$*" >> "$GUARD_TRACE"
case "$*" in
  *'/pulls'*) printf '%s' "$GUARD_PRS" ;;
  *) printf '%s' "$GUARD_IDENTITY" ;;
esac
`,
        { mode: 0o755 }
      );
      const result = spawnSync(
        'bash',
        [
          resolve(root, GUARD_PATH),
          'fix/timing',
          'origin',
          `git@github.com:${owner}/Smarter-Poker-Club-Arena.git`,
        ],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 5000,
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            GUARD_TRACE: trace,
            GUARD_IDENTITY: JSON.stringify(identity),
            GUARD_PRS: JSON.stringify(
              Array.isArray(prs)
                ? prs.map((p) => ({
                    ...p,
                    head: {
                      ref: 'fix/timing',
                      repo: { id: 1132369872, owner: { login: 'Smarter-Software-PIQ' } },
                    },
                  }))
                : prs
            ),
          },
        }
      );
      return {
        status: result.status,
        output: result.stdout + result.stderr,
        trace: existsSync(trace) ? readFileSync(trace, 'utf8') : '',
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const transferredIdentity = {
    id: 1132369872,
    full_name: 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena',
    owner: { login: 'Smarter-Software-PIQ' },
  };

  it.each(['Smarter-Poker', 'Smarter-Software-PIQ'])(
    'resolves the approved transfer before filtering %s heads',
    (owner) => {
      const result = runDestinationGuard(owner, transferredIdentity, [
        {
          number: 8479,
          state: 'open',
          head: {
            ref: 'fix/timing',
            repo: { id: 1132369872, owner: { login: 'Smarter-Software-PIQ' } },
          },
        },
      ]);
      expect(result.status).toBe(0);
      expect(result.trace).toContain('repos/Smarter-Software-PIQ/Smarter-Poker-Club-Arena/pulls');
      expect(result.trace).toContain('head=Smarter-Software-PIQ:fix/timing');
      expect(result.trace).not.toContain('head=Smarter-Poker:');
    }
  );
  it.each([
    { ...transferredIdentity, id: 42 },
    {
      ...transferredIdentity,
      full_name: 'Stranger/Smarter-Poker-Club-Arena',
      owner: { login: 'Stranger' },
    },
    {},
  ])('refuses an unproved transfer before querying PRs', (identity) => {
    const result = runDestinationGuard('Smarter-Poker', identity, []);
    expect(result.status).toBe(1);
    expect(result.trace).not.toContain('/pulls');
  });
  it.each([
    { prs: [{ number: 8479, state: 'closed' }], refusal: 'CLOSED pull request #8479' },
    {
      prs: [{ number: 8479, state: 'closed', merged_at: '2026-10-28T22:00:00Z' }],
      refusal: 'MERGED pull request #8479',
    },
    { prs: { message: 'Bad credentials' }, refusal: 'unreadable branch verdict' },
  ])(
    'still blocks closed, merged or unreadable transferred branch verdicts',
    ({ prs, refusal }) => {
      const result = runDestinationGuard('Smarter-Software-PIQ', transferredIdentity, prs);
      expect(result.status).toBe(1);
      expect(result.output).toContain(refusal);
    }
  );

  it('an auth failure is loud and blocks the orphaning push', () => {
    const guard = read(GUARD_PATH);
    expect(guard).toMatch(/BLOCKED: GitHub CLI did not provide an authenticated verdict/);
  });

  it('never reads a local or sibling .env for credentials', () => {
    const executable = read(GUARD_PATH)
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(executable).not.toMatch(/--git-common-dir|\.env|club-arena\/\.env/);
  });

  it('has no environment-variable bypass', () => {
    const guard = read(GUARD_PATH);
    expect(guard).not.toMatch(/AGENT_MERGED_BRANCH_OK|ALLOW|BYPASS|SKIP_GUARD/);
    expect(read('.env.example')).not.toMatch(/AGENT_MERGED_BRANCH_OK/);
  });

  it('validates Git branch grammar without bypassing legal punctuation', () => {
    const guard = read(GUARD_PATH);
    expect(guard).toContain('git check-ref-format "refs/heads/$BRANCH"');
    expect(guard).toContain('is not a valid destination branch');
    expect(guard).not.toMatch(/\*\[\^A-Za-z0-9._\/-\]\*\)\s*exit 0/);
  });
});

describe('LAW - transferred Club Arena pushes retain branch authority', () => {
  const branch = 'codex/guard-transfer-fixture';
  const canonical = 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena';
  const repositoryId = 1132369872;
  const pull = (
    state = 'open',
    merged = false,
    owner = 'Smarter-Software-PIQ',
    id = repositoryId
  ) => ({
    number: 9001,
    state,
    merged_at: merged ? '2026-10-29T00:00:00Z' : null,
    head: { ref: branch, repo: { id, owner: { login: owner } } },
  });
  function runGuard(
    remote: string,
    options: {
      metadata?: unknown;
      pulls?: unknown;
      fail?: string;
      expectedOwner?: string;
      emptyForWrongOwner?: boolean;
    } = {}
  ) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ca-guard-owner-')));
    try {
      const trace = join(directory, 'trace');
      const mock = join(directory, 'mock-gh.mjs');
      writeFileSync(
        mock,
        `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.GUARD_FIX_TRACE, JSON.stringify(args) + '\\n');
const endpoint = args.find(x => x.startsWith('repos/'));
const kind = endpoint?.endsWith('/pulls') ? 'pulls' : 'metadata';
if (process.env.GUARD_FIX_FAIL === kind) process.exit(1);
if (kind === 'pulls' && !args.includes('head=' + process.env.GUARD_FIX_OWNER + ':' + process.env.GUARD_FIX_BRANCH)) {
  if (process.env.GUARD_FIX_WRONG_OWNER_EMPTY === '1') { process.stdout.write('[]'); process.exit(0); }
  process.exit(2);
}
process.stdout.write(process.env[kind === 'pulls' ? 'GUARD_FIX_PULLS' : 'GUARD_FIX_METADATA']);
`,
        { mode: 0o755 }
      );
      writeFileSync(
        join(directory, 'gh'),
        '#!/bin/sh\nexec "$GUARD_FIX_NODE" "$GUARD_FIX_MOCK" "$@"\n',
        { mode: 0o755 }
      );
      const result = spawnSync('bash', [resolve(root, GUARD_PATH), branch, 'origin', remote], {
        cwd: root,
        env: {
          ...process.env,
          PATH: directory + ':' + process.env.PATH,
          GUARD_FIX_NODE: process.execPath,
          GUARD_FIX_MOCK: mock,
          GUARD_FIX_TRACE: trace,
          GUARD_FIX_OWNER: options.expectedOwner || 'Smarter-Software-PIQ',
          GUARD_FIX_BRANCH: branch,
          GUARD_FIX_FAIL: options.fail || '',
          GUARD_FIX_WRONG_OWNER_EMPTY: options.emptyForWrongOwner ? '1' : '',
          GUARD_FIX_METADATA:
            typeof options.metadata === 'string'
              ? options.metadata
              : JSON.stringify(
                  options.metadata ?? {
                    full_name: canonical,
                    id: repositoryId,
                    owner: { login: 'Smarter-Software-PIQ' },
                  }
                ),
          GUARD_FIX_PULLS:
            typeof options.pulls === 'string'
              ? options.pulls
              : JSON.stringify(options.pulls ?? [pull()]),
        },
        encoding: 'utf8',
      });
      const calls = existsSync(trace)
        ? readFileSync(trace, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((x) => JSON.parse(x))
        : [];
      return { ...result, calls };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  for (const owner of ['Smarter-Poker', 'Smarter-Software-PIQ'])
    for (const remote of [
      `git@github.com:${owner}/Smarter-Poker-Club-Arena.git`,
      `https://github.com/${owner}/Smarter-Poker-Club-Arena`,
      `ssh://git@github.com/${owner}/Smarter-Poker-Club-Arena.git/`,
    ])
      it(`accepts authenticated canonical open authority through ${remote}`, () => {
        const result = runGuard(remote);
        expect(result.status, result.stderr).toBe(0);
        expect(
          result.calls.some(
            (args) =>
              args.includes('repos/' + canonical + '/pulls') &&
              args.includes('head=Smarter-Software-PIQ:' + branch)
          )
        ).toBe(true);
      });
  for (const state of ['closed', 'merged'])
    it(`old HTTPS alias cannot turn a ${state} PR into an empty old-owner answer`, () => {
      const result = runGuard('https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena.git', {
        pulls: [pull('closed', state === 'merged')],
        emptyForWrongOwner: true,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(state === 'merged' ? 'MERGED' : 'CLOSED');
    });
  for (const metadata of [
    { full_name: canonical, id: 42 },
    { full_name: 'Other-Owner/Smarter-Poker-Club-Arena', id: repositoryId },
    '{',
  ])
    it('refuses wrong immutable identity or unreadable repository metadata', () => {
      expect(runGuard('git@github.com:' + canonical + '.git', { metadata }).status).toBe(1);
    });
  for (const remote of [
    'git@github.com:Smarter-Software-PIQ/Other-Repo.git',
    'git@evilgithub.com:Smarter-Poker/Smarter-Poker-Club-Arena.git',
    'https://github.com/Other-Owner/Smarter-Poker-Club-Arena.git',
    'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/extra',
  ])
    it(`refuses foreign or malformed destination ${remote}`, () => {
      const result = runGuard(remote);
      expect(result.status).toBe(1);
      expect(result.calls).toHaveLength(0);
    });
  for (const pulls of [
    [pull('open', false, 'Smarter-Poker')],
    [pull('open', false, 'Smarter-Software-PIQ', 42)],
    [{ ...pull(), head: { ...pull().head, ref: 'other-branch' } }],
    [{ ...pull(), state: 'unknown' }],
    '{',
    { message: 'unreadable' },
  ])
    it('refuses wrong head authority and unreadable PR verdicts', () => {
      expect(runGuard('git@github.com:' + canonical + '.git', { pulls }).status).toBe(1);
    });
  for (const fail of ['metadata', 'pulls'])
    it(`fails closed on ${fail} API failure`, () => {
      expect(runGuard('git@github.com:' + canonical + '.git', { fail }).status).toBe(1);
    });
  it('allows a genuine new branch only after exact repository and current-owner query', () => {
    expect(runGuard('git@github.com:' + canonical + '.git', { pulls: [] }).status).toBe(0);
  });
  it('retains pre-transfer canonical authority', () => {
    expect(
      runGuard('git@github.com:Smarter-Poker/Smarter-Poker-Club-Arena.git', {
        metadata: {
          full_name: 'Smarter-Poker/Smarter-Poker-Club-Arena',
          id: repositoryId,
          owner: { login: 'Smarter-Poker' },
        },
        expectedOwner: 'Smarter-Poker',
        pulls: [pull('open', false, 'Smarter-Poker')],
      }).status
    ).toBe(0);
  });
  it('preserves other existing Smarter-Poker repository checks', () => {
    expect(
      runGuard('git@github.com:Smarter-Poker/Smarter-Poker-World-Hub.git', {
        expectedOwner: 'Smarter-Poker',
        metadata: {
          full_name: 'Smarter-Poker/Smarter-Poker-World-Hub',
          id: 42,
          owner: { login: 'Smarter-Poker' },
        },
        pulls: [pull('open', false, 'Smarter-Poker', 42)],
      }).status
    ).toBe(0);
  });
});

describe('LAW - the test gate can never look at an empty diff', () => {
  /**
   * FOUND 2026-09-06, and it had been true for as long as the hook has had a
   * test gate.
   *
   * The new-branch arm read `git diff --name-only "$LOCAL_SHA"` - the WORKING
   * TREE against that commit. A clean tree at push time returns NOTHING, so
   * `FILES` was empty, `CHANGED_SRC` and `CHANGED_TESTS` were empty, and the
   * vitest gate below them was skipped in silence. Every house rule still
   * printed OK, so the push read as fully checked while the one guard
   * CLAUDE.md rule 8 calls the seatbelt had not run at all.
   *
   * Measured: 0 files that way against 7 the right way, on a push whose diff
   * CONTAINED the test that CI then failed on.
   *
   * And it is the path every agent takes: 10.82 requires a new branch off main
   * for every follow-up commit, so the rule that stops commits vanishing sends
   * all of them through the one arm where the gate is blind.
   */
  const hook = read(HOOK_PATH);

  it('never diffs the working tree against the commit being pushed', () => {
    /* `git diff --name-only <sha>` with no second ref is the bug. Two refs, or
       a range, is a real answer about what the push contains. */
    expect(hook, 'the new-branch arm is comparing against the working tree again').not.toMatch(
      /git diff --name-only "\$LOCAL_SHA"\s*\)/
    );
  });

  it('the new-branch arm resolves a merge base, like the remote-tip arm already did', () => {
    const arm = hook.slice(
      hook.indexOf('if [ "$REMOTE_SHA" = "0000'),
      hook.indexOf('# A FILE THAT IS IDENTICAL TO origin/main')
    );
    expect(arm, 'the new-branch arm must exist').not.toBe('');
    expect(arm, 'no merge-base in the new-branch arm').toMatch(/merge-base "\$LOCAL_SHA"/);
    expect(arm, 'it must diff two refs').toMatch(/git diff --name-only "\$BASE" "\$LOCAL_SHA"/);
    /* "I could not tell" is never "nothing changed" (10.86 rule 1): with no
       common base it checks the whole tree instead of an empty list. */
    expect(arm, 'no whole-tree fallback').toMatch(/git ls-files/);
  });
});

describe('LAW - changed server tests reach the server project', () => {
  // Execute the actual server gate and its final failure check. The earlier
  // Git/network guards are outside this selector fixture; Vitest is a recorder
  // here, so these cases prove invocation and refusal, not engine test success.
  function runServerGate({
    files,
    present = files,
    dependencyMode = 'local',
    runnerAvailable = true,
    runnerExit = 0,
  }: {
    files: string[];
    present?: string[];
    dependencyMode?: 'local' | 'ci';
    runnerAvailable?: boolean;
    runnerExit?: number;
  }) {
    const hook = read(HOOK_PATH);
    const marker = '\nSERVER_VITEST="$CA_TREE_TOP/server/node_modules/.bin/vitest"';
    expect(hook.split(marker)).toHaveLength(2);
    const serverGate = hook.slice(hook.indexOf(marker));
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ca-server-hook-selection-')));
    try {
      mkdirSync(join(directory, 'server'), { recursive: true });
      writeFileSync(join(directory, 'server/package.json'), '{}');
      for (const file of present) {
        mkdirSync(dirname(join(directory, file)), { recursive: true });
        writeFileSync(join(directory, file), '// selector fixture\n');
      }
      const trace = join(directory, 'runner-trace');
      if (runnerAvailable) {
        const runner = join(directory, 'server/node_modules/.bin/vitest');
        mkdirSync(dirname(runner), { recursive: true });
        writeFileSync(
          runner,
          '#!/bin/bash\n' +
            '{ printf "call\\n"; printf "cwd=%s\\n" "$PWD"; printf "arg=%s\\n" "$@"; } >> "$HOOK_TEST_TRACE"\n' +
            'exit "$HOOK_TEST_EXIT"\n',
          { mode: 0o755 }
        );
      }
      const result = spawnSync('bash', ['-c', 'set -e\nFAIL=0\n' + serverGate], {
        cwd: directory,
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin',
          CA_TREE_TOP: directory,
          FILES: files.join('\n'),
          SERVER_DEPENDENCY_MODE: dependencyMode,
          HOOK_TEST_TRACE: trace,
          HOOK_TEST_EXIT: String(runnerExit),
        },
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      return {
        status: result.status,
        output: result.stdout + result.stderr,
        calls: existsSync(trace) ? readFileSync(trace, 'utf8') : '',
        serverDirectory: join(directory, 'server'),
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it.each(['server/src/Root.test.mjs', 'server/src/testing/horseRegression/nested/frame.test.mjs'])(
    'runs a changed MJS test in the server project: %s',
    (file) => {
      const result = runServerGate({ files: [file] });
      expect(result.status).toBe(0);
      expect(result.calls).toBe(
        `call\ncwd=${result.serverDirectory}\narg=run\narg=${file.slice('server/'.length)}\n`
      );
    }
  );

  it('blocks the push when the changed MJS test runner fails', () => {
    const result = runServerGate({
      files: ['server/src/testing/horseRegression/frame.test.mjs'],
      runnerExit: 23,
    });
    expect(result.status).toBe(1);
    expect(result.calls).toContain('arg=run\narg=src/testing/horseRegression/frame.test.mjs\n');
    expect(result.output).toContain('BLOCKED: a server test you changed is failing.');
  });

  it('runs mixed TypeScript and MJS tests exactly once without treating them as sources', () => {
    const result = runServerGate({
      files: ['server/src/engine/decision.test.ts', 'server/src/testing/frame.test.mjs'],
    });
    expect(result.status).toBe(0);
    expect(result.calls).toBe(
      `call\ncwd=${result.serverDirectory}\narg=run\narg=src/engine/decision.test.ts\narg=src/testing/frame.test.mjs\n`
    );
  });

  it('runs related server tests for an MJS helper and preserves their failure', () => {
    const result = runServerGate({
      files: ['server/src/testing/horseRegression/fixture.mjs'],
      runnerExit: 19,
    });
    expect(result.status).toBe(1);
    expect(result.calls).toBe(
      `call\ncwd=${result.serverDirectory}\narg=related\narg=--run\narg=src/testing/horseRegression/fixture.mjs\n`
    );
  });

  it('preserves related-test selection for a TypeScript server source', () => {
    const result = runServerGate({ files: ['server/src/engine/decision.ts'] });
    expect(result.status).toBe(0);
    expect(result.calls).toBe(
      `call\ncwd=${result.serverDirectory}\narg=related\narg=--run\narg=src/engine/decision.ts\n`
    );
  });

  it('blocks incomplete dependencies instead of deferring a required local check', () => {
    const result = runServerGate({
      files: ['server/src/testing/frame.test.mjs'],
      dependencyMode: 'ci',
      runnerAvailable: false,
    });
    expect(result.status).toBe(1);
    expect(result.calls).toBe('');
    expect(result.output).toContain('BLOCKED: required local server dependencies are incomplete');
  });

  it('refuses a changed MJS test when local mode has no server runner', () => {
    const result = runServerGate({
      files: ['server/src/testing/frame.test.mjs'],
      runnerAvailable: false,
    });
    expect(result.status).toBe(1);
    expect(result.calls).toBe('');
    expect(result.output).toContain('REFUSING: you changed server/** and there is no vitest');
  });

  it('ignores removed files, declarations, source maps and tests from another project', () => {
    const present = [
      'server/src/testing/frame.test.mjs.map',
      'server/src/types.d.ts',
      'tests/root.test.ts',
    ];
    const result = runServerGate({
      files: ['server/src/testing/removed.test.mjs', ...present],
      present,
    });
    expect(result.status).toBe(0);
    expect(result.calls).toBe('');
  });
});

describe('LAW - local preflight selects document and workflow contracts', () => {
  // Execute the maintained gate with recording runners. This proves selection
  // and refusal; the selected real document law is also run by this PR.
  function runClientGate({
    files,
    pins = {},
    dependencyMode = 'local',
    runnerExit = 0,
    runnerAvailable = true,
  }: {
    files: string[];
    pins?: Record<string, string>;
    dependencyMode?: 'local' | 'ci';
    runnerExit?: number;
    runnerAvailable?: boolean;
  }) {
    const hook = read(HOOK_PATH);
    const start = hook.indexOf('\n# BEGIN TARGETED CLIENT PREFLIGHT');
    const end = hook.indexOf('\n# END TARGETED CLIENT PREFLIGHT');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ca-client-hook-selection-')));
    try {
      for (const [file, content] of Object.entries({
        'package.json': '{}',
        ...Object.fromEntries(files.map((file) => [file, '// source'])),
        ...pins,
      })) {
        mkdirSync(dirname(join(directory, file)), { recursive: true });
        writeFileSync(join(directory, file), content);
      }
      const trace = join(directory, 'runner-trace');
      if (runnerAvailable) {
        const runner = join(directory, 'node_modules/.bin/vitest');
        mkdirSync(dirname(runner), { recursive: true });
        writeFileSync(
          runner,
          '#!/bin/bash\nprintf "%s\\n" "$@" >> "$HOOK_TEST_TRACE"\nexit "$HOOK_TEST_EXIT"\n',
          { mode: 0o755 }
        );
      }
      const result = spawnSync(
        'bash',
        ['-c', 'set -e\nFAIL=0\n' + hook.slice(start, end) + '\nexit "$FAIL"'],
        {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            CA_TREE_TOP: directory,
            FILES: files.join('\n'),
            CLIENT_DEPENDENCY_MODE: dependencyMode,
            HOOK_TEST_TRACE: trace,
            HOOK_TEST_EXIT: String(runnerExit),
          },
          encoding: 'utf8',
          timeout: 5000,
        }
      );
      expect(result.error).toBeUndefined();
      return {
        status: result.status,
        output: result.stdout + result.stderr,
        calls: existsSync(trace) ? readFileSync(trace, 'utf8') : '',
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it.each([
    'AGENT-PLAYBOOK.md',
    '.github/workflows/publish-club-arena.yml',
    'scripts/stamp-build-provenance.mjs',
    'public/styles/example.css',
  ])('runs the existing test that reads %s and blocks on its failure', (file) => {
    const result = runClientGate({
      files: [file],
      runnerExit: 19,
      pins: { 'tests/existing.test.ts': `readFileSync('${file}')` },
    });
    expect(result.calls).toContain('tests/existing.test.ts');
    expect(result.status).toBe(1);
  });

  it('blocks a selected document test when dependencies are incomplete', () => {
    const result = runClientGate({
      files: ['AGENT-PLAYBOOK.md'],
      dependencyMode: 'ci',
      runnerAvailable: false,
      pins: { 'tests/doc.test.ts': "read('AGENT-PLAYBOOK.md')" },
    });
    expect(result.status).toBe(1);
    expect(result.calls).toBe('');
  });
  it('blocks a selected test without a local runner', () => {
    expect(runClientGate({ files: ['tests/doc.test.ts'], runnerAvailable: false }).status).toBe(1);
  });
  it('does not require dependencies for prose with no applicable executable contract', () => {
    const result = runClientGate({
      files: ['docs/ordinary-note.md'],
      dependencyMode: 'ci',
      runnerAvailable: false,
    });
    expect(result.status).toBe(0);
    expect(result.calls).toBe('');
  });
  it('runs a changed test once when it also names the changed document', () => {
    const result = runClientGate({
      files: ['AGENT-PLAYBOOK.md', 'tests/doc.test.ts'],
      pins: { 'tests/doc.test.ts': "read('AGENT-PLAYBOOK.md')" },
    });
    expect(result.status).toBe(0);
    expect(result.calls).toBe('run\ntests/doc.test.ts\n');
  });
});
