/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND SERVICE — Purchase & Balance Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles diamond balance queries, top-up operations, and transaction history.
 * Diamonds are the in-app currency used for VIP features and a-la-carte purchases.
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface DiamondPackage {
  id: string;
  name: string;
  diamonds: number;
  bonusDiamonds: number;
  priceUSD: number;
  popular?: boolean;
  bestValue?: boolean;
}

export interface DiamondWallet {
  balance: number;
  lifetimeEarned: number;
  lifetimeSpent: number;
}

export interface DiamondTransaction {
  id: string;
  type: string;
  amount: number;
  description: string;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIAMOND PACKAGES — Available for purchase
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * NOT THE STOREFRONT'S PRICE LIST, AND NOT A ROUTE'S EITHER (Dan 2026-08-25).
 *
 * The packages a member can actually buy come from
 * `/api/club-arena/store-catalog`, which mirrors VALID_DIAMOND_PACKAGES in the
 * World Hub's create-checkout-session route (micro/small/medium/... at $1-$500).
 * The ids and prices below — starter/popular/value/premium/elite/whale at
 * $0.99-$49.99 — match NO route: nothing sells a "Diamond Vault". They were
 * nevertheless rendered by DiamondTopUpModal until the 2026-08-25 audit, on
 * buttons that labelled the dollar figure as diamonds.
 *
 * They survive only because `purchaseDiamonds` below still takes a package id.
 * NOTHING IN THE UI CALLS IT. Do not render these to a member: use
 * `loadStoreCatalog()` from pages/marketplace/marketplaceShared.
 */
export const DIAMOND_PACKAGES: DiamondPackage[] = [
  { id: 'starter', name: 'Starter', diamonds: 100, bonusDiamonds: 0, priceUSD: 0.99 },
  {
    id: 'popular',
    name: 'Popular',
    diamonds: 500,
    bonusDiamonds: 50,
    priceUSD: 3.99,
    popular: true,
  },
  { id: 'value', name: 'Value Pack', diamonds: 1200, bonusDiamonds: 200, priceUSD: 7.99 },
  { id: 'premium', name: 'Premium', diamonds: 3000, bonusDiamonds: 750, priceUSD: 14.99 },
  {
    id: 'elite',
    name: 'Elite Bundle',
    diamonds: 6500,
    bonusDiamonds: 2000,
    priceUSD: 24.99,
    bestValue: true,
  },
  { id: 'whale', name: 'Diamond Vault', diamonds: 15000, bonusDiamonds: 5000, priceUSD: 49.99 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const DiamondService = {
  /**
   * Get user's diamond wallet balance.
   * Source of truth: profiles.diamonds column.
   * NOTE: The wallets table constraint only allows PLAYER and BUSINESS types —
   * there is no DIAMOND wallet type, so we read directly from profiles.
   * Also computes lifetimeEarned/lifetimeSpent from wallet_transactions.
   */
  async getBalance(userId: string): Promise<DiamondWallet> {
    // Read diamond balance from profiles (the actual source of truth)
    const { data: profileData } = await supabase
      .from('profiles')
      .select('diamonds')
      .eq('id', userId)
      .maybeSingle();

    const balance = profileData?.diamonds || 0;

    // 3. Compute lifetime stats from wallet_transactions (non-blocking)
    let lifetimeEarned = 0;
    let lifetimeSpent = 0;
    try {
      const { data: earnedData } = await supabase
        .from('wallet_transactions')
        .select('amount')
        .eq('user_id', userId)
        .eq('type', 'credit')
        .in('category', ['diamond_purchase', 'diamond_reward', 'diamond_refund']);
      lifetimeEarned = (earnedData || []).reduce((sum, t) => sum + Number(t.amount || 0), 0);

      const { data: spentData } = await supabase
        .from('wallet_transactions')
        .select('amount')
        .eq('user_id', userId)
        .eq('type', 'debit')
        .in('category', ['diamond_deduction', 'vip_purchase', 'mint']);
      lifetimeSpent = (spentData || []).reduce((sum, t) => sum + Number(t.amount || 0), 0);
    } catch (err) {
      reportError(err, 'DiamondService.getBalance.lifetimeStats', { userId });
      // Non-blocking: lifetime stats are best-effort
    }

    return {
      balance: balance || 0,
      lifetimeEarned,
      lifetimeSpent,
    };
  },

  /**
   * Get transaction history
   */
  async getTransactions(userId: string, limit = 20): Promise<DiamondTransaction[]> {
    const { data, error } = await supabase
      .from('wallet_transactions')
      .select('id, type, amount, description, created_at')
      .eq('user_id', userId)
      .in('category', [
        'diamond_purchase',
        'diamond_deduction',
        'vip_purchase',
        'mint',
        'diamond_reward',
        'diamond_refund',
      ])
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data) return [];

    return data.map((t: any) => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      description: t.description,
      createdAt: t.created_at,
    }));
  },

  /**
   * Purchase diamonds with Stripe payment verification.
   *
   * PRODUCTION FLOW:
   *   1. Create Stripe PaymentIntent via Supabase edge function
   *   2. Client confirms payment (Stripe.js)
   *   3. Webhook / edge function verifies payment → credits diamonds
   *
   * DEVELOPMENT FALLBACK:
   *   Directly calls fn_add_diamonds RPC (no real Stripe in dev)
   */
  async purchaseDiamonds(
    userId: string,
    packageId: string,
    paymentMethodId?: string
  ): Promise<{ success: boolean; newBalance?: number; clientSecret?: string; error?: string }> {
    const pkg = DIAMOND_PACKAGES.find((p) => p.id === packageId);
    if (!pkg) {
      return { success: false, error: 'Invalid package' };
    }

    const totalDiamonds = pkg.diamonds + pkg.bonusDiamonds;

    // ── STRIPE FLOW: Try edge function first ──────────────────────────────
    if (paymentMethodId) {
      try {
        const { data: intentData, error: intentError } = await supabase.functions.invoke(
          'create-diamond-payment',
          {
            body: {
              userId,
              packageId,
              paymentMethodId,
              amount: pkg.priceUSD * 100, // Stripe uses cents
              currency: 'usd',
              diamonds: totalDiamonds,
              description: `${pkg.name} (${pkg.diamonds}+${pkg.bonusDiamonds} Bonus)`,
            },
          }
        );

        if (intentError) {
          reportError(intentError, 'DiamondService.purchaseDiamonds.stripe', { userId, packageId });
          return { success: false, error: 'Payment processing failed. Please try again.' };
        }

        // Edge function returns clientSecret for client-side confirmation
        // OR confirms server-side and returns the new balance
        if (intentData?.requiresAction && intentData?.clientSecret) {
          // Client needs to handle 3D Secure or other confirmation
          return { success: true, clientSecret: intentData.clientSecret };
        }

        if (intentData?.success) {
          masterBus.emit('DIAMOND_BALANCE_CHANGED', {
            newBalance: intentData.newBalance || 0,
            delta: totalDiamonds,
            source: 'stripe_purchase',
          });
          return { success: true, newBalance: intentData.newBalance };
        }

        return { success: false, error: intentData?.error || 'Payment failed' };
      } catch (stripeErr) {
        reportError(stripeErr, 'DiamondService.purchase.stripeFallback');
        // Fall through to legacy RPC
      }
    }

    // ── LEGACY / DEV FLOW: Direct RPC credit ──────────────────────────────
    const { data, error } = await supabase.rpc('fn_add_diamonds', {
      p_user_id: userId,
      p_amount: totalDiamonds,
    });

    if (error) {
      reportError(error, 'DiamondService.purchaseDiamonds.rpc', { userId, packageId });
      return { success: false, error: error.message };
    }

    if (data?.success && data?.new_balance !== undefined) {
      masterBus.emit('DIAMOND_BALANCE_CHANGED', {
        newBalance: data.new_balance,
        delta: totalDiamonds,
        source: 'purchase',
      });
    }

    /**
     * `data?.success ?? true` (Dan 2026-08-25 audit). A `null` payload with no
     * PostgREST error — which is exactly what a refusal returning nothing looks
     * like — resolved to SUCCESS with `newBalance: undefined`. The top-up modal
     * then toasted "20000 diamonds added" and set the displayed balance to 0.
     * Nothing was credited and nothing went red.
     *
     * A credit is only a credit when the RPC says so AND names the resulting
     * balance. Anything else is a refusal.
     */
    if (!data?.success || data?.new_balance === undefined) {
      return {
        success: false,
        error: (data as { error?: string } | null)?.error || 'Diamond credit was not confirmed',
      };
    }

    return { success: true, newBalance: data.new_balance };
  },

  /**
   * Verify a Stripe payment (called after 3D Secure confirmation)
   */
  async verifyPayment(
    userId: string,
    paymentIntentId: string
  ): Promise<{ success: boolean; newBalance?: number; error?: string }> {
    try {
      const { data, error } = await supabase.functions.invoke('verify-diamond-payment', {
        body: { userId, paymentIntentId },
      });

      if (error) {
        return { success: false, error: 'Payment verification failed' };
      }

      if (data?.success && data?.newBalance !== undefined) {
        masterBus.emit('DIAMOND_BALANCE_CHANGED', {
          newBalance: data.newBalance,
          delta: data.diamondsAdded || 0,
          source: 'stripe_verified',
        });
      }

      return { success: data?.success, newBalance: data?.newBalance };
    } catch (err: unknown) {
      reportError(err, 'DiamondService.verifyPayment', { userId, paymentIntentId });
      return { success: false, error: 'Verification error' };
    }
  },

  /**
   * Check if user can afford a specific cost
   */
  async canAfford(userId: string, cost: number): Promise<boolean> {
    const wallet = await this.getBalance(userId);
    return wallet.balance >= cost;
  },
};

export default DiamondService;
