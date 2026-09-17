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
    expect(guard).toContain('REPO="${REMOTE_URL##*Smarter-Poker/}"');
    expect(guard).not.toMatch(/remote\.origin\.url/);
  });

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

  it('reports the existing CI deferral for MJS tests without claiming a local pass', () => {
    const result = runServerGate({
      files: ['server/src/testing/frame.test.mjs'],
      dependencyMode: 'ci',
      runnerAvailable: false,
    });
    expect(result.status).toBe(0);
    expect(result.calls).toBe('');
    expect(result.output).toContain(
      'local server tests not run: Mac dependencies are incomplete. Required CI must pass.'
    );
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
