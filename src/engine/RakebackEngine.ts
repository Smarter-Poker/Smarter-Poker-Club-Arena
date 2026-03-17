/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RAKEBACK ENGINE — Player Rake Contribution Tracking & Rebate System
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tracks per-player contributed rake and distributes rakeback:
 * - Weighted contributed method: only players who put chips in the pot
 * - Volume-based tier system for rakeback percentage
 * - Periodic settlement (daily/weekly/monthly)
 * - Bus emissions for transparency
 */

import { masterBus } from '../core/MasterBus';
import { supabase } from '../lib/supabase';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface RakebackTier {
  /** Minimum monthly rake to qualify (in chips) */
  minRake: number;
  /** Rakeback percentage for this tier (0-100) */
  rakebackPercent: number;
  /** Tier name for display */
  name: string;
}

export interface RakebackConfig {
  /** Whether rakeback is enabled for this club */
  enabled: boolean;
  /** Volume-based tier levels */
  tiers: RakebackTier[];
  /** Settlement frequency */
  settlementFrequency: 'daily' | 'weekly' | 'monthly';
  /** Minimum amount before payout (to avoid micro-transactions) */
  minimumPayout: number;
}

export interface PlayerRakeRecord {
  playerId: string;
  /** Total rake contributed this period */
  rakeContributed: number;
  /** Number of pots contributed to */
  potsContributed: number;
  /** Current tier based on volume */
  currentTier: RakebackTier;
  /** Accumulated rakeback not yet paid out */
  pendingRakeback: number;
  /** Period start timestamp */
  periodStart: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT TIERS
// ═══════════════════════════════════════════════════════════════════════════════

export const DEFAULT_RAKEBACK_TIERS: RakebackTier[] = [
  { minRake: 0, rakebackPercent: 5, name: 'Bronze' },
  { minRake: 100, rakebackPercent: 10, name: 'Silver' },
  { minRake: 500, rakebackPercent: 15, name: 'Gold' },
  { minRake: 2000, rakebackPercent: 20, name: 'Platinum' },
  { minRake: 10000, rakebackPercent: 25, name: 'Diamond' },
  { minRake: 50000, rakebackPercent: 30, name: 'Elite' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// RAKEBACK ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class RakebackEngineClass {
  private configs: Map<string, RakebackConfig> = new Map(); // key: clubId
  private playerRecords: Map<string, PlayerRakeRecord> = new Map(); // key: clubId:playerId

  private readonly DEFAULT_CONFIG: RakebackConfig = {
    enabled: false,
    tiers: DEFAULT_RAKEBACK_TIERS,
    settlementFrequency: 'weekly',
    minimumPayout: 1,
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════

  configure(clubId: string, config: Partial<RakebackConfig>): void {
    this.configs.set(clubId, { ...this.DEFAULT_CONFIG, ...config });
  }

  isEnabled(clubId: string): boolean {
    return this.configs.get(clubId)?.enabled ?? false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RAKE TRACKING (called after each hand)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record rake contributions from a hand.
   * Uses the weighted contributed method: each player's share of the rake
   * is proportional to their contribution to the pot.
   *
   * @param clubId - The club running the table
   * @param totalRake - Total rake taken from this hand
   * @param contributions - Map of playerId → amount they put in the pot
   * @param totalPotContributions - Total amount put in the pot by all players
   */
  recordHandRake(
    clubId: string,
    totalRake: number,
    contributions: Map<string, number>,
    totalPotContributions: number
  ): void {
    const config = this.configs.get(clubId) || this.DEFAULT_CONFIG;
    if (!config.enabled || totalRake <= 0 || totalPotContributions <= 0) return;

    for (const [playerId, potContribution] of contributions) {
      if (potContribution <= 0) continue;

      // Weighted rake: player's share proportional to pot contribution
      const rakeShare = (potContribution / totalPotContributions) * totalRake;
      const roundedShare = Math.round(rakeShare * 100) / 100;

      const key = `${clubId}:${playerId}`;
      let record = this.playerRecords.get(key);

      if (!record) {
        record = {
          playerId,
          rakeContributed: 0,
          potsContributed: 0,
          currentTier: config.tiers[0] || DEFAULT_RAKEBACK_TIERS[0],
          pendingRakeback: 0,
          periodStart: Date.now(),
        };
        this.playerRecords.set(key, record);
      }

      record.rakeContributed += roundedShare;
      record.potsContributed++;

      // Update tier based on new total
      record.currentTier = this.determineTier(record.rakeContributed, config);

      // Calculate and accumulate rakeback
      const rakebackAmount = (roundedShare * record.currentTier.rakebackPercent) / 100;
      record.pendingRakeback += Math.round(rakebackAmount * 100) / 100;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SETTLEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Calculate and distribute pending rakeback for all players in a club.
   * Persists each player's rakeback period to the `rakeback_periods` table
   * so the RakebackPage UI can display and players can claim.
   * Returns the distribution for processing.
   */
  async settleRakeback(clubId: string): Promise<Map<string, number>> {
    const config = this.configs.get(clubId) || this.DEFAULT_CONFIG;
    const distribution = new Map<string, number>();
    let totalDistributed = 0;
    let playersCount = 0;

    const now = new Date();
    const periodEnd = now.toISOString();
    const rows: Array<{
      user_id: string;
      club_id: string;
      period_start: string;
      period_end: string;
      rake_generated: number;
      rakeback_rate: number;
      rakeback_earned: number;
      total_rake_paid: number;
      status: string;
    }> = [];

    for (const [key, record] of this.playerRecords) {
      if (!key.startsWith(`${clubId}:`)) continue;

      if (record.pendingRakeback >= config.minimumPayout) {
        distribution.set(record.playerId, record.pendingRakeback);
        totalDistributed += record.pendingRakeback;
        playersCount++;

        const rakebackRate = record.currentTier.rakebackPercent / 100;

        rows.push({
          user_id: record.playerId,
          club_id: clubId,
          period_start: new Date(record.periodStart).toISOString(),
          period_end: periodEnd,
          rake_generated: Math.round(record.rakeContributed * 100) / 100,
          rakeback_rate: rakebackRate,
          rakeback_earned: Math.round(record.pendingRakeback * 100) / 100,
          total_rake_paid: Math.round(record.rakeContributed * 100) / 100,
          status: 'pending',
        });

        masterBus.emit('RAKEBACK_CALCULATED', {
          playerId: record.playerId,
          period: new Date(record.periodStart).toISOString(),
          rakeContributed: record.rakeContributed,
          rakebackAmount: record.pendingRakeback,
          tier: record.currentTier.name,
        });

        // Reset for next period
        record.pendingRakeback = 0;
        record.rakeContributed = 0;
        record.potsContributed = 0;
        record.periodStart = Date.now();
      }
    }

    // Persist to rakeback_periods table so RakebackPage can display them
    if (rows.length > 0) {
      try {
        const { error } = await supabase
          .from('rakeback_periods')
          .insert(rows);

        if (error) {
          console.error('[RakebackEngine] Failed to persist rakeback periods:', error.message);
        } else {
          console.debug(
            `[RakebackEngine] Persisted ${rows.length} rakeback periods for club ${clubId.substring(0, 8)}...`
          );
        }
      } catch (err) {
        console.error('[RakebackEngine] Exception persisting rakeback periods:', err);
      }
    }

    if (totalDistributed > 0) {
      masterBus.emit('RAKEBACK_DISTRIBUTED', {
        period: new Date().toISOString(),
        totalDistributed,
        playersCount,
      });
    }

    return distribution;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE QUERIES
  // ═══════════════════════════════════════════════════════════════════════════

  getPlayerRecord(clubId: string, playerId: string): PlayerRakeRecord | null {
    return this.playerRecords.get(`${clubId}:${playerId}`) ?? null;
  }

  getAllRecords(clubId: string): PlayerRakeRecord[] {
    const records: PlayerRakeRecord[] = [];
    for (const [key, record] of this.playerRecords) {
      if (key.startsWith(`${clubId}:`)) records.push(record);
    }
    return records;
  }

  getCurrentTier(clubId: string, playerId: string): RakebackTier | null {
    return this.getPlayerRecord(clubId, playerId)?.currentTier ?? null;
  }

  getPendingRakeback(clubId: string, playerId: string): number {
    return this.getPlayerRecord(clubId, playerId)?.pendingRakeback ?? 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════

  dispose(clubId: string): void {
    for (const key of this.playerRecords.keys()) {
      if (key.startsWith(`${clubId}:`)) {
        this.playerRecords.delete(key);
      }
    }
    this.configs.delete(clubId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE
  // ═══════════════════════════════════════════════════════════════════════════

  private determineTier(rakeContributed: number, config: RakebackConfig): RakebackTier {
    const tiers = [...config.tiers].sort((a, b) => b.minRake - a.minRake);
    for (const tier of tiers) {
      if (rakeContributed >= tier.minRake) return tier;
    }
    return config.tiers[0] || DEFAULT_RAKEBACK_TIERS[0];
  }
}

export const rakebackEngine = new RakebackEngineClass();
export default rakebackEngine;
