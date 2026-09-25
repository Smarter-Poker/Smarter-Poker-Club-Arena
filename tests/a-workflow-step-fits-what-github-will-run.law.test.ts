/**
 * LAW: no workflow step asks GitHub to run more than it will accept.
 * ═══════════════════════════════════════════════════════════════════════════
 * GitHub's workflow syntax reference, on `jobs.<job_id>.steps[*].run`:
 * "Runs command-line programs that do not exceed 21,000 characters using the
 * operating system's shell."
 *
 * WHAT HAPPENED (2026-09-22). #5090 gave every guard in the publisher a
 * voice, which is right, and took "Publish through the host-owned immutable
 * transaction" from 17,304 characters to 24,626. Over the limit GitHub does
 * not fail the step, and does not say which step is at fault. It refuses to
 * LOAD THE WORKFLOW, and the only signals are oblique:
 *
 *   - the run is named after the file path, not `name:`;
 *   - it is created with ZERO jobs and `created_at == updated_at`;
 *   - it is created even for pushes to branches the triggers exclude,
 *     because trigger filters live in the file it could not read;
 *   - `repository_dispatch` produces no run at all;
 *   - the stored workflow name in the Actions API becomes the path.
 *
 * None of those is a message. Club Arena's only publisher was dead from
 * 19:24 UTC, every merge after it reached main and none reached production,
 * and the workflow that would have said so is the one that stopped loading.
 * That is CLAUDE.md 10.86 exactly: the estate's failure mode is a signal
 * that answers when it cannot tell.
 *
 * So the limit is measured here, where it is cheap and legible, instead of
 * being discovered by a silent publisher.
 *
 * WHO READS THIS (CLAUDE.md 10.86 rule 3). `Client Unit Tests (vitest)`, one
 * of the required contexts in the `main protection` ruleset, runs
 * `npx vitest run tests/`. A step over the limit cannot merge.
 *
 * THE HEADROOM IS NOT DECORATION. A step is reported at 90% of the limit as
 * well as over it, because the cost of finding out at the ceiling is an
 * unloadable workflow rather than a failed check, and because this defect
 * arrived as one pull request adding a few hundred characters at a time.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const ROOT = join(__dirname, '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');

/** GitHub's documented ceiling for one `run` step. */
const RUN_LIMIT = 21_000;
/** Report before the ceiling: at the ceiling the failure is unreadable. */
const CROWDED = Math.floor(RUN_LIMIT * 0.9);

interface Step {
  name?: string;
  run?: string;
}

function steps(): Array<{ file: string; job: string; step: string; length: number }> {
  const out: Array<{ file: string; job: string; step: string; length: number }> = [];
  for (const file of readdirSync(WORKFLOWS)) {
    if (!/\.ya?ml$/.test(file)) continue;
    let parsed: { jobs?: Record<string, { steps?: Step[] }> };
    try {
      parsed = parse(readFileSync(join(WORKFLOWS, file), 'utf8')) as typeof parsed;
    } catch (error) {
      /* An unreadable workflow is not a clean report (CLAUDE.md 10.86 rule 2). */
      throw new Error(`.github/workflows/${file} could not be parsed: ${String(error)}`);
    }
    for (const [job, body] of Object.entries(parsed?.jobs ?? {})) {
      (body?.steps ?? []).forEach((step, index) => {
        if (typeof step?.run !== 'string') return;
        out.push({
          file,
          job,
          step: step.name ?? `step ${index}`,
          length: step.run.length,
        });
      });
    }
  }
  return out;
}

describe('a workflow step fits what GitHub will run', () => {
  const measured = steps();

  it('found the workflows and their run steps', () => {
    /* Zero steps means the scan broke, not that the repository is clean. */
    expect(measured.length, 'no run steps were measured; the scan is broken').toBeGreaterThan(50);
    expect(
      measured.some((s) => s.file === 'publish-club-arena.yml'),
      'the publisher was not measured'
    ).toBe(true);
  });

  it('keeps every run step inside the 21,000 character limit', () => {
    const over = measured
      .filter((s) => s.length > RUN_LIMIT)
      .map((s) => `${s.file} ${s.job} / ${s.step}: ${s.length} characters`);
    expect(
      over,
      [
        'GitHub documents that a run step may not exceed 21,000 characters.',
        'Past it the workflow does not FAIL, it stops LOADING: the run is named',
        'after the file path, carries zero jobs, is created even for branches',
        'the triggers exclude, and repository_dispatch answers with no run.',
        'Club Arena lost its only publisher that way on 2026-09-22.',
        '',
        'Move the body into a file the job checks out and pipe it in, the way',
        '.github/scripts/publish-origin-activate.sh is piped to the origin.',
        'Never solve it by deleting a guard.',
      ].join('\n')
    ).toEqual([]);
  });

  it('reports a step that is getting close, before the ceiling', () => {
    const crowded = measured
      .filter((s) => s.length > CROWDED && s.length <= RUN_LIMIT)
      .map((s) => `${s.file} ${s.job} / ${s.step}: ${s.length} of ${RUN_LIMIT}`);
    expect(
      crowded,
      `A run step is past ${CROWDED} characters. Move its body into a checked-out ` +
        `script now, while the workflow still loads and this check can still speak.`
    ).toEqual([]);
  });
});
