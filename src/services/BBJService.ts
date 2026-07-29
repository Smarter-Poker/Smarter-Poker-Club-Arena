/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BBJ SERVICE — Bad Beat Jackpot Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages the Triple-Bank BBJ system:
 * - MAIN Pool: Active jackpot displayed to players
 * - BACKUP Pool: Seeds next jackpot after a hit
 * - PROMO Pool: High-hand rewards and rain events
 *
 * TRIGGER LAW:
 * - NLH/PLO4/PLO5: Quad 2s or better beaten
 * - PLO6:  HARD LOCK - No BBJ for PLO6 variants
 */

import { supabase } from '../lib/supabase';
import { WalletService } from './WalletService';
import { masterBus } from '../core/MasterBus';
import type { EvaluatedHand } from '../types/engine/poker';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BBJPool {
  id: string;
  union_id: string | null;
  club_id: string | null;
  main_balance: number;
  backup_balance: number;
  promo_balance: number;
  total_contributed: number;
  last_hit_at: string | null;
  last_hit_amount: number | null;
  created_at: string;
  updated_at: string;
}

export interface BBJContribution {
  id: string;
  pool_id: string;
  hand_id: string;
  table_id: string;
  amount: number;
  main_portion: number;
  backup_portion: number;
  promo_portion: number;
  created_at: string;
}

export interface BBJPayout {
  id: string;
  pool_id: string;
  hand_id: string;
  winner_user_id: string;
  loser_user_id: string;
  table_players_share: number;
  // RAKE-AUDIT 2026-07-24: comments corrected — they were INVERTED vs the
  // actual PAYOUT_SHARES constants (LOSER 50% / WINNER 25% / TABLE 25%).
  // The BAD-BEAT HOLDER (the "loser" of the hand) gets the biggest share.
  winner_share: number; // Hand winner: typically 25%
  loser_share: number; // Bad-beat holder (hand loser): typically 50%
  table_share: number; // Typically 25% split among dealt-in players
  total_amount: number;
  created_at: string;
}

export type GameVariant = 'nlh' | 'plo4' | 'plo5' | 'plo6' | 'plo8' | 'short_deck';

export interface BBJTriggerResult {
  triggered: boolean;
  losingHand?: string;
  winningHand?: string;
  reason?: string;
}

export interface BBJPayoutParams {
  poolId: string;
  handId: string;
  clubId: string;
  tableId: string;
  handNumber: number;
  bigBlind: number;
  stakesTier: string;
  gameVariant: string;
  winnerUserId: string;
  winnerHand: string;
  winnerCards: string;
  winnerDisplayName: string;
  loserUserId: string;
  loserHand: string;
  loserCards: string;
  loserDisplayName: string;
  dealtInPlayerIds: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * BBJ Allocation Ratios
 * STANDARD MODE: <100k chips in main pool
 * PIVOT MODE: ≥100k chips in main pool
 */
const ALLOCATION = {
  STANDARD: {
    MAIN: 0.5, // 50%
    BACKUP: 0.25, // 25%
    PROMO: 0.25, // 25%
  },
  PIVOT: {
    MAIN: 0.3, // 30%
    BACKUP: 0.4, // 40%
    PROMO: 0.3, // 30%
  },
  PIVOT_THRESHOLD: 100000, // 100,000 chips
};

/**
 * BBJ Payout Distribution
 */
const PAYOUT_SHARES = {
  LOSER: 0.5, // 50% to the player whose qualifying hand was beaten (bad beat victim)
  WINNER: 0.25, // 25% to the player who beat the qualifying hand
  TABLE: 0.25, // 25% split among all dealt-in players at the table
};

/**
 * Minimum hand rankings that qualify for BBJ
 * Quad 2s is FOUR_OF_A_KIND (rank 8) with 2s as kicker
 */
const BBJ_MINIMUM_RANKING = 8; // FOUR_OF_A_KIND

/**
 * Variants that DO NOT have BBJ
 */
const BBJ_EXCLUDED_VARIANTS: GameVariant[] = ['plo6'];

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const BBJService = {
  /**
   * Ensure a BBJ pool exists for a club, creating one if missing
   * Used for backward compatibility with clubs created before pool initialization
   */
  async ensurePoolExists(clubId: string): Promise<BBJPool | null> {
    // Try to get existing pool
    const pool = await this.getPool({ clubId });
    if (pool) {
      return pool;
    }

    // Pool doesn't exist — create it
    const { data: newPool, error } = await supabase
      .from('bbj_pools')
      .insert({
        club_id: clubId,
        union_id: null,
        main_balance: 0,
        backup_balance: 0,
        promo_balance: 0,
        status: 'active',
        created_at: new Date().toISOString(),
      })
      .select()
      .maybeSingle();

    if (error || !newPool) {
      console.debug(
        'BBJService.ensurePoolExists: Failed to create pool:',
        error?.message || 'No data returned'
      );
      return null;
    }

    // Map and return the newly created pool
    const mapped: BBJPool = {
      id: newPool.id,
      union_id: newPool.union_id,
      club_id: newPool.club_id,
      main_balance: newPool.main_balance || 0,
      backup_balance: newPool.backup_balance || 0,
      promo_balance: newPool.promo_balance || 0,
      total_contributed: newPool.total_contributed || 0,
      last_hit_at: newPool.last_hit_at,
      last_hit_amount: newPool.last_hit_amount || 0,
      created_at: newPool.created_at,
      updated_at: newPool.updated_at,
    };

    return mapped;
  },

  /**
   * Get BBJ pool balances for a union or independent club
   */
  async getPool(options: { unionId?: string; clubId?: string }): Promise<BBJPool | null> {
    const { unionId, clubId } = options;

    let query = supabase
      .from('bbj_pools')
      .select(
        'id, union_id, club_id, main_balance, backup_balance, promo_balance, total_contributed, last_hit_at, last_hit_amount, status, created_at, updated_at'
      );

    if (unionId) {
      query = query.eq('union_id', unionId);
    } else if (clubId) {
      query = query.eq('club_id', await resolveClubUUID(clubId));
    } else {
      reportError('Must provide unionId or clubId', 'BBJService.getPool');
      return null;
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      // No pool found is not a critical error — return a default empty pool
      if (error.code === 'PGRST116') {
        console.debug('BBJService.getPool: No pool found, returning default');
        return null;
      }
      console.debug('BBJService.getPool error:', error);
      return null;
    }

    if (!data) return null;

    // Map DB columns to service interface
    // DB has: main_balance, backup_balance, promo_balance, total_contributed
    const mapped: BBJPool = {
      id: data.id,
      union_id: data.union_id,
      club_id: data.club_id,
      main_balance: data.main_balance || 0,
      backup_balance: data.backup_balance || 0,
      promo_balance: data.promo_balance || 0,
      total_contributed: data.total_contributed || 0,
      last_hit_at: data.last_hit_at,
      last_hit_amount: data.last_hit_amount || 0,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };

    return mapped;
  },

  /**
   * Calculate BBJ contribution from a pot
   * Uses 0.5x Big Blind rule
   */
  calculateContribution(bigBlind: number): number {
    return bigBlind * 0.5;
  },

  /**
   * Determine allocation ratios based on current pool size
   */
  getAllocationRatios(currentMainBalance: number): typeof ALLOCATION.STANDARD {
    if (currentMainBalance >= ALLOCATION.PIVOT_THRESHOLD) {
      return ALLOCATION.PIVOT;
    }
    return ALLOCATION.STANDARD;
  },

  /**
   * Record a BBJ contribution from a completed hand
   */
  async recordContribution(params: {
    poolId: string;
    handId: string;
    tableId: string;
    bigBlind: number;
    currentMainBalance: number;
    clubId?: string;
    handNumber?: number;
    stakesTier?: string;
    /** Pre-calculated BBJ drop from RakeService tier chart (preferred over flat 0.5×BB) */
    bbjDrop?: number;
  }): Promise<BBJContribution | null> {
    // Use pre-calculated tier-based BBJ drop from RakeService when available,
    // fallback to flat 0.5×BB for backward compatibility
    const contribution = params.bbjDrop ?? this.calculateContribution(params.bigBlind);

    // Determine stakes tier from big blind
    const stakesTier =
      params.stakesTier ||
      (params.bigBlind <= 100
        ? 'micro'
        : params.bigBlind <= 500
          ? 'low'
          : params.bigBlind <= 2000
            ? 'mid'
            : 'high');

    // Get club_id from table if not provided
    let clubId = params.clubId;
    if (!clubId) {
      const { data: tableData } = await supabase
        .from('tables')
        .select('club_id')
        .eq('id', params.tableId)
        .maybeSingle();
      clubId = tableData?.club_id || '';
    }

    // Apply allocation ratios based on current pool size
    const ratios = this.getAllocationRatios(params.currentMainBalance);
    // Integer-cents arithmetic to prevent float precision loss
    const contributionScaled = Math.trunc(contribution * 100);
    const mainScaled = Math.trunc(contributionScaled * ratios.MAIN);
    const backupScaled = Math.trunc(contributionScaled * ratios.BACKUP);
    const promoScaled = contributionScaled - mainScaled - backupScaled; // remainder guarantees sum === total
    const mainPortion = mainScaled / 100;
    const backupPortion = backupScaled / 100;
    const promoPortion = promoScaled / 100;

    // Call RPC to atomically update pool and record contribution
    // add_bbj_contribution now supports triple-bank allocation (MAIN/BACKUP/PROMO)
    const { data, error } = await retryAsync(
      () =>
        supabase.rpc('add_bbj_contribution', {
          p_table_id: params.tableId,
          p_club_id: clubId,
          p_amount: contribution,
          p_big_blind: params.bigBlind,
          p_hand_number: params.handNumber || 0,
          p_stakes_tier: stakesTier,
          p_main_portion: mainPortion,
          p_backup_portion: backupPortion,
          p_promo_portion: promoPortion,
        }),
      3
    );

    if (error) {
      reportError(error, 'BBJService.recordContribution');
      // P2-19: Raise CRITICAL alert — money was deducted from pot but never recorded in BBJ pool
      try {
        const { FinancialAlertService } = await import('./FinancialAlertService');
        await FinancialAlertService.logCritical(
          'BBJService.recordContribution',
          `BBJ contribution recording FAILED — ${contribution} chips deducted from pot but not credited to pool`,
          {
            poolId: params.poolId,
            handId: params.handId,
            tableId: params.tableId,
            clubId: clubId,
            contribution,
            mainPortion,
            backupPortion,
            promoPortion,
            bigBlind: params.bigBlind,
            error: error.message,
          }
        );
      } catch (alertErr: unknown) {
        console.warn('[BBJService] FinancialAlertService logging also failed:', alertErr);
      }
      return null;
    }

    return data;
  },

  /**
   * Check if a hand result triggers a BBJ
   *
   * TRIGGER CONDITIONS:
   * 1. Losing hand must be Quad 2s or better (FOUR_OF_A_KIND minimum)
   * 2. Winning hand must beat a qualifying hand
   * 3. Both players must use both hole cards (Omaha rule check)
   * 4. Variant must not be excluded (PLO6, OFC)
   */
  checkBBJTrigger(
    losingHand: EvaluatedHand,
    winningHand: EvaluatedHand,
    variant: GameVariant
  ): BBJTriggerResult {
    // Check variant exclusion
    if (BBJ_EXCLUDED_VARIANTS.includes(variant)) {
      return {
        triggered: false,
        reason: `BBJ not available for ${variant.toUpperCase()}`,
      };
    }

    // Check if losing hand qualifies (Quad 2s or better)
    if (losingHand.ranking < BBJ_MINIMUM_RANKING) {
      return {
        triggered: false,
        reason: 'Losing hand does not qualify (requires Quad 2s or better)',
      };
    }

    // Verify winning hand actually beats losing hand
    if (winningHand.ranking <= losingHand.ranking) {
      // If same ranking, need to check kickers
      if (winningHand.ranking === losingHand.ranking) {
        const kickerComparison = this.compareKickers(winningHand.kickers, losingHand.kickers);
        if (kickerComparison <= 0) {
          return {
            triggered: false,
            reason: 'Winning hand does not beat losing hand',
          };
        }
      } else {
        return {
          triggered: false,
          reason: 'Winning hand does not beat losing hand',
        };
      }
    }

    // BBJ TRIGGERED!
    return {
      triggered: true,
      losingHand: losingHand.name,
      winningHand: winningHand.name,
    };
  },

  /**
   * Compare kicker arrays (higher is better)
   * Only compare overlapping kickers, longer array wins
   */
  compareKickers(a: number[], b: number[]): number {
    // Compare only the kickers that exist in both arrays
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        return a[i] - b[i];
      }
    }
    // If all common kickers match, longer array (more kickers) wins
    return a.length - b.length;
  },

  /**
   * Execute BBJ payout
   *
   * DISTRIBUTION:
   * - 50% to "loser" (holder of the beaten qualifying hand — bad beat victim)
   * - 25% to "winner" (holder of the hand that beat the qualifier)
   * - 25% split among all dealt-in players at the table
   */
  async executePayout(params: BBJPayoutParams): Promise<BBJPayout | null> {
    // RAKE-AUDIT 2026-07-24: DEPRECATED / DEAD PATH — BBJ payouts are
    // SERVER-AUTHORITATIVE (ServerTableEngine → processBBJPayout →
    // bbj_atomic_payout, which locks the pool, dedupes per hand, rolls the
    // backup bank into main, records bbj_payouts + bbj_winners, and credits
    // stacks). This client path could NEVER succeed anyway: it passed
    // p_dealt_in_player_ids, which award_bbj's signature does not accept
    // (PostgREST function-resolution error), and award_bbj is REVOKEd from
    // authenticated/anon (service_role only). Running two independent payout
    // paths with different idempotency keys risks paying the same hand twice,
    // so the client path refuses immediately. The old body was removed.
    reportError(
      `BBJService.executePayout is deprecated (pool ${params.poolId}) — BBJ payouts are server-authoritative (bbj_atomic_payout)`,
      'BBJService.executePayout.deprecated'
    );
    return null;
  },

  /**
   * Get BBJ history for a pool
   */
  async getPayoutHistory(poolId: string, limit: number = 10): Promise<BBJPayout[]> {
    const { data, error } = await supabase
      .from('bbj_payouts')
      .select(
        'id, pool_id, hand_id, winner_user_id, loser_user_id, table_players_share:table_share, winner_share, loser_share, table_share, total_amount, created_at'
      )
      .eq('pool_id', poolId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      reportError(error, 'BBJService.getPayoutHistory');
      return [];
    }

    return data || [];
  },

  /**
   * Manually trigger a promo payout (rain event, high hand, etc.)
   * Requires admin authorization
   */
  async executePromoPayout(params: {
    poolId: string;
    amount: number;
    recipientUserIds: string[];
    reason: string;
  }): Promise<boolean> {
    // Guard: no recipients = nothing to distribute
    if (params.recipientUserIds.length === 0) {
      reportError('No recipients for promo payout', 'BBJService.executePromoPayout.noRecipients');
      return true;
    }

    // Atomic: deduct from the BBJ promo pool AND credit every recipient
    // (integer-cents split, remainder to the first recipient) in ONE transaction.
    // The old flow deducted the pool first and then credited recipients in a JS
    // loop — a partial loop failure stranded chips (deducted, never distributed).
    // Any failure now rolls the whole payout back.
    const { data: result, error: payoutError } = await retryAsync(
      () =>
        supabase.rpc('fn_bbj_promo_payout_atomic', {
          p_pool_id: params.poolId,
          p_amount: params.amount,
          p_recipient_user_ids: params.recipientUserIds,
          p_reason: params.reason,
          p_event_type: 'custom',
        }),
      3
    );

    if (payoutError || !result?.success) {
      reportError(
        payoutError || new Error(result?.error || 'promo payout failed'),
        'BBJService.executePromoPayout'
      );
      return false;
    }

    // Notify each recipient's UI that their PROMO balance changed.
    for (const userId of params.recipientUserIds) {
      masterBus.emit('BALANCE_UPDATED', { source: 'bbj_promo_payout', userId });
    }

    return true;
  },
};

export default BBJService;
