import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const root = resolve(__dirname, '../..');
const ci = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
const native = parse(
  readFileSync(join(root, '.github/workflows/component-fixture-native-smoke.yml'), 'utf8')
);

function classify(files: string) {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-ci-paths-'));
  try {
    const output = join(directory, 'outputs');
    const result = spawnSync(
      'bash',
      [
        '-eu',
        '-o',
        'pipefail',
        '-c',
        `
      gh() { printf '%s\\n' "$MOCK_CHANGED_FILES"; }
      sleep() { :; }
      ${ci.jobs.changes.steps[0].run}
    `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          MOCK_CHANGED_FILES: files,
          GITHUB_OUTPUT: output,
          REPO: 'owner/repo',
          PR: '1',
        },
      }
    );
    expect(result.status, result.stderr).toBe(0);
    return Object.fromEntries(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('='))
    );
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
    'scripts/ci/fixture-native-gate.mjs',
    'tests/operations/fixture-required-ci.test.mjs',
    'tests/unit/fixtureNativeCi.test.ts',
    'package-lock.json',
  ])('classifies actual affected path %s for native execution', (path) => {
    expect(classify(path).fixture).toBe('true');
  });

  it('runs native checks when the changed-file list is unavailable', () => {
    expect(classify('').fixture).toBe('true');
  });

  it('keeps unrelated docs and application changes out of expensive fixture builds', () => {
    expect(classify('docs/example.md\nsrc/components/example.tsx').fixture).toBe('false');
  });

  it('binds the required result to compilation and the native dependency without serializing compilation', () => {
    expect(ci.jobs.typecheck.name).toBe('TypeScript Check');
    expect(ci.jobs.typecheck.needs).toEqual(['typecheck_compile', 'changes', 'fixture_native']);
    expect(ci.jobs.typecheck.if).toBe("always() && github.event_name == 'pull_request'");
    expect(ci.jobs.typecheck_compile.needs).toBeUndefined();
    expect(ci.jobs.typecheck_compile.if).toBe("github.event_name == 'pull_request'");
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
  });
});
