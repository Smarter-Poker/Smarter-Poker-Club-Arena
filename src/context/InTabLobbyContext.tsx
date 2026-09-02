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

/** A tournament destination, split the way the in-tab renderer needs it. */
export interface InTabTournamentTarget {
  tournamentId: string;
  /**
   * The query string that rode along, INCLUDING the leading "?" ('' when there
   * was none).
   *
   * Dan 2026-08-28 round 2 — THIS FIELD IS A BUG FIX, NOT A CONVENIENCE.
   * Round 1 passed the id alone and dropped everything after it, which broke
   * the one control that depends on the query: TournamentLobbyCard's WATCH
   * button navigates to `/tournaments/<id>?watch=1`, and TournamentDetails
   * consumes `watch=1` to open the featured table. In the tab the parameter
   * never arrived, so the button opened the details page and stopped — a
   * control labelled "Watch" that did not watch. Outside the tab it worked,
   * which is exactly the kind of split behaviour nobody reports as one bug.
   */
  search: string;
}

export interface InTabLobbyNav {
  /**
   * Render this tournament INSIDE the current lobby tab instead of navigating
   * to /tournaments/:id. Returns true when the container took it; false means
   * it could not (no room), and the caller must fall through to a real
   * navigation rather than swallowing the click.
   */
  openTournament: (target: InTabTournamentTarget) => boolean;
}

export const InTabLobbyContext = createContext<InTabLobbyNav | null>(null);

/** Non-null only inside the MultiTablePage in-tab lobby / tournament subtree. */
export function useInTabLobby(): InTabLobbyNav | null {
  return useContext(InTabLobbyContext);
}

/** `/tournaments/<id>` with an id that is not a further path segment. */
const TOURNAMENT_PATH = /^\/tournaments\/([^/?#]+)/;

/**
 * The tournament destination in a react-router `To`, or null.
 *
 * Handles both shapes call sites actually use: a string path, and a partial
 * `{ pathname, search }` object. A search-only navigate (`{ search: '?x' }`,
 * which TournamentDetails uses to strip `?watch=1`) has no pathname and
 * correctly falls through to the real navigate — it is editing the current
 * URL, not leaving for a tournament.
 */
export function tournamentTargetFromTo(to: To): InTabTournamentTarget | null {
  const pathname = typeof to === 'string' ? to : (to.pathname ?? '');
  if (!pathname) return null;
  const id = pathname.match(TOURNAMENT_PATH)?.[1];
  if (!id) return null;

  // The search can arrive either inside the string ("/tournaments/x?watch=1")
  // or as its own field on a To object. Read whichever is present, and
  // normalise to a leading "?" so the consumer never has to care which.
  let search = '';
  if (typeof to === 'string') {
    const q = to.indexOf('?');
    if (q !== -1) search = to.slice(q);
  } else if (to.search) {
    search = to.search.startsWith('?') ? to.search : `?${to.search}`;
  }
  return { tournamentId: id, search };
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
      const target = tournamentTargetFromTo(to);
      // `openTournament` returning false means the container had no room for
      // it. Falling through to a real navigate is the honest outcome: the
      // player still reaches the tournament, and the cap toast has already
      // told them why the tab did not open.
      if (target && inTab.openTournament(target)) return;
      navigate(to, options);
    };

    return wrapped as NavigateFunction;
  }, [navigate, inTab]);
}
