import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const directory = resolve(process.cwd(), '.github/workflows');
// The tournament flag cards (V53) share the same hosted-capacity bound.
const files = readdirSync(directory).filter((file) =>
  /^horse-(phase\d+-strength-league|tournament-flag-cards)\.yml$/.test(file)
);
const read = (file: string) => parse(readFileSync(resolve(directory, file), 'utf8'));
const capacityGroup = 'horse-strength-hosted-capacity';

describe('Horse strength demand leaves hosted capacity for required checks and publishing', () => {
  it('bounds all phases and variants together, retaining pending qualifications', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      const workflow = read(file);
      // A per-phase, per-SHA or per-variant group multiplies the runner cap.
      expect(workflow.concurrency, file).toEqual({
        group: capacityGroup,
        queue: 'max',
        'cancel-in-progress': false,
      });
      expect(Object.keys(workflow.on), file).toEqual(['workflow_dispatch']);
      expect(workflow.jobs.league.strategy['max-parallel'], file).toBe(8);
      expect(workflow.jobs.league.strategy['fail-fast'], file).toBe(false);
      // The plan finishes before the matrix starts and the assembler starts
      // after it ends, so neither can add to the eight-runner bound. No
      // independent job may escape that bound.
      expect(Object.keys(workflow.jobs).sort(), file).toEqual(
        file.includes('phase8-') ? ['league'] : ['assemble', 'league', 'plan']
      );
      if (workflow.jobs.assemble) {
        expect(workflow.jobs.assemble.needs, file).toEqual(['plan', 'league']);
      }
      if (workflow.jobs.plan) {
        expect(workflow.jobs.league.needs, file).toBe('plan');
        expect(workflow.jobs.league.strategy.matrix, file).toBe(
          '${{ fromJSON(needs.plan.outputs.matrix) }}'
        );
        const plan = workflow.jobs.plan.steps.map((s: { run?: string }) => s.run || '').join('\n');
        expect(plan, file).toContain('include.length !==');
        expect(plan, file).toContain('git merge-base --is-ancestor');
      } else {
        expect(workflow.jobs.league.strategy.matrix).toEqual({
          seed: [8101101, 8102203, 8103307],
          objective: ['mtt', 'sng', 'spin', 'satellite', 'pko', 'mystery'],
        });
      }
      const steps = workflow.jobs.league.steps;
      expect(
        steps.find((s: { uses?: string }) => s.uses === 'actions/checkout@v4').with.ref,
        file
      ).toBe('${{ inputs.source_sha }}');
      const upload = steps.find((s: { uses?: string }) => s.uses === 'actions/upload-artifact@v4');
      expect(upload.if, file).toBe('always()');
      expect(upload.with['if-no-files-found'], file).toBe('error');
      expect(workflow.jobs.league['continue-on-error'], file).toBeUndefined();
    }
  });

  it('does not put client publication or required CI behind the league queue', () => {
    for (const file of ['ci.yml', 'publish-club-arena.yml', 'post-deploy-e2e.yml']) {
      const workflow = read(file);
      expect(JSON.stringify(workflow.concurrency) || '', file).not.toContain(capacityGroup);
      for (const job of Object.values(workflow.jobs) as { concurrency?: unknown }[]) {
        expect(JSON.stringify(job.concurrency) || '', file).not.toContain(capacityGroup);
      }
    }
  });
});
