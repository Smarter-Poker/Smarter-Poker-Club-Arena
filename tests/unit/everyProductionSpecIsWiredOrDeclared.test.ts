/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A SPEC THAT IS NEVER INVOKED IS NOT COVERAGE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-09-02. `post-deploy-e2e.yml` picks its specs BY NAME. On this day, 19 of
 * the 34 spec files at the top level of `tests/e2e` were not named anywhere in
 * it - so they had never run against production even once, and nothing said so.
 *
 * That is not a hypothetical. It is how a red went unexplained for hours:
 * `club-data-deep.spec.ts` reported a permission gate on 2026-09-01, the guard
 * bug behind it was fixed, and the fix could not be confirmed because by then
 * the spec had dropped out of the workflow's list entirely and was running
 * nowhere.
 *
 * Four of the nineteen were nets Dan asked for BY NAME after a live complaint:
 *
 *   seat-first-entry.spec.ts     "I STILL CAN'T EVEN SIT DOWN AND PLAY"
 *   live-animations.spec.ts      "now do a real live e2e browser test of everything"
 *   hero-cards-no-glitch.spec.ts bug list item 4, cards glitch before display
 *   multi-table.spec.ts          the PokerBros-parity regression net
 *
 * Each was written, merged, and then never run after a deploy.
 *
 * The workflow already knows this failure shape - its own comment describes
 * "nine route suites [that] stayed invisible one level down" and fixes it by
 * passing a DIRECTORY for `tests/e2e/routes`. The top level kept a hand-written
 * list, so the hole reopens one file at a time, silently, forever.
 *
 * THE RULE. Every spec at the top level of tests/e2e is either
 *
 *   (a) invoked by post-deploy-e2e.yml, or
 *   (b) listed in scripts/ci/e2e-not-in-post-deploy.json WITH A REASON.
 *
 * Adding a spec and forgetting to wire it now fails here, by name, at the
 * moment it is written - instead of being discovered by whoever eventually
 * wonders why a bug nobody caught had a test for it all along.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const WORKFLOW = readFileSync(resolve(ROOT, '.github/workflows/post-deploy-e2e.yml'), 'utf8');
const DECLARED = JSON.parse(
  readFileSync(resolve(ROOT, 'scripts/ci/e2e-not-in-post-deploy.json'), 'utf8')
) as { notInvoked: Array<{ file: string; reason: string }> };

const specs = readdirSync(resolve(ROOT, 'tests/e2e'))
  .filter((f) => f.endsWith('.spec.ts'))
  .sort();

describe('every production spec is wired into the deploy gate, or declared', () => {
  it('finds the spec files at all, so an empty glob cannot pass this suite', () => {
    // A directory read that quietly returns nothing would make every assertion
    // below vacuously true, which is the exact failure mode this file is about.
    expect(specs.length).toBeGreaterThan(20);
  });

  it('leaves no spec both un-invoked and undeclared', () => {
    const declared = new Set(DECLARED.notInvoked.map((e) => e.file));
    const orphans = specs.filter((f) => !WORKFLOW.includes(f) && !declared.has(f));
    expect(
      orphans,
      'These specs run NOWHERE and are not declared. Either add them to\n' +
        '.github/workflows/post-deploy-e2e.yml, or add an entry with a reason to\n' +
        'scripts/ci/e2e-not-in-post-deploy.json:\n  ' +
        orphans.join('\n  ')
    ).toEqual([]);
  });

  it('every declaration carries a reason that says something', () => {
    // "skipped" or "n/a" is not a reason. The neighbouring ratchet
    // (e2e-may-skip-entirely.json) states the same rule for the same purpose.
    const empty = DECLARED.notInvoked.filter((e) => !e.reason || e.reason.trim().length < 25);
    expect(empty.map((e) => e.file)).toEqual([]);
  });

  it('does not declare a spec that IS invoked, so the ratchet cannot go stale', () => {
    /* Once someone wires a declared spec in, its entry has to go, or this file
       keeps claiming production is uncovered when it is not - and a ratchet
       nobody trusts is a ratchet nobody shortens. */
    const contradictions = DECLARED.notInvoked
      .map((e) => e.file)
      .filter((f) => WORKFLOW.includes(f));
    expect(contradictions).toEqual([]);
  });

  it('does not declare a spec that no longer exists', () => {
    const present = new Set(specs);
    const ghosts = DECLARED.notInvoked.map((e) => e.file).filter((f) => !present.has(f));
    expect(ghosts).toEqual([]);
  });

  it('club-data-deep is wired in, because its verdict is the reason this exists', () => {
    expect(WORKFLOW).toContain('tests/e2e/club-data-deep.spec.ts');
  });

  it('the ratchet only goes down', () => {
    /* 18 on the day this was written. Raising it needs a deliberate edit here
       and a sentence in the pull request saying which surface stopped being
       covered and why that was acceptable. */
    expect(DECLARED.notInvoked.length).toBeLessThanOrEqual(18);
  });
});
