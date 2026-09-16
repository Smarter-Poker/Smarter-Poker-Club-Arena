/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  COSMETIC PURCHASE + OWNERSHIP INTEGRITY
 *
 *  Every case here is a defect measured against PRODUCTION on 2026-08-25, not
 *  a hypothetical. Two themes run through all of them:
 *
 *    1. A PRICE ON SCREEN IS A PROMISE. `fn_purchase_feature` ignores the cost
 *       the client sends and charges `feature_pricing.diamond_cost`, so every
 *       number in FEATURE_PRICING is a claim about a charge decided elsewhere.
 *       Four of the ten were false, and two of those said FREE about a feature
 *       that debits diamonds.
 *
 *    2. A REFUSAL IS NOT A SUCCESS. The RPCs on this path answer ordinary
 *       refusals with `{ success: false, error }` and NO PostgREST error, so a
 *       client that inspects only `error` reports a green purchase with no
 *       debit and no item.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rpc = vi.fn();
const from = vi.fn();
const reported: string[] = [];

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: (...a: unknown[]) => from(...a),
  },
}));

vi.mock('../src/utils/errorReporter', () => ({
  reportError: (err: unknown, ctx?: string) =>
    reported.push(`${ctx || ''}: ${err instanceof Error ? err.message : String(err)}`),
}));

const VIPMod = await import('../src/services/VIPService');
const {
  FEATURE_PRICING,
  vipService,
  isPurchasable,
  loadFeaturePricing,
  __resetFeaturePricingCache,
} = VIPMod;
const { loadEntitlements } = await import('../src/pages/marketplace/marketplaceShared');

const USER = '47965354-0e56-43ef-931c-ddaab82af765';

/**
 * `feature_pricing` as it stands in production kuklfnapbkmacvwxktbh, read on
 * 2026-08-25 and re-asserted by migration 20260825_feature_pricing_integrity.
 * Re-verify with:
 *   select feature, diamond_cost, usage_type from feature_pricing order by feature;
 */
const PRODUCTION_PRICES: Record<string, { cost: number; usageType: string }> = {
  auto_time_bank: { cost: 5, usageType: 'per_use' },
  club_creation: { cost: 100, usageType: 'permanent' },
  emoji_pack: { cost: 1, usageType: 'permanent' },
  offline_protection: { cost: 10, usageType: 'per_session' },
  // 5 since 20260825_rabbit_hunt_costs_five_diamonds. The row had said 1 since a
  // January seed; nothing read it, so nothing caught that it never matched the
  // stated price of the product.
  rabbit_hunt: { cost: 5, usageType: 'per_use' },
  show_stack_bb: { cost: 5, usageType: 'per_session' },
  tag_pack: { cost: 1, usageType: 'permanent' },
  theme_unlock: { cost: 25, usageType: 'permanent' },
  throwable: { cost: 1, usageType: 'per_use' },
  time_bank_seconds: { cost: 5, usageType: 'per_use' },
};

/** FEATURE_PRICING is patched in place by loadFeaturePricing, so restore it. */
let pristine: string;

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
  reported.length = 0;
  pristine = JSON.stringify(FEATURE_PRICING);
  __resetFeaturePricingCache();
});

afterEach(() => {
  const original = JSON.parse(pristine) as typeof FEATURE_PRICING;
  for (const key of Object.keys(original) as (keyof typeof FEATURE_PRICING)[]) {
    Object.assign(FEATURE_PRICING[key], original[key]);
  }
  __resetFeaturePricingCache();
});

/** Build a `from(...).select(...)` that resolves once, for feature_pricing. */
function pricingTable(result: { data: unknown; error: unknown }) {
  from.mockImplementation((table: string) => {
    if (table !== 'feature_pricing') throw new Error(`unexpected table ${table}`);
    return { select: () => Promise.resolve(result) };
  });
}

/* ── 1. The displayed price is the charged price ────────────────────────── */

describe('FEATURE_PRICING is the price the server actually charges', () => {
  it('matches production feature_pricing for every feature', () => {
    for (const [feature, expected] of Object.entries(PRODUCTION_PRICES)) {
      const local = FEATURE_PRICING[feature as keyof typeof FEATURE_PRICING];
      expect(local, `${feature} is missing from FEATURE_PRICING`).toBeTruthy();
      expect(local.cost, `${feature} price`).toBe(expected.cost);
      expect(local.usageType, `${feature} usage type`).toBe(expected.usageType);
    }
  });

  it('advertises no feature the server does not sell', () => {
    // `auto_time_bank` was printed as "5 D" on the table settings screen while
    // fn_purchase_feature answered `unknown feature: auto_time_bank`.
    for (const feature of Object.keys(FEATURE_PRICING)) {
      expect(PRODUCTION_PRICES[feature], `${feature} has no price row in production`).toBeTruthy();
    }
  });

  it('never calls a charged feature free', () => {
    // show_stack_bb read `cost: 0, description: "(FREE)"` and charged 5.
    // offline_protection read `cost: 0, description: "1 free per session"`
    // and charged 10. A member was told free and then debited.
    for (const [feature, price] of Object.entries(FEATURE_PRICING)) {
      const charged = PRODUCTION_PRICES[feature]?.cost ?? 0;
      if (charged > 0) {
        expect(price.cost, `${feature} shows 0 but costs ${charged}`).toBeGreaterThan(0);
        expect(price.description.toLowerCase(), `${feature} description claims free`).not.toMatch(
          /\bfree\b/
        );
      }
    }
  });
});

/* ── 2. Drift corrects itself and is reported, never silent ─────────────── */

describe('loadFeaturePricing', () => {
  it('adopts the server price and reports the drift', async () => {
    pricingTable({
      data: [{ feature: 'theme_unlock', diamond_cost: 40, usage_type: 'permanent' }],
      error: null,
    });
    await loadFeaturePricing(true);
    expect(FEATURE_PRICING.theme_unlock.cost).toBe(40);
    expect(reported.join(' ')).toContain('theme_unlock: displayed 25, server charges 40');
  });

  it('adopts a corrected usage type', async () => {
    pricingTable({
      data: [{ feature: 'tag_pack', diamond_cost: 1, usage_type: 'per_use' }],
      error: null,
    });
    await loadFeaturePricing(true);
    expect(FEATURE_PRICING.tag_pack.usageType).toBe('per_use');
  });

  it('reports a feature that is advertised but not for sale', async () => {
    pricingTable({
      data: [{ feature: 'theme_unlock', diamond_cost: 25, usage_type: 'permanent' }],
      error: null,
    });
    await loadFeaturePricing(true);
    expect(reported.join(' ')).toContain('auto_time_bank: advertised at 5, not for sale');
  });

  it('keeps the cached table when the read fails, and says so', async () => {
    pricingTable({ data: null, error: { message: 'network down' } });
    await loadFeaturePricing(true);
    // A failed read is not a price change. Blanking or zeroing the storefront
    // here would be the same class of lie in the other direction.
    expect(FEATURE_PRICING.theme_unlock.cost).toBe(25);
    expect(reported.join(' ')).toContain('loadFeaturePricing_failed');
  });

  it('treats an empty result as "could not tell", not "nothing is for sale"', async () => {
    pricingTable({ data: [], error: null });
    await loadFeaturePricing(true);
    expect(FEATURE_PRICING.rabbit_hunt.cost).toBe(5);
    expect(isPurchasable('rabbit_hunt')).toBe(true);
    // And it must not shout that the entire catalogue was withdrawn. Without
    // the early return the loop reports all ten features as "not for sale" and
    // stamps the cache, so the next five minutes of drift reports are noise
    // over a request that simply came back empty.
    expect(reported).toEqual([]);
  });

  it('does not cache an empty result as the truth', async () => {
    pricingTable({ data: [], error: null });
    await loadFeaturePricing(true);
    // A second, non-forced call must still go to the server rather than serving
    // the nothing it just received.
    let calls = 0;
    from.mockImplementation(() => {
      calls += 1;
      return {
        select: () =>
          Promise.resolve({
            data: [{ feature: 'rabbit_hunt', diamond_cost: 3, usage_type: 'per_use' }],
            error: null,
          }),
      };
    });
    await loadFeaturePricing();
    expect(calls).toBe(1);
    expect(FEATURE_PRICING.rabbit_hunt.cost).toBe(3);
  });
});

describe('isPurchasable', () => {
  it('fails open before the server list is known', () => {
    expect(isPurchasable('anything_at_all')).toBe(true);
  });

  it('fails closed once the server has listed what it sells', async () => {
    pricingTable({
      data: [{ feature: 'theme_unlock', diamond_cost: 25, usage_type: 'permanent' }],
      error: null,
    });
    await loadFeaturePricing(true);
    expect(isPurchasable('theme_unlock')).toBe(true);
    expect(isPurchasable('auto_time_bank')).toBe(false);
  });
});

/* ── 3. A refused purchase is never rendered as a success ───────────────── */

describe('vipService.purchaseFeature', () => {
  it('reports success only when the RPC actually granted the feature', async () => {
    rpc.mockResolvedValue({ data: { success: true, cost: 25 }, error: null });
    await expect(vipService.purchaseFeature(USER, 'theme_unlock')).resolves.toMatchObject({
      success: true,
      charged: 25,
    });
  });

  it('reports no local charge or grant for an idempotent replay', async () => {
    rpc.mockResolvedValue({
      data: { success: true, cost: 25, idempotent: true, granted: false },
      error: null,
    });
    await expect(vipService.purchaseFeature(USER, 'theme_unlock')).resolves.toMatchObject({
      success: true,
      charged: 0,
      idempotent: true,
      granted: false,
    });
  });

  it('never sends a client-chosen price', async () => {
    // fn_purchase_feature ignores p_cost, but sending one invites the next
    // author to believe the client decides. Verified live: passing 999999 for
    // auto_time_bank still charged the server's 5.
    rpc.mockResolvedValue({ data: { success: true, cost: 1 }, error: null });
    await vipService.purchaseFeature(USER, 'rabbit_hunt');
    expect(rpc).toHaveBeenCalledWith('fn_purchase_feature_v2', {
      p_user_id: USER,
      p_feature: 'rabbit_hunt',
      p_request_id: expect.any(String),
    });
  });

  it('does NOT claim success on a payload refusal with no postgres error', async () => {
    // THE SHAPE THIS WHOLE FILE EXISTS FOR.
    rpc.mockResolvedValue({
      data: { success: false, error: 'Insufficient diamonds' },
      error: null,
    });
    const out = await vipService.purchaseFeature(USER, 'theme_unlock');
    expect(out.success).toBe(false);
    expect(out.charged).toBe(0);
    expect(out.error).toContain('Insufficient');
  });

  it('marks an already-owned refusal so the UI does not call it a failure', async () => {
    rpc.mockResolvedValue({
      data: { success: false, error: 'already_owned', already_owned: true },
      error: null,
    });
    const out = await vipService.purchaseFeature(USER, 'theme_unlock');
    expect(out.success).toBe(false);
    expect(out.alreadyOwned).toBe(true);
    expect(out.charged).toBe(0);
  });

  it('does not claim success when the RPC itself errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    const out = await vipService.purchaseFeature(USER, 'theme_unlock');
    expect(out.success).toBe(false);
    expect(out.error).toBe('Purchase Failed');
    expect(out.error).not.toContain('permission denied');
  });

  it('does not claim success when the RPC returns nothing at all', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(vipService.purchaseFeature(USER, 'theme_unlock')).resolves.toMatchObject({
      success: false,
      charged: 0,
    });
  });
});

/* ── 4. Ownership: a failed read is not "you own nothing" ───────────────── */

function ownershipTables(results: Record<string, { data: unknown; error: unknown }>) {
  from.mockImplementation((table: string) => ({
    select: () => ({
      eq: () => Promise.resolve(results[table] ?? { data: [], error: null }),
    }),
  }));
}

describe('loadEntitlements', () => {
  const ok = { data: [], error: null };

  it('reads the SPECIFIC themes owned, deduped', async () => {
    ownershipTables({
      feature_purchases: { data: [], error: null },
      avatar_unlocks: {
        data: [
          { avatar_id: 'shark' },
          { avatar_id: 'shark' },
          { avatar_id: 'frame_gold' },
          { avatar_id: 'gold_frame' },
        ],
        error: null,
      },
      theme_unlocks: {
        data: [{ theme_id: 'midnight_a' }, { theme_id: 'royal_b' }, { theme_id: 'royal_b' }],
        error: null,
      },
    });
    const ent = await loadEntitlements('u1');
    // The generic feature_purchases.theme_unlock flag cannot name a theme and
    // accumulates a row per redemption, so it can never be counted.
    // Legacy receipts normalize to the real Table Studio presets they now
    // unlock; showing dead aliases would double-count the backfilled receipt.
    expect(ent.themes).toEqual(['carbon-ion', 'rustic-wood']);
    expect(ent.avatars).toEqual(['shark']);
    expect(ent.avatarCosmetics).toEqual(['frame_gold']);
    expect(ent.themeUnlock).toBe(true);
  });

  it('throws when avatar_unlocks fails instead of reporting zero avatars', async () => {
    ownershipTables({
      feature_purchases: ok,
      avatar_unlocks: { data: null, error: { message: 'rls denied' } },
      theme_unlocks: ok,
    });
    await expect(loadEntitlements('u1')).rejects.toBeTruthy();
  });

  it('throws when theme_unlocks fails instead of reporting zero themes', async () => {
    ownershipTables({
      feature_purchases: ok,
      avatar_unlocks: ok,
      theme_unlocks: { data: null, error: { message: 'rls denied' } },
    });
    await expect(loadEntitlements('u1')).rejects.toBeTruthy();
  });

  it('counts only unexpired feature purchases', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    ownershipTables({
      feature_purchases: {
        data: [
          { feature: 'throwable', uses_remaining: 5, expires_at: null },
          { feature: 'throwable', uses_remaining: 99, expires_at: past },
        ],
        error: null,
      },
      avatar_unlocks: ok,
      theme_unlocks: ok,
    });
    const ent = await loadEntitlements('u1');
    expect(ent.throwables).toBe(5);
  });
});
