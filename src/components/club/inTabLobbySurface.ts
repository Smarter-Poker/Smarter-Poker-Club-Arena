/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  IS THE PLAYER LOOKING AT A LOBBY RIGHT NOW? (Dan 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "WHEN YOU ARE ON A LIVE TABLE AND HIT THE + BUTTON AND GO TO
 * THE LOBBY, THE FOOTER MENU DOESN'T DISPLAY, AND IT NEEDS TO BE THERE ANYTIME
 * YOU ARE IN THE LOBBY, REGARDLESS OF HOW YOU GOT THERE OR WHICH ROUTE YOU
 * TOOK."
 *
 * WHY IT WAS MISSING. The "+" on a live table does not navigate anywhere: it
 * opens the club lobby as a TAB inside the multi-table container, on purpose,
 * so the running games are never torn down (MultiTablePage, OPEN_LOBBY_TAB).
 * The URL therefore stays /table/<id>. The one global footer is mounted at
 * the app root behind `shouldShowClubFooter(location.pathname)`, and /table/*
 * is on that denylist - correctly, because a footer over a live felt covers
 * the action buttons. So the player was in the lobby, on a table route, and
 * the pathname alone said "no footer".
 *
 * A pathname cannot answer this question by itself. The container knows which
 * tab is on screen, so it publishes that here, and the app-root gate reads
 * BOTH: the route, OR an in-tab lobby being the active tab. A lobby tab that
 * is mounted but behind a live table publishes false, so the footer never
 * floats over a game.
 *
 * External store rather than context because the reader (App.tsx) is the
 * container's parent, and because it must survive the container's own
 * display:none collapse without re-rendering the whole tree.
 */

import { useSyncExternalStore } from 'react';

let active = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => active;
const getServerSnapshot = () => false;

/** MultiTablePage calls this whenever its active tab changes or it unmounts. */
export function publishInTabLobbyActive(next: boolean): void {
  if (active === next) return;
  active = next;
  listeners.forEach((listener) => listener());
}

/** True while the active multi-table tab is a lobby the player can see. */
export function useInTabLobbyActive(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Test seam: reset between cases. */
export function resetInTabLobbyActiveForTests(): void {
  active = false;
}
