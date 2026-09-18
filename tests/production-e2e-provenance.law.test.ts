import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  classifyTrustedLineage,
  readBuildInfoSha,
  requireUnchangedBuildInfoSha,
  requireReadyEngineSha,
  readReadyEngineSha,
} from '../scripts/ci/production-e2e-provenance.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const CLI = resolve(process.cwd(), 'scripts/ci/production-e2e-provenance.mjs');

// Exact metadata shape from publisher 35288647065: its selected artifact is
// newer than the workflow trigger. Neither field is interchangeable.
const SOURCE_RUN = '35288647065';
const REPOSITORY_ID = '1132369872';
const TRIGGER = '4dc07c7f661803d4a496bd51bf077c8503d60236';
const SELECTED = '414c12e1654fcd6615bce292590f83d7dc3c18c9';
const selectedArtifact = () => ({
  id: 10525666396,
  name: `club-arena-dist-${SELECTED}`,
  expired: false,
  workflow_run: {
    id: Number(SOURCE_RUN),
    head_sha: TRIGGER,
    head_branch: 'main',
    repository_id: Number(REPOSITORY_ID),
    head_repository_id: Number(REPOSITORY_ID),
  },
});
const artifactPayload = () => ({ total_count: 1, artifacts: [selectedArtifact()] });
const selectArtifact = (payload: unknown, args = [SOURCE_RUN, TRIGGER, REPOSITORY_ID]) =>
  spawnSync(process.execPath, [CLI, 'publisher-artifact', ...args], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
  });

describe('the publisher hands its selected artifact to post-deploy verification', () => {
  it('returns the exact same-run selected SHA instead of the older trigger SHA', () => {
    const result = selectArtifact(artifactPayload());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(SELECTED);
    expect(result.stdout.trim()).not.toBe(TRIGGER);
  });

  it('allows unrelated same-run reports without choosing them as the client bundle', () => {
    const payload = artifactPayload();
    payload.total_count = 2;
    payload.artifacts.push({ ...selectedArtifact(), name: 'browser-report' });
    expect(selectArtifact(payload).stdout.trim()).toBe(SELECTED);
  });

  it.each([
    ['malformed JSON', '{'],
    ['an unreadable API response', { message: 'Resource not accessible by integration' }],
    ['missing bundle', { total_count: 0, artifacts: [] }],
    ['incomplete pagination', { total_count: 2, artifacts: [selectedArtifact()] }],
    ['duplicate bundles', { total_count: 2, artifacts: [selectedArtifact(), selectedArtifact()] }],
  ])('refuses %s without substituting the trigger or current live revision', (_name, payload) => {
    const result = selectArtifact(payload);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  it.each([
    [
      'expired bundle',
      (a: ReturnType<typeof selectedArtifact>) => {
        a.expired = true;
      },
    ],
    [
      'malformed artifact SHA',
      (a: ReturnType<typeof selectedArtifact>) => {
        a.name = 'club-arena-dist-414c12e';
      },
    ],
    [
      'different run',
      (a: ReturnType<typeof selectedArtifact>) => {
        a.workflow_run.id += 1;
      },
    ],
    [
      'different trigger',
      (a: ReturnType<typeof selectedArtifact>) => {
        a.workflow_run.head_sha = A;
      },
    ],
    [
      'PR validation branch',
      (a: ReturnType<typeof selectedArtifact>) => {
        a.workflow_run.head_branch = 'feature/pr';
      },
    ],
    [
      'different repository',
      (a: ReturnType<typeof selectedArtifact>) => {
        a.workflow_run.repository_id += 1;
      },
    ],
    [
      'fork source',
      (a: ReturnType<typeof selectedArtifact>) => {
        a.workflow_run.head_repository_id += 1;
      },
    ],
  ])('refuses %s', (_name, mutate) => {
    const payload = artifactPayload();
    mutate(payload.artifacts[0]);
    const result = selectArtifact(payload);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  it('requires exact expected run, trigger and repository arguments', () => {
    for (const args of [
      ['', TRIGGER, REPOSITORY_ID],
      [SOURCE_RUN, '4dc07c7', REPOSITORY_ID],
      [SOURCE_RUN, TRIGGER, ''],
    ]) {
      expect(selectArtifact(artifactPayload(), args).status).not.toBe(0);
    }
  });

  it('passes only source-run artifact metadata through the existing publication gate', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '.github/workflows/post-deploy-e2e.yml'),
      'utf8'
    );
    const gate = workflow.slice(
      workflow.indexOf('  publication-gate:'),
      workflow.indexOf('  seo-contract:')
    );
    expect(gate).toContain('client_target_sha: ${{ steps.client-target.outputs.sha }}');
    expect(gate).toContain('actions/runs/$SOURCE_RUN_ID/artifacts?per_page=100');
    expect(gate).toContain(
      'publisher-artifact "$SOURCE_RUN_ID" "$SOURCE_TRIGGER_SHA" "$REPOSITORY_ID"'
    );
    expect(gate).toContain('SOURCE_TRIGGER_SHA: ${{ github.event.workflow_run.head_sha }}');
    expect(gate).toContain('REPOSITORY_ID: ${{ github.repository_id }}');
    expect(gate).not.toContain('continue-on-error');
  });
});

describe('production E2E uses exact trusted provenance', () => {
  it('waits for maintenance and resume waves before creating live-table fixtures', () => {
    const full = readFileSync(
      resolve(process.cwd(), '.github/workflows/post-deploy-e2e.yml'),
      'utf8'
    );
    const live = full.slice(full.indexOf('  live-table-e2e:'));
    const wait = live.indexOf('- name: Wait for the same engine to resume gameplay');
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThan(live.indexOf('- name: Provision an isolated production E2E account'));
    expect(
      live.slice(wait, live.indexOf('- name: Provision an isolated production E2E account'))
    ).toContain('node scripts/ci/await-engine-gameplay.mjs "$EXPECTED_ENGINE_SHA"');
    expect(full.slice(0, full.indexOf('  live-table-e2e:'))).not.toContain('await-engine-gameplay');
  });

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

  it('keeps the exact engine prerequisite in its own job before its browser fixtures', () => {
    const fullWorkflow = readFileSync(
      resolve(process.cwd(), '.github/workflows/post-deploy-e2e.yml'),
      'utf8'
    );
    const workflow = fullWorkflow.slice(fullWorkflow.indexOf('  live-table-e2e:'));
    const gate = workflow.indexOf(
      '- name: Require the exact engine before opening production browser fixtures'
    );
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(workflow.indexOf('- name: Install Chromium and WebKit'));
    expect(gate).toBeLessThan(
      workflow.indexOf('- name: Provision an isolated production E2E account')
    );
    const stanza = workflow.slice(gate, workflow.indexOf('- name: Install Chromium and WebKit'));
    expect(stanza).toContain('set -euo pipefail');
    expect(stanza).toContain('curl -fsS --max-time 20');
    expect(stanza).toContain('engine-ready "$EXPECTED_ENGINE_SHA"');
    expect(stanza).not.toContain('continue-on-error');
    expect(stanza).not.toContain('|| true');
  });

  it('records the healthy serving engine without substituting an unshipped main commit', () => {
    expect(
      readReadyEngineSha(JSON.stringify({ releaseSha: B, running: true, liveness: 'ok' }))
    ).toBe(B);
    for (const value of [
      { releaseSha: B, running: false, liveness: 'ok' },
      { releaseSha: 'abc123', running: true, liveness: 'ok' },
      { releaseSha: B, running: true, liveness: 'bad' },
    ]) {
      expect(() => readReadyEngineSha(JSON.stringify(value))).toThrow();
    }
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
