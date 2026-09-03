/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LOBBY VIEW PREFERENCES — the tab, the sort and the Favorites chip, remembered
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-26: "ANY PREFERENCES, OR STAKES THAT ARE SELECTED SHOULD ALWAYS
 * BE AUTO SAVED FOR THE USER. WHEN THEY GO BACK TO THE PAGE, IT SHOULDN'T BE
 * RESET. THEY SHOULD AUTO SAVE UNTIL CHANGED."
 *
 * WHAT WAS ALREADY SAVED, AND WHAT WAS NOT. The lobby had two halves of this
 * and neither of them was the half a player notices first:
 *
 *   SAVED   the Advanced Filters sheet, the stake chips and the status chips
 *           (`ca_advanced_filters_<club>`, in AdvancedFilters.tsx) and each
 *           table's column sort (`ca_lobby_sort_<club>_<category>`).
 *   NOT     the GAME TYPE TAB, the SORT BY control, and the Favorites chip.
 *
 * So a player who set up the PLO tab sorted by stakes came back to ALL sorted
 * by starting time, saw a different board, and reasonably concluded nothing
 * had been remembered — the saved filters were still there, just underneath a
 * tab they were not looking at.
 *
 * THE SORT IS PER TAB, deliberately. It always was in effect: choosing a tab
 * overwrote the sort with that tab's default (MTT by starting time, cash by
 * recommended), so a single global value could never survive a tab change
 * anyway. Storing one sort per tab keeps those defaults for a first visit and
 * keeps the player's choice for every visit after.
 *
 * HOSTILE STATE. Everything read here is validated against the CURRENT tab and
 * sort lists before it is used, so a preference written by an older build (or
 * hand-edited, or truncated by a full disk) degrades to the default rather
 * than selecting a tab that no longer exists. Reads and writes are wrapped:
 * Safari private mode throws on localStorage access rather than returning null.
 */

export type LobbyTabKey = 'ALL' | 'HOLDEM' | 'OMAHA' | 'LIMIT' | 'MIXED' | 'MTT' | 'SNG' | 'SPIN';
export type LobbySortKey =
  | 'recommended'
  | 'stakes_high'
  | 'stakes_low'
  | 'players'
  | 'starting_soon';

export interface LobbyViewPrefs {
  /** Last game-type tab this player used in this club. */
  tab: LobbyTabKey | null;
  /** Last Sort By choice, per tab. Absent for a tab means "use the default". */
  sortByTab: Partial<Record<LobbyTabKey, LobbySortKey>>;
  /** Was the Favorites chip lit. */
  favoritesOnly: boolean;
}

const VALID_TABS: ReadonlySet<string> = new Set<LobbyTabKey>([
  'ALL',
  'HOLDEM',
  'OMAHA',
  'LIMIT',
  'MIXED',
  'MTT',
  'SNG',
  'SPIN',
]);

const VALID_SORTS: ReadonlySet<string> = new Set<LobbySortKey>([
  'recommended',
  'stakes_high',
  'stakes_low',
  'players',
  'starting_soon',
]);

/**
 * Per club, exactly like the saved filters beside it. One club's "PLO, stakes
 * high to low" is not another club's — a union hub and a micro club share a
 * player and share nothing else.
 */
const KEY_PREFIX = 'ca_lobby_view_';

export const EMPTY_VIEW_PREFS: LobbyViewPrefs = {
  tab: null,
  sortByTab: {},
  favoritesOnly: false,
};

export function loadViewPrefs(clubId: string): LobbyViewPrefs {
  if (!clubId) return { ...EMPTY_VIEW_PREFS, sortByTab: {} };
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}${clubId}`);
    if (!raw) return { ...EMPTY_VIEW_PREFS, sortByTab: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...EMPTY_VIEW_PREFS, sortByTab: {} };
    }
    const src = parsed as Record<string, unknown>;

    const tab =
      typeof src.tab === 'string' && VALID_TABS.has(src.tab) ? (src.tab as LobbyTabKey) : null;

    // Unknown tab keys and unknown sort keys are DROPPED rather than kept:
    // a stored value the current build cannot honour must not reach the UI.
    const sortByTab: Partial<Record<LobbyTabKey, LobbySortKey>> = {};
    const rawSorts = src.sortByTab;
    if (rawSorts && typeof rawSorts === 'object' && !Array.isArray(rawSorts)) {
      for (const [k, v] of Object.entries(rawSorts as Record<string, unknown>)) {
        if (VALID_TABS.has(k) && typeof v === 'string' && VALID_SORTS.has(v)) {
          sortByTab[k as LobbyTabKey] = v as LobbySortKey;
        }
      }
    }

    return { tab, sortByTab, favoritesOnly: src.favoritesOnly === true };
  } catch {
    // Corrupt JSON, a disabled store, or private-mode Safari throwing on read.
    return { ...EMPTY_VIEW_PREFS, sortByTab: {} };
  }
}

/**
 * Write, never throw. A lobby that cannot remember a tab is a small
 * disappointment; a lobby that crashes because the quota is full is not.
 */
export function saveViewPrefs(clubId: string, prefs: LobbyViewPrefs): void {
  if (!clubId) return;
  try {
    localStorage.setItem(`${KEY_PREFIX}${clubId}`, JSON.stringify(prefs));
  } catch {
    /* storage unavailable or full — the session keeps working in memory */
  }
}

/**
 * The sort a tab should show: the player's saved choice if they made one,
 * otherwise the tab's own default.
 *
 * THESE ARE THE DEFAULTS THAT WERE ALREADY IN FORCE, written down. The tab
 * buttons forced 'starting_soon' on MTT and 'recommended' on NLH/PLO, and the
 * page's initial state was 'starting_soon' — which is what ALL landed on and
 * what SPINS and HEADS UP inherited by never being reassigned. LIMIT is the
 * one that inherited whatever the previous tab happened to leave behind; it is
 * a cash tab, so it takes the cash default rather than a coin toss.
 */
export function defaultSortForTab(tab: LobbyTabKey): LobbySortKey {
  if (tab === 'HOLDEM' || tab === 'OMAHA' || tab === 'LIMIT' || tab === 'MIXED') {
    return 'recommended';
  }
  return 'starting_soon';
}

export function sortForTab(prefs: LobbyViewPrefs, tab: LobbyTabKey): LobbySortKey {
  return prefs.sortByTab[tab] ?? defaultSortForTab(tab);
}
