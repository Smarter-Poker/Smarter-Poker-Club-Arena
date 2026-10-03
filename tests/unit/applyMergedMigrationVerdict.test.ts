/**
 * The applier's verdict survives its own failure.
 *
 * scripts/ci/apply-recorded-migration.mjs is careful to separate three
 * outcomes - 0 APPLIED/ALREADY-APPLIED, 1 REFUSED, 3 UNKNOWN - because
 * "REFUSED, nothing was sent" and "UNKNOWN, something may have been sent"
 * call for opposite next moves (CLAUDE.md 10.86 rule 1).
 *
 * The workflow threw that away. GitHub runs `run:` under `bash -e`, and the
 * step opened with `set -uo pipefail`, which does NOT clear -e. So the moment
 * the node pipeline exited non-zero the step aborted - BEFORE
 * `echo "code=..." >> $GITHUB_OUTPUT` ran. `steps.apply.outputs.code` was
 * empty, and the summary's `*)` arm reported every refusal as
 * "UNEXPECTED exit " with no number and no cause.
 *
 * Measured: run 37091212017 (2026-10-03 02:51 UTC) was refused for the
 * :50-:03 break window - the applier said so in one clear sentence - and the
 * job summary called it UNEXPECTED. An agent reading that summary has been
 * told nothing, and the cheapest thing it can reach for next is a
 * re-dispatch, which section 2 rule 2 forbids.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(
  resolve(__dirname, '../../.github/workflows/apply-merged-migration.yml'),
  'utf8'
);

const applyStep = (() => {
  const start = workflow.indexOf('      - name: Apply the migration');
  const end = workflow.indexOf('      - name: Say what happened');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
})();

const summaryStep = workflow.slice(workflow.indexOf('      - name: Say what happened'));

describe('the apply step records its exit code before it can abort', () => {
  it('clears -e, so a non-zero applier does not skip the GITHUB_OUTPUT write', () => {
    // Without this the step dies on the pipeline and writes no code at all.
    expect(applyStep).toContain('set +e');
    expect(applyStep.indexOf('set +e')).toBeLessThan(
      applyStep.indexOf('node scripts/ci/apply-recorded-migration.mjs')
    );
  });

  it('captures PIPESTATUS, writes it, and exits with it', () => {
    const capture = applyStep.indexOf('code=${PIPESTATUS[0]}');
    const write = applyStep.indexOf('echo "code=$code" >> "$GITHUB_OUTPUT"');
    const exit = applyStep.indexOf('exit "$code"');
    expect(capture).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(capture);
    // The write happens BEFORE the step hands its failure to the job.
    expect(exit).toBeGreaterThan(write);
  });

  it('never re-arms -e between the pipeline and the write', () => {
    const pipeline = applyStep.indexOf('| tee /tmp/apply.log');
    const write = applyStep.indexOf('echo "code=$code" >> "$GITHUB_OUTPUT"');
    const between = applyStep.slice(pipeline, write);
    // `set -e` may be restored only after PIPESTATUS has been captured.
    expect(between).toContain('code=${PIPESTATUS[0]}');
    expect(between.indexOf('code=${PIPESTATUS[0]}')).toBeLessThan(
      between.includes('set -e') ? between.indexOf('set -e') : Number.MAX_SAFE_INTEGER
    );
  });
});

describe('the summary names all four things it can be looking at', () => {
  it('keeps the three outcomes the applier distinguishes', () => {
    expect(summaryStep).toMatch(/0\)\s*echo .*APPLIED/);
    expect(summaryStep).toMatch(/1\)\s*echo .*REFUSED/);
    expect(summaryStep).toMatch(/3\)\s*echo .*UNKNOWN/);
  });

  it('gives "no code was recorded" its own name instead of calling it unexpected', () => {
    // 10.86 rule 1 one level up: an absent verdict is not an odd exit status,
    // and it is certainly not a reason to re-dispatch.
    expect(summaryStep).toMatch(/""\)\s*echo .*COULD NOT TELL/);
    // The empty arm must come before the catch-all, or the catch-all eats it.
    const empty = summaryStep.indexOf('"") echo');
    const wildcard = summaryStep.indexOf('*) echo');
    expect(empty).toBeGreaterThan(-1);
    expect(wildcard).toBeGreaterThan(empty);
  });

  it('still fails the job unless the verdict is 0', () => {
    expect(summaryStep).toContain('test "$code" = "0"');
  });
});
