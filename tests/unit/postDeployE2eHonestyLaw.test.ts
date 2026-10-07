/**
 * POST-DEPLOY E2E HONESTY LAW (Phase 6, 2026-08-31)
 *
 * The rule this pins: **the post-deploy run must not report success when it did
 * not verify production.**
 *
 * It could, four different ways, and all four were live on `main`:
 *
 *   1. Playwright exits 0 when every test skips. Dozens of these specs skip
 *      themselves on /auth or when a live fixture is missing, so a run in which
 *      nothing executed was a green run.
 *   2. `global-setup.ts` falls back to a signed-out session when a login fails.
 *      Correct for a merge gate; fatal to the meaning of THIS job, whose entire
 *      purpose is to look at production with a real session.
 *   3. A failed Cashier step SKIPPED the broader sweep, so one money-surface red
 *      hid thirteen spec files and all of tests/e2e/routes - the precise
 *      opposite of the independence the workflow's own comment promises.
 *   4. Inside that sweep, `set -e` let a red Stats invocation abort the route
 *      invocation behind it. Same fault, one level down.
 *
 * Each assertion below is written against the shape that FIXED one of those.
 * If someone reverts one, this test names which.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/post-deploy-e2e.yml'), 'utf8');
const TABLE_WORKFLOW = WORKFLOW.slice(WORKFLOW.indexOf('  live-table-e2e:'));
const LIVE_TABLE = readFileSync(
  join(ROOT, 'tests/e2e/production-live-table-realtime.spec.ts'),
  'utf8'
);
const GLOBAL_SETUP = readFileSync(join(ROOT, 'tests/e2e/global-setup.ts'), 'utf8');
const ENGINE_READER = readFileSync(join(ROOT, 'scripts/ci/read-engine-release.mjs'), 'utf8');
const CHECKER = join(ROOT, 'scripts/ci/assert-e2e-actually-ran.mjs');

/**
 * ONE WORKFLOW STEP, bounded by the next step at the same indent.
 *
 * tests/helpers/sourceWindow.ts is the right idea in the wrong language: its
 * extractors match braces and parens, and YAML has neither. So the structure
 * here is the step list itself. A byte count would drift the moment a comment
 * is added inside a step, which is exactly the outage
 * noFixedSizeSourceWindows.test.ts exists to prevent - and this file was caught
 * by that test, correctly, on its first full-suite run.
 */
function step(workflow: string, name: string): string {
  const at = workflow.indexOf(`- name: ${name}`);
  if (at < 0) throw new Error(`step: "${name}" not found in the workflow`);
  const lineStart = workflow.lastIndexOf('\n', at) + 1;
  const indent = workflow.slice(lineStart, at);
  const next = workflow.indexOf(`\n${indent}- name: `, at + 1);
  return next < 0 ? workflow.slice(at) : workflow.slice(at, next);
}

/** Run the checker over throwaway reports and return its exit code. */
function check(reports: unknown[]): number {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-honesty-'));
  const paths = reports.map((r, i) => {
    const p = join(dir, `r${i}.json`);
    writeFileSync(p, JSON.stringify(r));
    return p;
  });
  try {
    execFileSync(process.execPath, [CHECKER, ...paths], { stdio: 'pipe' });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

const spec = (file: string, statuses: (string | null)[]) => ({
  suites: [
    {
      title: file,
      file,
      specs: statuses.map((s, i) => ({
        title: `t${i}`,
        file,
        tests: [{ results: [{ status: s ?? 'skipped' }] }],
      })),
    },
  ],
});

describe.each([
  { lane: 'client', workflow: WORKFLOW },
  { lane: 'live-table', workflow: TABLE_WORKFLOW },
])('$lane closing protected-main history', ({ workflow }) => {
  it.each(['forward', 'rollback', 'foreign', 'fetch-refused'])(
    'retains the exact %s verdict with a real stale checkout',
    (kind) => {
      const dir = mkdtempSync(join(tmpdir(), 'closing-lineage-'));
      const origin = join(dir, 'origin.git');
      const seed = join(dir, 'seed');
      const checkout = join(dir, 'checkout');
      const summary = join(dir, 'summary');
      const output = join(dir, 'output');
      // Hooks export the real repository's Git directory/index. Fixtures must
      // never inherit them, a global URL rewrite, or credentials/network I/O.
      const gitEnv = { ...process.env };
      for (const key of Object.keys(gitEnv)) {
        if (key.startsWith('GIT_')) delete gitEnv[key];
      }
      const emptyConfig = join(dir, 'empty-git-config');
      writeFileSync(emptyConfig, '');
      Object.assign(gitEnv, {
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ALLOW_PROTOCOL: 'file',
      });
      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', args, {
          cwd,
          env: gitEnv,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      try {
        git(dir, 'init', '--bare', '--initial-branch=main', origin);
        git(dir, 'clone', origin, seed);
        git(seed, 'config', 'user.name', 'Scoped Certificate Fixture');
        git(seed, 'config', 'user.email', 'certificate-fixture@example.invalid');
        writeFileSync(join(seed, 'proof'), 'first');
        git(seed, 'add', 'proof');
        git(seed, 'commit', '-m', 'first');
        git(seed, 'push', 'origin', 'main');
        const first = git(seed, 'rev-parse', 'HEAD');
        git(dir, 'clone', origin, checkout);
        writeFileSync(join(seed, 'proof'), 'second');
        git(seed, 'add', 'proof');
        git(seed, 'commit', '-m', 'second');
        const second = git(seed, 'rev-parse', 'HEAD');
        if (kind !== 'foreign') git(seed, 'push', 'origin', 'main');
        const expected = kind === 'rollback' ? second : first;
        const actual = kind === 'rollback' ? first : second;
        if (kind === 'rollback') git(checkout, 'fetch', 'origin', 'main');
        if (kind === 'forward')
          expect(
            spawnSync('git', ['cat-file', '-e', `${actual}^{commit}`], {
              cwd: checkout,
              env: gitEnv,
            }).status
          ).not.toBe(0);
        writeFileSync(summary, '');
        writeFileSync(output, '');
        const body = step(workflow, 'Classify the release window this certificate covers')
          .split('\n        run: |\n')[1]
          .replace(/^ {10}/gm, '');
        const result = spawnSync(
          'bash',
          [
            '--noprofile',
            '--norc',
            '-e',
            '-o',
            'pipefail',
            '-c',
            `
curl() { printf '%s' '{"ca_sha":"${actual}"}'; }
node() { command "$NODE_BIN" "$PROVENANCE_CLI" "$2" "$3"; }
timeout() { shift; "$@"; }
git() { [ "$FETCH_REFUSED" != true ] || return 1; command git "$@"; }
${body}`,
          ],
          {
            cwd: checkout,
            encoding: 'utf8',
            timeout: 5000,
            env: {
              ...gitEnv,
              NODE_BIN: process.execPath,
              PROVENANCE_CLI: join(ROOT, 'scripts/ci/production-e2e-provenance.mjs'),
              EXPECTED_LIVE_SHA: expected,
              GITHUB_STEP_SUMMARY: summary,
              GITHUB_OUTPUT: output,
              RUNTIME_RESUMED: 'true',
              LIVE_COVERAGE_COMPLETE: 'true',
              FETCH_REFUSED: String(kind === 'fetch-refused'),
            },
          }
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(
          ['forward', 'fetch-refused'].includes(kind) ? 0 : 1
        );
        expect(readFileSync(output, 'utf8')).not.toContain('certified=true');
        if (kind === 'forward')
          expect(readFileSync(summary, 'utf8')).toContain('production advanced');
        if (kind === 'fetch-refused')
          expect(readFileSync(summary, 'utf8')).toContain('protected-main history was unreadable');
        if (kind === 'foreign')
          expect(
            spawnSync('git', ['cat-file', '-e', `${actual}^{commit}`], {
              cwd: checkout,
              env: gitEnv,
            }).status
          ).not.toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

describe.each([
  { lane: 'client', workflow: WORKFLOW },
  { lane: 'live-table', workflow: TABLE_WORKFLOW },
])('$lane release-window status under Actions bash -e', ({ workflow, lane }) => {
  it.each([
    { status: 0, complete: 'true' },
    { status: 0, complete: 'false' },
    { status: 0, complete: '' },
    { status: 3, complete: 'true' },
    { status: 1, complete: 'true' },
  ])(
    'handles classifier $status and coverage $complete without losing its verdict',
    ({ status, complete }) => {
      const proof = step(workflow, 'Classify the release window this certificate covers');
      const body = proof.split('\n        run: |\n')[1];
      expect(body).toBeDefined();
      const script = body.replace(/^ {10}/gm, '');
      const dir = mkdtempSync(join(tmpdir(), 'e2e-release-window-'));
      const summary = join(dir, 'summary.md');
      const output = join(dir, 'output.txt');
      writeFileSync(summary, '');
      writeFileSync(output, '');
      try {
        // Execute the maintained shell block, including its pipeline, with the
        // runner's errexit setting. Only external I/O is controlled here; the
        // provenance parser's lineage decisions have their own direct tests.
        const result = spawnSync(
          'bash',
          [
            '--noprofile',
            '--norc',
            '-e',
            '-o',
            'pipefail',
            '-c',
            `curl() { printf '%s' '{"ca_sha":"${'a'.repeat(40)}"}'; }
timeout() { shift; "$@"; }
git() { [ "$*" = 'fetch --no-tags origin main' ]; }
node() {
  cat >/dev/null
  [ "$1" = scripts/ci/production-e2e-provenance.mjs ] || return 99
  [ "$2" = release-window ] || return 99
  printf '%s\\n' "$CLASSIFIER_OUTPUT"
  return "$CLASSIFIER_STATUS"
}
${script}`,
          ],
          {
            cwd: ROOT,
            encoding: 'utf8',
            timeout: 5_000,
            env: {
              ...process.env,
              EXPECTED_LIVE_SHA: 'a'.repeat(40),
              GITHUB_STEP_SUMMARY: summary,
              GITHUB_OUTPUT: output,
              RUNTIME_RESUMED: 'true',
              LIVE_COVERAGE_COMPLETE: complete,
              CLASSIFIER_STATUS: String(status),
              CLASSIFIER_OUTPUT: status === 3 ? `superseded ${'b'.repeat(40)}` : 'certified',
            },
          }
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(status === 1 ? 1 : 0);
        const report = readFileSync(summary, 'utf8');
        const outputs = readFileSync(output, 'utf8');
        if (status === 0) {
          expect(report).toContain('Production stayed on');
          if (lane === 'live-table' && complete !== 'true') {
            expect(report).toContain('NON-VERDICT');
            expect(outputs).not.toContain('certified=true');
          } else {
            expect(report).not.toContain('NON-VERDICT');
            expect(outputs).toContain('certified=true');
          }
        } else if (status === 3) {
          expect(result.stdout).toContain('::warning::UNKNOWN: production advanced');
          expect(report).toContain(`superseded ${'b'.repeat(40)}`);
          expect(report).toContain('NON-VERDICT');
          expect(report).not.toContain('Production stayed on');
          expect(outputs).not.toContain('certified=true');
        } else {
          expect(result.stdout).toContain('::error::production left');
          expect(report).not.toContain('Production stayed on');
          expect(report).not.toContain('NON-VERDICT');
          expect(outputs).not.toContain('certified=true');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

describe.each([
  { lane: 'client', workflow: WORKFLOW },
  { lane: 'live-table', workflow: TABLE_WORKFLOW },
])('$lane release window fetches a release published after checkout', ({ workflow }) => {
  // Run 37559264622: all three Phase 1 journeys passed on 68fdeb670c, and the
  // run was still red because production had moved to f681634a08, a later
  // commit on main that this job's checkout had never seen, so the classifier
  // answered "does not resolve to a trusted repository commit". The step must
  // refresh protected main before it classifies.
  const run = (fetchStatus: number) => {
    const proof = step(workflow, 'Classify the release window this certificate covers');
    const script = proof.split('\n        run: |\n')[1].replace(/^ {10}/gm, '');
    const dir = mkdtempSync(join(tmpdir(), 'e2e-release-fetch-'));
    const calls = join(dir, 'calls.txt');
    const summary = join(dir, 'summary.md');
    const output = join(dir, 'output.txt');
    writeFileSync(calls, '');
    writeFileSync(summary, '');
    writeFileSync(output, '');
    try {
      const result = spawnSync(
        'bash',
        [
          '--noprofile',
          '--norc',
          '-e',
          '-o',
          'pipefail',
          '-c',
          `curl() { printf '%s' '{"ca_sha":"${'b'.repeat(40)}","built_by":"publish-club-arena.yml"}'; }
timeout() { shift; "$@"; }
git() {
  printf 'git %s\\n' "$*" >> "$CALLS"
  case "$1" in
    cat-file) return 1 ;;
    fetch) return "$FETCH_STATUS" ;;
  esac
  return 99
}
node() {
  cat >/dev/null
  printf 'node %s\\n' "$2" >> "$CALLS"
  printf '%s\\n' "superseded ${'b'.repeat(40)}"
  return 3
}
${script}`,
        ],
        {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 5_000,
          env: {
            ...process.env,
            CALLS: calls,
            FETCH_STATUS: String(fetchStatus),
            EXPECTED_LIVE_SHA: 'a'.repeat(40),
            GITHUB_STEP_SUMMARY: summary,
            GITHUB_OUTPUT: output,
            RUNTIME_RESUMED: 'true',
            LIVE_COVERAGE_COMPLETE: 'true',
          },
        }
      );
      return { result, calls: readFileSync(calls, 'utf8').trim().split('\n') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('fetches the closing SHA from origin before the classifier reads it', () => {
    const { result, calls } = run(0);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(calls).toEqual(['git fetch --no-tags origin main', 'node release-window']);
    expect(result.stdout).toContain('::warning::UNKNOWN: production advanced');
  });

  it('refuses certification without asking the classifier when protected history is unreadable', () => {
    const { result, calls } = run(1);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning::UNKNOWN: protected-main history was unreadable');
    expect(calls).toEqual(['git fetch --no-tags origin main']);
  });
});

describe('the checker refuses a run that verified nothing', () => {
  it('fails when every test in a spec file skipped', () => {
    expect(check([spec('tests/e2e/a.spec.ts', [null, null])])).toBe(1);
  });

  it('passes when the file executed at least one test', () => {
    expect(check([spec('tests/e2e/a.spec.ts', ['passed', null])])).toBe(0);
  });

  it('still fails when only ONE of several files went silent', () => {
    // The failure mode a pass-rate percentage hides: eleven healthy files can
    // carry an entire money surface that verified nothing.
    expect(
      check([
        spec('tests/e2e/a.spec.ts', ['passed']),
        spec('tests/e2e/production-cashier.spec.ts', [null, null]),
      ])
    ).toBe(1);
  });

  it('treats a MISSING report as "it did not run", never as "nothing to check"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-honesty-'));
    let code = 0;
    try {
      execFileSync(process.execPath, [CHECKER, join(dir, 'never-written.json')], { stdio: 'pipe' });
    } catch (err) {
      code = (err as { status?: number }).status ?? -1;
    }
    expect(code).toBe(1);
  });

  it('fails an empty report rather than calling zero specs a success', () => {
    expect(check([{ suites: [] }])).toBe(1);
  });

  it('counts a failed test as executed - a red run is honest, just red', () => {
    expect(check([spec('tests/e2e/a.spec.ts', ['failed'])])).toBe(0);
  });

  it('rejects a stated notRunReason even alongside a real report', () => {
    // The workflow writes this when it decides not to invoke Playwright for a
    // path at all, because the file does not exist at the deployed commit.
    expect(
      check([
        { notRunReason: 'absent at the deployed commit' },
        spec('tests/e2e/a.spec.ts', ['passed']),
      ])
    ).toBe(1);
  });

  it('refuses a run in which EVERY invocation was declined', () => {
    // Reasons are not a verdict. If nothing was invoked, nothing was verified.
    expect(check([{ notRunReason: 'absent' }, { notRunReason: 'absent' }])).toBe(1);
  });
});

describe('the allowlist is a ratchet, not an escape hatch', () => {
  const allowlist = JSON.parse(
    readFileSync(join(ROOT, 'scripts/ci/e2e-may-skip-entirely.json'), 'utf8')
  ) as { allowed: { file: string; reason: string }[] };

  it('every exemption carries a reason that says what is missing', () => {
    for (const entry of allowlist.allowed) {
      expect(entry.file, 'an exemption without a file').toBeTruthy();
      expect(
        (entry.reason ?? '').length,
        `${entry.file} is exempt with no reason - say WHAT is missing`
      ).toBeGreaterThan(20);
    }
  });

  it('spells paths the way the JSON report does, or the exemption is a no-op', () => {
    // Playwright reports `file` relative to testDir. An entry written from the
    // repo root matches nothing, exempts nothing, and looks exactly like an
    // exemption that works - the quietest possible way for this ratchet to
    // stop holding. Verified against a real report, not assumed.
    for (const entry of allowlist.allowed) {
      expect(entry.file, `${entry.file} must be relative to tests/e2e`).not.toMatch(/^tests\//);
      expect(entry.file).toMatch(/\.spec\.ts$/);
    }
  });

  it('holds the number of specs allowed to verify nothing at or below its ceiling', () => {
    // Lower this when a spec is made to run. Never raise it to make a run green.
    expect(allowlist.allowed.length).toBeLessThanOrEqual(6);
  });
});

describe('the workflow cannot go back to reporting success dishonestly', () => {
  it('runs the honesty check, and runs it even when the suite went red', () => {
    expect(WORKFLOW).toContain('assert-e2e-actually-ran.mjs');
    expect(step(WORKFLOW, 'Did the suite actually verify production?')).toContain('if: always()');
  });

  it('preserves the production report when GitHub cancels at the job timeout', () => {
    const upload = step(WORKFLOW, 'Upload the report when something is wrong on production');
    expect(upload).toContain('if: always()');
    expect(upload).toContain('failure() || cancelled()');
  });

  // 2026-09-30: this used to require the closing read to be
  // `production-e2e-provenance.mjs unchanged`, which made an ordinary forward
  // publish mid-suite indistinguishable from a rollback. Twelve of twenty
  // sampled runs died on it with nothing wrong on the live site. The closing
  // read now CLASSIFIES the window; what must not come back is a run that
  // certifies without asking, or one that retries until the answer suits it.
  it('classifies the release window it covered, and never assumes one', () => {
    const cleanupAt = WORKFLOW.indexOf('- name: Hard-delete the isolated production E2E account');
    const proofAt = WORKFLOW.indexOf('- name: Classify the release window this certificate covers');
    const uploadAt = WORKFLOW.indexOf(
      '- name: Upload the report when something is wrong on production'
    );
    const proof = step(WORKFLOW, 'Classify the release window this certificate covers');

    expect(cleanupAt).toBeGreaterThan(-1);
    expect(proofAt).toBeGreaterThan(cleanupAt);
    expect(uploadAt).toBeGreaterThan(proofAt);
    expect(proof).toContain("if: always() && steps.live.outputs.ready == 'true'");
    expect(proof).toContain('EXPECTED_LIVE_SHA: ${{ steps.live.outputs.sha }}');
    expect(proof).toContain('production-e2e-provenance.mjs release-window "$EXPECTED_LIVE_SHA"');
    // A rollback or an off-lineage SHA is still a hard red, and an unreadable
    // or superseded window is still SAID OUT LOUD rather than passed silently.
    expect(proof).toContain('::error::production left');
    expect(proof).toContain('NON-VERDICT');
    expect(proof).toContain('::warning::UNKNOWN');
    expect(proof).not.toContain('for i in');
    expect(proof).not.toContain('sleep ');
  });

  // The publisher's own post-swap proof keeps the strict comparison. Merging
  // the two questions is how a forty-minute browser window would have argued
  // its way into the one place a single exact SHA really is required.
  it('leaves `unchanged` to the publisher and never reuses it for the browser window', () => {
    expect(WORKFLOW).not.toContain('production-e2e-provenance.mjs unchanged');
  });

  it('emits the JSON the honesty check reads, from every playwright invocation', () => {
    for (const report of [
      'cashier.json',
      'stats.json',
      'live-table-realtime.json',
      'club-members.json',
      'daily-missions.json',
      'daily-missions-accessibility.json',
      'daily-missions-settlement.json',
      'sweep.json',
    ]) {
      expect(WORKFLOW, `no PLAYWRIGHT_JSON_OUTPUT_NAME for ${report}`).toContain(
        `e2e-report/${report}`
      );
    }
    expect(WORKFLOW).toContain('--reporter=line,json');
    expect(WORKFLOW).toContain('--output="test-results/$output_dir"');
    expect(WORKFLOW, 'a line-only reporter leaves the honesty check nothing to read').not.toMatch(
      /--reporter=line\s+--retries/
    );
  });

  it('refuses a green verdict when the Daily Missions accessibility suite only skipped', () => {
    const honesty = step(WORKFLOW, 'Did the suite actually verify production?');
    expect(honesty).toContain('e2e-report/daily-missions-accessibility.json');

    const sweep = step(WORKFLOW, 'Run the specs that need a deployed page');
    expect(sweep).toContain('daily missions accessibility exit=$daily_missions_accessibility_rc');
  });

  it('runs live-table continuity as real mobile WebKit with exact engine provenance', () => {
    const sweep = step(
      TABLE_WORKFLOW,
      'Certify live-table continuity against the exact serving engine'
    );
    const honesty = step(TABLE_WORKFLOW, 'Did the live-table certificate actually execute?');
    const engine = step(TABLE_WORKFLOW, 'Resolve the exact protected-main engine component');

    expect(sweep).toContain('tests/e2e/production-live-table-realtime.spec.ts');
    expect(sweep).toContain('--project=webkit-live-table-realtime');
    expect(sweep).toContain("LIVE_TABLE_REALTIME_CERTIFICATION: '1'");
    expect(sweep).toContain('EXPECTED_ENGINE_SHA: ${{ steps.engine.outputs.sha }}');
    expect(honesty).toContain('e2e-report/live-table-realtime.json');
    // The engine is deliberately read through its own announced :55 restart
    // (CLAUDE.md section 13). Run 36717851302 died at 12:55:36Z on a bare
    // `curl: (22) ... 502` from an engine that was doing exactly what it was
    // told. The reader waits; the parser it waits for is unchanged.
    expect(engine).toContain('scripts/ci/read-engine-release.mjs');
    expect(engine).not.toContain('curl -fsS --max-time 20');
    expect(ENGINE_READER).toContain('readReadyEngineSha');
    expect(ENGINE_READER).toContain('GAMEPLAY_WAIT_MS');
    expect(engine).not.toContain('git log "$MAIN_SHA"');
    expect(engine).toContain('ENGINE_SHA="$ENGINE_TRIGGER_SHA"');
    expect(engine).toContain('git cat-file -e "$ENGINE_SHA^{commit}"');
    expect(engine).toContain('git merge-base --is-ancestor "$ENGINE_SHA" "$MAIN_SHA"');
    expect(LIVE_TABLE).toContain('releaseSha: string | null;');
    expect(LIVE_TABLE).toContain('observedReleaseSha');
    expect(LIVE_TABLE).toContain('toMatch(/^[0-9a-f]{40}$/)');
    expect(LIVE_TABLE).toContain('toBe(EXPECTED_ENGINE_SHA)');
    expect(LIVE_TABLE).not.toContain('engineVersionMatchesExpected');
    expect(LIVE_TABLE).not.toContain('EXPECTED_ENGINE_SHA.startsWith');
  });

  it('accepts an engine certification trigger only with one exact protected-main SHA', () => {
    const gate = step(WORKFLOW, 'Read The Origin Job Verdict');
    expect(WORKFLOW).toContain(
      'run-name: Post-Deploy E2E ${{ github.event.client_payload.engine_sha || github.sha }}'
    );
    expect(gate).toContain('if [ "$EVENT_NAME" = repository_dispatch ]');
    expect(gate).toMatch(/\[\[ "\$ENGINE_TRIGGER_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
    expect(gate).toContain('engine_trigger_sha=$ENGINE_TRIGGER_SHA');
  });

  it('refuses a green verdict when the Daily Missions database settlement suite only skipped', () => {
    const honesty = step(WORKFLOW, 'Did the suite actually verify production?');
    expect(honesty).toContain('e2e-report/daily-missions-settlement.json');

    const sweep = step(WORKFLOW, 'Run the specs that need a deployed page');
    expect(sweep).toContain('tests/e2e/daily-missions-database-settlement.spec.ts');
    expect(sweep).toContain('daily missions settlement exit=$daily_missions_settlement_rc');
  });

  it('demands a real session, so a signed-out fallback cannot pass as a verdict', () => {
    expect(WORKFLOW).toContain("E2E_REQUIRE_AUTH: '1'");
    expect(GLOBAL_SETUP).toContain("process.env.E2E_REQUIRE_AUTH === '1'");
    expect(
      GLOBAL_SETUP.slice(
        GLOBAL_SETUP.indexOf('function signedOut'),
        GLOBAL_SETUP.indexOf('export default')
      ),
      'signedOut() must THROW under E2E_REQUIRE_AUTH, not merely log'
    ).toMatch(/E2E_REQUIRE_AUTH === '1'[\s\S]{0,200}throw new Error/);
  });

  it('does not let the spec swap silently restore the signed-out fallback', () => {
    // Taking tests/e2e wholesale from the deployed commit would also take
    // global-setup.ts back to before E2E_REQUIRE_AUTH existed - disabling the
    // fix on precisely the runs it was written for.
    const align = step(WORKFLOW, 'Take the specs from the commit production is actually serving');
    expect(align).toContain('tests/e2e/global-setup.ts');
    expect(align).toContain('tests/e2e/support');
    const tableAlign = step(
      TABLE_WORKFLOW,
      'Take the specs from the commit production is actually serving'
    );
    expect(tableAlign).toContain('tests/e2e/global-setup.ts');
    expect(tableAlign).toContain('tests/e2e/production-live-table-realtime.spec.ts');
    expect(tableAlign).toContain('tests/e2e/support');
  });

  it('annotates the run when a supplied credential silently did not work', () => {
    // ci.yml's scheduled Live Production E2E tolerates MISSING secrets on
    // purpose. It must not tolerate a BROKEN one in silence: that is 47 route
    // specs skipping inside a green job.
    const fn = GLOBAL_SETUP.slice(
      GLOBAL_SETUP.indexOf('function signedOut'),
      GLOBAL_SETUP.indexOf('export default')
    );
    expect(fn).toContain('process.env.SP_EMAIL && process.env.SP_PASS');
    expect(fn).toContain('::error title=');
  });

  it('never lets one red step hide the rest of the production sweep', () => {
    const sweep = step(WORKFLOW, 'Run the specs that need a deployed page');
    expect(sweep, 'a failed Cashier step used to skip this one entirely').toContain(
      "if: always() && steps.live.outputs.ready == 'true'"
    );
    expect(
      sweep,
      'without set +e a red Stats invocation aborts the route invocation behind it'
    ).toContain('set +e');
    expect(sweep).toContain('sweep_rc=$?');
  });

  it('keeps the specs and the deployed bundle on the same commit', () => {
    // Runs 33394046555 and 33394398578 failed on an element that existed on
    // main and was simply not deployed yet. Nothing was broken.
    expect(WORKFLOW).toContain('Take the specs from the commit production is actually serving');
    expect(WORKFLOW).toContain('production-e2e-provenance.mjs lineage "$LIVE" "$HERE"');
    expect(WORKFLOW).not.toContain('::warning::deployed sha');
    expect(WORKFLOW, 'the ancestor check needs history the shallow clone lacks').toContain(
      'fetch-depth: 0'
    );
  });
});

describe('all required live-table subjects must pass before certification', () => {
  const titles = [
    ...['MTT', 'SPIN', 'SNG'].map(
      (format) => `an already-running ${format} table stays realtime and recovers one owner`
    ),
    'an already-running table stays live and recovers one owner after a network loss',
  ];
  function report() {
    return {
      errors: [],
      suites: [
        {
          suites: [
            {
              specs: titles.map((title) => ({
                title,
                file: 'production-live-table-realtime.spec.ts',
                ok: true,
                tests: [
                  {
                    projectName: 'webkit-live-table-realtime',
                    expectedStatus: 'passed',
                    status: 'expected',
                    results: [{ status: 'passed' }],
                  },
                ],
              })),
            },
          ],
        },
      ],
    };
  }
  function inspect(value: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'live-coverage-'));
    try {
      const input = join(dir, 'report.json');
      const output = join(dir, 'output.txt');
      if (value !== undefined)
        writeFileSync(input, typeof value === 'string' ? value : JSON.stringify(value));
      const result = spawnSync(
        process.execPath,
        [join(ROOT, 'scripts/ci/live-table-certificate-coverage.mjs'), input],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
          },
        }
      );
      expect(result.status).toBe(0);
      const complete = readFileSync(output, 'utf8').trim() === 'complete=true';
      expect(result.stdout).toContain(complete ? 'All four required' : 'NON-VERDICT');
      return complete;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  it('accepts all four named successful WebKit cases', () => {
    expect(inspect(report())).toBe(true);
  });
  it.each(['skipped', 'failed', 'timedOut', 'interrupted'])(
    'refuses a required %s case beside three passes',
    (status) => {
      const value = report();
      value.suites[0].suites[0].specs[0].tests[0].results[0].status = status;
      expect(inspect(value)).toBe(false);
    }
  );
  it.each(['missing', 'duplicate', 'wrong project', 'expected failure', 'flaky', 'renamed'])(
    'refuses %s coverage',
    (reason) => {
      const value = report();
      const specs = value.suites[0].suites[0].specs;
      if (reason === 'missing') specs.shift();
      if (reason === 'duplicate') specs.push(structuredClone(specs[0]));
      if (reason === 'wrong project') specs[0].tests[0].projectName = 'chromium';
      if (reason === 'expected failure') specs[0].tests[0].expectedStatus = 'failed';
      if (reason === 'flaky') specs[0].tests[0].results.unshift({ status: 'failed' });
      if (reason === 'renamed') specs[0].title = 'unrelated fourth test';
      expect(inspect(value)).toBe(false);
    }
  );
  it.each([undefined, '{', {}, { errors: [], suites: [] }])(
    'refuses absent or unreadable report %#',
    (value) => {
      expect(inspect(value)).toBe(false);
    }
  );
  it('does not accept a report-level error or explicit not-run reason', () => {
    expect(inspect({ ...report(), errors: [{ message: 'runner failed' }] })).toBe(false);
    expect(inspect({ ...report(), notRunReason: 'not invoked' })).toBe(false);
  });
  it('wires complete coverage into certification and retains partial evidence', () => {
    const gate = step(TABLE_WORKFLOW, 'Did all required live-table cases pass?');
    expect(gate).toContain('id: live_coverage');
    expect(gate).toContain('if: always()');
    expect(gate).toContain(
      'node scripts/ci/live-table-certificate-coverage.mjs e2e-report/live-table-realtime.json'
    );
    const release = step(TABLE_WORKFLOW, 'Classify the release window this certificate covers');
    expect(release).toContain(
      'LIVE_COVERAGE_COMPLETE: ${{ steps.live_coverage.outputs.complete }}'
    );
    expect(
      step(TABLE_WORKFLOW, 'Upload the report when something is wrong on production')
    ).toContain("steps.live_coverage.outputs.complete != 'true'");
    expect(LIVE_TABLE).toContain("const TOURNAMENT_FORMATS = ['mtt', 'spin', 'sng'] as const");
    expect(LIVE_TABLE).toContain(titles[3]);
  });
});
