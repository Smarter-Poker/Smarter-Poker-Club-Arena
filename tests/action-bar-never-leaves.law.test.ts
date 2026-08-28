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
    expect(CONTEXT).toContain('inTab.openTournament(tournamentId)) return');
    expect(MULTI).toContain('if (!openTournamentTab(match[1])) return;');
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
