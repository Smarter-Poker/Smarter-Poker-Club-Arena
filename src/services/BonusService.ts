/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BONUS SERVICE — Daily & Special Bonuses
 * Handles daily login bonuses, special promotions, and rewards
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
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

// AUDIT M18: the 7-day reward schedule used to live here as a client constant.
// It now lives in public.daily_bonus_rewards and arrives via
// fn_daily_bonus_status, because three different copies of it had already
// drifted apart: this constant, BonusPage's hardcoded `day * 10` chips, and the
// old claim_daily_bonus RPC's `p_amount DEFAULT 100`. The client must never
// decide what a bonus pays.
interface DailyScheduleEntry {
  day: number;
  reward: number;
  reward_type: 'chips' | 'vip_points';
}

interface DailyBonusStatusRpc {
  streak: number;
  last_claim: string | null;
  can_claim: boolean;
  next_day: number;
  schedule: DailyScheduleEntry[];
}

interface ClaimDailyBonusRpc {
  ok: boolean;
  reason?: string;
  day?: number;
  streak?: number;
  amount?: number;
  reward_type?: 'chips' | 'vip_points';
}

interface ClaimSpecialBonusRpc {
  ok: boolean;
  reason?: string;
  amount?: number;
  reward_type?: 'chips' | 'vip_points';
}

// Reasons fn_claim_special_bonus / fn_claim_daily_bonus return for an ordinary
// refusal, mapped to something a player can act on. An unmapped reason is a
// contract change and should read as one rather than as a generic failure.
const CLAIM_REASON_TEXT: Record<string, string> = {
  not_found: 'That bonus is no longer available',
  already_claimed: 'Bonus already claimed',
  already_claimed_today: 'Daily bonus already claimed today',
  expired: 'That bonus has expired',
  requirements_not_met: 'Bonus requirements not met',
  non_positive_reward: 'That bonus has no reward to pay',
};

function claimReasonText(reason: string | undefined): string {
  return CLAIM_REASON_TEXT[reason ?? ''] ?? `Bonus could not be claimed (${reason ?? 'unknown'})`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class BonusServiceClass {
  /**
   * Get user's bonus status
   */
  async getBonusStatus(userId: string): Promise<BonusStatus> {
    // AUDIT M18: the daily half comes from fn_daily_bonus_status, which returns
    // the streak, whether a claim is available, the ladder position that would
    // pay next, and the live reward schedule. Reading `user_bonuses` directly
    // here was half the problem: the table is SELECT-own-only and nothing
    // client-side could ever write it, so the streak never moved, and the
    // amounts shown came from a constant that no payout path consulted.
    const { data: dailyRaw, error: dailyErr } = await supabase.rpc('fn_daily_bonus_status');

    if (dailyErr) {
      reportError(dailyErr, 'BonusService.getBonusStatus.fn_daily_bonus_status', { userId });
      throw new Error('Could not load daily bonus status');
    }

    const daily = dailyRaw as DailyBonusStatusRpc | null;
    const schedule = daily?.schedule ?? [];
    const streak = daily?.streak ?? 0;
    const currentDay = daily?.next_day ?? 1;
    const canClaimDaily = daily?.can_claim ?? false;

    // A day is shown as claimed when it sits behind the current position in the
    // active 7-day cycle. `next_day` is 1-based, so the completed count is
    // next_day - 1 while a claim is still available today, and next_day - 1 is
    // likewise correct once today's claim is spent, because next_day has
    // already advanced past it.
    const completedInCycle = Math.max(0, currentDay - 1);

    const dailyBonuses: DailyBonus[] = schedule.map((entry) => ({
      day: entry.day,
      claimed: entry.day <= completedInCycle,
      reward: entry.reward,
      rewardType: entry.reward_type,
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
      streak,
    };
  }

  /**
   * Claim daily bonus
   */
  async claimDailyBonus(userId: string): Promise<{
    success: boolean;
    reward: number;
    rewardType: string;
    day: number;
    streak: number;
  }> {
    // AUDIT M18: one round trip that owns the whole claim — the once-per-UTC-day
    // guard, the streak arithmetic, the payout lookup and the credit, in one
    // transaction. The old shape made two independent calls (claim_daily_bonus,
    // then a separate client-side credit), which was broken four ways at once:
    // the RPC was never granted to `authenticated`; its return shape had no
    // `claimed` or `new_streak` field for the client to read; it stamped
    // profiles.last_login_date while the UI read user_bonuses.daily_streak; and
    // it credited internally AND expected the client to credit again, so an
    // unblocked version would have paid every daily bonus twice.
    //
    // No amount is sent. The server decides what a bonus pays; the client is
    // told what was paid.
    const { data: claimRaw, error } = await retryAsync(
      () => supabase.rpc('fn_claim_daily_bonus'),
      3
    );

    if (error) {
      reportError(error, 'BonusService.claimDailyBonus.fn_claim_daily_bonus', { userId });
      throw new Error('Failed to claim bonus');
    }

    const claim = claimRaw as ClaimDailyBonusRpc | null;

    if (!claim?.ok) {
      // A refusal is a business outcome, not a fault: surface the server's own
      // reason rather than a guess, so "already claimed today" cannot be
      // reported as an infrastructure error (or vice versa).
      throw new Error(claimReasonText(claim?.reason));
    }

    masterBus.emit('BALANCE_UPDATED', {
      source: claim.reward_type === 'vip_points' ? 'bonus_vip_points' : 'bonus_chips',
      userId,
    });

    return {
      success: true,
      reward: claim.amount ?? 0,
      rewardType: claim.reward_type ?? 'chips',
      day: claim.day ?? 1,
      streak: claim.streak ?? 0,
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
      console.warn('[BonusService] Login streak lookup failed - defaulting to 1:', e);
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
    // AUDIT M17: the eligibility checks, the claim and the payout all happen
    // inside fn_claim_special_bonus, in one transaction. Doing them here was
    // not merely racy, it was inert: special_bonuses is SELECT-own-only, so the
    // client's "mark as claimed" UPDATE matched zero rows — and PostgREST
    // reports no error for a zero-row write, so this method returned true and
    // the UI said the bonus was claimed while nothing at all had happened.
    //
    // The amount is never sent. It is read server-side from the bonus row,
    // which a player cannot write; that is the only reason the function is
    // allowed to be SECURITY DEFINER.
    const { data: claimRaw, error } = await retryAsync(
      () => supabase.rpc('fn_claim_special_bonus', { p_bonus_id: bonusId }),
      3
    );

    if (error) {
      reportError(error, 'BonusService.claimSpecialBonus.fn_claim_special_bonus', {
        userId,
        bonusId,
      });
      throw new Error('Failed to claim bonus');
    }

    const claim = claimRaw as ClaimSpecialBonusRpc | null;

    if (!claim?.ok) {
      throw new Error(claimReasonText(claim?.reason));
    }

    masterBus.emit('BALANCE_UPDATED', {
      source: claim.reward_type === 'vip_points' ? 'bonus_vip_points' : 'bonus_chips',
      userId,
    });

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

  // AUDIT M17/M18: `awardReward` was removed, not repaired. It was the client's
  // own credit path, and neither branch could ever succeed from a browser:
  // `atomic_credit_wallet_and_log` is SECURITY INVOKER and dies on the wallets
  // RLS policy (42501), and `add_vip_points` is granted to postgres and
  // service_role only, so it dies on the function grant (42501). Both callers
  // now claim through a SECURITY DEFINER RPC that pays as part of the same
  // transaction that consumes the bonus, so there is no second leg to award and
  // nothing left for this method to do. Do not reintroduce a client-side
  // credit helper: a browser-callable "credit this user N chips" is a mint.
}

// Export singleton
export const bonusService = new BonusServiceClass();
