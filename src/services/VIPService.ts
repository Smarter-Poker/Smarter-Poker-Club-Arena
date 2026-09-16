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
import { resolveVipStatus, type VipStatus } from '../utils/vipStatus';
import { retryAsync } from '../utils/retryAsync';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface VIPStatus {
  isVIP: boolean;
  /**
   * Which membership, resolved by `utils/vipStatus`. There are exactly two,
   * plus none - Dan 2026-09-04: "THERE IS NO SUCH THING AS 'PLATINUM VIP' BTW.
   * JUST VIP, AND LIFETIME VIP."
   */
  status: VipStatus;
  /** Null for a lifetime membership: it does not expire, so it has no date. */
  expiresAt: Date | null;
  monthlyLimits: VIPMonthlyLimits;
}

export interface VIPMonthlyLimits {
  /**
   * Throwables are metered in their OWN table, `throw_usage`, one row per
   * throw - not in `vip_feature_usage_monthly` like the other four. That is
   * why getMonthlyUsage reads two sources.
   */
  throwables: { used: number; limit: number };
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
// WHAT A VIP ACTUALLY GETS (MONTHLY)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * EVERY NUMBER HERE IS ONE THE SERVER ENFORCES. NOTHING ELSE BELONGS IN IT.
 *
 * Renamed from `VIP_GOLD_LIMITS` on 2026-09-05. There is no Gold. Dan, verbatim
 * on 2026-09-04: "THERE IS NO SUCH THING AS 'PLATINUM VIP' BTW. JUST VIP, AND
 * LIFETIME VIP." The name was the last survivor of a six-rung ladder
 * (bronze / silver / gold / platinum / diamond / royal) that lived in
 * src/constants/vipTiers.ts and was deleted with it.
 *
 * Three entries were removed at the same time because nothing on the platform
 * implemented them, checked against the live database and the engine:
 *
 *   leaderboardBoost: 0.06   LeaderboardService applies no boost of any kind.
 *                            The page advertised "+6% Score Boost" to every
 *                            member.
 *   themes: 3                Nothing reads it. `theme_unlock` is not metered,
 *                            and Table Studio sells themes individually.
 *   clubCreation: 3          The real rule is fn_get_club_creation_eligibility,
 *                            which caps EVERYONE - VIP or not - at 4 club
 *                            memberships. It is not a VIP benefit and the
 *                            number was not 3.
 *
 * What is left, and where each one is actually enforced:
 *
 *   rabbitHunts 100/mo   fn_consume_rabbit_hunt (v_vip_monthly_cap = 100),
 *                        server-authoritative, charges 5 diamonds from the
 *                        101st. Dan 2026-08-25.
 *   timeBankSeconds 120  fn_time_bank_allowance returns 120 minus the month's
 *                        use, and the engine seeds the bank from it.
 *   emojis 1200/mo       counted by fn_increment_vip_usage under 'emoji_pack'.
 *   tags 1000/mo         counted by fn_increment_vip_usage under 'tag_pack'.
 *   throwables 500/mo    fn_use_throwable counts this calendar month's rows in
 *                        `throw_usage` and only charges the 1-diamond price
 *                        from the 501st. RESTORED 2026-09-05: I removed this
 *                        line the same morning on the strength of
 *                        `feature_pricing.throwable.vip_tiers_included` being
 *                        empty. That column is read by NOTHING - the
 *                        enforcement is the function, and it was there all
 *                        along. 95 throws by 5 players, every one of them free.
 *
 * The three booleans are features a non-VIP pays for per session or per use
 * (5, 10 and 5 diamonds) and a VIP does not. "Included" - never "Unlimited",
 * which is the word Dan struck: "THERE IS NOTHING UNLIMITED LIKE THROWABLES OR
 * TIME BANKS."
 */
export const VIP_MONTHLY_ALLOWANCES = {
  rabbitHunts: 100,
  timeBankSeconds: 120,
  emojis: 1200,
  tags: 1000,
  throwables: 500,
  showStackBB: true,
  offlineProtection: true,
  autoTimeBank: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// DIAMOND PRICING (For non-VIP / VIP top-up)
// ═══════════════════════════════════════════════════════════════════════════════
//
// THE SERVER IS THE PRICE. THIS TABLE IS A CACHE OF IT.
//
// `fn_purchase_feature(p_user_id, p_feature, p_cost)` IGNORES the cost the
// client passes and charges `feature_pricing.diamond_cost` instead. So every
// number printed from this table is a CLAIM about a charge decided elsewhere,
// and on 2026-08-25 four of the ten were false against production:
//
//   rabbit_hunt         advertised 5, charged 1   <- see below, resolved the
//                                                     OTHER way on 2026-08-25
//   show_stack_bb       advertised 0 and labelled "(FREE)", charged 5
//   offline_protection  advertised 0 and labelled "1 free per session", charged 10
//   tag_pack            advertised per_use, actually written `permanent`
//
// RABBIT HUNT WAS RECONCILED DOWNWARDS AND SHOULD NOT HAVE BEEN. Matching the
// client to `feature_pricing` is the right instinct and was right for the other
// three, but the DB is only the authority on what IS charged, not on what the
// price is SUPPOSED to be. Dan, 2026-08-25: "vip members get 100 rabbit hunts a
// month for free, and they COST 5 DIAMONDS EACH after that." The 1 in the row
// was a January seed that had never matched the product, and it went unnoticed
// because until that day nothing read the row and nothing charged for a hunt at
// all. The row is 5 now (20260825_rabbit_hunt_costs_five_diamonds) and this
// constant follows it back up.
//
// Two of those told a player a feature was FREE and then debited them. The
// values below now match `feature_pricing` exactly, and `loadFeaturePricing()`
// re-reads that table at runtime so the next drift corrects itself and is
// reported instead of sitting silently on the screen.
//
// `auto_time_bank` had no row in `feature_pricing` at all while the table
// settings screen printed "5 D" for it — a price for something the RPC would
// refuse with "unknown feature". Migration 20260825_feature_pricing_integrity
// adds it at the advertised 5/per_use, so the printed price became true rather
// than the product being quietly withdrawn.

export interface FeaturePrice {
  cost: number;
  usageType: 'per_use' | 'per_session' | 'permanent';
  description: string;
}

export const FEATURE_PRICING: Record<VIPFeature, FeaturePrice> = {
  rabbit_hunt: { cost: 5, usageType: 'per_use', description: 'See The Cards That Would Have Come' },
  show_stack_bb: {
    cost: 5,
    usageType: 'per_session',
    description: 'Display Stack In Big Blinds For The Session',
  },
  offline_protection: {
    cost: 10,
    usageType: 'per_session',
    description: 'Protects Your Stack While Disconnected, For The Session',
  },
  auto_time_bank: {
    cost: 5,
    usageType: 'per_use',
    description: 'Auto Time Bank (Diamonds Per Activation)',
  },
  time_bank_seconds: { cost: 5, usageType: 'per_use', description: 'Extra Time Bank Extension' },
  throwable: { cost: 1, usageType: 'per_use', description: 'Throw Item At Table' },
  theme_unlock: { cost: 25, usageType: 'permanent', description: 'Unlock Table Theme' },
  club_creation: { cost: 100, usageType: 'permanent', description: 'Create Club' },
  emoji_pack: { cost: 1, usageType: 'permanent', description: 'Unlock 50 Emojis' },
  tag_pack: { cost: 1, usageType: 'permanent', description: 'Player Tag' },
};

/**
 * Features the server has confirmed it will actually sell, once
 * `loadFeaturePricing()` has run. Empty means "not checked yet", which is NOT
 * the same as "nothing is for sale" — see `isPurchasable`.
 */
const serverPriced = new Set<string>();
let pricingLoadedAt = 0;
/** Matches the marketplace catalog TTL so one tab cannot hold a stale price. */
const PRICING_TTL_MS = 300_000;

/**
 * True unless the server has told us this feature has no price row.
 *
 * Fails OPEN before the first successful load, because refusing to show a
 * price everywhere just because a fetch has not returned yet is a worse lie
 * than showing the cached one. Fails CLOSED once we know the server's list.
 */
export function isPurchasable(feature: string): boolean {
  return serverPriced.size === 0 || serverPriced.has(feature);
}

type PricingRow = { feature: string; diamond_cost: number; usage_type: string };

const isUsageType = (v: unknown): v is FeaturePrice['usageType'] =>
  v === 'per_use' || v === 'per_session' || v === 'permanent';

/**
 * Re-read `feature_pricing` and patch FEATURE_PRICING in place so every
 * consumer that already holds the object starts telling the truth.
 *
 * `feature_pricing` is world-readable (RLS policy `feature_pricing_public_select`,
 * roles anon + authenticated, USING true), so this needs no privileged route.
 *
 * Drift is REPORTED, not swallowed: a price that silently disagreed with the
 * charge is exactly the defect this function exists to end, and a self-healing
 * cache that heals in silence hides how long the storefront was lying.
 */
export async function loadFeaturePricing(force = false): Promise<Record<VIPFeature, FeaturePrice>> {
  if (!force && pricingLoadedAt && Date.now() - pricingLoadedAt < PRICING_TTL_MS) {
    return FEATURE_PRICING;
  }
  try {
    const { data, error } = await supabase
      .from('feature_pricing')
      .select('feature, diamond_cost, usage_type');
    if (error) throw error;
    const rows = (data || []) as PricingRow[];
    // A successful request that returned nothing is not evidence that nothing
    // is for sale. Keep the cached table rather than blanking the storefront.
    if (rows.length === 0) return FEATURE_PRICING;

    serverPriced.clear();
    const drift: string[] = [];
    for (const row of rows) {
      const key = String(row.feature);
      serverPriced.add(key);
      const local = (FEATURE_PRICING as Record<string, FeaturePrice | undefined>)[key];
      if (!local) continue; // server sells more than this union knows (card backs)
      const cost = Number(row.diamond_cost);
      if (Number.isFinite(cost) && cost !== local.cost) {
        drift.push(`${key}: displayed ${local.cost}, server charges ${cost}`);
        local.cost = cost;
      }
      if (isUsageType(row.usage_type) && row.usage_type !== local.usageType) {
        drift.push(`${key}: displayed ${local.usageType}, server uses ${row.usage_type}`);
        local.usageType = row.usage_type;
      }
    }
    for (const key of Object.keys(FEATURE_PRICING)) {
      if (!serverPriced.has(key)) {
        drift.push(
          `${key}: advertised at ${FEATURE_PRICING[key as VIPFeature].cost}, not for sale`
        );
      }
    }
    pricingLoadedAt = Date.now();
    if (drift.length > 0) {
      reportError(
        new Error(`feature pricing drift: ${drift.join('; ')}`),
        'VIPService.loadFeaturePricing'
      );
    }
    return FEATURE_PRICING;
  } catch (err) {
    // The cached table stays in force. It is correct as of the last audit, so
    // it is the best available answer when the read fails.
    reportError(err, 'VIPService.loadFeaturePricing_failed');
    return FEATURE_PRICING;
  }
}

/** Test seam: forget what the server said so the next load re-reads it. */
export function __resetFeaturePricingCache(): void {
  serverPriced.clear();
  pricingLoadedAt = 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class VIPServiceClass {
  /**
   * Is this player a VIP, and which kind.
   *
   * 2026-09-05: this selected `is_vip, vip_expires_at` and derived the answer
   * itself, so a LIFETIME member whose `vip_expires_at` was ever set into the
   * past would have been read as expired - the whole point of a lifetime
   * membership is that the date does not decide. Production stores the sentinel
   * 2099-12-31 on 692 of those rows and NULL on 329, so nobody was harmed; the
   * resolver removes the possibility rather than the coincidence.
   *
   * `resolveVipStatus` is the ONE place that answers this question
   * (tests/vip-is-not-a-ladder.law.test.ts).
   */
  async checkVIPStatus(userId: string): Promise<VIPStatus> {
    const { data, error } = await supabase
      .from('profiles')
      .select('is_vip, vip_tier, vip_expires_at')
      .eq('id', userId)
      .maybeSingle();

    /**
     * A FAILED READ IS NOT A DOWNGRADE (2026-08-28).
     *
     * `error` and `!data` were collapsed into one answer: "not VIP, zero
     * allowance". One transient network blip or RLS hiccup therefore stripped
     * a PAYING member of the rabbit hunts, time-bank seconds, emojis and tags
     * they bought — silently, with no retry.
     *
     * This repo has already ruled against this exact shape twice, in comments
     * that are still in the tree: `WalletService.getPlayerBalance` was deleted
     * for it ("a read that never happened is not a balance of zero"), and
     * `useWalletStore.loadDiamonds` refuses to zero a cached count for the
     * same reason. Nothing made VIP the exception.
     *
     * `!data` is a real answer — the profile row says this user is not VIP.
     * `error` is the ABSENCE of an answer, so it throws, and the caller keeps
     * whatever it already knew rather than acting on a fiction.
     */
    if (error) {
      throw new Error(`VIP status unreadable: ${error.message || 'query failed'}`);
    }
    if (!data) {
      return {
        isVIP: false,
        status: 'none',
        expiresAt: null,
        monthlyLimits: this.getEmptyLimits(),
      };
    }

    const vipStatus = resolveVipStatus(data);
    const isVIP = vipStatus !== 'none';

    if (!isVIP) {
      return {
        isVIP: false,
        status: 'none',
        expiresAt: null,
        monthlyLimits: this.getEmptyLimits(),
      };
    }

    // Get monthly usage for VIP user
    const limits = await this.getMonthlyUsage(userId);

    return {
      isVIP: true,
      // A lifetime membership has no expiry to show, whatever sentinel date the
      // row happens to carry.
      status: vipStatus,
      expiresAt:
        vipStatus === 'lifetime' || !data.vip_expires_at ? null : new Date(data.vip_expires_at),
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
  ): Promise<{ success: boolean; charged: number; error?: string; alreadyOwned?: boolean }> {
    // Prod sig: (p_user_id, p_feature, p_cost integer DEFAULT 0). p_cost is
    // deliberately NOT sent — the function ignores it and prices the purchase
    // from `feature_pricing`, which is the only safe design: a client that can
    // name its own price can buy a 300-diamond card back for nothing.
    //
    // REFUSALS ARRIVE AS DATA, NOT AS `error`. fn_purchase_feature answers
    // "authentication required", "unknown feature", "already_owned" and
    // "Insufficient diamonds" with `{ success: false, error }` and a 200, so a
    // caller that inspects only `error` reports a green purchase with no debit
    // and no feature. Both are checked below, and the order matters: `error`
    // first (transport/permission), then the payload.
    const { data, error } = await supabase.rpc('fn_purchase_feature', {
      p_user_id: userId,
      p_feature: feature,
    });
    void quantity; // explicitly acknowledge unused param at FE layer

    if (error) {
      return { success: false, charged: 0, error: error.message };
    }

    if (!data || !data.success) {
      // `already_owned` is a REFUSAL, not a failure: the player has the thing
      // and was not charged again. Callers surface it differently so nobody is
      // told a purchase broke when it was correctly declined.
      const reason = String(data?.error || '');
      return {
        success: false,
        charged: 0,
        error: reason || 'Purchase failed',
        alreadyOwned: reason === 'already_owned' || !!data?.already_owned,
      };
    }

    return { success: true, charged: Number(data.cost) || 0 };
  }

  /**
   * Get current monthly usage for VIP user
   */
  private async getMonthlyUsage(userId: string): Promise<VIPMonthlyLimits> {
    try {
      // vip_feature_usage_monthly is the month-scoped per-feature ledger,
      // written atomically by fn_increment_vip_usage (2026-08-17). Before it
      // existed this method deliberately read nothing, so VIP quotas never
      // depleted and the diamond top-up path could never trigger.
      const month = new Date().toISOString().slice(0, 7); // 'YYYY-MM' UTC
      const { data, error } = await supabase
        .from('vip_feature_usage_monthly')
        .select('feature, usage_count')
        .eq('user_id', userId)
        .eq('month', month);
      if (error) console.warn('[VIPService] getMonthlyUsage error:', error.message);

      const usage: Record<string, number> = {};
      for (const row of data || []) {
        usage[(row as any).feature] = (row as any).usage_count || 0;
      }

      /* fn_use_throwable meters against `throw_usage` by calendar month, not
         against vip_feature_usage_monthly, so it takes its own count. */
      let throwsUsed = 0;
      const monthStart = new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)
      );
      const { count: throwCount, error: throwErr } = await supabase
        .from('throw_usage')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', monthStart.toISOString());
      if (throwErr) {
        console.warn('[VIPService] throw_usage count error:', throwErr.message);
      } else {
        throwsUsed = throwCount || 0;
      }

      return {
        rabbitHunts: { used: usage['rabbit_hunt'] || 0, limit: VIP_MONTHLY_ALLOWANCES.rabbitHunts },
        timeBankSeconds: {
          used: usage['time_bank_seconds'] || 0,
          limit: VIP_MONTHLY_ALLOWANCES.timeBankSeconds,
        },
        /* WH issue #771 item 3 (2026-08-27): these read usage under 'emojis'
           and 'tags' while fn_increment_vip_usage writes the VIPFeature keys
           'emoji_pack' and 'tag_pack' — so the two counters could NEVER
           match and the 1,200-emoji / 1,000-tag allowances were never
           enforced in either direction. The reader now uses the keys the
           writer writes, which is the whole fix: the quota machinery agrees
           with itself, and the moment the VIP page re-advertises the lines
           the enforcement is already real. */
        emojis: { used: usage['emoji_pack'] || 0, limit: VIP_MONTHLY_ALLOWANCES.emojis },
        tags: { used: usage['tag_pack'] || 0, limit: VIP_MONTHLY_ALLOWANCES.tags },
        /* Counted from throw_usage, which is where fn_use_throwable writes and
           reads it. A failed count is reported as 0 used rather than 0 allowed:
           a read that did not happen is not an exhausted allowance. */
        throwables: { used: throwsUsed, limit: VIP_MONTHLY_ALLOWANCES.throwables },
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
      throwables: { used: 0, limit: 0 },
    };
  }

  /**
   * Check if VIP user has remaining quota for feature
   */
  private async checkVIPQuota(userId: string, feature: VIPFeature): Promise<boolean> {
    // Some features are unlimited for VIP. Rabbit hunt is NOT one of them any
    // more (Dan 2026-08-25: 100/month, then 5 diamonds) — but this method is
    // only consulted for display, and the authoritative decision is made by
    // fn_consume_rabbit_hunt on the server when the reveal is actually bought.
    if (['show_stack_bb', 'offline_protection', 'auto_time_bank'].includes(feature)) {
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
        // The old fallback upserted vip_monthly_usage with columns that table
        // does not have (feature/period_start/usage_count) and could never
        // succeed. fn_increment_vip_usage has a real body since 2026-08-17
        // and writes both the lifetime/daily and monthly ledgers atomically,
        // so an error here is a genuine failure worth reporting, not a
        // missing-RPC condition to paper over.
        reportError(rpcErr, 'VIPService.fn_increment_vip_usage_failed');
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
      // 2026-08-28: these were console.warn — invisible to everyone. A failed
      // consume means the paid feature was granted and the use was never
      // decremented: silent entitlement-ledger drift on a purchase path. The
      // grant deliberately stands (err in the player's favour, never re-charge
      // a player for our failure) but the failure is now REPORTED so the
      // drift is visible instead of unknowable.
      if (error) reportError(error, 'VIPService.fn_consume_feature_use_failed');
    } catch (err) {
      reportError(err, 'VIPService.consumePurchase_failed');
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
   * Get the monthly allowances for display
   */
  getGoldBenefits() {
    return VIP_MONTHLY_ALLOWANCES;
  }
}

// Export singleton
export const vipService = new VIPServiceClass();
