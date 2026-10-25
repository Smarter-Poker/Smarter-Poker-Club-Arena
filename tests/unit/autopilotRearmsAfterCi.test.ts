/**
 * PR #7780 (2026-10-23): the autopilot armed protected squash auto-merge,
 * GitHub withdrew it 17 seconds later, and nothing armed it again. A fully
 * green urgent engine fix sat unmerged for 43 minutes. The autopilot now
 * re-evaluates a same-repository PR when its required CI run passes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const raw = readFileSync(
  resolve(__dirname, '../..', '.github/workflows/agent-autopilot.yml'),
  'utf8'
);
const wf = parse(raw) as Record<string, any>;
const job = wf.jobs['queue-pr'];
const run = job.steps.find((s: any) => s.name === 'Enable protected squash auto-merge')
  .run as string;

describe('the autopilot re-arms a protected merge after CI passes', () => {
  it('listens for the required CI run completing, by native event and never a schedule', () => {
    expect(wf.on.workflow_run).toEqual({
      workflows: ['CI — Build & Type Safety'],
      types: ['completed'],
    });
    expect(wf.on.pull_request_target).toBeDefined();
    expect(wf.on.schedule).toBeUndefined();
  });

  it('only a successful same-repository run can mint merge authority', () => {
    expect(job.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(job.if).toContain(
      'github.event.workflow_run.head_repository.full_name == github.repository'
    );
    expect(job.if).toContain('github.event.pull_request.head.repo.full_name == github.repository');
  });

  it('touches only the open, non-draft PR whose head is exactly the commit CI passed', () => {
    expect(run).toContain('--head "$RUN_HEAD_BRANCH" --state open');
    expect(run).toContain('.headRefOid == \\"$RUN_HEAD_SHA\\" and .isDraft == false');
    expect(run).toMatch(/nothing to re-arm/);
  });

  it('keeps hold labels and the single queue script authoritative on both paths', () => {
    const hold = run.indexOf('*,do-not-merge,*|*,hold,*|*,wip,*');
    const resolvePr = run.indexOf('if [ -z "$PR" ]');
    expect(resolvePr).toBeGreaterThan(-1);
    expect(hold).toBeGreaterThan(resolvePr);
    expect(run.trim().endsWith('bash .github/scripts/queue-pr.sh "$REPO" "$PR"')).toBe(true);
  });

  it('serializes per PR branch, so a re-arm and a new push never race', () => {
    expect(wf.concurrency.group).toBe(
      "agent-autopilot-${{ github.event.pull_request.number || github.event.workflow_run.head_branch }}${{ github.event.action == 'closed' && '-merged' || '' }}"
    );
    // The merged-PR dispatch (a-merged-migration-is-dispatched-by-its-merger)
    // runs in its own group and is never cancelled; every other event still is.
    expect(wf.concurrency['cancel-in-progress']).toBe("${{ github.event.action != 'closed' }}");
  });
});
