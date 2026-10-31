import { supabase } from '../lib/supabase';
import { aggregateArenaRecord, type ArenaRecord } from '../utils/arenaRecord';

/** The public credential retains only nonfinancial fields, in separate samples. */
export async function readSeparatedPublicArenaRecord(
  targetUserId: string
): Promise<ArenaRecord | null> {
  const modes = ['cash', 'tournament'] as const;
  const results = await Promise.all(
    modes.map(async (mode) => {
      const { data, error } = await supabase.rpc('ca_public_arena_record_separated', {
        p_target_user: targetUserId,
        p_game_mode: mode,
        p_asset: 'chips',
      });
      if (error) throw error;
      if (
        data?.contract_version !== 2 ||
        data?.scope?.target_user_id !== targetUserId ||
        data?.scope?.game_mode !== mode ||
        data?.scope?.asset !== 'chips' ||
        data?.scope?.visibility !== 'public' ||
        !Array.isArray(data?.rows)
      ) {
        throw new Error('Public Player Record Scope Could Not Be Verified');
      }
      for (const row of data.rows) {
        if (
          !row ||
          ['hands_played', 'vpip', 'pfr', 'tournaments_played', 'tournaments_won'].some(
            (key) => typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0
          ) ||
          row.vpip > 100 ||
          row.pfr > row.vpip ||
          row.tournaments_won > row.tournaments_played
        ) {
          throw new Error('Public Player Record Could Not Be Verified');
        }
      }
      return { count: data.rows.length, record: aggregateArenaRecord(data.rows) };
    })
  );
  if (results.every((result) => result.count === 0)) return null;
  return {
    ...results[0].record,
    tournamentsPlayed: results[1].record.tournamentsPlayed,
    tournamentsWon: results[1].record.tournamentsWon,
  };
}
