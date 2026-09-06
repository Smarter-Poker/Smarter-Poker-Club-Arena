/**
 * A FILE NOTHING IMPORTS SHIPS TO NOBODY.
 *
 * Measured 2026-09-02: 64 behavioural modules in `src/` that no other file in
 * `src/` imports, including `ClubDetailPage.tsx` (76KB) and
 * `PlayerSessionsPage.tsx` (57KB). That alone is waste. The trap is that 18 of
 * them are ASSERTED AGAINST BY TESTS, so:
 *
 *   - an agent sent to "fix a bug in ClubDetailPage" edits it, runs the tests,
 *     sees green, ships, and changes nothing a player can see; and
 *   - a law failing on dead code blocks `publish-club-arena.yml` for everyone,
 *     over behaviour that is not in the product.
 *
 * This does NOT fail on the orphans that exist today. Removing one that a law
 * guards means first proving the law still holds against the LIVE equivalent —
 * a judgement call per file, not a sweep. It ratchets, so the set cannot
 * quietly grow while somebody makes those calls.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const script = join(root, 'scripts', 'ci', 'report-orphan-modules.mjs');

interface OrphanReport {
  orphans: string[];
  guardedOrphans: Array<{ orphan: string }>;
  baseline: number;
}

function readReport(): OrphanReport {
  const out = execFileSync('node', [script, '--json'], { cwd: root, encoding: 'utf8' });
  return JSON.parse(out);
}

describe('orphan-module ratchet', () => {
  let report: OrphanReport;

  /* Building the import graph is intentionally comprehensive and can take
     longer than Vitest's five-second per-test budget under full-suite load.
     Compute it once with an explicit hook budget instead of repeating the
     identical child process for every assertion. */
  beforeAll(() => {
    report = readReport();
  }, 30_000);

  it('does not grow the set of unreachable modules', () => {
    const { orphans, baseline } = report;
    expect(
      orphans.length,
      `Unreachable src/ modules went from ${baseline} to ${orphans.length}. A file nothing ` +
        `imports ships to nobody: route it from App.tsx, import it where it belongs, or delete ` +
        `it. If a test guards it, retarget that test at the live equivalent FIRST.\n` +
        orphans.slice(0, 40).join('\n')
    ).toBeLessThanOrEqual(baseline);
  });

  it('does not let the baseline drift far below the real count', () => {
    /* This used to assert `toBe(baseline)` - an exact match - so ANY commit
       that removed an orphan FAILED the build until its author also edited
       BASELINE_ORPHANS. Two costs, and the estate paid both:
     *
     *   1. Improving the code broke CI. On 2026-09-04 a branch that deleted one
     *      dead module went red with "down to 63 - lower BASELINE_ORPHANS to
     *      match", while 910 of 911 tests passed.
     *   2. Worse at this scale: it forced every agent who tidied anything to
     *      edit ONE shared constant on ONE line. With a dozen agents in flight
     *      that line is a conflict magnet - the same shape as the
     *      MIGRATION-CHANGELOG collisions this repo already had to design away.
     *
     * The safety property is that the set must not GROW; the test above pins
     * that and is untouched. Tightening the number is housekeeping, and
     * housekeeping should not be able to fail a build or serialise twelve
     * agents behind one integer.
     *
     * Slack keeps the ratchet honest without making it hostile: drift a little
     * and nothing happens, drift a lot and someone is told to reset it. */
    const { orphans, baseline } = report;
    const SLACK = 10;
    expect(
      baseline - orphans.length,
      `BASELINE_ORPHANS is ${baseline} but only ${orphans.length} orphans remain - the ratchet ` +
        `has drifted more than ${SLACK} loose and has stopped meaning anything. Lower ` +
        `BASELINE_ORPHANS in scripts/ci/report-orphan-modules.mjs to ${orphans.length}.`
    ).toBeLessThanOrEqual(SLACK);
  });

  it('still reports which orphans are guarded by tests', () => {
    // The dangerous subset is the whole reason this exists; if the reporter
    // stops distinguishing it, the report is just a list of file names.
    const { guardedOrphans } = report;
    expect(Array.isArray(guardedOrphans)).toBe(true);
  });
});
