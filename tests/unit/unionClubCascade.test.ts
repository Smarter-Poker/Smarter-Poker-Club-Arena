/**
 * THE UNION -> CLUB CASCADE MUST NOT COLLAPSE ON A BLIP (2026-08-23)
 *
 * Dan: "the mtt, spins and heads up tournaments keep breaking and not
 * displaying correctly. Sometimes it displays, then it disappears."
 *
 * ClubHomePage forks its entire game list on `unionId`. With it, a union club
 * lists its own private games plus every union game — 138 games, 35 of them
 * MTTs. Without it, the same club lists only what it owns, which for a union
 * club is almost nothing: the MTT tab reads "Nothing Here On This Tab" while
 * 138 games run one join away. Two screenshots of the same club minutes apart
 * showed 1,172 members / 42 games and 584 members / 138 games.
 *
 * The fork hung on ONE union_clubs read whose catch treated FAILURE exactly
 * like ABSENCE, so any timeout silently demoted the club to standalone.
 *
 * These pin the rule at the source, because the failure is a branch shape
 * rather than a value: standalone may only be concluded from POSITIVE
 * evidence, never from an error.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/pages/ClubHomePage.tsx'), 'utf8');

describe('union -> club cascade', () => {
  it('treats a failed union lookup differently from an empty one', () => {
    // The regression was a single `if (!ucErr && ucRow)` with no error branch.
    expect(SRC).toMatch(/if \(ucErr\) \{/);
  });

  it('falls back to the club row and then to cache when the lookup errors', () => {
    const errBranch = SRC.slice(SRC.indexOf('if (ucErr) {'), SRC.indexOf('if (!ucErr && !ucRow)'));
    expect(errBranch, 'must consult clubs.union_id').toMatch(/clubData as \{ union_id/);
    expect(errBranch, 'must consult the cached answer').toMatch(/readCachedUnion\(\)/);
  });

  it('carries union_id on the club row so the fallback costs no round trip', () => {
    expect(SRC).toMatch(/created_at, is_union, union_id, opening_checklist_started_at'/);
  });

  it('caches a resolved union so the next load survives a timeout', () => {
    expect(SRC).toMatch(/cacheUnion\(ucRow\.union_id\)/);
  });

  it('only clears the cache on positive evidence of standalone', () => {
    // cacheUnion(null) must sit INSIDE the branch where the query SUCCEEDED
    // and returned nothing — never in a catch, and never on the error path.
    const emptyBranch = SRC.slice(
      SRC.indexOf('if (!ucErr && !ucRow)'),
      SRC.indexOf('if (!ucErr && ucRow)')
    );
    expect(emptyBranch.length, 'the empty-read branch must exist').toBeGreaterThan(0);
    expect(emptyBranch, 'the cache is cleared only on a successful empty read').toContain(
      'cacheUnion(null)'
    );
    const errorBranch = SRC.slice(
      SRC.indexOf('if (ucErr) {'),
      SRC.indexOf('if (!ucErr && !ucRow)')
    );
    expect(errorBranch, 'an error must never clear the cached scope').not.toContain(
      'cacheUnion(null)'
    );
  });
});
