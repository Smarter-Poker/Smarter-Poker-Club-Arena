/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNION ID RESOLVER — slug or UUID in the URL, UUID in every query
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Union routes read /unions/<slug> (Dan 2026-09-04: "the Midway Union slug is
 * not present and should be", instead of /unions/fade0000-0000-...). The
 * database keys everything by `unions.id`, so every page that reads the route
 * param resolves it here first. Mirrors utils/clubIdResolver, which does the
 * same job for /clubs/<slug>.
 *
 * Contract: a UUID is returned as-is with no network; a slug is looked up once
 * and cached for the session. An unknown slug returns null; a failed lookup
 * throws. Neither result may become a slug in a UUID-only query.
 */

import { supabase } from '../lib/supabase';
import { isUUID } from './clubIdResolver';

const cache = new Map<string, string>();
/** id -> slug, learned from any union row that passed through mapUnion. */
const slugById = new Map<string, string>();

export function resolveUnionUUIDSync(param: string): string | null {
  if (isUUID(param)) return param;
  return cache.get(param) ?? null;
}

export function clearUnionUUIDCache(): void {
  cache.clear();
  slugById.clear();
}

/**
 * The identifier to write into a /unions/... link for this union: the slug
 * when it is already known, otherwise the id (SlugEnforcer then rewrites it
 * once on arrival). For links built from rows that carry only `union_id`.
 */
export function unionRouteRef(id: string): string {
  return slugById.get(id) || id;
}

export async function resolveUnionUUID(param: string): Promise<string | null> {
  const sync = resolveUnionUUIDSync(param);
  if (sync) return sync;
  const { data, error } = await supabase
    .from('unions')
    .select('id')
    .eq('slug', param)
    .maybeSingle();
  if (error) throw error;
  if (data?.id) {
    cache.set(param, data.id);
    return data.id;
  }
  return null;
}

/** Remember a slug -> id pair learned from a row already in hand. */
export function rememberUnionSlug(slug: string | null | undefined, id: string): void {
  if (slug && isUUID(id)) {
    cache.set(slug, id);
    slugById.set(id, slug);
  }
}
