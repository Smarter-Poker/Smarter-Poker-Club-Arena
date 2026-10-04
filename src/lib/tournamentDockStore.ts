/**
 * The tournament info dock's collapse toggle, ONE value for every table open
 * in this browser tab.
 *
 * Each mounted table page used to read localStorage once and keep its own
 * copy, so collapsing the dock on one tournament tab left every other
 * already-mounted tournament tab open, with its action bar on a different
 * line (review of the 2026-10-04 dock, item 8). The flag is a preference about
 * the player's screen, not about a table: one store, every page subscribes.
 */
const KEY = 'ca.tournamentDock.collapsed';

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let collapsed: boolean | null = null;
const listeners = new Set<() => void>();

export function tournamentDockCollapsed(): boolean {
  if (collapsed === null) collapsed = read();
  return collapsed;
}

export function subscribeTournamentDock(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function toggleTournamentDockCollapsed(): void {
  collapsed = !tournamentDockCollapsed();
  try {
    window.localStorage.setItem(KEY, collapsed ? '1' : '0');
  } catch {
    /* Private mode: the choice simply lasts for this visit. */
  }
  for (const listener of Array.from(listeners)) listener();
}

/** Test seam: forget the cached value so the next read comes from storage. */
export function resetTournamentDockStoreForTests(): void {
  collapsed = null;
  listeners.clear();
}
