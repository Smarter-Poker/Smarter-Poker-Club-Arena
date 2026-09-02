/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW — THE MENU STAYS IN THE CLUB YOU ARE IN
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-02, binding:
 *
 *   "WHEN YOU GO TO THE HAMBURGER MENU INSIDE ANY CLUB, THAT ENTIRE HAMBURGER
 *    MENU NEEDS TO BE LINKED TO THAT CLUB. IF YOU ARE A PART OF MULTIPLE CLUBS
 *    (OR UNIONS) IT SHOULD ALWAYS BE OPEN TO THAT SPECIFIC CLUB, AND THE SLUGS
 *    MUST MATCH FOR PAGES LIKE THE LEADERBOARDS PAGE."
 *
 * THE BUG THIS SHIPPED TO FIX. Standing inside Deep Stack Society, Dan opened
 * Leaderboards and got Club JAQK. Two independent faults, and each one alone
 * was enough:
 *
 *   1. The link threw the club away. `getClubArenaNavigation` had a
 *      `clubPath()` builder and used it for four of sixteen destinations;
 *      Leaderboards was one of the twelve hardcoded global strings.
 *   2. The page could not have read it anyway. `LeaderboardPage` matched the
 *      URL's club with `club.id === requestedClubId` — true only for a UUID,
 *      while `SlugEnforcer` guarantees the URL carries a slug — and on failure
 *      fell through to `clubs[0]`, so the wrong club arrived with no error.
 *
 * Every assertion below is one of those two faults. A red test here means one
 * of them is back.
 */

import { describe, expect, it } from 'vitest';
import {
  CLUB_CONTEXT_PARAM,
  CLUB_SCOPED_GLOBAL_ROUTES,
  findClubByParam,
  isClubScopedGlobalRoute,
  matchesClubParam,
  readClubContextParam,
  withClubContext,
} from '../src/utils/clubScopedPath';
import { getClubArenaNavigation } from '../src/config/clubArenaNavigation';

const CLUB = 'deep-stack-society';

describe('LAW: a club-scoped link carries its club', () => {
  it('stamps the club onto every club-scoped global route', () => {
    for (const route of CLUB_SCOPED_GLOBAL_ROUTES) {
      const stamped = withClubContext(route, CLUB);
      expect(
        new URLSearchParams(stamped.split('?')[1] || '').get(CLUB_CONTEXT_PARAM),
        `${route} must carry the club`
      ).toBe(CLUB);
    }
  });

  it('passes the identifier through unchanged, so the slugs match', () => {
    // Dan's "THE SLUGS MUST MATCH": whatever the route is already using is
    // what the link carries. Swapping in a UUID here would put an identifier
    // in the address bar that the player has never seen.
    expect(withClubContext('/leaderboard', CLUB)).toBe(`/leaderboard?club=${CLUB}`);
    expect(withClubContext('/leaderboard', '25450')).toBe('/leaderboard?club=25450');
  });

  it('leaves personal and arena-wide routes alone', () => {
    // A club on these would be a parameter nothing reads, riding along on
    // every URL a player shares.
    for (const route of ['/profile', '/settings', '/notifications', '/legal/tos', '/friends']) {
      expect(withClubContext(route, CLUB)).toBe(route);
    }
  });

  it('never adds a second, contradicting club to an already-scoped path', () => {
    expect(withClubContext('/clubs/other-club/cashier', CLUB)).toBe('/clubs/other-club/cashier');
    expect(withClubContext('/unions/some-union', CLUB)).toBe('/unions/some-union');
    expect(isClubScopedGlobalRoute('/clubs/x/leaderboard')).toBe(false);
  });

  it('preserves existing query parameters and fragments', () => {
    const stamped = withClubContext('/tournament-results?filter=mine&type=spin#top', CLUB);
    const params = new URLSearchParams(stamped.split('?')[1].split('#')[0]);
    expect(params.get('filter')).toBe('mine');
    expect(params.get('type')).toBe('spin');
    expect(params.get(CLUB_CONTEXT_PARAM)).toBe(CLUB);
    expect(stamped.endsWith('#top')).toBe(true);
  });

  it('does not override a club the caller set deliberately', () => {
    // The Owner Prize Tools picker builds its own club param. This must not
    // fight it.
    const explicit = '/leaderboard?setup=prizes&club=another-club';
    expect(withClubContext(explicit, CLUB)).toBe(explicit);
  });

  it('is a no-op with no club in play, so signed-out nav is unchanged', () => {
    expect(withClubContext('/leaderboard', null)).toBe('/leaderboard');
    expect(withClubContext('/leaderboard', '')).toBe('/leaderboard');
  });
});

describe('LAW: the hamburger is linked to the club you are inside', () => {
  const flatten = (clubId: string | null) =>
    getClubArenaNavigation({ clubId, clubRole: 'owner', isPlatformStaff: false }).flatMap(
      (group) => group.items
    );

  it('gives EVERY destination the club, not just the four that had clubPath()', () => {
    const items = flatten(CLUB);
    const offenders = items
      .filter((item) => isClubScopedGlobalRoute(item.path))
      .filter((item) => readClubContextParam(item.path.split('?')[1] || '') !== CLUB);

    expect(
      offenders.map((item) => `${item.label} -> ${item.path}`),
      'every club-scoped destination in the drawer must carry the club'
    ).toEqual([]);
  });

  it('routes Leaderboards to the club the player is standing in', () => {
    // The exact destination in Dan's 2026-09-02 report.
    const leaderboards = flatten(CLUB).find((item) => item.label === 'Leaderboards');
    expect(leaderboards).toBeDefined();
    expect(leaderboards!.path).toBe(`/leaderboard?club=${CLUB}`);
  });

  it('carries the club to the messenger too', () => {
    // `external` describes the DESTINATION, not the route: Messages navigates
    // in-app to NavigateToMessenger, which forwards `?club=` to the Hub. This
    // was skipped once as "external" and dropped the club at the last hop.
    const messages = flatten(CLUB).find((item) => item.label === 'Messages');
    expect(messages!.path).toContain(`club=${CLUB}`);
  });

  it('adds nothing when there is no club, so the global drawer is untouched', () => {
    for (const item of flatten(null)) {
      expect(item.path).not.toContain(`${CLUB_CONTEXT_PARAM}=`);
    }
  });
});

describe('LAW: a page resolves the club the URL actually names', () => {
  const clubs = [
    { id: '11111111-1111-4111-8111-111111111111', slug: 'club-jaqk', club_id: 10001 },
    { id: '22222222-2222-4222-8222-222222222222', slug: CLUB, club_id: 25450 },
  ];

  it('matches a slug — the form SlugEnforcer guarantees the URL carries', () => {
    // This is the whole reported bug. `club.id === 'deep-stack-society'` was
    // false, and the page silently showed clubs[0] (Club JAQK) instead.
    expect(findClubByParam(clubs, CLUB)?.id).toBe(clubs[1].id);
  });

  it('matches a UUID and a 6-digit club code as well', () => {
    expect(findClubByParam(clubs, clubs[1].id)?.id).toBe(clubs[1].id);
    expect(findClubByParam(clubs, '25450')?.id).toBe(clubs[1].id);
  });

  it('is case-insensitive, so a link mangled in transit still opens', () => {
    expect(findClubByParam(clubs, 'DEEP-STACK-SOCIETY')?.id).toBe(clubs[1].id);
  });

  it('returns null rather than a different club when the URL names one you are not in', () => {
    // NULL IS A MEANINGFUL ANSWER. `|| clubs[0]` here is what turned a
    // dropped parameter into a wrong club with no error, and is forbidden.
    expect(findClubByParam(clubs, 'a-club-i-left')).toBeNull();
    expect(findClubByParam(clubs, null)).toBeNull();
    expect(matchesClubParam(clubs[0], '')).toBe(false);
  });

  it('reads the param off a real search string', () => {
    expect(readClubContextParam(`?setup=prizes&club=${CLUB}`)).toBe(CLUB);
    expect(readClubContextParam('?period=week')).toBeNull();
    expect(readClubContextParam('')).toBeNull();
  });
});
