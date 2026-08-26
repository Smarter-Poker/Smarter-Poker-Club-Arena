/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE LOBBY ACTION BAR: CREATE A CLUB, FIND A PLAYER, JOIN A CLUB
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-26: "We should probably do a full audit on the create a club,
 * find a player and join a club action bar at the top of the club arena
 * lobby... make sure all of that works, that users can create there clubs, find
 * players and actually join clubs through those links and buttons."
 *
 * The audit found seven things that were not merely rough but INERT. Each one
 * below is a control that rendered, accepted a click, and could not succeed.
 *
 * 1. THE JOIN BUTTON ON THE DISCOVER TAB COULD NOT BE PRESSED. ClubsPage gated
 *    on `joinClubId.length !== 6`. Every club that exists has a FIVE-digit
 *    club_id - SHARK CLUB 25450, Midway Union 55555, Club JAQK 77777 - because
 *    all three creation paths generate Math.floor(10000 + random * 90000).
 *    Typing a real code left JOIN CLUB greyed out, and the guard returned
 *    without setting joinError, so nothing explained why. HomePage's own modal
 *    had always accepted 5-6; the two screens simply disagreed. Now there is
 *    one definition, in src/utils/clubCode.ts, and both import it.
 *
 * 2. THE OWNER'S "INVITE LINK" WAS DEAD THREE SEPARATE WAYS. ClubSettingsPage
 *    built `${origin}/clubs?join=true&c=...&ref=...`:
 *      - no router basename, so it landed outside the SPA entirely;
 *      - `/clubs` is `<Navigate to="/" replace />` in App.tsx and Navigate
 *        carries no search string, so `c` and `ref` were destroyed even at the
 *        right path (the real list page is `/clubs-list`);
 *      - `?c=` fed a five-digit code to the six-digit gate in item 1.
 *    Corroboration from production: club_members holds 1502 rows and exactly
 *    ONE non-null invited_by. Referral attribution had essentially never fired.
 *
 * 3. `/invite/...?code=XYZ` QUERIED A COLUMN THAT DOES NOT EXIST. InvitePage
 *    filtered `clubs.invite_code`; the column is `code`. PostgREST answered
 *    42703 and the catch reported "Club not found or invitation expired" - a
 *    database error wearing a plausible business message, on a public route.
 *
 * 4. EVERY CUSTOM CLUB LOGO UPLOAD WAS REFUSED. CreateClubPage uploaded to
 *    `<club-uuid>/logo-...`. The only INSERT policies admitting bucket
 *    'club-assets' are `club logos authenticated insert` (name LIKE
 *    'club-logos/%') and `club cards authenticated insert`; the generic
 *    allowlist policy does not include the bucket. The failure was non-fatal,
 *    so the club was created with logo, logo_url and avatar_url all NULL and
 *    nobody was told. CreateClubModal had always used the right prefix.
 *
 * 5. THE 4-CLUB LIMIT FAILED OPEN. Both create paths read
 *    `if (!countError && count >= 4)`, so any error on the count query skipped
 *    the guard. Nothing on the server re-checks it either: both paths INSERT
 *    into club_members directly rather than through fn_join_club, whose limit
 *    check lives in the non-owner branch. The client guard is the only limit
 *    there is, so it cannot be the one that shrugs.
 *
 * 6. FIND A PLAYER COULD NEVER SHOW A TOURNAMENT. It tested
 *    `status === 'running' || status === 'late_reg'`. tournaments.status is
 *    stored UPPERCASE (COMPLETED, CANCELLED, RUNNING, REGISTERING) and
 *    'late_reg' has never been a value. 356 live registrations were fetched
 *    and silently discarded; a player sitting in an MTT read as
 *    "Not Currently Playing".
 *
 * 7. THE ADMIN PLAYER SEARCH REPORTED A CRASH AS "NO PLAYERS FOUND".
 *    `profiles.id` is a uuid; any non-uuid input raised 22P02, which the
 *    handler converted into an empty result set. A hard failure and a genuine
 *    miss were the same screen.
 *
 * Everything asserted here is source-level because CI has no browser. The
 * database facts behind each item were verified against production first.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { isJoinableClubCode, parseClubCode } from '../src/utils/clubCode';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const CLUBS_PAGE = read('src/pages/ClubsPage.tsx');
const HOME = read('src/pages/HomePage.tsx');
const SETTINGS = read('src/pages/ClubSettingsPage.tsx');
const INVITE = read('src/pages/InvitePage.tsx');
const CLUBS_SERVICE = read('src/services/ClubsService.ts');
const CREATE_MODAL = read('src/components/modals/CreateClubModal.tsx');
const FIND = read('src/components/modals/FindPlayerModal.tsx');
const PLAYER_SEARCH = read('src/components/admin/PlayerSearch.tsx');

const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

describe('a club code means the same thing on every screen', () => {
  it('accepts the five-digit codes every real club actually has', () => {
    // SHARK CLUB, Midway Union, Club JAQK.
    expect(isJoinableClubCode('25450')).toBe(true);
    expect(isJoinableClubCode('55555')).toBe(true);
    expect(isJoinableClubCode('77777')).toBe(true);
  });

  it('still accepts six digits, which the column default mints', () => {
    // clubs.club_id defaults to (100000 + floor(random() * 900000))::integer,
    // so any insert path that omits it makes a six-digit club that must remain
    // joinable.
    expect(isJoinableClubCode('123456')).toBe(true);
    expect(parseClubCode('123456')).toBe(123456);
  });

  it('rejects what is not a code', () => {
    expect(isJoinableClubCode('1234')).toBe(false);
    expect(isJoinableClubCode('1234567')).toBe(false);
    expect(isJoinableClubCode('abcde')).toBe(false);
    expect(isJoinableClubCode('')).toBe(false);
    expect(isJoinableClubCode(null)).toBe(false);
    expect(parseClubCode('nope')).toBeNull();
  });

  it('tolerates a pasted code with whitespace', () => {
    expect(isJoinableClubCode(' 25450 ')).toBe(true);
    expect(parseClubCode(' 25450 ')).toBe(25450);
  });

  it('is imported by both screens rather than spelled out twice', () => {
    expect(CLUBS_PAGE).toMatch(/from '\.\.\/utils\/clubCode'/);
    expect(HOME).toMatch(/from '\.\.\/utils\/clubCode'/);
    // The exact-six gate is gone.
    expect(codeOnly(CLUBS_PAGE)).not.toMatch(/joinClubId\.length !== 6/);
  });
});

describe('the invite link an owner copies', () => {
  it('points at the invite route, with the basename', () => {
    expect(SETTINGS).toMatch(/\/hub\/club-arena\/invite\/\$\{clubId\}\?ref=\$\{playerNumber\}/);
  });

  it('no longer points at a route that redirects and eats the query string', () => {
    expect(codeOnly(SETTINGS)).not.toMatch(/\/clubs\?join=true/);
  });

  it('and Browse Clubs goes to the page that lists clubs', () => {
    // `/clubs` is <Navigate to="/" replace /> - the button labelled Browse
    // Clubs did not browse clubs.
    expect(codeOnly(INVITE)).not.toMatch(/navigate\('\/clubs'\)/);
    expect(INVITE).toMatch(/navigate\('\/clubs-list'\)/);
  });
});

describe('the invite page', () => {
  it('queries the column that exists', () => {
    expect(codeOnly(INVITE)).not.toMatch(/eq\('invite_code'/);
    expect(INVITE).toMatch(/clubQuery\.eq\('code', inviteCode\)/);
  });
});

describe('finding a player', () => {
  it('compares tournament status the way the column is actually stored', () => {
    expect(codeOnly(FIND)).not.toMatch(/tournament\.status === 'running'/);
    expect(codeOnly(FIND)).not.toMatch(/'late_reg'/);
    expect(FIND).toMatch(/tourneyStatus === 'RUNNING' \|\| tourneyStatus === 'REGISTERING'/);
  });

  it('compares table status case-insensitively too', () => {
    expect(FIND).toMatch(/tableStatus === 'running' \|\| tableStatus === 'waiting'/);
  });

  it('searches the whole roster, not the first 200 of it', () => {
    expect(codeOnly(FIND)).not.toMatch(/searchableUserIds\.slice\(0, 200\)/);
    expect(FIND).toMatch(/for \(let i = 0; i < scope\.searchableUserIds\.length/);
  });

  it('reports a failing typeahead instead of showing an empty dropdown', () => {
    expect(FIND).toMatch(/reportError\(pageError, 'FindPlayerModal\.fetchSuggestions'\)/);
  });

  it('knows co_owner is a role', () => {
    // It is in club_members_role_check and an owner can grant it. Without this
    // a co-owner was silently demoted to searching their friends list.
    expect(FIND).toMatch(/r === 'admin' \|\| r === 'co_owner'/);
  });
});

describe('the admin player search', () => {
  it('does not hand a non-uuid to a uuid column', () => {
    expect(PLAYER_SEARCH).toMatch(/That Is Not A Valid Player ID/);
  });

  it('says the search failed rather than claiming nobody matched', () => {
    expect(PLAYER_SEARCH).toMatch(/The Search Could Not Run\. Please Try Again\./);
    expect(PLAYER_SEARCH).toMatch(/\) : searchError \? \(/);
  });

  it('escapes ILIKE wildcards so an underscore does not over-match', () => {
    expect(PLAYER_SEARCH).toMatch(/likeSafe/);
    expect(codeOnly(PLAYER_SEARCH)).not.toMatch(/ilike\('username', `%\$\{query\}%`\)/);
  });
});
