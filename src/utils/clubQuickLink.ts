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
  /** Lobby membership mapping: only an owner may open a union treasury. */
  is_owner?: boolean;
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

/**
 * Wallet destinations shown by the Cashier tile. Every active club membership
 * has its own club wallet; a union is additionally eligible only for its owner.
 * Co-owners/admins/agents still see all of their club wallets, but never a
 * union treasury they do not own.
 */
export function eligibleCashierWallets<T extends QuickLinkClub>(clubs: T[]): T[] {
  return clubs.filter((c) => !isUnionEntity(c) || c.is_owner === true);
}

/** Resolve the Cashier tile without applying the clubs-only marketplace rule. */
export function resolveCashierWallet<T extends QuickLinkClub>(
  clubs: T[],
  lastClubId?: string | null
): T | null {
  const eligible = eligibleCashierWallets(clubs);
  const last = lastClubId !== undefined ? lastClubId : readLastClubId();
  return eligible.find((c) => c.id === last) || eligible[0] || null;
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
 * refetch.
 *
 * Returns NULL when the read FAILED and there is no cache to fall back on
 * (Cashier audit 2026-08-27, the named house bug shape): the old empty-map
 * answer flowed into `map.get(clubId) ?? 0`, so a refused/dropped
 * club_members read told the cashout modal the player has **0 chips in this
 * club** — Max prefilled 0, every percent button zeroed, and the local
 * `amount > balance` check refused a cashout the server would have allowed.
 * A stale cache still beats both answers, so it is returned when present.
 *
 * Call clearClubChipBalanceCache() after any chip movement to force a refresh;
 * the quick-link surfaces do this off the MasterBus balance events.
 */
export async function fetchClubChipBalances(userId: string): Promise<Map<string, number> | null> {
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
      return balanceCache?.balances ?? null;
    }
    const balances = new Map<string, number>();
    for (const row of data || []) {
      if (row.club_id) balances.set(String(row.club_id), Number(row.chip_balance) || 0);
    }
    balanceCache = { userId, ts: Date.now(), balances };
    return balances;
  } catch (err) {
    reportError(err, 'clubQuickLink.fetchClubChipBalances');
    return balanceCache?.balances ?? null;
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
  /* Cashier audit 2026-08-27: the TABLE cashier emits these two on top-up and
     partial cash-out (TablePage handleAddChips/handleWithdrawChips), and they
     were missing here — so after a table chip move, the Cashier page's Max
     button kept prefilling the pre-transaction figure for up to the 30s TTL,
     the exact failure the subscription exists to prevent. */
  'CHIPS_ADDED',
  'CHIPS_WITHDRAWN',
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
  return eligibleQuickLinkClubs(readCachedClubsRaw());
}

/** Read the lobby's cached club list WITHOUT filtering unions out. */
function readCachedClubsRaw(): QuickLinkClub[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CLUBS_CACHE);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QuickLinkClub[]) : [];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LOBBY DESTINATION — "which club's lobby does this player belong in?"
// ─────────────────────────────────────────────────────────────────────────────
/**
 * UNION LAW (Dan 2026-08-23). A union's tables hang off the union's own HUB
 * CLUB — a `clubs` row with `is_union = true`, sharing the union's name. In
 * production 8,083 tables hang off Midway Union's hub. So `tables.club_id` on
 * any union game is the UNION, not the club the player is sitting in.
 *
 * Every "take me back to the lobby" path used to read `tables.club_id` and
 * navigate straight to it:
 *   - the in-table "+" (opens a lobby tab beside the running game)
 *   - MultiTablePage.goToLobby() when the last tab closes
 *   - TablePage.exitDestination() on leave / tournament bust
 *
 * A SHARK CLUB or Club JAQK player pressing "+" therefore landed in the MIDWAY
 * UNION lobby, wearing the union's skins: Union Bank, rake treasury, clubs
 * wallet. Players, agents and super agents must never see any of it — those are
 * a different wallet that no club member has access to, managed on the union's
 * own surfaces only.
 *
 * `resolveLobbyClubId` is the one rule for all of those paths: a union hub club
 * can never be the answer.
 */
const unionFlagCache = new Map<string, boolean>();

/** Seed the union flags from a club list already in hand (no network). */
export function primeUnionFlags(clubs: QuickLinkClub[]): void {
  for (const c of clubs) {
    if (c?.id && isUUID(c.id)) unionFlagCache.set(c.id, isUnionEntity(c));
  }
}

/** Drop the memoized union flags. Used by tests. */
export function clearUnionFlagCache(): void {
  unionFlagCache.clear();
}

/**
 * The raw answer: true / false / null when it genuinely could not be checked.
 * Memory first, then the lobby's cached club list, then `clubs.is_union`.
 *
 * The null is the whole point of this function existing separately. The two
 * callers below want OPPOSITE things from an unverifiable id, and collapsing
 * that into one boolean would be a bug in one of them either way.
 */
/**
 * What a CACHED club row proves about union-ness — true, false, or null for
 * "this row does not say".
 *
 * HOSTILE STATE (Dan 2026-08-24, Rule 8). `CLUBS_CACHE` is written by HomePage
 * and read here with NO freshness check, so a row can be arbitrarily old. Rows
 * written before `is_union` was selected carry neither `is_union` nor
 * `entity_type`, and `isUnionEntity` answers FALSE for those — it asks "does
 * this object say union", which is the right question when filtering a list
 * and the wrong one when deciding whether a union may be a destination.
 *
 * The consequence was measured, not theorised: with one legacy row for the
 * union hub in localStorage, isConfirmedUnionClubId returned false (so
 * UnionSkinGuard did not eject an old bookmark) and resolveLobbyClubId handed
 * back the union's own id as a lobby. The answer was then memoised in
 * unionFlagCache for the rest of the session. A stale cache alone reopened the
 * whole bug.
 *
 * So absence is now UNKNOWN, not "no", and an unknown falls through to the
 * database. A modern row still answers from cache with no network call.
 */
function cachedUnionFlag(club: QuickLinkClub): boolean | null {
  if (club.is_union === true || club.entity_type === 'union') return true;
  // Only an EXPLICIT negative counts as proof that it is an ordinary club.
  if (club.is_union === false) return false;
  if (typeof club.entity_type === 'string') return false; // 'club'
  return null; // legacy row — carries no union signal at all
}

async function lookupUnionFlag(clubId: string): Promise<boolean | null> {
  const cached = unionFlagCache.get(clubId);
  if (cached !== undefined) return cached;

  const fromCache = readCachedClubsRaw().find((c) => c.id === clubId);
  if (fromCache) {
    const flag = cachedUnionFlag(fromCache);
    if (flag !== null) {
      unionFlagCache.set(clubId, flag);
      return flag;
    }
    // Old-shape row: it says nothing either way. Fall through and ask.
  }

  try {
    const { data, error } = await supabase
      .from('clubs')
      .select('is_union')
      .eq('id', clubId)
      .maybeSingle();
    if (error || !data) {
      if (error) reportError(error, 'clubQuickLink.lookupUnionFlag');
      return null; // unverifiable
    }
    const flag = data.is_union === true;
    unionFlagCache.set(clubId, flag);
    return flag;
  } catch (err) {
    reportError(err, 'clubQuickLink.lookupUnionFlag');
    return null; // unverifiable
  }
}

/**
 * FAIL CLOSED — "may this club be a lobby DESTINATION?" An unverifiable id
 * counts as a union and is skipped, because sending the player one navigation
 * out of their way is recoverable and showing an agent the union's treasury is
 * not. Used by resolveLobbyClubId.
 */
export async function isUnionClubId(clubId: string): Promise<boolean> {
  return (await lookupUnionFlag(clubId)) ?? true;
}

/**
 * FAIL OPEN — "am I CERTAIN this is a union?" Only a confirmed `is_union = true`
 * counts. Used by UnionSkinGuard, which EJECTS someone from a page: a network
 * blip must never throw a player out of their own club lobby, so "don't know"
 * has to mean "leave them alone".
 */
export async function isConfirmedUnionClubId(clubId: string): Promise<boolean> {
  return (await lookupUnionFlag(clubId)) === true;
}

/**
 * Resolve the club lobby a seated player should land in. Never a union.
 *
 * Candidates, in order:
 *   1. `viewerClubId`  — `useUserStore.currentClubId`, the club the player
 *      ENTERED THROUGH. Buy-ins draw chips from this club and rake is earned
 *      for it, so it is the club they are playing in even on a union table.
 *   2. `tableClubId`   — `tables.club_id`. Correct for an ordinary club game;
 *      it is the union hub on a union game, and is skipped there.
 *   3. the last visited club, then the first eligible cached club — for a deep
 *      link straight onto a table with no lobby visit behind it.
 *
 * Returns null when nothing survives; the caller then falls back to HomePage.
 */
export async function resolveLobbyClubId(opts: {
  viewerClubId?: string | null;
  tableClubId?: string | null;
}): Promise<string | null> {
  const seen = new Set<string>();
  for (const candidate of lobbyClubCandidates(opts)) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (await isUnionClubId(candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * The same rule, answered from memory only — no network, no promise.
 *
 * Why it exists: `resolveLobbyClubId` is async, so a caller that needs the
 * answer in a synchronous handler (TablePage's `exitDestination`, which runs on
 * a Leave click) has a window after mount where it has nothing and falls back
 * to '/'. Seeding from this first closes that window in the common case — the
 * player came through a lobby, so their club is already in the cache.
 *
 * Returns null the moment it is UNSURE, never a guess: an id whose union flag
 * is not already known is skipped and left for the async pass to settle.
 */
export function resolveLobbyClubIdSync(opts: {
  viewerClubId?: string | null;
  tableClubId?: string | null;
}): string | null {
  const cachedClubs = readCachedClubsRaw();
  const seen = new Set<string>();
  for (const candidate of lobbyClubCandidates(opts)) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    let flag = unionFlagCache.get(candidate);
    if (flag === undefined) {
      const row = cachedClubs.find((c) => c.id === candidate);
      // cachedUnionFlag, not isUnionEntity: a legacy row carries no union
      // signal, and reading its silence as "not a union" is exactly how a
      // stale cache used to hand the union hub back as a lobby. Unknown stays
      // unknown here and the async pass settles it.
      if (row) flag = cachedUnionFlag(row) ?? undefined;
    }
    if (flag === undefined) continue; // unknown — the async pass decides
    if (flag) continue; // known union — never
    return candidate;
  }
  return null;
}

/** Candidate club ids for a lobby destination, best first, UUIDs only. */
function lobbyClubCandidates(opts: {
  viewerClubId?: string | null;
  tableClubId?: string | null;
}): string[] {
  return [
    opts.viewerClubId,
    opts.tableClubId,
    readLastClubId(),
    ...readCachedQuickLinkClubs().map((c) => c.id),
  ].filter((c): c is string => !!c && isUUID(c));
}
