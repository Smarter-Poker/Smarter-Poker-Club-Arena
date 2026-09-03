/**
 * A PURCHASE IS NOT COMPLETE UNTIL THE SELECTOR CAN USE IT.
 *
 * These pins cover the full cosmetic delivery chain introduced after the
 * 2026-08-29 production audit: canonical SKU, server price, durable receipt,
 * category entitlement, immediate repaint, and cross-tab refresh.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  THEME_PRESET_ALIASES,
  THEME_PRESET_CATALOG,
  THEME_PRESET_BUNDLES,
} from '../../src/lib/tableTheme';
import { CARD_BACK_CATALOG } from '../../src/components/table/CardImage';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const MODAL = read('src/components/table/ThemeSettingsModal.tsx');
const VIP = read('src/pages/VIPPage.tsx');
const ITEMS = read('src/pages/marketplace/MyItemsTab.tsx');
const ENTITLEMENTS = read('src/pages/marketplace/marketplaceShared.ts');
const MANAGE = read('src/pages/marketplace/ManageTab.tsx');
const AVATAR_GALLERY = read('src/components/customization/AvatarGallery.tsx');
const MIGRATION = read(
  'supabase/migrations/20260829190000_cosmetic_checkout_and_entitlement_delivery.sql'
);

describe('canonical cosmetic SKUs', () => {
  it('defines ten complete, distinct theme bundles', () => {
    expect(THEME_PRESET_CATALOG).toHaveLength(10);
    expect(new Set(THEME_PRESET_CATALOG.map((preset) => preset.id)).size).toBe(10);
    for (const preset of THEME_PRESET_CATALOG) {
      expect(THEME_PRESET_BUNDLES[preset.id]).toEqual({
        table_id: preset.table_id,
        button_id: preset.button_id,
        background_id: preset.background_id,
        cards_id: preset.cards_id,
      });
    }
  });

  it('keeps every legacy receipt alias mapped on both client and server', () => {
    for (const [legacyId, presetId] of Object.entries(THEME_PRESET_ALIASES)) {
      expect(MIGRATION).toContain(`('${legacyId}'`);
      expect(MIGRATION).toContain(`'${presetId}')`);
    }
  });

  it('prices every and only premium card back on the server', () => {
    const paid = CARD_BACK_CATALOG.filter((design) => design.price > 0);
    expect(paid).toHaveLength(9);
    for (const design of paid) {
      expect(MIGRATION).toContain(`'card_back_${design.id}'`);
      expect(MIGRATION).toMatch(
        new RegExp(`'card_back_${design.id.replace('-', '\\-')}',\\s+${design.price}`)
      );
    }
    for (const dead of ['card_back_classic', 'card_back_burgundy', 'card_back_navy']) {
      expect(MIGRATION).toContain(dead);
      expect(MIGRATION).toMatch(new RegExp(`DELETE[\\s\\S]{0,300}${dead}`));
    }
  });
});

describe('checkout and delivery contract', () => {
  it('prices from feature_pricing, latches duplicate taps and auto-equips on success', () => {
    expect(MODAL).toContain(".from('feature_pricing')");
    expect(MODAL).toContain("supabase.rpc('fn_purchase_feature'");
    expect(MODAL).toContain('purchaseBusyRef.current');
    expect(MODAL).toMatch(/if \(!pending \|\| !userId \|\| purchaseBusyRef\.current\) return/);
    expect(MODAL).toContain('applyAccessibleAsset(pending.tab, pending.id)');
    expect(MODAL).toContain("masterBus.emit('DIAMOND_SPENT'");
    expect(MODAL).toContain("masterBus.emit('COSMETIC_OWNERSHIP_CHANGED'");
  });

  it('treats already-owned as permission and refuses all other data-level failures', () => {
    expect(MODAL).toContain("data?.error === 'already_owned'");
    expect(MODAL).toMatch(/if \(!data\?\.success && !alreadyOwned\)/);
  });

  it('delivers every preset field atomically and validates club SKUs before redemption', () => {
    for (const category of ['theme_id', 'table_id', 'button_id', 'background_id', 'cards_id']) {
      expect(MIGRATION).toContain(`'${category}'`);
    }
    expect(MIGRATION).toContain('sp_grant_theme_preset');
    expect(MIGRATION).toContain('trg_validate_shop_theme_preset');
    expect(MIGRATION).toContain("'invalid_theme_sku'");
    expect(MIGRATION).toContain("'user_id', v_uid");
  });

  it('prevents admins from typing an invented table theme', () => {
    expect(MANAGE).toContain('MARKETPLACE_THEME_PRESETS.map');
    expect(MANAGE).toContain('Choose A Table Studio Theme');
    expect(MANAGE).toContain('MARKETPLACE_THEME_IDS.has');
    expect(MANAGE).not.toContain('Theme Id (E.g. royal_gold)');
  });

  it('restricts avatar products to the real 97-avatar library on both client and server', () => {
    expect(MANAGE).toMatch(/avatarService\s*\.getAvatarLibraryResult\(\)/);
    expect(MANAGE).toContain('avatarOptions.map');
    expect(MANAGE).not.toContain('Avatar Id (E.g. shark)');
    expect(MIGRATION).toContain('CREATE TABLE IF NOT EXISTS public.avatar_shop_catalog');
    expect(MIGRATION).toContain('sp_resolve_avatar_shop_sku');
    expect(MIGRATION).toContain('expected the shipped 97');
    expect(MIGRATION).toContain("'invalid_avatar_sku'");
  });

  it('maps every VIP avatar reward to a style the gallery can actually render', () => {
    for (const style of ['frame_gold', 'frame_hellfire', 'frame_diamond']) {
      expect(MIGRATION).toContain(`grant_ref = '${style}'`);
    }
    expect(MIGRATION).not.toMatch(/grant_ref = '(?:gold_frame|royal_crown|diamond_halo)'/);
  });
});

describe('immediate ownership refresh', () => {
  it('reads modern category entitlements and retains legacy receipts during rollout', () => {
    expect(ENTITLEMENTS).toContain(".from('theme_asset_unlocks')");
    expect(ENTITLEMENTS).toContain(".from('theme_unlocks')");
    expect(MODAL).toContain(".from('theme_asset_unlocks')");
  });

  it('broadcasts rewards and club redemptions to every open Studio', () => {
    expect(VIP).toContain("masterBus.emit('COSMETIC_OWNERSHIP_CHANGED'");
    expect(ITEMS).toContain("masterBus.emit('COSMETIC_OWNERSHIP_CHANGED'");
    expect(MODAL).toContain("masterBus.subscribe('COSMETIC_OWNERSHIP_CHANGED'");
    expect(AVATAR_GALLERY).toContain("masterBus.subscribe('COSMETIC_OWNERSHIP_CHANGED'");
  });

  it('releases the redemption latch on both success and failure', () => {
    const finallyBlock = ITEMS.slice(ITEMS.indexOf('} finally {', ITEMS.indexOf('handleRedeem')));
    expect(finallyBlock).toContain('redeemingRef.current = false');
  });

  it('removes the generic theme SKU that cannot identify an asset', () => {
    expect(VIP).toContain("feature !== 'theme_unlock'");
    expect(MIGRATION).toContain(
      "DELETE FROM public.feature_pricing WHERE feature = 'theme_unlock'"
    );
  });
});
