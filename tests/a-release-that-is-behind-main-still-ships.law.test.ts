/**
 * LAW: a build that is merely BEHIND main is still shippable; only a backwards
 * move is refused.
 *
 * The engine release path asked, in four places, that the target BE the newest
 * commit touching `server/**` on protected main. A release waits in a FIFO and
 * then waits again on the box for its `:55` break window - up to fifty minutes -
 * re-checking that as it waits. At this repo's merge rate, about nineteen an
 * hour, the answer is almost never still yes.
 *
 * Measured 2026-09-12. The engine ran `d68cc549` for four and a half hours while
 * eight consecutive release transactions built their image, waited, and died:
 *
 *   03:07  image for 367a6ade built and validated on the box
 *   03:32  main moved   367a6adec..43216b121
 *   03:41  main moved   43216b121..f894216ca
 *   03:53  main moved   f894216ca..35f1b585e
 *   03:53  FATAL: target 367a6adecd is stale; protected main requires 35f1b585ef
 *   03:53  sealed desired runtime d68cc549 was recovered
 *
 * One of those eight carried the fix for a live fault that was killing every
 * cash table every twenty seconds. The gate was refusing the remedy for the
 * outage it was sitting on top of.
 *
 * Every deploy is behind main the instant it lands, so being behind cannot be
 * what makes one unsafe. Two properties are what matter and both are kept:
 *
 *   CONTAINMENT  the target is an ancestor of protected main. This is what
 *                catches a rewind, a force-push, or a build off other history.
 *                It was always a separate check and it still gates, hard.
 *   NO REVERSAL  the engine never moves backwards. Proved on the box against
 *                the runtime it has sealed, which also serialises two racing
 *                releases: an older one cannot land on a newer sealed one.
 *
 * Identity was a blunt approximation of NO REVERSAL, made where the sealed
 * runtime is not knowable. It is replaced by NO REVERSAL itself, asserted where
 * the answer is known.
 *
 * This law pins that the swap actually happened and did not quietly revert: the
 * containment proofs are still hard failures, the backwards proof exists, and no
 * high-water identity comparison is a hard failure again.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');
/** A law a reformat can break is not a law. */
const flat = (s: string): string => s.replace(/\s+/g, ' ');

const deploy = read('.github/workflows/auto-deploy-hetzner.yml');
const txn = read('server/scripts/engine-release-transaction.sh');

/**
 * Shell with comment lines removed.
 *
 * Both files now QUOTE the old refusal in the comment that explains why it went,
 * so a naive search for that text finds the documentation rather than the defect
 * - the same trap `check-unqualified-writes.mjs` records in its own header. Only
 * executable lines are searched for the thing that must be gone.
 */
const code = (s: string): string =>
  s
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

describe('a release that is behind main still ships', () => {
  it('containment in protected main is still a hard failure everywhere', () => {
    // These are the checks that actually protect the engine. If any of them
    // becomes a warning, this law has been read as licence to relax the wrong
    // thing.
    expect(deploy).toContain('target is not contained in protected main');
    expect(deploy).toContain('release target left protected-main history');
    expect(deploy).toContain('workflow control commit left protected-main history');
    expect(txn).toContain('is no longer contained in protected main');
    for (const marker of [
      'target is not contained in protected main',
      'release target left protected-main history',
    ]) {
      const line = deploy.split('\n').find((l) => l.includes(marker))!;
      expect(line, marker).toMatch(/exit 1/);
    }
  });

  it('the box proves the target does not move the engine backwards', () => {
    const f = flat(txn);
    expect(f).toContain('"$RELEASE_SEAL" get desired-sha');
    expect(f).toMatch(
      /merge-base --is-ancestor "\$sealed_sha" "\$SHA" \\? *\|\| die "target \$SHA does not descend from the sealed runtime \$sealed_sha"/
    );
  });

  it('no high-water identity comparison is a hard failure any more', () => {
    // `[ "$LATEST_REQUIRED" = ... ]` under `set -euo pipefail` fails the step on
    // its own, so a bare one is as fatal as an explicit exit. Every surviving
    // comparison must carry a non-fatal branch.
    const lines = deploy.split('\n');
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (
        !/\[\s*"\$(LATEST_REQUIRED|RESOLVED_SHA)"\s*=\s*"\$(LATEST_REQUIRED|SHA|TARGET_SHA)"\s*\]/.test(
          line
        )
      ) {
        return;
      }
      const window = lines.slice(i, i + 3).join(' ');
      if (!/&&|\|\|/.test(window)) offenders.push(`line ${i + 1}: ${line.trim()}`);
      if (/exit 1/.test(window)) offenders.push(`line ${i + 1} still exits 1: ${line.trim()}`);
    });
    expect(offenders, offenders.join('\n')).toEqual([]);
    expect(code(txn)).not.toContain('is stale; protected main requires');
    expect(txn, 'the reason it went must stay written down').toContain(
      'is stale; protected main requires'
    );
  });

  it('the reason is written where the next person will look', () => {
    expect(deploy).toContain('Behind main is not the same as going backwards');
    expect(txn).toContain('BEHIND MAIN IS NOT THE SAME AS GOING BACKWARDS');
  });
});
