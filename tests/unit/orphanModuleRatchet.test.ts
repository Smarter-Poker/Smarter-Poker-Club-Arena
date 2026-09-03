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

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const script = join(root, 'scripts', 'ci', 'report-orphan-modules.mjs');

function report(): {
  orphans: string[];
  guardedOrphans: Array<{ orphan: string }>;
  baseline: number;
} {
  const out = execFileSync('node', [script, '--json'], { cwd: root, encoding: 'utf8' });
  return JSON.parse(out);
}

describe('orphan-module ratchet', () => {
  it('does not grow the set of unreachable modules', () => {
    const { orphans, baseline } = report();
    expect(
      orphans.length,
      `Unreachable src/ modules went from ${baseline} to ${orphans.length}. A file nothing ` +
        `imports ships to nobody: route it from App.tsx, import it where it belongs, or delete ` +
        `it. If a test guards it, retarget that test at the live equivalent FIRST.\n` +
        orphans.slice(0, 40).join('\n')
    ).toBeLessThanOrEqual(baseline);
  });

  it('tightens the baseline when the set shrinks', () => {
    /* The same discipline as discardedErrorReadRatchet: a commit that removes
       an orphan lowers the number in the same breath, or the ratchet drifts
       loose and stops meaning anything. */
    const { orphans, baseline } = report();
    expect(
      orphans.length,
      `Unreachable modules are down to ${orphans.length} — lower BASELINE_ORPHANS in ` +
        `scripts/ci/report-orphan-modules.mjs to match, in this commit.`
    ).toBe(baseline);
  });

  it('still reports which orphans are guarded by tests', () => {
    // The dangerous subset is the whole reason this exists; if the reporter
    // stops distinguishing it, the report is just a list of file names.
    const { guardedOrphans } = report();
    expect(Array.isArray(guardedOrphans)).toBe(true);
  });
});
