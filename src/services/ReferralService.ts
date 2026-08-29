/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  REFERRAL SERVICE — Referral code generation, redemption, and milestones
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';

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
      const { data: existing, error: existingErr } = await supabase
        .from('referral_codes')
        .select('id, code, uses, max_uses')
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle();

      /* A FAILED LOOKUP IS NOT "NO CODE YET" (2026-08-29). Only `data` was
         destructured; a Supabase builder resolves with {data: null, error}. A
         failed read therefore minted a SECOND referral code for a player who
         already had one -- and a player whose code changes has just lost every
         link they have already shared. */
      if (existingErr) throw existingErr;

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
        reportError(error?.message || 'No data returned', 'ReferralService.Failed_to_create_code');
        return null;
      }

      return {
        id: data.id,
        code: data.code,
        uses: data.uses,
        maxUses: data.max_uses,
      };
    } catch (err: unknown) {
      reportError(err, 'ReferralService.getOrCreateCode_exception');
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
        reportError(error, 'ReferralService.redeemCode_RPC_error');
        return { success: false, error: error.message };
      }

      if (!data?.success) {
        return { success: false, error: data?.error || 'Redemption failed' };
      }

      // Emit bus event for real-time UI updates
      masterBus.emit('BALANCE_UPDATED', { source: 'referral_redemption', userId: refereeId });

      return { success: true };
    } catch (err: any) {
      reportError(err, 'ReferralService.redeemCode_exception');
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
        .limit(QUERY_LIMITS.BULK);

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
      reportError(err, 'ReferralService.getStats_exception');
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
   * Check and award milestone bonuses.
   *
   * SWEEP #3 (2026-07-23): awards now flow through the SECURITY DEFINER
   * `fn_claim_referral_milestone` RPC, which validates the referral count and
   * dedupes claims in the DB (referral_milestone_claims PK). The old path
   * called `add_chips` directly with only a localStorage dedupe — a replayable
   * client-side credit (and add_chips is service_role-only anyway).
   * localStorage is kept purely as a call-suppression hint; the server is the
   * authority either way.
   */
  async checkMilestones(userId: string, totalReferrals: number): Promise<void> {
    const milestones = this.getMilestones(totalReferrals);
    for (const m of milestones) {
      if (m.unlocked) {
        const storageKey = `referral_milestone_${m.count}_${userId}`;
        if (typeof window !== 'undefined' && localStorage.getItem(storageKey)) continue;

        try {
          const { data, error } = await supabase.rpc('fn_claim_referral_milestone', {
            p_milestone: m.count,
          });

          if (error) {
            reportError(error, 'ReferralService.milestone_claim_rpc_failed');
            continue;
          }

          // Server says claimed (now) or already claimed (before) — either way,
          // stop re-asking from this browser.
          if (
            typeof window !== 'undefined' &&
            (data?.success || data?.error === 'milestone already claimed')
          ) {
            localStorage.setItem(storageKey, 'true');
          }

          if (data?.success) {
            masterBus.emit('BALANCE_UPDATED', { source: 'referral_milestone', userId });
          }
        } catch (err: unknown) {
          reportError(err, 'ReferralService.milestone_mcount_award_failed');
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
