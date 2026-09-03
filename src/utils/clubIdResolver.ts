/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ID RESOLVER — Smart UUID vs Integer Club ID Detection
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The clubs table has two ID columns:
 *   - `id`      (UUID, primary key)  — used internally
 *   - `club_id` (INTEGER, unique)    — the human-readable 6-digit club code
 *
 * URL route params may contain EITHER format. This utility detects which one
 * was provided and builds the correct Supabase query filter.
 */

import { supabase } from '../lib/supabase';
import { reportError } from './errorReporter';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns true if the value looks like a UUID.
 */
export function isUUID(value: string): boolean {
  return UUID_REGEX.test(value);
}

/**
 * Returns the correct column name and typed value for querying the clubs table.
 *
 * @example
 *   const { column, value } = resolveClubIdFilter(clubId);
 *   supabase.from('clubs').select('*').eq(column, value).maybeSingle();
 */
export function resolveClubIdFilter(clubIdParam: string): {
  column: 'id' | 'club_id' | 'slug';
  value: string | number;
} {
  if (isUUID(clubIdParam)) {
    return { column: 'id', value: clubIdParam };
  }
  if (/^\d+$/.test(clubIdParam)) {
    return { column: 'club_id', value: Number(clubIdParam) };
  }
  return { column: 'slug', value: clubIdParam };
}

// ─── Resolved-UUID cache: memory + localStorage ────────────────────────────
//
// The club_id -> UUID mapping is immutable (both columns are set at club
// creation and never change), so it is safe to persist across sessions. This
// removes an entire serial network roundtrip from the front of EVERY wallet
// and lobby mount that arrives with an integer club code in the URL.
//
// The persisted map lives under ONE localStorage key (not one key per club)
// and is purged on sign-out by clearUserCaches — the set of clubs a person
// has visited is their data.
export const CLUB_UUID_MAP_KEY = 'club_arena_uuid_map_v1';
const MAX_PERSISTED_MAPPINGS = 200;

const uuidCache = new Map<string, string>();
let persistedLoaded = false;

function loadPersistedMap(): void {
  if (persistedLoaded) return;
  persistedLoaded = true;
  try {
    const raw = localStorage.getItem(CLUB_UUID_MAP_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, string>;
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && UUID_REGEX.test(v) && !uuidCache.has(k)) {
          uuidCache.set(k, v);
        }
      }
    }
  } catch {
    /* corrupt or unavailable — memory cache still works */
  }
}

function persistMap(): void {
  try {
    const entries = Array.from(uuidCache.entries()).slice(-MAX_PERSISTED_MAPPINGS);
    localStorage.setItem(CLUB_UUID_MAP_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* best-effort */
  }
}

/**
 * Synchronous resolution attempt: returns the UUID immediately when the input
 * already is one, or when the mapping is cached (memory or localStorage).
 * Returns null when a network lookup is required — callers then fall back to
 * resolveClubUUID. This lets wallet surfaces start their data fetch in the
 * same tick they mount instead of waiting a roundtrip.
 */
export function resolveClubUUIDSync(clubIdParam: string): string | null {
  if (isUUID(clubIdParam)) return clubIdParam;
  loadPersistedMap();
  return uuidCache.get(clubIdParam) ?? null;
}

/**
 * Resolves any club ID (UUID or integer) to its actual UUID.
 * If the provided ID is already a UUID, returns it immediately.
 * If it's an integer, queries the clubs table to find the UUID.
 * Results are cached for the lifetime of the session.
 *
 * @example
 *   const uuid = await resolveClubUUID('25450');
 *   // Returns the UUID like 'abc123-...'
 *   supabase.from('tables').select('*').eq('club_id', uuid);
 */
/**
 * Drop the in-memory map. `clearUserCaches` removes the persisted copy on
 * sign-out, but this module kept its Map and its `persistedLoaded` flag, so
 * the first write after the NEXT sign-in serialised the previous account's
 * visited clubs straight back to localStorage and undid the purge.
 * walletCache exports `clearWalletMemoryCache` for exactly this reason.
 */
export function clearClubUUIDCache(): void {
  uuidCache.clear();
  persistedLoaded = false;
}

export async function resolveClubUUID(clubIdParam: string, signal?: AbortSignal): Promise<string> {
  // Already a UUID — return as-is
  if (isUUID(clubIdParam)) return clubIdParam;

  // Check cache (memory, hydrated from localStorage on first call)
  const cached = resolveClubUUIDSync(clubIdParam);
  if (cached) return cached;

  const filter = resolveClubIdFilter(clubIdParam);

  // Query clubs table to get the UUID
  const query = supabase.from('clubs').select('id').eq(filter.column, filter.value);
  const { data, error } = await (signal ? query.abortSignal(signal) : query).maybeSingle();

  /* A FAILED READ IS NOT "NO SUCH CLUB". The error used to be dropped, so an
     RLS refusal, a PostgREST 400 or a dropped connection was indistinguishable
     from a club that does not exist - and the fallback below then handed a
     6-digit integer string to callers that feed it into `.eq('club_id', uuid)`,
     producing Postgres 22P02 "invalid input syntax for type uuid" on every
     downstream query, a long way from the cause. Reporting it does not change
     the return contract, but it makes the real failure findable. */
  if (error) reportError(error, 'clubIdResolver.resolveClubUUID', { clubIdParam });

  if (data?.id) {
    uuidCache.set(clubIdParam, data.id);
    persistMap();
    return data.id;
  }

  // Fallback: return as-is (will fail downstream, but that's the existing behavior)
  console.warn(`[clubIdResolver] Could not resolve club UUID for: ${clubIdParam}`);
  return clubIdParam;
}

/**
 * Resolve a route-facing club identifier for authorization-sensitive reads.
 *
 * The legacy resolver deliberately preserves its original string fallback for
 * hundreds of older call sites. Guards and workspace permissions cannot use
 * that permissive contract: passing a slug or numeric code into a UUID column
 * turns a lookup problem into a misleading membership denial. This strict
 * variant keeps the compatibility surface while giving trust boundaries an
 * explicit, fail-closed result.
 */
export async function resolveClubUUIDStrict(
  clubIdParam: string,
  signal?: AbortSignal
): Promise<string> {
  const resolvedId = await resolveClubUUID(clubIdParam, signal);
  if (!isUUID(resolvedId)) {
    throw new Error(`Club identity could not be resolved for "${clubIdParam}".`);
  }
  return resolvedId;
}
