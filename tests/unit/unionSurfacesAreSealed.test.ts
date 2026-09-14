/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERY DOOR INTO A UNION SURFACE IS SHUT (2026-08-23)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, binding: "players, agents, super agents, nobody should ever see the
 * union skins."
 *
 * A union is a row in the `clubs` table (`is_union = true`) with its own hub
 * club, and its games hang off that hub — so `tables.club_id` and
 * `tournaments.club_id` are the UNION on any union game. Three separate
 * surfaces read one of those columns and navigated straight to it:
 *
 *   1. the in-table "+"   → MultiTablePage rendered <ClubHomePage> for the
 *                           union inside the lobby tab
 *   2. every table exit   → TablePage navigated to /clubs/<union>
 *   3. the MTT ticker     → /clubs/<union>/tournaments, which is the screenshot
 *                           Dan sent: the Midway Union tournament list with
 *                           "+ Create Tournament" on it
 *
 * Each is fixed at source, and UnionSkinGuard backstops the ones nobody has
 * found yet. These are source-level assertions on purpose: the failure is a
 * NAVIGATION TARGET, which renders identically to the correct one until you
 * read the URL — so a rendering test would assert the same string anyway, with
 * a mounted router, four mocked queries and a live clock behind it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod, sliceBetween } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

const APP = read('src/App.tsx');
const GUARD = read('src/components/common/UnionSkinGuard.tsx');
const TICKER = read('src/components/tournament/TournamentStartingTicker.tsx');
/* The rail's reads live in the feed function since 2026-09-14. */
const FEED_SQL = read('supabase/migrations/20260914102703_the_rail_asks_the_server_once.sql');
const TABLE_PAGE = read('src/pages/TablePage.tsx');
const MULTI = read('src/pages/MultiTablePage.tsx');
const TRACKER = read('src/components/common/LastClubTracker.tsx');
const TAB_BAR = read('src/components/table/TableTabBar.tsx');

/**
 * The ticker's click handler, isolated from the poll and the marquee.
 *
 * RE-ANCHORED 2026-09-05. The handler used to be an inline `onClick` on the
 * marquee button and this file sliced between two class names to find it. The
 * render moved to TickerRail.tsx in the same pass, and the routing decision -
 * the thing this file actually guards - moved into a named `open` callback
 * here. Same rule, same file, new anchors: whatever owns the bar, the id in
 * the URL is a TOURNAMENT id and never a club id.
 */
const TICKER_CLICK = TICKER.slice(
  TICKER.indexOf('const open = useCallback('),
  TICKER.indexOf('[navigate]')
);

/** MultiTablePage's single home-club writer. */
const COMMIT_HOME_CLUB = MULTI.slice(
  MULTI.indexOf('const commitHomeClub = useCallback('),
  MULTI.indexOf('const handleAddTable = useCallback(')
);

describe('the MTT ticker opens the event, not a club list', () => {
  it('navigates to the tournament registration page', () => {
    /* /tournaments/:tournamentId is TournamentDetails — the page that owns the
       Register button via useTournamentRegistration.

       2026-08-26: the strip now carries OVERLAY announcements as well as
       starting-soon ones, so the click target is resolved once into
       `targetId` rather than reading `primary.id` inline. The rule is
       unchanged and the assertion below is what keeps it: whatever owns the
       bar, the id in the URL is a TOURNAMENT id. */
    expect(TICKER_CLICK).toMatch(/navigate\(`\/tournaments\/\$\{entry\.tournamentId\}`\)/);
  });

  it('the click target is only ever a tournament id, from every source', () => {
    /* Every source now composes its item through tickerMessages, and only two
       fields can carry a destination: `tournamentId` and `tableId`. If a third
       one ever appears carrying anything club-shaped, this fails - which is
       the whole point of this file. */
    const ITEM = read('src/components/tournament/tickerMessages.ts');
    const SHAPE = ITEM.slice(
      ITEM.indexOf('export interface TickerItem {'),
      ITEM.indexOf('/** Between the fields of one announcement. */')
    );
    expect(SHAPE).toMatch(/tournamentId\?: string;/);
    expect(SHAPE).toMatch(/tableId\?: string;/);
    expect(SHAPE).not.toMatch(/clubId/);
  });

  it('never routes through a club id again', () => {
    // The regression, verbatim: `/clubs/${primary.clubId}/tournaments`. On a
    // union game primary.clubId IS the union hub club.
    expect(TICKER_CLICK).not.toContain('primary.clubId');
    expect(TICKER_CLICK).not.toContain('clubId');
    expect(TICKER_CLICK).not.toMatch(/\/clubs\//);
  });

  it('the overlay query is scoped to the clubs the player belongs to', () => {
    /* An overlay announcement is an invitation to enter. A player must never
       be shown money they cannot go and win, and the club scope is what
       guarantees that - the same rule the starting-soon query follows.

       THE QUERY MOVED INTO THE DATABASE (2026-09-14). It is a block of
       fn_get_ticker_feed now, so this reads the migration. The guarantee got
       STRONGER in the move and this asserts the stronger form: the scope is no
       longer a club-id list the browser assembles and sends, it is `v_clubs`,
       built inside a SECURITY DEFINER function from the caller's own
       auth.uid(). A client cannot ask about a club it does not belong to, so
       there is no longer a request a union surface could widen. */
    const OVERLAY_Q = sliceBetween(FEED_SQL, '-- ── OVERLAYS', '-- ── REGISTRATION CLOSING');
    expect(OVERLAY_Q).toMatch(/t\.club_id = ANY\(v_clubs\)/);
    expect(OVERLAY_Q).toMatch(/t\.tournament_type = 'MTT'/);
    expect(OVERLAY_Q).toMatch(/t\.guaranteed_prize > 0/);
  });

  it('builds that scope from the caller, never from what the caller sent', () => {
    /* The whole point of the move. If `v_clubs` ever came from a parameter,
       every scoping guarantee on this rail would be back in the browser. */
    const SCOPE = sliceBetween(
      FEED_SQL,
      'SELECT COALESCE(array_agg(cm.club_id)',
      'IF array_length'
    );
    expect(SCOPE).toContain('cm.user_id = v_uid');
    expect(SCOPE).toContain("cm.status IN ('active', 'approved')");
    expect(FEED_SQL).toMatch(/v_uid\s+uuid := auth\.uid\(\)/);
    /* No parameter may name a club scope. p_rail_club_id is which club's rail
       is being PAINTED - it only ever suppresses a club name from the copy. */
    const SIGNATURE = sliceBetween(
      FEED_SQL,
      'CREATE OR REPLACE FUNCTION public.fn_get_ticker_feed',
      'RETURNS jsonb'
    );
    expect(SIGNATURE).not.toMatch(/p_club_ids|p_clubs\b/);
  });

  it('falls back to the GLOBAL lobby, which is never union-scoped', () => {
    expect(TICKER_CLICK).toMatch(/navigate\('\/tournaments'\)/);
  });

  it('a table opening opens that table, and nothing else routes by table', () => {
    /* The only non-tournament destination the bar has. It is a TABLE id from
       the table-openings source, never a club id and never a lobby. */
    expect(TICKER_CLICK).toMatch(/navigate\(`\/table\/\$\{entry\.tableId\}`\)/);
  });
});

describe('table exits land in a club, never a union', () => {
  it('exitDestination reads the union-filtered ref', () => {
    /* Bounded from the declaration rather than to the next named function:
       `handleLeaveTableRef` is declared ABOVE exitDestination, so slicing to
       indexOf('const handleLeaveTable') produced an empty string and the
       assertion passed against nothing. */
    const at = TABLE_PAGE.indexOf('const exitDestination = () => {');
    expect(at).toBeGreaterThan(-1);
    const fn = sliceMethod(TABLE_PAGE, 'const exitDestination = () => {');
    expect(fn).toContain('lobbyClubIdRef.current');
    // actualClubIdRef is the table's OWNER club — right for rake, wrong for a
    // destination, and the union hub on any union game.
    expect(fn).not.toContain('actualClubIdRef');
  });

  it('fills the lobby ref through the resolver, both passes', () => {
    // Sync first so a Leave click in the first moments still lands somewhere
    // real; async after, for the deep-link case with a cold cache.
    expect(TABLE_PAGE).toContain('resolveLobbyClubIdSync(lobbyClubArgs)');
    expect(TABLE_PAGE).toContain('resolveLobbyClubId(lobbyClubArgs)');
  });

  it('has no exit path left that navigates off actualClubIdRef', () => {
    /* Covers the tournament bust and the seat-release refund, which both did.
       Targeted at the NAVIGATION, not at the ref: actualClubIdRef is still the
       right answer for observer-chat permissions and the club leaderboard, and
       a blanket "this ref appears nowhere" would have failed on those two. */
    const clubNavs = [...TABLE_PAGE.matchAll(/navigate\(`\/clubs\/\$\{(clubId|backTo)\}`\)/g)];
    expect(clubNavs.length).toBeGreaterThan(0);
    for (const m of clubNavs) {
      const preceding = TABLE_PAGE.slice(Math.max(0, (m.index ?? 0) - 400), m.index);
      expect(preceding.lastIndexOf('lobbyClubIdRef.current')).toBeGreaterThan(
        preceding.lastIndexOf('actualClubIdRef.current')
      );
    }
  });
});

describe('the in-tab lobby has exactly one writer, and it filters unions', () => {
  it('commitHomeClub is the only thing that sets homeClubId', () => {
    const writes = MULTI.match(/setHomeClubId\(/g) ?? [];
    expect(writes).toHaveLength(1);
    expect(COMMIT_HOME_CLUB).toContain('setHomeClubId(');
    expect(COMMIT_HOME_CLUB).toContain('resolveLobbyClubId');
  });

  it('prefers the club the player entered through', () => {
    expect(COMMIT_HOME_CLUB).toContain('currentClubId');
  });
});

describe('UnionSkinGuard is mounted and fails open', () => {
  it('is rendered at the app root', () => {
    expect(APP).toContain("import UnionSkinGuard from './components/common/UnionSkinGuard'");
    expect(APP).toContain('<UnionSkinGuard />');
  });

  it('ejects only on a CONFIRMED union', () => {
    // isUnionClubId fails CLOSED (unknown → union). Using it here would throw a
    // player out of their own club lobby on a network blip.
    expect(GUARD).toContain('isConfirmedUnionClubId');
    expect(GUARD).not.toMatch(/[^dm]\bisUnionClubId\b/);
  });

  it('lets the union owner and its admins through', () => {
    expect(GUARD).toContain('owner_id');
    expect(GUARD).toContain('union_admins');
  });

  it('replaces the history entry so Back cannot bounce them in again', () => {
    expect(GUARD).toContain('{ replace: true }');
  });

  it('sends them to the same destination every other exit uses', () => {
    expect(GUARD).toContain('resolveLobbyClubId');
  });
});

/**
 * Dan 2026-08-23: "when you right click on an action tab, or hold it down on
 * mobile, you should get an option to Leave Table."
 *
 * The item existed but was gated on `tabs.length > 1`, so it vanished in the
 * commonest case of all — one table open.
 */
describe('the tab quick menu always offers Leave Table', () => {
  const LEAVE_ITEM = TAB_BAR.slice(
    TAB_BAR.indexOf("isLobby ? 'Close Lobby' : 'Leave Table'") - 400,
    TAB_BAR.indexOf("isLobby ? 'Close Lobby' : 'Leave Table'") + 120
  );

  it('does not hide the item when only one table is open', () => {
    expect(LEAVE_ITEM).toContain('(!isLobby || tabs.length > 1)');
    // The regression: a bare count gate in front of the item.
    expect(LEAVE_ITEM).not.toMatch(/onQuickAction &&\s*\n\s*tabs\.length > 1 &&\s*\n\s*item\(/);
  });

  it("still routes through the engine's secure cashout path", () => {
    expect(LEAVE_ITEM).toContain("onQuickAction(tab.id, 'leave')");
  });

  it('keeps the count gate for a lobby tab, which has nothing to close alone', () => {
    expect(LEAVE_ITEM).toContain('Close Lobby');
    expect(LEAVE_ITEM).toContain('tabs.length > 1');
  });
});

describe('a union is never recorded as your last club', () => {
  it('LastClubTracker checks before it remembers', () => {
    expect(TRACKER).toContain('isConfirmedUnionClubId');
    const effect = TRACKER.slice(TRACKER.indexOf('useEffect('));
    const guardAt = effect.indexOf('isConfirmedUnionClubId');
    const writeAt = effect.indexOf('rememberLastClub(uuid)');
    expect(guardAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(guardAt);
  });
});
