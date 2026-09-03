/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A NEW REGISTRATION MUST NOT RELOAD THE WHOLE UNION ROSTER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `entrantKey` is the sorted join of entrant ids. It was introduced to keep the
 * club sweep from re-running on every chip tick, and it does that correctly.
 * But it also changes on every REGISTRATION, and the load effect depended on
 * it, so each new player triggered the entire sweep again:
 *
 *   1. a PAGED `tournament_players` read of the whole field
 *   2. a chunked `club_members` read for everyone unresolved
 *   3. a chunked `clubs` read for every referenced club
 *   4. the union's name
 *
 * Four to sixteen round trips, per new player, during late registration —
 * which is exactly the window when players arrive fastest and the field is
 * largest. A 500-runner event re-read 500 rows to learn about one person.
 *
 * A club assignment does not change once resolved: it comes from the
 * `tournament_players` row the player entered on, or from their membership. So
 * the resolved maps are cumulative and an entrant-set change only has to ask
 * about ids that are NOT already in them. A player LEAVING costs nothing —
 * `groups` buckets from `entries`, so they simply stop being rendered.
 *
 * WHAT THIS PINS is the shape of the load, since the effect cannot be run
 * headlessly without standing up Supabase: the cache exists, the top-up path
 * narrows every query, the no-op path issues none, a retry starts over, and a
 * failed top-up keeps the roster already on screen.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceStatement } from '../helpers/sourceWindow';
import { planUnionLoad } from '../../src/components/tournament/details/UnionsTab';

const SRC = readFileSync(
  join(__dirname, '..', '..', 'src/components/tournament/details/UnionsTab.tsx'),
  'utf8'
);
/** The comments describe the old behaviour; assertions read the code only. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * THE DECISION ITSELF, exercised with real inputs.
 *
 * The first version of this file only asserted source strings. Disabling the
 * top-up underneath them — one edit, `const isTopUp = false` — left every
 * string in place and the whole file still passed. That is the failure mode
 * the repo has been bitten by before: a test that passes either way pins
 * nothing. `planUnionLoad` is extracted so these cases can actually break.
 */
describe('planUnionLoad decides what to fetch', () => {
  const withResolved = (...ids: string[]) => ({ clubByUser: new Map(ids.map((i) => [i, 'club'])) });

  it('a cold load reads the whole field', () => {
    expect(planUnionLoad(null, ['a', 'b', 'c'])).toEqual({
      mode: 'cold',
      userIds: ['a', 'b', 'c'],
    });
  });

  it('one newcomer costs a read of ONE id, not of the field', () => {
    // The bug: a 500-runner event re-read 500 rows to learn about one person.
    const field = Array.from({ length: 500 }, (_, i) => `p${i}`);
    const prior = withResolved(...field);
    const plan = planUnionLoad(prior, [...field, 'newcomer']);
    expect(plan.mode).toBe('topup');
    expect(plan.userIds).toEqual(['newcomer']);
  });

  it('issues NO read when the entrant set gained nobody', () => {
    // A re-render, a chip tick, or a player leaving.
    const prior = withResolved('a', 'b');
    expect(planUnionLoad(prior, ['a', 'b'])).toEqual({ mode: 'noop', userIds: [] });
    // A DEPARTURE also costs nothing: `groups` buckets from `entries`.
    expect(planUnionLoad(prior, ['a'])).toEqual({ mode: 'noop', userIds: [] });
  });

  it('an empty field against an empty cache is still a cold load, not a no-op', () => {
    expect(planUnionLoad(null, []).mode).toBe('cold');
  });
});

describe('the union roster is resolved cumulatively', () => {
  it('keeps what previous runs resolved', () => {
    expect(code).toMatch(/const resolvedRef = useRef<LoadedData \| null>\(null\)/);
  });

  it('the effect uses the planner rather than re-deriving the decision', () => {
    expect(code).toMatch(/const plan = planUnionLoad\(prior, allEntrantIds\)/);
    expect(code).toMatch(/const userIds = plan\.userIds/);
    expect(code).toMatch(/if \(plan\.mode === 'noop'\)/);
  });

  it('narrows the entrant read on a top-up instead of paging the whole field', () => {
    /*
     * Step 1 is the expensive one: a paged walk of every `tournament_players`
     * row. A top-up wants a chunked `.in()` on the newcomers and nothing more.
     *
     * Bounded by the STATEMENT, not by a character count. The first draft used
     * `[\s\S]{0,220}` between `inChunks` and `.in('user_id', chunk)` and failed
     * because the generic argument and the chained builder are longer than
     * that — which is the drift `noFixedSizeSourceWindows` exists to forbid.
     * Widening the number would have been the wrong repair.
     */
    const stmt = sliceStatement(code, 'const tpRows = isTopUp');
    expect(stmt).toMatch(/\?\s*await inChunks/);
    expect(stmt).toMatch(/\.in\('user_id', chunk\)/);
    expect(stmt).toMatch(/:\s*await fetchAllPages/);
    expect(stmt).toMatch(/\.range\(from, to\)/);
  });

  it('seeds the maps from the cache so a top-up ADDS rather than replaces', () => {
    // Seeding from empty would leave the roster containing only the newcomers.
    expect(code).toMatch(/new Map<string, string>\(prior\?\.clubByUser \?\? \[\]\)/);
    expect(code).toMatch(/new Map<string, ClubSource>\(prior\?\.sourceByUser \?\? \[\]\)/);
    expect(code).toMatch(/new Map<string, ClubRow>\(prior\?\.clubsById \?\? \[\]\)/);
  });

  it('skips clubs it has already loaded', () => {
    // A newcomer from a club already on screen costs no club query at all.
    expect(code).toMatch(/unknownClubIds[\s\S]{0,90}!clubsById\.has\(id\)/);
    expect(code).toMatch(/if \(unknownClubIds\.length > 0\)/);
  });

  it('fetches the union name once', () => {
    // A union does not rename itself because somebody registered.
    expect(code).toMatch(/let unionName: string \| null = prior\?\.unionName \?\? null/);
    expect(code).toMatch(/if \(unionId && unionName === null\)/);
  });

  it('writes the cache before publishing, so the next change tops it up', () => {
    expect(code).toMatch(/resolvedRef\.current = next;[\s\S]{0,80}setData\(next\)/);
  });
});

describe('the cache cannot outlive what it is a cache OF', () => {
  it('starts over for a different tournament, union, host club or retry', () => {
    expect(code).toMatch(
      /const identity = `\$\{tournamentId\}\|\$\{unionId \?\? ''\}\|\$\{hostClubId \?\? ''\}\|\$\{attempt\}`/
    );
    expect(code).toMatch(
      /if \(resolvedForRef\.current !== identity\)[\s\S]{0,120}resolvedRef\.current = null/
    );
  });

  it('does the reset INSIDE the load effect, not in a second one', () => {
    /*
     * Two effects sharing dependencies run in declaration order, so a separate
     * resetter declared after the loader would clear the cache only AFTER the
     * loader had already read it — a retry would top up the very data it is
     * retrying because of. One effect, no ordering to get wrong.
     */
    const effects = code.match(/useEffect\(\(\) => \{\s*resolvedRef\.current = null/g) || [];
    expect(effects).toEqual([]);
  });

  it('a failed TOP-UP keeps the roster already on screen', () => {
    // Only a cold load has nothing to fall back to. Throwing away a correct
    // roster because one newcomer could not be resolved is the worse outcome.
    expect(code).toMatch(
      /if \(isTopUp\)[\s\S]{0,260}setState\('ready'\)[\s\S]{0,60}else[\s\S]{0,60}setState\('error'\)/
    );
    expect(code).toMatch(/UnionsTab\.top_up_failed/);
  });
});
