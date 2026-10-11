/**
 * A PROVISIONAL PLACE IS NOT AN ERROR, AND A YIELD IS NOT A FAILURE (2026-10-11).
 *
 * Two engine log sources reported designed behaviour as errors:
 *
 * 1. TournamentManager.finishing_ladder_exhausted. A bust recorded while late
 *    registration still grows the field takes the place the field had then, so
 *    the ladder runs low and later busts find every place below the seed taken.
 *    Coffee Break Freeroll 7aace408 (178 entrants, late registration to 17:51,
 *    busts from 17:44) reported it 15 times between 18:06 and 18:13 UTC on
 *    2026-10-11, each asking for the standings to be renumbered. Nothing needed
 *    renumbering by hand: the finish derives every place again from when each
 *    bust happened before it pays, and 7aace408 finished with 178 distinct
 *    places in bust order and its 18 prizes (169.20, the whole pool) paid at the
 *    finish. The branch still places the player (the deadlock fix) and still
 *    logs; only the error report is gone. A ladder with no free place at all
 *    stays critical.
 *
 * 2. Tournament.elimination_check_error with retirement_custody_stale. A break
 *    retirement whose sweep budget ran out throws that staleness error; the
 *    custody keeps its reservation and the sweep's finally block requeues the
 *    work. It is quiet only when the budget really has expired.
 *
 * Registry: docs/laws.d/server-src-tournament-aProvisionalPlaceIsNotAnError.md
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBudgetYieldedRetirement, RETIREMENT_STALENESS_ERRORS } from './retirementYield.js';

const ELIM = readFileSync(join(__dirname, 'TournamentManagerEliminations.ts'), 'utf8');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CODE = code(ELIM);

const exhaustedBranch = (): string => {
  const start = CODE.indexOf('if (place < 2) {');
  const end = CODE.indexOf('const eliminated = await this.eliminatePlayer(', start);
  return start >= 0 && end > start ? CODE.slice(start, end) : '';
};

describe('a provisional place is not an error', () => {
  it('still places a player when the ladder runs out downward', () => {
    const branch = exhaustedBranch();
    expect(branch).toMatch(/place\s*=\s*up;/);
    expect(branch).toContain('finishing_ladder_exhausted');
  });

  it('logs the provisional place instead of reporting an error', () => {
    const branch = exhaustedBranch();
    const afterPlace = branch.slice(branch.indexOf('place = up;'));
    expect(afterPlace).toContain('console.log(');
    expect(afterPlace).not.toContain('reportError(');
  });

  it('keeps a ladder with no free place at all critical', () => {
    const branch = exhaustedBranch();
    expect(branch).toMatch(
      /if \(up > ceiling\) \{\s+reportError\([\s\S]*?'TournamentManager\.no_free_finishing_place'/
    );
  });
});

describe('a budget yield is not a failure', () => {
  it('names exactly the two custody staleness errors', () => {
    expect([...RETIREMENT_STALENESS_ERRORS].sort()).toEqual([
      'admission_revision_stale',
      'retirement_custody_stale',
    ]);
  });

  it('is a yield only when the sweep budget has expired', () => {
    const stale = new Error('retirement_custody_stale');
    expect(isBudgetYieldedRetirement(stale, true)).toBe(true);
    expect(isBudgetYieldedRetirement(new Error('admission_revision_stale'), true)).toBe(true);
    // Budget left: the lease, lifecycle or reservation changed. Still reported.
    expect(isBudgetYieldedRetirement(stale, false)).toBe(false);
  });

  it('never quiets anything else', () => {
    expect(
      isBudgetYieldedRetirement(
        new Error('F06 fn_f06_discover_breaks outcome unproven: Error: supabase_timeout'),
        true
      )
    ).toBe(false);
    expect(isBudgetYieldedRetirement(new Error('retirement_registry_changed'), true)).toBe(false);
    expect(isBudgetYieldedRetirement('retirement_custody_stale', true)).toBe(false);
    expect(isBudgetYieldedRetirement(null, true)).toBe(false);
  });

  it('the sweep asks the budget, and reports everything else', () => {
    expect(CODE).toMatch(
      /catch \(err\) \{\s+if \(isBudgetYieldedRetirement\(err, this\.running && this\.eliminationWorkBudgetExpired\(\)\)\) \{\s+console\.log\(/
    );
    expect(CODE).toMatch(
      /\} else \{\s+reportError\(err, 'Tournament\.elimination_check_error'\);\s+\}/
    );
  });
});
