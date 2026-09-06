/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLEAR USER CACHES — what must not survive a sign-out
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-23. Until now, signing out cleared the Zustand store, the Sentry
 * user, and the realtime hooks — and no storage whatsoever. Everything the
 * previous account had cached stayed on the device and was read straight back
 * by the next person to use it:
 *
 *   club_arena_clubs_cache      the clubs they belong to, by name
 *   club_home_cache_*           a club lobby, painted instantly before any
 *                               fetch could correct it
 *   hand_history_*              hands they played
 *   club_arena_last_club        where they were
 *   sessionStorage SWR caches   profile, transaction history, session stats —
 *                               these die with the TAB, not with the session,
 *                               so a sign-out and sign-in in the same tab
 *                               carried them across accounts
 *
 * On a personal device this is untidy. On a shared one it is another person's
 * data on screen. The trigger is in IdentityDNA's SIGNED_OUT branch, which is
 * the single place every sign-out passes through.
 *
 * WHAT IS DELIBERATELY KEPT: device preferences. Sound, haptics, language,
 * card/table appearance, deck style, PWA install state and onboarding flags
 * describe the DEVICE, not the person, and wiping them would make every
 * sign-out feel like a factory reset. They contain nothing about who was
 * logged in.
 *
 * NEVER TOUCHED: STORAGE_KEYS.SSO_AUTH ('smarter-poker-auth'). Supabase owns
 * that key and is mid-sign-out when this runs; deleting it underneath the SDK
 * is how you get a half-signed-out session. There is a test pinning this.
 *
 * ANTI-DRIFT: the key list is typed as `(typeof STORAGE_KEYS)[keyof typeof
 * STORAGE_KEYS]`, so a key renamed in storage.ts fails the build here instead
 * of quietly dropping out of the purge. The dynamic prefixes are exported and
 * imported by the code that writes them, for the same reason.
 */

import { STORAGE_KEYS } from '../lib/storage';
import { clearMembershipsWarmCache } from '../lib/membershipWarmState';
import { SWR_CACHE_PREFIXES } from './staleCacheReaper';
import { WALLET_CACHE_PREFIX, clearWalletMemoryCache } from '../lib/walletCache';
import { CLUB_UUID_MAP_KEY, clearClubUUIDCache } from './clubIdResolver';
import { STATS_CACHE_PREFIX, clearStatsRangeMemo } from '../lib/statsCache';
import { CLUB_WORKSPACE_CACHE_KEY } from '../lib/clubWorkspaceCache';
/** Written by ClubHomePage; imported there so writer and purger cannot drift. */
export const CLUB_HOME_CACHE_PREFIX = 'club_home_cache_';
/** Financial retry journals live here so sign-out never eagerly loads their implementations. */
export const CASHIER_RECOVERY_PREFIX = 'smarter-poker:cashier-transfer-recovery:v1';
export const CASHIER_REQUEST_RECOVERY_PREFIX = 'smarter-poker:cashier-chip-request:v1';
export const UNION_WALLET_RECOVERY_PREFIX = 'smarter-poker:union-wallet-intent:v2';

type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/**
 * Exact localStorage keys holding data about the account that just signed out.
 * Typed against STORAGE_KEYS so a rename cannot silently skip one.
 */
const USER_SCOPED_KEYS: StorageKey[] = [
  // ── Cached account data ──
  STORAGE_KEYS.LOBBY_CACHE,
  STORAGE_KEYS.PLAYER_STATS_CACHE,
  STORAGE_KEYS.CLUBS_CACHE,
  STORAGE_KEYS.CLUBS_CACHE_TS,
  STORAGE_KEYS.CLUBS_PAGE_CACHE,
  STORAGE_KEYS.CAROUSEL_CLUBS_CACHE,
  STORAGE_KEYS.CAROUSEL_UNIONS_CACHE,
  STORAGE_KEYS.CLUBS_PAGE_UNIONS_CACHE,
  STORAGE_KEYS.SHARK_STATS_SWR,
  STORAGE_KEYS.PLAYER_STATS_SWR,
  STORAGE_KEYS.USER_PROFILE,

  // ── Where they were, and who they are to other players ──
  STORAGE_KEYS.ACTIVE_CLUB_ID,
  STORAGE_KEYS.RECENT_TABLES,
  STORAGE_KEYS.LAST_CLUB,
  STORAGE_KEYS.LAST_VISITED,
  STORAGE_KEYS.PINNED_CLUBS,
  STORAGE_KEYS.CLUB_ORDER,
  STORAGE_KEYS.QUICK_ACTIONS_RECENT,
  STORAGE_KEYS.MUTED_PLAYERS,
  STORAGE_KEYS.FAVORITE_TABLES,
  STORAGE_KEYS.RECENT_SEARCHES,
];

/**
 * localStorage key PREFIXES with a dynamic tail (club id, table id).
 * A prefix cannot be enumerated from STORAGE_KEYS, so each one is listed with
 * the writer that produces it.
 */
const USER_SCOPED_PREFIXES: string[] = [
  CLUB_HOME_CACHE_PREFIX, // ClubHomePage instant-paint cache
  WALLET_CACHE_PREFIX, // walletCache.ts instant-paint money panels (per-user keys)
  'hand_history_', // TablePage per-table hand log
  'ca_saved_start_time_', // per-club session timer
  'dismissed_announcements_', // per-club dismissals
  'referral_', // per-club referral attribution
  STATS_CACHE_PREFIX, // PlayerStatsPage SWR payload: lifetime profit, sessions, hands
  CASHIER_RECOVERY_PREFIX, // unresolved money intents, scoped by user + club
  CASHIER_REQUEST_RECOVERY_PREFIX, // unresolved chip-request retry ids, scoped by intent
  UNION_WALLET_RECOVERY_PREFIX, // unresolved union-wallet intents, scoped by user
];

/**
 * Exact keys that are not in STORAGE_KEYS but are still about the person:
 * the club-code -> UUID map records which clubs this device has visited.
 */
const EXTRA_USER_SCOPED_KEYS: string[] = [CLUB_UUID_MAP_KEY, CLUB_WORKSPACE_CACHE_KEY];

function purgeLocal(): number {
  let removed = 0;
  for (const key of [...USER_SCOPED_KEYS, ...EXTRA_USER_SCOPED_KEYS]) {
    if (localStorage.getItem(key) !== null) {
      localStorage.removeItem(key);
      removed++;
    }
  }
  // Iterate backwards: removeItem() re-indexes, so a forward loop skips
  // the entry that slides into the vacated slot.
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (USER_SCOPED_PREFIXES.some((p) => key.startsWith(p))) {
      localStorage.removeItem(key);
      removed++;
    }
  }
  return removed;
}

function purgeSession(): number {
  let removed = 0;
  for (let i = sessionStorage.length - 1; i >= 0; i--) {
    const key = sessionStorage.key(i);
    if (!key) continue;
    if (SWR_CACHE_PREFIXES.some((p) => key.startsWith(p))) {
      sessionStorage.removeItem(key);
      removed++;
    }
  }
  return removed;
}

/**
 * Remove every cache belonging to the account that just signed out.
 *
 * Never throws: a sign-out must complete even if storage is unavailable
 * (Safari private mode, quota errors, a disabled storage partition). A failed
 * purge is worth strictly less than a stuck sign-out.
 */
export function clearUserCaches(): void {
  // The in-flight membership warm window is keyed by user, but a sign-out
  // should not leave the previous account's request resolvable at all.
  try {
    clearMembershipsWarmCache();
  } catch {
    /* never let a cache purge break sign-out */
  }
  // Wallet panels cache in memory as well as localStorage; both must die
  // with the account.
  try {
    clearWalletMemoryCache();
    /* The slug -> UUID map lives in a module Map as well as in localStorage.
       Purging only the persisted copy left the previous account's clubs in
       memory, and the next persistMap() wrote them straight back. */
    clearClubUUIDCache();
    // The Stats page's in-memory per-range payloads. Same reason as the three
    // above: purging only the persisted copy left the previous account's data
    // resident in the tab.
    clearStatsRangeMemo();
  } catch {
    /* never let a cache purge break sign-out */
  }
  let local = 0;
  let session = 0;
  try {
    local = purgeLocal();
  } catch {
    /* storage unavailable */
  }
  try {
    session = purgeSession();
  } catch {
    /* storage unavailable */
  }
  if (import.meta.env.DEV) {
    console.info(`[clearUserCaches] purged ${local} local + ${session} session entries`);
  }
}

export default clearUserCaches;
