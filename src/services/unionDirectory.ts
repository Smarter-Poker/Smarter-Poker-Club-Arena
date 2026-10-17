import { supabase } from '../lib/supabase';

/** PostgREST answers at most this many rows per request (the API's max-rows). */
export const UNION_DIRECTORY_PAGE = 1000;

/**
 * THE WHOLE UNION, NOT ITS FIRST THOUSAND (Dan's sweep, 2026-10-17).
 *
 * fn_union_player_directory returns every player of every member club and has
 * no LIMIT of its own, but the API caps a single answer at 1,000 rows. Midway
 * Union's Union Bank and Promo Wallet therefore listed "3 Clubs - 1,000
 * Members" for a union with more, and the union dashboard's Players tab
 * stopped at the same row. The roster is read in pages ordered by its unique
 * (club_id, user_id) pair, so no seam can repeat or skip a row, until a page
 * comes back short. Any failed page fails the whole read: a partial roster
 * presented as complete is the bug this replaces.
 */
export async function readUnionDirectory<Row>(
  unionId: string
): Promise<{ data: Row[] | null; error: unknown }> {
  const rows: Row[] = [];
  for (let from = 0; ; from += UNION_DIRECTORY_PAGE) {
    const { data, error } = await supabase
      .rpc('fn_union_player_directory', { p_union_id: unionId })
      .order('club_id', { ascending: true })
      .order('user_id', { ascending: true })
      .range(from, from + UNION_DIRECTORY_PAGE - 1);
    if (error) return { data: null, error };
    const page = (data as Row[] | null) ?? [];
    rows.push(...page);
    if (page.length < UNION_DIRECTORY_PAGE) return { data: rows, error: null };
  }
}
