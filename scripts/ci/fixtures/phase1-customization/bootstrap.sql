-- Minimal production-shaped predecessor for the two Phase 1 customization
-- migrations.  The qualification runner installs the latest committed
-- fn_purchase_feature_v2 body verbatim after this fixture, then applies the
-- candidate migrations themselves.

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

-- Exercise the migration's conditional Supabase Realtime publication path.
CREATE PUBLICATION supabase_realtime;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    current_user::text
  );
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

-- The cutover seal reads the same three durable engine truth surfaces as the
-- protected deployment route. Keep their fixture shapes production-compatible
-- while leaving them empty until each refusal/acceptance case supplies its own
-- exact evidence.
CREATE TABLE public.engine_leader (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  instance_id text NOT NULL,
  engine_version text,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.engine_table_leases (
  table_id uuid PRIMARY KEY,
  instance_id text NOT NULL,
  engine_version text,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.ca_engine_deploy_attempts (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  run_id text,
  target_sha text NOT NULL,
  shipped boolean NOT NULL,
  reason text,
  actor text
);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  diamonds integer NOT NULL DEFAULT 0,
  is_vip boolean NOT NULL DEFAULT false,
  vip_tier text,
  vip_expires_at timestamptz,
  equipped_frame text,
  equipped_aura text
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT TO authenticated USING (id = (SELECT auth.uid()));
CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()));
GRANT SELECT, UPDATE ON public.profiles TO authenticated;

CREATE TABLE public.cosmetic_catalog (
  category text NOT NULL,
  asset_id text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('free', 'vip')),
  PRIMARY KEY (category, asset_id),
  CONSTRAINT cosmetic_catalog_category_check CHECK (
    category IN ('theme_id', 'table_id', 'button_id', 'background_id', 'cards_id')
  )
);

INSERT INTO public.cosmetic_catalog(category, asset_id, tier) VALUES
  ('theme_id','default-dark','free'), ('theme_id','classic-brown','vip'),
  ('theme_id','neon-blue','vip'), ('theme_id','rustic-wood','vip'),
  ('theme_id','casino-green','vip'), ('theme_id','ocean-depths','vip'),
  ('theme_id','crimson-club','vip'), ('theme_id','arctic-suite','vip'),
  ('theme_id','amethyst-night','vip'), ('theme_id','carbon-ion','vip'),
  ('table_id','classic_green','free'), ('table_id','carbon_red','vip'),
  ('table_id','ice_cavern','vip'), ('table_id','golden_sand','vip'),
  ('table_id','jade_city','vip'), ('table_id','ocean_blue','vip'),
  ('table_id','crimson','vip'), ('table_id','arctic_white','vip'),
  ('table_id','amethyst_cavern','vip'), ('table_id','carbon_ion','vip'),
  ('button_id','classic-white','free'), ('button_id','gray-d-gear','vip'),
  ('button_id','blue-crystal','vip'), ('button_id','gold-star','vip'),
  ('button_id','ocean-pearl','vip'), ('button_id','red-d-gear','vip'),
  ('button_id','amethyst-chip','vip'), ('button_id','carbon-ion','vip'),
  ('background_id','midnight','free'), ('background_id','galaxy','vip'),
  ('background_id','golden_dusk','vip'), ('background_id','jade_neon','vip'),
  ('background_id','royal_indigo','vip'), ('background_id','crimson_lounge','vip'),
  ('background_id','ice_frost','vip'), ('background_id','carbon_grid','vip'),
  ('cards_id','classic_red','free'), ('cards_id','classic_blue','free'),
  ('cards_id','gold','vip'), ('cards_id','carbon','vip'),
  ('cards_id','diamond-foil','vip'), ('cards_id','royal','vip');

CREATE TABLE public.feature_pricing (
  feature text PRIMARY KEY,
  diamond_cost integer NOT NULL,
  usage_type text NOT NULL,
  description text
);
ALTER TABLE public.feature_pricing ENABLE ROW LEVEL SECURITY;
CREATE POLICY patch_maintain_access ON public.feature_pricing FOR ALL USING (true) WITH CHECK (true);
GRANT ALL ON public.feature_pricing TO anon, authenticated;

CREATE TABLE public.feature_purchases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature text NOT NULL,
  cost integer NOT NULL,
  usage_type text NOT NULL,
  uses_remaining integer,
  expires_at timestamptz,
  purchased_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.feature_purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY patch_maintain_access ON public.feature_purchases FOR ALL USING (true) WITH CHECK (true);
GRANT ALL ON public.feature_purchases TO anon, authenticated;

CREATE TABLE public.theme_asset_unlocks (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category text NOT NULL,
  asset_id text NOT NULL,
  unlock_method text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category, asset_id)
);
ALTER TABLE public.theme_asset_unlocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY theme_asset_unlocks_select_own ON public.theme_asset_unlocks
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY theme_asset_unlocks_insert_own ON public.theme_asset_unlocks
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.theme_asset_unlocks TO authenticated;

CREATE TABLE public.theme_unlocks (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  theme_id text NOT NULL,
  unlock_method text,
  PRIMARY KEY (user_id, theme_id)
);

CREATE TABLE public.user_theme_settings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  game_type text NOT NULL DEFAULT 'ALL',
  theme_id text NOT NULL DEFAULT 'default-dark',
  table_id text NOT NULL DEFAULT 'classic_green',
  button_id text NOT NULL DEFAULT 'classic-white',
  background_id text NOT NULL DEFAULT 'midnight',
  cards_id text NOT NULL DEFAULT 'classic_red',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, game_type)
);
ALTER TABLE public.user_theme_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_theme_settings_select_own ON public.user_theme_settings
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY user_theme_settings_insert_own ON public.user_theme_settings
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY user_theme_settings_update_own ON public.user_theme_settings
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
GRANT SELECT, INSERT, UPDATE ON public.user_theme_settings TO authenticated;

CREATE FUNCTION public.sp_theme_asset_is_owned(
  p_user_id uuid,
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

  SELECT coalesce(p.is_vip, false)
         AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now())
    INTO v_is_vip
    FROM public.profiles p
   WHERE p.id = p_user_id;
  IF coalesce(v_is_vip, false) THEN RETURN true; END IF;

  IF p_category = 'cards_id' AND EXISTS (
    SELECT 1 FROM public.feature_purchases fp
     WHERE fp.user_id = p_user_id AND fp.feature = 'card_back_' || p_asset_id
  ) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.theme_asset_unlocks u
     WHERE u.user_id = p_user_id
       AND u.category = p_category
       AND u.asset_id = p_asset_id
  );
END;
$$;

CREATE FUNCTION public.trg_user_theme_settings_entitlement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.theme_id IS DISTINCT FROM OLD.theme_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id, 'theme_id', NEW.theme_id) THEN
      RAISE EXCEPTION 'Theme is not owned' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.table_id IS DISTINCT FROM OLD.table_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id, 'table_id', NEW.table_id) THEN
      RAISE EXCEPTION 'Table is not owned' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.button_id IS DISTINCT FROM OLD.button_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id, 'button_id', NEW.button_id) THEN
      RAISE EXCEPTION 'Button is not owned' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.background_id IS DISTINCT FROM OLD.background_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id, 'background_id', NEW.background_id) THEN
      RAISE EXCEPTION 'Background is not owned' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.cards_id IS DISTINCT FROM OLD.cards_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id, 'cards_id', NEW.cards_id) THEN
      RAISE EXCEPTION 'Card back is not owned' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_user_theme_settings_entitlement
  BEFORE INSERT OR UPDATE ON public.user_theme_settings
  FOR EACH ROW EXECUTE FUNCTION public.trg_user_theme_settings_entitlement();

CREATE TABLE public.theme_preset_catalog (
  theme_id text PRIMARY KEY,
  display_name text NOT NULL,
  table_id text NOT NULL,
  button_id text NOT NULL,
  background_id text NOT NULL,
  cards_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.theme_preset_catalog
  (theme_id, display_name, table_id, button_id, background_id, cards_id)
VALUES
  ('default-dark','House Classic','classic_green','classic-white','midnight','classic_red'),
  ('classic-brown','Carbon Club','carbon_red','gray-d-gear','midnight','classic_red'),
  ('neon-blue','Neon Ice','ice_cavern','blue-crystal','galaxy','classic_blue'),
  ('rustic-wood','Golden Dusk','golden_sand','gold-star','golden_dusk','gold'),
  ('casino-green','Jade Casino','jade_city','gold-star','jade_neon','carbon'),
  ('ocean-depths','Ocean Suite','ocean_blue','classic-white','royal_indigo','classic_blue'),
  ('crimson-club','Crimson Club','crimson','red-d-gear','crimson_lounge','classic_red'),
  ('arctic-suite','Arctic Suite','arctic_white','ocean-pearl','ice_frost','diamond-foil'),
  ('amethyst-night','Amethyst Night','amethyst_cavern','amethyst-chip','royal_indigo','royal'),
  ('carbon-ion','Carbon Ion','carbon_ion','carbon-ion','carbon_grid','carbon');
CREATE TABLE public.theme_preset_aliases (
  alias text PRIMARY KEY,
  theme_id text NOT NULL REFERENCES public.theme_preset_catalog(theme_id)
);
CREATE FUNCTION public.sp_resolve_theme_preset(p_theme_id text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT coalesce(
    (SELECT p.theme_id FROM public.theme_preset_catalog p WHERE p.theme_id = p_theme_id),
    (SELECT a.theme_id FROM public.theme_preset_aliases a WHERE a.alias = p_theme_id)
  );
$$;
CREATE FUNCTION public.sp_grant_theme_preset(
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
  SELECT p.* INTO v_preset FROM public.theme_preset_catalog p
   WHERE p.theme_id = public.sp_resolve_theme_preset(p_theme_id);
  IF v_preset.theme_id IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.theme_asset_unlocks(user_id, category, asset_id, unlock_method)
  VALUES
    (p_user_id,'theme_id',v_preset.theme_id,p_unlock_method),
    (p_user_id,'table_id',v_preset.table_id,p_unlock_method),
    (p_user_id,'button_id',v_preset.button_id,p_unlock_method),
    (p_user_id,'background_id',v_preset.background_id,p_unlock_method),
    (p_user_id,'cards_id',v_preset.cards_id,p_unlock_method)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.theme_unlocks(user_id, theme_id, unlock_method)
  VALUES (p_user_id, v_preset.theme_id, p_unlock_method)
  ON CONFLICT DO NOTHING;
  RETURN v_preset.theme_id;
END;
$$;

CREATE TABLE public.digital_purchase_receipts (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  purchase_kind text NOT NULL,
  request_payload jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);

CREATE TABLE public.diamond_debit_receipts (
  user_id uuid NOT NULL,
  reference_id text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (user_id, reference_id)
);
CREATE FUNCTION public.deduct_diamonds(
  p_user_id uuid,
  p_amount integer,
  p_description text,
  p_transaction_type text,
  p_source text,
  p_metadata jsonb,
  p_reference_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_balance integer;
  v_result jsonb;
BEGIN
  SELECT result INTO v_result FROM public.diamond_debit_receipts
   WHERE user_id = p_user_id AND reference_id = p_reference_id;
  IF FOUND THEN
    RETURN v_result || jsonb_build_object('idempotent', true);
  END IF;
  UPDATE public.profiles
     SET diamonds = diamonds - p_amount
   WHERE id = p_user_id AND diamonds >= p_amount
   RETURNING diamonds INTO v_balance;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient Diamonds');
  END IF;
  v_result := jsonb_build_object(
    'success', true, 'idempotent', false, 'balance', v_balance,
    'description', p_description, 'transaction_type', p_transaction_type,
    'source', p_source, 'metadata', p_metadata
  );
  INSERT INTO public.diamond_debit_receipts(user_id, reference_id, result)
  VALUES (p_user_id, p_reference_id, v_result);
  RETURN v_result;
END;
$$;
CREATE FUNCTION public.sp_is_lifetime_vip(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT coalesce((SELECT is_vip AND lower(coalesce(vip_tier,'')) = 'lifetime'
                     FROM public.profiles WHERE id = p_user), false);
$$;

CREATE FUNCTION public.trg_deliver_table_studio_entitlement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_category text;
  v_asset_id text;
  v_theme_id text;
BEGIN
  IF NEW.feature NOT LIKE 'studio:%' THEN RETURN NEW; END IF;
  v_category := split_part(NEW.feature, ':', 2);
  v_asset_id := substring(NEW.feature from length('studio:' || v_category || ':') + 1);
  IF v_category NOT IN ('theme_id','table_id','button_id','background_id')
     OR NOT EXISTS (
       SELECT 1 FROM public.cosmetic_catalog c
        WHERE c.category = v_category AND c.asset_id = v_asset_id AND c.tier = 'vip'
     ) THEN
    RAISE EXCEPTION 'Invalid Table Studio entitlement SKU %', NEW.feature
      USING ERRCODE = '23514';
  END IF;
  IF v_category = 'theme_id' THEN
    v_theme_id := public.sp_grant_theme_preset(NEW.user_id, v_asset_id, 'diamond_purchase');
    IF v_theme_id IS NULL THEN RAISE EXCEPTION 'Preset cannot be delivered'; END IF;
  ELSE
    INSERT INTO public.theme_asset_unlocks(user_id, category, asset_id, unlock_method)
    VALUES (NEW.user_id, v_category, v_asset_id, 'diamond_purchase')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_deliver_table_studio_entitlement
  AFTER INSERT ON public.feature_purchases
  FOR EACH ROW EXECUTE FUNCTION public.trg_deliver_table_studio_entitlement();

-- Sentinels prove CREATE OR REPLACE did not detach existing trigger wiring.
CREATE TABLE public.phase1_trigger_audit (
  source_table text NOT NULL,
  row_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION public.trg_phase1_receipt_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.phase1_trigger_audit(source_table, row_key)
  VALUES (TG_TABLE_NAME, NEW.feature);
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_phase1_receipt_audit
  AFTER INSERT ON public.feature_purchases
  FOR EACH ROW EXECUTE FUNCTION public.trg_phase1_receipt_audit();

CREATE TABLE public.user_table_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  table_color text,
  card_back text,
  settings_touched text[] NOT NULL DEFAULT '{}'::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.user_table_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY patch_maintain_access ON public.user_table_settings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY user_table_settings_select_own ON public.user_table_settings
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY user_table_settings_insert_own ON public.user_table_settings
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY user_table_settings_update_own ON public.user_table_settings
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
GRANT SELECT, INSERT, UPDATE ON public.user_table_settings TO authenticated;

CREATE FUNCTION public.fn_set_interface_theme(p_theme text)
RETURNS text LANGUAGE sql AS $$ SELECT p_theme $$;
GRANT EXECUTE ON FUNCTION public.fn_set_interface_theme(text) TO authenticated;
CREATE FUNCTION public.fn_mark_table_setting_touched(p_columns text[])
RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  UPDATE public.user_table_settings
     SET settings_touched = settings_touched || p_columns
   WHERE user_id = auth.uid();
END;
$$;
GRANT EXECUTE ON FUNCTION public.fn_mark_table_setting_touched(text[]) TO authenticated;

CREATE TABLE public.user_table_studio_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  favorites text[] NOT NULL DEFAULT '{}'::text[],
  loadouts jsonb NOT NULL DEFAULT '[null,null,null]'::jsonb,
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION public.trg_touch_table_studio_preferences()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_touch_table_studio_preferences
  BEFORE UPDATE ON public.user_table_studio_preferences
  FOR EACH ROW EXECUTE FUNCTION public.trg_touch_table_studio_preferences();
ALTER TABLE public.user_table_studio_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY table_studio_preferences_select_own ON public.user_table_studio_preferences
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY table_studio_preferences_insert_own ON public.user_table_studio_preferences
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY table_studio_preferences_update_own ON public.user_table_studio_preferences
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
GRANT SELECT, INSERT, UPDATE ON public.user_table_studio_preferences TO authenticated;

CREATE FUNCTION public.fn_seed_table_studio_preferences(p_favorites text[], p_loadouts jsonb)
RETURNS TABLE(favorites text[], loadouts jsonb, revision bigint, updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  INSERT INTO public.user_table_studio_preferences(user_id, favorites, loadouts)
  VALUES (auth.uid(), coalesce(p_favorites,'{}'), coalesce(p_loadouts,'[null,null,null]'))
  ON CONFLICT (user_id) DO NOTHING;
  RETURN QUERY
  SELECT p.favorites, p.loadouts, p.revision, p.updated_at
    FROM public.user_table_studio_preferences p WHERE p.user_id = auth.uid();
END;
$$;
GRANT EXECUTE ON FUNCTION public.fn_seed_table_studio_preferences(text[], jsonb) TO authenticated;
CREATE FUNCTION public.fn_mutate_table_studio_preferences(
  p_favorite_key text,
  p_favorite_enabled boolean,
  p_loadout_slot integer,
  p_loadout jsonb
)
RETURNS TABLE(favorites text[], loadouts jsonb, revision bigint, updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF (p_favorite_key IS NOT NULL OR p_favorite_enabled IS NOT NULL)
     = (p_loadout_slot IS NOT NULL) THEN
    RAISE EXCEPTION 'Exactly one Table Studio mutation is required'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  UPDATE public.user_table_studio_preferences p
     SET favorites = CASE
       WHEN p_loadout_slot IS NOT NULL THEN p.favorites
       WHEN p_favorite_enabled THEN
         (ARRAY[p_favorite_key] || array_remove(p.favorites, p_favorite_key))[1:100]
       ELSE array_remove(p.favorites, p_favorite_key)
     END,
         loadouts = CASE
       WHEN p_loadout_slot IS NULL THEN p.loadouts
       ELSE jsonb_set(p.loadouts, ARRAY[p_loadout_slot::text], coalesce(p_loadout,'null'), false)
     END,
         revision = p.revision + 1
   WHERE p.user_id = auth.uid()
   RETURNING p.favorites, p.loadouts, p.revision, p.updated_at;
END;
$$;
GRANT EXECUTE ON FUNCTION public.fn_mutate_table_studio_preferences(text, boolean, integer, jsonb)
  TO authenticated;

CREATE TABLE public.avatar_unlocks (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  avatar_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, avatar_id)
);
ALTER TABLE public.avatar_unlocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own unlocks" ON public.avatar_unlocks
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY "Users can insert their own unlocks" ON public.avatar_unlocks
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Users can update their own unlocks" ON public.avatar_unlocks
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Users can delete their own unlocks" ON public.avatar_unlocks
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.avatar_unlocks TO authenticated;

CREATE TABLE public.avatar_style_catalog (unlock_token text PRIMARY KEY);
INSERT INTO public.avatar_style_catalog(unlock_token) VALUES
  ('frame_gold'), ('frame_diamond'), ('frame_cyber'), ('frame_hellfire'),
  ('aura_fire'), ('aura_glitch');
CREATE FUNCTION public.sp_normalize_cosmetic_token(p_raw text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(lower(btrim(coalesce(p_raw,''))), '[[:space:]-]+', '_', 'g');
$$;
CREATE FUNCTION public.sp_resolve_avatar_entitlement(p_avatar_id text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT s.unlock_token FROM public.avatar_style_catalog s
   WHERE s.unlock_token = p_avatar_id;
$$;
CREATE FUNCTION public.sp_cosmetic_is_owned(p_user uuid, p_token text, p_kind text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_token text := public.sp_normalize_cosmetic_token(p_token);
BEGIN
  IF v_token = '' THEN RETURN true; END IF;
  IF p_kind IS NOT NULL AND split_part(v_token,'_',1) <> p_kind THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.avatar_style_catalog WHERE unlock_token = v_token) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user AND p.is_vip)
      OR EXISTS (SELECT 1 FROM public.avatar_unlocks a
                  WHERE a.user_id = p_user
                    AND public.sp_normalize_cosmetic_token(a.avatar_id) = v_token);
END;
$$;
CREATE FUNCTION public.sp_guard_avatar_cosmetics()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_owner uuid;
BEGIN
  -- A polymorphic trigger record cannot resolve columns from both target
  -- tables inside one CASE expression. Match production's branch-before-field
  -- contract so profiles reads id and user_avatars reads user_id.
  IF TG_TABLE_NAME = 'profiles' THEN
    v_owner := NEW.id;
  ELSE
    v_owner := NEW.user_id;
  END IF;
  IF NEW.equipped_frame IS DISTINCT FROM
       (CASE WHEN TG_OP = 'UPDATE' THEN OLD.equipped_frame ELSE NULL END)
     AND NEW.equipped_frame IS NOT NULL
     AND NOT public.sp_cosmetic_is_owned(v_owner, NEW.equipped_frame, 'frame') THEN
    RAISE EXCEPTION 'unowned frame' USING ERRCODE = '23514';
  END IF;
  IF NEW.equipped_aura IS DISTINCT FROM
       (CASE WHEN TG_OP = 'UPDATE' THEN OLD.equipped_aura ELSE NULL END)
     AND NEW.equipped_aura IS NOT NULL
     AND NOT public.sp_cosmetic_is_owned(v_owner, NEW.equipped_aura, 'aura') THEN
    RAISE EXCEPTION 'unowned aura' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_profiles_cosmetics_ownership
  BEFORE INSERT OR UPDATE OF equipped_frame, equipped_aura ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.sp_guard_avatar_cosmetics();
CREATE TABLE public.user_avatars (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  equipped_frame text,
  equipped_aura text
);
CREATE TRIGGER trg_user_avatars_cosmetics_ownership
  BEFORE INSERT OR UPDATE OF equipped_frame, equipped_aura ON public.user_avatars
  FOR EACH ROW EXECUTE FUNCTION public.sp_guard_avatar_cosmetics();

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  format_contract text,
  final_table_triggered boolean
);

-- Two real owners and three entitlement states.
INSERT INTO auth.users(id) VALUES
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000003'),
  ('00000000-0000-4000-8000-000000000004');
INSERT INTO public.profiles
  (id, settings, diamonds, is_vip, vip_tier, vip_expires_at)
VALUES
  ('00000000-0000-4000-8000-000000000001','{"theme":"dark","soundEnabled":true}',1000,false,NULL,NULL),
  ('00000000-0000-4000-8000-000000000002','{"theme":"light"}',1000,false,NULL,NULL),
  ('00000000-0000-4000-8000-000000000003','{}',1000,true,'monthly',now() - interval '1 day'),
  ('00000000-0000-4000-8000-000000000004','{}',1000,true,'lifetime',now() - interval '1 year');
INSERT INTO public.user_theme_settings(user_id) VALUES
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');
INSERT INTO public.user_table_settings(user_id) VALUES
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');
INSERT INTO public.user_avatars(user_id) VALUES
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000003'),
  ('00000000-0000-4000-8000-000000000004');
INSERT INTO public.user_table_studio_preferences(user_id, loadouts) VALUES (
  '00000000-0000-4000-8000-000000000001',
  '[{"theme_id":"default-dark","table_id":"classic_green","button_id":"classic-white","background_id":"midnight","cards_id":"classic_red","name":"Legacy","saved_at":"2026-10-05T00:00:00Z"},null,null]'
);
INSERT INTO public.theme_asset_unlocks(user_id, category, asset_id, unlock_method) VALUES
  ('00000000-0000-4000-8000-000000000001','theme_id','default-dark','fixture-owned-look');

INSERT INTO public.tournaments(id, format_contract, final_table_triggered) VALUES
  ('10000000-0000-4000-8000-000000000001','spin-v1',true),
  ('10000000-0000-4000-8000-000000000002','sng-v1',true),
  ('10000000-0000-4000-8000-000000000003','seat-first-v1',true),
  ('10000000-0000-4000-8000-000000000004',NULL,true),
  ('10000000-0000-4000-8000-000000000005','mtt-v1',true),
  ('10000000-0000-4000-8000-000000000006','mtt-v2',false),
  ('10000000-0000-4000-8000-000000000007','spin-v1',NULL),
  ('10000000-0000-4000-8000-000000000008','mtt-v2',false);
