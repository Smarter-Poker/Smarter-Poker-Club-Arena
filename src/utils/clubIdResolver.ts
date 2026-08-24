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
export async function resolveClubUUID(clubIdParam: string): Promise<string> {
  // Already a UUID — return as-is
  if (isUUID(clubIdParam)) return clubIdParam;

  // Check cache (memory, hydrated from localStorage on first call)
  const cached = resolveClubUUIDSync(clubIdParam);
  if (cached) return cached;

  const filter = resolveClubIdFilter(clubIdParam);

  // Query clubs table to get the UUID
  const { data } = await supabase
    .from('clubs')
    .select('id')
    .eq(filter.column, filter.value)
    .maybeSingle();

  if (data?.id) {
    uuidCache.set(clubIdParam, data.id);
    persistMap();
    return data.id;
  }

  // Fallback: return as-is (will fail downstream, but that's the existing behavior)
  console.warn(`[clubIdResolver] Could not resolve club UUID for: ${clubIdParam}`);
  return clubIdParam;
}
