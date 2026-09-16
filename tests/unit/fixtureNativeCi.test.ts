import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { classifyChangedPaths, classifyGitChanges } from '../../scripts/ci/classify-ci-changes.mjs';

const root = resolve(__dirname, '../..');
const ci = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
const native = parse(
  readFileSync(join(root, '.github/workflows/component-fixture-native-smoke.yml'), 'utf8')
);

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
      execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
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

describe('browser changes retain their shipped-CSS qualification', () => {
  it.each([
    'tests/e2e/live-animations.spec.ts',
    'tests/e2e/multi-table.spec.ts',
    'tests/e2e/lib/live-css.ts',
    'tests/e2e/css/club-lobby-sticky-selector.spec.ts',
    'playwright.config.ts',
  ])('runs the browser build and CSS gate for %s', (path) => {
    expect(classifyChangedPaths([path]).src).toBe(true);
  });

  it('retains a removed browser test in the immutable Git classification', () => {
    withGitFixture(({ directory, git, write, commit }) => {
      write('tests/e2e/renamed.spec.ts');
      const base = commit();
      git('mv', 'tests/e2e/renamed.spec.ts', 'docs/retired-example.md');
      const result = classifyGitChanges({ cwd: directory, base, head: commit() });
      expect(result.complete).toBe(true);
      expect(result.flags.src).toBe(true);
    });
  });

  it('keeps unrelated docs and unit-only changes outside the browser build', () => {
    expect(classifyChangedPaths(['docs/example.md']).src).toBe(false);
    expect(classifyChangedPaths(['tests/unit/example.test.ts']).src).toBe(false);
  });
});

describe('the journal gate follows every financial probe input', () => {
  it.each([
    'server/src/services/SettlementService.ts',
    'supabase/migrations/20260916000000_example.sql',
    'supabase/migrations/20260916000000_example.sql.pending',
    'scripts/ci/probes/chip-journal-atomicity/run-isolated.sh',
    'scripts/ci/probes/chip-journal-atomicity/test_hand.py',
    'scripts/ci/probes/chip-journal-atomicity/hand-fixture.sql',
    'scripts/ci/probes/chip-journal-atomicity/postgres-runtime/query.mjs',
    'scripts/ci/probes/chip-journal-atomicity/postgres-runtime/package-lock.json',
    'scripts/ci/probes/stats-runout-index/probe.sql',
    'scripts/ci/probes/stats-witness-showdown/baseline-facts-range.sql',
    'scripts/dev/probe-tournament-registration-funding-pg17.py',
    'scripts/dev/tournament_heads_up_payout_cases.py',
    'scripts/dev/fixtures/heads-up-funding/captured-functions.json',
    'tests/fixtures/financial.sql',
    'tests/fixtures/financial.sql.pending',
    '.github/workflows/ci.yml',
    'scripts/ci/classify-ci-changes.mjs',
    'package.json',
    'package-lock.json',
    '.npmrc',
    '.node-version',
  ])('runs the financial category for %s', (path) => {
    expect(classifyChangedPaths([path]).server).toBe(true);
  });

  it('does not rerun the journal for the seven UI/fixture paths in PR4705', () => {
    const paths = [
      'src/pages/PlayerStatisticsPage.css',
      'tests/e2e/global-setup.ts',
      'tests/e2e/production-daily-missions.spec.ts',
      'tests/e2e/production-mobile-lobby-chrome.spec.ts',
      'tests/e2e/routes/utils.ts',
      'tests/e2e/support/ensureClubMembership.ts',
      'tests/unit/productionE2EProfilePreflight.test.ts',
    ];
    expect(classifyChangedPaths(paths)).toMatchObject({ server: false, src: true, tests: true });
  });

  it.each([undefined, null, 'unknown', [null], [''], ['bad\0path']])(
    'runs the journal when changed paths are malformed: %j',
    (paths) => {
      expect(classifyChangedPaths(paths).server).toBe(true);
    }
  );

  it.each(['rename', 'delete'])(
    'retains a %s of a probe input in the actual Git diff',
    (operation) => {
      withGitFixture(({ directory, git, write, commit }) => {
        const path = 'scripts/ci/probes/chip-journal-atomicity/postgres-runtime/package-lock.json';
        write(path);
        const base = commit();
        if (operation === 'rename') git('mv', path, 'docs/retired-runtime.txt');
        else git('rm', path);
        const result = classifyGitChanges({ cwd: directory, base, head: commit() });
        expect(result.complete).toBe(true);
        expect(result.paths).toContain(path);
        expect(result.flags.server).toBe(true);
      });
    }
  );
});

describe('FIFO5 qualification inputs reach the existing accounting category', () => {
  it.each([
    'scripts/qualification/spin-expiry-business-races.py',
    'scripts/qualification/spin-expiry-business-state.sql',
    'scripts/qualification/spin-expiry-committed-refund-oracle.py',
    'scripts/qualification/spin-expiry-committed-refund-state.sql',
    'scripts/qualification/spin-expiry-committed-refund.authority.json',
    'scripts/qualification/spin-expiry-committed-refund.py',
    'scripts/qualification/spin-expiry-lock-order.authority.json',
    'scripts/qualification/spin-expiry-lock-order.component-inputs.sql',
    'scripts/qualification/spin-expiry-lock-order.sql',
    'supabase/components/spin-expiry-lock-order.rollback.sql',
    'supabase/components/spin-expiry-lock-order.sql',
    'scripts/ci/test-spin-expiry-postgres.py',
    'scripts/ci/test_spin_expiry_wrapper.py',
    'scripts/ci/classify-ci-changes.mjs',
    'tests/unit/fixtureNativeCi.test.ts',
    '.github/workflows/ci.yml',
  ])('classifies the directly owned input %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, fifo5: true });
  });

  it.each([
    'scripts/qualification/spin-expiry-business-races.md',
    'scripts/qualification/spin-expiry-committed-refund.md',
    'scripts/qualification/spin-expiry-lock-order.md',
  ])('does not select financial CI for documentation-only input %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: false, fifo5: false });
  });

  it.each([
    'src/pages/PlayerStatisticsPage.css',
    'docs/example.md',
    'scripts/qualification/unrelated.py',
    'supabase/components/spin-expiry-lock-order-unrelated.sql',
  ])('does not select FIFO5 for an unrelated path %s', (path) => {
    expect(classifyChangedPaths([path]).fifo5).toBe(false);
  });

  it.each([undefined, null, 'unknown', [null], [''], ['bad\0path']])(
    'retains FIFO5 when changed paths are malformed: %j',
    (paths) => {
      expect(classifyChangedPaths(paths)).toMatchObject({ server: true, fifo5: true });
    }
  );

  it.each(['rename', 'delete'])('retains the %s of an authority input', (operation) => {
    withGitFixture(({ directory, git, write, commit }) => {
      const path = 'scripts/qualification/spin-expiry-committed-refund.authority.json';
      write(path);
      const base = commit();
      if (operation === 'rename') git('mv', path, 'docs/retired-authority.json');
      else git('rm', path);
      const result = classifyGitChanges({ cwd: directory, base, head: commit() });
      expect(result.complete).toBe(true);
      expect(result.paths).toContain(path);
      expect(result.flags).toMatchObject({ server: true, fifo5: true });
    });
  });

  it('exports the flag through the existing immutable change-detection job', () => {
    expect(ci.jobs.changes.outputs.fifo5).toBe('${{ steps.f.outputs.fifo5 }}');
    expect(ci.jobs.accounting_postgres.if).toContain("needs.changes.outputs.server == 'true'");
  });

  it('runs the wrapper selftest and real FIFO5 qualification once in the accounting job', () => {
    const steps = ci.jobs.accounting_postgres.steps.filter((step: { run?: string }) =>
      step.run?.includes('scripts/ci/test-spin-expiry-postgres.py')
    );
    expect(steps).toHaveLength(1);
    const step = steps[0];
    expect(step.if).toBe(
      "github.event_name == 'schedule' || needs.changes.result != 'success' || needs.changes.outputs.fifo5 != 'false'"
    );
    expect(step.run.trim().split('\n')).toEqual([
      'python3 scripts/ci/test-spin-expiry-postgres.py --self-test',
      'python3 scripts/ci/test-spin-expiry-postgres.py',
    ]);
    expect(step.env).toEqual({
      PG_BIN: '/usr/lib/postgresql/17/bin',
      FIFO5_PG17_PROVIDER_DIR: '${{ vars.FIFO5_PG17_PROVIDER_DIR }}',
      FIFO5_PG17_PROVIDER_SHA256: '${{ vars.FIFO5_PG17_PROVIDER_SHA256 }}',
    });
    expect(step).not.toHaveProperty('continue-on-error');
    expect(ci.jobs.accounting_postgres['runs-on']).toEqual([
      'self-hosted',
      'smarter-local-linux-arm64',
    ]);
    expect(ci.jobs.accounting_postgres['timeout-minutes']).toBe(15);
  });

  it('keeps the existing server tests dependent on successful financial qualification', () => {
    expect(ci.jobs.server_shards.needs).toEqual(['changes', 'accounting_postgres']);
    expect(ci.jobs.server_shards.if).toContain("needs.changes.outputs.server == 'true'");
    const gate = ci.jobs.server_shards.steps.find(
      (step: { name?: string }) => step.name === 'Require successful real PostgreSQL accounting tests'
    );
    expect(gate.if).toBe("needs.accounting_postgres.result != 'success'");
    expect(gate.run).toMatch(/\bexit 1\b/);
    expect(gate).not.toHaveProperty('continue-on-error');
    const suite = ci.jobs.server_shards.steps.find(
      (step: { name?: string }) => step.name === 'Full server test suite'
    );
    expect(suite.run).toContain('npm test -- --shard="$SERVER_TEST_SHARD/4"');
    expect(suite).not.toHaveProperty('if');
  });
});

describe('required CI owns native fixture verification', () => {
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

  it('keeps compilation required after classification without waiting for native verification', () => {
    expect(ci.jobs.typecheck.name).toBe('TypeScript Check');
    expect(ci.jobs.typecheck.needs).toEqual(['typecheck_compile', 'changes', 'fixture_native']);
    expect(ci.jobs.typecheck.if).toBe("always() && github.event_name == 'pull_request'");
    expect(ci.jobs.typecheck_compile.needs).toBe('changes');
    expect(ci.jobs.typecheck_compile.if).toBe(
      "${{ !cancelled() && github.event_name == 'pull_request' }}"
    );
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
