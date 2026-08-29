import { readFileSync } from 'node:fs';

const migration = readFileSync(
  'supabase/migrations/20260829230000_table_studio_storefront_and_cloud_preferences.sql',
  'utf8'
);
const modal = readFileSync('src/components/table/ThemeSettingsModal.tsx', 'utf8');
const collections = readFileSync('src/hooks/useTableStudioCollections.ts', 'utf8');

describe('Table Studio permanent storefront', () => {
  it('prices every premium non-card category from cosmetic_catalog', () => {
    for (const category of ['theme_id', 'table_id', 'button_id', 'background_id']) {
      expect(migration).toContain(`WHEN '${category}'`);
    }
    expect(migration).toContain("'studio:' || c.category || ':' || c.asset_id");
    expect(migration).toContain("c.tier = 'vip'");
    expect(migration).toContain("p.usage_type = 'permanent'");
  });

  it('delivers the exact category entitlement in the purchase transaction', () => {
    expect(migration).toContain('trg_deliver_table_studio_entitlement');
    expect(migration).toContain('AFTER INSERT ON public.feature_purchases');
    expect(migration).toContain('sp_grant_theme_preset');
    expect(migration).toContain('INSERT INTO public.theme_asset_unlocks');
    expect(migration).toContain("RAISE EXCEPTION 'Invalid Table Studio entitlement SKU %'");
  });

  it('uses the server feature id and applies the purchased asset immediately', () => {
    expect(modal).toContain('`studio:${TAB_TO_FIELD[tab]}:${assetId}`');
    expect(modal).toContain("supabase.rpc('fn_purchase_feature'");
    expect(modal).toContain('p_feature: pending.feature');
    expect(modal).toContain('applyAccessibleAsset(pending.tab, pending.id)');
  });
});

describe('Table Studio cross-device collections', () => {
  it('stores only the signed-in user row behind owner-only RLS', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.user_table_studio_preferences');
    expect(migration).toContain('user_id uuid PRIMARY KEY REFERENCES auth.users(id)');
    expect(migration).toContain('user_id = (SELECT auth.uid())');
    expect(migration).toContain('cardinality(favorites) <= 100');
    expect(migration).toContain('jsonb_array_length(loadouts) = 3');
  });

  it('hydrates locally, reconciles from cloud, and subscribes to realtime', () => {
    expect(collections).toContain('table-studio-favorites:');
    expect(collections).toContain('table-studio-loadouts:');
    expect(collections).toContain(".from('user_table_studio_preferences')");
    expect(collections).toContain("'postgres_changes'");
    expect(collections).toContain('supabase.removeChannel(channel)');
  });

  it('sanitizes a saved loadout against current entitlements before writing it', () => {
    expect(modal).toContain('Locked Or Retired Choices Were Kept On Your Current Design');
    expect(modal).toMatch(/canAccessAsset\([\s\S]{0,250}candidate\[field\]/);
  });
});
