/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A SKIPPED RUN IS NOT A GREEN RUN
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `check-main-is-green.mjs` exists so that a workflow which is red on `main` and
 * gates nothing still reaches a person. It read the single newest run per
 * workflow and alarmed only when that run's conclusion was the literal string
 * `failure`. Its own green line said what it was really doing:
 *
 *     "OK - every workflow's latest run on main is green or neutral."
 *
 * Neutral counted as health.
 *
 * MEASURED 2026-09-09. `Post-Deploy E2E (production)` - the suite that checks
 * the LIVE site after every publish - had failed **24 times in 21 hours with no
 * success at all**, and the detector had never named it. It is a `workflow_run`
 * listener with a concurrency group, so its runs are mostly `skipped` (the
 * publish it listens for ended in something other than success) or `cancelled`
 * (a newer run took the lock). In a 300-run window it had 46 runs, 7 of which
 * carried a verdict, and all 7 were failures - while the newest run, the only
 * one the detector read, was `cancelled`.
 *
 * So the guard built to stop exactly this failure mode was blind to it, in the
 * one repo where the failing suite is the only thing looking at production.
 *
 * These cases pin the rule that fixes it: only a run that reached a VERDICT is
 * evidence, `skipped`/`cancelled`/`neutral` are stepped over rather than
 * believed, and `timed_out`/`startup_failure` are failures too - the old
 * equality test on 'failure' let both through.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  BAD_CONCLUSIONS,
  classifyWorkflow,
  collectActiveWorkflowRuns,
  issueCarriesWorkflowAlarm,
  MAIN_HEALTH_READER_LABEL,
  redWorkflows,
  verdictRuns,
  workflowAlarmMarker,
} from '../scripts/ci/lib/workflowVerdicts.mjs';

const REPO_ROOT = resolve(__dirname, '..');
const CHECKER = resolve(REPO_ROOT, 'scripts/ci/check-main-is-green.mjs');

const NOW = Date.parse('2026-09-09T12:00:00Z');
/** Newest first, one run per hour going back. */
const run = (conclusion: string, hoursAgo: number, name = 'W') => ({
  name,
  conclusion,
  created_at: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
  html_url: `https://example.invalid/${conclusion}/${hoursAgo}`,
});

describe('only a run that reached a verdict is evidence', () => {
  it('reports a workflow whose newest run is cancelled but whose newest VERDICT failed', () => {
    // The measured Post-Deploy E2E shape: a wall of no-ops over real failures.
    const list = [
      run('cancelled', 1),
      run('cancelled', 2),
      run('skipped', 3),
      run('skipped', 4),
      run('failure', 5),
      run('failure', 6),
    ];

    const verdict = classifyWorkflow('Post-Deploy E2E (production)', list, NOW);

    expect(verdict, 'a wall of skips hid two real failures').not.toBeNull();
    expect(verdict!.consecutive).toBe(2);
    expect(verdict!.hours).toBeCloseTo(6, 5);
  });

  it('steps over a skip between two failures instead of resetting the clock', () => {
    // The old walk did `if (r.conclusion !== 'failure') break`, so ONE skip in
    // the middle reported 1 consecutive failure minutes old, and the threshold
    // then filed it as a fresh transient for ever.
    const list = [run('failure', 1), run('skipped', 2), run('failure', 10)];

    const verdict = classifyWorkflow('W', list, NOW)!;

    expect(verdict.consecutive).toBe(2);
    expect(verdict.hours).toBeCloseTo(10, 5);
  });

  it('stays quiet when the newest verdict is a success, however many old failures sit behind it', () => {
    const list = [run('cancelled', 1), run('success', 2), run('failure', 3), run('failure', 4)];

    expect(classifyWorkflow('W', list, NOW)).toBeNull();
  });

  it('counts timed_out and startup_failure as red, which the old equality test did not', () => {
    expect(BAD_CONCLUSIONS.has('timed_out')).toBe(true);
    expect(BAD_CONCLUSIONS.has('startup_failure')).toBe(true);

    expect(classifyWorkflow('W', [run('timed_out', 1)], NOW)).not.toBeNull();
    expect(classifyWorkflow('W', [run('startup_failure', 1)], NOW)).not.toBeNull();
  });

  it('does not alarm on a workflow the window holds no verdict for', () => {
    // No evidence is a question, not an alarm. Paging on it would make every
    // path-filtered workflow permanently red.
    const list = [run('skipped', 1), run('cancelled', 2), run('skipped', 3)];

    expect(verdictRuns(list)).toHaveLength(0);
    expect(classifyWorkflow('W', list, NOW)).toBeNull();
  });
});

describe('the reported duration does not claim more than the window supports', () => {
  it('marks the run window as limiting when every verdict in it is bad', () => {
    const verdict = classifyWorkflow('W', [run('failure', 1), run('failure', 9)], NOW)!;

    expect(verdict.windowLimited, 'no success in the window, so the rot started earlier').toBe(
      true
    );
  });

  it('does not mark it when a green run bounds the failure', () => {
    const verdict = classifyWorkflow('W', [run('failure', 1), run('success', 9)], NOW)!;

    expect(verdict.windowLimited).toBe(false);
    expect(verdict.lastGreen).toBe(new Date(NOW - 9 * 3_600_000).toISOString());
  });
});

describe('grouping keeps workflows apart', () => {
  it('classifies each workflow on its own runs', () => {
    const runs = [
      run('cancelled', 1, 'Noisy'),
      run('failure', 2, 'Noisy'),
      run('success', 3, 'Quiet'),
      run('failure', 4, 'Quiet'),
    ];

    const red = redWorkflows(runs, NOW).map((r) => r.name);

    expect(red).toEqual(['Noisy']);
  });
});

describe('the inventory is per active workflow, not one noisy global window', () => {
  it('fetches the latest main verdict for a low-frequency active workflow', async () => {
    const calls: string[] = [];
    const api = async (path: string) => {
      calls.push(path);
      if (path.includes('/actions/workflows?')) {
        return {
          total_count: 2,
          workflows: [
            { id: 41, name: 'Low Frequency Audit', state: 'active' },
            { id: 42, name: 'Retired Audit', state: 'disabled_manually' },
          ],
        };
      }
      if (path.includes('/actions/workflows/41/runs?')) {
        return { workflow_runs: [run('failure', 72, 'API supplied stale name')] };
      }
      throw new Error(`unexpected API path: ${path}`);
    };

    const inventory = await collectActiveWorkflowRuns(
      api,
      'Smarter-Poker/Smarter-Poker-Club-Arena',
      'main'
    );

    expect(inventory.workflows.map((workflow) => workflow.name)).toEqual(['Low Frequency Audit']);
    expect(inventory.runs).toHaveLength(1);
    expect(inventory.runs[0].name).toBe('Low Frequency Audit');
    expect(redWorkflows(inventory.runs, NOW).map((verdict) => verdict.name)).toEqual([
      'Low Frequency Audit',
    ]);
    expect(calls.some((path) => path.includes('/actions/runs?'))).toBe(false);
  });

  it('refuses an all-green answer when any active workflow has no readable verdict', async () => {
    const api = async (path: string) => {
      if (path.includes('/actions/workflows?')) {
        return { total_count: 1, workflows: [{ id: 9, name: 'Unreadable', state: 'active' }] };
      }
      return { workflow_runs: [run('skipped', 1)] };
    };

    await expect(
      collectActiveWorkflowRuns(api, 'Smarter-Poker/Smarter-Poker-Club-Arena', 'main')
    ).rejects.toThrow(/no completed verdict/i);
  });

  it('treats a PR-only active workflow with zero main runs as not applicable', async () => {
    const api = async (path: string) => {
      if (path.includes('/actions/workflows?')) {
        return {
          total_count: 2,
          workflows: [
            { id: 10, name: 'Pull Request Review', state: 'active' },
            { id: 11, name: 'Main Build', state: 'active' },
          ],
        };
      }
      if (path.includes('/actions/workflows/10/runs?')) return { workflow_runs: [] };
      if (path.includes('/actions/workflows/11/runs?')) {
        return { workflow_runs: [run('success', 1)] };
      }
      throw new Error(`unexpected API path: ${path}`);
    };

    const inventory = await collectActiveWorkflowRuns(api, 'owner/repo', 'main');

    expect(inventory.notApplicable.map((workflow) => workflow.name)).toEqual([
      'Pull Request Review',
    ]);
    expect(inventory.runs.map((item) => item.name)).toEqual(['Main Build']);
  });
});

describe('a durable reader contract, not prose, makes a red workflow loud', () => {
  const workflow = 'Production Integrity Audit';
  const since = '2026-09-09T03:00:00.000Z';
  const marker = workflowAlarmMarker(workflow);
  const owned = {
    title: 'Any human title',
    body: `Incident evidence\n\n${marker}`,
    labels: [{ name: MAIN_HEALTH_READER_LABEL }],
    updated_at: '2026-09-09T04:00:00.000Z',
  };

  it('accepts only the exact marker plus exact label', () => {
    expect(issueCarriesWorkflowAlarm(owned, workflow, since)).toBe(true);
    expect(issueCarriesWorkflowAlarm({ ...owned, labels: [] }, workflow, since)).toBe(false);
    expect(issueCarriesWorkflowAlarm({ ...owned, body: workflow }, workflow, since)).toBe(false);
  });

  it('does not let another workflow marker or a stale issue suppress the alarm', () => {
    expect(issueCarriesWorkflowAlarm(owned, 'Another Workflow', since)).toBe(false);
    expect(
      issueCarriesWorkflowAlarm(
        { ...owned, updated_at: '2026-09-09T02:59:59.000Z' },
        workflow,
        since
      )
    ).toBe(false);
  });
});

describe('the detector no longer teaches the next reader that neutral is green', () => {
  const src = readFileSync(CHECKER, 'utf8');

  it('does not call a neutral latest run green', () => {
    expect(src).not.toContain('is green or neutral');
  });

  it('classifies through the shared module rather than its own inline equality test', () => {
    expect(src).toContain("from './lib/workflowVerdicts.mjs'");
    expect(src).not.toContain("latest.conclusion !== 'failure'");
  });

  it('does not use the repository-wide run window or fuzzy issue text as authority', () => {
    expect(src).not.toContain('/actions/runs?branch=');
    expect(src).toContain('collectActiveWorkflowRuns');
    expect(src).toContain('issueCarriesWorkflowAlarm');
    expect(src).not.toContain('hay.includes(needle)');
  });
});
