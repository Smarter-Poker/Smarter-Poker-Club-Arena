/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  REFERRAL SERVICE — Referral code generation, redemption, and milestones
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ReferralCode {
  id: string;
  code: string;
  uses: number;
  maxUses: number;
}

export interface ReferralStats {
  code: string;
  totalReferrals: number;
  totalChipsEarned: number;
}

export interface ReferralMilestone {
  count: number;
  reward: number;
  label: string;
  unlocked: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MILESTONE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

const MILESTONES: Omit<ReferralMilestone, 'unlocked'>[] = [
  { count: 5, reward: 2500, label: '5 Referrals' },
  { count: 10, reward: 5000, label: '10 Referrals' },
  { count: 25, reward: 15000, label: '25 Referrals' },
  { count: 50, reward: 50000, label: '50 Referrals' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class ReferralService {
  /**
   * Generate a unique referral code for a user (or return existing one)
   */
  async getOrCreateCode(userId: string): Promise<ReferralCode | null> {
    try {
      // Check for existing code
      const { data: existing } = await supabase
        .from('referral_codes')
        .select('id, code, uses, max_uses')
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle();

      if (existing) {
        return {
          id: existing.id,
          code: existing.code,
          uses: existing.uses,
          maxUses: existing.max_uses,
        };
      }

      // Generate a new 8-char alphanumeric code
      const code = this.generateCode();

      const { data, error } = await supabase
        .from('referral_codes')
        .insert({ user_id: userId, code })
        .select('id, code, uses, max_uses')
        .maybeSingle();

      if (error || !data) {
        console.error(
          '[ReferralService] Failed to create code:',
          error?.message || 'No data returned'
        );
        return null;
      }

      return {
        id: data.id,
        code: data.code,
        uses: data.uses,
        maxUses: data.max_uses,
      };
    } catch (err: unknown) {
      console.error('[ReferralService] getOrCreateCode exception:', err);
      return null;
    }
  }

  /**
   * Redeem a referral code (called during signup)
   */
  async redeemCode(refereeId: string, code: string): Promise<{ success: boolean; error?: string }> {
    try {
      const { data, error } = await supabase.rpc('redeem_referral_code', {
        p_referee_id: refereeId,
        p_code: code.toUpperCase().trim(),
      });

      if (error) {
        console.error('[ReferralService] redeemCode RPC error:', error);
        return { success: false, error: error.message };
      }

      if (!data?.success) {
        return { success: false, error: data?.error || 'Redemption failed' };
      }

      // Emit bus event for real-time UI updates
      masterBus.emit('BALANCE_UPDATED', { source: 'referral_redemption', userId: refereeId });

      return { success: true };
    } catch (err: any) {
      console.error('[ReferralService] redeemCode exception:', err);
      return { success: false, error: err.message || 'Redemption failed' };
    }
  }

  /**
   * Get referral stats for a user
   */
  async getStats(userId: string): Promise<ReferralStats> {
    try {
      const code = await this.getOrCreateCode(userId);

      const { data: redemptions } = await supabase
        .from('referral_redemptions')
        .select('chips_awarded_referrer')
        .eq('referrer_id', userId)
        .limit(5000);

      const totalReferrals = redemptions?.length || 0;
      const totalChipsEarned = (redemptions || []).reduce(
        (sum, r) => sum + (r.chips_awarded_referrer || 0),
        0
      );

      return {
        code: code?.code || '',
        totalReferrals,
        totalChipsEarned,
      };
    } catch (err: unknown) {
      console.error('[ReferralService] getStats exception:', err);
      return { code: '', totalReferrals: 0, totalChipsEarned: 0 };
    }
  }

  /**
   * Get milestones with unlocked status
   */
  getMilestones(totalReferrals: number): ReferralMilestone[] {
    return MILESTONES.map((m) => ({
      ...m,
      unlocked: totalReferrals >= m.count,
    }));
  }

  /**
   * Check and award milestone bonuses
   */
  async checkMilestones(userId: string, totalReferrals: number): Promise<void> {
    const milestones = this.getMilestones(totalReferrals);
    for (const m of milestones) {
      if (m.unlocked) {
        // Check if already awarded
        const storageKey = `referral_milestone_${m.count}_${userId}`;
        if (typeof window !== 'undefined' && localStorage.getItem(storageKey)) continue;

        // Award bonus chips
        try {
          await supabase.rpc('add_chips', {
            p_user_id: userId,
            p_amount: m.reward,
            p_reason: `Referral milestone: ${m.label}`,
          });

          if (typeof window !== 'undefined') {
            localStorage.setItem(storageKey, 'true');
          }

          masterBus.emit('BALANCE_UPDATED', { source: 'referral_milestone', userId });
        } catch (err: unknown) {
          console.error(`[ReferralService] milestone ${m.count} award failed:`, err);
        }
      }
    }
  }

  /**
   * Generate a random 8-char alphanumeric code
   */
  private generateCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I/O/0/1 to avoid confusion
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }
}

export const referralService = new ReferralService();
