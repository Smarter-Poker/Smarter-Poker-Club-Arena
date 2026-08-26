/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WALLET CACHE — instant-paint, stale-while-revalidate cache for money panels
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (Dan 2026-08-23): "wallets inside the clubs and unions need
 * to cache much better... it simply takes way too much time for the wallets to
 * load or reload on pages inside the Club Arena."
 *
 * Before this module, every wallet surface (DynamicWallet on the club lobby,
 * the Cashier, Club Financials, the union dashboard) started from a skeleton
 * on EVERY navigation: resolve the club UUID (one roundtrip), then fetch the
 * panel (another), then render. Nothing survived a reload; nothing was shared
 * between two mounts of the same panel in one session.
 *
 * THE MODEL — three layers, one contract:
 *
 *   1. MEMORY   — a Map. Same-session remounts paint synchronously with zero
 *                 parse cost. First consulted, always written.
 *   2. STORAGE  — localStorage, so a reload or a next-day visit still paints
 *                 instantly. Entries are versioned and TTL'd.
 *   3. NETWORK  — the caller's fetcher. ALWAYS runs (stale-while-revalidate):
 *                 the cache is never a substitute for the truth, only for the
 *                 skeleton. Concurrent fetches for one key share one promise.
 *
 * MONEY SAFETY. A cached balance is a PAINT, not a fact. Every consumer must
 * revalidate immediately (the SWR contract) and keep its realtime
 * subscriptions — this module only removes the blank time before the first
 * truthful number arrives, it never extends the life of a wrong one. Writes
 * happen after every successful fetch AND after every realtime delta, so the
 * cache converges on whatever the live panel last knew.
 *
 * PRIVACY. Keys embed the viewing user's id and the whole prefix is purged on
 * sign-out by clearUserCaches (which imports WALLET_CACHE_PREFIX and
 * clearWalletMemoryCache from here, so writer and purger cannot drift).
 */

export const WALLET_CACHE_PREFIX = 'wallet_cache_';

/** Bump when the shape of any cached payload changes. Old entries are ignored. */
const WALLET_CACHE_VERSION = 'v1';

/** Entries older than this are treated as absent (do not paint week-old money). */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface CacheEnvelope<T> {
  at: number;
  data: T;
}

// ── Layer 1: memory ──────────────────────────────────────────────────────────
const memory = new Map<string, CacheEnvelope<unknown>>();

// ── In-flight dedupe ─────────────────────────────────────────────────────────
const inflight = new Map<string, Promise<unknown>>();

/**
 * Build a namespaced cache key. All parts are joined; the user id must be the
 * first part so sign-out purging and per-account isolation both hold.
 */
export function walletCacheKey(userId: string, ...parts: (string | number)[]): string {
  return `${WALLET_CACHE_PREFIX}${WALLET_CACHE_VERSION}_${userId}_${parts.join('_')}`;
}

/**
 * Synchronous read WITH the entry's age: memory first, then localStorage
 * (which hydrates memory). Returns null when absent, expired, or
 * unparseable. Never throws.
 *
 * The `at` timestamp lets a consumer distinguish "painted from seconds-old
 * data" from "painted from an hour ago": a FRESH entry (navigated away and
 * straight back) does not need an immediate network revalidation at all —
 * the realtime channels, bus events and the visibility refresh already own
 * keeping it true. That distinction is what stops every page hop from
 * becoming a full resync.
 */
export function readWalletCacheEntry<T>(
  key: string,
  ttlMs: number = DEFAULT_TTL_MS
): { data: T; at: number } | null {
  const mem = memory.get(key);
  if (mem) {
    if (Date.now() - mem.at <= ttlMs) return { data: mem.data as T, at: mem.at };
    memory.delete(key);
  }
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.at !== 'number') return null;
    if (Date.now() - parsed.at > ttlMs) {
      localStorage.removeItem(key);
      return null;
    }
    memory.set(key, parsed);
    return { data: parsed.data, at: parsed.at };
  } catch {
    return null;
  }
}

/** Synchronous read of just the payload. See readWalletCacheEntry. */
export function readWalletCache<T>(key: string, ttlMs: number = DEFAULT_TTL_MS): T | null {
  return readWalletCacheEntry<T>(key, ttlMs)?.data ?? null;
}

/**
 * Write-through: memory always; localStorage best-effort. On quota exhaustion
 * every wallet_cache_ entry is evicted once and the write retried — the same
 * self-healing ClubHomePage's instant-paint cache uses.
 */
export function writeWalletCache<T>(key: string, data: T): void {
  persistEnvelope(key, { at: Date.now(), data });
}

/**
 * Persist an envelope EXACTLY AS GIVEN, keeping its original `at`.
 *
 * The debounced flush used to call writeWalletCache, which stamps a fresh
 * `at` — so a value written at T reached localStorage dated up to 800ms
 * later, and `flushWalletCacheWrites` on pagehide could re-date it by
 * arbitrarily more. Every freshness test downstream (the wallet panel's
 * FRESH_WINDOW, useSpinsWallet's, the TTL) then believed the data was newer
 * than it was, and skipped the refetch that would have corrected it.
 */
function persistEnvelope<T>(key: string, envelope: CacheEnvelope<T>): void {
  memory.set(key, envelope);
  const value = JSON.stringify(envelope);
  try {
    localStorage.setItem(key, value);
  } catch {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(WALLET_CACHE_PREFIX)) localStorage.removeItem(k);
      }
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable — memory layer still serves this session */
    }
  }
}

// ── Debounced storage writes ─────────────────────────────────────────────────
// During live play the realtime channels patch a wallet several times a
// second (a chip balance every hand, the BBJ every pot). Each patch must land
// in the MEMORY layer immediately — that is what a same-session remount
// paints — but serialising + writing localStorage at that rate is pure waste:
// only the LAST value before the page goes away matters for the next visit.
const pendingFlush = new Map<string, ReturnType<typeof setTimeout>>();
const DEFAULT_FLUSH_MS = 800;

/**
 * Like writeWalletCache, but the localStorage write is deferred by a trailing
 * per-key debounce. Memory is written synchronously, so nothing in-session
 * ever observes a stale value. A pagehide/hidden listener (below) flushes
 * anything still pending, so closing the tab inside the window cannot lose
 * the final number.
 */
export function writeWalletCacheDebounced<T>(
  key: string,
  data: T,
  flushMs: number = DEFAULT_FLUSH_MS
): void {
  memory.set(key, { at: Date.now(), data });
  const existing = pendingFlush.get(key);
  if (existing) clearTimeout(existing);
  pendingFlush.set(
    key,
    setTimeout(() => {
      pendingFlush.delete(key);
      const env = memory.get(key);
      if (env) persistEnvelope(key, env);
    }, flushMs)
  );
}

/** Flush every pending debounced write to localStorage right now. */
export function flushWalletCacheWrites(): void {
  for (const [key, timer] of pendingFlush) {
    clearTimeout(timer);
    const env = memory.get(key);
    if (env) persistEnvelope(key, env);
  }
  pendingFlush.clear();
}

// The page going away is the one moment a pending write MUST land: the next
// visit paints from localStorage. pagehide covers navigation/close; the
// visibilitychange->hidden case covers mobile app-switching, where pagehide
// may never fire before the process is frozen.
if (typeof window !== 'undefined') {
  try {
    window.addEventListener('pagehide', flushWalletCacheWrites);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushWalletCacheWrites();
    });
  } catch {
    /* non-browser environment — tests flush explicitly */
  }
}

/**
 * Share one in-flight fetch per key. A second caller arriving while the first
 * request is still on the wire gets the SAME promise instead of issuing a
 * duplicate query — the classic mount-storm on a page that renders two wallet
 * surfaces at once.
 */
export function dedupedFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fetcher().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

/**
 * Purge the memory layer (and any pending dedupe handles). Called on sign-out
 * alongside the localStorage prefix purge in clearUserCaches — sessionless
 * memory must not outlive the account either.
 */
export function clearWalletMemoryCache(): void {
  // Cancel pending debounced flushes FIRST — a timer firing after the purge
  // would re-write the signed-out account's last balance to localStorage.
  for (const timer of pendingFlush.values()) clearTimeout(timer);
  pendingFlush.clear();
  memory.clear();
  inflight.clear();
}
