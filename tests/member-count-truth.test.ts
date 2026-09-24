/**
 * A CLUB'S MEMBER COUNT IS NOT "HOW MANY MEMBERS THIS VIEWER MAY ENUMERATE".
 *
 * club_members carries four permissive SELECT policies. Someone browsing a club
 * they have not joined matches none of them, so a direct count returns 0 - for a
 * club with 588 active members. Measured on production, as a real authenticated
 * non-member:
 *
 *   direct RLS count ............... 0
 *   fn_get_club_member_count ..... 588   (after 20260825460000 made it SECDEF)
 *   true count ................... 588
 *
 * This has now been got wrong three times in three places: the featured club
 * card (fixed 2026-07-24), ClubHomePage's two counts, and the shared
 * memberCount utility whose own header claimed to be the single source of truth
 * while disagreeing with the batch function next to it. These tests exist so
 * there is not a fourth.
 *
 * They assert on source text because CI has no database. That cannot prove the
 * SQL is right; it can prove nobody quietly reintroduces the direct count.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const HOME = read('src/pages/ClubHomePage.tsx');
const UTIL = read('src/utils/memberCount.ts');
const MIGRATION = read(
  'supabase/migrations/20260825460000_fn_get_club_member_count_actually_bypasses_rls.sql'
);

/**
 * A club member count taken straight off the table, filtered by club, is the
 * shape that is always wrong. Matching it precisely rather than by keyword keeps
 * the test from firing on the legitimate per-user counts elsewhere in these
 * files, which read the CALLER's own rows and are covered by the
 * `auth.uid() = user_id` policy.
 */
const DIRECT_CLUB_COUNT =
  /from\(\s*['"]club_members['"]\s*\)[\s\S]{0,200}?count:\s*['"]exact['"][\s\S]{0,200}?eq\(\s*['"]club_id['"]/;

/**
 * The same defect via `.in('club_id', [...])` - the UNION total. The first
 * version of this guard only matched `.eq(`, and missed this one, which was
 * still live in the shipped bundle. RLS does not drop a CLUB from that sum, it
 * drops ROWS, so the union total quietly becomes "members of this union I may
 * personally enumerate": measured at 593 against a true 1,172.
 */
const DIRECT_UNION_COUNT =
  /from\(\s*['"]club_members['"]\s*\)[\s\S]{0,200}?count:\s*['"]exact['"][\s\S]{0,200}?\.in\(\s*['"]club_id['"]/;

describe('ClubHomePage asks the database the right question', () => {
  it('takes both member counts from the real-time SECURITY DEFINER RPC', () => {
    const uses =
      HOME.match(/supabase\s*\.?\s*\n?\s*\.rpc\(\s*'fn_get_club_realtime_member_count'/g) || [];
    expect(uses.length).toBe(2);
  });

  it('never counts club_members directly by club_id', () => {
    expect(HOME).not.toMatch(DIRECT_CLUB_COUNT);
  });

  it('takes the UNION total from the batch RPC, not from a filtered scan', () => {
    expect(HOME).not.toMatch(DIRECT_UNION_COUNT);
    // \s* : the call gained an `error:` binding on 2026-08-29 (round 9)
    // and Prettier wrapped it; the pin is about WHICH RPC, not line shape.
    expect(HOME).toMatch(/rpc\(\s*'fn_batch_club_realtime_member_counts'/);
  });

  it('still sums the union without de-duplicating, as specified', () => {
    // A player in two clubs is two memberships - that is what unions.member_count
    // holds, and the header must not start disagreeing with the record again.
    expect(HOME).toMatch(/reduce\(/);
    expect(HOME).toMatch(/Number\(row\.member_count \?\? 0\)/);
  });

  it('coerces the bigint the RPC returns', () => {
    // RETURNS bigint, and PostgREST may serialise that as a JSON number or a
    // string. `count > 0` on a string is not the comparison anybody intended.
    expect(HOME).toMatch(/Number\(liveCountRaw\)/);
    expect(HOME).toMatch(/Number\(memberCountResult\.data\)/);
    expect(HOME).toMatch(/Number\.isFinite\(liveCount\)/);
  });
});

describe('the shared utility is what its header claims to be', () => {
  it('routes the single-club count through the same RPC family as the batch', () => {
    expect(UTIL).toMatch(/rpc\(\s*'fn_get_club_member_count'/);
    expect(UTIL).toMatch(/rpc\(\s*'fn_batch_club_member_counts'/);
  });

  it('no longer counts club_members directly by club_id', () => {
    expect(UTIL).not.toMatch(DIRECT_CLUB_COUNT);
  });
});

describe('the migration cannot land without proving itself', () => {
  it('sets SECURITY DEFINER', () => {
    expect(MIGRATION).toMatch(/SECURITY DEFINER/);
  });

  it('keeps search_path pinned, which is what makes SECURITY DEFINER safe', () => {
    expect(MIGRATION).toMatch(/SET search_path TO 'public', 'extensions'/);
  });

  it('asserts at apply time that it is SECDEF and agrees with its sibling', () => {
    expect(MIGRATION).toMatch(
      /RAISE EXCEPTION 'fn_get_club_member_count is still not SECURITY DEFINER/
    );
    expect(MIGRATION).toMatch(/disagrees with fn_batch_club_member_counts/);
  });

  it('is not reachable by anon', () => {
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_get_club_member_count\(uuid\) FROM anon;/
    );
  });
});
