/**
 * Player Stats cache ownership.
 *
 * Every cache entry is identified by the complete analytical scope. Keeping
 * this in a leaf module lets sign-out purge Stats without importing the page.
 */

/** localStorage prefix retained for sign-out's user-cache purge. */
export const STATS_CACHE_PREFIX = 'ps_stats_v5_scope_';
export const STATS_CACHE_CONTRACT_VERSION = 2 as const;
export const RANGE_MEMO_TTL_MS = 60_000;

export type StatsCacheVisibility = 'owner' | 'shared_club';

export interface StatsCacheIdentity {
  contractVersion: typeof STATS_CACHE_CONTRACT_VERSION;
  viewerId: string;
  targetUserId: string;
  clubId: string | null;
  asset: string;
  rangeKey: string;
  rangeDays: number | null;
  timezone: string;
  visibility: StatsCacheVisibility;
}

interface PersistentStatsEntry {
  identity: StatsCacheIdentity;
  payload: unknown;
  cachedAt: number;
}

const rangeMemo = new Map<string, { payload: unknown; at: number }>();

export function statsCacheIdentityKey(identity: StatsCacheIdentity): string {
  return JSON.stringify([
    identity.contractVersion,
    identity.viewerId,
    identity.targetUserId,
    identity.clubId,
    identity.asset,
    identity.rangeKey,
    identity.rangeDays,
    identity.timezone,
    identity.visibility,
  ]);
}

export function statsCacheStorageKey(identity: StatsCacheIdentity): string {
  return `${STATS_CACHE_PREFIX}${statsCacheIdentityKey(identity)}`;
}

function sameIdentity(left: unknown, right: StatsCacheIdentity): boolean {
  if (!left || typeof left !== 'object') return false;
  return statsCacheIdentityKey(left as StatsCacheIdentity) === statsCacheIdentityKey(right);
}

/** Reject data whose server-declared scope differs from its cache identity. */
export function statsPayloadMatchesIdentity(
  payload: unknown,
  identity: StatsCacheIdentity
): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const root = payload as Record<string, unknown>;
  const scope = root.scope;
  if (!scope || typeof scope !== 'object') return false;
  const declared = scope as Record<string, unknown>;
  if (root.contract_version !== identity.contractVersion) return false;
  if (declared.target_user_id !== identity.targetUserId) return false;
  if ((declared.club_id ?? null) !== identity.clubId) return false;
  if ((declared.range_days ?? null) !== identity.rangeDays) return false;
  if (declared.visibility !== identity.visibility) return false;
  if (typeof declared.asset === 'string' && declared.asset !== identity.asset) return false;
  const declaredTimezone =
    typeof root.window_tz === 'string'
      ? root.window_tz
      : typeof declared.range_tz === 'string'
        ? declared.range_tz
        : null;
  return declaredTimezone === identity.timezone;
}

/** Shared-club data is never written to persistent browser storage. */
export function statsCacheMayPersist(identity: StatsCacheIdentity): boolean {
  return identity.visibility === 'owner' && identity.viewerId === identity.targetUserId;
}

export function readStatsPersistentCache(
  identity: StatsCacheIdentity,
  ttlMs: number
): { payload: unknown; cachedAt: number } | null {
  if (!statsCacheMayPersist(identity)) return null;
  try {
    const raw = localStorage.getItem(statsCacheStorageKey(identity));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistentStatsEntry>;
    if (!Number.isFinite(parsed.cachedAt)) return null;
    if (Date.now() - Number(parsed.cachedAt) > ttlMs) return null;
    if (!sameIdentity(parsed.identity, identity)) return null;
    if (!statsPayloadMatchesIdentity(parsed.payload, identity)) return null;
    return { payload: parsed.payload, cachedAt: Number(parsed.cachedAt) };
  } catch {
    return null;
  }
}

export function writeStatsPersistentCache(identity: StatsCacheIdentity, payload: unknown): boolean {
  if (!statsCacheMayPersist(identity) || !statsPayloadMatchesIdentity(payload, identity)) {
    return false;
  }
  try {
    const entry: PersistentStatsEntry = { identity, payload, cachedAt: Date.now() };
    localStorage.setItem(statsCacheStorageKey(identity), JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}

export function readStatsRangeMemo(identity: StatsCacheIdentity): unknown | null {
  const key = statsCacheIdentityKey(identity);
  const hit = rangeMemo.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > RANGE_MEMO_TTL_MS) {
    rangeMemo.delete(key);
    return null;
  }
  if (!statsPayloadMatchesIdentity(hit.payload, identity)) {
    rangeMemo.delete(key);
    return null;
  }
  return hit.payload;
}

export function writeStatsRangeMemo(identity: StatsCacheIdentity, payload: unknown): boolean {
  if (!statsPayloadMatchesIdentity(payload, identity)) return false;
  rangeMemo.set(statsCacheIdentityKey(identity), { payload, at: Date.now() });
  return true;
}

/** Drop every memoised payload. Sign-out and explicit refresh both call this. */
export function clearStatsRangeMemo(): void {
  rangeMemo.clear();
}
