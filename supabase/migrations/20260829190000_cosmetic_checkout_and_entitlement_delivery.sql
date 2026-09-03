-- ═══════════════════════════════════════════════════════════════════════════
-- COSMETIC CHECKOUT → RECEIPT → ENTITLEMENT → LIVE TABLE, 2026-08-29
-- ═══════════════════════════════════════════════════════════════════════════
-- A cosmetic purchase is not complete when currency moves. It is complete
-- when the exact selectable asset is in the ledger consumed by Table Studio.
--
-- This migration closes three production gaps:
--   1. four shipped card backs had no server price while three dead aliases did;
--   2. VIP rewards and club table skins wrote legacy theme_unlocks rows whose
--      ids do not exist in Table Studio;
--   3. a composite theme receipt granted only theme_id, while the database
--      independently guards its felt, button, background and card back.
--
-- The server now owns a canonical ten-preset bundle catalog. Every theme SKU
-- resolves to one of those presets before purchase/redeem, and a grant writes
-- all five category-specific entitlements atomically.

-- ── 1. Server-authoritative card-back SKUs ────────────────────────────────

DELETE FROM public.feature_pricing
 WHERE feature IN ('card_back_classic', 'card_back_burgundy', 'card_back_navy');

-- A generic theme purchase names no theme and can never deliver a usable SKU.
-- Existing buyers are grandfathered below; no new anonymous "theme" is sold.
DELETE FROM public.feature_pricing WHERE feature = 'theme_unlock';

INSERT INTO public.feature_pricing (feature, diamond_cost, usage_type, description)
VALUES
  ('card_back_neon',          75,  'permanent', 'Neon card back'),
  ('card_back_galaxy',        75,  'permanent', 'Galaxy card back'),
  ('card_back_diamond',       100, 'permanent', 'Diamond card back'),
  ('card_back_dragon',        125, 'permanent', 'Dragon card back'),
  ('card_back_gold',          150, 'permanent', 'Premium Gold card back'),
  ('card_back_carbon',        175, 'permanent', 'Carbon Fiber card back'),
  ('card_back_holographic',   200, 'permanent', 'Holographic card back'),
  ('card_back_club-branded',  250, 'permanent', 'Club Crest card back'),
  ('card_back_diamond-foil',  300, 'permanent', 'Diamond Foil card back')
ON CONFLICT (feature) DO UPDATE SET
  diamond_cost = EXCLUDED.diamond_cost,
  usage_type = EXCLUDED.usage_type,
  description = EXCLUDED.description;

-- Every successful card-back receipt is mirrored into the category ledger.
-- The purchase function remains the sole price/charge authority; this trigger
-- only delivers the entitlement after its insert succeeds in the same tx.
CREATE OR REPLACE FUNCTION public.trg_deliver_card_back_entitlement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_asset_id text;
BEGIN
  IF NEW.feature LIKE 'card\_back\_%' ESCAPE '\' THEN
    v_asset_id := substring(NEW.feature from 11);
    IF EXISTS (
      SELECT 1 FROM public.cosmetic_catalog
       WHERE category = 'cards_id' AND asset_id = v_asset_id
    ) THEN
      INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
      VALUES (NEW.user_id, 'cards_id', v_asset_id, 'purchase')
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deliver_card_back_entitlement ON public.feature_purchases;
CREATE TRIGGER trg_deliver_card_back_entitlement
  AFTER INSERT ON public.feature_purchases
  FOR EACH ROW EXECUTE FUNCTION public.trg_deliver_card_back_entitlement();

-- Backfill receipts written before the delivery trigger existed.
INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT DISTINCT fp.user_id, 'cards_id', substring(fp.feature from 11), 'purchase'
  FROM public.feature_purchases fp
  JOIN public.cosmetic_catalog c
    ON c.category = 'cards_id' AND c.asset_id = substring(fp.feature from 11)
 WHERE fp.feature LIKE 'card\_back\_%' ESCAPE '\'
ON CONFLICT DO NOTHING;

-- ── 2. Canonical composite-preset catalog ────────────────────────────────

CREATE TABLE IF NOT EXISTS public.theme_preset_catalog (
  theme_id       text PRIMARY KEY,
  display_name   text NOT NULL,
  table_id       text NOT NULL,
  button_id      text NOT NULL,
  background_id  text NOT NULL,
  cards_id       text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.theme_preset_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.theme_preset_catalog FROM PUBLIC, anon, authenticated;

INSERT INTO public.theme_preset_catalog
  (theme_id, display_name, table_id, button_id, background_id, cards_id)
VALUES
  ('default-dark',    'House Classic',  'classic_green',    'classic-white',  'midnight',       'classic_red'),
  ('classic-brown',   'Carbon Club',    'carbon_red',       'gray-d-gear',    'midnight',       'classic_red'),
  ('neon-blue',       'Neon Ice',       'ice_cavern',       'blue-crystal',   'galaxy',         'classic_blue'),
  ('rustic-wood',     'Golden Dusk',    'golden_sand',      'gold-star',      'golden_dusk',    'gold'),
  ('casino-green',    'Jade Casino',    'jade_city',        'gold-star',      'jade_neon',      'carbon'),
  ('ocean-depths',    'Ocean Suite',    'ocean_blue',       'classic-white',  'royal_indigo',   'classic_blue'),
  ('crimson-club',    'Crimson Club',   'crimson',          'red-d-gear',     'crimson_lounge', 'classic_red'),
  ('arctic-suite',    'Arctic Suite',   'arctic_white',     'ocean-pearl',    'ice_frost',      'diamond-foil'),
  ('amethyst-night',  'Amethyst Night', 'amethyst_cavern',  'amethyst-chip',  'royal_indigo',   'royal'),
  ('carbon-ion',      'Carbon Ion',     'carbon_ion',       'carbon-ion',     'carbon_grid',    'carbon')
ON CONFLICT (theme_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  table_id = EXCLUDED.table_id,
  button_id = EXCLUDED.button_id,
  background_id = EXCLUDED.background_id,
  cards_id = EXCLUDED.cards_id;

CREATE TABLE IF NOT EXISTS public.theme_preset_aliases (
  alias     text PRIMARY KEY,
  theme_id  text NOT NULL REFERENCES public.theme_preset_catalog(theme_id) ON DELETE CASCADE
);

ALTER TABLE public.theme_preset_aliases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.theme_preset_aliases FROM PUBLIC, anon, authenticated;

INSERT INTO public.theme_preset_aliases (alias, theme_id) VALUES
  ('neon',            'neon-blue'),
  ('midnight_casino', 'carbon-ion'),
  ('cosmic',          'amethyst-night'),
  ('midnight_felt',   'carbon-ion'),
  ('midnight_a',      'carbon-ion'),
  ('royal_gold',      'rustic-wood'),
  ('royal_b',         'rustic-wood')
ON CONFLICT (alias) DO UPDATE SET theme_id = EXCLUDED.theme_id;

CREATE OR REPLACE FUNCTION public.sp_resolve_theme_preset(p_theme_id text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT COALESCE(
    (SELECT p.theme_id FROM public.theme_preset_catalog p WHERE p.theme_id = p_theme_id),
    (SELECT a.theme_id FROM public.theme_preset_aliases a WHERE a.alias = p_theme_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.sp_grant_theme_preset(
  p_user_id uuid,
  p_theme_id text,
  p_unlock_method text DEFAULT 'grant'
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_preset public.theme_preset_catalog%ROWTYPE;
BEGIN
  SELECT p.* INTO v_preset
    FROM public.theme_preset_catalog p
   WHERE p.theme_id = public.sp_resolve_theme_preset(p_theme_id);
  IF v_preset.theme_id IS NULL THEN RETURN NULL; END IF;

  INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
  VALUES
    (p_user_id, 'theme_id',      v_preset.theme_id,      p_unlock_method),
    (p_user_id, 'table_id',      v_preset.table_id,      p_unlock_method),
    (p_user_id, 'button_id',     v_preset.button_id,     p_unlock_method),
    (p_user_id, 'background_id', v_preset.background_id, p_unlock_method),
    (p_user_id, 'cards_id',      v_preset.cards_id,      p_unlock_method)
  ON CONFLICT DO NOTHING;

  -- Compatibility receipt for older World Hub readers. Table Studio and the
  -- entitlement guard use theme_asset_unlocks above.
  INSERT INTO public.theme_unlocks (user_id, theme_id, unlock_method)
  VALUES (p_user_id, v_preset.theme_id, p_unlock_method)
  ON CONFLICT (user_id, theme_id) DO NOTHING;

  RETURN v_preset.theme_id;
END;
$$;

REVOKE ALL ON FUNCTION public.sp_resolve_theme_preset(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sp_grant_theme_preset(uuid, text, text) FROM PUBLIC, anon, authenticated;

-- ── 3. Server-authoritative 97-avatar library and style SKUs ─────────────

-- Club owners previously typed arbitrary avatar ids into a free-text field.
-- Production contains "crown", which is not one of the 97 shipped avatars;
-- purchasers therefore received a ledger row that no gallery tile could use.
CREATE TABLE IF NOT EXISTS public.avatar_shop_catalog (
  avatar_id text PRIMARY KEY
);

ALTER TABLE public.avatar_shop_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.avatar_shop_catalog FROM PUBLIC, anon, authenticated;

INSERT INTO public.avatar_shop_catalog (avatar_id)
SELECT 'free-people-' || lpad(n::text, 3, '0')
  FROM unnest(ARRAY[1,2,3,7,8]) AS n
UNION ALL
SELECT 'free-animal-' || lpad(n::text, 3, '0') FROM generate_series(1,6) AS n
UNION ALL
SELECT 'free-arch-' || lpad(n::text, 3, '0') FROM generate_series(1,8) AS n
UNION ALL
SELECT 'free-mix-' || lpad(n::text, 3, '0') FROM generate_series(1,4) AS n
UNION ALL
SELECT 'vip-people-' || lpad(n::text, 3, '0') FROM generate_series(1,20) AS n
UNION ALL
SELECT 'vip-fantasy-' || lpad(n::text, 3, '0')
  FROM unnest(ARRAY[1,4,5,6,7,8,9,10,11,12,13,14,15]) AS n
UNION ALL
SELECT 'vip-animal-' || lpad(n::text, 3, '0') FROM generate_series(1,10) AS n
UNION ALL
SELECT 'vip-culture-' || lpad(n::text, 3, '0') FROM generate_series(1,5) AS n
UNION ALL
SELECT 'vip-new-' || lpad(n::text, 3, '0') FROM generate_series(1,26) AS n
ON CONFLICT (avatar_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.avatar_shop_aliases (
  alias text PRIMARY KEY,
  avatar_id text NOT NULL REFERENCES public.avatar_shop_catalog(avatar_id) ON DELETE CASCADE
);

ALTER TABLE public.avatar_shop_aliases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.avatar_shop_aliases FROM PUBLIC, anon, authenticated;

INSERT INTO public.avatar_shop_aliases (alias, avatar_id) VALUES
  ('shark', 'free-animal-001'),
  ('crown', 'vip-people-007')
ON CONFLICT (alias) DO UPDATE SET avatar_id = EXCLUDED.avatar_id;

-- VIP rewards also sell the six CSS styles rendered by AvatarGallery. They
-- are not avatar-library rows, so keep a distinct server catalog while using
-- the same avatar_unlocks entitlement ledger.
CREATE TABLE IF NOT EXISTS public.avatar_style_catalog (
  unlock_token text PRIMARY KEY
);

ALTER TABLE public.avatar_style_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.avatar_style_catalog FROM PUBLIC, anon, authenticated;

INSERT INTO public.avatar_style_catalog (unlock_token) VALUES
  ('frame_gold'),
  ('frame_diamond'),
  ('frame_cyber'),
  ('frame_hellfire'),
  ('aura_fire'),
  ('aura_glitch')
ON CONFLICT (unlock_token) DO NOTHING;

CREATE OR REPLACE FUNCTION public.sp_resolve_avatar_shop_sku(p_avatar_id text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT COALESCE(
    (SELECT c.avatar_id FROM public.avatar_shop_catalog c WHERE c.avatar_id = p_avatar_id),
    (SELECT a.avatar_id FROM public.avatar_shop_aliases a WHERE a.alias = p_avatar_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.sp_resolve_avatar_entitlement(p_avatar_id text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT COALESCE(
    public.sp_resolve_avatar_shop_sku(p_avatar_id),
    (SELECT s.unlock_token FROM public.avatar_style_catalog s WHERE s.unlock_token = p_avatar_id)
  );
$$;

REVOKE ALL ON FUNCTION public.sp_resolve_avatar_shop_sku(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sp_resolve_avatar_entitlement(text)
  FROM PUBLIC, anon, authenticated;

-- Normalize the two legacy aliases already sold by clubs. The Crown card now
-- names the real Royal Monarch artwork it grants.
UPDATE public.club_shop_items
   SET name = 'Royal Monarch Avatar'
 WHERE grant_spec->>'type' = 'avatar'
   AND grant_spec->>'avatar_id' = 'crown'
   AND name = 'Crown Avatar';

UPDATE public.club_shop_items i
   SET grant_spec = jsonb_set(i.grant_spec, '{avatar_id}', to_jsonb(a.avatar_id), true)
  FROM public.avatar_shop_aliases a
 WHERE COALESCE(i.grant_spec->>'type', '') = 'avatar'
   AND i.grant_spec->>'avatar_id' = a.alias;

-- ── 4. Prevent future club products from storing invented cosmetic ids ───

-- Normalize all known legacy shop SKUs before installing the write guard.
UPDATE public.club_shop_items i
   SET grant_spec = jsonb_set(i.grant_spec, '{theme_id}', to_jsonb(a.theme_id), true)
  FROM public.theme_preset_aliases a
 WHERE COALESCE(i.grant_spec->>'type', '') = 'table_skin'
   AND i.grant_spec->>'theme_id' = a.alias;

CREATE OR REPLACE FUNCTION public.trg_validate_shop_theme_preset()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_theme_id text;
  v_avatar_id text;
BEGIN
  IF COALESCE(NEW.grant_spec->>'type', '') = 'table_skin' THEN
    v_theme_id := public.sp_resolve_theme_preset(NEW.grant_spec->>'theme_id');
    IF v_theme_id IS NULL THEN
      RAISE EXCEPTION 'Unknown Table Studio theme "%"', NEW.grant_spec->>'theme_id'
        USING ERRCODE = '23514';
    END IF;
    NEW.grant_spec := jsonb_set(NEW.grant_spec, '{theme_id}', to_jsonb(v_theme_id), true);
  ELSIF COALESCE(NEW.grant_spec->>'type', '') = 'avatar' THEN
    v_avatar_id := public.sp_resolve_avatar_shop_sku(NEW.grant_spec->>'avatar_id');
    IF v_avatar_id IS NULL THEN
      RAISE EXCEPTION 'Unknown avatar-library SKU "%"', NEW.grant_spec->>'avatar_id'
        USING ERRCODE = '23514';
    END IF;
    NEW.grant_spec := jsonb_set(NEW.grant_spec, '{avatar_id}', to_jsonb(v_avatar_id), true);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_shop_theme_preset ON public.club_shop_items;
CREATE TRIGGER trg_validate_shop_theme_preset
  BEFORE INSERT OR UPDATE OF grant_spec ON public.club_shop_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_validate_shop_theme_preset();

-- ── 5. Club redemption delivers a complete preset or real avatar ─────────

CREATE OR REPLACE FUNCTION public.fn_redeem_shop_item(p_inventory_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row     public.club_shop_inventory;
  v_spec    jsonb;
  v_type    text;
  v_qty     integer;
  v_ref     text;
  v_uid     uuid := auth.uid();
  v_found   boolean;
  v_granted jsonb := jsonb_build_object('type', 'none');
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  SELECT * INTO v_row FROM public.club_shop_inventory
   WHERE id = p_inventory_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found');
  END IF;
  IF v_row.user_id <> v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  IF v_row.status = 'redeemed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_redeemed');
  END IF;

  SELECT grant_spec INTO v_spec FROM public.club_shop_items WHERE id = v_row.item_id;
  v_found := FOUND;
  IF NOT v_found THEN
    RETURN jsonb_build_object('success', false, 'error', 'item_gone');
  END IF;

  v_type := COALESCE(v_spec->>'type', 'none');
  BEGIN
    v_qty := GREATEST(1, LEAST(1000, COALESCE((v_spec->>'qty')::integer, 1)));
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_grant_quantity');
  END;

  -- Validate permanent references BEFORE consuming the inventory row.
  IF v_type = 'table_skin' THEN
    v_ref := public.sp_resolve_theme_preset(v_spec->>'theme_id');
    IF v_ref IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_theme_sku');
    END IF;
  ELSIF v_type = 'avatar' THEN
    v_ref := public.sp_resolve_avatar_shop_sku(v_spec->>'avatar_id');
    IF v_ref IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_avatar_sku');
    END IF;
  END IF;

  IF v_type = 'time_bank' THEN
    INSERT INTO public.feature_purchases
      (user_id, feature, cost, usage_type, uses_remaining, expires_at)
    VALUES (v_uid, 'time_bank_seconds', 0, 'per_use', v_qty, NULL);
    v_granted := jsonb_build_object('type', 'time_bank', 'uses', v_qty, 'seconds', v_qty * 20);

  ELSIF v_type = 'throwable' THEN
    INSERT INTO public.feature_purchases
      (user_id, feature, cost, usage_type, uses_remaining, expires_at)
    VALUES (v_uid, 'throwable', 0, 'per_use', v_qty, NULL);
    v_granted := jsonb_build_object('type', 'throwable', 'uses', v_qty);

  ELSIF v_type = 'emote_pack' THEN
    INSERT INTO public.feature_purchases
      (user_id, feature, cost, usage_type, uses_remaining, expires_at)
    VALUES (v_uid, 'emoji_pack', 0, 'permanent', NULL, NULL);
    v_granted := jsonb_build_object('type', 'emote_pack', 'permanent', true);

  ELSIF v_type = 'table_skin' THEN
    PERFORM public.sp_grant_theme_preset(v_uid, v_ref, 'club_shop');
    v_granted := jsonb_build_object(
      'type', 'table_skin', 'permanent', true, 'theme_id', v_ref
    );

  ELSIF v_type = 'avatar' THEN
    INSERT INTO public.avatar_unlocks (user_id, avatar_id, unlock_method)
    VALUES (v_uid, v_ref, 'club_shop') ON CONFLICT DO NOTHING;
    v_granted := jsonb_build_object('type', 'avatar', 'avatar_id', v_ref);
  END IF;

  UPDATE public.club_shop_inventory
     SET status = 'redeemed', redeemed_at = now()
   WHERE id = p_inventory_id;

  RETURN jsonb_build_object(
    'success', true,
    'user_id', v_uid,
    'item_name', v_row.item_name,
    'granted', v_granted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_redeem_shop_item(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_redeem_shop_item(uuid) TO authenticated, service_role;

-- ── 6. VIP rewards deliver valid presets and rendered avatar styles ──────

UPDATE public.vip_reward_catalog SET grant_ref = 'neon-blue'      WHERE id = 'theme-neon';
UPDATE public.vip_reward_catalog SET grant_ref = 'carbon-ion'     WHERE id = 'theme-midnight';
UPDATE public.vip_reward_catalog SET grant_ref = 'amethyst-night' WHERE id = 'theme-cosmic';
UPDATE public.vip_reward_catalog
   SET name = 'Gold Avatar Frame',
       description = 'Exclusive gold avatar frame',
       grant_ref = 'frame_gold'
 WHERE id = 'avatar-gold-frame';
UPDATE public.vip_reward_catalog
   SET name = 'Hellfire Avatar Frame',
       description = 'Animated premium hellfire avatar frame',
       grant_ref = 'frame_hellfire'
 WHERE id = 'avatar-royal-crown';
UPDATE public.vip_reward_catalog
   SET name = 'Diamond Avatar Frame',
       description = 'Premium faceted diamond avatar frame',
       grant_ref = 'frame_diamond'
 WHERE id = 'avatar-diamond-halo';

CREATE OR REPLACE FUNCTION public.fn_redeem_vip_points(
  p_cost bigint,
  p_reason text DEFAULT 'Reward redemption',
  p_reward_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_bal       bigint;
  v_reward    record;
  v_cost      bigint;
  v_status    text := 'pending';
  v_theme_id  text;
  v_avatar_id text;
  v_granted   jsonb := jsonb_build_object('type', 'none');
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  IF p_reward_id IS NOT NULL THEN
    SELECT * INTO v_reward FROM public.vip_reward_catalog
     WHERE id = p_reward_id AND is_active;
    IF v_reward.id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'unknown_reward');
    END IF;
    v_cost := v_reward.points_cost;
    IF v_reward.grant_type = 'theme' THEN
      v_theme_id := public.sp_resolve_theme_preset(v_reward.grant_ref);
      IF v_theme_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_reward_sku');
      END IF;
    ELSIF v_reward.grant_type = 'avatar' THEN
      v_avatar_id := public.sp_resolve_avatar_entitlement(v_reward.grant_ref);
      IF v_avatar_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_reward_sku');
      END IF;
    END IF;
  ELSE
    v_cost := p_cost;
  END IF;

  IF v_cost IS NULL OR v_cost <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_cost');
  END IF;

  IF p_reward_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('fn_redeem_vip_points:' || v_uid::text || ':' || p_reward_id, 0)
    );
    IF v_reward.stock IS NOT NULL AND v_reward.stock <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'sold_out');
    END IF;
    IF v_reward.grant_type = 'theme' AND EXISTS (
      SELECT 1 FROM public.theme_asset_unlocks
       WHERE user_id = v_uid AND category = 'theme_id' AND asset_id = v_theme_id
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_owned', 'already_owned', true);
    END IF;
    IF v_reward.grant_type = 'avatar' AND EXISTS (
      SELECT 1 FROM public.avatar_unlocks
       WHERE user_id = v_uid AND avatar_id = v_avatar_id
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_owned', 'already_owned', true);
    END IF;
  END IF;

  SELECT current_points INTO v_bal FROM public.vip_points
   WHERE user_id = v_uid FOR UPDATE;
  IF COALESCE(v_bal, 0) < v_cost THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'insufficient_points', 'balance', COALESCE(v_bal, 0)
    );
  END IF;

  UPDATE public.vip_points
     SET current_points = current_points - v_cost, updated_at = now()
   WHERE user_id = v_uid;
  INSERT INTO public.vip_points_ledger (user_id, points, reason, source_type, source_id)
  VALUES (v_uid, -v_cost, p_reason, 'redeem', gen_random_uuid());

  IF p_reward_id IS NOT NULL THEN
    IF v_reward.grant_type = 'theme' THEN
      PERFORM public.sp_grant_theme_preset(v_uid, v_theme_id, 'vip_points');
      v_status := 'granted';
      v_granted := jsonb_build_object('type', 'theme', 'theme_id', v_theme_id);
    ELSIF v_reward.grant_type = 'avatar' THEN
      INSERT INTO public.avatar_unlocks (user_id, avatar_id, unlock_method)
      VALUES (v_uid, v_avatar_id, 'vip_points') ON CONFLICT DO NOTHING;
      v_status := 'granted';
      v_granted := jsonb_build_object('type', 'avatar', 'avatar_id', v_avatar_id);
    END IF;

    IF v_reward.stock IS NOT NULL THEN
      UPDATE public.vip_reward_catalog SET stock = stock - 1 WHERE id = p_reward_id;
    END IF;
    INSERT INTO public.vip_reward_claims (user_id, reward_id, points_spent, status)
    VALUES (v_uid, p_reward_id, v_cost, v_status);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'balance', COALESCE(v_bal, 0) - v_cost,
    'charged', v_cost,
    'status', CASE WHEN p_reward_id IS NULL THEN NULL ELSE v_status END,
    'granted', v_granted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_redeem_vip_points(bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_redeem_vip_points(bigint, text, text)
  TO authenticated, service_role;

-- ── 7. Grandfather every receipt already sold/redeemed ───────────────────

DO $$
DECLARE
  r record;
  v_theme_id text;
BEGIN
  -- Old specific receipts (VIP rewards and club items).
  FOR r IN SELECT user_id, theme_id, unlock_method FROM public.theme_unlocks LOOP
    v_theme_id := public.sp_resolve_theme_preset(r.theme_id);
    IF v_theme_id IS NOT NULL THEN
      PERFORM public.sp_grant_theme_preset(r.user_id, v_theme_id, COALESCE(r.unlock_method, 'legacy'));
    END IF;
  END LOOP;

  -- A generic diamond purchase never recorded a chosen id. Grant one complete
  -- premium preset so every person previously charged receives usable value.
  FOR r IN
    SELECT DISTINCT user_id FROM public.feature_purchases WHERE feature = 'theme_unlock'
  LOOP
    PERFORM public.sp_grant_theme_preset(r.user_id, 'neon-blue', 'legacy_purchase');
  END LOOP;

  -- Claims are the durable receipt even if their old theme_unlock row was
  -- deleted or failed to write.
  FOR r IN
    SELECT c.user_id, c.reward_id, v.grant_ref
      FROM public.vip_reward_claims c
      JOIN public.vip_reward_catalog v ON v.id = c.reward_id
     WHERE c.status IN ('granted', 'fulfilled') AND v.grant_type = 'theme'
  LOOP
    PERFORM public.sp_grant_theme_preset(r.user_id, r.grant_ref, 'vip_points_backfill');
  END LOOP;

  -- Redeemed inventory is likewise a receipt and must remain usable.
  FOR r IN
    SELECT inv.user_id, item.grant_spec->>'theme_id' AS theme_id
      FROM public.club_shop_inventory inv
      JOIN public.club_shop_items item ON item.id = inv.item_id
     WHERE inv.status = 'redeemed' AND item.grant_spec->>'type' = 'table_skin'
  LOOP
    PERFORM public.sp_grant_theme_preset(r.user_id, r.theme_id, 'club_shop_backfill');
  END LOOP;

  -- Old avatar aliases and invented VIP style ids are durable receipts too.
  -- Keep their historical rows and add the canonical usable entitlement.
  INSERT INTO public.avatar_unlocks (user_id, avatar_id, unlock_method)
  SELECT user_id,
         CASE avatar_id
           WHEN 'shark' THEN 'free-animal-001'
           WHEN 'crown' THEN 'vip-people-007'
           WHEN 'gold_frame' THEN 'frame_gold'
           WHEN 'royal_crown' THEN 'frame_hellfire'
           WHEN 'diamond_halo' THEN 'frame_diamond'
         END,
         COALESCE(unlock_method, 'legacy')
    FROM public.avatar_unlocks
   WHERE avatar_id IN ('shark', 'crown', 'gold_frame', 'royal_crown', 'diamond_halo')
  ON CONFLICT DO NOTHING;

  -- A claim remains proof of purchase even if its old unlock insert was lost.
  INSERT INTO public.avatar_unlocks (user_id, avatar_id, unlock_method)
  SELECT c.user_id, public.sp_resolve_avatar_entitlement(v.grant_ref), 'vip_points_backfill'
    FROM public.vip_reward_claims c
    JOIN public.vip_reward_catalog v ON v.id = c.reward_id
   WHERE c.status IN ('granted', 'fulfilled')
     AND v.grant_type = 'avatar'
     AND public.sp_resolve_avatar_entitlement(v.grant_ref) IS NOT NULL
  ON CONFLICT DO NOTHING;

  -- The redeemed inventory row is the receipt for historical club purchases.
  INSERT INTO public.avatar_unlocks (user_id, avatar_id, unlock_method)
  SELECT inv.user_id,
         public.sp_resolve_avatar_shop_sku(item.grant_spec->>'avatar_id'),
         'club_shop_backfill'
    FROM public.club_shop_inventory inv
    JOIN public.club_shop_items item ON item.id = inv.item_id
   WHERE inv.status = 'redeemed'
     AND item.grant_spec->>'type' = 'avatar'
     AND public.sp_resolve_avatar_shop_sku(item.grant_spec->>'avatar_id') IS NOT NULL
  ON CONFLICT DO NOTHING;
END;
$$;

-- ── 8. Post-apply proofs ──────────────────────────────────────────────────

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.theme_preset_catalog;
  IF v_count <> 10 THEN
    RAISE EXCEPTION 'theme_preset_catalog has % rows, expected 10', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.avatar_shop_catalog;
  IF v_count <> 97 THEN
    RAISE EXCEPTION 'avatar_shop_catalog has % rows, expected the shipped 97', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.avatar_style_catalog;
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'avatar_style_catalog has % rows, expected 6', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM public.theme_preset_catalog p
   WHERE NOT EXISTS (SELECT 1 FROM public.cosmetic_catalog c WHERE c.category='theme_id' AND c.asset_id=p.theme_id)
      OR NOT EXISTS (SELECT 1 FROM public.cosmetic_catalog c WHERE c.category='table_id' AND c.asset_id=p.table_id)
      OR NOT EXISTS (SELECT 1 FROM public.cosmetic_catalog c WHERE c.category='button_id' AND c.asset_id=p.button_id)
      OR NOT EXISTS (SELECT 1 FROM public.cosmetic_catalog c WHERE c.category='background_id' AND c.asset_id=p.background_id)
      OR NOT EXISTS (SELECT 1 FROM public.cosmetic_catalog c WHERE c.category='cards_id' AND c.asset_id=p.cards_id);
  IF v_count <> 0 THEN
    RAISE EXCEPTION '% theme preset bundle(s) reference an unknown cosmetic', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.feature_pricing
   WHERE feature LIKE 'card\_back\_%' ESCAPE '\';
  IF v_count <> 9 THEN
    RAISE EXCEPTION 'feature_pricing has % paid card backs, expected 9', v_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.club_shop_items
     WHERE grant_spec->>'type' = 'table_skin'
       AND public.sp_resolve_theme_preset(grant_spec->>'theme_id') IS NULL
  ) THEN
    RAISE EXCEPTION 'club shop still contains an invalid table theme SKU';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.club_shop_items
     WHERE grant_spec->>'type' = 'avatar'
       AND public.sp_resolve_avatar_shop_sku(grant_spec->>'avatar_id') IS NULL
  ) THEN
    RAISE EXCEPTION 'club shop still contains an invalid avatar SKU';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.vip_reward_catalog
     WHERE grant_type = 'theme'
       AND public.sp_resolve_theme_preset(grant_ref) IS NULL
  ) THEN
    RAISE EXCEPTION 'VIP rewards still contain an invalid table theme SKU';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.vip_reward_catalog
     WHERE grant_type = 'avatar'
       AND public.sp_resolve_avatar_entitlement(grant_ref) IS NULL
  ) THEN
    RAISE EXCEPTION 'VIP rewards still contain an invalid avatar/style SKU';
  END IF;
END;
$$;
