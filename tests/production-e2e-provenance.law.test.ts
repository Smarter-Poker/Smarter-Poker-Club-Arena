import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  classifyTrustedLineage,
  readBuildInfoSha,
  requireUnchangedBuildInfoSha,
} from '../scripts/ci/production-e2e-provenance.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const CLI = resolve(process.cwd(), 'scripts/ci/production-e2e-provenance.mjs');

describe('production E2E uses exact trusted provenance', () => {
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
