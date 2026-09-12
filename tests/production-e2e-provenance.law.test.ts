import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  classifyTrustedLineage,
  readBuildInfoSha,
  requireUnchangedBuildInfoSha,
  requireReadyEngineSha,
} from '../scripts/ci/production-e2e-provenance.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const CLI = resolve(process.cwd(), 'scripts/ci/production-e2e-provenance.mjs');

describe('production E2E uses exact trusted provenance', () => {
  it('admits only the exact running engine before browser fixture creation', () => {
    expect(
      requireReadyEngineSha(JSON.stringify({ releaseSha: A, running: true, liveness: 'ok' }), A)
    ).toBe(A);
  });

  it.each([
    ['an old engine', { releaseSha: B, running: true, liveness: 'ok' }],
    ['a stopped engine', { releaseSha: A, running: false, liveness: 'ok' }],
    ['coerced readiness', { releaseSha: A, running: 'true', liveness: 'ok' }],
    ['failed liveness', { releaseSha: A, running: true, liveness: 'stalled' }],
    ['a short engine SHA', { releaseSha: 'abc1234', running: true, liveness: 'ok' }],
    ['a missing engine SHA', { running: true, liveness: 'ok' }],
    ['an array', [{ releaseSha: A, running: true, liveness: 'ok' }]],
  ])('refuses %s as a certification prerequisite', (_label, value) => {
    expect(() => requireReadyEngineSha(JSON.stringify(value), A)).toThrow();
  });

  it('rejects malformed engine health and expected identity', () => {
    expect(() => requireReadyEngineSha('{', A)).toThrow();
    expect(() => requireReadyEngineSha('{}', 'abc1234')).toThrow();
  });

  it('keeps the prerequisite after schema audits and before browser installation and account creation', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '.github/workflows/post-deploy-e2e.yml'),
      'utf8'
    );
    const gate = workflow.indexOf(
      '- name: Require the exact engine before opening production browser fixtures'
    );
    expect(gate).toBeGreaterThan(
      workflow.indexOf('- name: Audit the remaining live schema from trusted code')
    );
    expect(gate).toBeLessThan(workflow.indexOf('- name: Install Chromium and WebKit'));
    const stanza = workflow.slice(gate, workflow.indexOf('- name: Install Chromium and WebKit'));
    expect(stanza).toContain('set -euo pipefail');
    expect(stanza).toContain('curl -fsS --max-time 20');
    expect(stanza).toContain('engine-ready "$EXPECTED_ENGINE_SHA"');
    expect(stanza).not.toContain('continue-on-error');
    expect(stanza).not.toContain('|| true');
  });

  it('uses the same exact engine parser from the workflow CLI', () => {
    const run = (sha: string) =>
      spawnSync(process.execPath, [CLI, 'engine-ready', A], {
        input: JSON.stringify({ releaseSha: sha, running: true, liveness: 'ok' }),
        encoding: 'utf8',
      });
    expect(run(A).status).toBe(0);
    expect(run(B).status).not.toBe(0);
  });

  it('reads one full lowercase SHA from a JSON object', () => {
    expect(readBuildInfoSha(JSON.stringify({ ca_sha: A }))).toBe(A);
  });

  it.each([
    ['malformed JSON', '{'],
    ['an array', JSON.stringify([{ ca_sha: A }])],
    ['a missing field', JSON.stringify({ sha: A })],
    ['a short SHA', JSON.stringify({ ca_sha: 'abc1234' })],
    ['an uppercase SHA', JSON.stringify({ ca_sha: 'A'.repeat(40) })],
    ['a decorated SHA', JSON.stringify({ ca_sha: `${A}x` })],
  ])('rejects %s', (_label, raw) => {
    expect(() => readBuildInfoSha(raw)).toThrow();
  });

  it('accepts a final build-info document only when production stayed on the recorded SHA', () => {
    expect(requireUnchangedBuildInfoSha(JSON.stringify({ ca_sha: A }), A)).toBe(A);
  });

  it.each([
    ['malformed final build-info', '{'],
    ['a changed final SHA', JSON.stringify({ ca_sha: B })],
  ])('rejects %s so a moving or unreadable release cannot pass', (_label, raw) => {
    expect(() => requireUnchangedBuildInfoSha(raw, A)).toThrow();
  });

  it('rejects a malformed expected SHA instead of weakening the final comparison', () => {
    expect(() => requireUnchangedBuildInfoSha(JSON.stringify({ ca_sha: A }), 'abc1234')).toThrow();
  });

  it('makes the exact workflow CLI reject malformed or changed HTTP bodies', () => {
    const run = (raw: string) =>
      spawnSync(process.execPath, [CLI, 'unchanged', A], { input: raw, encoding: 'utf8' });

    const exact = run(JSON.stringify({ ca_sha: A }));
    expect(exact.status, exact.stderr).toBe(0);
    expect(exact.stdout.trim()).toBe(A);
    expect(run(`not-json "ca_sha": "${A}"`).status).not.toBe(0);
    expect(run(JSON.stringify({ ca_sha: B })).status).not.toBe(0);
  });

  it('accepts an identical live and checkout commit without guessing', () => {
    const commitExists = vi.fn();
    const isAncestor = vi.fn();
    expect(classifyTrustedLineage(A, A, { commitExists, isAncestor })).toBe('same');
    expect(commitExists).not.toHaveBeenCalled();
    expect(isAncestor).not.toHaveBeenCalled();
  });

  it('accepts a known live ancestor', () => {
    expect(
      classifyTrustedLineage(A, B, {
        commitExists: () => true,
        isAncestor: () => true,
      })
    ).toBe('ancestor');
  });

  it('rejects an unknown production SHA', () => {
    expect(() =>
      classifyTrustedLineage(A, B, {
        commitExists: () => false,
        isAncestor: () => true,
      })
    ).toThrow('does not resolve');
  });

  it('rejects a divergent production SHA', () => {
    expect(() =>
      classifyTrustedLineage(A, B, {
        commitExists: () => true,
        isAncestor: () => false,
      })
    ).toThrow('is not an ancestor');
  });
});
