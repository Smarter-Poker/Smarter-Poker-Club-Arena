/**
 * MERGEABILITY IS COMPUTED LAZILY, AND BOTH GUARDS BELIEVED OTHERWISE.
 * ============================================================================
 * `gh pr list --json mergeStateStatus` does NOT return a live value. GitHub
 * computes mergeability on demand and a bulk listing returns "UNKNOWN" for
 * every row until something has asked about each pull request individually.
 *
 * Two guards read it straight out of a bulk listing and branched on it:
 *
 *   agent-autopilot.yml  tested `$STATE = "DIRTY"` to decide NOT to refresh a
 *                        conflicted branch. Measured 2026-08-27 on one Club
 *                        Arena sweep: all 100 open pull requests took the
 *                        "refreshing" path and every one of them was
 *                        conflicted, so `gh pr update-branch` was called 100
 *                        times a sweep on branches the API cannot fast-forward
 *                        — the exact thing that file's own comment forbids.
 *
 *   report-stuck-prs.sh  classified with a `case` ending in `*) continue ;;`,
 *                        so UNKNOWN did not mis-label a pull request, it
 *                        removed it from the report altogether. The report that
 *                        exists so a stranded pull request cannot go unnoticed
 *                        under-reported exactly when nothing else had warmed
 *                        the cache — which is when nobody was looking.
 *
 * Both now re-ask per pull request before branching, and the reporter names a
 * pull request it still cannot classify instead of dropping it.
 *
 * These files are in estate-integrity.sh SHARED_FILES and must stay
 * byte-identical across all seven repos, so this test travels with them.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const AUTOPILOT = resolve(__dirname, '../../.github/workflows/agent-autopilot.yml');
const REPORTER = resolve(__dirname, '../../.github/scripts/report-stuck-prs.sh');

const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const autopilot = read(AUTOPILOT);
const reporter = read(REPORTER);

describe('agent-autopilot: resolves UNKNOWN before trusting merge state', () => {
  it('the workflow is present', () => {
    expect(autopilot).not.toBe('');
  });

  it('re-asks per pull request when the bulk listing says UNKNOWN', () => {
    expect(autopilot).toMatch(/case "\$STATE" in[\s\S]{0,80}UNKNOWN/);
    expect(autopilot).toMatch(/gh pr view[\s\S]{0,120}mergeStateStatus/);
  });

  it('still has the DIRTY branch the re-ask exists to make reachable', () => {
    expect(autopilot).toMatch(/"\$STATE" = "DIRTY"/);
  });

  it('the re-ask happens BEFORE the DIRTY test, or it changes nothing', () => {
    // Anchor on the retry loop itself. Anchoring on the string `STATE" =
    // "UNKNOWN"` broke the moment the same comparison was reused further down
    // in the refresh guard - a test that pins a phrase rather than the thing
    // it means.
    const reask = autopilot.indexOf('for _try in 1 2 3');
    const dirty = autopilot.indexOf('"$STATE" = "DIRTY"');
    expect(reask).toBeGreaterThan(-1);
    expect(dirty).toBeGreaterThan(-1);
    expect(reask).toBeLessThan(dirty);
  });
});

describe('report-stuck-prs: never drops a pull request it cannot classify', () => {
  it('the script is present', () => {
    expect(reporter).not.toBe('');
  });

  it('re-asks per pull request when the bulk listing says UNKNOWN', () => {
    expect(reporter).toMatch(/ST" = "UNKNOWN"/);
    expect(reporter).toMatch(/gh pr view[\s\S]{0,120}mergeStateStatus/);
  });

  it('names an unclassifiable pull request instead of silently skipping it', () => {
    expect(reporter).toMatch(/mergeability unknown even when asked directly/);
  });

  it('the UNKNOWN arm comes before the catch-all, or it is unreachable', () => {
    const unknownArm = reporter.indexOf('UNKNOWN|"")');
    const catchAll = reporter.lastIndexOf('*)\n      continue ;;');
    expect(unknownArm).toBeGreaterThan(-1);
    expect(catchAll).toBeGreaterThan(-1);
    expect(unknownArm).toBeLessThan(catchAll);
  });

  it('the re-ask happens after the draft/hold filters, so no call is wasted', () => {
    const holdSkip = reporter.indexOf('[ "$HOLD" != "0" ] && continue');
    const reask = reporter.indexOf('ST" = "UNKNOWN"');
    expect(holdSkip).toBeGreaterThan(-1);
    expect(reask).toBeGreaterThan(holdSkip);
  });
});

describe('agent-autopilot: one ask is not enough, and unknown never refreshes', () => {
  it('retries the ask, because GitHub computes mergeability asynchronously', () => {
    // Measured after the single-ask version shipped: 20 of 99 pull requests
    // resolved to DIRTY and 78 still fell through to a doomed update-branch,
    // because the first request only STARTS the computation.
    expect(autopilot).toMatch(/for _try in 1 2 3/);
    expect(autopilot).toMatch(/sleep 2/);
  });

  it('refuses to refresh a branch whose mergeability is still unknown', () => {
    expect(autopilot).toMatch(/mergeability is still unknown — not touching it/);
    // The guard must sit BEFORE the branch that calls update-branch.
    const guard = autopilot.indexOf('mergeability is still unknown');
    // lastIndexOf: `gh pr update-branch` is also named in a comment further up,
    // and the call site is what has to come after the guard.
    const refresh = autopilot.lastIndexOf('gh pr update-branch');
    expect(guard).toBeGreaterThan(-1);
    expect(refresh).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(refresh);
  });
});
