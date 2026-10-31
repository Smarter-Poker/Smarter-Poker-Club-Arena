import { supabase } from '../lib/supabase';

/** Keep the profile's cash behavior and tournament results as independent reads. */
export async function readSeparatedProfileStats(userId: string) {
  const args = { p_user: userId, p_days: null, p_asset: 'chips' };
  const [cash, tournament] = await Promise.all([
    supabase.rpc('ca_player_stats_overview_separated', { ...args, p_game_mode: 'cash' }),
    supabase.rpc('ca_player_stats_overview_separated', { ...args, p_game_mode: 'tournament' }),
  ]);
  if (cash.error || tournament.error) return { data: null, error: cash.error ?? tournament.error };
  if (
    cash.data?.scope?.game_mode !== 'cash' ||
    tournament.data?.scope?.game_mode !== 'tournament' ||
    cash.data?.scope?.target_user_id !== userId ||
    tournament.data?.scope?.target_user_id !== userId
  )
    return { data: null, error: new Error('Profile Statistics Scope Could Not Be Verified') };
  return {
    data: {
      ...cash.data,
      tournament_overall: tournament.data.overall,
      tournaments: tournament.data.tournaments,
      recent_tournaments: tournament.data.recent_tournaments,
    },
    error: null,
  };
}
