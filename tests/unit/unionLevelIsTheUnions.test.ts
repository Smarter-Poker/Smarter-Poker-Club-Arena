import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getClubLevelFromMembers } from '../../src/utils/clubLevels';

const src = readFileSync(resolve(__dirname, '../../src/pages/ClubHomePage.tsx'), 'utf8');

/**
 * A UNION'S MEMBER TOTAL IS THE UNION'S, NOT THE VIEWER'S (2026-09-02).
 *
 * Midway Union rendered "LEVEL 25". 25 is the ladder level for 328 members -
 * the union's own house-club row (club_id 55555) - while the union holds
 * 1,177 memberships (584 Club JAQK + 593 Shark Club), which is level 33.
 *
 * The cause was that the union total was summed over `unionClubIds`, a list
 * read straight from `union_clubs`. That table carries RLS policy
 * `union_clubs_read`, which admits a row only if the viewer is a union admin,
 * owns that club, or is a member of it. The per-club COUNT was already
 * SECURITY DEFINER and therefore RLS-proof; the LIST it was given was not, so
 * the sum silently became "the part of this union I am allowed to enumerate".
 *
 * Worse, `unionClubIds` initialises to `[resolvedId]`, and for a union lobby
 * that is the union's own house club. So a viewer who could see no rows did
 * not get an empty list and a skipped block - they got the house club, and
 * `unionClubIds.length > 0` waved it through as if the read had succeeded.
 *
 * `fn_batch_union_realtime_member_counts` takes the union id, resolves its
 * clubs server-side and is SECURITY DEFINER, so every viewer gets the same
 * number. HomePage.tsx already used it, which is precisely why the home page
 * and the union lobby disagreed about the same union.
 */
describe("a union's member total is the union's, not the viewer's", () => {
  it('asks the union-scoped security-definer RPC for the union total', () => {
    expect(src).toMatch(/fn_batch_union_realtime_member_counts/);
    const call = src.slice(src.indexOf("'fn_batch_union_realtime_member_counts'"));
    expect(call).toMatch(/p_union_ids:\s*\[unionId\]/);
  });

  it('never derives the union total from the RLS-filtered club list again', () => {
    // The club-scoped batch RPC may still exist elsewhere for club surfaces,
    // but it must not be the source of a UNION total.
    const unionBlock = src.slice(
      src.indexOf('if (clubData.is_union && unionId)'),
      src.indexOf('A CLUB’S MEMBER COUNT IS ITS OWN') > 0
        ? src.indexOf('A CLUB’S MEMBER COUNT IS ITS OWN')
        : src.indexOf("A CLUB'S MEMBER COUNT IS ITS OWN")
    );
    expect(unionBlock).not.toMatch(/p_club_ids:\s*unionClubIds/);
  });

  it('does not gate the union total on a list that can never be empty', () => {
    // `unionClubIds` defaults to [resolvedId], so `.length > 0` was always
    // true and could not tell a real read from the fallback.
    expect(src).not.toMatch(/clubData\.is_union && unionClubIds\.length > 0/);
  });

  it('the ladder still puts 1,177 members at 33 and 328 at 25', () => {
    // Pins the arithmetic the bug was visible through, so a ladder edit that
    // reintroduced the confusion would fail here too.
    expect(getClubLevelFromMembers(1177)).toBe(33);
    expect(getClubLevelFromMembers(328)).toBe(25);
    expect(getClubLevelFromMembers(1177)).not.toBe(getClubLevelFromMembers(328));
  });
});
