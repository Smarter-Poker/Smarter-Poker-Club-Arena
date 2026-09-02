-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827162643; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT s.user_id,'theme_id',s.theme_id,'grandfathered' FROM public.user_theme_settings s
  JOIN public.cosmetic_catalog c ON c.category='theme_id' AND c.asset_id=s.theme_id AND c.tier<>'free'
 WHERE s.user_id IS NOT NULL ON CONFLICT DO NOTHING;

INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT s.user_id,'table_id',s.table_id,'grandfathered' FROM public.user_theme_settings s
  JOIN public.cosmetic_catalog c ON c.category='table_id' AND c.asset_id=s.table_id AND c.tier<>'free'
 WHERE s.user_id IS NOT NULL ON CONFLICT DO NOTHING;

INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT s.user_id,'button_id',s.button_id,'grandfathered' FROM public.user_theme_settings s
  JOIN public.cosmetic_catalog c ON c.category='button_id' AND c.asset_id=s.button_id AND c.tier<>'free'
 WHERE s.user_id IS NOT NULL ON CONFLICT DO NOTHING;

INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT s.user_id,'background_id',s.background_id,'grandfathered' FROM public.user_theme_settings s
  JOIN public.cosmetic_catalog c ON c.category='background_id' AND c.asset_id=s.background_id AND c.tier<>'free'
 WHERE s.user_id IS NOT NULL ON CONFLICT DO NOTHING;

INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT s.user_id,'cards_id',s.cards_id,'grandfathered' FROM public.user_theme_settings s
  JOIN public.cosmetic_catalog c ON c.category='cards_id' AND c.asset_id=s.cards_id AND c.tier<>'free'
 WHERE s.user_id IS NOT NULL ON CONFLICT DO NOTHING;

INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT DISTINCT fp.user_id,'cards_id',substring(fp.feature from 11),'purchase'
  FROM public.feature_purchases fp
 WHERE fp.feature LIKE 'card\_back\_%'
   AND EXISTS (SELECT 1 FROM public.cosmetic_catalog c WHERE c.category='cards_id' AND c.asset_id=substring(fp.feature from 11))
ON CONFLICT DO NOTHING;
