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

/**
 * THE DIAMOND ARENA IS DIAMONDS ONLY. NO CHIPS, EVER. (Dan, 2026-09-13.)
 * Nothing in this shape is a chip, and nothing in the wallet may draw one for
 * the arena. tests/the-diamond-arena-is-diamonds-only.law.test.ts pins it.
 */
export interface DiamondArenaInfo {
  clubId: string;
  name: string;
  slug: string | null;
  cashGamesEnabled: boolean;
  tournamentsEnabled: boolean;
}

/** One read of the diamond wallet: `fn_diamond_wallet_summary`. */
export interface DiamondWalletSummary {
  /** profiles.diamonds - custody is already outside it. */
  onHand: number;
  /** Purchased diamonds inside the refund window; cannot be sent. */
  collateral: number;
  /** on_hand - collateral: what send_wallet_diamond_transfer will allow. */
  sendable: number;
  /** Open poker_diamond_custody balance: at a seat or in a tournament entry. */
  inArena: number;
  arenaSeats: number;
  arenaEntries: number;
  /** null if the platform diamonds club is not configured. */
  arena: DiamondArenaInfo | null;
  lifetimeEarned: number;
  lifetimeSpent: number;
  readAt: string;
}

export interface DiamondLifetimeStats {
  lifetimeEarned: number;
  lifetimeSpent: number;
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

    /*
     * The two `wallet_transactions` reads that used to follow are gone.
     * They filtered `category IN (diamond_purchase, diamond_reward,
     * diamond_refund)` and `(diamond_deduction, vip_purchase, mint)`; five of
     * those six values are rejected by `wallet_transactions_category_check`,
     * so the sums were zero by construction - and every caller of this
     * method (the wallet store, the profile page, the diamond modal, the
     * club home) reads only `.balance`. Two dead round trips on every
     * balance load, on a call the store's own comment names as part of the
     * 85-request mount storm. Lifetime figures now come from the ledger that
     * actually records diamonds, via `getLifetimeStats`, and only when a
     * surface asks for them.
     */
    return {
      balance: balance || 0,
      lifetimeEarned: 0,
      lifetimeSpent: 0,
    };
  },

  /**
   * Lifetime earned / spent, summed IN SQL over the whole `diamond_transactions`
   * ledger by `fn_diamond_lifetime_totals` (migration 20260913171905,
   * SECURITY INVOKER so RLS still scopes it to the caller).
   *
   * Until 2026-09-13 this read up to 5,000 rows into the browser and added them
   * up here, and a failed read returned `{ 0, 0 }` - a figure indistinguishable
   * from a brand-new account, presented as a lifetime. CLAUDE.md 10.86: "I could
   * not tell" is its own outcome. So a failed read now returns `null`, and the
   * surface says Unavailable and offers a retry instead of printing a zero.
   */
  async getLifetimeStats(userId: string): Promise<DiamondLifetimeStats | null> {
    try {
      const { data, error } = await supabase.rpc('fn_diamond_lifetime_totals', {
        p_user_id: userId,
      });
      if (error) throw error;
      // RETURNS TABLE: one row, or none if the function somehow yields nothing.
      const row = (Array.isArray(data) ? data[0] : data) as
        | { lifetime_earned: number | string; lifetime_spent: number | string }
        | undefined;
      if (!row) throw new Error('fn_diamond_lifetime_totals returned no row');
      const lifetimeEarned = Number(row.lifetime_earned);
      const lifetimeSpent = Number(row.lifetime_spent);
      if (!Number.isFinite(lifetimeEarned) || !Number.isFinite(lifetimeSpent)) {
        throw new Error('fn_diamond_lifetime_totals returned a non-numeric total');
      }
      return { lifetimeEarned, lifetimeSpent };
    } catch (err) {
      reportError(err, 'DiamondService.getLifetimeStats', { userId });
      return null;
    }
  },

  /**
   * The whole diamond picture in one RPC, own-user only (the function pins
   * the caller to auth.uid()). `null` means the read failed: the surface says
   * Unavailable and offers a retry rather than printing zeros (10.86).
   */
  async getWalletSummary(): Promise<DiamondWalletSummary | null> {
    try {
      const { data, error } = await supabase.rpc('fn_diamond_wallet_summary');
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
      if (!row || typeof row !== 'object') {
        throw new Error('fn_diamond_wallet_summary returned nothing');
      }
      const num = (v: unknown) => {
        const n = Number(v);
        if (!Number.isFinite(n)) {
          throw new Error('fn_diamond_wallet_summary returned a non-numeric figure');
        }
        return n;
      };
      const arenaRaw = row.arena as Record<string, unknown> | null | undefined;
      const arena: DiamondArenaInfo | null =
        arenaRaw && typeof arenaRaw === 'object' && typeof arenaRaw.club_id === 'string'
          ? {
              clubId: arenaRaw.club_id,
              name: String(arenaRaw.name || 'Diamond Arena'),
              slug: typeof arenaRaw.slug === 'string' ? arenaRaw.slug : null,
              cashGamesEnabled: arenaRaw.cash_games_enabled === true,
              tournamentsEnabled: arenaRaw.tournaments_enabled === true,
            }
          : null;
      return {
        onHand: num(row.on_hand),
        collateral: num(row.collateral),
        sendable: num(row.sendable),
        inArena: num(row.in_arena),
        arenaSeats: num(row.arena_seats),
        arenaEntries: num(row.arena_entries),
        arena,
        lifetimeEarned: num(row.lifetime_earned),
        lifetimeSpent: num(row.lifetime_spent),
        readAt: String(row.read_at || ''),
      };
    } catch (err) {
      reportError(err, 'DiamondService.getWalletSummary');
      return null;
    }
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
   * There is NO development fallback (removed 2026-09-08): a credit without a
   * payment is not a feature to keep around.
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

    // ── NO OTHER PATH (2026-09-08, store readiness phase 3) ─────────────────
    // This used to fall through to `fn_add_diamonds`, a "development
    // fallback" that credited the package with no payment at all. It was
    // never reachable from a browser (the function is executable by
    // service_role only - checked against production) and this method has no
    // caller, but a credit path that exists in client code is a credit path
    // someone will call one day. A purchase is a store receipt (the app) or a
    // Stripe Checkout session (the web), and nothing else.
    return {
      success: false,
      error: 'Purchases Are Made Through The Store Or Stripe Checkout.',
    };
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
