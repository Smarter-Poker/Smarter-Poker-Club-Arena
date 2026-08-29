/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  JSON.parse, ONCE PER DISTINCT STRING
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `tournaments.blind_structure` and `payout_structure` are stored as TEXT and
 * arrive from PostgREST as strings. Nothing in the app keeps the parsed form:
 * every reader parses again, from the same unchanged string, on every call.
 *
 * On the tournament Detail tab that is once a SECOND, for as long as the tab is
 * open. `DetailOverviewTab`'s `level` memo lists `tick` in its dependencies —
 * correctly, the clock has to count — and calls
 * `tournamentService.getCurrentLevelState()`, which re-parses a 40-level
 * structure from scratch each time. The parse is not the reason the memo
 * recomputes, it is just carried along by it, sixty times a minute, producing a
 * result identical to the previous one.
 *
 * A string key is exactly right here. The row changes and the string changes
 * with it, so a stale entry is not reachable: a new structure is a new key.
 *
 * WHY IT RETURNS A COPY
 *
 * Handing every caller the same array would make one caller's `.sort()` or
 * `.push()` everybody else's bug, at a distance, intermittently — the worst
 * possible trade for a performance fix. The copy is a shallow clone of ~40
 * object references, which is nothing beside the parse it replaces; the parse
 * is the cost being removed, not the allocation.
 *
 * The ELEMENTS are shared, so mutating `levels[0].bigBlind` still leaks. Every
 * reader in the estate treats these as read-only records and none of them
 * writes into one — checked when this was added. If that ever stops being true,
 * deep-freeze here rather than deleting the cache.
 */

/** Distinct structures held. Far more than any one session sees. */
const MAX_ENTRIES = 64;

const cache = new Map<string, unknown>();

/**
 * `JSON.parse(raw)`, memoised on `raw`. Returns `undefined` when the string is
 * absent or not valid JSON — the same shape every caller already handles, so a
 * malformed structure behaves exactly as it did before.
 *
 * A parse FAILURE is cached too. Re-attempting a parse that has already thrown,
 * once a second, for a row that is not going to change, is the same waste in a
 * worse costume.
 */
export function parseJsonCached(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;

  if (cache.has(raw)) {
    const hit = cache.get(raw);
    return Array.isArray(hit) ? hit.slice() : hit;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }

  /* Plain FIFO eviction. An LRU would need a touch on every read and the
     working set here is one or two structures per open tournament -- the cap
     exists to stop an unbounded map, not to be clever about which entry goes. */
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(raw, parsed);

  return Array.isArray(parsed) ? parsed.slice() : parsed;
}

/** Test seam. Nothing in the app needs this; a suite that measures does. */
export function __clearParseJsonCache(): void {
  cache.clear();
}

/** Test seam: how many distinct strings are held. */
export function __parseJsonCacheSize(): number {
  return cache.size;
}
