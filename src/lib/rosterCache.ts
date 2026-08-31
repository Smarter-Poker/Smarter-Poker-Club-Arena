import { mapRosterRow, type RosterMember, type RosterSummary } from '../services/ClubRosterService';

export const ROSTER_CACHE_PREFIX = 'roster_cache_v5_';
export const ROSTER_SEARCH_PREFIX = 'roster_search_v1_';
export const ROSTER_CACHE_TTL_MS = 5 * 60 * 1000;
const ROSTER_CACHE_VERSION = 5;
const MAX_CACHE_CHARACTERS = 600_000;

interface RosterCacheEnvelope {
  version: number;
  at: number;
  rows: unknown[];
  summary: RosterSummary;
}

function key(userId: string, clubId: string): string {
  return `${ROSTER_CACHE_PREFIX}${userId}_${clubId}`;
}

export function rosterSearchKey(userId: string, clubId: string): string {
  return `${ROSTER_SEARCH_PREFIX}${userId}_${clubId}`;
}

/**
 * The instant-paint cache is deliberately identity/presence only. Financials,
 * internal notes, activity timestamps and hierarchy never rest in web storage.
 */
export function sanitizeRosterMemberForCache(row: RosterMember): RosterMember {
  return {
    ...row,
    chip_balance: null,
    player_wallet: null,
    agent_wallet: null,
    promo_wallet: null,
    total_fees: null,
    downline_fees: null,
    total_hands: null,
    downline_direct: null,
    downline_total: null,
    upline_user_id: null,
    upline_name: null,
    last_login: null,
    nickname: null,
    remark: null,
    can_view_financials: false,
    can_view_notes: false,
    in_viewer_downline: false,
  };
}

export function writeRosterCache(
  userId: string,
  clubId: string,
  rows: RosterMember[],
  summary: RosterSummary
): void {
  try {
    const envelope: RosterCacheEnvelope = {
      version: ROSTER_CACHE_VERSION,
      at: Date.now(),
      rows: rows.map(sanitizeRosterMemberForCache),
      summary: {
        ...summary,
        capabilities: {
          can_view_financials: false,
          can_export: false,
          can_manage_members: false,
          can_view_notes: false,
        },
      },
    };
    const value = JSON.stringify(envelope);
    if (value.length <= MAX_CACHE_CHARACTERS) sessionStorage.setItem(key(userId, clubId), value);
  } catch {
    // Storage is an optional paint accelerator; privacy and rendering do not depend on it.
  }
}

export function readRosterCache(
  userId: string,
  clubId: string
): { rows: RosterMember[]; summary: RosterSummary; cachedAt: number } | null {
  const cacheKey = key(userId, clubId);
  try {
    const raw = sessionStorage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RosterCacheEnvelope;
    if (
      parsed.version !== ROSTER_CACHE_VERSION ||
      typeof parsed.at !== 'number' ||
      Date.now() - parsed.at > ROSTER_CACHE_TTL_MS ||
      !Array.isArray(parsed.rows) ||
      !parsed.summary
    ) {
      sessionStorage.removeItem(cacheKey);
      return null;
    }
    const rows = parsed.rows
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      .map(mapRosterRow);
    return { rows, summary: parsed.summary, cachedAt: parsed.at };
  } catch {
    try {
      sessionStorage.removeItem(cacheKey);
    } catch {
      /* unavailable */
    }
    return null;
  }
}

export function purgeRosterCache(userId: string, clubId: string): void {
  try {
    sessionStorage.removeItem(key(userId, clubId));
  } catch {
    /* unavailable */
  }
}
