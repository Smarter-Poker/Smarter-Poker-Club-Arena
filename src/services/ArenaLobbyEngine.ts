/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Arena Lobby Engine
 * ═══════════════════════════════════════════════════════════════════════════════
 * Real-time traffic monitoring and live game discovery
 */

import { supabase } from '@/lib/supabase';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubUUID } from '../utils/clubIdResolver';
import type {
  ClubTrafficData,
  StakeInfo,
  HeatLevel,
  HeatConfig,
  HEAT_LEVELS,
} from '@/types/club.types';

// ═══════════════════════════════════════════════════════════════════════════════
//  HEAT LEVEL CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

const HEAT_THRESHOLDS: HeatConfig[] = [
  { level: 0, name: 'COLD', color: '#4A5568', minPlayers: 0, minWaiting: 0 },
  { level: 1, name: 'WARM', color: '#48BB78', minPlayers: 10, minWaiting: 2 },
  { level: 2, name: 'ACTIVE', color: '#ECC94B', minPlayers: 25, minWaiting: 5 },
  { level: 3, name: 'HOT', color: '#ED8936', minPlayers: 50, minWaiting: 10 },
  { level: 4, name: 'VERY HOT', color: '#F56565', minPlayers: 75, minWaiting: 15 },
  { level: 5, name: 'RED HOT', color: '#E53E3E', minPlayers: 100, minWaiting: 20 },
];

/**
 * Calculate heat level based on player count and waiting list
 */
export function calculateHeatLevel(activePlayers: number, waitingTotal: number): HeatLevel {
  // Find the highest matching heat level
  for (let i = HEAT_THRESHOLDS.length - 1; i >= 0; i--) {
    const threshold = HEAT_THRESHOLDS[i];
    if (activePlayers >= threshold.minPlayers || waitingTotal >= threshold.minWaiting) {
      return threshold.level as HeatLevel;
    }
  }
  return 0;
}

/**
 * Get heat level configuration
 */
export function getHeatConfig(level: HeatLevel): HeatConfig {
  return HEAT_THRESHOLDS[level];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  LIVE TRAFFIC FETCHING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch aggregated lobby data for all clubs
 */
export async function getArenaLobbyClubs(): Promise<ClubTrafficData[]> {
  const { data, error } = await retryAsync(() => supabase.rpc('get_arena_lobby_clubs'), 3);

  if (error) {
    console.error('[ArenaLobbyEngine] get_arena_lobby_clubs RPC not available:', error.message);
    // Fallback: return empty array instead of crashing
    return [];
  }

  return (data || []).map((club: any) => ({
    ...club,
    heat_level: calculateHeatLevel(club.active_players, club.waiting_list_total),
  }));
}

/**
 * Fetch traffic data for a specific club
 */
export async function getClubTraffic(clubId: string): Promise<ClubTrafficData | null> {
  const { data, error } = await retryAsync(
    () =>
      supabase.rpc('get_club_traffic', {
        p_club_id: clubId,
      }),
    3
  );

  if (error) {
    console.error('[ArenaLobbyEngine] get_club_traffic RPC not available:', error.message);
    // Fallback: return null instead of crashing
    return null;
  }

  if (!data) return null;

  return {
    ...data,
    heat_level: calculateHeatLevel(data.active_players, data.waiting_list_total),
  };
}

/**
 * Fetch detailed stake breakdown for a club
 */
export async function getClubStakes(clubId: string): Promise<StakeInfo[]> {
  const { data, error } = await supabase
    .from('tables')
    .select(
      'id, club_id, table_name, game_type, small_blind, big_blind, min_buy_in, max_buy_in, max_players, player_count, status, waiting_list_count, label, created_at'
    )
    .eq('club_id', await resolveClubUUID(clubId))
    .eq('status', 'active')
    .order('small_blind', { ascending: true });

  if (error) {
    console.error('[Service] Stakes fetch failed:', error);
    throw new Error('Failed to fetch stakes');
  }

  return data || [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// 📡 REAL-TIME SUBSCRIPTIONS
// ═══════════════════════════════════════════════════════════════════════════════

type TrafficUpdateCallback = (data: ClubTrafficData) => void;

/**
 * Subscribe to real-time traffic updates for a club
 */
export function subscribeToClubTraffic(
  clubId: string,
  callback: TrafficUpdateCallback
): () => void {
  const channel = supabase
    .channel(`club_traffic:${clubId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'tables',
        filter: `club_id=eq.${clubId}`,
      },
      async () => {
        // Re-fetch aggregated data on any change
        const traffic = await getClubTraffic(clubId);
        if (traffic) {
          callback(traffic);
        }
      }
    )
    .subscribe();

  // Return unsubscribe function
  return () => {
    supabase.removeChannel(channel);
  };
}

/**
 * Subscribe to all lobby traffic updates
 */
export function subscribeToLobbyTraffic(callback: (data: ClubTrafficData[]) => void): () => void {
  const channel = supabase
    .channel('arena_lobby')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'tables',
      },
      async () => {
        // Re-fetch all lobby data on any change
        const lobbyData = await getArenaLobbyClubs();
        callback(lobbyData);
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SOFTNESS CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate game softness based on players-per-flop average
 * This indicates how loose/passive the table is
 */
export function calculateSoftness(
  playersPerFlop: number
): 'tight' | 'average' | 'soft' | 'very_soft' {
  if (playersPerFlop < 25) return 'tight';
  if (playersPerFlop < 35) return 'average';
  if (playersPerFlop < 50) return 'soft';
  return 'very_soft';
}

// Export service object
export const ArenaLobbyEngine = {
  getArenaLobbyClubs,
  getClubTraffic,
  getClubStakes,
  subscribeToClubTraffic,
  subscribeToLobbyTraffic,
  calculateHeatLevel,
  getHeatConfig,
  calculateSoftness,
};
