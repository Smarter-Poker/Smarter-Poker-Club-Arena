import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Each strength league scores its own run: the assemble job downloads every
// attempt, runs the existing assembler at the evaluated commit, and pushes
// the evidence to a new horse-evidence/* branch. Nobody downloads artifacts
// by hand, and nothing it does can reach main.
const directory = resolve(process.cwd(), '.github/workflows');
const leagues = [
  { phase: 10, prefix: 'p102', variant: 'plo4' },
  { phase: 11, prefix: 'p112', variant: '${{ inputs.variant }}' },
  { phase: 12, prefix: 'p122', variant: '${{ inputs.variant }}' },
  { phase: 13, prefix: 'p132', variant: '${{ inputs.variant }}' },
];

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};

for (const { phase, prefix, variant } of leagues) {
  const file = `horse-phase${phase}-strength-league.yml`;
  const text = readFileSync(resolve(directory, file), 'utf8');
  const workflow = parse(text);
  const job = workflow.jobs.assemble;
  const steps: Step[] = job?.steps ?? [];
  const runs = steps.map((s) => s.run || '').join('\n');

  describe(`${file} assembles its own evidence`, () => {
    it('runs after every shard once the plan succeeded', () => {
      expect(job).toBeDefined();
      expect(job.needs).toEqual(['plan', 'league']);
      expect(job.if).toBe(
        "always() && github.ref == 'refs/heads/main' && needs.plan.result == 'success'"
      );
    });

    it('holds write access only in this job; the workflow stays read-only', () => {
      expect(workflow.permissions).toEqual({ contents: 'read' });
      expect(job.permissions).toEqual({ contents: 'write' });
      for (const [name, other] of Object.entries(workflow.jobs) as [
        string,
        { permissions?: unknown },
      ][]) {
        if (name !== 'assemble') expect(other.permissions, name).toBeUndefined();
      }
    });

    it('assembles the exact evaluated commit from every attempt of this run', () => {
      const checkout = steps.find((s) => s.uses === 'actions/checkout@v4');
      expect(checkout?.with?.ref).toBe('${{ inputs.source_sha }}');
      const download = steps.find((s) => s.uses === 'actions/download-artifact@v4');
      expect(download?.with?.pattern).toBe(`${prefix}-*`);
      expect(download?.with?.['merge-multiple']).toBe(false);
      expect(runs).toContain('npm ci --ignore-scripts');
      expect(runs).toContain('npm ci --prefix server');
      expect(runs).toContain(`npx tsx scripts/phase${phase}-strength-assemble.mjs`);
      expect(runs).toContain(`BASE="docs/evidence/phase${phase}/$SHA8"`);
      if (phase !== 10) expect(runs).toContain('--variant="$VARIANT"');
      expect(runs).toContain('$GITHUB_STEP_SUMMARY');
      const assemble = steps.find((s) => s.name === 'Run the assembler');
      expect(assemble?.env?.VARIANT).toBe(variant);
    });

    it('fails visibly and pushes nothing when the assembler refuses', () => {
      const assemble = steps.find((s) => s.name === 'Run the assembler');
      expect(assemble?.run).toContain('exit "$code"');
      const push = steps.findIndex((s) => s.name === 'Push the evidence to its own branch');
      expect(push).toBeGreaterThan(steps.indexOf(assemble as Step));
      expect((steps[push] as Step & { if?: string }).if).toBeUndefined();
    });

    it('pushes only a new horse-evidence branch, never main and never a pull request', () => {
      expect(runs).toContain(
        `BRANCH="horse-evidence/phase${phase}-$VARIANT-$SHA8-run$GITHUB_RUN_ID"`
      );
      expect(runs).toContain('git push origin "HEAD:refs/heads/$BRANCH"');
      const pushes = runs.split('\n').filter((l) => /git push/.test(l));
      expect(pushes).toEqual(['git push origin "HEAD:refs/heads/$BRANCH"']);
      expect(runs).not.toMatch(/refs\/heads\/main|push[^\n]*\bmain\b|gh pr|pulls|--force/);
      // The run directory is evidence for the run, not for the release mirror.
      expect(runs).toContain('cp "$OUT/strength.json" "$MIRROR/$OUT/strength.json"');
      expect(runs).not.toMatch(/cp -r|\$MIRROR\/\$OUT\/runs/);
    });

    it('records no completion record', () => {
      expect(text).not.toMatch(/completion/i);
    });
  });
}
