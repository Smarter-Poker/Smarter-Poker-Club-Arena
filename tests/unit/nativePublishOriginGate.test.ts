import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const root = resolve(__dirname, '../..');
const workflow = parse(
  readFileSync(join(root, '.github/workflows/publish-club-arena.yml'), 'utf8')
);
const preparation = parse(
  readFileSync(join(root, '.github/workflows/publish-club-arena-client.yml'), 'utf8')
);
const transaction = parse(
  readFileSync(join(root, '.github/workflows/publish-club-arena-transaction.yml'), 'utf8')
);
const target = '1'.repeat(40);
const other = '2'.repeat(40);

function eligible(verifiedSha: string, overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'vars.CAPGO_OTA_ENABLED': 'true',
    'inputs.target_sha': target,
    'inputs.build_result': 'success',
    'needs.publish-to-origin.result': 'success',
    'needs.publish-to-origin.outputs.verified_sha': verifiedSha,
    'inputs.client_result': 'success',
    'inputs.tests_proven': 'false',
    ...overrides,
  };
  // Evaluate the actual job predicate, with only this documented expression
  // subset accepted. A new operator/context needs an explicit test review.
  const expression = transaction.jobs['publish-to-app'].if
    .replace(
      /github\.repository_id == '1132369872' && github\.ref == 'refs\/heads\/main' && github\.workflow_ref == format\('\{0\}\/\.github\/workflows\/publish-club-arena\.yml@refs\/heads\/main', github\.repository\) && \(github\.event_name == 'push' \|\| github\.event_name == 'repository_dispatch'\)/,
      'true'
    )
    .replace(/always\(\)/g, 'true')
    .replace(/(?:vars|needs|inputs)\.[a-zA-Z0-9_.-]+/g, (name: string) => {
      if (!(name in values)) throw new Error('Unreviewed workflow context: ' + name);
      return JSON.stringify(values[name]);
    });
  expect(expression.replace(/"[^"\n]*"|'[^'\n]*'|true|false|\s|==|!=|&&|\|\||[()]/g, '')).toBe('');
  return Function('"use strict"; return (' + expression + ');')() as boolean;
}

function runOriginVerification(liveSha: string) {
  const dir = mkdtempSync(join(tmpdir(), 'native-publish-origin-'));
  try {
    const step = transaction.jobs['publish-to-origin'].steps.find(
      (item: { name: string }) => item.name === 'Verify the origin serves this bundle'
    );
    expect(step.id).toBe('verified');
    expect(step.if).toBe("steps.verdict.outputs.verdict == 'publish'");
    expect(transaction.jobs['publish-to-origin'].outputs.verified_sha).toBe(
      '${{ steps.verified.outputs.sha }}'
    );
    const command = step.run.replace('${{ steps.verdict.outputs.ours }}', target);
    expect(command).not.toContain('${{');
    // Run the committed shell. Only transport and delay are substituted:
    // the JSON parsing, equality check, output emission and exit are real.
    writeFileSync(
      join(dir, 'curl'),
      '#!/bin/sh\nprintf \'{"ca_sha":"%s"}\\n\' "$FIXTURE_LIVE_SHA"\n',
      { mode: 0o755 }
    );
    writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', command], {
      cwd: root,
      env: {
        PATH: dir + ':' + (process.env.PATH ?? '/usr/bin:/bin'),
        FIXTURE_LIVE_SHA: liveSha,
        ORIGIN_URL: 'https://origin.invalid',
        PUBLIC_URL: 'https://public.invalid',
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      },
      encoding: 'utf8',
      // The real shell performs 120 JSON interpreter checks on mismatch.
      // Allow the measured concurrent-run cost without changing its loop or assertions.
      timeout: 15_000,
    });
    return { status: result.status, output: readFileSync(output, 'utf8'), error: result.error };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('native publishing requires the exact origin verification', () => {
  it('rejects a successful stand-down that never verified the old target', () => {
    expect(eligible('')).toBe(false);
    expect(eligible('', { 'inputs.target_sha': '' })).toBe(false);
  });

  it('accepts the exact verified target and rejects a different one', () => {
    expect(eligible(target)).toBe(true);
    expect(eligible(other)).toBe(false);
  });

  it('uses the same conservative selector on the entire verified published backlog', () => {
    const client = preparation.jobs['client-tests'];
    const checkout = client.steps.find(
      (step: { uses?: string }) => step.uses === 'actions/checkout@v4'
    );
    expect(checkout.with.ref).toBe('${{ inputs.target_sha }}');
    expect(checkout.with['fetch-depth']).toBe(0);
    expect(checkout.with.filter).toBe('blob:none');
    const tests = client.steps.find((step: { name?: string }) =>
      step.name?.startsWith('Client tests must pass')
    );
    expect(tests.env.CI_HEAD_SHA).toBe('${{ inputs.target_sha }}');
    expect(tests.env.CI_BASE_SHA).toBe('${{ inputs.selection_base }}');
    expect(workflow.jobs['client-publication'].with.selection_base).toBe(
      '${{ needs.publish-needed.outputs.selection_base }}'
    );
    expect(workflow.jobs['publish-needed'].outputs.selection_base).toBe(
      '${{ steps.selection-base.outputs.base_sha }}'
    );
    expect(
      workflow.jobs['publish-needed'].steps.find(
        (step: { id?: string }) => step.id === 'selection-base'
      ).if
    ).toBe("steps.target.outputs.component == 'client'");
    expect(tests.run).toContain(
      'node scripts/ci/ui-test-selection.mjs unit --shard=${{ matrix.shard }}/16'
    );
    expect(tests.run).not.toMatch(/origin\/main|github\.event\.before|continue-on-error/);
    const ci = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
    expect(client.strategy).toEqual({
      'fail-fast': true,
      matrix: { shard: Array.from({ length: 16 }, (_, index) => index + 1) },
    });
    expect(ci.jobs.unit_shards.strategy.matrix.shard).toEqual([1, 2, 3, 4]);
    const workers = 4;
    expect(client.env.VITEST_MAX_THREADS).toBe(workers);
    expect(ci.jobs.unit_shards.env.VITEST_MAX_THREADS).toBe(workers);
    expect(preparation.jobs.production.concurrency).toEqual({
      group: 'publish-club-arena-production',
      'cancel-in-progress': false,
    });
  });

  it('preserves the proved-tree client-test fast path', () => {
    // The proof reads the source PR and its checks with this job's token.
    // Missing read permissions returns 403 and repeats the already-passed suite.
    expect(workflow.jobs['publish-needed'].permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      checks: 'read',
      actions: 'read',
    });
    expect(
      eligible(target, {
        'inputs.client_result': 'skipped',
        'inputs.tests_proven': 'true',
      })
    ).toBe(true);
    expect(
      eligible('', {
        'inputs.client_result': 'skipped',
        'inputs.tests_proven': 'true',
      })
    ).toBe(false);
  });

  it.each([
    ['disabled account', { 'vars.CAPGO_OTA_ENABLED': '' }],
    ['failed build', { 'inputs.build_result': 'failure' }],
    ['failed origin', { 'needs.publish-to-origin.result': 'failure' }],
    ['failed tests', { 'inputs.client_result': 'failure' }],
    ['unproved skipped tests', { 'inputs.client_result': 'skipped' }],
  ])('still refuses %s', (_label, overrides) => {
    expect(eligible(target, overrides)).toBe(false);
  });

  it('the actual HTTP verification shell emits evidence only for the matched SHA', () => {
    const matched = runOriginVerification(target);
    expect(matched.error).toBeUndefined();
    expect(matched.status).toBe(0);
    expect(matched.output).toBe('sha=' + target + '\n');
    const mismatched = runOriginVerification(other);
    expect(mismatched.error).toBeUndefined();
    expect(mismatched.status).toBe(1);
    expect(mismatched.output).toBe('');
    // In the 302-file hook, the wrong-SHA child timed out at 5s while
    // completing 12 real two-origin parser attempts. Keep every refusal and
    // production timeout unchanged; allow each isolated child 15s and the
    // parent 45s for both authoritative outcomes plus assertion/cleanup.
  }, 45_000);

  it('the local template and publisher do not accept paid error telemetry configuration', () => {
    const template = readFileSync(join(root, '.env.example'), 'utf8');
    const build = preparation.jobs['build-and-store'].steps.find(
      (item: { name: string }) => item.name === 'Build Club Arena'
    );
    expect(template).not.toMatch(
      new RegExp(String.raw`^\s*(?:VITE_)?${['SEN', 'TRY'].join('')}_\w+\s*=`, 'm')
    );
    expect(Object.keys(build.env).filter((name) => name.includes(['SEN', 'TRY'].join('')))).toEqual(
      []
    );
  });
});
