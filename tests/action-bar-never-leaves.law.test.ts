/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE ACTION BAR NEVER LEAVES THE TOP — LAW (Dan 2026-08-28, binding)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Verbatim: "NOTICE HOW IM INSIDE THE LOBBY FROM THE + BUTTON SCREEN AND HAVE
 * GONE TO MTT. IF I CLICK A LOBBY OR GO TO REGISTER A TOURNAMENT, MY ACTION BAR
 * DISAPPEARS AND THE PAGE GETS LOST. YOU HAVE TO FIX THIS SO THAT IF YOU ARE ON
 * A PAGE THROUGH THE + BUTTON, THAT YOUR ACTION BAR STAYS AT THE TOP 100% OF
 * THE TIME."
 *
 * The action bar lives inside MultiTablePage, and MultiTablePage collapses to
 * display:none on any route that is not /table/:tableId. So "the bar stays" and
 * "the route does not leave /table/* " are THE SAME REQUIREMENT, and every pin
 * below is really about the second one.
 *
 * WHAT ACTUALLY SHIPPED BROKEN. The only guard was
 * `onClickCapture={handleLobbyLinkCapture}`, which reads `closest('a')` and
 * rewrites clicks on `<a href="/tournaments/:id">`. It was written when lobby
 * rows were anchors. They stopped being anchors — src/components/lobby/
 * LobbyTable.tsx has no <a> and no <Link> in it — and every row became a
 * <div>/<button> calling navigate() imperatively, which produces no anchor
 * click at all. The guard silently stopped guarding anything, and nothing said
 * so. That is why the fix is a CONTEXT (which sees navigate calls) and not a
 * better click handler, and why the last pin here is a tripwire on the exact
 * assumption that rotted.
 *
 * If a pin below goes red you are re-shipping the reported bug: a seated player
 * taps an MTT row, the container unmounts, and the bar, the tab strip and the
 * Take Seat button all vanish while their hands are running. Fix your change.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../', p), 'utf8');

const CONTEXT = read('src/context/InTabLobbyContext.tsx');
const MULTI = read('src/pages/MultiTablePage.tsx');
const CLUB_HOME = read('src/pages/ClubHomePage.tsx');
const HOME = read('src/pages/HomePage.tsx');
const DETAILS = read('src/pages/tournament/TournamentDetails.tsx');
const SAT_CARD = read('src/components/tournament/TournamentLobbyCard.tsx');
const REG_HOOK = read('src/hooks/useTournamentRegistration.ts');
const LOBBY_TABLE = read('src/components/lobby/LobbyTable.tsx');

/**
 * The files that can render inside the in-tab lobby subtree. Every one of them
 * has at least one /tournaments/:id destination, and every one of them used to
 * take the player off the route.
 */
const IN_TAB_SURFACES: Array<[string, string]> = [
  ['ClubHomePage', CLUB_HOME],
  ['HomePage', HOME],
  ['TournamentDetails', DETAILS],
  ['TournamentLobbyCard', SAT_CARD],
  ['useTournamentRegistration', REG_HOOK],
];

describe('a page reached through the + button keeps its action bar', () => {
  it('every in-tab surface navigates through useAppNavigate, never useNavigate', () => {
    for (const [name, src] of IN_TAB_SURFACES) {
      expect(name && src).toBeTruthy();
      // The hook must be imported...
      expect(src).toContain('useAppNavigate');
      // ...and react-router's own must not be, in any import shape. A single
      // `const navigate = useNavigate()` in any of these files re-opens the
      // bug for every call site in it at once.
      expect(src, `${name} still imports useNavigate`).not.toMatch(
        /useNavigate\s*[,}].*from 'react-router-dom'|{\s*useNavigate\s*}/
      );
      expect(src, `${name} still calls useNavigate()`).not.toContain('useNavigate()');
    }
  });

  it('the interception rewrites /tournaments/:id and nothing else', () => {
    // /table/:id MUST still navigate for real: that is how a player takes a
    // seat from the lobby (MultiTablePage's route effect converts the lobby tab
    // in place). Rewriting it would cost someone a seat, which is strictly
    // worse than the bug being fixed.
    expect(CONTEXT).toContain('/^\\/tournaments\\/([^/?#]+)/');
    expect(CONTEXT).not.toMatch(/\^\\\/table\\\//);
  });

  it('a numeric navigate (browser Back) is passed straight through', () => {
    expect(CONTEXT).toContain("typeof to === 'number'");
  });

  it('interception yields when the container has no room, never swallows', () => {
    // openTournamentTab returns false at the table cap. Both consumers must
    // fall through to a real navigation rather than leaving a dead tap: a
    // player who cannot open a tab must still be able to READ the tournament.
    // Round 2 passes a {tournamentId, search} target rather than a bare id, so
    // the query survives (see the WATCH pin below). The YIELD is what matters
    // here and it is unchanged.
    expect(CONTEXT).toContain('inTab.openTournament(target)) return');
    expect(MULTI).toContain('if (!openTournamentTab(target)) return;');
  });

  it('BOTH lobby-tab branches are inside the provider and keep the click capture', () => {
    // The tournament branch had NO capture handler at all, which is how a
    // satellite card inside TournamentDetails escaped every time.
    expect(MULTI).toContain('InTabLobbyContext.Provider');
    const occurrences = MULTI.split('onClickCapture={handleLobbyLinkCapture}').length - 1;
    expect(occurrences).toBe(2);
  });

  it('the route itself is the backstop when tables are open', () => {
    expect(MULTI).toContain("matchPath('/tournaments/:tournamentId', location.pathname)");
    // It must be inert with nothing running — /tournaments/:id is an ordinary
    // page for a player with no tables open.
    expect(MULTI).toContain('if (open.length === 0) return;');
  });

  it('the in-tab tournament error state offers no route-leaving escape', () => {
    // "Back To Clubs" on the Tournament Not Found screen is a real anchor to a
    // route outside /table/*. In the tab it is suppressed; MultiTablePage's own
    // "← Lobby" pill is the way back.
    expect(DETAILS).toContain('{!tournamentIdOverride && (');
  });

  it('TRIPWIRE: lobby rows are still not anchors', () => {
    /**
     * This is the assumption whose rotting caused the bug. If LobbyTable ever
     * gains real <a>/<Link> rows again, the click-capture path becomes load
     * bearing once more and the comments describing it as a secondary net are
     * wrong. Update those comments (and this pin) deliberately — do not let the
     * two drift apart a second time.
     */
    expect(LOBBY_TABLE).not.toMatch(/<Link\b/);
    expect(LOBBY_TABLE).not.toMatch(/<a\s/);
  });

  it('the law is written where the next agent will read it', () => {
    expect(CONTEXT).toContain('STAYS AT THE TOP 100% OF THE TIME');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ROUND 2 — what the first pass got wrong, and what it never covered
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Round 1 generalised the MECHANISM (a context beats a DOM click-capture) but
 * kept the old guard's SCOPE, and lost data on the way through. Every pin below
 * is a defect that shipped in it, or a hole it left open.
 */
describe('the drill-in carries everything the route carried', () => {
  it('the query string survives — the WATCH button regression', () => {
    /**
     * `/tournaments/:id?watch=1` is how TournamentLobbyCard opens a running
     * event's table. Round 1 passed only `match[1]` / the bare id, so in the
     * tab the parameter never arrived and a button labelled "Watch" opened a
     * details page and stopped. It still worked on the real route, which is
     * how a bug like this survives a demo.
     */
    expect(CONTEXT).toContain('search: string');
    expect(CONTEXT).toContain('tournamentTargetFromTo');
    // Both entry points must parse through the SAME function, or an anchor and
    // an imperative navigate can disagree about one destination.
    expect(MULTI).toContain('tournamentTargetFromTo(href)');
    expect(MULTI).not.toContain('openTournamentTab(match[1])');
    // And the details page has to be able to RECEIVE it.
    expect(DETAILS).toContain('searchOverride');
  });

  it('embedded, the watch intent never rewrites the table URL', () => {
    // navigate({ search }) resolves its missing pathname from the CURRENT
    // location. In-tab that is /table/:tableId, so consuming ?watch=1 there
    // would wipe ?name=&stakes=&code= — the params MultiTablePage reads to
    // name a tab it has not built yet.
    expect(DETAILS).toContain('if (searchOverride === undefined) {');
  });

  it('the drill-in is a stack, so satellite -> back returns to the parent', () => {
    for (const tok of ['lobbyTournamentStack', 'pushLobbyTournament', 'popLobbyTournament']) {
      expect(MULTI, `${tok} missing`).toContain(tok);
    }
    // The back pill must pop ONE level, never blank the whole history.
    expect(MULTI).toContain('popLobbyTournamentTab(table.id)');
    expect(MULTI).not.toContain('clearLobbyTournament(table.id)');
  });

  it('the + button returns to the lobby, not to a stale tournament', () => {
    // OPEN_LOBBY_TAB used to focus the tab and leave lobbyTournamentId set, so
    // "+" reopened whatever tournament the tab was parked on — or, if that tab
    // was already active, did nothing visible at all.
    expect(MULTI).toContain('cur.map((t) => (isLobbyTab(t) ? clearLobbyTournaments(t) : t))');
  });

  it('drill-ins use a functional updater, so two in one tick cannot lose one', () => {
    expect(MULTI).toContain('setTables((cur) =>');
    expect(MULTI).not.toContain('setTables(prev.map((t) => (isLobbyTab(t)');
  });

  it('the whole container is inside the provider, not just the lobby tab', () => {
    // TournamentLobbyModal renders TournamentDetails (and its SatellitesTab)
    // from inside TablePage. With the provider wrapping only renderLobbyTab,
    // a satellite tap on the felt did a real route change.
    const providerAt = MULTI.indexOf('<InTabLobbyContext.Provider');
    const dockAt = MULTI.indexOf('<LiveTablesBar');
    expect(providerAt).toBeGreaterThan(-1);
    expect(dockAt).toBeGreaterThan(providerAt);
    // Exactly one provider — a nested second copy is how two guards drift.
    expect(MULTI.split('<InTabLobbyContext.Provider').length - 1).toBe(1);
  });

  it('the bare /tournaments list is covered too', () => {
    // matchPath('/tournaments/:tournamentId') does not match '/tournaments',
    // and TournamentStartingTicker — an app-root marquee over every table —
    // falls back to exactly that when it cannot resolve an id.
    expect(MULTI).toContain("matchPath('/tournaments', location.pathname)");
  });
});

describe('nothing throws a seated player off their table without a gesture', () => {
  const SUPABASE_LIB = read('src/lib/supabase.ts');
  const AD_SERVICE = read('src/services/AdService.ts');
  const AD_ROTATOR = read('src/components/ads/HouseAdRotator.tsx');

  it('a failed auth read is not evidence that there is no user', () => {
    // getAuthUser returns { user: null } both when signed out AND when its
    // 5s getUser() times out. ClubHomePage navigated to /invite on that null,
    // from a LOAD EFFECT — so one slow network call mid-hand collapsed the
    // container with nobody having clicked anything.
    expect(SUPABASE_LIB).toContain('failed: true as const');
    expect(CLUB_HOME).toContain('?.failed');
  });

  it('a failed membership read is not evidence of non-membership', () => {
    // PostgREST returns data:null for a 500, a statement timeout or an RLS
    // hiccup. `error` was never inspected, so all of them read as "not a
    // member" and bounced. The union cascade in this same file already had
    // the right rule: downgrade only on POSITIVE evidence of absence.
    /**
     * Both membership reads — the `get_club_home` fast path and the full
     * `loadClubData` — must inspect `error` before concluding anything.
     *
     * Asserted by SHAPE rather than by variable name: PR #1702 fixed the same
     * defect independently while this was in flight, and its names won the
     * merge. Pinning `memStatError` would have made this test a claim about
     * whose branch landed first, which is not what anyone needs it to say.
     */
    const destructures =
      CLUB_HOME.match(/\{\s*data:\s*\w+,\s*error:\s*\w+\s*\}\s*=\s*await/g) ?? [];
    expect(destructures.length).toBeGreaterThanOrEqual(1);
    expect(CLUB_HOME).toContain('if (memberResult.error) {');
    // Every membership read's error must reach the reporter rather than a bounce.
    expect(CLUB_HOME).toMatch(/membership_unreadable/);
  });

  it('every /invite redirect goes through the embedded-aware helper', () => {
    expect(CLUB_HOME).toContain('const bounceToInvite = useCallback');
    /**
     * EXACTLY ONE navigate to /invite may exist in this file, and it is the one
     * INSIDE `bounceToInvite`. Every other site calls the helper, which renders
     * an in-tab panel when embedded instead of routing away. Counting is the
     * honest assertion here: a second raw call is precisely the regression, and
     * it does not matter which line it is on.
     */
    expect(CLUB_HOME.match(/navigate\(`\/invite\//g) ?? []).toHaveLength(1);
    expect(CLUB_HOME.match(/bounceToInvite\(\)/g) ?? []).not.toHaveLength(0);
  });

  it("the club error panel's exit is hidden in the tab", () => {
    expect(CLUB_HOME).toContain('{!clubIdOverride && (');
  });

  it('GameLobbyPanel asks the context, not a coincidence of props', () => {
    const PANEL = read('src/components/lobby/GameLobbyPanel.tsx');
    // Its "Back To All Games" link leaves /table/*. It was safe only because
    // ClubHomePage happens to pass embedded={Boolean(clubIdOverride)} — two
    // unrelated flags agreeing, not an invariant. The context knows.
    expect(PANEL).toContain('useInTabLobby');
    expect(PANEL).toContain('const isEmbedded =');
    expect(PANEL).toContain('{isEmbedded ? (');
  });

  it('an ad row cannot choose where the router goes', () => {
    // target_url is unvalidated admin-entered text handed straight to
    // navigate(). isSafeAdImage existed; its destination twin did not.
    expect(AD_SERVICE).toContain('export function isSafeAdTarget');
    expect(AD_ROTATOR).toContain('isSafeAdTarget(url)');
    // HouseAdCard was retired 2026-09-13; every surface is the rotator now.
    // Protocol-relative and backslash forms must be rejected, not just
    // "starts with a slash".
    expect(AD_SERVICE).toContain("!url.startsWith('//')");
    expect(AD_SERVICE).toContain("url.includes('\\\\')");
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ROUND 3 — the bar stops depending on the route at all
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Rounds 1 and 2 keep the bar by never LEAVING /table/*, which works for
 * destinations the tab can render and cannot work for the ones it cannot: the
 * club bottom nav's six links, create-table, buy-diamonds, a house ad pointing
 * at /marketplace. Refusing to navigate would be worse than the bug — the
 * player asked to go to the cashier.
 *
 * So off-route the strip is hoisted out of the hidden container and fixed to
 * the top of the viewport. "100% of the time" stops being a list of
 * destinations somebody has to remember to extend.
 */
describe('the bar outlives the route', () => {
  const CSS = read('src/pages/MultiTablePage.css');

  it('renders the strip while the container is hidden', () => {
    expect(MULTI).toContain('{hidden && tables.length >= 1 && (');
    expect(MULTI).toContain('multi-table-page__tab-bar-wrapper--pinned');
    // One TableTabBar per state, both fed the SAME props — a second strip that
    // drifts from the first is worse than no second strip.
    expect(MULTI.split('<TableTabBar').length - 1).toBe(2);
  });

  it('is pinned, above the page, and clears the notch', () => {
    const block = CSS.slice(
      CSS.indexOf('.multi-table-page__tab-bar-wrapper--pinned'),
      CSS.indexOf('body[data-ca-pinned-bar')
    );
    expect(block).toMatch(/position:\s*fixed/);
    /* The header still owns y=0 and this bar still starts at its bottom edge.
       What changed on 2026-08-30 is that the MTT ticker takes the band in
       between - Dan: "THE TICKER MUST ALWAYS BE AT THE VERY TOP OF THE PAGE,
       DIRECTLY UNDER THE GLOBAL HEADER, THE 'ACTION TAB' SHOULD NEVER BE ABOVE
       IT." `--mtt-ticker-h` is absent unless a ticker is actually on screen, so
       this still resolves to exactly the header height on a quiet schedule. */
    expect(block).toMatch(
      /top:\s*calc\(\s*var\(--ca-global-header-height,\s*0px\)\s*\+\s*var\(--mtt-ticker-h,\s*0px\)\s*\)/
    );
    expect(block).toMatch(/padding-top:\s*0/);
    expect(block).not.toMatch(/padding-top:\s*env\(safe-area-inset-top/);
  });

  it('makes room for itself so it covers nothing', () => {
    // A fixed bar is out of flow. AppLayout owns an in-flow slot immediately
    // after GlobalHeader; body padding would move the header below the bar.
    expect(CSS).toContain("body[data-ca-pinned-bar='1']");
    expect(CSS).not.toMatch(/body\[data-ca-pinned-bar='1'\]\s*\{[^}]*padding-top/s);
    expect(read('src/components/layouts/AppLayout.tsx')).toContain('pinnedActionBarClearance');
    expect(MULTI).toContain("body.setAttribute('data-ca-pinned-bar', '1')");
    expect(MULTI).toContain("body.removeAttribute('data-ca-pinned-bar')");
  });

  it('the urgent dock survives, and only for urgency', () => {
    // The strip supersedes "Return to game". A countdown the player is about
    // to lose money to is a different job, and sits at the bottom in thumb
    // reach rather than at the top.
    expect(MULTI).toContain("hidden && dock.kind === 'urgent'");
    expect(MULTI).not.toContain("hidden && dock.kind !== 'none'");
  });

  it('a lobby tab is reachable from off-route', () => {
    // A lobby tab has no /table URL, and the container only un-hides for one.
    // It borrows a real open table's URL and overrides the index that route
    // would otherwise select.
    expect(MULTI).toContain('pendingTabIndexRef');
    expect(MULTI).toContain('pendingTabIndexRef.current = idx;');
    // Consumed once and cleared unconditionally, so a stale intent can never
    // redirect a later unrelated arrival.
    expect(MULTI).toContain('pendingTabIndexRef.current = null;');
  });

  it('pressing the tab you are already on still takes you back', () => {
    // Off-route that press is not a no-op: it means "return to my table". The
    // old `idx !== activeIndex` gate made the likeliest tab dead.
    const sel = MULTI.slice(
      MULTI.indexOf('const handleTabSelect'),
      MULTI.indexOf('// ─── Batch 3: quick-join sheet')
    );
    expect(sel).toContain('if (idx === -1) return;');
    // The navigation must sit OUTSIDE the animation gate.
    const gate = sel.indexOf('if (idx !== activeIndex) {');
    const nav = sel.indexOf('navigate(`/table/${target.id}');
    expect(gate).toBeGreaterThan(-1);
    expect(nav).toBeGreaterThan(gate);
    expect(sel.slice(gate, nav)).toContain('}');
  });
});

describe('a /table url never says less than the tab already knew', () => {
  it('every navigation carries name, stakes and code', () => {
    // The route effect reads those three to label a tab it has not built yet,
    // falling back to "Table 1" with blank stakes. Three call sites sent a
    // bare id, so a reload downgraded a labelled tab.
    expect(MULTI).toContain('const tableQuery = (t: TableInstance): string =>');
    /* Comments stripped first: this file DISCUSSES the bare form in several
       block comments (it is describing the bug), and a pin that cannot tell
       prose from code would either fail forever or force the explanations
       out. Only real call sites count. */
    const code = MULTI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const bare = code.match(/navigate\(`\/table\/\$\{[^}]+\}`/g) ?? [];
    expect(bare, `bare /table navigations: ${bare.join(', ')}`).toHaveLength(0);
  });

  it('does not write a placeholder name into the url', () => {
    // "Table 3" is the ABSENCE of a name; persisting it would make the
    // fallback permanent.
    expect(MULTI).toContain('!/^Table \\d+$/.test(t.name)');
  });
});

describe('the drill-in survives a reload, without resurrecting a seat', () => {
  it('persists the stack under its own key, with a TTL', () => {
    expect(MULTI).toContain("const DRILL_IN_KEY = 'ca_lobby_drill_in'");
    expect(MULTI).toContain('DRILL_IN_TTL_MS');
    // NOT the key that was deleted for resurrecting tables.
    expect(MULTI).toContain("sessionStorage.removeItem('multi_table_session')");
  });

  it('validates what it reads back rather than trusting the blob', () => {
    const read_ = MULTI.slice(
      MULTI.indexOf('const readDrillIn'),
      MULTI.indexOf('/** Lobby tabs carry')
    );
    expect(read_).toContain('Array.isArray');
    expect(read_).toMatch(/typeof \(e as InTabTournamentTarget\)\.tournamentId === 'string'/);
  });

  it('waits for server truth, and yields to it', () => {
    // A seat is worth more than a page you were reading: the restored lobby
    // tab must never win the last slot from a real seat.
    expect(MULTI).toContain('if (!tablesReady) return;');
    expect(MULTI).toContain('if (!openTournamentTab(saved[saved.length - 1])) return;');
  });

  it('never overwrites a live drill-in', () => {
    expect(MULTI).toContain(
      'if (tablesRef.current.some((t) => isLobbyTab(t) && t.lobbyTournamentId)) return;'
    );
  });
});
