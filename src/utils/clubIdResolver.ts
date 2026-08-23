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

// ─── In-memory cache for resolved UUIDs ────────────────────────────────────
const uuidCache = new Map<string, string>();

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

  // Check cache
  const cached = uuidCache.get(clubIdParam);
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
    return data.id;
  }

  // Fallback: return as-is (will fail downstream, but that's the existing behavior)
  console.warn(`[clubIdResolver] Could not resolve club UUID for: ${clubIdParam}`);
  return clubIdParam;
}
