import { supabase } from '../lib/supabase';

/** PostgREST caps a single response. Rank requires the complete event, including
 * tables whose players happen to sort beyond the first response page. */
export async function readTournamentStandings(
  tournamentId: string,
  projection: string,
  activeOnly = false
) {
  const rows: Record<string, unknown>[] = [];
  const pageSize = 1000;
  let count: number | null = null;
  for (let offset = 0; ; offset += pageSize) {
    let query = supabase
      .from('tournament_players')
      .select(projection, { count: 'exact' })
      .eq('tournament_id', tournamentId)
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (activeOnly) query = query.in('status', ['playing', 'registered']);
    let result;
    try {
      result = await query;
    } catch (error) {
      return {
        data: null,
        error: error instanceof Error ? error : new Error(String(error)),
        count: null,
      };
    }
    if (result.error) return { data: null, error: result.error, count: null };
    if (result.data === null)
      return { data: null, error: new Error('Tournament standings unavailable'), count: null };
    count = result.count;
    const page = result.data as unknown as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < pageSize || (count !== null && rows.length >= count)) {
      return { data: rows, error: null, count: count ?? rows.length };
    }
  }
}
