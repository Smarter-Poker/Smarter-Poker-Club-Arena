-- Keep every selectable Table Studio background writable under the
-- user_theme_settings entitlement trigger.
--
-- The UI added ten iconic places and ten graphic skins after
-- cosmetic_catalog was seeded. The trigger deliberately rejects unknown ids,
-- so all twenty tiles rendered and previewed correctly but every save failed.
-- They are premium additions: the original three free backgrounds remain the
-- only free choices, matching the estate-wide "three free, rest VIP" rule.

BEGIN;

INSERT INTO public.cosmetic_catalog (category, asset_id, tier) VALUES
  ('background_id', 'place_las_vegas', 'vip'),
  ('background_id', 'place_paris', 'vip'),
  ('background_id', 'place_london', 'vip'),
  ('background_id', 'place_tokyo', 'vip'),
  ('background_id', 'place_dubai', 'vip'),
  ('background_id', 'place_sydney', 'vip'),
  ('background_id', 'place_rio', 'vip'),
  ('background_id', 'place_santorini', 'vip'),
  ('background_id', 'place_new_york', 'vip'),
  ('background_id', 'place_monaco', 'vip'),
  ('background_id', 'skin_shadow_suits', 'vip'),
  ('background_id', 'skin_gilded_fall', 'vip'),
  ('background_id', 'skin_crimson_damask', 'vip'),
  ('background_id', 'skin_graphite_embossed', 'vip'),
  ('background_id', 'skin_obsidian_micro', 'vip'),
  ('background_id', 'skin_emerald_argyle', 'vip'),
  ('background_id', 'skin_ultraviolet_suits', 'vip'),
  ('background_id', 'skin_black_gold_chips', 'vip'),
  ('background_id', 'skin_golden_sparks', 'vip'),
  ('background_id', 'skin_platinum_deco', 'vip')
ON CONFLICT (category, asset_id) DO UPDATE SET tier = EXCLUDED.tier;

-- Preserve any extended background that reached a row before the catalog
-- caught up. This is idempotent and mirrors the original entitlement rollout.
INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT s.user_id, 'background_id', s.background_id, 'grandfathered'
  FROM public.user_theme_settings s
  JOIN public.cosmetic_catalog c
    ON c.category = 'background_id'
   AND c.asset_id = s.background_id
   AND c.tier <> 'free'
 WHERE s.user_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- A card back purchased after the original grandfather migration existed in
-- feature_purchases but not theme_asset_unlocks. The picker correctly showed
-- it as owned while the database still rejected the equip. Treat the durable
-- purchase receipt as ownership directly so current and future purchases work
-- immediately even if no secondary unlock row has been materialized yet.
CREATE OR REPLACE FUNCTION public.sp_theme_asset_is_owned(
  p_user_id  uuid,
  p_category text,
  p_asset_id text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_tier text;
  v_is_vip boolean;
BEGIN
  SELECT tier INTO v_tier
    FROM public.cosmetic_catalog
   WHERE category = p_category AND asset_id = p_asset_id;

  IF v_tier IS NULL THEN RETURN false; END IF;
  IF v_tier = 'free' THEN RETURN true; END IF;

  SELECT COALESCE(p.is_vip, false)
         AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now())
    INTO v_is_vip
    FROM public.profiles p
   WHERE p.id = p_user_id;

  IF COALESCE(v_is_vip, false) THEN RETURN true; END IF;

  IF p_category = 'cards_id' AND EXISTS (
    SELECT 1
      FROM public.feature_purchases fp
     WHERE fp.user_id = p_user_id
       AND fp.feature = 'card_back_' || p_asset_id
  ) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.theme_asset_unlocks u
     WHERE u.user_id = p_user_id
       AND u.category = p_category
       AND u.asset_id = p_asset_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sp_theme_asset_is_owned(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.sp_theme_asset_is_owned(uuid, text, text)
  TO authenticated, service_role;

DO $$
DECLARE
  v_backgrounds integer;
  v_free integer;
  v_orphans integer;
BEGIN
  SELECT count(*) INTO v_backgrounds
    FROM public.cosmetic_catalog
   WHERE category = 'background_id';
  IF v_backgrounds <> 30 THEN
    RAISE EXCEPTION 'expected 30 selectable backgrounds, found %', v_backgrounds;
  END IF;

  SELECT count(*) INTO v_free
    FROM public.cosmetic_catalog
   WHERE category = 'background_id' AND tier = 'free';
  IF v_free <> 3 THEN
    RAISE EXCEPTION 'expected exactly 3 free backgrounds, found %', v_free;
  END IF;

  SELECT count(*) INTO v_orphans
    FROM public.user_theme_settings s
   WHERE NOT public.sp_theme_asset_is_owned(s.user_id, 'theme_id', s.theme_id)
      OR NOT public.sp_theme_asset_is_owned(s.user_id, 'table_id', s.table_id)
      OR NOT public.sp_theme_asset_is_owned(s.user_id, 'button_id', s.button_id)
      OR NOT public.sp_theme_asset_is_owned(s.user_id, 'background_id', s.background_id)
      OR NOT public.sp_theme_asset_is_owned(s.user_id, 'cards_id', s.cards_id);
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '% player theme rows still contain unowned assets', v_orphans;
  END IF;
END $$;

COMMIT;
