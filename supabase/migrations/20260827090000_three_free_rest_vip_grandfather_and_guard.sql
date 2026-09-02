-- ═══════════════════════════════════════════════════════════════════════════
--  THREE FREE, THE REST VIP — GRANDFATHERED, THEN ENFORCED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan 2026-08-27: "WE HAVE CUSTOMIZABLE SKINS, TABLES, CARD BACKS ETC... CHOSE
-- 3 THAT ARE FREE TO INTERCHANGE AND USE, AND THE REST ARE VIP LOCKED FOR ALL
-- CUSTOMIZABLE FUNCTIONS AND FEATURES." And, on what happens to players who
-- already equipped something that is about to lock: "Keep what they have."
--
-- TWO STEPS, IN THIS ORDER, AND THE ORDER IS THE WHOLE POINT.
--
--   1. GRANDFATHER FIRST. Every currently-equipped choice is written into the
--      ledger as owned, for every player, before any rule exists that could
--      refuse it. A player's felt must never change underneath them because we
--      changed a price list.
--   2. GUARD SECOND. A BEFORE INSERT/UPDATE trigger on user_theme_settings
--      that refuses a value the player is not entitled to.
--
-- WHY THE GUARD IS NOT OPTIONAL. Until now NOTHING enforced any of this
-- server-side: user_theme_settings has no CHECK, no trigger, and an RLS policy
-- that checks only `auth.uid() = user_id` (ownership of the ROW, not
-- entitlement to the VALUE). Both writers are direct PostgREST upserts. So a
-- devtools user could equip every VIP cosmetic permanently with one request,
-- and the World Hub writes the same table, so a client-side rule in Club Arena
-- alone was bypassable from the other app. The precedent copied here verbatim
-- is 20260825120000_avatar_cosmetics_ownership_guard.sql, whose header says it
-- best: "A picker that greys out an unowned tile is a locked door in a
-- building with no walls."
--
-- THE CATALOG LIVES IN ONE PLACE. `cosmetic_catalog` below is the single
-- source of truth for which id is free and which is VIP, so the TypeScript
-- catalogs and this guard cannot drift into disagreeing about what a player
-- owns. A CI check (scripts/ci/check-cosmetic-catalog-drift.mjs) fails the
-- build if they do.
--
-- ── HOW THIS WAS APPLIED TO PRODUCTION, 2026-08-27 ────────────────────────
-- Applied via the Supabase MCP as FOUR ordered migrations rather than one,
-- deliberately: the grandfather step had to be provably complete and
-- inspectable before the guard existed, and the guard's own assertion had to
-- be free to fail without rolling back the grants.
--
--   three_free_rest_vip_part1_catalog        sections 0-2
--   three_free_rest_vip_part2_grandfather    section 3
--   three_free_rest_vip_part2b_normalize_legacy_ids   (see below)
--   three_free_rest_vip_part3_guard          sections 4-6
--
-- PART 2b EXISTS BECAUSE THE ASSERTION CAUGHT A REAL PLAYER. The first guard
-- attempt refused to install: one live player still carried pre-2026-08-18
-- ids (`dark-felt`, `diamond-pattern`, `red`) that no catalog knows, because
-- the CLIENT has always resolved those through legacy alias maps while the
-- stored row kept the old spelling. Failing closed on an unknown id is
-- correct (that is how a typo never becomes a permanent cosmetic), so the fix
-- was to normalize each row to the id the player is ACTUALLY looking at
-- (dark-felt renders neon_city, which is VIP, so that player was granted it)
-- rather than to weaken the rule. This file keeps all of it in one place for
-- a fresh environment; the split is only how it reached production.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 0. THE CATALOG
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cosmetic_catalog (
  -- Which user_theme_settings column this id belongs to.
  category   text NOT NULL CHECK (category IN
                 ('theme_id', 'table_id', 'button_id', 'background_id', 'cards_id')),
  asset_id   text NOT NULL,
  -- 'free'  : anyone may equip it, always.
  -- 'vip'   : VIP members, or a player holding an explicit unlock row.
  tier       text NOT NULL CHECK (tier IN ('free', 'vip')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (category, asset_id)
);

ALTER TABLE public.cosmetic_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cosmetic_catalog_read ON public.cosmetic_catalog;
-- The catalog is a price list. Everyone may read it; nobody but the service
-- role may write it (no INSERT/UPDATE/DELETE policy exists, so RLS denies).
CREATE POLICY cosmetic_catalog_read ON public.cosmetic_catalog
  FOR SELECT TO anon, authenticated USING (true);

GRANT SELECT ON public.cosmetic_catalog TO anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. SEED IT — mirrors the TypeScript catalogs exactly (see the CI drift check)
-- ───────────────────────────────────────────────────────────────────────────

INSERT INTO public.cosmetic_catalog (category, asset_id, tier) VALUES
  -- Theme presets (THEME_PRESETS in ThemeSettingsModal.tsx): 3 free of 10
  ('theme_id', 'default-dark', 'free'),
  ('theme_id', 'classic-brown', 'free'),
  ('theme_id', 'ocean-depths', 'free'),
  ('theme_id', 'neon-blue', 'vip'),
  ('theme_id', 'rustic-wood', 'vip'),
  ('theme_id', 'casino-green', 'vip'),
  ('theme_id', 'crimson-club', 'vip'),
  ('theme_id', 'arctic-suite', 'vip'),
  ('theme_id', 'amethyst-night', 'vip'),
  ('theme_id', 'carbon-ion', 'vip'),
  -- Table felts (FELT_META in tableTheme.ts): 3 free of 13
  ('table_id', 'classic_green', 'free'),
  ('table_id', 'ocean_blue', 'free'),
  ('table_id', 'carbon_red', 'free'),
  ('table_id', 'neon_city', 'vip'),
  ('table_id', 'ice_cavern', 'vip'),
  ('table_id', 'arctic_white', 'vip'),
  ('table_id', 'mahogany_red', 'vip'),
  ('table_id', 'crimson', 'vip'),
  ('table_id', 'electric_purple', 'vip'),
  ('table_id', 'golden_sand', 'vip'),
  ('table_id', 'jade_city', 'vip'),
  ('table_id', 'amethyst_cavern', 'vip'),
  ('table_id', 'carbon_ion', 'vip'),
  -- Dealer buttons (BUTTON_ASSETS): 3 free of 10
  ('button_id', 'classic-white', 'free'),
  ('button_id', 'red-d-gear', 'free'),
  ('button_id', 'gray-d-gear', 'free'),
  ('button_id', 'blue-crystal', 'vip'),
  ('button_id', 'gold-star', 'vip'),
  ('button_id', 'sports-themed', 'vip'),
  ('button_id', 'jade-seal', 'vip'),
  ('button_id', 'amethyst-chip', 'vip'),
  ('button_id', 'carbon-ion', 'vip'),
  ('button_id', 'ocean-pearl', 'vip'),
  -- Backgrounds (BACKGROUND_META): 3 free of 10
  ('background_id', 'midnight', 'free'),
  ('background_id', 'royal_indigo', 'free'),
  ('background_id', 'emerald_room', 'free'),
  ('background_id', 'crimson_lounge', 'vip'),
  ('background_id', 'ocean_abyss', 'vip'),
  ('background_id', 'golden_dusk', 'vip'),
  ('background_id', 'galaxy', 'vip'),
  ('background_id', 'carbon_grid', 'vip'),
  ('background_id', 'ice_frost', 'vip'),
  ('background_id', 'jade_neon', 'vip'),
  -- Card backs (CARD_BACK_CATALOG): 3 free of 12
  ('cards_id', 'classic_blue', 'free'),
  ('cards_id', 'classic_red', 'free'),
  ('cards_id', 'royal', 'free'),
  ('cards_id', 'gold', 'vip'),
  ('cards_id', 'holographic', 'vip'),
  ('cards_id', 'carbon', 'vip'),
  ('cards_id', 'club-branded', 'vip'),
  ('cards_id', 'diamond-foil', 'vip'),
  ('cards_id', 'neon', 'vip'),
  ('cards_id', 'galaxy', 'vip'),
  ('cards_id', 'diamond', 'vip'),
  ('cards_id', 'dragon', 'vip')
ON CONFLICT (category, asset_id) DO UPDATE SET tier = EXCLUDED.tier;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. THE LEDGER — what a specific player owns beyond the free tier
-- ───────────────────────────────────────────────────────────────────────────
--
-- Separate from `avatar_unlocks` (avatars/frames/auras) and from
-- `feature_purchases` (diamond buys) because it answers a different question:
-- "may this player equip this THEME asset". A grandfather grant and a future
-- shop purchase both land here.

CREATE TABLE IF NOT EXISTS public.theme_asset_unlocks (
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category     text NOT NULL,
  asset_id     text NOT NULL,
  -- 'grandfathered' | 'purchase' | 'grant' | 'reward'
  unlock_method text NOT NULL DEFAULT 'grant',
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category, asset_id)
);

ALTER TABLE public.theme_asset_unlocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS theme_asset_unlocks_read_own ON public.theme_asset_unlocks;
-- READ ONLY for the player. Deliberately NO insert/update policy: a player who
-- can write their own unlock row owns everything, which is the exact hole this
-- migration exists to close. Grants come from the service role.
CREATE POLICY theme_asset_unlocks_read_own ON public.theme_asset_unlocks
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

GRANT SELECT ON public.theme_asset_unlocks TO authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. GRANDFATHER — BEFORE the guard exists. "Keep what they have." (Dan)
-- ───────────────────────────────────────────────────────────────────────────
--
-- Every equipped value that is NOT free becomes an owned row for that player.
-- Runs across all five columns in one statement per column. Idempotent.

INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT s.user_id, 'theme_id', s.theme_id, 'grandfathered'
  FROM public.user_theme_settings s
  JOIN public.cosmetic_catalog c
    ON c.category = 'theme_id' AND c.asset_id = s.theme_id AND c.tier <> 'free'
 WHERE s.user_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT s.user_id, 'table_id', s.table_id, 'grandfathered'
  FROM public.user_theme_settings s
  JOIN public.cosmetic_catalog c
    ON c.category = 'table_id' AND c.asset_id = s.table_id AND c.tier <> 'free'
 WHERE s.user_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT s.user_id, 'button_id', s.button_id, 'grandfathered'
  FROM public.user_theme_settings s
  JOIN public.cosmetic_catalog c
    ON c.category = 'button_id' AND c.asset_id = s.button_id AND c.tier <> 'free'
 WHERE s.user_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT s.user_id, 'background_id', s.background_id, 'grandfathered'
  FROM public.user_theme_settings s
  JOIN public.cosmetic_catalog c
    ON c.category = 'background_id' AND c.asset_id = s.background_id AND c.tier <> 'free'
 WHERE s.user_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT s.user_id, 'cards_id', s.cards_id, 'grandfathered'
  FROM public.user_theme_settings s
  JOIN public.cosmetic_catalog c
    ON c.category = 'cards_id' AND c.asset_id = s.cards_id AND c.tier <> 'free'
 WHERE s.user_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Anyone who already BOUGHT a card back keeps it, whatever they have equipped.
INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT DISTINCT fp.user_id, 'cards_id', substring(fp.feature from 11), 'purchase'
  FROM public.feature_purchases fp
 WHERE fp.feature LIKE 'card\_back\_%'
   AND EXISTS (SELECT 1 FROM public.cosmetic_catalog c
                WHERE c.category = 'cards_id' AND c.asset_id = substring(fp.feature from 11))
ON CONFLICT DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. THE ENTITLEMENT TEST
-- ───────────────────────────────────────────────────────────────────────────

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
  -- Clearing a value is always allowed.
  IF p_asset_id IS NULL OR btrim(p_asset_id) = '' THEN RETURN true; END IF;

  SELECT tier INTO v_tier
    FROM public.cosmetic_catalog
   WHERE category = p_category AND asset_id = p_asset_id;

  -- An id the catalog has never heard of is REFUSED. That is deliberate: it
  -- is how a typo, a retired asset and an invented value all fail closed
  -- rather than becoming a permanent cosmetic nobody can explain.
  IF v_tier IS NULL THEN RETURN false; END IF;
  IF v_tier = 'free' THEN RETURN true; END IF;

  SELECT COALESCE(p.is_vip, false)
         AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now())
    INTO v_is_vip
    FROM public.profiles p
   WHERE p.id = p_user_id;

  IF COALESCE(v_is_vip, false) THEN RETURN true; END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.theme_asset_unlocks u
     WHERE u.user_id = p_user_id AND u.category = p_category AND u.asset_id = p_asset_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sp_theme_asset_is_owned(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.sp_theme_asset_is_owned(uuid, text, text) TO authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. THE GUARD
-- ───────────────────────────────────────────────────────────────────────────
--
-- Only checks a column it is actually CHANGING (or setting on INSERT), so a
-- grandfathered row can still be written back untouched by any code path that
-- upserts the whole row.

CREATE OR REPLACE FUNCTION public.trg_user_theme_settings_entitlement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.theme_id IS DISTINCT FROM OLD.theme_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id, 'theme_id', NEW.theme_id) THEN
      RAISE EXCEPTION 'Theme "%" is VIP only', NEW.theme_id USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.table_id IS DISTINCT FROM OLD.table_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id, 'table_id', NEW.table_id) THEN
      RAISE EXCEPTION 'Table felt "%" is VIP only', NEW.table_id USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.button_id IS DISTINCT FROM OLD.button_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id, 'button_id', NEW.button_id) THEN
      RAISE EXCEPTION 'Dealer button "%" is VIP only', NEW.button_id USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.background_id IS DISTINCT FROM OLD.background_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id, 'background_id', NEW.background_id) THEN
      RAISE EXCEPTION 'Background "%" is VIP only', NEW.background_id USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.cards_id IS DISTINCT FROM OLD.cards_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id, 'cards_id', NEW.cards_id) THEN
      RAISE EXCEPTION 'Card back "%" is VIP only', NEW.cards_id USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_theme_settings_entitlement ON public.user_theme_settings;
CREATE TRIGGER trg_user_theme_settings_entitlement
  BEFORE INSERT OR UPDATE ON public.user_theme_settings
  FOR EACH ROW EXECUTE FUNCTION public.trg_user_theme_settings_entitlement();

-- The UPDATE policy had a USING clause and no WITH CHECK, so a row could be
-- updated into a shape the policy would not have admitted. Closed here.
DROP POLICY IF EXISTS "Users can update own theme settings" ON public.user_theme_settings;
CREATE POLICY "Users can update own theme settings"
  ON public.user_theme_settings FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- ───────────────────────────────────────────────────────────────────────────
-- 6. POST-APPLY ASSERTIONS
-- ───────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_free  integer;
  v_cats  integer;
  v_orphan integer;
BEGIN
  -- Exactly three free per category, five categories.
  SELECT count(*) INTO v_cats FROM (
    SELECT category FROM public.cosmetic_catalog WHERE tier = 'free'
     GROUP BY category HAVING count(*) = 3
  ) t;
  IF v_cats <> 5 THEN
    RAISE EXCEPTION 'expected 5 categories with exactly 3 free assets, found %', v_cats;
  END IF;

  SELECT count(*) INTO v_free FROM public.cosmetic_catalog WHERE tier = 'free';
  IF v_free <> 15 THEN
    RAISE EXCEPTION 'expected 15 free assets total, found %', v_free;
  END IF;

  -- NOBODY may be left equipping something they do not own. This is the
  -- grandfather step proving itself: if this is non-zero, a real player's
  -- table would break on their next settings write.
  SELECT count(*) INTO v_orphan
    FROM public.user_theme_settings s
   WHERE NOT public.sp_theme_asset_is_owned(s.user_id, 'theme_id', s.theme_id)
      OR NOT public.sp_theme_asset_is_owned(s.user_id, 'table_id', s.table_id)
      OR NOT public.sp_theme_asset_is_owned(s.user_id, 'button_id', s.button_id)
      OR NOT public.sp_theme_asset_is_owned(s.user_id, 'background_id', s.background_id)
      OR NOT public.sp_theme_asset_is_owned(s.user_id, 'cards_id', s.cards_id);
  IF v_orphan > 0 THEN
    RAISE EXCEPTION '% player(s) equip an asset they do not own — grandfathering missed them', v_orphan;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.user_theme_settings'::regclass
       AND tgname = 'trg_user_theme_settings_entitlement'
  ) THEN
    RAISE EXCEPTION 'entitlement trigger missing — migration did not take';
  END IF;
END $$;

-- ROLLBACK:
--   DROP TRIGGER trg_user_theme_settings_entitlement ON public.user_theme_settings;
--   DROP FUNCTION public.trg_user_theme_settings_entitlement();
--   DROP FUNCTION public.sp_theme_asset_is_owned(uuid, text, text);
--   -- keep theme_asset_unlocks and cosmetic_catalog: dropping them would
--   -- destroy the grandfather record, which is the one thing here that cannot
--   -- be recomputed after the fact.
