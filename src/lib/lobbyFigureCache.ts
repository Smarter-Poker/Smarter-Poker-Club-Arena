/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LOBBY FIGURE CACHE — the last number we actually knew (Dan 2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "IN THE CLUB ARENA LOBBY, THE GAME CARDS SHOULD NEVER SAY UNAVAILABLE, THEY
 *  SHOULD HAVE 0'S UNTIL THE CARD LOADS. BUT THIS SHOULD HAVE A CACHE FEATURE,
 *  THAT ALWAYS SAVES THE LAST KNOWN NUMBERS, SAVED AS THE DEFAULT, AND UPDATES
 *  WHEN IT HAS THE REAL NUMBERS UPDATED."
 *
 * A lobby card is drawn before its counts arrive, and drawn again every time a
 * realtime update lands with a field missing. Printing "Unavailable" in a
 * numeric bay reads as a broken card rather than a loading one, and it is
 * usually not even true: on a second visit we know perfectly well what the
 * number was ninety seconds ago. This holds that answer so a card opens with
 * it and corrects itself the moment the live figure arrives.
 *
 * ═══ WHAT THIS IS NOT FOR ═══════════════════════════════════════════════════
 *
 * MONEY. Not balances, not a treasury, not a jackpot - nothing a player might
 * act on believing it is current.
 *
 * `src/lib/walletCache.ts` is the wallet's own cache and stays separate.
 * `tests/unit/clubPageHardening.test.ts` records why: when a refused money read
 * was coerced to 0, the lobby painted a fabricated "Diamonds 0" over a balance
 * it had actually read fine, and then persisted the invented zero for the next
 * visit. `tests/club-buttons.test.tsx` pins the conclusion - an errored
 * `ArenaWalletRow` says "Unavailable" and must never say "$0.00", because
 * unknown and zero are different facts about somebody's money.
 *
 * A seat count is not that. Nobody spends "0/6". So this covers the counts on
 * club and game cards, and stops there.
 *
 * ═══ SHAPE ═════════════════════════════════════════════════════════════════
 *
 * One key, one JSON object, an LRU cap. Per-scope keys would read more nicely
 * in devtools and would also let a busy club with 170 rotating games grow
 * localStorage without bound, with nothing in a position to prune it. Values
 * are stored as strings because strings are what the cards render; the caller
 * decides what an absent figure means.
 *
 * Nothing here is user-scoped - a club's member count and a table's seat count
 * are public facts about the lobby - so it deliberately does not join
 * USER_SCOPED_PREFIXES, and a sign-out leaves nothing behind worth purging.
 *
 * Every storage touch is wrapped. Safari private mode throws on write, and a
 * lobby that cannot draw because a cache was unavailable would be a much worse
 * bug than the one this exists to fix.
 */

const STORAGE_KEY = 'ca_lobby_figures_v1';

/** Roughly a full lobby of games plus a season of clubs. */
const MAX_SCOPES = 400;

export type FigureMap = Record<string, string>;

interface Entry {
  /** Date.now() at last write. LRU pruning only - never displayed. */
  at: number;
  v: FigureMap;
}

/**
 * Hydrated once, then authoritative for the session. Re-reading and re-parsing
 * localStorage per card would be a JSON.parse of the whole lobby on every
 * render of every one of ~170 cards.
 */
let memory: Map<string, Entry> | null = null;
let flushHandle: ReturnType<typeof setTimeout> | null = null;

function hydrate(): Map<string, Entry> {
  if (memory) return memory;
  const map = new Map<string, Entry>();
  memory = map;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [scope, value] of Object.entries(parsed || {})) {
        const entry = value as Partial<Entry> | null;
        if (!entry || typeof entry !== 'object' || !entry.v || typeof entry.v !== 'object')
          continue;
        const figures: FigureMap = {};
        for (const [key, figure] of Object.entries(entry.v)) {
          if (typeof figure === 'string') figures[key] = figure;
        }
        map.set(scope, { at: typeof entry.at === 'number' ? entry.at : 0, v: figures });
      }
    }
  } catch {
    /* Unreadable or unavailable storage is a cold cache, not an error. */
  }
  return map;
}

function flush(): void {
  flushHandle = null;
  const map = hydrate();
  try {
    let entries = [...map.entries()];
    if (entries.length > MAX_SCOPES) {
      entries.sort((a, b) => b[1].at - a[1].at);
      entries = entries.slice(0, MAX_SCOPES);
      memory = new Map(entries);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* Full or blocked storage: the in-memory copy still serves this session. */
  }
}

function scheduleFlush(): void {
  if (flushHandle !== null) return;
  /* Coalesced on purpose. A lobby refresh calls this once per visible card
     inside the same tick, and serializing the map once costs the same as
     serializing it for the first card alone. */
  flushHandle = setTimeout(flush, 400);
}

/** The last known figures for a scope. Empty when nothing was ever stored. */
export function readFigures(scope: string): FigureMap {
  if (!scope) return {};
  return hydrate().get(scope)?.v ?? {};
}

/**
 * Store the figures we DO know.
 *
 * Absent values are skipped rather than written, which is the whole point: a
 * partial update must not erase the fields it did not carry, or the cache
 * would forget precisely when it is most needed.
 */
export function rememberFigures(
  scope: string,
  values: Record<string, string | number | null | undefined>
): void {
  if (!scope) return;
  const map = hydrate();
  const previous = map.get(scope)?.v ?? {};
  const next: FigureMap = { ...previous };
  let changed = false;

  for (const [key, raw] of Object.entries(values)) {
    if (raw === null || raw === undefined) continue;
    const figure = String(raw);
    if (figure === '') continue;
    if (next[key] === figure) continue;
    next[key] = figure;
    changed = true;
  }

  if (!changed && map.has(scope)) return;
  map.set(scope, { at: Date.now(), v: next });
  scheduleFlush();
}

/**
 * What a card should print: the live figure when there is one, otherwise the
 * last one we knew, otherwise the zero Dan asked for.
 */
export function figureOr(
  live: string | number | null | undefined,
  cached: string | undefined,
  zero = '0'
): string {
  if (live !== null && live !== undefined && String(live) !== '') return String(live);
  if (cached !== undefined && cached !== '') return cached;
  return zero;
}

/** Test seam. Drops the hydrated copy so the next read re-parses storage. */
export function resetLobbyFigureCacheForTests(): void {
  memory = null;
  if (flushHandle !== null) {
    clearTimeout(flushHandle);
    flushHandle = null;
  }
}
