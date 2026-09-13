import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { hash } from '../../scripts/ci/prove-retained-frontend.mjs';
import { isolatedGitEnvironment } from '../../scripts/ci/classify-club-arena-components.mjs';

const root = path.resolve(__dirname, '../..');
const publisher = parse(
  readFileSync(path.join(root, '.github/workflows/publish-club-arena.yml'), 'utf8')
);
const e2eText = readFileSync(path.join(root, '.github/workflows/post-deploy-e2e.yml'), 'utf8');
const e2e = parse(e2eText);
function publisherEligible(overrides = {}) {
  const values = {
    'needs.publish-needed.result': 'success',
    'needs.frontend-identity.result': 'success',
    'needs.build-and-store.result': 'skipped',
    'needs.frontend-identity.outputs.retained': 'true',
    'needs.client-tests.result': 'success',
    'needs.publish-needed.outputs.tests_proven': 'false',
    ...overrides,
  };
  const expression = publisher.jobs['publish-to-origin'].if
    .replace(/always\(\)/g, 'true')
    .replace(/needs\.[\w.-]+/g, (key: string) => {
      if (!(key in values)) throw new Error('unreviewed predicate context');
      return JSON.stringify(values[key as keyof typeof values]);
    });
  expect(expression.replace(/"[^"\n]*"|'[^'\n]*'|true|false|\s|==|!=|&&|\|\||[()]/g, '')).toBe('');
  return Function(`"use strict"; return (${expression});`)();
}
function executeGate(kind: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ca-frontend-gate-'));
  try {
    const native = 'Publish through the host-owned immutable transaction';
    const origin = 'Verify the origin serves this bundle';
    const standdown = 'Stand down if the origin already serves a newer bundle';
    const retention = 'Recheck the unchanged immutable frontend artifact';
    const steps = [native, origin, standdown, retention].map((name) => ({
      name,
      status: 'completed',
      conclusion: 'skipped',
    }));
    const set = (name: string, conclusion: string) => {
      steps.find((step) => step.name === name)!.conclusion = conclusion;
    };
    if (kind === 'publish') {
      set(native, 'success');
      set(origin, 'success');
      set(standdown, 'success');
    }
    if (kind === 'retain') set(retention, 'success');
    if (kind === 'standdown') set(standdown, 'success');
    if (kind === 'failed-retention') set(retention, 'failure');
    if (kind === 'missing-retention') steps.pop();
    writeFileSync(
      path.join(dir, 'jobs'),
      JSON.stringify({
        jobs: [{ name: 'publish-to-origin', status: 'completed', conclusion: 'success', steps }],
      })
    );
    writeFileSync(path.join(dir, 'output'), '');
    const step = e2e.jobs['publication-gate'].steps.find(
      (value: { id: string }) => value.id === 'origin'
    );
    const script = step.run.match(/<<'NODE'\n([\s\S]*?)\nNODE/)?.[1];
    expect(script).toBeTruthy();
    const result = spawnSync(
      process.execPath,
      ['-', path.join(dir, 'jobs'), path.join(dir, 'output')],
      { input: script, encoding: 'utf8', env: isolatedGitEnvironment() }
    );
    return { code: result.status, output: readFileSync(path.join(dir, 'output'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
describe('retained frontend keeps the existing publication and all browser coverage', () => {
  it('accepts a skipped build only behind a successful retained-artifact proof and client gate', () => {
    expect(publisherEligible()).toBe(true);
    expect(publisherEligible({ 'needs.frontend-identity.result': 'failure' })).toBe(false);
    expect(publisherEligible({ 'needs.frontend-identity.outputs.retained': 'false' })).toBe(false);
    expect(publisherEligible({ 'needs.client-tests.result': 'failure' })).toBe(false);
    expect(publisherEligible({ 'needs.client-tests.result': 'skipped' })).toBe(false);
    expect(
      publisherEligible({
        'needs.client-tests.result': 'skipped',
        'needs.publish-needed.outputs.tests_proven': 'true',
      })
    ).toBe(true);
    expect(
      publisherEligible({
        'needs.build-and-store.result': 'success',
        'needs.frontend-identity.outputs.retained': 'false',
      })
    ).toBe(true);
  });
  it.each(['publish', 'retain', 'standdown'])(
    'the actual E2E gate still runs every suite after %s',
    (kind) => {
      expect(executeGate(kind)).toEqual({ code: 0, output: 'should_run=true\n' });
    }
  );
  it.each(['failed-retention', 'missing-retention', 'unproved-skip'])(
    'the actual E2E gate refuses %s',
    (kind) => {
      const result = executeGate(kind);
      expect(result.code).not.toBe(0);
      expect(result.output).toBe('');
    }
  );
  it('runs the actual native filesystem, lock and artifact refusal tests', () => {
    const output = execFileSync('python3', ['tests/operations/native-frontend-proof.test.py'], {
      cwd: root,
      env: { ...isolatedGitEnvironment(), PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(output).toBe('');
  });
  it('preserves all production steps, report groups, cleanup and static concurrency', () => {
    // Accepted a8 browser job; independent of shallow CI checkout history.
    expect(hash(e2eText.slice(e2eText.indexOf('  production-e2e:')))).toBe(
      '233e05a589a4ce53ccece54a518e1c6c9af0265b5b63e71cef41f76d91e7feb4'
    );
    const reports = e2e.jobs['production-e2e'].steps.find(
      (step: { name: string }) => step.name === 'Did the suite actually verify production?'
    ).run;
    expect(reports.match(/e2e-report\/[\w-]+\.json/g)).toHaveLength(11);
    expect(publisher.concurrency).toEqual({
      group: 'publish-club-arena-production',
      'cancel-in-progress': false,
    });
    expect(e2eText).not.toContain('should_run=false');
  });
});
