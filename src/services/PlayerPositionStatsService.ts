/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Player Position Stats Service
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tracks and parses positional statistics per hand, aggregating VPIP, PFR,
 * 3-Bet frequencies, and Real-time P/L across table positions.
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PositionStatPayload {
  user_id: string;
  position: string;
  hands_played: number;
  vpip_count: number;
  pfr_count: number;
  three_bet_count: number;
  fold_to_three_bet_count: number;
  hands_won: number;
  total_profit: number;
}

class PlayerPositionStatsServiceClass {
  /**
   * Parse a completed hand payload and bulk insert positional statistics
   */
  async processHand(handData: {
    players: Array<{
      id: string;
      name: string;
      seat: number;
      stack: number;
      position: string;
      isWinner?: boolean;
      result?: number;
    }>;
    actions: Array<{
      seat: number;
      action: string;
      amount?: number;
      street: string;
    }>;
  }): Promise<void> {
    try {
      const statsPayload: PositionStatPayload[] = [];
      const vipPayload: Array<{
        user_id: string;
        amount: number;
        transaction_type: string;
        description: string;
      }> = [];
      const preflopActions = handData.actions.filter(
        (a) => a.street === 'PREFLOP' || a.street === 'preflop'
      );

      // Process each player
      for (const player of handData.players) {
        // Only count real users with a position
        if (!player.id || player.id.startsWith('bot_') || !player.position) {
          continue;
        }

        const playerPreflopActions = preflopActions.filter((a) => a.seat === player.seat);

        let vpip = 0;
        let pfr = 0;
        let threeBet = 0;
        let foldToThreeBet = 0;

        // VPIP: Did they voluntarily put money in? (Call, Bet, Raise, All-in)
        if (
          playerPreflopActions.some((a) => ['call', 'bet', 'raise', 'all-in'].includes(a.action))
        ) {
          vpip = 1;
        }

        // PFR: Did they raise at any point preflop?
        if (playerPreflopActions.some((a) => ['raise', 'all-in'].includes(a.action))) {
          pfr = 1;
        }

        // 3-Bet & Fold to 3-Bet logic
        let raiseLevel = 1; // BB is 1
        for (const action of preflopActions) {
          if (action.action === 'raise' || action.action === 'all-in') {
            raiseLevel++;
            if (raiseLevel === 3 && action.seat === player.seat) {
              threeBet = 1;
            }
          } else if (action.action === 'fold' && action.seat === player.seat && raiseLevel >= 3) {
            foldToThreeBet = 1;
          }
        }

        statsPayload.push({
          user_id: player.id,
          position: player.position,
          hands_played: 1,
          vpip_count: vpip,
          pfr_count: pfr,
          three_bet_count: threeBet,
          fold_to_three_bet_count: foldToThreeBet,
          hands_won: player.isWinner ? 1 : 0,
          total_profit: player.result || 0,
        });

        // Feature 13: Grant 1 VIP Point per hand played
        vipPayload.push({
          user_id: player.id,
          amount: 1,
          transaction_type: 'hand_played',
          description: `Played hand at ${player.position}`,
        });
      }

      // Upsert positional statistics
      if (statsPayload.length > 0) {
        const { error } = await retryAsync(
          () =>
            supabase.rpc('bulk_update_position_stats', {
              payload: statsPayload,
            }),
          3
        );
        if (error) {
          console.error('[PositionStats] Failed to upsert stats:', error.message);
        } else {
          console.debug(`[PositionStats] Upserted positions for ${statsPayload.length} players`);
        }
      }

      // Bulk Add VIP points and broadcast globally
      // NOTE: bulk_add_vip_points RPC may not exist yet — individual add_vip_points is the fallback
      if (vipPayload.length > 0) {
        const { error: vipError } = await retryAsync(
          () =>
            supabase.rpc('bulk_add_vip_points', {
              payload: vipPayload,
            }),
          1 // Only 1 retry — RPC may not exist
        );
        if (!vipError) {
          vipPayload.forEach((v) => {
            masterBus.emit('VIP_POINTS_UPDATED', {
              userId: v.user_id,
              added: v.amount,
              source: 'hand_played',
            });
          });
        }
      }
    } catch (err: unknown) {
      console.error('[PositionStats] Processing error:', err);
    }
  }
}

export const playerPositionStatsService = new PlayerPositionStatsServiceClass();
export default playerPositionStatsService;
