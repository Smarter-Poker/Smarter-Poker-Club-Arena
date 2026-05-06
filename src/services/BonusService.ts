/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BONUS SERVICE — Daily & Special Bonuses
 * Handles daily login bonuses, special promotions, and rewards
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import { WalletService } from './WalletService';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface DailyBonus {
  day: number;
  claimed: boolean;
  reward: number;
  rewardType: 'chips' | 'vip_points';
  claimedAt?: string;
}

export interface SpecialBonus {
  id: string;
  name: string;
  description: string;
  reward: number;
  rewardType: 'chips' | 'vip_points' | 'item';
  condition: string;
  progress: number;
  target: number;
  claimed: boolean;
  expiresAt?: string;
}

export interface BonusStatus {
  dailyBonuses: DailyBonus[];
  currentDay: number;
  canClaimDaily: boolean;
  nextDailyReset: string;
  specialBonuses: SpecialBonus[];
  streak: number;
}

// Daily bonus rewards by day (7-day cycle)
const DAILY_REWARDS = [
  { day: 1, reward: 100, type: 'chips' },
  { day: 2, reward: 150, type: 'chips' },
  { day: 3, reward: 200, type: 'chips' },
  { day: 4, reward: 300, type: 'chips' },
  { day: 5, reward: 500, type: 'chips' },
  { day: 6, reward: 200, type: 'vip_points' },
  { day: 7, reward: 1000, type: 'chips' }, // Jackpot day!
];

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class BonusServiceClass {
  /**
   * Get user's bonus status
   */
  async getBonusStatus(userId: string): Promise<BonusStatus> {
    // Get user's bonus data
    const { data: bonusData } = await supabase
      .from('user_bonuses')
      .select('id, user_id, daily_streak, last_daily_claim')
      .eq('user_id', userId)
      .maybeSingle();

    const today = new Date().toISOString().split('T')[0];
    const lastClaim = bonusData?.last_daily_claim?.split('T')[0];
    const canClaimDaily = lastClaim !== today;
    const currentDay = ((bonusData?.daily_streak || 0) % 7) + 1;

    // Build daily bonuses array
    const dailyBonuses: DailyBonus[] = DAILY_REWARDS.map((r, i) => ({
      day: r.day,
      claimed: i < (bonusData?.daily_streak || 0) % 7,
      reward: r.reward,
      rewardType: r.type as DailyBonus['rewardType'],
    }));

    // Get special bonuses
    const { data: specialData } = await supabase
      .from('special_bonuses')
      .select(
        'id, name, description, reward, reward_type, condition, progress, target, claimed, expires_at'
      )
      .eq('user_id', userId)
      .eq('claimed', false)
      .gte('expires_at', new Date().toISOString());

    const specialBonuses: SpecialBonus[] = (specialData || []).map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description,
      reward: b.reward,
      rewardType: b.reward_type,
      condition: b.condition,
      progress: b.progress || 0,
      target: b.target,
      claimed: b.claimed,
      expiresAt: b.expires_at,
    }));

    // Calculate next reset (midnight UTC)
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);

    return {
      dailyBonuses,
      currentDay,
      canClaimDaily,
      nextDailyReset: tomorrow.toISOString(),
      specialBonuses,
      streak: bonusData?.daily_streak || 0,
    };
  }

  /**
   * Claim daily bonus
   */
  async claimDailyBonus(
    userId: string
  ): Promise<{ success: boolean; reward: number; rewardType: string }> {
    // Atomic claim: RPC checks last_daily_claim < today AND increments streak in one operation
    // This prevents TOCTOU double-claims from concurrent requests
    const { data: claimResult, error } = await retryAsync(
      () =>
        supabase.rpc('claim_daily_bonus', {
          p_user_id: userId,
        }),
      3
    );

    if (error) {
      reportError(error, 'BonusService.Failed_to_claim');
      throw new Error('Failed to claim bonus');
    }

    if (!claimResult?.claimed) {
      throw new Error('Daily bonus already claimed today');
    }

    // claimResult contains { claimed: true, new_streak: number }
    const currentDay = (claimResult.new_streak - 1) % 7;
    const reward = DAILY_REWARDS[currentDay];

    // Award the reward
    await this.awardReward(userId, reward.reward, reward.type);

    return {
      success: true,
      reward: reward.reward,
      rewardType: reward.type,
    };
  }

  /**
   * Check if user is eligible to spin the Lucky Wheel today
   */
  async canSpinToday(userId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('user_lucky_wheel_spins')
      .select('last_spin_date')
      .eq('user_id', userId)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      reportError(error, 'BonusService.Failed_to_check_spin_status');
      return false; // Fail safe
    }

    if (!data || !data.last_spin_date) return true;

    // Check if last spin was today UTC
    const today = new Date().toISOString().split('T')[0];
    return data.last_spin_date !== today;
  }

  /**
   * Get lifetime wheel stats and streak multiplier for a user
   */
  async getWheelStats(
    userId: string
  ): Promise<{ totalSpins: number; lastSpinDate: string | null; streakMultiplier: number }> {
    const { data, error } = await supabase
      .from('user_lucky_wheel_spins')
      .select('total_spins, last_spin_date')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data) {
      return { totalSpins: 0, lastSpinDate: null, streakMultiplier: 1 };
    }

    // Determine current global login streak (as a proxy for spin streak)
    let streakMultiplier = 1;
    let loginStreak = 1; // Default
    try {
      const { data: ud } = await supabase
        .from('user_daily_rewards')
        .select('current_streak')
        .eq('user_id', userId)
        .maybeSingle();
      if (ud) {
        loginStreak = ud.current_streak;
      }
    } catch (e: unknown) {
      console.warn('[BonusService] Login streak lookup failed — defaulting to 1:', e);
    }

    if (loginStreak >= 3 && loginStreak <= 6) {
      streakMultiplier = 1.5;
    } else if (loginStreak >= 7) {
      streakMultiplier = 2;
    }

    return {
      totalSpins: data.total_spins || 0,
      lastSpinDate: data.last_spin_date,
      streakMultiplier,
    };
  }

  /**
   * Spin Lucky Draw Wheel (Atomic + Server RNG)
   */
  async spinLuckyWheel(
    userId: string
  ): Promise<{ segmentId: string; rewardType: string; amount: number }> {
    const { data, error } = await retryAsync(
      () =>
        supabase.rpc('claim_lucky_wheel_spin', {
          p_user_id: userId,
        }),
      3
    );

    if (error) {
      reportError(error, 'BonusService.Failed_to_spin_lucky_wheel');
      if (error.message.includes('Already spun today')) {
        throw new Error('You have already spun the wheel today!');
      }
      throw new Error(`Failed to spin wheel: ${error.message}`);
    }

    if (data?.rewardType === 'chips') {
      masterBus.emit('BALANCE_UPDATED', { source: 'lucky_wheel_chips', userId });
    } else if (data?.rewardType === 'diamonds') {
      masterBus.emit('BALANCE_UPDATED', { source: 'lucky_wheel_diamonds', userId });
    }

    return data;
  }

  /**
   * Claim special bonus
   */
  async claimSpecialBonus(userId: string, bonusId: string): Promise<boolean> {
    // Check if bonus exists and is claimable
    const { data: bonus } = await supabase
      .from('special_bonuses')
      .select(
        'id, name, description, reward, reward_type, condition, progress, target, claimed, expires_at'
      )
      .eq('id', bonusId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!bonus) {
      throw new Error('Bonus not found');
    }

    if (bonus.claimed) {
      throw new Error('Bonus already claimed');
    }

    if (bonus.progress < bonus.target) {
      throw new Error('Bonus requirements not met');
    }

    // Mark as claimed — user_id filter prevents cross-user claim
    const { error: claimErr } = await supabase
      .from('special_bonuses')
      .update({ claimed: true, claimed_at: new Date().toISOString() })
      .eq('id', bonusId)
      .eq('user_id', userId)
      .eq('claimed', false); // Prevent double-claim race
    if (claimErr) throw new Error(`Claim update failed: ${claimErr.message}`);

    // Award reward
    await this.awardReward(userId, bonus.reward, bonus.reward_type);

    return true;
  }

  /**
   * Update bonus progress
   */
  async updateProgress(userId: string, bonusId: string, amount: number = 1): Promise<number> {
    // Use atomic RPC to prevent read-modify-write race on concurrent progress updates
    try {
      const { data, error } = await retryAsync(
        () =>
          supabase.rpc('increment_bonus_progress', {
            p_bonus_id: bonusId,
            p_user_id: userId,
            p_amount: amount,
          }),
        3
      );

      if (error) {
        reportError(
          new Error('[Bonus] increment_bonus_progress RPC not available - returning silently'),
          'BonusService.increment_bonus_progress_RPC_not_availab'
        );
        return 0;
      }

      return data ?? 0;
    } catch (err: unknown) {
      reportError(err, 'BonusService.Failed_to_update_progress_noncritical');
      return 0;
    }
  }

  /**
   * Award reward to user
   */
  private async awardReward(userId: string, amount: number, type: string): Promise<void> {
    const amt = Math.trunc(amount * 100) / 100;
    let error;
    switch (type) {
      case 'chips':
        // Use proper wallet system with ATOMIC audit trail
        ({ error } = await retryAsync(
          () =>
            supabase.rpc('atomic_credit_wallet_and_log', {
              p_user_id: userId,
              p_amount: amt,
              p_category: 'bonus',
              p_description: `Bonus chip reward`,
              p_table_id: null,
              p_hand_id: null,
              p_related_entity_id: null,
            }),
          3
        ));
        if (!error) {
          masterBus.emit('BALANCE_UPDATED', { source: 'bonus_chips', userId });
        }
        break;

      case 'vip_points':
        ({ error } = await retryAsync(
          () => supabase.rpc('add_vip_points', { p_user_id: userId, p_points: amt }),
          3
        ));
        if (!error) {
          masterBus.emit('BALANCE_UPDATED', { source: 'bonus_vip_points', userId });
        }
        break;
      default:
        reportError(
          new Error(`[Bonus] Unknown reward type: ${type}`),
          'BonusService.Unknown_reward_type'
        );
        return;
    }

    if (error) {
      reportError(error, 'BonusService.Failed_to_award_type_reward');
      throw new Error(`Failed to award ${type} reward`);
    }
  }
}

// Export singleton
export const bonusService = new BonusServiceClass();
