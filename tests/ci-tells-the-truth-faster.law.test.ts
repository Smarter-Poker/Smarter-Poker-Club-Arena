/**
 * CI TELLS THE TRUTH, FASTER (2026-09-26).
 *
 * Measured on PR #5242 and PR #5260, and pinned here so none of it drifts back:
 *
 * 1. Two pushes of one commit in the same second (push ids 44577774264 and
 *    44577774629) opened two `CI - Build & Type Safety` runs for head
 *    6a4c6fdc17. With `cancel-in-progress: true` the newer cancelled the older;
 *    the cancelled run's fail-open jobs still ran the whole heavy matrix, its
 *    fixture gate called a cancellation a compilation failure, and the
 *    surviving run waited 25 minutes behind it. A duplicate now queues, and a
 *    cancelled upstream is reported as NO VERDICT, never as a failure and never
 *    as green.
 * 2. `Accounting transactions (PostgreSQL 17)` was 29.5 minutes of serial
 *    suites (job 108270970154), the critical path of every server-touching
 *    pull request. It is four shards now; every suite step belongs to exactly
 *    one shard and the required aggregate still needs all of them.
 * 3. The Diamond playfield suite on software WebGL gets one retry, and a
 *    retried pass is named as FLAKY in the job, never folded into "passed".
 * 4. The Diamond games visual baseline is informational (never in the
 *    ruleset) and fails loudly when its harness produces nothing.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  FixtureGateNoVerdict,
  NO_VERDICT_EXIT_CODE,
  requireFixtureNativeResult,
} from '../scripts/ci/fixture-native-gate.mjs';
import { summarize } from '../scripts/ci/playwright-flaky-summary.mjs';
import { GAMES, judgeGame } from '../scripts/ci/diamond-visual-baseline.mjs';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
type Step = {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
const ci = parse(read('.github/workflows/ci.yml'));

describe('a duplicate run for the same commit is not a verdict', () => {
  it('queues a duplicate instead of cancelling the run already in progress', () => {
    expect(ci.concurrency.group).toContain('github.event.pull_request.head.sha');
    expect(ci.concurrency.group).toContain('github.event.pull_request.number');
    expect(ci.concurrency['cancel-in-progress']).toBe(false);
  });

  const verified = {
    eventName: 'pull_request',
    compileResult: 'success',
    diffResult: 'success',
    fixtureChanged: 'true',
    nativeResult: 'success',
    nativeVerified: 'true',
    sourceSha: 'a'.repeat(40),
    nativeSourceSha: 'a'.repeat(40),
  };

  it('names a cancelled compilation or native job as no verdict, and never passes it', () => {
    for (const change of [
      { compileResult: 'cancelled' },
      { nativeResult: 'cancelled' },
      { compileResult: 'cancelled', nativeResult: 'cancelled' },
      { compileResult: 'cancelled', nativeResult: 'skipped', fixtureChanged: 'false' },
    ]) {
      expect(() => requireFixtureNativeResult({ ...verified, ...change })).toThrow(
        FixtureGateNoVerdict
      );
    }
  });

  it('reports a real failure as the failure, however much was cancelled beside it', () => {
    for (const change of [
      { compileResult: 'failure', nativeResult: 'cancelled' },
      { compileResult: 'cancelled', nativeResult: 'failure' },
      { compileResult: 'timed_out', nativeResult: 'cancelled' },
    ]) {
      let thrown: unknown;
      try {
        requireFixtureNativeResult({ ...verified, ...change });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(FixtureGateNoVerdict);
    }
  });

  it('exits 3 for no verdict, 1 for a failure and 0 only for a real pass', () => {
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, ['scripts/ci/fixture-native-gate.mjs'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          CI_EVENT_NAME: 'pull_request',
          COMPILE_RESULT: 'success',
          DIFF_RESULT: 'success',
          FIXTURE_CHANGED: 'false',
          NATIVE_RESULT: 'skipped',
          SOURCE_SHA: 'a'.repeat(40),
          ...env,
        },
      });
    expect(run({}).status).toBe(0);
    const cancelled = run({ COMPILE_RESULT: 'cancelled' });
    expect(NO_VERDICT_EXIT_CODE).toBe(3);
    expect(cancelled.status).toBe(3);
    expect(cancelled.stdout).toContain('NO VERDICT (CANCELLED)');
    expect(run({ COMPILE_RESULT: 'failure' }).status).toBe(1);
  });

  it('keeps the gate behind the required TypeScript Check on always()', () => {
    expect(ci.jobs.typecheck.name).toBe('TypeScript Check');
    expect(ci.jobs.typecheck.if).toMatch(/^always\(\)/);
    expect(ci.jobs.typecheck.steps.at(-1).run).toBe('node scripts/ci/fixture-native-gate.mjs');
  });
});

describe('the PostgreSQL accounting qualification runs as four shards of one job', () => {
  const job = ci.jobs.accounting_postgres;
  const steps: Step[] = job.steps;
  const SETUP = new Set([
    'Checkout',
    'Setup Node 22',
    'Install server test dependencies',
    'Install PostgreSQL 17 tools without a default database service',
  ]);
  const shardsOf = (step: Step) =>
    [...String(step.if ?? '').matchAll(/matrix\.shard == (\d)/g)].map((m) => Number(m[1]));

  it('is a four-way matrix that lets every shard finish', () => {
    expect(job.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2, 3, 4] } });
    expect(job.name).toBe('Accounting transactions (PostgreSQL 17) shard ${{ matrix.shard }}/4');
    expect(job['timeout-minutes']).toBe(40);
  });

  it('gives every suite step exactly one shard, and every shard some suites', () => {
    const perShard = new Map<number, number>();
    for (const step of steps) {
      if (SETUP.has(step.name ?? '')) {
        expect(step.if, `${step.name} is setup and runs in every shard`).toBeUndefined();
        continue;
      }
      const shards = shardsOf(step);
      if (/isolation (test )?tool/i.test(step.name ?? '')) {
        expect(shards, step.name).toEqual([3, 4]);
        continue;
      }
      expect(shards, `${step.name} must name exactly one shard`).toHaveLength(1);
      perShard.set(shards[0], (perShard.get(shards[0]) ?? 0) + 1);
    }
    expect([...perShard.keys()].sort()).toEqual([1, 2, 3, 4]);
  });

  it('builds the isolation tester in every shard whose suites use it', () => {
    const build = steps.find(
      (s) => s.name === 'Build the matching native PostgreSQL isolation test tool'
    );
    expect(shardsOf(build!)).toEqual([3, 4]);
    for (const step of steps) {
      const usesTester =
        JSON.stringify(step.env ?? {}).includes('isolationtester') ||
        /isolationtester/.test(step.run ?? '');
      if (usesTester) expect([3, 4], `${step.name}`).toContain(shardsOf(step)[0]);
    }
    const evidence = steps.find(
      (s) => s.name === 'Retain PostgreSQL isolation tool build evidence'
    );
    expect(String(evidence!.with!.name)).toContain('${{ matrix.shard }}');
  });

  it('runs BBJ in shard 1, whose rendered name is the job BBJ binds its deadline to', () => {
    for (const name of [
      'Bind BBJ qualification to the actual accounting job deadline',
      'BBJ bank replay identity and drift-safe installation',
    ]) {
      expect(shardsOf(steps.find((s) => s.name === name)!)).toEqual([1]);
    }
    const probe = read('scripts/ci/probes/bbj-bank-replay/funded/current_ci.py');
    const constant = /^ACCOUNTING_JOB_NAME = '([^']+)'$/m.exec(probe)?.[1];
    expect(constant).toBe(job.name.replace('${{ matrix.shard }}', '1'));
  });

  it('still feeds the required Server Engine aggregate, which needs every shard', () => {
    expect(ci.jobs.server.name).toBe('Server Engine (typecheck + tests)');
    expect(ci.jobs.server.needs).toContain('accounting_postgres');
    expect(ci.jobs.server.steps[0].env.ACCOUNTING_RESULT).toBe(
      '${{ needs.accounting_postgres.result }}'
    );
  });
});

describe('a retried Diamond playfield pass is named, never hidden', () => {
  const beats: Step[] = ci.jobs['css-beats-e2e'].steps;
  const suite = beats.find((s) => s.name === "Run the beats against this commit's CSS")!;
  const line = suite.run!.split('\n').find((l) => l.includes('diamond-games-playfield.spec.ts'))!;

  it('gives the software-WebGL suite one retry and a JSON report', () => {
    expect(line).toContain('--retries=1');
    expect(line).toContain('--reporter=line,json');
    expect(line).toContain(
      'PLAYWRIGHT_JSON_OUTPUT_NAME="$RUNNER_TEMP/diamond-playfield-report.json"'
    );
  });

  it('reads that report right after the suites, whether they passed or failed', () => {
    const index = beats.indexOf(suite);
    const reader = beats[index + 1];
    expect(reader.run).toBe('node scripts/ci/playwright-flaky-summary.mjs');
    expect(reader.if).toContain('always()');
    expect(reader.env!.PLAYFIELD_REPORT).toBe('${{ runner.temp }}/diamond-playfield-report.json');
  });

  it('names a retried pass in the other CSS Beat suites too', () => {
    const first = suite.run!.split('\n').find((l) => l.includes('tests/e2e/multi-table.spec.ts'))!;
    expect(first).toContain('--retries=1');
    expect(first).toContain('--reporter=line,json');
    expect(first).toContain('PLAYWRIGHT_JSON_OUTPUT_NAME="$RUNNER_TEMP/css-beats-report.json"');
    const reader = beats[beats.indexOf(suite) + 2];
    expect(reader.run).toBe('node scripts/ci/playwright-flaky-summary.mjs');
    expect(reader.if).toContain('always()');
    expect(reader.env!.PLAYFIELD_REPORT).toBe('${{ runner.temp }}/css-beats-report.json');
    expect(reader.env!.SUITE_LABEL).toBeTruthy();
  });

  const report = {
    suites: [
      {
        title: 'css/diamond-games-playfield.spec.ts',
        file: 'css/diamond-games-playfield.spec.ts',
        specs: [
          {
            title: 'crash flies',
            file: 'css/diamond-games-playfield.spec.ts',
            line: 12,
            tests: [{ projectName: 'chromium', status: 'flaky', results: [{}, {}] }],
          },
          {
            title: 'plinko drops',
            file: 'css/diamond-games-playfield.spec.ts',
            line: 40,
            tests: [{ projectName: 'chromium', status: 'expected', results: [{}] }],
          },
        ],
      },
    ],
  };

  it('turns a flaky case into a warning annotation and a summary line', () => {
    const result = summarize(report, 'Diamond playfield');
    expect(result.flaky).toHaveLength(1);
    expect(result.annotations[0]).toMatch(/^::warning title=FLAKY \(passed only on retry\)::/);
    expect(result.annotations[0]).toContain('crash flies');
    expect(result.summary).toContain('| 1 | 1 | 0 | 0 |');
  });

  it('fails loudly when the suites claim success and leave no report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flaky-summary-'));
    try {
      const run = (env: Record<string, string>) =>
        spawnSync(process.execPath, ['scripts/ci/playwright-flaky-summary.mjs'], {
          cwd: root,
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '', ...env },
        });
      const missing = join(dir, 'missing.json');
      expect(run({ PLAYFIELD_REPORT: missing, SUITE_OUTCOME: 'success' }).status).toBe(1);
      expect(run({ PLAYFIELD_REPORT: missing, SUITE_OUTCOME: 'failure' }).status).toBe(0);
      const present = join(dir, 'report.json');
      writeFileSync(present, JSON.stringify(report));
      const ok = run({ PLAYFIELD_REPORT: present, SUITE_OUTCOME: 'success' });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('FLAKY (passed only on retry)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the Diamond games visual baseline informs and never gates', () => {
  const workflow = parse(read('.github/workflows/diamond-visual-baseline.yml'));

  it('runs on the Diamond scene directories and the harness itself', () => {
    const paths: string[] = workflow.on.pull_request.paths;
    for (const path of [
      'src/components/crash/**',
      'src/components/plinko/**',
      'src/components/games/**',
      'src/components/wheel/**',
      'src/pages/Diamond*',
      'scripts/dev/diamond-test-shots.mjs',
    ]) {
      expect(paths).toContain(path);
    }
    expect(workflow.on.schedule).toBeUndefined();
  });

  it('is never a required check', () => {
    const ruleset = read('scripts/ci/apply-main-ruleset.mjs');
    expect(ruleset).not.toContain(workflow.jobs.shots.name);
    expect(ruleset).not.toContain(workflow.name);
    expect(workflow.jobs.shots['continue-on-error']).toBeUndefined();
  });

  it('shoots all four games and uploads what it drew', () => {
    expect(GAMES).toEqual(['plinko', 'crash', 'crossing', 'mines']);
    const steps: Step[] = workflow.jobs.shots.steps;
    expect(
      steps.some((s) => s.run?.startsWith('node scripts/ci/diamond-visual-baseline.mjs'))
    ).toBe(true);
    const upload = steps.find((s) =>
      String((s as { uses?: string }).uses).startsWith('actions/upload-artifact')
    );
    expect(upload?.if).toContain('always()');
  });

  it('calls a harness that drew nothing a failure, not an empty pass', () => {
    expect(judgeGame('crash', [], 0).problems.length).toBeGreaterThan(0);
    expect(
      judgeGame(
        'crash',
        ['crash-393-idle.png', 'crash-393-open.png', 'crash-1280-idle.png', 'crash-1280-open.png'],
        1
      ).problems
    ).toEqual(['the harness exited 1']);
    expect(
      judgeGame(
        'crash',
        ['crash-393-idle.png', 'crash-393-open.png', 'crash-1280-idle.png', 'crash-1280-open.png'],
        0
      ).problems
    ).toEqual([]);
  });
});
