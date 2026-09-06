// ---------------------------------------------------------------------------
// LAW: a wall-clock wait must fit UNDER the timeout that kills it.
//
// 2026-09-06, PR #3272. One test of 6,192 failed in CI and could not be
// reproduced locally in two full runs:
//
//   FAIL src/engine/RunItTwice.multiway.test.ts
//     > a declined offer continues the runout to a single-board completion
//   Error: Test timed out in 10000ms.
//
// The test polled for an engine event against `Date.now() + 10_000`, and
// vitest.config.ts carried `testTimeout: 10_000`. The same number. A wait that
// spends its whole budget is killed by vitest at the exact instant it would
// have given up, so the assertion that was meant to explain the failure never
// runs and CI prints a timeout that names nothing.
//
// Two separate files had independently arrived at that number, both while
// CORRECTLY de-flaking a fixed sleep into a conditional wait. Each author read
// the ceiling and used it as the budget. The waits became robust; the headroom
// became zero.
//
// The pins below make the relationship structural rather than a coincidence.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_TIMEOUT_MS, WAIT_BUDGET_MS, WAIT_POLL_MS } from './waitBudget.js';

const SERVER_ROOT = join(__dirname, '..', '..');
const SRC = join(SERVER_ROOT, 'src');

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) testFiles(p, out);
    else if (p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('the wait budget fits under the test ceiling', () => {
  it('the budget is strictly smaller than the ceiling, with real headroom', () => {
    expect(WAIT_BUDGET_MS).toBeLessThan(TEST_TIMEOUT_MS);
    // Headroom has to be enough for the throw, the stack, and the reporter to
    // run after the wait gives up. A budget one poll-interval under the ceiling
    // is arithmetically "less than" and practically the same bug.
    const headroom = TEST_TIMEOUT_MS - WAIT_BUDGET_MS;
    expect(
      headroom,
      `only ${headroom}ms between the wait budget and the ceiling. An exhausted ` +
        'wait needs room to throw its diagnostic before vitest kills the test; ' +
        'that is the entire point of this law.'
    ).toBeGreaterThanOrEqual(5_000);
    expect(WAIT_POLL_MS).toBeLessThan(WAIT_BUDGET_MS);
  });

  it('vitest.config.ts imports the ceiling instead of restating it', () => {
    const cfg = readFileSync(join(SERVER_ROOT, 'vitest.config.ts'), 'utf8');
    expect(
      cfg,
      'server/vitest.config.ts must import TEST_TIMEOUT_MS from src/testing/waitBudget.ts. ' +
        'A literal here is free to drift away from the budget the tests wait on, ' +
        'which is exactly how the two became equal.'
    ).toMatch(/TEST_TIMEOUT_MS/);
    const literal = cfg.match(/testTimeout:\s*([0-9_]+)/);
    expect(
      literal,
      `server/vitest.config.ts sets testTimeout to the literal ${literal?.[1]}. ` +
        'Import TEST_TIMEOUT_MS instead.'
    ).toBeNull();
  });

  it('no server test polls against a hardcoded deadline that races the ceiling', () => {
    const offenders: string[] = [];
    for (const file of testFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      const rel = file.replace(SERVER_ROOT + '/', '');

      // ONLY the polling shape counts. A bare `Date.now() + 60_000` is almost
      // always a FIXTURE - a deadline stamped onto a row, a bound in an
      // assertion, a jump on a mocked clock - and none of those spends wall
      // time. Judging by magnitude alone flagged seven such lines and would
      // have taught the next agent to delete the law. The bug is a deadline
      // this process then SITS ON in a loop, so require both halves:
      //
      //     const deadline = Date.now() + N;      <- declared
      //     while (!x && Date.now() < deadline)   <- and spun on
      const declared = new Map<string, { ms: number; line: number; text: string }>();
      src.split('\n').forEach((line, i) => {
        const m = line.match(/(?:const|let)\s+(\w+)\s*=\s*Date\.now\(\)\s*\+\s*([0-9_]+)/);
        if (m)
          declared.set(m[1], {
            ms: Number(m[2].replace(/_/g, '')),
            line: i + 1,
            text: line.trim(),
          });
      });
      for (const [name, d] of declared) {
        const spunOn = new RegExp(`Date\\.now\\(\\)\\s*<=?\\s*${name}\\b`).test(src);
        if (spunOn && d.ms >= TEST_TIMEOUT_MS) offenders.push(`${rel}:${d.line}  ${d.text}`);
      }

      // The same bug wearing a parameter: a helper whose DEFAULT budget could
      // outlive the ceiling. This is the form InsuranceRitExclusivity had.
      src.split('\n').forEach((line, i) => {
        const m = line.match(/(?:timeoutMs|budgetMs|deadlineMs)\s*=\s*([0-9_]+)/);
        if (!m) return;
        if (Number(m[1].replace(/_/g, '')) < TEST_TIMEOUT_MS) return;
        offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      'These poll against a deadline at or past the timeout that kills them, so ' +
        'they can never report what they were waiting for - CI shows only ' +
        '"Test timed out" and names nothing. Use waitFor / waitForEvent from ' +
        'src/testing/waitBudget.ts.\n' +
        offenders.join('\n')
    ).toEqual([]);
  });

  it('an exhausted wait throws, naming what it wanted', async () => {
    const { waitFor, waitForEvent } = await import('./waitBudget.js');

    await expect(waitFor(() => false, 'a thing that never happens', 60)).rejects.toThrow(
      /a thing that never happens/
    );

    // The event flavour must name what DID arrive - that is what separates
    // "never fired" from "fired late" in a single CI read.
    await expect(
      waitForEvent([{ type: 'HAND_START' }, { type: 'DEAL' }], 'HAND_COMPLETE', 60)
    ).rejects.toThrow(/HAND_START, DEAL/);

    // And it must still resolve immediately when the condition already holds.
    await expect(waitForEvent([{ type: 'HAND_COMPLETE' }], 'HAND_COMPLETE', 60)).resolves.toEqual({
      type: 'HAND_COMPLETE',
    });
  });
});
