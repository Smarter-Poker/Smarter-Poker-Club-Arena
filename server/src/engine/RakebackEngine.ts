/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RAKEBACK ENGINE — Player Rake Contribution Tracking & Rebate System
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tracks per-player rake credit and distributes rakeback:
 * - FIX 144: EQUAL share method — each dealt-in player gets 1/N of total rake
 *   (NOT weighted by pot contribution — NEVER weighted under any circumstances)
 * - Volume-based tier system for rakeback percentage
 * - Periodic settlement (daily/weekly/monthly)
 * - Supabase persistence for rakeback_periods table
 * - Optional event callbacks for transparency
 *
 * Ported from client: src/engine/RakebackEngine.ts (301 lines)
 * Server adaptation: No masterBus — uses optional onEvent callback. Class export, not singleton.
 *   Supabase client injected via constructor (not imported globally).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { reportError } from '../services/errorReporter.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface RakebackTier {
  minRake: number;
  rakebackPercent: number;
  name: string;
}

export interface RakebackConfig {
  enabled: boolean;
  tiers: RakebackTier[];
  settlementFrequency: 'daily' | 'weekly' | 'monthly';
  minimumPayout: number;
}

export interface PlayerRakeRecord {
  playerId: string;
  rakeContributed: number;
  potsContributed: number;
  currentTier: RakebackTier;
  pendingRakeback: number;
  periodStart: number;
}

export const DEFAULT_RAKEBACK_TIERS: RakebackTier[] = [
  { minRake: 0, rakebackPercent: 5, name: 'Bronze' },
  { minRake: 100, rakebackPercent: 10, name: 'Silver' },
  { minRake: 500, rakebackPercent: 15, name: 'Gold' },
  { minRake: 2000, rakebackPercent: 20, name: 'Platinum' },
  { minRake: 10000, rakebackPercent: 25, name: 'Diamond' },
  { minRake: 50000, rakebackPercent: 30, name: 'Elite' },
];

export type RakebackEventType = 'RAKEBACK_CALCULATED' | 'RAKEBACK_DISTRIBUTED';

export interface RakebackEvent {
  type: RakebackEventType;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RAKEBACK ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class RakebackEngine {
  private configs: Map<string, RakebackConfig> = new Map();
  private playerRecords: Map<string, PlayerRakeRecord> = new Map();
  private supabase: SupabaseClient;
  private onEvent?: (event: RakebackEvent) => void;

  private readonly DEFAULT_CONFIG: RakebackConfig = {
    enabled: false,
    tiers: DEFAULT_RAKEBACK_TIERS,
    settlementFrequency: 'weekly',
    minimumPayout: 1,
  };

  constructor(supabase: SupabaseClient, onEvent?: (event: RakebackEvent) => void) {
    this.supabase = supabase;
    this.onEvent = onEvent;
  }

  configure(clubId: string, config: Partial<RakebackConfig>): void {
    this.configs.set(clubId, { ...this.DEFAULT_CONFIG, ...config });
  }

  isEnabled(clubId: string): boolean {
    return this.configs.get(clubId)?.enabled ?? false;
  }

  /**
   * Record rake contributions from a hand.
   * FIX 144: EQUAL SHARE method — each dealt-in player gets credited with an
   * equal portion of the total rake generated for that hand.
   * Rake is taken from the POT (not per player), but each dealt-in player
   * gets 1/N of the rake credited for rakeback tracking purposes.
   */
  recordHandRake(
    clubId: string,
    totalRake: number,
    contributions: Map<string, number>,
    totalPotContributions: number
  ): void {
    const config = this.configs.get(clubId) || this.DEFAULT_CONFIG;
    if (!config.enabled || totalRake <= 0) return;

    // FIX 170: Count dealt-in players — must have invested > 0 (not >= 0).
    // Players with 0 contribution were not dealt in and should not receive rakeback credit.
    const dealtInPlayers = [...contributions.entries()].filter(([, invested]) => invested > 0);
    const playerCount = dealtInPlayers.length;
    if (playerCount === 0) return;

    // Equal share: each dealt-in player gets totalRake / playerCount
    const equalShare = Math.round((totalRake / playerCount) * 100) / 100;

    for (const [playerId] of dealtInPlayers) {
      const roundedShare = equalShare;

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

      record.currentTier = this.determineTier(record.rakeContributed, config);

      const rakebackAmount = (roundedShare * record.currentTier.rakebackPercent) / 100;
      record.pendingRakeback += Math.round(rakebackAmount * 100) / 100;
    }
  }

  /**
   * Calculate and distribute pending rakeback for all players in a club.
   * Persists to the `rakeback_periods` table.
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

        this.emitEvent({
          type: 'RAKEBACK_CALCULATED',
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

    // Persist to rakeback_periods table
    if (rows.length > 0) {
      try {
        const { error } = await this.supabase
          .from('rakeback_periods')
          .insert(rows);

        if (error) {
          reportError(error, 'RakebackEngine.Failed_to_persist_rakeback_per');
        } else {
          console.debug(
            `[RakebackEngine] Persisted ${rows.length} rakeback periods for club ${clubId.substring(0, 8)}...`
          );
        }
      } catch (err) {
        reportError(err, 'RakebackEngine.Exception_persisting_rakeback_');
      }
    }

    if (totalDistributed > 0) {
      this.emitEvent({
        type: 'RAKEBACK_DISTRIBUTED',
        period: new Date().toISOString(),
        totalDistributed,
        playersCount,
      });
    }

    return distribution;
  }

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

  dispose(clubId: string): void {
    for (const key of [...this.playerRecords.keys()]) {
      if (key.startsWith(`${clubId}:`)) {
        this.playerRecords.delete(key);
      }
    }
    this.configs.delete(clubId);
  }

  disposeAll(): void {
    this.playerRecords.clear();
    this.configs.clear();
  }

  private determineTier(rakeContributed: number, config: RakebackConfig): RakebackTier {
    const tiers = [...config.tiers].sort((a, b) => b.minRake - a.minRake);
    for (const tier of tiers) {
      if (rakeContributed >= tier.minRake) return tier;
    }
    return config.tiers[0] || DEFAULT_RAKEBACK_TIERS[0];
  }

  private emitEvent(event: RakebackEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch (err) {
        reportError(err, 'RakebackEngine.Event_handler_error');
      }
    }
  }
}
