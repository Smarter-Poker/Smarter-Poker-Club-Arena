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
import { isUUID } from './clubIdResolver';

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
