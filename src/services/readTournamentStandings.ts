import { supabase } from '../lib/supabase';

/** PostgREST caps a single response. Rank requires the complete event, including
 * tables whose players happen to sort beyond the first response page.
 * The projection must include id for stable paging while the field changes. */
export async function readTournamentStandings(
  tournamentId: string,
  projection: string,
  activeOnly = false
) {
  const rows: Record<string, unknown>[] = [];
  const pageSize = 1000;
  let count: number | null = null;
  let cursor: string | null = null;
  for (;;) {
    let query = supabase
      .from('tournament_players')
      .select(projection, cursor === null ? { count: 'exact' } : undefined)
      .eq('tournament_id', tournamentId)
      .order('id', { ascending: true })
      .limit(pageSize);
    if (cursor !== null) query = query.gt('id', cursor);
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
    if (!Array.isArray(result.data))
      return { data: null, error: new Error('Tournament standings unavailable'), count: null };
    // A cursor-filtered count is only the remaining suffix, not field size.
    if (cursor === null) count = result.count;
    const page = result.data as unknown as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < pageSize) {
      return { data: rows, error: null, count: count ?? rows.length };
    }
    const lastId = page[page.length - 1]?.id;
    if (typeof lastId !== 'string' || !lastId || (cursor !== null && lastId <= cursor)) {
      return {
        data: null,
        error: new Error('Tournament standings cursor unavailable'),
        count: null,
      };
    }
    cursor = lastId;
  }
}
