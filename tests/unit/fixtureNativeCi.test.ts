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
    const upload = steps.find((step: { name?: string }) => step.name === 'Retain BBJ accounting receipts');
    expect(invoke.run).toContain('test_retain_evidence.py');
    expect(invoke.run).toContain('python3 scripts/ci/test-bbj-bank-replay.py');
    expect(invoke['continue-on-error']).toBeUndefined();
    const timing = steps.find((step: { id?: string }) => step.id === 'bbj_timing');
    expect(ci.jobs.accounting_postgres.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(timing.env.GH_TOKEN).toBe('${{ github.token }}');
    expect(invoke.env.GH_TOKEN).toBeUndefined();
    expect(invoke.env.GITHUB_TOKEN).toBeUndefined();
    expect(invoke.env.BBJ_JOB_TIMING_FILE).toBe('${{ runner.temp }}/bbj-job-timing-${{ github.run_id }}-${{ github.run_attempt }}.json');

    expect(receipt.if).toBe("always() && (steps.bbj.outcome != 'skipped' || steps.bbj_timing.outcome == 'failure' || steps.bbj_timing.outcome == 'cancelled')");
    expect(receipt.env.BBJ_STEP_OUTCOME).toBe('${{ steps.bbj.outcome }}');
    expect(upload.if).toBe("always() && steps.bbj_evidence.outputs.ready == 'true'");
    expect(upload.uses).toBe('actions/upload-artifact@v4');
    expect(upload.with.path).toBe('artifacts/bbj-bank-replay/');
    expect(upload.with['if-no-files-found']).toBe('error');
    expect(upload.with['retention-days']).toBe(3);
    expect(upload['continue-on-error']).toBeUndefined();
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
