/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB HOME WATERFALL — the lobby's round trips must stay overlapped
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Measured 2026-08-23 against production: the queries behind the club lobby
 * execute in ~9ms server-side, and getting the table list on screen still took
 * SIX sequential round trips after the club row — member+diamonds, union row,
 * union clubs, member count, live count, tables. At 150-250ms per trip wired
 * and 250-400ms on mobile, that is 1-1.5s and 2-3s respectively of pure
 * waiting, more than every remaining byte on the boot path combined.
 *
 * Two of those queries need only `resolvedId` and were merely queued behind
 * the auth/membership chain by code order. They are now started as soon as the
 * club row resolves and awaited where they always were.
 *
 * This is pinned STATICALLY on purpose. ClubHomePage is 2,500 lines with
 * realtime subscriptions and no component-level coverage — a behavioural test
 * would need more mocking than it would be worth, and would not catch the
 * thing that actually regresses here, which is someone moving a query back
 * inline while refactoring. Ordering in the source is exactly the property
 * that must hold.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const whole = readFileSync(path.resolve(__dirname, '../..', 'src/pages/ClubHomePage.tsx'), 'utf8');

/**
 * Only loadClubData is under test. The page has a second, unrelated
 * union_clubs lookup in another function (the join/spin flow), and an
 * assertion written against the whole file matches that one too — which is
 * how the first draft of this test failed for the wrong reason.
 */
const start = whole.indexOf('const loadClubData = async');
if (start < 0) throw new Error('loadClubData not found in ClubHomePage');
const end = whole.indexOf('\n  };', start);
const src = whole.slice(start, end > start ? end : undefined);

/** Index of the first occurrence, asserting it exists at all. */
function at(needle: string): number {
  const i = src.indexOf(needle);
  expect(i, `ClubHomePage no longer contains: ${needle}`).toBeGreaterThan(-1);
  return i;
}

describe('the club lobby does not re-serialise its round trips', () => {
  it('starts the union lookup and the live member count before the membership batch', () => {
    const resolved = at('const resolvedId = clubData.id;');
    const unionStart = at('const unionRowPromise = supabase');
    const countStart = at('const liveMemberCountPromise = supabase');
    /* The membership read is the first thing that used to block them. It was
       a Promise.all of the club_members row AND a DiamondService balance;
       the balance fed a `wallet` state nothing in the file ever read, so the
       round trip is gone and this is a single awaited query now. What this
       test pins is unchanged: both hoisted promises must be ISSUED before it. */
    const membershipAwait = at('const memberResult = await supabase');

    expect(unionStart).toBeGreaterThan(resolved);
    expect(countStart).toBeGreaterThan(resolved);
    expect(
      unionStart,
      'the union lookup is issued after the membership batch again — back to a serial waterfall'
    ).toBeLessThan(membershipAwait);
    expect(
      countStart,
      'the live member count is issued after the membership batch again'
    ).toBeLessThan(membershipAwait);
  });

  it('awaits the hoisted promises rather than issuing the queries inline', () => {
    expect(src).toContain('await unionRowPromise');
    expect(src).toContain('await liveMemberCountPromise');
    // The inline forms are what the hoist replaced; their return means the
    // query is back in series regardless of what the promises above do.
    expect(
      /await supabase\s*\n\s*\.from\('union_clubs'\)/.test(src),
      'union_clubs is being queried inline inside loadClubData again'
    ).toBe(false);
    // Scoped to the STANDALONE-club count (.eq club_id = resolvedId). The
    // union-wide count a few lines further down uses .in('club_id',
    // unionClubIds) and genuinely cannot be hoisted - it depends on a value
    // two round trips away - so it must not trip this.
    /* Matched on the COUNT form specifically. A bare club_members read is not
       the thing being guarded against - the viewer's own membership row is
       one, is awaited inline on purpose, and cannot be hoisted because it
       needs the authenticated user id. Only the head/count query is. */
    expect(
      /await supabase\s*\n\s*\.from\('club_members'\)[\s\S]{0,240}?count: 'exact'[\s\S]{0,240}?\.eq\('club_id', resolvedId\)/.test(
        src
      ),
      'the standalone live member count is being queried inline inside loadClubData again'
    ).toBe(false);
  });

  it('keeps a rejection handler on each hoisted promise', () => {
    // A hoisted promise that rejects before its await is an unhandled
    // rejection. Both must shape the failure so the fail-open handling at each
    // await site still sees { error } rather than throwing.
    const unionBlock = src.slice(
      at('const unionRowPromise = supabase'),
      at('const liveMemberCountPromise')
    );
    expect(unionBlock).toContain('(error) => ({ data: null, error })');
    /* Was `{ count: null, error }` while this was a PostgREST head/count query.
       It is now supabase.rpc('fn_get_club_member_count', ...), whose failure
       shape is `{ data: null, error }` - because a direct count returned 0 to
       anyone who is not a member of the club (RLS), and cost 204ms against the
       RPC's 0.55ms. What this test actually guards is unchanged: the hoisted
       promise must still shape its rejection so the fail-open handling at the
       await site sees `{ error }` instead of an unhandled rejection. */
    const countBlock = src.slice(
      at('const liveMemberCountPromise = supabase'),
      at('const liveMemberCountPromise = supabase') + 600
    );
    expect(countBlock).toContain('(error) => ({ data: null, error })');
  });
});
