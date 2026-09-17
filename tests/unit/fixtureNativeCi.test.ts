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
          if (operation === 'renamed') git('mv', '--', path, relocated[index]);
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
    'scripts/qualification/unrelated.sql',
    'supabase/components/unrelated.sql',
    'supabase/components/spin-expiry-lock-order.sql.bak',
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
    expect(ci.jobs.server_shards.needs).toContain('accounting_postgres');
    const gate = ci.jobs.server_shards.steps.find(
      (step: { name?: string }) =>
        step.name === 'Require successful real PostgreSQL accounting tests'
    );
    expect(gate.if).toBe("needs.accounting_postgres.result != 'success'");
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
