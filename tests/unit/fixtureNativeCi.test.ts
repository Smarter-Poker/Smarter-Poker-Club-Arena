import { describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import {
  classifyChangedPaths,
  classifyGitChanges,
  gitEnvironmentForCwd,
} from '../../scripts/ci/classify-ci-changes.mjs';

const root = resolve(__dirname, '../..');
const ci = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
const native = parse(
  readFileSync(join(root, '.github/workflows/component-fixture-native-smoke.yml'), 'utf8')
);

it('runs the real Diamond playfields once with an isolated software-rendering worker', () => {
  const beat = ci.jobs['css-beats-e2e'].steps.find(
    (step: { name?: string }) => step.name === "Run the beats against this commit's CSS"
  );
  const commands = beat.run.split('\n').filter((line: string) => line.includes('playwright test'));
  const playfields = commands.filter((line: string) =>
    line.includes('tests/e2e/css/diamond-games-playfield.spec.ts')
  );
  expect(playfields).toHaveLength(1);
  expect(playfields[0]).toContain('--workers=1');
  expect(playfields[0]).toContain('--retries=0');
  expect(playfields[0]).not.toContain('tests/e2e/multi-table.spec.ts');
  expect(commands.some((line: string) => line.includes('tests/e2e/multi-table.spec.ts'))).toBe(
    true
  );
});

describe('cash lobby verification reaches the existing browser gate', () => {
  it.each([
    'tests/e2e/global-setup.ts',
    'tests/e2e/live-animations.spec.ts',
    'tests/e2e/mobile-lobby-chrome.spec.ts',
    'tests/e2e/production-live-table-realtime.spec.ts',
    'tests/e2e/support/cashLobbyOverlays.ts',
    'tests/e2e/support/observationDeadline.ts',
    'tests/e2e/support/initialTableOwnership.ts',
  ])('runs browser regressions when the individual input changes: %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ src: true, tests: true, server: false });
  });

  it('does not route unrelated unit tests or similarly named notes to the browser build', () => {
    expect(classifyChangedPaths(['tests/unit/unrelated.test.ts']).src).toBe(false);
    expect(classifyChangedPaths(['tests/e2e/support/cashLobbyOverlays.ts.md']).src).toBe(false);
    expect(classifyChangedPaths(['tests/e2e/live-animations.spec.ts.md']).src).toBe(false);
  });
});

describe('build provenance changes reach the existing client verification', () => {
  it('runs Production Build, CSS Beat and client tests for the exact stamper path', () => {
    expect(classifyChangedPaths(['scripts/stamp-build-provenance.mjs'])).toEqual({
      src: true,
      server: false,
      tests: true,
      phase4: false,
      fixture: false,
    });
  });

  it.each([
    'scripts/stamp-build-provenance.mjs.md',
    'scripts/stamp-build-provenance.mjsx',
    'scripts/ci/stamp-build-provenance.mjs',
    'docs/scripts/stamp-build-provenance.mjs',
  ])('does not select client checks for a lookalike path: %s', (path) => {
    expect(classifyChangedPaths([path])).toEqual({
      src: false,
      server: false,
      tests: false,
      phase4: false,
      fixture: false,
    });
  });
});

type GitFixture = {
  directory: string;
  base: string;
  git: (...args: string[]) => string;
  write: (name: string, value?: string) => void;
  commit: () => string;
};

function withGitFixture(check: (fixture: GitFixture) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-ci-git-'));
  try {
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: directory,
        env: gitEnvironmentForCwd(),
        encoding: 'utf8',
      }).trim();
    const write = (name: string, value = 'fixture') => {
      const path = join(directory, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, value);
    };
    const commit = () => {
      git('add', '--all');
      git(
        '-c',
        'user.name=Fixture CI Test',
        '-c',
        'user.email=fixture@invalid',
        'commit',
        '-qm',
        'fixture commit'
      );
      return git('rev-parse', 'HEAD');
    };
    git('init', '-q');
    write('docs/baseline.md');
    write('operations/release/fixture/provider.mjs');
    const base = commit();
    check({ directory, git, write, commit, base });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('BBJ source changes reach their existing accounting verification', () => {
  it.each([
    'scripts/ci/test-bbj-bank-replay.py',
    'scripts/ci/probes/bbj-bank-replay/funded/source/internal-ledger-native-fixture-0006/build/10-historical-schema.sql',
  ])('runs the accounting job for the individual affected path %s', (path) => {
    expect(classifyChangedPaths([path]).server).toBe(true);
  });

  it('keeps unrelated documentation and similarly named scripts outside accounting', () => {
    for (const path of [
      'docs/bbj-notes.md',
      'scripts/ci/test-bbj-bank-replay.py.md',
      'scripts/ci/probes/bbj-bank-replay-other/fixture.sql',
    ]) {
      expect(classifyChangedPaths([path]).server).toBe(false);
    }
  });

  it('retains receipts after attempted BBJ execution without converting failures to success', () => {
    const steps = ci.jobs.accounting_postgres.steps;
    const invoke = steps.find((step: { id?: string }) => step.id === 'bbj');
    const receipt = steps.find((step: { id?: string }) => step.id === 'bbj_evidence');
    const upload = steps.find(
      (step: { name?: string }) => step.name === 'Retain BBJ accounting receipts'
    );
    expect(invoke.run).toContain('test_retain_evidence.py');
    expect(invoke.run).toContain('python3 scripts/ci/test-bbj-bank-replay.py');
    expect(invoke['continue-on-error']).toBeUndefined();
    const timing = steps.find((step: { id?: string }) => step.id === 'bbj_timing');
    expect(ci.jobs.accounting_postgres.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(timing.env.GH_TOKEN).toBe('${{ github.token }}');
    expect(invoke.env.GH_TOKEN).toBeUndefined();
    expect(invoke.env.GITHUB_TOKEN).toBeUndefined();
    expect(invoke.env.BBJ_JOB_TIMING_FILE).toBe(
      '${{ runner.temp }}/bbj-job-timing-${{ github.run_id }}-${{ github.run_attempt }}.json'
    );

    expect(receipt.if).toBe(
      "always() && (steps.bbj.outcome != 'skipped' || steps.bbj_timing.outcome == 'failure' || steps.bbj_timing.outcome == 'cancelled')"
    );
    expect(receipt.env.BBJ_STEP_OUTCOME).toBe('${{ steps.bbj.outcome }}');
    expect(upload.if).toBe("always() && steps.bbj_evidence.outputs.ready == 'true'");
    expect(upload.uses).toBe('actions/upload-artifact@v4');
    expect(upload.with.path).toBe('artifacts/bbj-bank-replay/');
    expect(upload.with['if-no-files-found']).toBe('error');
    expect(upload.with['retention-days']).toBe(3);
    expect(upload['continue-on-error']).toBeUndefined();
  });
});

function withForeignGitContext(directory: string, extended: boolean, check: () => void) {
  // The hostile context points only to a disposable decoy, never the checkout
  // whose pre-push hook may be running this test.
  const gitDirectory = join(directory, '.git');
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GIT_')) vi.stubEnv(key, undefined);
    }
    vi.stubEnv('GIT_DIR', gitDirectory);
    if (extended) {
      for (const [key, value] of Object.entries({
        GIT_WORK_TREE: directory,
        GIT_COMMON_DIR: gitDirectory,
        GIT_INDEX_FILE: join(gitDirectory, 'index'),
        GIT_OBJECT_DIRECTORY: join(gitDirectory, 'objects'),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(gitDirectory, 'objects'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.bare',
        GIT_CONFIG_VALUE_0: 'true',
        GIT_CONFIG_PARAMETERS: "'core.bare=true'",
      }))
        vi.stubEnv(key, value);
    }
    check();
  } finally {
    vi.unstubAllEnvs();
  }
}

describe('required CI owns native fixture verification', () => {
  it.each([
    'scripts/ci/test-satellite-qualifiers.py',
    'scripts/ci/satellite_qualifier_fixture.py',
    'scripts/ci/satellite_qualifier_concurrency.py',
    'scripts/ci/satellite_entry_club_native.py',
    'scripts/ci/probes/satellite-entry-club-native.sql',
    'scripts/ci/fixtures/satellite-qualifiers/current-money-ddl-guard-20260917.json',
    'scripts/ci/probes/satellite-qualifiers-native.sql',
    'scripts/ci/probes/satellite-qualifier-reader.spec',
    'scripts/ci/probes/satellite-qualifier-finish.spec',
    'tests/operations/satellite-qualifier-results.test.py',
  ])('runs the existing accounting job for satellite input %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('executes satellite settlement and retains exact receipts in accounting', () => {
    const steps = ci.jobs.accounting_postgres.steps;
    const satellite = steps.filter((step: { run?: string }) =>
      step.run?.includes('scripts/ci/test-satellite-qualifiers.py')
    );
    expect(satellite).toHaveLength(1);
    expect(satellite[0].run).toContain('satellite-qualifier-results.test.py');
    expect(satellite[0].run).toContain('--pg-bin "$PG_BIN"');
    expect(satellite[0].env.PG_BIN).toBe('/usr/lib/postgresql/17/bin');
    expect(satellite[0].env.PG_ISOLATION_TESTER).toBe(
      '${{ github.workspace }}/artifacts/postgresql-17-isolationtester/toolchain/lib/pgxs/src/test/isolation/isolationtester'
    );
    expect(satellite[0]['continue-on-error']).toBeUndefined();
    expect(satellite[0].if).toBeUndefined();
    const upload = steps.find(
      (step: { name?: string }) => step.name === 'Retain satellite qualifier receipts'
    );
    expect(upload.uses).toBe('actions/upload-artifact@v4');
    expect(upload.if).toContain('always()');
    expect(upload.if).toContain('steps.satellite_qualifiers.outcome');
    expect(upload.with['if-no-files-found']).toBe('error');
  });

  it.each([
    'scripts/ci/test-mtt-unlimited.py',
    'scripts/ci/mtt_unlimited_fixture.py',
    'scripts/ci/mtt_format_qualification.py',
    'scripts/ci/mtt_historical_freebuy_proof.py',
    'scripts/ci/mtt_break_authoring_native.py',
    'scripts/ci/fixtures/mtt-break-authoring/source-binding.json',
    'scripts/ci/fixtures/mtt-break-authoring/catalog-supplement.sql',
    'scripts/dev/fixtures/mtt-blind-contract/authoring-native.sql',
    'scripts/ci/fixtures/mtt-historical-freebuy/current-authority-supplement.sql',
    'scripts/ci/fixtures/mtt-historical-freebuy/source-binding.json',
    'scripts/ci/mtt_isolation_results.py',
    'scripts/ci/fixtures/mtt-unlimited/accounting-schema.sql',
    'scripts/ci/fixtures/mtt-format-preparation/source-binding.json',
    'scripts/ci/fixtures/mtt-format-preparation/satellite-restart-future.sql',
    'scripts/ci/fixtures/mtt-format-preparation/satellite-creator-legacy.sql',
    'scripts/ci/probes/mtt-format-preparation-native.sql',
    'scripts/ci/probes/mtt-format-admission-lock.spec',
    'scripts/ci/probes/mtt-isolation/creation-commit.spec',
    'tests/operations/mtt-unlimited-runner.test.py',
    'tests/operations/mtt-isolation-results.test.py',
    'tests/operations/fixtures/mtt-preparation-lock/format_admission-actual.stdout',
  ])('selects the existing accounting job for MTT regression input %s', (path) => {
    expect(classifyChangedPaths([path]).server).toBe(true);
  });

  it.each([
    'scripts/ci/mtt_activation_native.py',
    'scripts/ci/mtt_activation_funding.py',
    'scripts/ci/mtt_activation_satellite.py',
    'scripts/ci/satellite_qualifier_fixture.py',
    'scripts/ci/mtt_break_authoring_native.py',
    'scripts/ci/fixtures/mtt-format-activation/source-binding.json',
    'scripts/ci/fixtures/mtt-format-activation/transition.sql',
    'scripts/ci/fixtures/satellite-qualifiers/current-money-ddl-guard-20260917.json',
    'scripts/ci/fixtures/mtt-break-authoring/catalog-supplement.sql',
    'scripts/ci/probes/mtt-activation/admission-activation-first-commit.spec',
    'tests/operations/mtt-activation-results.test.py',
  ])('routes each actual activation input to accounting and its routing tests: %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('runs preparation and actual activation only in the existing private native job', () => {
    const steps = ci.jobs.accounting_postgres.steps;
    const mtt = steps.filter((step: { run?: string }) =>
      step.run?.includes('test-mtt-unlimited.py')
    );
    expect(mtt).toHaveLength(1);
    expect(mtt[0].run).toContain('--mode preparation');
    expect(mtt[0].run).toContain('mtt-unlimited-runner.test.py');
    expect(mtt[0].run).toContain('mtt-isolation-results.test.py');
    expect(mtt[0].run).toContain('mtt-activation-results.test.py');
    expect(mtt[0].run.match(/test-mtt-unlimited\.py --mode activation/g)).toHaveLength(1);
    expect(mtt[0].run).toContain(
      '--output "$RUNNER_TEMP/mtt-activation-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"'
    );
    expect(mtt[0].run).not.toMatch(/DATABASE_URL|SUPABASE|apply_migration|\|\|\s*true/);
    expect(mtt[0].env.PG_BIN).toBe('/usr/lib/postgresql/17/bin');
    expect(mtt[0].env.PG_ISOLATION_TESTER).toBe(
      '${{ github.workspace }}/artifacts/postgresql-17-isolationtester/toolchain/lib/pgxs/src/test/isolation/isolationtester'
    );
    expect(mtt[0].run).not.toContain('20260915150000');
    expect(mtt[0]['continue-on-error']).toBeUndefined();
    expect(mtt[0].if).toBeUndefined();
    const evidence = steps.filter(
      (step: { name?: string }) =>
        step.name === 'Retain MTT preparation and activation receipts and exact native transcripts'
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0].uses).toBe('actions/upload-artifact@v4');
    expect(evidence[0].if).toContain('always()');
    expect(evidence[0].if).toContain('steps.mtt_preparation.outcome');
    expect(evidence[0].with['if-no-files-found']).toBe('error');
    expect(evidence[0].with.path.trim().split('\n')).toEqual([
      '${{ runner.temp }}/mtt-preparation-${{ github.run_id }}-${{ github.run_attempt }}',
      '${{ runner.temp }}/mtt-activation-${{ github.run_id }}-${{ github.run_attempt }}',
    ]);
  });

  it.each([
    'scripts/dev/probe-atomic-tournament-blinds-pg17.py',
    'scripts/dev/probe-played-mtt-launch-pg17.py',
  ])('executes the retained MTT native authority probe in accounting: %s', (path) => {
    const invocations = ci.jobs.accounting_postgres.steps.filter(
      (step: { run?: string }) => step.run === `python3 ${path}`
    );
    expect(invocations).toHaveLength(1);
    expect(invocations[0].env.POKER_AUDIT_PG_BIN).toBe('/usr/lib/postgresql/17/bin');
    expect(invocations[0].if).toBeUndefined();
    expect(invocations[0]['continue-on-error']).toBeUndefined();
    expect(classifyChangedPaths([path]).server).toBe(true);
  });

  it.each([false, true])(
    'isolates fixture writes from foreign Git context (extended=%s)',
    (extended) => {
      withGitFixture((decoy) => {
        const files = ['config', 'index', 'HEAD'];
        const before = files.map((file) => readFileSync(join(decoy.directory, '.git', file)));
        withForeignGitContext(decoy.directory, extended, () => {
          withGitFixture(({ git, write, commit }) => {
            expect(git('rev-parse', '--is-bare-repository')).toBe('false');
            write('docs/isolated.md');
            commit();
          });
        });
        expect(decoy.git('rev-parse', 'HEAD')).toBe(decoy.base);
        expect(decoy.git('rev-parse', '--is-bare-repository')).toBe('false');
        files.forEach((file, index) => {
          expect(readFileSync(join(decoy.directory, '.git', file))).toEqual(before[index]);
        });
      });
    }
  );

  it.each([false, true])(
    'classifies the requested repository under foreign Git context (extended=%s)',
    (extended) => {
      withGitFixture((decoy) => {
        withGitFixture(({ directory, base, write, commit }) => {
          write('scripts/dev/probe-foreign-context.py');
          const head = commit();
          withForeignGitContext(decoy.directory, extended, () => {
            const result = classifyGitChanges({ cwd: directory, base, head });
            expect(result.complete).toBe(true);
            expect(result.paths).toEqual(['scripts/dev/probe-foreign-context.py']);
            expect(result.flags.server).toBe(true);
            expect(result.flags.fixture).toBe(false);
          });
        });
      });
    }
  );

  it.each([
    'scripts/dev/probe-causal-pko-predecessors-pg17.sh',
    'scripts/dev/fixtures/causal-pko-predecessors/qualification.sql',
    'scripts/dev/probe-terminal-bounty-candidate-coverage-pg17.sh',
    'scripts/dev/probe-committed-payout-terms-pg17.py',
    'scripts/dev/probe-tournament-create-payout-depth-pg17.py',
    'tests/operations/pko-probe-cleanup.test.py',
  ])('selects the existing accounting job for MTT regression input %s', (path) => {
    expect(classifyChangedPaths([path]).server).toBe(true);
  });

  const externalMttInputs = [
    'docs/changelog/2026-09-11-a-bust-is-ranked-by-when-it-happened.rollback.sql',
    'scripts/ci/probes/chip-journal-atomicity/postgres-runtime/package.json',
    'scripts/ci/probes/chip-journal-atomicity/postgres-runtime/package-lock.json',
  ];

  it.each(externalMttInputs)(
    'selects accounting and routing tests for an executable MTT input outside scripts/dev: %s',
    (path) => {
      expect(classifyChangedPaths([path])).toEqual({
        src: false,
        server: true,
        tests: true,
        phase4: false,
        fixture: false,
      });
    }
  );

  it.each([
    'docs/changelog/2026-09-11-a-bust-is-ranked-by-when-it-happened.md',
    'docs/changelog/2026-09-11-a-bust-is-ranked-by-when-it-happened.rollback.sql.md',
    'docs/changelog/unrelated.rollback.sql',
    'scripts/ci/probes/chip-journal-atomicity/postgres-runtime/README.md',
    'scripts/ci/probes/chip-journal-atomicity/postgres-runtime/package.json.example',
    'scripts/ci/probes/chip-journal-atomicity/postgres-runtime-other/package.json',
  ])('keeps unrelated documentation and neighboring MTT input paths skipped: %s', (path) => {
    expect(classifyChangedPaths([path])).toEqual({
      src: false,
      server: false,
      tests: false,
      phase4: false,
      fixture: false,
    });
  });

  it.each(externalMttInputs)(
    'retains MTT checks when an executable input is renamed: %s',
    (path) => {
      withGitFixture(({ directory, git, write, commit }) => {
        write(path);
        const base = commit();
        git('mv', path, 'docs/retired-mtt-input.txt');
        const result = classifyGitChanges({ cwd: directory, base, head: commit() });
        expect(result.complete).toBe(true);
        expect(result.paths).toContain(path);
        expect(result.paths).toContain('docs/retired-mtt-input.txt');
        expect(result.flags.server).toBe(true);
        expect(result.flags.tests).toBe(true);
      });
    }
  );

  it.each([
    'operations/release/fixture/safeupdate-provider.mjs',
    'operations/release/native/component-observation-client.mjs',
    'operations/release/ci/fixture-smoke.py',
    '.github/workflows/component-fixture-native-smoke.yml',
    '.github/workflows/ci.yml',
    '.github/workflows/release-component-qualification.yml',
    'tests/operations/fixtures/realtime-launcher/bin/realtime',
    'scripts/ci/classify-ci-changes.mjs',
    'scripts/ci/fixture-native-gate.mjs',
    'tests/operations/fixture-required-ci.test.mjs',
    'tests/unit/fixtureNativeCi.test.ts',
    'package-lock.json',
  ])('classifies actual affected path %s for native execution', (path) => {
    expect(classifyChangedPaths([path]).fixture).toBe(true);
  });

  it('a provider renamed outside the fixture is detected from actual old and new Git paths', () => {
    withGitFixture(({ directory, base, git, write, commit }) => {
      write('scripts/keep.txt');
      git('mv', 'operations/release/fixture/provider.mjs', 'scripts/relocated.mjs');
      const head = commit();
      const result = classifyGitChanges({ cwd: directory, base, head });
      expect(result.complete).toBe(true);
      expect(result.paths).toContain('operations/release/fixture/provider.mjs');
      expect(result.paths).toContain('scripts/relocated.mjs');
      expect(result.flags.fixture).toBe(true);
    });
  });

  it('Git enumeration includes affected paths beyond a hundred files', () => {
    withGitFixture(({ directory, base, write, commit }) => {
      for (let i = 0; i < 105; i++) write(`docs/page-${i}.md`);
      write('operations/release/fixture/native-smoke.mjs');
      const result = classifyGitChanges({ cwd: directory, base, head: commit() });
      expect(result.complete).toBe(true);
      expect(result.paths).toHaveLength(106);
      expect(result.flags.fixture).toBe(true);
    });
  });

  it('head drift, absent Git objects and invalid event identities run every suite', () => {
    withGitFixture(({ directory, base, write, commit }) => {
      write('docs/first.md');
      const eventHead = commit();
      write('docs/second.md');
      const currentHead = commit();
      for (const input of [
        { base, head: eventHead },
        { base: 'f'.repeat(40), head: currentHead },
        { base: '', head: currentHead },
        { base, head: 'main' },
      ]) {
        const result = classifyGitChanges({ cwd: directory, ...input });
        expect(result.complete).toBe(false);
        expect(Object.values(result.flags).every((flag) => flag === true)).toBe(true);
      }
    });
  });

  it('verified unrelated diffs and empty diffs preserve legitimate native skips', () => {
    withGitFixture(({ directory, base, write, commit }) => {
      write('docs/other.md');
      const head = commit();
      const changed = classifyGitChanges({ cwd: directory, base, head });
      expect(changed.complete).toBe(true);
      expect(changed.flags.fixture).toBe(false);
      const empty = classifyGitChanges({ cwd: directory, base: head, head });
      expect(empty.complete).toBe(true);
      expect(empty.paths).toEqual([]);
      expect(empty.flags.fixture).toBe(false);
    });
  });

  it('checkout and classification use the event base/head, with no mutable PR listing', () => {
    expect(ci.jobs.changes.steps[0].with.ref).toBe('${{ github.event.pull_request.head.sha }}');
    expect(ci.jobs.changes.steps[0].with['fetch-depth']).toBe(0);
    expect(ci.jobs.changes.steps[0].with['persist-credentials']).toBe(false);
    expect(ci.jobs.changes.steps[1].env.CI_BASE_SHA).toBe(
      '${{ github.event.pull_request.base.sha }}'
    );
    expect(ci.jobs.changes.steps[1].env.CI_HEAD_SHA).toBe(
      '${{ github.event.pull_request.head.sha }}'
    );
    expect(ci.jobs.changes.steps[1].run).toBe('node scripts/ci/classify-ci-changes.mjs');
  });

  it('binds the required result to compilation and the native dependency without serializing compilation', () => {
    expect(ci.jobs.typecheck.name).toBe('TypeScript Check');
    expect(ci.jobs.typecheck.needs).toEqual(['typecheck_compile', 'changes', 'fixture_native']);
    expect(ci.jobs.typecheck.if).toBe("always() && github.event_name == 'pull_request'");
    expect(ci.jobs.typecheck_compile.needs).toBeUndefined();
    expect(ci.jobs.typecheck_compile.if).toBe("github.event_name == 'pull_request'");
    expect(ci.jobs.typecheck.steps[0].with.ref).toBe('${{ github.event.pull_request.head.sha }}');
    expect(ci.jobs.typecheck.steps[0].with['persist-credentials']).toBe(false);
    expect(ci.jobs.typecheck.steps.at(-1).run).toBe('node scripts/ci/fixture-native-gate.mjs');
    expect(ci.jobs.typecheck.steps.at(-1).env.NATIVE_RESULT).toBe(
      '${{ needs.fixture_native.result }}'
    );
  });

  it('uses one exact-head native invocation on both ready and draft PRs with read-only permissions', () => {
    expect(ci.jobs.fixture_native.uses).toBe(
      './.github/workflows/component-fixture-native-smoke.yml'
    );
    expect(ci.jobs.fixture_native.with.source_sha).toBe(
      '${{ github.event.pull_request.head.sha }}'
    );
    expect(ci.jobs.fixture_native.if).toContain("needs.changes.outputs.fixture != 'false'");
    expect(ci.jobs.fixture_native.if).toContain('always()');
    expect(ci.jobs.fixture_native.if).not.toContain('draft');
    expect(native.jobs['native-smoke'].if).not.toContain('draft');
    expect(Object.keys(native.on)).toEqual(['workflow_call']);
    expect(native.permissions).toEqual({ contents: 'read' });
    expect(ci.jobs.fixture_native.permissions).toEqual({ contents: 'read' });
    const checkout = native.jobs['native-smoke'].steps.find((s: { uses?: string }) =>
      s.uses?.startsWith('actions/checkout@')
    );
    expect(checkout.with.ref).toBe('${{ inputs.source_sha }}');
    expect(checkout.with['persist-credentials']).toBe(false);
    const build = native.jobs['native-smoke'].steps.find(
      (s: { env?: Record<string, string> }) => s.env?.FIXTURE_SOURCE_SHA
    );
    expect(build.env.FIXTURE_SOURCE_SHA).toBe('${{ inputs.source_sha }}');
    expect(build.id).toBe('smoke');
    expect(build.run.indexOf('python3 operations/release/ci/fixture-smoke.py')).toBeLessThan(
      build.run.indexOf('echo "native_verified=true"')
    );
    expect(native.jobs['native-smoke'].outputs.native_verified).toBe(
      '${{ steps.smoke.outputs.native_verified }}'
    );
    expect(native.on.workflow_call.outputs.native_verified.value).toBe(
      '${{ jobs.native-smoke.outputs.native_verified }}'
    );
    expect(ci.jobs.typecheck.steps.at(-1).env.NATIVE_VERIFIED).toBe(
      '${{ needs.fixture_native.outputs.native_verified }}'
    );
    expect(ci.jobs.typecheck.steps.at(-1).env.NATIVE_SOURCE_SHA).toBe(
      '${{ needs.fixture_native.outputs.source_sha }}'
    );
    expect(ci.jobs.typecheck.steps.at(-1).env.SOURCE_SHA).toBe(
      '${{ github.event.pull_request.head.sha }}'
    );
  });
});

// Keep the full current qualification closure explicit: no manifest read is
// needed to classify its own removal, or a source renamed outside the scope.
const spinExpiryAccountingPaths = [
  'scripts/qualification/spin-positive-fee-entry.py',
  'scripts/qualification/spin-positive-fee-entry-oracle.py',
  'scripts/qualification/spin-mixed-positive-fee-entry.sql',
  'scripts/qualification/spin-positive-fee-entry.hosted.manifest.json',
  'scripts/qualification/spin-positive-fee-entry.md',
  'scripts/qualification/fixtures/spin-mixed-positive-fee/provider-supplement.sql',
  'scripts/qualification/fixtures/spin-mixed-positive-fee/catalog-readback.sql',
  'scripts/qualification/fixtures/spin-mixed-positive-fee/reference-data.sql',
  'scripts/qualification/fixtures/spin-mixed-positive-fee/expected-metadata.json',
  'scripts/qualification/fixtures/spin-mixed-positive-fee/preimage-metadata.json',
  'scripts/qualification/fixtures/spin-mixed-positive-fee/provenance.json',
  'scripts/qualification/fixtures/spin-mixed-positive-fee/hand-id-sequence.sql',
  'scripts/qualification/fixtures/spin-mixed-positive-fee/hand-id-sequence-capture.json',
  'supabase/components/spin-mixed-basis-current-terminal.sql',
  'supabase/components/spin-mixed-basis-current-terminal.rollback.sql',
  'scripts/qualification/spin-mixed-current.py',
  'scripts/qualification/spin-mixed-current-races.py',
  'scripts/qualification/spin-mixed-current-assertions.py',
  'scripts/qualification/spin-mixed-current.hosted.manifest.json',
  'scripts/qualification/spin-mixed-current.md',
  'scripts/qualification/fixtures/spin-mixed-current/actor-identity.sql',
  'scripts/qualification/fixtures/spin-mixed-current/authority.json',
  'scripts/qualification/fixtures/spin-mixed-current/catalog.json',
  'scripts/qualification/fixtures/spin-mixed-current/catalog-readback.sql',
  'scripts/qualification/fixtures/spin-mixed-current/catalog-restore.sql',
  'scripts/qualification/fixtures/spin-mixed-current/narrow-refusal.sql',
  'scripts/qualification/fixtures/spin-mixed-current/net-plan.json',
  'scripts/qualification/fixtures/spin-mixed-current/observer.sql',
  'scripts/qualification/fixtures/spin-mixed-current/period-requests.json',
  'scripts/qualification/fixtures/spin-mixed-current/provenance.json',
  'scripts/qualification/fixtures/spin-mixed-current/recognition-readback.sql',
  'scripts/qualification/fixtures/spin-mixed-current/recognition-restore.sql',
  'scripts/qualification/fixtures/spin-mixed-current/recognizer.json',
  'scripts/qualification/fixtures/spin-mixed-current/replay.sql',
  'scripts/qualification/fixtures/spin-mixed-current/rollback-refusals.sql',
  'scripts/qualification/fixtures/spin-mixed-current/store-policy.sql',
  'scripts/qualification/fixtures/spin-mixed-current/synthetic-entry-close.sql',
  'scripts/qualification/fixtures/spin-mixed-current/synthetic-input-check.sql',
  'scripts/qualification/fixtures/spin-mixed-current/synthetic-model.json',
  'scripts/qualification/fixtures/spin-mixed-current/synthetic-provider.sql',
  'scripts/qualification/fixtures/spin-mixed-current/synthetic-seed.sql',
  'scripts/qualification/fixtures/spin-mixed-current/wrapper-refusals.sql',
  'scripts/qualification/spin-receipt-lane.hosted.manifest.json',
  'supabase/components/spin-mixed-basis-current-receipt-lane.sql',
  'supabase/components/spin-mixed-basis-current-receipt-lane.rollback.sql',
  'scripts/qualification/fixtures/spin-mixed-current/current-lane-state.sql',
  'scripts/qualification/fixtures/spin-mixed-current/current-lane-snapshot.sql',
  'scripts/qualification/fixtures/spin-mixed-current/current-lane-refusals.sql',
  'scripts/qualification/fixtures/spin-mixed-current/doctrine-successor.json',
  'scripts/qualification/fixtures/spin-mixed-current/doctrine-successor-restore.sql',
  'supabase/components/spin-mixed-basis-receipt-lane.sql',
  'supabase/components/spin-mixed-basis-receipt-lane.rollback.sql',
  'scripts/qualification/spin-receipt-lane.py',
  'scripts/qualification/spin-receipt-lane.sql',
  'scripts/qualification/spin-receipt-lane-compactor.sql',
  'scripts/qualification/spin-receipt-lane.md',
  'scripts/qualification/fixtures/spin-receipt-lane/authority.json',
  'scripts/qualification/fixtures/spin-receipt-lane/boundary.sql',
  'scripts/qualification/fixtures/spin-receipt-lane/provider.sql',
  'scripts/qualification/fixtures/spin-receipt-lane/state.sql',
  'scripts/qualification/fixtures/spin-receipt-lane/snapshot.sql',
  'scripts/qualification/fixtures/spin-receipt-lane/component-inputs.sql',

  'supabase/components/spin-mixed-basis-evidence.sql',
  'scripts/qualification/spin-mixed-basis-shape.sql',
  'scripts/qualification/spin-mixed-basis-evidence.preimage.sql',
  'scripts/qualification/spin-mixed-basis-pure.sql',
  'scripts/qualification/spin-mixed-basis-pure.hosted.manifest.json',
  'scripts/qualification/fixtures/spin-history-retention/capture-closure.sql',
  'scripts/qualification/fixtures/spin-history-retention/capture-provider.sql',
  'scripts/qualification/fixtures/spin-history-retention/component-inputs.sql',
  'scripts/qualification/fixtures/spin-history-retention/database-state.sql',
  'scripts/qualification/fixtures/spin-history-retention/estate.sql',
  'scripts/qualification/fixtures/spin-history-retention/history-writer-authority.json',
  'scripts/qualification/fixtures/spin-history-retention/preimage.sql',
  'scripts/qualification/fixtures/spin-history-retention/provider-authority.json',
  'scripts/qualification/fixtures/spin-history-retention/provider-check.sql',
  'scripts/qualification/fixtures/spin-history-retention/provider-closure-authority.json',
  'scripts/qualification/fixtures/spin-history-retention/provider-closure-check.sql',
  'scripts/qualification/fixtures/spin-history-retention/provider-closure.sql',
  'scripts/qualification/fixtures/spin-history-retention/provider-supplement.sql',
  'scripts/qualification/fixtures/spin-history-retention/sequence-authority-capture.json',
  'scripts/qualification/fixtures/spin-history-retention/sequence-authority.sql',
  'scripts/qualification/fixtures/spin-history-retention/social-alias-reference.sql',
  'scripts/qualification/fixtures/spin-history-retention/social-alias-reference-authority.json',
  'scripts/qualification/fixtures/spin-history-retention/state.sql',
  'scripts/qualification/spin-history-retention-behavior.sql',
  'scripts/qualification/spin-history-retention.md',
  'scripts/qualification/spin-history-retention.sql',
  'supabase/components/spin-history-retention.rollback.sql',
  'supabase/components/spin-history-retention.sql',
  'scripts/qualification/spin-history-retention.manifest.json',
  'scripts/qualification/fixtures/spin-history-retention/capture-completed-start.sql',
  'scripts/qualification/fixtures/spin-history-retention/completed-start-authority.json',
  'scripts/qualification/fixtures/spin-history-retention/completed-start-input.sql',
  'scripts/qualification/fixtures/spin-history-retention/completed-start-restore.sql',
  'scripts/qualification/spin-history-retention-completed.sql',
  'scripts/qualification/spin-history-retention-completed.md',
  'scripts/qualification/spin-history-retention-completed.manifest.json',
  'scripts/qualification/spin-expiry-business-races.md',
  'scripts/qualification/spin-expiry-business-races.py',
  'scripts/qualification/spin-expiry-business-state.sql',
  'scripts/qualification/spin-expiry-committed-refund-oracle.py',
  'scripts/qualification/spin-expiry-committed-refund-state.sql',
  'scripts/qualification/spin-expiry-committed-refund.authority.json',
  'scripts/qualification/spin-expiry-committed-refund.md',
  'scripts/qualification/spin-expiry-committed-refund.py',
  'scripts/qualification/spin-expiry-lock-order.authority.json',
  'scripts/qualification/spin-expiry-lock-order.component-inputs.sql',
  'scripts/qualification/spin-expiry-lock-order.md',
  'scripts/qualification/spin-expiry-lock-order.sql',
  'scripts/qualification/spin-expiry-real-funded-fixture.sql',
  'supabase/components/spin-expiry-lock-order.rollback.sql',
  'supabase/components/spin-expiry-lock-order.sql',
  'scripts/ci/probes/spin-expiry/inputs/schema.sql',
  'scripts/ci/probes/spin-expiry/inputs/access.sql',
  'scripts/ci/probes/spin-expiry/inputs/policies.sql',
  'scripts/ci/probes/spin-expiry/principals.sql',
  'scripts/ci/probes/spin-expiry/provider-supplement.sql',
  'scripts/ci/probes/spin-expiry/provider-roles.sql',
  'scripts/ci/probes/spin-expiry/provider-roles-check.sql',
  'scripts/ci/probes/spin-expiry/provider-check.sql',
  'scripts/ci/probes/spin-expiry/empty-provider-check.sql',
  'scripts/ci/probes/spin-expiry/inputs/catalog-sequence-exact.json',
  'scripts/ci/probes/spin-expiry/inputs/spin-catalog-supplement.sql',
  'scripts/ci/probes/spin-expiry/inputs/entry-provider-supplement.sql',
  'scripts/ci/probes/spin-expiry/inputs/entry-sequence-authority.sql',
  'scripts/ci/probes/spin-expiry/inputs/settle-source-authority.sql',
  'scripts/ci/probes/spin-expiry/inputs/captured-financial-store-policy.sql',
  'scripts/ci/probes/spin-expiry/inputs/captured-spin-catalog.json',
  'scripts/ci/probes/spin-expiry/spin-catalog-observer.sql',
  'scripts/ci/probes/spin-expiry/manifest.json',
  'scripts/ci/test-spin-expiry-postgres.py',
  'scripts/ci/test_spin_expiry_wrapper.py',
  'tests/unit/fixtureNativeCi.test.ts',
] as const;

describe('required CI owns funded Spin expiry PostgreSQL qualification', () => {
  it.each(spinExpiryAccountingPaths)('selects accounting and its guards for %s', (path) => {
    const flags = classifyChangedPaths([path]);
    expect(flags.server).toBe(true);
    expect(flags.tests).toBe(true);
    expect(flags.src).toBe(false);
  });

  it.each(['modified', 'deleted', 'renamed'] as const)(
    'keeps the full qualification selected when its actual Git paths are %s',
    (operation) => {
      withGitFixture(({ directory, git, write, commit }) => {
        for (const path of spinExpiryAccountingPaths) write(path, 'original qualification input');
        const base = commit();
        const relocated = spinExpiryAccountingPaths.map(
          (_, index) => `docs/relocated-spin-${index}.txt`
        );
        for (const [index, path] of spinExpiryAccountingPaths.entries()) {
          if (operation === 'modified') write(path, 'changed qualification input');
          if (operation === 'deleted') rmSync(join(directory, path));
          // The commit stages real filesystem renames in one Git operation. Avoid
          // one subprocess per path while retaining the actual committed diff.
          if (operation === 'renamed')
            renameSync(join(directory, path), join(directory, relocated[index]));
        }
        const result = classifyGitChanges({ cwd: directory, base, head: commit() });
        expect(result.complete).toBe(true);
        for (const path of spinExpiryAccountingPaths) expect(result.paths).toContain(path);
        expect(result.flags.server).toBe(true);
        expect(result.flags.tests).toBe(true);
        if (operation === 'renamed') {
          for (const path of relocated) expect(result.paths).toContain(path);
          // The old paths, rather than harmless destinations, select the job.
          expect(classifyChangedPaths(relocated).server).toBe(false);
          expect(classifyChangedPaths(relocated).tests).toBe(false);
        }
      });
    }
  );

  it.each([
    'docs/spin-expiry-plan.md',
    'supabase/components/spin-mixed-basis-current-terminal.sql.bak',
    'supabase/components/spin-mixed-basis-current-terminal.rollback.sql.bak',
    'scripts/qualification/spin-positive-fee-entry.py.bak',
    'scripts/qualification/spin-positive-fee-entry-unrelated.py',
    'scripts/qualification/spin-mixed-positive-fee-entry.sql.bak',
    'scripts/qualification/fixtures/spin-mixed-positive-fee-notes/input.sql',
    'scripts/qualification/spin-mixed-current.py.bak',
    'scripts/qualification/spin-mixed-current-races.py.bak',
    'scripts/qualification/spin-mixed-current-assertions.py.bak',
    'scripts/qualification/spin-mixed-current.hosted.manifest.json.bak',
    'scripts/qualification/spin-mixed-current.md.bak',
    'scripts/qualification/spin-mixed-current-unrelated.py',
    'scripts/qualification/spin-mixed-current-races.md',
    'scripts/qualification/fixtures/spin-mixed-current-notes/input.sql',
    'docs/scripts/qualification/fixtures/spin-mixed-current/input.sql',
    'supabase/components/spin-mixed-basis-current-receipt-lane.sql.bak',
    'supabase/components/spin-mixed-basis-current-receipt-lane.rollback.sql.bak',
    'supabase/components/spin-mixed-basis-current-receipt-lane-other.sql',
    'supabase/components/spin-mixed-basis-receipt-lane.sql.bak',
    'scripts/qualification/spin-receipt-lane.py.bak',
    'scripts/qualification/spin-receipt-lane.hosted.manifest.json.bak',
    'scripts/qualification/unrelated.sql',
    'supabase/components/unrelated.sql',
    'supabase/components/spin-expiry-lock-order.sql.bak',
    'supabase/components/spin-mixed-basis-evidence.sql.bak',
    'scripts/qualification/spin-mixed-basis-pure.sql.bak',
    'scripts/qualification/spin-mixed-basis-pure.hosted.manifest.json.bak',
    'scripts/qualification/spin-mixed-basis-shape.sql.bak',
    'scripts/qualification/spin-mixed-basis-evidence.preimage.sql.bak',
    'supabase/components/spin-history-retention.sql.bak',
    'scripts/qualification/spin-history-retention.sql.bak',
    'scripts/qualification/spin-history-retention-completed.sql.bak',
    'scripts/ci/probes/unrelated/input.sql',
    'scripts/ci/test-spin-expiry-postgres.py.bak',
  ])('preserves an unrelated accounting skip for %s', (path) => {
    const flags = classifyChangedPaths([path]);
    expect(flags.server).toBe(false);
    expect(flags.tests).toBe(false);
  });

  it('preserves a verified empty Git diff without weakening uncertain-diff behavior', () => {
    withGitFixture(({ directory, base }) => {
      const result = classifyGitChanges({ cwd: directory, base, head: base });
      expect(result.complete).toBe(true);
      expect(result.paths).toEqual([]);
      expect(result.flags.server).toBe(false);
      expect(result.flags.tests).toBe(false);
    });
  });

  it('calls the finite Spin runner from the existing PostgreSQL dependency', () => {
    const accounting = ci.jobs.accounting_postgres;
    expect(accounting.needs).toBe('changes');
    expect(accounting.if).toContain("needs.changes.outputs.server == 'true'");
    expect(accounting.if).toContain("needs.changes.result != 'success'");
    expect(accounting['runs-on']).toBe('ubuntu-latest');
    expect(accounting['continue-on-error']).toBeUndefined();
    const calls = accounting.steps.filter(
      (step: { id?: string }) => step.id === 'spin_expiry_postgres'
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].run).toBe('python3 scripts/ci/test-spin-expiry-postgres.py');
    expect(calls[0].env.PG_BIN).toBe('/usr/lib/postgresql/17/bin');
    expect(calls[0].if).toBeUndefined();
    expect(calls[0]['continue-on-error']).toBeUndefined();
    expect(ci.jobs.server.needs).toContain('accounting_postgres');
    const gate = ci.jobs.server.steps.find(
      (step: { name?: string }) => step.name === 'Every shard and real PostgreSQL accounting passed'
    );
    expect(ci.jobs.server.if).toBe('always()');
    expect(gate.env.ACCOUNTING_RESULT).toBe('${{ needs.accounting_postgres.result }}');
    expect(gate.run).toContain('"accounting:$ACCOUNTING_RESULT"');
    expect(gate.run).toContain('exit 1');
    expect(ci.jobs.unit_shards.if).toContain("needs.changes.outputs.tests == 'true'");
    expect(
      ci.jobs.unit_shards.steps.some(
        (step: { run?: string }) =>
          step.run === 'npx vitest run tests/ --shard=${{ matrix.shard }}/4'
      )
    ).toBe(true);
  });
});

describe('Production Alert SQL checks use the existing accounting job', () => {
  const paths = [
    'scripts/ci/test-hand-index-writer-order.py',
    'scripts/ci/test-hand-stat-writer-order.py',
    'scripts/ci/test-rake-attribution-atomic.py',
    'scripts/ci/probes/hand-index-writer-order/baseline.json',
    'scripts/ci/probes/hand-stat-writer-order/baseline.json',
    'scripts/ci/probes/rake-attribution-atomic/baseline.json',
    'supabase/migrations/20260914194928_hand_index_writers_share_a_canonical_order.sql',
    'supabase/migrations/20260914212802_hand_stat_writers_share_a_canonical_order.sql',
    'supabase/migrations/20260914223105_rake_settlement_requires_complete_attribution.sql',
    'tests/tournament-rake-attribution-retries-inside-its-own-transaction.law.test.ts',
  ];

  it.each(paths)('selects the real accounting check and source guards for %s', (path) => {
    const flags = classifyChangedPaths([path]);
    expect(flags.server).toBe(true);
    expect(flags.tests).toBe(true);
  });

  it.each([
    'scripts/ci/test-hand-stat-writer-order.py.bak',
    'scripts/ci/probes/unrelated-input/baseline.json',
  ])('does not select an unrelated accounting check for %s', (path) => {
    expect(classifyChangedPaths([path]).server).toBe(false);
  });

  it('runs all three real drivers with the installed PG17 tools and no failure bypass', () => {
    const accounting = ci.jobs.accounting_postgres;
    expect(accounting['runs-on']).toBe('ubuntu-latest');
    expect(accounting['continue-on-error']).toBeUndefined();
    const expected = [
      [
        'hand_index_writer_order',
        'python3 scripts/ci/test-hand-index-writer-order.py --migration supabase/migrations/20260914194928_hand_index_writers_share_a_canonical_order.sql --output artifacts/production-alerts-sql/hand-index',
      ],
      [
        'hand_stat_writer_order',
        'python3 scripts/ci/test-hand-stat-writer-order.py --migration supabase/migrations/20260914212802_hand_stat_writers_share_a_canonical_order.sql --output artifacts/production-alerts-sql/hand-stat',
      ],
      [
        'rake_attribution_atomic',
        'python3 scripts/ci/test-rake-attribution-atomic.py --output artifacts/production-alerts-sql/rake-attribution',
      ],
    ];
    let previous = -1;
    for (const [id, command] of expected) {
      const calls = accounting.steps.filter((step: { id?: string }) => step.id === id);
      expect(calls).toHaveLength(1);
      expect(calls[0].run).toBe(command);
      expect(calls[0].env.PG_BIN).toBe('/usr/lib/postgresql/17/bin');
      expect(calls[0].if).toBeUndefined();
      expect(calls[0]['continue-on-error']).toBeUndefined();
      const current = accounting.steps.indexOf(calls[0]);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
    expect(ci.jobs.server.needs).toContain('accounting_postgres');
    expect(
      ci.jobs.unit_shards.steps.some(
        (step: { run?: string }) =>
          step.run === 'npx vitest run tests/ --shard=${{ matrix.shard }}/4'
      )
    ).toBe(true);
  });
});

describe('memory observation rules keep their existing monitoring regression checks', () => {
  it.each([
    'infra/monitoring/alert-rules.yml',
    'infra/monitoring/grafana-dashboards/poker-engine.json',
  ])('runs the existing test suite for a rule-only change to %s', (path) => {
    expect(classifyChangedPaths([path]).tests).toBe(true);
    expect(classifyChangedPaths([path]).src).toBe(false);
  });
});

describe('Horse League priority fixture stays in the existing server verification', () => {
  it.each([
    'scripts/qualification/horse-league-process-priority-native.mjs',
    'scripts/qualification/fixtures/horse-league-process-priority/child.mjs',
  ])('selects server checks when only %s changes', (path) => {
    expect(classifyChangedPaths([path]).server).toBe(true);
    expect(classifyChangedPaths([path]).tests).toBe(true);
  });
  it('does not select the server for qualification prose alone', () => {
    expect(
      classifyChangedPaths(['scripts/qualification/horse-league-process-priority-native.md']).server
    ).toBe(false);
  });
});

describe('native PG17 isolation tool is built by the existing accounting job', () => {
  it('tool source changes require the accounting and contract suites', () => {
    const flags = classifyChangedPaths(['scripts/ci/build_pg17_isolationtester.py']);
    expect(flags.server).toBe(true);
    expect(flags.tests).toBe(true);
    expect(flags.src).toBe(false);
    expect(classifyChangedPaths(['scripts/ci/build_pg17_isolationtester.py.bak']).server).toBe(
      false
    );
  });

  it('builds the pinned upstream tool once before PostgreSQL business qualification', () => {
    const steps = ci.jobs.accounting_postgres.steps;
    const builders = steps.filter((step: { id?: string }) => step.id === 'pg17_isolation_tool');
    expect(builders).toHaveLength(1);
    expect(builders[0].run).toBe('python3 scripts/ci/build_pg17_isolationtester.py');
    expect(builders[0].env.PG_BIN).toBe('/usr/lib/postgresql/17/bin');
    expect(builders[0]['continue-on-error']).toBeUndefined();
    const bbj = steps.filter((step: { id?: string }) => step.id === 'bbj');
    expect(bbj).toHaveLength(1);
    expect(bbj[0].run).toContain('python3 scripts/ci/test-bbj-bank-replay.py');
    expect(steps.indexOf(builders[0])).toBeLessThan(steps.indexOf(bbj[0]));
    const evidence = steps.find(
      (step: { name?: string }) => step.name === 'Retain PostgreSQL isolation tool build evidence'
    );
    expect(evidence.if).toBe("always() && steps.pg17_isolation_tool.outcome != 'skipped'");
    expect(evidence.with.path).toContain('artifacts/postgresql-17-isolationtester/receipt.json');
    expect(evidence.with.path).not.toContain('**');
  });
});

describe('composed alert inputs stay in the existing accounting qualification', () => {
  it.each([
    'supabase/components/production-alert-identity-and-rake-wording.sql',
    'supabase/components/production-alert-identity-and-rake-wording.rollback.sql',
    'supabase/components/direct-operational-source-intake.sql',
    'supabase/components/direct-operational-source-legacy-envelope.sql',
    'supabase/components/direct-operational-source-legacy-envelope.rollback.sql',
    'scripts/qualification/direct-operational-source-legacy-envelope.sql',
    'supabase/components/direct-operational-source-intake.rollback.sql',
    'supabase/components/direct-operational-source-intake.authority.sql',
    'supabase/components/direct-operational-source-intake.functions.sql',
    'supabase/components/direct-operational-source-intake.postimage.sql',
    'scripts/qualification/direct-operational-source-intake.sql',
    'scripts/qualification/fixtures/direct-operational-source-intake/prepare.sql',
    'scripts/qualification/fixtures/direct-operational-source-intake/authority.json',
    'scripts/qualification/fixtures/direct-operational-source-intake/race.sql',
    'scripts/qualification/fixtures/direct-operational-source-intake/retained.sql',
    'scripts/qualification/production-alert-core-connected.sql',
    'scripts/qualification/production-alert-core-identity.sql',
    'scripts/ci/probes/production-alert-core/notification/inputs/schema.sql',
    'scripts/ci/test-production-alert-core-postgres.py',
    'scripts/ci/test_production_alert_core_postgres.py',
    'supabase/components/duplicate-structure-record-evidence.rollback.sql',
    'supabase/components/rake-repair-record-evidence-rollback.sql',
    'supabase/components/spin-repair-evidence.sql',
    'scripts/qualification/duplicate-structure-record-evidence.sql',
    'scripts/qualification/rake-repair-record-evidence.manifest.json',
    'scripts/qualification/spin-repair-evidence-race.spec',
    'scripts/qualification/fixtures/spin-repair-evidence/original.sql',
    'scripts/qualification/alert-evidence-hosted.manifest.json',
    'scripts/ci/test-alert-evidence-postgres.py',
    'scripts/ci/test_alert_evidence_wrapper.py',
  ])('selects server and test checks for %s', (path) => {
    const flags = classifyChangedPaths([path]);
    expect(flags.server).toBe(true);
    expect(flags.tests).toBe(true);
  });

  it.each([
    'scripts/ci/test-production-alert-core-postgres.py.bak',
    'supabase/components/spin-repair-evidence.sql.bak',
    'supabase/components/direct-operational-source-intake.sql.bak',
    'supabase/components/direct-operational-source-legacy-envelope.sql.bak',
    'scripts/qualification/direct-operational-source-intake.md',
    'scripts/qualification/unrelated.sql',
  ])('does not select unrelated input %s', (path) => {
    expect(classifyChangedPaths([path]).server).toBe(false);
  });

  it('calls both real qualifiers without a conditional or error bypass', () => {
    const steps = ci.jobs.accounting_postgres.steps;
    for (const [id, command] of [
      [
        'production_alert_core',
        'python3 scripts/ci/test-production-alert-core-postgres.py --output artifacts/production-alerts-sql/core',
      ],
      [
        'alert_evidence_postgres',
        'python3 scripts/ci/test-alert-evidence-postgres.py --output artifacts/production-alerts-sql/evidence',
      ],
    ]) {
      const calls = steps.filter((step: { id?: string }) => step.id === id);
      expect(calls).toHaveLength(1);
      expect(calls[0].run).toBe(command);
      expect(calls[0].env.PG_BIN).toBe('/usr/lib/postgresql/17/bin');
      expect(calls[0].if).toBeUndefined();
      expect(calls[0]['continue-on-error']).toBeUndefined();
      expect(steps.indexOf(calls[0])).toBeLessThan(
        steps.findIndex(
          (step: { name?: string }) =>
            step.name === 'Retain production alert SQL qualification evidence'
        )
      );
    }
    const evidence = steps.find((step: { id?: string }) => step.id === 'alert_evidence_postgres');
    expect(evidence.env.PG_ISOLATION_TESTER).toBe(
      '${{ github.workspace }}/artifacts/postgresql-17-isolationtester/toolchain/lib/pgxs/src/test/isolation/isolationtester'
    );
  });
});

describe('Class4 evidence uses the same PostgreSQL job', () => {
  it.each([
    'supabase/components/class4-hand-outcome-evidence.sql',
    'supabase/components/class4-hand-outcome-evidence.rollback.sql',
    'scripts/qualification/class4-hand-outcome-evidence.sql',
    'scripts/qualification/class4-hand-outcome-evidence.drift.sql',
    'scripts/qualification/class4-hand-outcome-evidence.concurrency.spec',
    'scripts/qualification/fixtures/class4-hand-outcome-evidence.preimage.sql',
    'scripts/qualification/fixtures/class4-hand-outcome-evidence.candidate.sql',
    'scripts/qualification/fixtures/class4-hand-outcome-evidence.originals.sql',
    'scripts/ci/test-class4-hand-outcome-postgres.py',
    'scripts/ci/test_class4_hand_outcome_postgres.py',
    'scripts/ci/probes/class4-hand-outcome/manifest.json',
  ])('selects server and test execution for %s', (path) => {
    expect(classifyChangedPaths([path]).server).toBe(true);
    expect(classifyChangedPaths([path]).tests).toBe(true);
  });
  it('does not classify an unrelated or backup SQL file', () => {
    expect(
      classifyChangedPaths(['supabase/components/class4-hand-outcome-evidence.sql.bak']).server
    ).toBe(false);
  });
  it('runs the original states and native concurrency without a bypass', () => {
    const calls = ci.jobs.accounting_postgres.steps.filter(
      (step: { id?: string }) => step.id === 'class4_hand_outcome'
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].if).toBeUndefined();
    expect(calls[0]['continue-on-error']).toBeUndefined();
    expect(calls[0].env.PG_BIN).toBe('/usr/lib/postgresql/17/bin');
    expect(calls[0].run.trim()).toBe(
      'python3 -m unittest discover -s scripts/ci -p test_class4_hand_outcome_postgres.py\npython3 scripts/ci/test-class4-hand-outcome-postgres.py --output artifacts/production-alerts-sql/class4'
    );
  });
});

describe('cash failure intake is exercised by the actual hosted scheduler fixture', () => {
  it.each([
    'supabase/components/cash-failed-run-intake.sql',
    'supabase/components/cash-failed-run-intake.rollback.sql',
    'supabase/components/cash-pot-check-evidence.sql',
    'supabase/components/cash-pot-check-evidence.rollback.sql',
    'scripts/ci/build_pg17_cash_pgcron.py',
    'scripts/ci/test-cash-failure-pgcron.py',
    'scripts/ci/test_cash_native_pgcron.py',
    'scripts/qualification/cash-native-hosted.manifest.json',
    'scripts/qualification/cash-pot-check-connected.sql',
    'scripts/ci/probes/production-alert-core/cash-checker-preimage.sql',
    'scripts/qualification/cash-pot-check-evidence-concurrency.spec',
    'scripts/qualification/fixtures/cash-native-pgcron/pg_cron-heap-tables.patch',
    'scripts/qualification/fixtures/cash-pot-check-evidence/preimage.sql',
  ])('requires accounting and its guard suite for %s', (path) => {
    const result = classifyChangedPaths([path]);
    expect(result.server).toBe(true);
    expect(result.tests).toBe(true);
  });
  it('keeps backup files outside the production source match', () => {
    expect(
      classifyChangedPaths(['supabase/components/cash-failed-run-intake.sql.bak']).server
    ).toBe(false);
  });
  it('builds and executes the native scheduler without suppressing failure', () => {
    const job = ci.jobs.accounting_postgres;
    const build = job.steps.filter((s: { id?: string }) => s.id === 'cash_pgcron_build');
    const execution = job.steps.filter((s: { id?: string }) => s.id === 'cash_native_failure');
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['continue-on-error']).toBeUndefined();
    expect(build).toHaveLength(1);
    expect(execution).toHaveLength(1);
    expect(build[0].run).toBe('python3 scripts/ci/build_pg17_cash_pgcron.py');
    expect(execution[0].run.trim()).toBe(
      'python3 -m unittest discover -s scripts/ci -p test_cash_native_pgcron.py\npython3 scripts/ci/test-cash-failure-pgcron.py'
    );
    expect(execution[0].if).toBeUndefined();
    expect(execution[0]['continue-on-error']).toBeUndefined();
    expect(job.steps.indexOf(build[0])).toBeLessThan(job.steps.indexOf(execution[0]));
  });
});

describe('restored provider accounting qualification', () => {
  const fixtureDirectories = [
    'accounting-agreement-history',
    'accounting-alert-38644',
    'accounting-delivery',
    'agent-accounting-statements',
    'browser-period-observer',
    'cash-commission-sources',
    'cash-rake-earning-evidence',
    'cash-source-compatibility',
    'cash-source-refusals',
    'cashier-document-authority',
    'club-weekly-summary',
    'correction-document-authority',
    'correction-writer-authority',
    'credit-invoice-generation',
    'credit-reduction-authority',
    'credit-request-authority',
    'full-weekly-accounting',
    'messenger-private-accounting',
    'mixed-rake-period',
    'pnl-evidence',
    'push-health-reader',
    'push-subscription-ownership',
    'push-subscription-rotation',
    'rakeback-history-privacy',
    'rakeback-write-authority',
    'routed-accounting',
    'scope-weekly-accounting',
    'tournament-fee-lifecycle',
    'tournament-fee-sources',
    'unified-weekly-accounting',
    'union-earned-close',
    'union-weekly-accounting',
    'weekly-accounting-coordinator',
    'weekly-scheduler-fairness',
    'weekly-scheduler-timing',
    'weekly-union-continuation',
  ];

  it.each([
    'supabase/accounting/weekly-v3/components/20260915150000_credit_reductions_retain_exact_intent_and_private_records.sql',
    'supabase/accounting/credit-reduction-v1/server-functions.sql',
    'scripts/ci/build-weekly-accounting-activation.py',
    ...fixtureDirectories.map((directory) => `tests/fixtures/${directory}/regression.sql`),
  ])('runs the existing required accounting job for %s', (path) => {
    const flags = classifyChangedPaths([path]);
    expect(flags.server).toBe(true);
    expect(flags.src).toBe(false);
    expect(flags.phase4).toBe(false);
    expect(flags.fixture).toBe(false);
    expect(flags.tests).toBe(path.startsWith('tests/'));
  });

  it.each([
    'docs/accounting/notes.md',
    'supabase/accounting-notes/readme.md',
    'scripts/ci/build-weekly-accounting-activation.py.backup',
    'tests/fixtures/full-weekly-accounting-other/regression.sql',
    'tests/fixtures/unrelated-game/regression.sql',
  ])('does not widen accounting execution to unrelated path %s', (path) => {
    expect(classifyChangedPaths([path]).server).toBe(false);
  });

  it('retains prior application, migration and runner classifications and fail-closed input', () => {
    for (const path of [
      'server/src/services/Accounting.ts',
      'supabase/migrations/example.sql',
      'scripts/dev/test-full-weekly-accounting-activation.sh',
    ]) {
      expect(classifyChangedPaths([path])).toEqual({
        src: false,
        server: true,
        tests: true,
        phase4: false,
        fixture: false,
      });
    }
    expect(classifyChangedPaths([]).server).toBe(false);
    expect(Object.values(classifyChangedPaths([''])).every(Boolean)).toBe(true);
  });

  it('runs each required source suite once on the original provider job', () => {
    const job = ci.jobs.accounting_postgres;
    const steps = job.steps as Array<{
      run?: string;
      if?: string;
      env?: Record<string, string>;
      'continue-on-error'?: boolean;
    }>;
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job.if).toBe(ci.jobs.server_shards.if);
    expect(ci.jobs.server.needs).toContain('accounting_postgres');
    expect(job['continue-on-error']).not.toBe(true);
    const requiredRunners = [
      'union-weekly-accounting',
      'credit-invoice-generation',
      'accounting-delivery',
      'credit-invoice-payment',
      'agent-accounting-statements',
      'accounting-agreement-history',
      'club-weekly-summary',
      'weekly-accounting-coordinator',
      'full-weekly-accounting-activation',
      'cash-commission-sources',
      'cash-source-refusals',
      'cash-source-compatibility',
      'tournament-fee-sources',
      'scope-weekly-accounting',
      'unified-weekly-accounting',
      'push-health-reader',
    ];
    for (const runner of requiredRunners) {
      const command = `bash scripts/dev/test-${runner}.sh`;
      const matches = steps.filter((step) => step.run?.includes(command));
      expect(matches, runner).toHaveLength(1);
      const step = matches[0];
      expect(step.run!.split(command)).toHaveLength(2);
      expect(step.if, runner).toBeUndefined();
      expect(step['continue-on-error'], runner).not.toBe(true);
      expect(step.env?.PG_BIN, runner).toBe('/usr/lib/postgresql/17/bin');
      if (runner !== 'full-weekly-accounting-activation') expect(step.run).toBe(command);
    }
    const full = steps.find((step) =>
      step.run?.includes('test-full-weekly-accounting-activation.sh')
    )!;
    expect(full.run).toContain('set -euo pipefail');
    expect(
      full.run!.indexOf('python3 scripts/ci/build-weekly-accounting-activation.py')
    ).toBeLessThan(full.run!.indexOf('bash scripts/dev/test-full-weekly-accounting-activation.sh'));
    expect(full.env?.ACCOUNTING_ACTIVATION_DIR).toBe(
      '${{ runner.temp }}/union-accounting-activation'
    );
    expect(full.env?.ACCOUNTING_TEST_OUTPUT_DIR).toBe(
      '${{ runner.temp }}/union-accounting-results'
    );
    expect(full.env?.ACCOUNTING_FIXTURE_PARENT).toBe('${{ runner.temp }}/union-accounting-scratch');
  });

  it('requires real pg_cron even when PostgreSQL tools are already present', () => {
    const install = ci.jobs.accounting_postgres.steps.find(
      (step: { name?: string }) =>
        step.name === 'Install PostgreSQL 17 tools without a default database service'
    );
    expect(install.run).toContain('-f /usr/share/postgresql/17/extension/pg_cron.control &&');
    expect(install.run).toContain('-f /usr/lib/postgresql/17/lib/pg_cron.so ]]; then exit 0; fi');
    expect(install.run).toContain(
      'install -y --no-install-recommends postgresql-17 postgresql-17-cron'
    );
    expect(install.run).toContain('create_main_cluster = false');
    const evidence = ci.jobs.accounting_postgres.steps.find(
      (step: { name?: string }) => step.name === 'Preserve weekly accounting qualification evidence'
    );
    expect(evidence.if).toBe('always()');
    expect(evidence.uses).toBe('actions/upload-artifact@v4');
    expect(evidence.with.path).toContain('${{ runner.temp }}/union-accounting-results');
    expect(evidence.with.path).toContain('${{ runner.temp }}/union-accounting-activation');
  });
});

describe('instruction-only verification preserves source contracts without replaying unchanged SQL', () => {
  it('admits only the exact maintained policy prose and hash manifest', async () => {
    const { instructionOnlyPaths } = await import('../../scripts/ci/classify-ci-changes.mjs');
    const allowed = [
      'OWNER-POLICY.md',
      'OPERATING-LAW.md',
      'HARDENING.md',
      'REFERENCE-INDEX.md',
      'policy-manifest.json',
    ].map((p) => `docs/agent-policy/${p}`);
    expect(instructionOnlyPaths(allowed)).toBe(true);
    expect(classifyChangedPaths(allowed)).toMatchObject({
      tests: true,
      src: false,
      server: false,
      fixture: false,
    });
    for (const path of [
      'CLAUDE.md',
      'docs/changelog/rollback.sql',
      'docs/agent-policy/agent-policy.mjs',
      'src/App.tsx',
      'server/src/index.ts',
      'supabase/migrations/fix.sql',
      '.github/workflows/ci.yml',
      'scripts/ci/classify-ci-changes.mjs',
      'docs/agent-policy/../other.md',
    ]) {
      expect(instructionOnlyPaths([...allowed, path]), path).toBe(false);
    }
    expect(instructionOnlyPaths([])).toBe(false);
    expect(instructionOnlyPaths(null)).toBe(false);
  });
  it('the existing required compiler route invokes policy checks and fails closed for missing classification', () => {
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('node docs/agent-policy/agent-policy.mjs check');
    expect(ci).toContain('node --test docs/agent-policy/agent-policy.test.mjs');
    expect(ci).toContain("if: steps.compile_scope.outputs.instructions_only != 'true'");
    expect(ci).toContain('npx tsc --noEmit');
    expect(ci).toContain('npx vitest run tests/ --shard=${{ matrix.shard }}/4');
  });
});

it('the actual replay condition executes for missing output and non-instruction diffs', () => {
  const condition = ci.jobs.typecheck_compile.steps.find(
    (step: { name: string }) =>
      step.name === 'Chip journal transactions survive failures and replays'
  ).if;
  const evaluate = new Function('steps', `return (${condition});`);
  for (const value of ['true', 'false', undefined, '']) {
    expect(evaluate({ compile_scope: { outputs: { instructions_only: value } } })).toBe(
      value !== 'true'
    );
  }
  const classifier = ci.jobs.typecheck_compile.steps.find(
    (step: { id: string }) => step.id === 'compile_scope'
  );
  expect(classifier.run).toBe('node scripts/ci/classify-ci-changes.mjs');
  expect(classifier.env.CI_HEAD_SHA).toBe('${{ github.sha }}');
  expect(classifier['continue-on-error']).toBeUndefined();
  expect(ci.jobs.typecheck_compile.needs).toBeUndefined();
  expect(ci.jobs.typecheck_compile.if).toBe("github.event_name == 'pull_request'");
});
