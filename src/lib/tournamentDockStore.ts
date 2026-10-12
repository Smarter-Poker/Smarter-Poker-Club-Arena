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
const CLOSED_KEY = 'ca.tournamentDock.closed';
let closed: boolean | null = null;

export function tournamentDockClosed(): boolean {
  if (closed === null) {
    try {
      closed = window.localStorage.getItem(CLOSED_KEY) === '1';
    } catch {
      closed = false;
    }
  }
  return closed;
}

export function setTournamentDockClosed(value: boolean): void {
  if (value === tournamentDockClosed()) return;
  closed = value;
  try {
    window.localStorage.setItem(CLOSED_KEY, value ? '1' : '0');
  } catch {
    /* Private mode keeps the choice for this visit. */
  }
  for (const listener of Array.from(listeners)) listener();
}

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

/**
 * Another browser tab changed the choice: adopt it, so two open tabs agree on
 * one dock. Installed with the first subscriber and removed with the last.
 */
function onStorage(e: StorageEvent): void {
  if (e.key === CLOSED_KEY) {
    closed = e.newValue === '1';
    for (const listener of Array.from(listeners)) listener();
    return;
  }
  if (e.key !== KEY) return;
  const next = e.newValue === '1';
  if (next === collapsed) return;
  collapsed = next;
  for (const listener of Array.from(listeners)) listener();
}

export function subscribeTournamentDock(listener: () => void): () => void {
  if (listeners.size === 0) {
    try {
      window.addEventListener('storage', onStorage);
    } catch {
      /* No window (prerender): nothing to sync with. */
    }
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      try {
        window.removeEventListener('storage', onStorage);
      } catch {
        /* No window (prerender). */
      }
    }
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
  closed = null;
  listeners.clear();
  try {
    window.removeEventListener('storage', onStorage);
  } catch {
    /* No window. */
  }
}
