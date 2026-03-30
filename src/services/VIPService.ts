/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  VIP SERVICE — Membership Check & Feature Gating
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * VIP Model:
 * - Gold VIP = Included with Club Arena monthly membership (external)
 * - Non-VIP = Pay diamonds per-use for each feature
 * - VIP users can buy more if they run out of monthly limits
 */

import { supabase } from '../lib/supabase';
import { retryAsync } from '../utils/retryAsync';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface VIPStatus {
  isVIP: boolean;
  expiresAt: Date | null;
  monthlyLimits: VIPMonthlyLimits;
}

export interface VIPMonthlyLimits {
  rabbitHunts: { used: number; limit: number };
  timeBankSeconds: { used: number; limit: number };
  emojis: { used: number; limit: number };
  tags: { used: number; limit: number };
}

export interface FeatureAccess {
  hasAccess: boolean;
  isVIP: boolean;
  needsPurchase: boolean;
  diamondCost?: number;
  usageType?: 'per_use' | 'per_session' | 'permanent';
}

export type VIPFeature =
  | 'rabbit_hunt'
  | 'show_stack_bb'
  | 'offline_protection'
  | 'auto_time_bank'
  | 'time_bank_seconds'
  | 'throwable'
  | 'theme_unlock'
  | 'club_creation'
  | 'emoji_pack'
  | 'tag_pack';

// ═══════════════════════════════════════════════════════════════════════════════
// VIP GOLD LIMITS (Monthly)
// ═══════════════════════════════════════════════════════════════════════════════

export const VIP_GOLD_LIMITS = {
  rabbitHunts: Infinity, // Unlimited rabbit hunts
  showStackBB: true, // Always available
  offlineProtection: true, // Always available
  autoTimeBank: true, // Always available
  timeBankSeconds: 120, // 120 seconds free per month
  themes: 3, // 3 themes unlocked
  clubCreation: 3, // Can create 3 clubs
  emojis: 1200, // 1200 free emojis
  tags: 1000, // 1000 player tags
  leaderboardBoost: 0.06, // 6% score boost
};

// ═══════════════════════════════════════════════════════════════════════════════
// DIAMOND PRICING (For non-VIP / VIP top-up)
// ═══════════════════════════════════════════════════════════════════════════════

export const FEATURE_PRICING: Record<
  VIPFeature,
  {
    cost: number;
    usageType: 'per_use' | 'per_session' | 'permanent';
    description: string;
  }
> = {
  rabbit_hunt: { cost: 5, usageType: 'per_use', description: 'See what cards would have come' },
  show_stack_bb: {
    cost: 0,
    usageType: 'per_session',
    description: 'Display stack in big blinds (FREE)',
  },
  offline_protection: {
    cost: 0,
    usageType: 'per_session',
    description: '1 free per session, VIP unlimited',
  },
  auto_time_bank: {
    cost: 5,
    usageType: 'per_use',
    description: 'Auto time bank (diamonds per activation)',
  },
  time_bank_seconds: { cost: 5, usageType: 'per_use', description: 'Extra time bank extension' },
  throwable: { cost: 1, usageType: 'per_use', description: 'Throw item at table' },
  theme_unlock: { cost: 25, usageType: 'permanent', description: 'Unlock table theme' },
  club_creation: { cost: 0, usageType: 'permanent', description: 'Create club (FREE)' },
  emoji_pack: { cost: 1, usageType: 'permanent', description: 'Unlock 50 emojis' },
  tag_pack: { cost: 1, usageType: 'per_use', description: 'Player tag' },
};

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class VIPServiceClass {
  /**
   * Check if user has VIP (Gold) membership
   * VIP status comes from Club Arena subscription (stored in profiles or external check)
   */
  async checkVIPStatus(userId: string): Promise<VIPStatus> {
    const { data, error } = await supabase
      .from('profiles')
      .select('is_vip, vip_expires_at')
      .eq('id', userId)
      .maybeSingle();

    if (error || !data) {
      return {
        isVIP: false,
        expiresAt: null,
        monthlyLimits: this.getEmptyLimits(),
      };
    }

    const isVIP =
      data.is_vip && (!data.vip_expires_at || new Date(data.vip_expires_at) > new Date());

    if (!isVIP) {
      return {
        isVIP: false,
        expiresAt: null,
        monthlyLimits: this.getEmptyLimits(),
      };
    }

    // Get monthly usage for VIP user
    const limits = await this.getMonthlyUsage(userId);

    return {
      isVIP: true,
      expiresAt: data.vip_expires_at ? new Date(data.vip_expires_at) : null,
      monthlyLimits: limits,
    };
  }

  /**
   * Check if user is VIP (simple boolean check)
   */
  async isVIP(userId: string): Promise<boolean> {
    const status = await this.checkVIPStatus(userId);
    return status.isVIP;
  }

  /**
   * Check if user can access a feature (VIP or needs to pay)
   */
  async checkFeatureAccess(userId: string, feature: VIPFeature): Promise<FeatureAccess> {
    const status = await this.checkVIPStatus(userId);
    const pricing = FEATURE_PRICING[feature];

    if (status.isVIP) {
      // VIP user - check if they have remaining quota
      const hasQuota = await this.checkVIPQuota(userId, feature);

      if (hasQuota) {
        return { hasAccess: true, isVIP: true, needsPurchase: false };
      }

      // VIP but out of quota - can top up with diamonds
      return {
        hasAccess: false,
        isVIP: true,
        needsPurchase: true,
        diamondCost: pricing.cost,
        usageType: pricing.usageType,
      };
    }

    // Non-VIP - check for existing purchase
    const hasPurchase = await this.checkExistingPurchase(userId, feature);

    if (hasPurchase) {
      return { hasAccess: true, isVIP: false, needsPurchase: false };
    }

    // Needs to buy
    return {
      hasAccess: false,
      isVIP: false,
      needsPurchase: true,
      diamondCost: pricing.cost,
      usageType: pricing.usageType,
    };
  }

  /**
   * Use a feature (charge diamonds if needed)
   * Returns true if successful, false if insufficient funds
   */
  async useFeature(
    userId: string,
    feature: VIPFeature
  ): Promise<{ success: boolean; charged: number }> {
    const access = await this.checkFeatureAccess(userId, feature);

    if (access.hasAccess) {
      // Free access - consume quota if VIP
      if (access.isVIP) {
        await this.consumeVIPQuota(userId, feature);
      } else {
        await this.consumePurchase(userId, feature);
      }
      return { success: true, charged: 0 };
    }

    // Need to purchase
    return await this.purchaseFeature(userId, feature);
  }

  /**
   * Purchase feature access with diamonds
   */
  async purchaseFeature(
    userId: string,
    feature: VIPFeature,
    quantity: number = 1
  ): Promise<{ success: boolean; charged: number; error?: string }> {
    const { data, error } = await supabase.rpc('fn_purchase_feature', {
      p_user_id: userId,
      p_feature: feature,
      p_quantity: quantity,
    });

    if (error) {
      return { success: false, charged: 0, error: error.message };
    }

    if (!data || !data.success) {
      return { success: false, charged: 0, error: data?.error || 'Purchase failed' };
    }

    return { success: true, charged: data.cost || 0 };
  }

  /**
   * Get current monthly usage for VIP user
   */
  private async getMonthlyUsage(userId: string): Promise<VIPMonthlyLimits> {
    try {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const { data, error } = await supabase
        .from('vip_monthly_usage')
        .select('feature, usage_count')
        .eq('user_id', userId)
        .gte('period_start', startOfMonth.toISOString());
      if (error) console.warn('[VIPService] getMonthlyUsage error:', error.message);

      const usage: Record<string, number> = {};
      (data || []).forEach((row) => {
        usage[row.feature] = row.usage_count;
      });

      return {
        rabbitHunts: { used: usage['rabbit_hunt'] || 0, limit: VIP_GOLD_LIMITS.rabbitHunts },
        timeBankSeconds: {
          used: usage['time_bank_seconds'] || 0,
          limit: VIP_GOLD_LIMITS.timeBankSeconds,
        },
        emojis: { used: usage['emojis'] || 0, limit: VIP_GOLD_LIMITS.emojis },
        tags: { used: usage['tags'] || 0, limit: VIP_GOLD_LIMITS.tags },
      };
    } catch (err) {
      console.warn('[VIPService] getMonthlyUsage unexpected error:', err);
      return this.getEmptyLimits();
    }
  }

  private getEmptyLimits(): VIPMonthlyLimits {
    return {
      rabbitHunts: { used: 0, limit: 0 },
      timeBankSeconds: { used: 0, limit: 0 },
      emojis: { used: 0, limit: 0 },
      tags: { used: 0, limit: 0 },
    };
  }

  /**
   * Check if VIP user has remaining quota for feature
   */
  private async checkVIPQuota(userId: string, feature: VIPFeature): Promise<boolean> {
    // Some features are unlimited for VIP
    if (
      ['rabbit_hunt', 'show_stack_bb', 'offline_protection', 'auto_time_bank'].includes(feature)
    ) {
      return true;
    }

    const limits = await this.getMonthlyUsage(userId);

    switch (feature) {
      case 'time_bank_seconds':
        return limits.timeBankSeconds.used < limits.timeBankSeconds.limit;
      default:
        return true;
    }
  }

  /**
   * Consume VIP quota
   */
  private async consumeVIPQuota(userId: string, feature: VIPFeature): Promise<void> {
    try {
      // ATOMIC: Use single RPC call to both create/find the record AND increment.
      // Previous 2-step approach (upsert + separate increment) had a race condition
      // where concurrent calls could both set usage_count=1 then both increment,
      // resulting in count=2 instead of count=2 from separate increments.
      const { error: rpcErr } = await retryAsync(
        () =>
          supabase.rpc('fn_increment_vip_usage', {
            p_user_id: userId,
            p_feature: feature,
          }),
        3
      );
      if (rpcErr) {
        // If the RPC fails (e.g., row doesn't exist yet), fall back to upsert
        console.warn('[VIPService] fn_increment_vip_usage error, falling back to upsert:', rpcErr.message);
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        const { error: upsertErr } = await supabase.from('vip_monthly_usage').upsert(
          {
            user_id: userId,
            feature,
            period_start: startOfMonth.toISOString(),
            usage_count: 1,
          },
          {
            onConflict: 'user_id,feature,period_start',
            ignoreDuplicates: false,
          }
        );
        if (upsertErr) reportError(upsertErr, 'VIPService.upsertQuota');
      }
    } catch (err) {
      console.warn('[VIPService] consumeVIPQuota unexpected error:', err);
    }
  }

  /**
   * Check for existing a-la-carte purchase
   */
  private async checkExistingPurchase(userId: string, feature: VIPFeature): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('feature_purchases')
        .select('id, uses_remaining, expires_at')
        .eq('user_id', userId)
        .eq('feature', feature)
        .or('expires_at.is.null,expires_at.gt.now()')
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) console.debug('[VIPService] checkExistingPurchase:', error.message);

      if (!data || data.length === 0) return false;

      const purchase = data[0];

      // Per-use: check remaining uses
      if (purchase.uses_remaining !== null) {
        return purchase.uses_remaining > 0;
      }

      // Session/permanent: just needs to exist and not expired
      return true;
    } catch (err) {
      console.warn('[VIPService] checkExistingPurchase unexpected error:', err);
      return false;
    }
  }

  /**
   * Consume one use of a purchase
   */
  private async consumePurchase(userId: string, feature: VIPFeature): Promise<void> {
    try {
      const { error } = await retryAsync(
        () =>
          supabase.rpc('fn_consume_feature_use', {
            p_user_id: userId,
            p_feature: feature,
          }),
        3
      );
      if (error) console.warn('[VIPService] fn_consume_feature_use error:', error.message);
    } catch (err) {
      console.warn('[VIPService] consumePurchase unexpected error:', err);
    }
  }

  /**
   * Get feature pricing for display
   */
  getFeaturePricing(feature: VIPFeature) {
    return FEATURE_PRICING[feature];
  }

  /**
   * Get all feature pricing
   */
  getAllPricing() {
    return FEATURE_PRICING;
  }

  /**
   * Get VIP Gold benefits for display
   */
  getGoldBenefits() {
    return VIP_GOLD_LIMITS;
  }
}

// Export singleton
export const vipService = new VIPServiceClass();
