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
const target = '1'.repeat(40);
const other = '2'.repeat(40);

function eligible(verifiedSha: string, overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'vars.CAPGO_OTA_ENABLED': 'true',
    'needs.publish-needed.outputs.target_sha': target,
    'needs.build-and-store.result': 'success',
    'needs.publish-to-origin.result': 'success',
    'needs.publish-to-origin.outputs.verified_sha': verifiedSha,
    'needs.client-tests.result': 'success',
    'needs.publish-needed.outputs.tests_proven': 'false',
    ...overrides,
  };
  // Evaluate the actual job predicate, with only this documented expression
  // subset accepted. A new operator/context needs an explicit test review.
  const expression = workflow.jobs['publish-to-app'].if
    .replace(/always\(\)/g, 'true')
    .replace(/(?:vars|needs)\.[a-zA-Z0-9_.-]+/g, (name: string) => {
      if (!(name in values)) throw new Error('Unreviewed workflow context: ' + name);
      return JSON.stringify(values[name]);
    });
  expect(expression.replace(/"[^"\n]*"|'[^'\n]*'|true|false|\s|==|!=|&&|\|\||[()]/g, '')).toBe('');
  return Function('"use strict"; return (' + expression + ');')() as boolean;
}

function runOriginVerification(liveSha: string) {
  const dir = mkdtempSync(join(tmpdir(), 'native-publish-origin-'));
  try {
    const step = workflow.jobs['publish-to-origin'].steps.find(
      (item: { name: string }) => item.name === 'Verify the origin serves this bundle'
    );
    expect(step.id).toBe('verified');
    expect(step.if).toBe("steps.verdict.outputs.verdict == 'publish'");
    expect(workflow.jobs['publish-to-origin'].outputs.verified_sha).toBe(
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
      timeout: 5000,
    });
    return { status: result.status, output: readFileSync(output, 'utf8'), error: result.error };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('native publishing requires the exact origin verification', () => {
  it('rejects a successful stand-down that never verified the old target', () => {
    expect(eligible('')).toBe(false);
    expect(eligible('', { 'needs.publish-needed.outputs.target_sha': '' })).toBe(false);
  });

  it('accepts the exact verified target and rejects a different one', () => {
    expect(eligible(target)).toBe(true);
    expect(eligible(other)).toBe(false);
  });

  it('preserves the proved-tree client-test fast path', () => {
    expect(
      eligible(target, {
        'needs.client-tests.result': 'skipped',
        'needs.publish-needed.outputs.tests_proven': 'true',
      })
    ).toBe(true);
    expect(
      eligible('', {
        'needs.client-tests.result': 'skipped',
        'needs.publish-needed.outputs.tests_proven': 'true',
      })
    ).toBe(false);
  });

  it.each([
    ['disabled account', { 'vars.CAPGO_OTA_ENABLED': '' }],
    ['failed build', { 'needs.build-and-store.result': 'failure' }],
    ['failed origin', { 'needs.publish-to-origin.result': 'failure' }],
    ['failed tests', { 'needs.client-tests.result': 'failure' }],
    ['unproved skipped tests', { 'needs.client-tests.result': 'skipped' }],
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
  });

  it('the non-secret local template points to the same Sentry destination as production', () => {
    const template = readFileSync(join(root, '.env.example'), 'utf8');
    const build = workflow.jobs['build-and-store'].steps.find(
      (item: { name: string }) => item.name === 'Build Club Arena'
    );
    for (const key of ['SENTRY_ORG', 'SENTRY_PROJECT']) {
      expect(template.match(new RegExp('^' + key + '=(.*)$', 'm'))?.[1]).toBe(build.env[key]);
    }
  });
});
