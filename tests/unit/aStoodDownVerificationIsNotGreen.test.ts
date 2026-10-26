/**
 * A RUN THAT TESTED NOTHING DOES NOT SAY SUCCESS (2026-10-26).
 *
 * post-deploy-e2e.yml stands down when the publisher it listens to was
 * replaced before reaching the origin: the gate succeeds, should_run stays
 * empty and every lane skips. GitHub used to conclude that run `success`, and
 * check-main-is-green.mjs - which steps over cancelled and skipped runs because
 * they carry no verdict - read it as a pass. Failed verification 40242809027
 * followed by stand-down 40243837996 (`success`) is the measured case.
 *
 * The workflow now cancels a confirmed stand-down after its verdict recorder
 * has run, so the run reads as superseded. These cases pin that shape.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

import { classifyWorkflow, isVerdict } from '../../scripts/ci/lib/workflowVerdicts.mjs';
import { decide } from '../../scripts/ci/record-post-deploy-verdict.mjs';

const WORKFLOW_PATH = resolve(__dirname, '../../.github/workflows/post-deploy-e2e.yml');
const workflow = parse(readFileSync(WORKFLOW_PATH, 'utf8'));
const job = workflow.jobs['stood-down-is-not-green'];
const script: string = job.steps.map((step: { run?: string }) => step.run ?? '').join('\n');

describe('a stood-down post-deploy verification is never green', () => {
  it('runs only for a confirmed publisher stand-down', () => {
    const condition = String(job.if);
    expect(condition).toContain("github.event_name == 'workflow_run'");
    expect(condition).toContain("needs.publication-gate.result == 'success'");
    expect(condition).toContain("needs.publication-gate.outputs.should_run != 'true'");
    // A run that verified something, or one whose gate failed, is never retired.
    expect(condition).not.toContain("should_run == 'true'");
  });

  it('runs after the verdict recorder, so the recorder never sees a cancelled gate', () => {
    expect(job.needs).toEqual(expect.arrayContaining(['publication-gate', 'post-deploy-verdict']));
    expect(String(job.if)).toContain("needs.post-deploy-verdict.result == 'success'");
  });

  it('waits on every job a stand-down could still be running', () => {
    const others = Object.keys(workflow.jobs).filter(
      (name) => name !== 'stood-down-is-not-green' && name !== 'post-deploy-verdict'
    );
    const direct = new Set<string>([...job.needs, ...workflow.jobs['post-deploy-verdict'].needs]);
    for (const name of others) expect(direct.has(name), name).toBe(true);
  });

  it('cancels exactly its own run and holds no other write permission', () => {
    expect(job.permissions).toEqual({ actions: 'write' });
    expect(job.steps[0].env.RUN_ID).toBe('${{ github.run_id }}');
    expect(script).toContain('repos/$REPO/actions/runs/$RUN_ID/cancel');
    expect(workflow.jobs['publication-gate'].permissions.actions).toBe('read');
  });

  it('fails out loud rather than falling back to success when it cannot cancel', () => {
    const exits = script.match(/exit 1/g) ?? [];
    expect(exits.length).toBe(2);
    expect(script).not.toMatch(/exit 0/);
    expect(script).not.toContain('|| true');
  });

  it('keeps the recorder treating the stand-down as nothing to verify', () => {
    const outcome = decide(
      {
        source: 'club-arena.post-deploy-e2e',
        runId: '1',
        headSha: 'a'.repeat(40),
        gate: { name: 'gate', result: 'success', shouldRun: '' },
        lanes: [{ name: 'Client browser verification', result: 'skipped', owed: true }],
      },
      null
    );
    expect(outcome.action).toBe('none');
  });

  it('lets the red-workflow detector keep reporting the failure a stand-down follows', () => {
    const now = Date.parse('2026-10-26T00:00:00Z');
    const runs = [
      {
        name: 'Post-Deploy E2E',
        conclusion: 'cancelled',
        created_at: '2026-10-25T23:14:38Z',
        html_url: 'x',
      },
      {
        name: 'Post-Deploy E2E',
        conclusion: 'failure',
        created_at: '2026-10-25T23:00:54Z',
        html_url: 'y',
      },
    ];
    expect(isVerdict(runs[0])).toBe(false);
    expect(classifyWorkflow('Post-Deploy E2E', runs, now)?.consecutive).toBe(1);
  });
});
