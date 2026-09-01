-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827162934; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The three-free guard's own assertion caught these before it could lock
-- anyone out: one player still carries pre-2026-08-18 ids that no catalog
-- knows. The CLIENT has always rendered them through its legacy alias maps
-- (tableAssets.ts TABLE_SKINS / TABLE_BACKGROUNDS, CardImage CARD_BACK_ALIASES),
-- so the row and the felt already disagreed. Normalize each to the id the
-- player is ACTUALLY looking at, which is also what makes "keep what they
-- have" true rather than approximately true.
--
--   background 'diamond-pattern' -> 'midnight'      (free)
--   cards      'red'             -> 'classic_red'   (free)
--   table      'dark-felt'       -> 'neon_city'     (VIP -> granted below)

UPDATE public.user_theme_settings SET background_id = 'midnight'    WHERE background_id = 'diamond-pattern';
UPDATE public.user_theme_settings SET background_id = 'carbon_grid' WHERE background_id = 'stone-concrete';
UPDATE public.user_theme_settings SET background_id = 'galaxy'      WHERE background_id = 'galaxy-nebula';
UPDATE public.user_theme_settings SET background_id = 'golden_dusk' WHERE background_id = 'hardwood-floor';
UPDATE public.user_theme_settings SET background_id = 'jade_neon'   WHERE background_id = 'teal-tile';

UPDATE public.user_theme_settings SET cards_id = 'classic_red'  WHERE cards_id IN ('red','classic','burgundy');
UPDATE public.user_theme_settings SET cards_id = 'classic_blue' WHERE cards_id IN ('blue','black','navy');
UPDATE public.user_theme_settings SET cards_id = 'royal'        WHERE cards_id = 'white';

UPDATE public.user_theme_settings SET table_id = 'neon_city' WHERE table_id = 'dark-felt';

-- Now grandfather anything that normalized onto a VIP asset.
INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT s.user_id,'background_id',s.background_id,'grandfathered' FROM public.user_theme_settings s
  JOIN public.cosmetic_catalog c ON c.category='background_id' AND c.asset_id=s.background_id AND c.tier<>'free'
 WHERE s.user_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT s.user_id,'cards_id',s.cards_id,'grandfathered' FROM public.user_theme_settings s
  JOIN public.cosmetic_catalog c ON c.category='cards_id' AND c.asset_id=s.cards_id AND c.tier<>'free'
 WHERE s.user_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT s.user_id,'table_id',s.table_id,'grandfathered' FROM public.user_theme_settings s
  JOIN public.cosmetic_catalog c ON c.category='table_id' AND c.asset_id=s.table_id AND c.tier<>'free'
 WHERE s.user_id IS NOT NULL ON CONFLICT DO NOTHING;

-- Every equipped value must now be a known catalog id.
DO $$
DECLARE v_unknown integer;
BEGIN
  WITH cols AS (
    SELECT user_id,'theme_id' cat, theme_id val FROM public.user_theme_settings
    UNION ALL SELECT user_id,'table_id',table_id FROM public.user_theme_settings
    UNION ALL SELECT user_id,'button_id',button_id FROM public.user_theme_settings
    UNION ALL SELECT user_id,'background_id',background_id FROM public.user_theme_settings
    UNION ALL SELECT user_id,'cards_id',cards_id FROM public.user_theme_settings
  )
  SELECT count(*) INTO v_unknown FROM cols c
   WHERE c.val IS NOT NULL AND btrim(c.val) <> ''
     AND NOT EXISTS (SELECT 1 FROM public.cosmetic_catalog k WHERE k.category=c.cat AND k.asset_id=c.val);
  IF v_unknown > 0 THEN
    RAISE EXCEPTION '% equipped value(s) are not in the catalog after normalization', v_unknown;
  END IF;
END $$;
