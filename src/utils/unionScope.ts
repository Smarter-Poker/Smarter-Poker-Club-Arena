/**
 * UNION SCOPE (P2-1, 2026-08-20)
 *
 * UNION LAW: every game in a union is created BY the union, so union tables
 * and tournaments carry the union's container club as club_id. A plain
 * .eq('club_id', <club uuid>) on tables/tournaments therefore misses every
 * union game and made club admin/analytics pages look empty.
 *
 * Use clubGamesOrFilter() to build a PostgREST .or() filter that matches a
 * club's own games PLUS its union's games.
 */
import { supabase } from '../lib/supabase';

const unionCache = new Map<string, string | null>();

/** Resolve the union_id (or null) for a club UUID, cached for the session. */
export async function resolveClubUnionId(clubUuid: string): Promise<string | null> {
  if (unionCache.has(clubUuid)) return unionCache.get(clubUuid) ?? null;
  const { data } = await supabase.from('clubs').select('union_id').eq('id', clubUuid).maybeSingle();
  const unionId = (data?.union_id as string | null) ?? null;
  unionCache.set(clubUuid, unionId);
  return unionId;
}

/**
 * PostgREST .or() filter string matching rows owned by the club OR created
 * by its union. Works for any table with club_id + union_id columns
 * (tables, tournaments).
 *
 * @example
 *   supabase.from('tables').select('*').or(await clubGamesOrFilter(uuid));
 */
export async function clubGamesOrFilter(clubUuid: string): Promise<string> {
  const unionId = await resolveClubUnionId(clubUuid);
  return unionId ? `club_id.eq.${clubUuid},union_id.eq.${unionId}` : `club_id.eq.${clubUuid}`;
}
