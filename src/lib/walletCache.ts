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
 * Synchronous read: memory first, then localStorage (which hydrates memory).
 * Returns null when absent, expired, or unparseable. Never throws.
 */
export function readWalletCache<T>(key: string, ttlMs: number = DEFAULT_TTL_MS): T | null {
  const mem = memory.get(key);
  if (mem) {
    if (Date.now() - mem.at <= ttlMs) return mem.data as T;
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
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * Write-through: memory always; localStorage best-effort. On quota exhaustion
 * every wallet_cache_ entry is evicted once and the write retried — the same
 * self-healing ClubHomePage's instant-paint cache uses.
 */
export function writeWalletCache<T>(key: string, data: T): void {
  const envelope: CacheEnvelope<T> = { at: Date.now(), data };
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
  memory.clear();
  inflight.clear();
}
