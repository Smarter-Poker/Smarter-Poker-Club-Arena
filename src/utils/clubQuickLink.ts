/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB QUICK LINK — Shared "which club does this shortcut open?" resolution
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Used by the lobby Cashier/Marketplace tiles, keyboard shortcuts 4/5, and the
 * in-cashier club switcher. One resolution rule everywhere:
 *
 *   last-visited club if the user is still a member, otherwise their first
 *   club. Unions are excluded — they are not cashier/marketplace destinations.
 *
 * LAST_CLUB is written by rememberLastClub(), which is called from the club
 * carousel, the quick-switch popovers, and LastClubTracker (any /clubs/:clubId
 * route entry), so "last visited" stays accurate however the user navigates.
 *
 * CHIP MODEL (binding): chips are PER CLUB — a separate balance per club
 * membership on `club_members.chip_balance`, never interchangeable between
 * clubs. Only diamonds are global (the `wallets` table). Never source a
 * club chip balance from `wallets`.
 */

import { STORAGE_KEYS } from '../lib/storage';
import { supabase } from '../lib/supabase';
import { isUUID } from './clubIdResolver';
import { reportError } from './errorReporter';

/** Minimal structural shape — UserClub and CashierPage club rows both satisfy it. */
export interface QuickLinkClub {
  id: string;
  name?: string;
  club_id?: number | string;
  logo_url?: string;
  /** Authoritative union flag from the `clubs` table. */
  is_union?: boolean;
  /** Lobby-derived label; kept for callers that only have the mapped shape. */
  entity_type?: 'club' | 'union';
  [key: string]: unknown;
}

/**
 * Membership rows that count as "you are in this club".
 * Production currently uses 'approved' (bulk) and 'active' (legacy rows);
 * anything else (pending/banned/rejected) must never surface in a quick link.
 */
const ACTIVE_MEMBER_STATUSES = ['approved', 'active'];

/**
 * True when a club row is really a union.
 *
 * `is_union` is the authoritative column on the `clubs` table. `entity_type`
 * is the lobby's derived label, which is computed from a NAME HEURISTIC
 * (union_id set AND /union/i in the name) and therefore misses a union that
 * isn't named "... Union". Checking both means a union is filtered out even
 * when only one source is present on the object.
 */
export function isUnionEntity(club: QuickLinkClub): boolean {
  return club.is_union === true || club.entity_type === 'union';
}

/** Clubs eligible for cashier/marketplace quick links (unions excluded). */
export function eligibleQuickLinkClubs<T extends QuickLinkClub>(clubs: T[]): T[] {
  return clubs.filter((c) => !isUnionEntity(c));
}

/** Read the last-visited club UUID, null when unset or storage is unavailable. */
export function readLastClubId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.LAST_CLUB);
  } catch {
    return null;
  }
}

/** Persist the last-visited club UUID. Silently no-ops if storage is unavailable. */
export function rememberLastClub(clubId: string): void {
  if (!clubId || !isUUID(clubId)) return;
  try {
    localStorage.setItem(STORAGE_KEYS.LAST_CLUB, clubId);
  } catch {
    /* storage unavailable — navigation still works */
  }
}

/**
 * Resolve the club a quick link should open.
 *
 * @param clubs      the user's clubs (unions filtered out internally)
 * @param lastClubId optional override; defaults to the stored LAST_CLUB
 * @returns the target club, or null when the user has no eligible clubs
 */
export function resolveTargetClub<T extends QuickLinkClub>(
  clubs: T[],
  lastClubId?: string | null
): T | null {
  const eligible = eligibleQuickLinkClubs(clubs);
  const last = lastClubId !== undefined ? lastClubId : readLastClubId();
  return eligible.find((c) => c.id === last) || eligible[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-CLUB CHIP BALANCES — club chips live on club_members.chip_balance
// (the wallets table holds global diamonds, never per-club chips)
// ─────────────────────────────────────────────────────────────────────────────

const BALANCE_TTL_MS = 30_000;
let balanceCache: { userId: string; ts: number; balances: Map<string, number> } | null = null;

/**
 * Fetch the user's chip balance in every club they belong to, keyed by club
 * UUID. One cheap query, memoized for 30s so opening a popover twice does not
 * refetch. Returns the stale cache (or an empty map) on failure — the popover
 * simply omits balances rather than breaking.
 *
 * Call clearClubChipBalanceCache() after any chip movement to force a refresh;
 * the quick-link surfaces do this off the MasterBus balance events.
 */
export async function fetchClubChipBalances(userId: string): Promise<Map<string, number>> {
  if (
    balanceCache &&
    balanceCache.userId === userId &&
    Date.now() - balanceCache.ts < BALANCE_TTL_MS
  ) {
    return balanceCache.balances;
  }
  try {
    const { data, error } = await supabase
      .from('club_members')
      .select('club_id, chip_balance, status')
      .eq('user_id', userId)
      .in('status', ACTIVE_MEMBER_STATUSES);
    if (error) {
      reportError(error, 'clubQuickLink.fetchClubChipBalances');
      return balanceCache?.balances ?? new Map();
    }
    const balances = new Map<string, number>();
    for (const row of data || []) {
      if (row.club_id) balances.set(String(row.club_id), Number(row.chip_balance) || 0);
    }
    balanceCache = { userId, ts: Date.now(), balances };
    return balances;
  } catch (err) {
    reportError(err, 'clubQuickLink.fetchClubChipBalances');
    return balanceCache?.balances ?? new Map();
  }
}

/** Drop the memoized balances. Called after chip movements and by tests. */
export function clearClubChipBalanceCache(): void {
  balanceCache = null;
}

/**
 * MasterBus events that mean "a chip balance just moved" — the quick-link
 * surfaces subscribe to these and drop the memo so the next popover open
 * shows fresh numbers instead of up-to-30s-stale ones.
 */
export const CHIP_BALANCE_EVENTS = [
  'CASHIER_BALANCE_CHANGED',
  'CHIPS_DISTRIBUTED',
  'BALANCE_UPDATED',
  'WALLET_REFRESHED',
] as const;

/**
 * Network fallback for when CLUBS_CACHE is cold (e.g. a deep link straight
 * into a club cashier without ever visiting the lobby). Fetches a minimal
 * club list via the user's memberships.
 *
 * Unions ARE stored in the `clubs` table (is_union = true) and DO have
 * club_members rows, so the union flag must be selected and filtered here —
 * otherwise the union shows up as a switchable club cashier.
 */
export async function fetchQuickLinkClubs(userId: string): Promise<QuickLinkClub[]> {
  try {
    const { data, error } = await supabase
      .from('club_members')
      .select('status, club:clubs(id, club_id, name, logo_url, member_count, is_union)')
      .eq('user_id', userId)
      .in('status', ACTIVE_MEMBER_STATUSES);
    if (error) {
      reportError(error, 'clubQuickLink.fetchQuickLinkClubs');
      return [];
    }
    const clubs: QuickLinkClub[] = [];
    const seen = new Set<string>();
    for (const row of (data || []) as Array<{ club: QuickLinkClub | QuickLinkClub[] | null }>) {
      const club = Array.isArray(row.club) ? row.club[0] : row.club;
      if (!club?.id || seen.has(club.id)) continue;
      seen.add(club.id);
      clubs.push(club);
    }
    return eligibleQuickLinkClubs(clubs);
  } catch (err) {
    reportError(err, 'clubQuickLink.fetchQuickLinkClubs');
    return [];
  }
}

/**
 * Map a /clubs/:clubId route param to the club's UUID when possible.
 * Params may be a UUID or the 6-digit numeric club code; numeric codes are
 * resolved against the cached club list (no network) and dropped otherwise.
 */
export function clubParamToUuid(param: string | undefined): string | null {
  if (!param) return null;
  if (isUUID(param)) return param;
  try {
    const cached = localStorage.getItem(STORAGE_KEYS.CLUBS_CACHE);
    if (!cached) return null;
    const clubs: QuickLinkClub[] = JSON.parse(cached);
    if (!Array.isArray(clubs)) return null;
    const match = clubs.find((c) => String(c.club_id) === param);
    return match && isUUID(match.id) ? match.id : null;
  } catch {
    return null;
  }
}

/** Read the lobby's cached club list, union-filtered. Empty when cold/corrupt. */
export function readCachedQuickLinkClubs(): QuickLinkClub[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CLUBS_CACHE);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? eligibleQuickLinkClubs(parsed) : [];
  } catch {
    return [];
  }
}
