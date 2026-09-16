/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLOSING THE TICKER, AND HAVING IT STAY CLOSED
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two of the eight sources persisted a dismissal and six did not.
 *
 * Starting-soon and overlay each wrote their own `sessionStorage` key. The
 * other six - registration closing, guarantees, table openings, results,
 * service notices and club updates - were "dismissed" by filtering a React
 * state array, and the next thirty-second poll rebuilt that array from the
 * database and put the message straight back. A close button that does not
 * close is worse than no close button: the player learns the control is a lie
 * and stops reaching for it.
 *
 * One store, every source, keyed by the item id.
 *
 * ── WHY THERE IS A TTL ──────────────────────────────────────────────────────
 *
 * A dismissal is "not now", not "never". The old keys had no expiry at all, so
 * closing "New PLO Table Open" for table X silenced that table for the whole
 * session even after it emptied, refilled and reopened four hours later. Each
 * kind gets a window proportional to how long its news stays news:
 *
 *   an alert or a countdown   six hours  - it is about one event, and that
 *                                          event will be over long before then
 *   an operational message    thirty minutes - tables open and close all night
 *   an operator's own notice  twelve hours - a club says it once and means it
 *
 * `sessionStorage`, like the keys it replaces, so nothing follows a player into
 * tomorrow and a fresh tab is a fresh start.
 *
 * ── THE LEGACY KEYS ARE IMPORTED, NOT ORPHANED ──────────────────────────────
 *
 * A player who closed an announcement thirty seconds before this shipped should
 * not have it reappear because the storage key changed underneath them. The
 * first read migrates both old keys and then removes them.
 */

import type { TickerKind } from './tickerMessages';

const STORE_KEY = 'ca_ticker_dismissed_v2';
const LEGACY_STARTING_KEY = 'ca_mtt_ticker_dismissed';
const LEGACY_OVERLAY_KEY = 'ca_overlay_ticker_dismissed';

const HOUR = 60 * 60_000;

/** How long a dismissal of each kind is honoured. */
export const DISMISS_TTL_MS: Record<TickerKind, number> = {
  overlays: 6 * HOUR,
  starting_soon: 6 * HOUR,
  registration_closing: 30 * 60_000,
  guarantees: 30 * 60_000,
  table_openings: 30 * 60_000,
  winner_results: 30 * 60_000,
  maintenance: 12 * HOUR,
  custom_messages: 12 * HOUR,
};

type Store = Record<string, number>;

function storage(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage;
  } catch {
    /* a disabled or partitioned sessionStorage must not break the rail */
    return null;
  }
}

function readRaw(): Store {
  const store = storage();
  if (!store) return {};
  try {
    const parsed = JSON.parse(store.getItem(STORE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [id, until] of Object.entries(parsed as Record<string, unknown>)) {
      const at = Number(until);
      if (Number.isFinite(at)) out[id] = at;
    }
    return out;
  } catch {
    return {};
  }
}

function writeRaw(next: Store): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    /* a full sessionStorage must not break the announcement */
  }
}

/**
 * Pull the two pre-2026-09-05 keys forward.
 *
 * They held bare tournament ids; this store holds ITEM ids, and one tournament
 * produces both a `soon-` and an `overlay-` item. Both are written so the
 * import is faithful whichever of the two the player actually closed - the
 * wrong one costs nothing, because the player was not going to be shown it in
 * the next six hours anyway.
 */
function importLegacy(now: number, into: Store): boolean {
  const store = storage();
  if (!store) return false;
  let changed = false;
  const migrate = (key: string, prefixes: string[]) => {
    let raw: string | null = null;
    try {
      raw = store.getItem(key);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const ids = JSON.parse(raw);
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id !== 'string' || !id) continue;
          for (const prefix of prefixes) {
            const itemId = `${prefix}${id}`;
            if (into[itemId] === undefined) {
              into[itemId] = now + DISMISS_TTL_MS.starting_soon;
              changed = true;
            }
          }
        }
      }
    } catch {
      /* unreadable legacy value is simply dropped */
    }
    try {
      store.removeItem(key);
    } catch {
      /* best effort */
    }
  };
  migrate(LEGACY_STARTING_KEY, ['soon-']);
  migrate(LEGACY_OVERLAY_KEY, ['overlay-']);
  return changed;
}

let legacyImported = false;

/**
 * Every id still dismissed, with expired entries pruned on the way out.
 *
 * Returns a Set because that is what the caller does with it - membership
 * tests, once per item, once per render.
 */
export function readDismissed(now: number = Date.now()): Set<string> {
  const raw = readRaw();
  let changed = false;
  if (!legacyImported) {
    legacyImported = true;
    changed = importLegacy(now, raw) || changed;
  }
  const live: Store = {};
  for (const [id, until] of Object.entries(raw)) {
    if (until > now) live[id] = until;
    else changed = true;
  }
  if (changed) writeRaw(live);
  return new Set(Object.keys(live));
}

/** Remember a dismissal and hand back the new set. */
export function dismissItem(id: string, kind: TickerKind, now: number = Date.now()): Set<string> {
  const raw = readRaw();
  const live: Store = {};
  for (const [key, until] of Object.entries(raw)) {
    if (until > now) live[key] = until;
  }
  live[id] = now + (DISMISS_TTL_MS[kind] ?? DISMISS_TTL_MS.starting_soon);
  writeRaw(live);
  return new Set(Object.keys(live));
}

/** Test seam: forget that the legacy keys were already imported this session. */
export function resetDismissalsForTests(): void {
  legacyImported = false;
  const store = storage();
  try {
    store?.removeItem(STORE_KEY);
    store?.removeItem(LEGACY_STARTING_KEY);
    store?.removeItem(LEGACY_OVERLAY_KEY);
  } catch {
    /* best effort */
  }
}
