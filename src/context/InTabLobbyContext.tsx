/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  IN-TAB LOBBY NAVIGATION — the action bar never leaves the top of the screen
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28, verbatim: "NOTICE HOW IM INSIDE THE LOBBY FROM THE + BUTTON
 * SCREEN AND HAVE GONE TO MTT. IF I CLICK A LOBBY OR GO TO REGISTER A
 * TOURNAMENT, MY ACTION BAR DISAPPEARS AND THE PAGE GETS LOST. YOU HAVE TO FIX
 * THIS SO THAT IF YOU ARE ON A PAGE THROUGH THE + BUTTON, THAT YOUR ACTION BAR
 * STAYS AT THE TOP 100% OF THE TIME."
 *
 * WHY IT WAS BROKEN. MultiTablePage renders the club lobby inside a tab and
 * guarded it with ONE mechanism: `onClickCapture={handleLobbyLinkCapture}`,
 * which reads `e.target.closest('a')` and rewrites clicks on
 * `<a href="/tournaments/:id">` into an in-tab drill-in. That guard was written
 * against a lobby whose rows really were anchors. They are not any more —
 * `components/lobby/LobbyTable.tsx` contains no `<a>` and no `<Link>` at all.
 * Every row, every Details button, every Register callback is a `<div>` or
 * `<button>` whose handler calls `navigate()` imperatively, and an imperative
 * navigate produces NO CLICK ON AN ANCHOR, so the capture handler never ran.
 *
 * The route then changed to /tournaments/:id, which is outside /table/:tableId,
 * so MultiTablePage collapsed itself to display:none — taking the action bar,
 * the tab strip and the Take Seat bar with it. That is exactly the screenshot:
 * a tournament page with no bar above it and no way back except the small
 * "Return To Game" dock at the bottom.
 *
 * A DOM-click guard can never be the fix, because the thing it is guarding
 * against is not a DOM click. This is: a context the embedded lobby subtree
 * provides, and `useAppNavigate` — a drop-in replacement for react-router's
 * `useNavigate` — consults. Inside the in-tab lobby a tournament destination is
 * handed to the container to render IN THE TAB; everywhere else the hook is
 * react-router's `useNavigate` unchanged, byte for byte, so the same components
 * keep working on their own routes.
 *
 * Interception is deliberately narrow. `/table/:id` still navigates for real —
 * the route effect in MultiTablePage converts the lobby tab in place, which is
 * how sitting down from the lobby has always worked, and breaking it would cost
 * a seat. Only /tournaments/:id is pulled in-tab, because that is the one
 * destination that has an in-tab renderer.
 */

import { createContext, useContext, useMemo } from 'react';
import {
  useNavigate,
  type NavigateFunction,
  type NavigateOptions,
  type To,
} from 'react-router-dom';

export interface InTabLobbyNav {
  /**
   * Render this tournament INSIDE the current lobby tab instead of navigating
   * to /tournaments/:id. Returns true when the container took it; false means
   * it could not (no room), and the caller must fall through to a real
   * navigation rather than swallowing the click.
   */
  openTournament: (tournamentId: string) => boolean;
}

export const InTabLobbyContext = createContext<InTabLobbyNav | null>(null);

/** Non-null only inside the MultiTablePage in-tab lobby / tournament subtree. */
export function useInTabLobby(): InTabLobbyNav | null {
  return useContext(InTabLobbyContext);
}

/** `/tournaments/<id>` with an id that is not a further path segment. */
const TOURNAMENT_PATH = /^\/tournaments\/([^/?#]+)/;

/**
 * The tournament id in a react-router `To`, or null.
 *
 * Handles both shapes call sites actually use: a string path, and a partial
 * `{ pathname }` object. A search-only navigate (`{ search: '?x' }`, which
 * TournamentDetails uses to strip `?watch=1`) has no pathname and correctly
 * falls through to the real navigate — it is editing the current URL, not
 * leaving for a tournament.
 */
export function tournamentIdFromTo(to: To): string | null {
  const pathname = typeof to === 'string' ? to : (to.pathname ?? '');
  if (!pathname) return null;
  return pathname.match(TOURNAMENT_PATH)?.[1] ?? null;
}

/**
 * `useNavigate`, plus the in-tab rule.
 *
 * Use this instead of `useNavigate` in any component that can be rendered
 * inside the in-tab lobby (ClubHomePage, HomePage, TournamentDetails,
 * TournamentLobbyCard, useTournamentRegistration). Outside the provider it IS
 * `useNavigate` — the same function object react-router handed back — so
 * adopting it is free on every other route.
 */
export function useAppNavigate(): NavigateFunction {
  const navigate = useNavigate();
  const inTab = useInTabLobby();

  return useMemo<NavigateFunction>(() => {
    if (!inTab) return navigate;

    const wrapped = (to: To | number, options?: NavigateOptions) => {
      // A numeric `to` is history movement (back / forward). It cannot name a
      // tournament, and rewriting it would break the browser Back button.
      if (typeof to === 'number') {
        navigate(to);
        return;
      }
      const tournamentId = tournamentIdFromTo(to);
      // `openTournament` returning false means the container had no room for
      // it. Falling through to a real navigate is the honest outcome: the
      // player still reaches the tournament, and the cap toast has already
      // told them why the tab did not open.
      if (tournamentId && inTab.openTournament(tournamentId)) return;
      navigate(to, options);
    };

    return wrapped as NavigateFunction;
  }, [navigate, inTab]);
}
