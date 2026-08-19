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
  entity_type?: 'club' | 'union';
  [key: string]: unknown;
}

/** Clubs eligible for cashier/marketplace quick links (unions excluded). */
export function eligibleQuickLinkClubs<T extends QuickLinkClub>(clubs: T[]): T[] {
  return clubs.filter((c) => c.entity_type !== 'union');
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
// (the wallets table is the user's global diamond/promo balance, not per-club)
// ─────────────────────────────────────────────────────────────────────────────

const BALANCE_TTL_MS = 30_000;
let balanceCache: { userId: string; ts: number; balances: Map<string, number> } | null = null;

/**
 * Fetch the user's chip balance in every club they belong to, keyed by club
 * UUID. One cheap query, memoized for 30s so opening a popover twice does not
 * refetch. Returns the stale cache (or an empty map) on failure — the popover
 * simply omits balances rather than breaking.
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
      .select('club_id, chip_balance')
      .eq('user_id', userId);
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

/** Drop the memoized balances (used by tests and after chip transfers). */
export function clearClubChipBalanceCache(): void {
  balanceCache = null;
}

/**
 * Network fallback for when CLUBS_CACHE is cold (e.g. a deep link straight
 * into a club cashier without ever visiting the lobby). Fetches a minimal
 * club list via the user's memberships. Rows come from club_members, so
 * unions never appear.
 */
export async function fetchQuickLinkClubs(userId: string): Promise<QuickLinkClub[]> {
  try {
    const { data, error } = await supabase
      .from('club_members')
      .select('club:clubs(id, club_id, name, logo_url, member_count)')
      .eq('user_id', userId);
    if (error) {
      reportError(error, 'clubQuickLink.fetchQuickLinkClubs');
      return [];
    }
    const clubs: QuickLinkClub[] = [];
    for (const row of (data || []) as Array<{ club: QuickLinkClub | QuickLinkClub[] | null }>) {
      const club = Array.isArray(row.club) ? row.club[0] : row.club;
      if (club?.id) clubs.push(club);
    }
    return clubs;
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
