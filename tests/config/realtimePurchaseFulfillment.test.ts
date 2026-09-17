/**
 * A checkout is complete only when the paid benefit is usable. These pins
 * cover the production migration and every client refresh surface it wakes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const MIGRATION = read(
  'supabase/migrations/20260829213000_realtime_shop_fulfillment_and_purchase_intents.sql'
);
const RPC_LOCK = read('supabase/migrations/20260829220000_lock_shop_fulfillment_rpcs.sql');
const STORE = read('src/pages/marketplace/StoreTab.tsx');
const MARKET = read('src/pages/MarketplacePage.tsx');
const MEMBERSHIP = read('src/pages/marketplace/MembershipTab.tsx');
const DIAMONDS = read('src/pages/marketplace/DiamondsTab.tsx');
const BUS = read('src/core/MasterBus.ts');
const TABLE = read('src/pages/TablePage.tsx');
const THROWS = read('src/components/table/ThrowableSelector.tsx');
const THROW_SERVICE = read('src/services/ThrowableService.ts');
const EMOJIS = read('src/components/table/EmojiPicker.tsx');
const REWARDS = read('src/components/vip/RewardsMarketplace.tsx');
const VIP_PAGE = read('src/pages/VIPPage.tsx');

describe('atomic club-shop fulfillment', () => {
  it('grants in the purchase trigger and backfills every waiting receipt', () => {
    expect(MIGRATION).toContain('CREATE OR REPLACE FUNCTION public.sp_grant_shop_item');
    expect(MIGRATION).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_deliver_shop_purchase[\s\S]*sp_grant_shop_item/
    );
    expect(MIGRATION).toContain("inv.status = 'owned' AND inv.redeemed_at IS NULL");
    expect(MIGRATION).toContain("'club_shop_backfill'");
  });

  it('withdraws unfulfillable products and rejects future grant-less rows', () => {
    expect(MIGRATION).toContain('SET is_active = false');
    expect(MIGRATION).toContain("grant_type = 'manual'");
    expect(MIGRATION).toContain('Active shop item has no executable grant');
    expect(REWARDS).toContain("row.grant_type === 'theme' || row.grant_type === 'avatar'");
    expect(REWARDS).not.toContain("id: 'merch-hoodie'");
  });

  it('checks durable permanent entitlements before allowing another charge', () => {
    expect(MIGRATION).toMatch(
      /fn_shop_item_availability[\s\S]*theme_asset_unlocks[\s\S]*avatar_unlocks[\s\S]*emoji_pack/
    );
    expect(MIGRATION).toContain('v_inv.redeemed_at IS NOT NULL');
    expect(MARKET).toContain('isMarketplaceItemOwned');
  });

  it('keeps fulfillment and refund writers behind trusted server paths', () => {
    expect(RPC_LOCK).toContain('FROM PUBLIC, anon, authenticated');
    expect(RPC_LOCK).toMatch(
      /fn_refund_shop_purchase\(uuid, uuid, uuid, text\)[\s\S]*TO service_role/
    );
    expect(RPC_LOCK).toContain('shop refund writer is still browser-callable');
  });
});

describe('same-frame and cross-tab delivery', () => {
  it('uses synchronous refs and stable keys on every checkout launcher', () => {
    expect(MEMBERSHIP).toContain('inFlightRef.current');
    expect(MEMBERSHIP).toContain('intentKeyRef.current');
    expect(DIAMONDS).toContain('checkoutInFlightRef.current');
    expect(DIAMONDS).toContain('checkoutKeyRef.current');
    expect(VIP_PAGE).toContain('purchaseInFlightRef.current');
  });

  it('broadcasts every entitlement without deduplicating receipts', () => {
    expect(STORE).toContain("masterBus.emit('ENTITLEMENTS_CHANGED'");
    expect(STORE).toContain('Delivered Instantly:');
    expect(BUS).toContain("| 'ENTITLEMENTS_CHANGED'");
    expect(BUS).toMatch(/DEDUP_BYPASS[\s\S]*'ENTITLEMENTS_CHANGED'/);
    expect(MARKET).toContain("subscribeDebounced(\n        'ENTITLEMENTS_CHANGED'");
  });

  it('updates open tables, throw packs and emoji access in real time', () => {
    expect(TABLE).toContain("useMasterBusSubscription('ENTITLEMENTS_CHANGED'");
    expect(THROWS).toContain("masterBus.subscribe('ENTITLEMENTS_CHANGED'");
    expect(THROW_SERVICE).toContain('packThrowsRemaining');
    expect(EMOJIS).toContain("checkFeatureAccess(user.id, 'emoji_pack')");
    expect(EMOJIS).toContain("masterBus.subscribe('ENTITLEMENTS_CHANGED'");
    expect(VIP_PAGE).toContain("masterBus.emit('ENTITLEMENTS_CHANGED'");
  });
});
