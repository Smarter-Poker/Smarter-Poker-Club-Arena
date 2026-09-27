import { supabase } from '../lib/supabase';
import { clubGamesOrFilter } from '../utils/unionScope';

export const XMTT_PAGE_SIZE = 50;
export type XmttFilter = 'all' | 'registering' | 'running' | 'completed';
export interface XmttTournament {
  format_contract?: unknown;
  id: string;
  name: string;
  status: string;
  type?: string;
  buy_in: number;
  buy_in_fee?: number | null;
  max_players: number | null;
  registered_count?: number;
  start_time?: string;
  created_at: string;
  prize_pool?: number;
  club_id?: string;
}
const FILTERS = ['registering', 'running', 'completed'] as const;

/** Page only as far as the player explicitly requested. Counts never use a capped row array. */
export async function readXmttLobby(
  clubId: string,
  filter: XmttFilter,
  visibleLimit: number,
  signal: AbortSignal
) {
  if (!Number.isSafeInteger(visibleLimit) || visibleLimit < 1)
    throw new Error('Invalid Tournament Page');
  const scope = await clubGamesOrFilter(clubId);
  if (signal.aborted) throw new Error('Tournament Read Cancelled');
  const query = (selected: XmttFilter, head = false) => {
    let q = supabase
      .from('tournaments')
      .select(
        'format_contract, id, name, status, type:tournament_type, buy_in:buy_in_amount, buy_in_fee, max_players, registered_count:current_players, start_time, created_at, prize_pool, club_id, is_bounty, bounty_amount, is_pko, is_mystery_bounty',
        { count: 'exact', head }
      )
      .or(scope)
      .in('tournament_type', ['MTT', 'XMTT']);
    if (selected !== 'all') q = q.ilike('status', selected);
    return q.abortSignal(signal);
  };
  const countsPromise = Promise.all(
    FILTERS.map(async (status) => {
      const { count, error } = await query(status, true);
      if (error) throw error;
      if (!Number.isSafeInteger(count) || count! < 0)
        throw new Error('Tournament Count Unavailable');
      return [status, count!] as const;
    })
  );
  const rowsPromise = (async () => {
    const rows: XmttTournament[] = [];
    let total = 0;
    for (let from = 0; from < visibleLimit; from += XMTT_PAGE_SIZE) {
      const { data, count, error } = await query(filter)
        .order('start_time', { ascending: false })
        .order('id', { ascending: false })
        .range(from, Math.min(visibleLimit, from + XMTT_PAGE_SIZE) - 1);
      if (error) throw error;
      if (!Array.isArray(data) || !Number.isSafeInteger(count) || count! < 0)
        throw new Error('Tournament List Unavailable');
      const pageSize = Math.min(visibleLimit - from, XMTT_PAGE_SIZE);
      if (
        data.length > pageSize ||
        data.some((row) => !row || typeof row.id !== 'string' || !row.id)
      )
        throw new Error('Tournament List Unavailable');
      total = count!;
      rows.push(...(data as unknown as XmttTournament[]));
      if (rows.length >= total || data.length < XMTT_PAGE_SIZE) break;
    }
    // Offset pages can move during a concurrent insertion. Do not present an incomplete duplicate list as current.
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      throw new Error('Tournament List Changed. Refresh To Continue.');
    return { rows, total };
  })();
  const [result, counts] = await Promise.all([rowsPromise, countsPromise]);
  return {
    ...result,
    counts: Object.fromEntries(counts) as Record<Exclude<XmttFilter, 'all'>, number>,
  };
}

/** Positions only: this page never displays the old per-tournament total count. */
export async function readXmttWaitlistPositions(
  ids: string[],
  userId: string,
  signal: AbortSignal
): Promise<Record<string, number | null>> {
  const uniqueIds = [...new Set(ids)];
  const positions: Record<string, number | null> = Object.fromEntries(
    uniqueIds.map((id) => [id, null])
  );
  for (let from = 0; from < uniqueIds.length; from += XMTT_PAGE_SIZE) {
    const batch = uniqueIds.slice(from, from + XMTT_PAGE_SIZE);
    const { data, error } = await supabase
      .from('tournament_waitlists')
      .select('tournament_id, position')
      .eq('user_id', userId)
      .in('tournament_id', batch)
      .limit(batch.length + 1)
      .abortSignal(signal);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Waitlist Status Unavailable');
    const seen = new Set<string>();
    for (const row of data) {
      if (
        !batch.includes(row.tournament_id) ||
        seen.has(row.tournament_id) ||
        !Number.isSafeInteger(row.position) ||
        row.position < 1
      ) {
        throw new Error('Waitlist Status Unavailable');
      }
      seen.add(row.tournament_id);
      positions[row.tournament_id] = row.position;
    }
  }
  return positions;
}
