/**
 * THE CSS BEAT GATE REQUIRES BOTH HALVES (2026-10-01).
 *
 * "CSS Beat E2E (multi-table + animations)" is a required check on main. Its
 * browser work now runs as two jobs side by side: css-beats-e2e (the beats,
 * Table Studio and the decision gate on one shared build) and
 * diamond-playfield-e2e (the real Diamond scenes, which bundle themselves).
 * The required NAME belongs to css-beats-gate, which runs no browser and
 * passes only when both halves passed.
 *
 * The danger in any aggregator is the skip. A job skipped by `needs:` reports
 * SKIPPED, and a ruleset counts a skipped required check as SATISFIED: if a
 * failed half could skip the gate, a red browser suite would merge green.
 * This law pins every piece that prevents it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(__dirname, '..');
const ci = parse(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<
    string,
    {
      name?: string;
      needs?: string | string[];
      if?: string;
      steps?: { name?: string; run?: string; env?: Record<string, string> }[];
    }
  >;
};
const REQUIRED = 'CSS Beat E2E (multi-table + animations)';
const ruleset = readFileSync(resolve(root, 'scripts/ci/apply-main-ruleset.mjs'), 'utf8');
const squash = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

describe('the CSS Beat gate requires both halves', () => {
  const gate = ci.jobs['css-beats-gate'];

  it('the required name is still required, and only the gate carries it', () => {
    expect(ruleset).toContain(`'${REQUIRED}'`);
    const carriers = Object.entries(ci.jobs).filter(([, job]) => job.name === REQUIRED);
    expect(carriers.map(([id]) => id)).toEqual(['css-beats-gate']);
  });

  it('waits for both halves and the change classifier', () => {
    expect(gate.needs).toEqual(['changes', 'css-beats-e2e', 'diamond-playfield-e2e']);
  });

  it('evaluates even when a half failed, so a failure can never skip it green', () => {
    expect(squash(gate.if)).toMatch(/^always\(\) && /);
  });

  it('is admitted exactly when each half is', () => {
    expect(squash(gate.if)).toBe(squash(ci.jobs['css-beats-e2e'].if));
    expect(squash(gate.if)).toBe(squash(ci.jobs['diamond-playfield-e2e'].if));
    // The fail-closed admission css-beats-e2e has always had.
    expect(squash(gate.if)).toContain("needs.changes.result != 'success'");
  });

  it('fails unless both results are exactly success', () => {
    const step = gate.steps!.find((s) => s.name === 'Both halves passed')!;
    expect(step.env!.BEATS_RESULT).toBe('${{ needs.css-beats-e2e.result }}');
    expect(step.env!.PLAYFIELD_RESULT).toBe('${{ needs.diamond-playfield-e2e.result }}');
    expect(step.run).toContain('[ "$BEATS_RESULT" != "success" ]');
    expect(step.run).toContain('[ "$PLAYFIELD_RESULT" != "success" ]');
    expect(step.run).toContain('exit 1');
  });

  it('each suite runs in exactly one half', () => {
    const run = (job: string) => (ci.jobs[job].steps ?? []).map((s) => s.run ?? '').join('\n');
    expect(run('css-beats-e2e')).toContain('tests/e2e/multi-table.spec.ts');
    expect(run('css-beats-e2e')).not.toContain('diamond-games-playfield.spec.ts');
    expect(run('diamond-playfield-e2e')).toContain('tests/e2e/css/diamond-games-playfield.spec.ts');
    expect(run('diamond-playfield-e2e')).not.toContain('multi-table.spec.ts');
  });
});
