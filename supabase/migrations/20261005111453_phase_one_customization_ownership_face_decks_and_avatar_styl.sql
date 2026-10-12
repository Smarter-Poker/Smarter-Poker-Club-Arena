-- 20261005111453_phase_one_customization_ownership_face_decks_and_avatar_styl.sql
--
-- Phase 1's client already exposed durable Table Studio choices, but production
-- still lacked the owner-bound mutation RPCs, a distinct ten-option face-deck
-- authority, and the complete ten-frame/ten-aura entitlement catalog. That
-- mismatch could leak queued writes across an account switch, reject real UI
-- choices, or let legacy browser grants forge purchase/unlock rows.
--
-- This one backward-compatible prerequisite transaction closes those gaps
-- without replacing the current commerce receipt/debit implementation. It
-- binds every settings/collection mutation to auth.uid(), preserves "auto" as
-- the account theme preference, adds the face-deck catalog/loadout/equip path,
-- patches only the current v2 purchase category allow-list, and makes avatar
-- entitlement ledgers server-owned with active-VIP expiry semantics. It also
-- installs the backward-compatible Final Table transition receipt/event RPCs
-- before the engine that consumes them is released; the later migration owns
-- only post-cutover legacy retirement, short-format cleanup, and enforcement.
--
-- One transaction intentionally produces one schema-cache reload.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- ── Receipt/catalog policies ────────────────────────────────────────────────

ALTER TABLE public.feature_purchases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patch_maintain_access ON public.feature_purchases;
DROP POLICY IF EXISTS feature_purchases_select_own ON public.feature_purchases;

REVOKE ALL ON TABLE public.feature_purchases FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.feature_purchases TO authenticated;

CREATE POLICY feature_purchases_select_own
  ON public.feature_purchases
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Pricing is a public catalogue, but it is never a public write surface.
ALTER TABLE public.feature_pricing ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patch_maintain_access ON public.feature_pricing;
DROP POLICY IF EXISTS feature_pricing_read_catalog ON public.feature_pricing;
DROP POLICY IF EXISTS feature_pricing_public_select ON public.feature_pricing;
REVOKE ALL ON TABLE public.feature_pricing FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.feature_pricing TO anon, authenticated;
CREATE POLICY feature_pricing_read_catalog
  ON public.feature_pricing
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Keep the intentional owner policies created in 20260326; remove only the
-- historical policy that bypassed every one of them.
ALTER TABLE public.user_table_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patch_maintain_access ON public.user_table_settings;

-- Entitlements are written only by trusted purchase/redemption functions and
-- triggers. Make that invariant explicit even if an older grant is replayed.
ALTER TABLE public.theme_asset_unlocks ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE public.theme_asset_unlocks
  FROM PUBLIC, anon, authenticated;

-- user_theme_settings is keyed by a surrogate id, while the engine needs
-- user_id + game_type to route a DELETE. Under PostgreSQL's default replica
-- identity a delete carries only the primary key, so the deletion silently
-- vanished at the bridge. FULL makes the complete old owner/bucket available.
ALTER TABLE public.user_theme_settings REPLICA IDENTITY FULL;

-- The currently served client still writes appearance rows directly. Keep its
-- owner-scoped RLS policies and existing write grants through prerequisite
-- installation; the post-client migration retires that route only after the
-- owner-bound, idempotent RPC client is proven live.
GRANT SELECT ON TABLE public.user_theme_settings TO authenticated;

-- A transport timeout is ambiguous: the transaction may have committed even
-- though its response was lost. Retrying the value without an operation key
-- can overwrite a newer choice made on another device. Keep a compact durable
-- receipt so the same mutation returns its first result without applying twice.
CREATE TABLE IF NOT EXISTS public.customization_settings_mutation_receipts (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mutation_id uuid NOT NULL,
  operation text NOT NULL CHECK (
    operation IN ('interface_theme', 'account_settings', 'table_appearance')
  ),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  -- NULL is a short-lived ownership marker while the first invocation is
  -- applying the mutation. The transaction makes that marker invisible until
  -- it is replaced by the committed result.
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mutation_id)
);
ALTER TABLE public.customization_settings_mutation_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.customization_settings_mutation_receipts
  FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS customization_settings_mutation_receipts_created_idx
  ON public.customization_settings_mutation_receipts (created_at);

-- ── Account-bound interface mode ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_set_interface_theme(
  p_expected_user_id uuid,
  p_mutation_id uuid,
  p_theme text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_prior_operation text;
  v_prior_request jsonb;
  v_prior_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_expected_user_id IS NULL OR p_expected_user_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'Authenticated account changed before the preference was saved'
      USING ERRCODE = '42501';
  END IF;
  IF p_theme IS NULL OR NOT (p_theme IN ('light', 'dark')) THEN
    RAISE EXCEPTION 'Invalid interface theme' USING ERRCODE = '22023';
  END IF;
  IF p_mutation_id IS NULL
     OR p_mutation_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'Mutation id is required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.customization_settings_mutation_receipts
    (user_id, mutation_id, operation, request, result)
  VALUES (
    v_user_id,
    p_mutation_id,
    'interface_theme',
    jsonb_build_object('theme', p_theme),
    NULL
  )
  ON CONFLICT (user_id, mutation_id) DO NOTHING;

  IF NOT FOUND THEN
    SELECT operation, request, result
      INTO v_prior_operation, v_prior_request, v_prior_result
      FROM public.customization_settings_mutation_receipts
     WHERE user_id = v_user_id AND mutation_id = p_mutation_id;
    IF v_prior_operation <> 'interface_theme'
       OR v_prior_request IS DISTINCT FROM jsonb_build_object('theme', p_theme) THEN
      RAISE EXCEPTION 'Mutation id was already used for another request'
        USING ERRCODE = '22023';
    END IF;
    IF v_prior_result IS NULL THEN
      RAISE EXCEPTION 'Mutation is still in progress; retry with the same mutation id'
        USING ERRCODE = '40001';
    END IF;
    RETURN v_prior_result ->> 'theme';
  END IF;

  UPDATE public.profiles
     SET settings = jsonb_set(
       CASE
         WHEN jsonb_typeof(settings) = 'object' THEN settings
         ELSE '{}'::jsonb
       END,
       '{theme}',
       to_jsonb(p_theme),
       true
     )
   WHERE id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.customization_settings_mutation_receipts
     SET result = jsonb_build_object('theme', p_theme)
   WHERE user_id = v_user_id AND mutation_id = p_mutation_id;
  RETURN p_theme;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_set_interface_theme(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_set_interface_theme(uuid, uuid, text) TO authenticated;

-- SettingsPage saves more than interface mode. Merge only the keys it sends
-- into the authenticated player's existing JSON document so an older page
-- cannot erase a preference introduced by a newer client. The resolved
-- light/dark value validates this request atomically while the durable JSON
-- retains the player's exact light/dark/auto preference.
CREATE OR REPLACE FUNCTION public.fn_patch_account_settings(
  p_expected_user_id uuid,
  p_mutation_id uuid,
  p_settings_patch jsonb,
  p_interface_theme text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_result jsonb;
  v_patch jsonb;
  v_prior_operation text;
  v_prior_request jsonb;
  v_prior_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_expected_user_id IS NULL OR p_expected_user_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'Authenticated account changed before settings were saved'
      USING ERRCODE = '42501';
  END IF;
  IF p_settings_patch IS NULL OR jsonb_typeof(p_settings_patch) <> 'object' THEN
    RAISE EXCEPTION 'Settings patch must be an object' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_settings_patch::text) > 65536 THEN
    RAISE EXCEPTION 'Settings patch is too large' USING ERRCODE = '22023';
  END IF;
  IF p_interface_theme IS NULL OR NOT (p_interface_theme IN ('light', 'dark')) THEN
    RAISE EXCEPTION 'Invalid interface theme' USING ERRCODE = '22023';
  END IF;
  IF p_mutation_id IS NULL
     OR p_mutation_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'Mutation id is required' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_object_keys(p_settings_patch) AS key
     WHERE key NOT IN (
       'soundEnabled', 'soundVolume', 'theme', 'cardBack', 'fourColorDeck',
       'animationSpeed', 'showPotOdds', 'showTicker', 'confirmAllIn',
       'autoMuckWinners', 'tournamentReminders', 'clubActivity',
       'handWonNotifications', 'achievementNotifications', 'friendAlerts',
       'settlementAlerts'
     )
  ) THEN
    RAISE EXCEPTION 'Settings patch contains an unsupported key' USING ERRCODE = '22023';
  END IF;
  IF (p_settings_patch ? 'soundVolume') AND NOT (CASE
    WHEN jsonb_typeof(p_settings_patch -> 'soundVolume') = 'number'
      THEN (p_settings_patch ->> 'soundVolume')::numeric BETWEEN 0 AND 100
    ELSE false
  END) THEN
    RAISE EXCEPTION 'Invalid sound volume' USING ERRCODE = '22023';
  END IF;
  IF (p_settings_patch ? 'theme') AND (
    jsonb_typeof(p_settings_patch -> 'theme') <> 'string'
    OR p_settings_patch ->> 'theme' NOT IN ('dark', 'light', 'auto')
  ) THEN
    RAISE EXCEPTION 'Invalid requested theme' USING ERRCODE = '22023';
  END IF;
  IF (p_settings_patch ? 'theme')
     AND p_settings_patch ->> 'theme' <> 'auto'
     AND p_settings_patch ->> 'theme' IS DISTINCT FROM p_interface_theme THEN
    RAISE EXCEPTION 'Resolved interface theme does not match the requested preference'
      USING ERRCODE = '22023';
  END IF;
  IF (p_settings_patch ? 'animationSpeed') AND (
    jsonb_typeof(p_settings_patch -> 'animationSpeed') <> 'string'
    OR p_settings_patch ->> 'animationSpeed' NOT IN ('slow', 'normal', 'fast')
  ) THEN
    RAISE EXCEPTION 'Invalid animation speed' USING ERRCODE = '22023';
  END IF;
  IF (p_settings_patch ? 'cardBack') AND (
    jsonb_typeof(p_settings_patch -> 'cardBack') <> 'string'
    OR NOT EXISTS (
      SELECT 1 FROM public.cosmetic_catalog c
       WHERE c.category = 'cards_id' AND c.asset_id = p_settings_patch ->> 'cardBack'
    )
  ) THEN
    RAISE EXCEPTION 'Invalid card back' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_each(p_settings_patch) AS setting(key, value)
     WHERE key IN (
       'soundEnabled', 'fourColorDeck', 'showPotOdds', 'showTicker', 'confirmAllIn',
       'autoMuckWinners', 'tournamentReminders', 'clubActivity',
       'handWonNotifications', 'achievementNotifications', 'friendAlerts',
       'settlementAlerts'
     )
       AND jsonb_typeof(value) <> 'boolean'
  ) THEN
    RAISE EXCEPTION 'Settings patch contains an invalid boolean' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.customization_settings_mutation_receipts
    (user_id, mutation_id, operation, request, result)
  VALUES (
    v_user_id,
    p_mutation_id,
    'account_settings',
    jsonb_build_object('settings_patch', p_settings_patch, 'interface_theme', p_interface_theme),
    NULL
  )
  ON CONFLICT (user_id, mutation_id) DO NOTHING;

  IF NOT FOUND THEN
    SELECT operation, request, result
      INTO v_prior_operation, v_prior_request, v_prior_result
      FROM public.customization_settings_mutation_receipts
     WHERE user_id = v_user_id AND mutation_id = p_mutation_id;
    IF v_prior_operation <> 'account_settings'
       OR v_prior_request IS DISTINCT FROM jsonb_build_object(
         'settings_patch', p_settings_patch,
         'interface_theme', p_interface_theme
       ) THEN
      RAISE EXCEPTION 'Mutation id was already used for another request'
        USING ERRCODE = '22023';
    END IF;
    IF v_prior_result IS NULL THEN
      RAISE EXCEPTION 'Mutation is still in progress; retry with the same mutation id'
        USING ERRCODE = '40001';
    END IF;
    RETURN v_prior_result;
  END IF;

  -- Preserve the account preference exactly, including "auto". The resolved
  -- light/dark value is a consistency fence for this request, not durable
  -- cross-device state.
  v_patch := p_settings_patch;

  SELECT (
    CASE
      WHEN jsonb_typeof(settings) = 'object' THEN settings
      ELSE '{}'::jsonb
    END
  ) || v_patch
    INTO v_result
    FROM public.profiles
   WHERE id = v_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;
  IF octet_length(v_result::text) > 65536 THEN
    RAISE EXCEPTION 'Resulting settings document is too large' USING ERRCODE = '22023';
  END IF;

  UPDATE public.profiles SET settings = v_result WHERE id = v_user_id;
  UPDATE public.customization_settings_mutation_receipts
     SET result = v_result
   WHERE user_id = v_user_id AND mutation_id = p_mutation_id;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_patch_account_settings(uuid, uuid, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_patch_account_settings(uuid, uuid, jsonb, text)
  TO authenticated;

-- A lost HTTP response is not proof that an appearance write failed. The
-- browser retries this RPC with the same mutation UUID, so a committed first
-- attempt is read back rather than replayed over a newer choice from another
-- device. The expected owner also makes an account switch while a request is
-- queued fail closed instead of writing into the newly authenticated account.
CREATE OR REPLACE FUNCTION public.fn_patch_table_appearance(
  p_expected_user_id uuid,
  p_mutation_id uuid,
  p_game_type text,
  p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_request jsonb;
  v_result jsonb;
  v_prior_operation text;
  v_prior_request jsonb;
  v_prior_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_expected_user_id IS NULL OR p_expected_user_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'Authenticated account changed before appearance was saved'
      USING ERRCODE = '42501';
  END IF;
  IF p_mutation_id IS NULL
     OR p_mutation_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'Mutation id is required' USING ERRCODE = '22023';
  END IF;
  IF p_game_type IS NULL OR p_game_type NOT IN (
    'ALL', 'NLH', '6+', 'PLO', 'PINEAPPLE', 'MTT', 'SNG'
  ) THEN
    RAISE EXCEPTION 'Invalid appearance game type' USING ERRCODE = '22023';
  END IF;
  IF p_patch IS NULL
     OR jsonb_typeof(p_patch) <> 'object'
     OR p_patch = '{}'::jsonb
     OR octet_length(p_patch::text) > 4096 THEN
    RAISE EXCEPTION 'Appearance patch must be a non-empty object'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_object_keys(p_patch) AS field(name)
     WHERE field.name NOT IN (
       'theme_id', 'table_id', 'button_id', 'background_id', 'cards_id', 'face_deck_id'
     )
  ) THEN
    RAISE EXCEPTION 'Appearance patch contains an unsupported field'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_each(p_patch) AS field(name, value)
     WHERE jsonb_typeof(field.value) <> 'string'
        OR btrim(field.value #>> '{}') = ''
        OR length(field.value #>> '{}') > 128
  ) THEN
    RAISE EXCEPTION 'Appearance patch contains an invalid asset id'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_each_text(p_patch) AS asset(category, asset_id)
     WHERE NOT EXISTS (
       SELECT 1
         FROM public.cosmetic_catalog catalog
        WHERE catalog.category = asset.category
          AND catalog.asset_id = asset.asset_id
     )
  ) THEN
    RAISE EXCEPTION 'Appearance patch references an unknown asset'
      USING ERRCODE = '22023';
  END IF;

  v_request := jsonb_build_object('game_type', p_game_type, 'patch', p_patch);
  INSERT INTO public.customization_settings_mutation_receipts
    (user_id, mutation_id, operation, request, result)
  VALUES (v_user_id, p_mutation_id, 'table_appearance', v_request, NULL)
  ON CONFLICT (user_id, mutation_id) DO NOTHING;

  IF NOT FOUND THEN
    SELECT operation, request, result
      INTO v_prior_operation, v_prior_request, v_prior_result
      FROM public.customization_settings_mutation_receipts
     WHERE user_id = v_user_id AND mutation_id = p_mutation_id;
    IF v_prior_operation <> 'table_appearance'
       OR v_prior_request IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'Mutation id was already used for another request'
        USING ERRCODE = '22023';
    END IF;
    IF v_prior_result IS NULL THEN
      RAISE EXCEPTION 'Mutation is still in progress; retry with the same mutation id'
        USING ERRCODE = '40001';
    END IF;
    RETURN v_prior_result;
  END IF;

  -- Let schema defaults create the untouched fields on a player's first
  -- partial save. The ownership trigger validates those defaults and every
  -- changed field before the row can become visible.
  INSERT INTO public.user_theme_settings (user_id, game_type)
  VALUES (v_user_id, p_game_type)
  ON CONFLICT (user_id, game_type) DO NOTHING;

  -- This update takes the row lock and serializes different devices. Only
  -- keys present in the patch move; unrelated appearance fields survive.
  UPDATE public.user_theme_settings AS settings
     SET theme_id = CASE
           WHEN p_patch ? 'theme_id' THEN p_patch ->> 'theme_id'
           ELSE settings.theme_id
         END,
         table_id = CASE
           WHEN p_patch ? 'table_id' THEN p_patch ->> 'table_id'
           ELSE settings.table_id
         END,
         button_id = CASE
           WHEN p_patch ? 'button_id' THEN p_patch ->> 'button_id'
           ELSE settings.button_id
         END,
         background_id = CASE
           WHEN p_patch ? 'background_id' THEN p_patch ->> 'background_id'
           ELSE settings.background_id
         END,
         cards_id = CASE
           WHEN p_patch ? 'cards_id' THEN p_patch ->> 'cards_id'
           ELSE settings.cards_id
         END,
         face_deck_id = CASE
           WHEN p_patch ? 'face_deck_id' THEN p_patch ->> 'face_deck_id'
           ELSE settings.face_deck_id
         END
   WHERE settings.user_id = v_user_id
     AND settings.game_type = p_game_type
   RETURNING jsonb_build_object(
     'game_type', settings.game_type,
     'theme_id', settings.theme_id,
     'table_id', settings.table_id,
     'button_id', settings.button_id,
     'background_id', settings.background_id,
     'cards_id', settings.cards_id,
     'face_deck_id', settings.face_deck_id,
     'updated_at', settings.updated_at
   ) INTO v_result;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'Appearance settings row was not saved' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.customization_settings_mutation_receipts
     SET result = v_result
   WHERE user_id = v_user_id AND mutation_id = p_mutation_id;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_patch_table_appearance(uuid, uuid, text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_patch_table_appearance(uuid, uuid, text, jsonb)
  TO authenticated;

-- A second auth fence for the metadata write that follows each successful
-- per-column table-setting upsert. Without the captured owner, an A request
-- resolving after login switched to B could mark B's column as deliberately
-- chosen even though B never touched it.
CREATE OR REPLACE FUNCTION public.fn_mark_table_setting_touched(
  p_expected_user_id uuid,
  p_columns text[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_valid text[];
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_expected_user_id IS NULL OR p_expected_user_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'Authenticated account changed before settings were marked'
      USING ERRCODE = '42501';
  END IF;
  IF p_columns IS NULL OR array_length(p_columns, 1) IS NULL THEN
    RETURN;
  END IF;

  SELECT array_agg(DISTINCT requested.column_name)
    INTO v_valid
    FROM unnest(p_columns) AS requested(column_name)
   WHERE requested.column_name IN (
     SELECT attribute.attname::text
       FROM pg_attribute attribute
      WHERE attribute.attrelid = 'public.user_table_settings'::regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND attribute.attname NOT IN ('user_id', 'created_at', 'updated_at', 'settings_touched')
   );

  IF v_valid IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.user_table_settings AS setting
     SET settings_touched = (
       SELECT array_agg(DISTINCT touched)
         FROM unnest(setting.settings_touched || v_valid) AS touched
     )
   WHERE setting.user_id = v_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_mark_table_setting_touched(uuid, text[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_mark_table_setting_touched(uuid, text[])
  TO authenticated;

-- ── Account-bound Table Studio collections ─────────────────────────────────

-- Browsers may read their locker, but all mutations must pass through the
-- owner-bound functions below. This closes the legacy direct-write policies
-- that allowed malformed JSON and bypassed the engine's discrete event path.
DROP POLICY IF EXISTS table_studio_preferences_insert_own
  ON public.user_table_studio_preferences;
DROP POLICY IF EXISTS table_studio_preferences_update_own
  ON public.user_table_studio_preferences;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE public.user_table_studio_preferences
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_table_studio_favorites_are_valid(p_favorites text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT cardinality(p_favorites) <= 100
     AND cardinality(p_favorites) = (
       SELECT count(DISTINCT item) FROM unnest(p_favorites) AS item
     )
     AND NOT EXISTS (
       SELECT 1
         FROM unnest(p_favorites) AS item
        WHERE item IS NULL
           OR item <> btrim(item)
           OR item !~ '^(themes|table|button|background|cards|decks):[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
     );
$$;

CREATE OR REPLACE FUNCTION public.fn_table_studio_loadout_is_valid(p_loadout jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE WHEN jsonb_typeof(p_loadout) <> 'object' THEN false ELSE (
         p_loadout ?& ARRAY['theme_id', 'table_id', 'button_id', 'background_id', 'cards_id']
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_object_keys(p_loadout) AS key
        WHERE key NOT IN (
          'theme_id', 'table_id', 'button_id', 'background_id', 'cards_id',
          'face_deck_id', 'name', 'saved_at'
        )
     )
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_each(p_loadout) AS field(key, value)
        WHERE key IN (
          'theme_id', 'table_id', 'button_id', 'background_id', 'cards_id', 'face_deck_id'
        )
          AND (
            jsonb_typeof(value) <> 'string'
            OR value #>> '{}' <> btrim(value #>> '{}')
            OR length(value #>> '{}') NOT BETWEEN 1 AND 128
            OR value #>> '{}' !~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'
          )
     )
     AND (
       NOT (p_loadout ? 'name')
       OR (
         jsonb_typeof(p_loadout -> 'name') = 'string'
         AND length(p_loadout ->> 'name') BETWEEN 1 AND 32
         AND p_loadout ->> 'name' = btrim(p_loadout ->> 'name')
       )
     )
     AND (
       NOT (p_loadout ? 'saved_at')
       OR (
         jsonb_typeof(p_loadout -> 'saved_at') = 'string'
         AND length(p_loadout ->> 'saved_at') <= 64
         AND p_loadout ->> 'saved_at' ~
           '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
       )
     )
  ) END;
$$;

CREATE OR REPLACE FUNCTION public.fn_table_studio_loadouts_are_valid(p_loadouts jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE WHEN jsonb_typeof(p_loadouts) <> 'array' THEN false ELSE (
         jsonb_array_length(p_loadouts) = 3
     AND octet_length(p_loadouts::text) <= 8192
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_loadouts) AS slot(value)
        WHERE slot.value <> 'null'::jsonb
          AND NOT COALESCE(public.fn_table_studio_loadout_is_valid(slot.value), false)
     )
  ) END;
$$;

REVOKE ALL ON FUNCTION public.fn_table_studio_favorites_are_valid(text[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_table_studio_loadout_is_valid(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_table_studio_loadouts_are_valid(jsonb)
  FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.user_table_studio_preferences
     WHERE NOT public.fn_table_studio_favorites_are_valid(favorites)
        OR NOT public.fn_table_studio_loadouts_are_valid(loadouts)
  ) THEN
    RAISE EXCEPTION 'Existing Table Studio collections contain invalid data';
  END IF;
END;
$$;

ALTER TABLE public.user_table_studio_preferences
  DROP CONSTRAINT IF EXISTS table_studio_favorites_payload_valid,
  ADD CONSTRAINT table_studio_favorites_payload_valid
    CHECK (public.fn_table_studio_favorites_are_valid(favorites)) NOT VALID,
  DROP CONSTRAINT IF EXISTS table_studio_loadouts_payload_valid,
  ADD CONSTRAINT table_studio_loadouts_payload_valid
    CHECK (public.fn_table_studio_loadouts_are_valid(loadouts)) NOT VALID;
ALTER TABLE public.user_table_studio_preferences
  VALIDATE CONSTRAINT table_studio_favorites_payload_valid;
ALTER TABLE public.user_table_studio_preferences
  VALIDATE CONSTRAINT table_studio_loadouts_payload_valid;

CREATE OR REPLACE FUNCTION public.fn_seed_table_studio_preferences(
  p_expected_user_id uuid,
  p_favorites text[],
  p_loadouts jsonb
)
RETURNS TABLE(favorites text[], loadouts jsonb, revision bigint, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_favorites text[] := COALESCE(p_favorites, '{}'::text[]);
  v_loadouts jsonb := COALESCE(p_loadouts, '[null,null,null]'::jsonb);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_expected_user_id IS NULL OR p_expected_user_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'Authenticated account changed before the collection was saved'
      USING ERRCODE = '42501';
  END IF;
  IF NOT public.fn_table_studio_favorites_are_valid(v_favorites) THEN
    RAISE EXCEPTION 'Invalid Table Studio favorites' USING ERRCODE = '22023';
  END IF;
  IF NOT public.fn_table_studio_loadouts_are_valid(v_loadouts) THEN
    RAISE EXCEPTION 'Invalid Table Studio loadouts' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM unnest(v_favorites) AS favorite(item)
     WHERE NOT EXISTS (
       SELECT 1
         FROM public.cosmetic_catalog c
        WHERE c.category = CASE split_part(favorite.item, ':', 1)
          WHEN 'themes' THEN 'theme_id'
          WHEN 'table' THEN 'table_id'
          WHEN 'button' THEN 'button_id'
          WHEN 'background' THEN 'background_id'
          WHEN 'cards' THEN 'cards_id'
          WHEN 'decks' THEN 'face_deck_id'
        END
          AND c.asset_id = split_part(favorite.item, ':', 2)
     )
  ) THEN
    RAISE EXCEPTION 'Table Studio favorites contain an unknown asset' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_loadouts) AS slot(value)
      CROSS JOIN LATERAL (
        VALUES
          ('theme_id', slot.value ->> 'theme_id'),
          ('table_id', slot.value ->> 'table_id'),
          ('button_id', slot.value ->> 'button_id'),
          ('background_id', slot.value ->> 'background_id'),
          ('cards_id', slot.value ->> 'cards_id'),
          ('face_deck_id', slot.value ->> 'face_deck_id')
      ) AS asset(category, asset_id)
     WHERE slot.value <> 'null'::jsonb
       AND asset.asset_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.cosmetic_catalog c
          WHERE c.category = asset.category AND c.asset_id = asset.asset_id
       )
  ) THEN
    RAISE EXCEPTION 'Table Studio loadouts contain an unknown asset' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.user_table_studio_preferences (user_id, favorites, loadouts)
  VALUES (v_user_id, v_favorites, v_loadouts)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN QUERY
  SELECT p.favorites, p.loadouts, p.revision, p.updated_at
    FROM public.user_table_studio_preferences p
   WHERE p.user_id = v_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_mutate_table_studio_preferences(
  p_expected_user_id uuid,
  p_favorite_key text DEFAULT NULL,
  p_favorite_enabled boolean DEFAULT NULL,
  p_loadout_slot integer DEFAULT NULL,
  p_loadout jsonb DEFAULT NULL
)
RETURNS TABLE(favorites text[], loadouts jsonb, revision bigint, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_is_favorite_mutation boolean := p_favorite_key IS NOT NULL OR p_favorite_enabled IS NOT NULL;
  v_is_loadout_mutation boolean := p_loadout_slot IS NOT NULL;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_expected_user_id IS NULL OR p_expected_user_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'Authenticated account changed before the collection was saved'
      USING ERRCODE = '42501';
  END IF;
  IF v_is_favorite_mutation = v_is_loadout_mutation THEN
    RAISE EXCEPTION 'Exactly one Table Studio mutation is required' USING ERRCODE = '22023';
  END IF;

  IF v_is_favorite_mutation AND (
    p_favorite_key IS NULL OR p_favorite_enabled IS NULL OR
    NOT public.fn_table_studio_favorites_are_valid(ARRAY[p_favorite_key])
  ) THEN
    RAISE EXCEPTION 'Invalid favorite mutation' USING ERRCODE = '22023';
  END IF;
  IF v_is_favorite_mutation AND NOT EXISTS (
    SELECT 1
      FROM public.cosmetic_catalog c
     WHERE c.category = CASE split_part(p_favorite_key, ':', 1)
       WHEN 'themes' THEN 'theme_id'
       WHEN 'table' THEN 'table_id'
       WHEN 'button' THEN 'button_id'
       WHEN 'background' THEN 'background_id'
       WHEN 'cards' THEN 'cards_id'
       WHEN 'decks' THEN 'face_deck_id'
     END
       AND c.asset_id = split_part(p_favorite_key, ':', 2)
  ) THEN
    RAISE EXCEPTION 'Favorite references an unknown asset' USING ERRCODE = '22023';
  END IF;

  IF v_is_loadout_mutation THEN
    IF p_loadout_slot < 0 OR p_loadout_slot > 2 THEN
      RAISE EXCEPTION 'Invalid loadout slot' USING ERRCODE = '22023';
    END IF;
    IF p_loadout IS NOT NULL AND NOT public.fn_table_studio_loadout_is_valid(p_loadout) THEN
      RAISE EXCEPTION 'Invalid loadout payload' USING ERRCODE = '22023';
    END IF;
    IF p_loadout IS NOT NULL AND EXISTS (
      SELECT 1
        FROM (
          VALUES
            ('theme_id', p_loadout ->> 'theme_id'),
            ('table_id', p_loadout ->> 'table_id'),
            ('button_id', p_loadout ->> 'button_id'),
            ('background_id', p_loadout ->> 'background_id'),
            ('cards_id', p_loadout ->> 'cards_id'),
            ('face_deck_id', p_loadout ->> 'face_deck_id')
        ) AS asset(category, asset_id)
       WHERE asset.asset_id IS NOT NULL
         AND NOT EXISTS (
         SELECT 1 FROM public.cosmetic_catalog c
          WHERE c.category = asset.category AND c.asset_id = asset.asset_id
       )
    ) THEN
      RAISE EXCEPTION 'Loadout references an unknown asset' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.user_table_studio_preferences (user_id)
  VALUES (v_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN QUERY
  UPDATE public.user_table_studio_preferences AS p
     SET favorites = CASE
       WHEN NOT v_is_favorite_mutation THEN p.favorites
       WHEN p_favorite_enabled THEN
         (ARRAY[p_favorite_key] || array_remove(p.favorites, p_favorite_key))[1:100]
       ELSE array_remove(p.favorites, p_favorite_key)
     END,
         loadouts = CASE
       WHEN NOT v_is_loadout_mutation THEN p.loadouts
       ELSE jsonb_set(
         p.loadouts,
         ARRAY[p_loadout_slot::text],
         COALESCE(p_loadout, 'null'::jsonb),
         false
       )
     END,
         revision = p.revision + 1
   WHERE p.user_id = v_user_id
   RETURNING p.favorites, p.loadouts, p.revision, p.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_seed_table_studio_preferences(uuid, text[], jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_seed_table_studio_preferences(uuid, text[], jsonb)
  TO authenticated;

REVOKE ALL ON FUNCTION public.fn_mutate_table_studio_preferences(uuid, text, boolean, integer, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_mutate_table_studio_preferences(uuid, text, boolean, integer, jsonb)
  TO authenticated;

COMMENT ON FUNCTION public.fn_set_interface_theme(uuid, uuid, text) IS
  'Idempotently patches interface mode only when the queued owner still equals auth.uid().';
COMMENT ON FUNCTION public.fn_patch_account_settings(uuid, uuid, jsonb, text) IS
  'Idempotently merges account settings for the explicitly bound owner while validating the effective interface mode.';
COMMENT ON FUNCTION public.fn_patch_table_appearance(uuid, uuid, text, jsonb) IS
  'Idempotently patches one canonical appearance bucket for the explicitly bound authenticated owner.';
COMMENT ON FUNCTION public.fn_mark_table_setting_touched(uuid, text[]) IS
  'Marks deliberate table-setting columns only for the owner captured by the originating write.';
COMMENT ON FUNCTION public.fn_seed_table_studio_preferences(uuid, text[], jsonb) IS
  'Seeds Table Studio collections only for the explicitly bound authenticated owner.';
COMMENT ON FUNCTION public.fn_mutate_table_studio_preferences(uuid, text, boolean, integer, jsonb) IS
  'Mutates one Table Studio collection field only for the explicitly bound authenticated owner.';

-- Migration-level assertions: a replay must stop instead of silently rebuilding
-- public receipt-forging surfaces. Legacy client RPCs remain executable only
-- until the explicit post-cutover migration retires them.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('feature_purchases', 'feature_pricing', 'user_table_settings')
       AND policyname = 'patch_maintain_access'
  ) THEN
    RAISE EXCEPTION 'blanket customization policies remain installed';
  END IF;

  IF has_table_privilege('anon', 'public.feature_purchases', 'INSERT')
     OR has_table_privilege('authenticated', 'public.feature_purchases', 'INSERT')
     OR has_table_privilege('anon', 'public.feature_purchases', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.feature_purchases', 'UPDATE')
     OR has_table_privilege('anon', 'public.feature_purchases', 'DELETE')
     OR has_table_privilege('authenticated', 'public.feature_purchases', 'DELETE')
     OR has_table_privilege('anon', 'public.feature_purchases', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.feature_purchases', 'TRUNCATE')
  THEN
    RAISE EXCEPTION 'browser roles can still forge or alter purchase receipts';
  END IF;

  IF has_table_privilege('anon', 'public.feature_pricing', 'INSERT')
     OR has_table_privilege('authenticated', 'public.feature_pricing', 'INSERT')
     OR has_table_privilege('anon', 'public.feature_pricing', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.feature_pricing', 'UPDATE')
     OR has_table_privilege('anon', 'public.feature_pricing', 'DELETE')
     OR has_table_privilege('authenticated', 'public.feature_pricing', 'DELETE')
     OR has_table_privilege('anon', 'public.feature_pricing', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.feature_pricing', 'TRUNCATE')
  THEN
    RAISE EXCEPTION 'browser roles can still alter the authoritative cosmetic catalogue';
  END IF;

  IF has_table_privilege('anon', 'public.theme_asset_unlocks', 'INSERT')
     OR has_table_privilege('authenticated', 'public.theme_asset_unlocks', 'INSERT')
     OR has_table_privilege('anon', 'public.theme_asset_unlocks', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.theme_asset_unlocks', 'UPDATE')
     OR has_table_privilege('anon', 'public.theme_asset_unlocks', 'DELETE')
     OR has_table_privilege('authenticated', 'public.theme_asset_unlocks', 'DELETE')
     OR has_table_privilege('anon', 'public.theme_asset_unlocks', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.theme_asset_unlocks', 'TRUNCATE')
  THEN
    RAISE EXCEPTION 'browser roles can still forge or alter cosmetic entitlements';
  END IF;

  IF has_table_privilege('anon', 'public.customization_settings_mutation_receipts', 'SELECT')
     OR has_table_privilege(
       'authenticated',
       'public.customization_settings_mutation_receipts',
       'SELECT'
     )
     OR has_table_privilege(
       'authenticated',
       'public.customization_settings_mutation_receipts',
       'INSERT'
     )
     OR has_table_privilege(
       'authenticated',
       'public.customization_settings_mutation_receipts',
       'UPDATE'
     )
     OR has_table_privilege(
       'authenticated',
       'public.customization_settings_mutation_receipts',
       'DELETE'
     )
  THEN
    RAISE EXCEPTION 'browser roles can read or forge settings mutation receipts';
  END IF;

  IF has_table_privilege('authenticated', 'public.user_table_studio_preferences', 'INSERT')
     OR has_table_privilege('authenticated', 'public.user_table_studio_preferences', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.user_table_studio_preferences', 'DELETE')
     OR has_table_privilege('authenticated', 'public.user_table_studio_preferences', 'TRUNCATE')
  THEN
    RAISE EXCEPTION 'browser roles can still bypass Table Studio collection RPCs';
  END IF;

  IF (
    SELECT relation.relreplident
      FROM pg_class relation
     WHERE relation.oid = 'public.user_theme_settings'::regclass
  ) <> 'f' THEN
    RAISE EXCEPTION 'user_theme_settings deletes do not carry their routing identity';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.fn_patch_account_settings(uuid, uuid, jsonb, text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.fn_patch_account_settings(uuid, uuid, jsonb, text)',
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'account settings patch grants are not closed to authenticated owners';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.fn_patch_table_appearance(uuid, uuid, text, jsonb)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.fn_patch_table_appearance(uuid, uuid, text, jsonb)',
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'table appearance patch grants are not closed to authenticated owners';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.fn_mark_table_setting_touched(uuid, text[])',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.fn_mark_table_setting_touched(uuid, text[])',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.fn_set_interface_theme(uuid, uuid, text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.fn_set_interface_theme(uuid, uuid, text)',
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'owner-bound customization function grants are invalid';
  END IF;
END;
$$;

-- ── Independent card-face decks ─────────────────────────────────────────────

-- ── 1. A distinct appearance authority and authoritative catalog ───────────

ALTER TABLE public.cosmetic_catalog
  DROP CONSTRAINT IF EXISTS cosmetic_catalog_category_check;
ALTER TABLE public.cosmetic_catalog
  ADD CONSTRAINT cosmetic_catalog_category_check
  CHECK (category IN (
    'theme_id', 'table_id', 'button_id', 'background_id', 'cards_id', 'face_deck_id'
  ));

ALTER TABLE public.user_theme_settings
  ADD COLUMN IF NOT EXISTS face_deck_id text NOT NULL DEFAULT 'house-classic';
ALTER TABLE public.user_theme_settings
  ALTER COLUMN face_deck_id SET DEFAULT 'house-classic',
  ALTER COLUMN face_deck_id SET NOT NULL;

COMMENT ON COLUMN public.user_theme_settings.cards_id IS
  'Card-back artwork shown while a card is face down.';
COMMENT ON COLUMN public.user_theme_settings.face_deck_id IS
  'Card-face finish; rank and suit identity remain authoritative game state.';

INSERT INTO public.cosmetic_catalog (category, asset_id, tier) VALUES
  ('face_deck_id', 'house-classic', 'free'),
  ('face_deck_id', 'broadcast-pro', 'free'),
  ('face_deck_id', 'ivory-club', 'free'),
  ('face_deck_id', 'midnight-foil', 'vip'),
  ('face_deck_id', 'carbon-edge', 'vip'),
  ('face_deck_id', 'royal-purple', 'vip'),
  ('face_deck_id', 'emerald-room', 'vip'),
  ('face_deck_id', 'crimson-signature', 'vip'),
  ('face_deck_id', 'platinum-line', 'vip'),
  ('face_deck_id', 'neon-circuit', 'vip')
ON CONFLICT (category, asset_id) DO UPDATE SET tier = EXCLUDED.tier;

INSERT INTO public.feature_pricing (feature, diamond_cost, usage_type, description) VALUES
  ('studio:face_deck_id:midnight-foil', 75, 'permanent', 'Table Studio face deck: Midnight Foil'),
  ('studio:face_deck_id:carbon-edge', 75, 'permanent', 'Table Studio face deck: Carbon Edge'),
  ('studio:face_deck_id:royal-purple', 100, 'permanent', 'Table Studio face deck: Royal Purple'),
  ('studio:face_deck_id:emerald-room', 100, 'permanent', 'Table Studio face deck: Emerald Room'),
  ('studio:face_deck_id:crimson-signature', 125, 'permanent', 'Table Studio face deck: Crimson Signature'),
  ('studio:face_deck_id:platinum-line', 175, 'permanent', 'Table Studio face deck: Platinum Line'),
  ('studio:face_deck_id:neon-circuit', 200, 'permanent', 'Table Studio face deck: Neon Circuit')
ON CONFLICT (feature) DO UPDATE SET
  diamond_cost = EXCLUDED.diamond_cost,
  usage_type = EXCLUDED.usage_type,
  description = EXCLUDED.description;

-- Composite Looks now paint a face finish as well. The original preset table
-- and grant function only knew the first five appearance fields; without this
-- sixth grant, selecting a purchased premium Look asked the equip trigger to
-- apply an unowned premium deck and the entire save failed.
ALTER TABLE public.theme_preset_catalog
  ADD COLUMN IF NOT EXISTS face_deck_id text NOT NULL DEFAULT 'house-classic';

UPDATE public.theme_preset_catalog AS preset
   SET face_deck_id = expected.face_deck_id
  FROM (VALUES
    ('default-dark', 'house-classic'),
    ('classic-brown', 'ivory-club'),
    ('neon-blue', 'neon-circuit'),
    ('rustic-wood', 'midnight-foil'),
    ('casino-green', 'emerald-room'),
    ('ocean-depths', 'broadcast-pro'),
    ('crimson-club', 'crimson-signature'),
    ('arctic-suite', 'platinum-line'),
    ('amethyst-night', 'royal-purple'),
    ('carbon-ion', 'carbon-edge')
  ) AS expected(theme_id, face_deck_id)
 WHERE preset.theme_id = expected.theme_id
   AND preset.face_deck_id IS DISTINCT FROM expected.face_deck_id;

ALTER TABLE public.theme_preset_catalog
  ALTER COLUMN face_deck_id SET DEFAULT 'house-classic',
  ALTER COLUMN face_deck_id SET NOT NULL;

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
    (p_user_id, 'cards_id',      v_preset.cards_id,      p_unlock_method),
    (p_user_id, 'face_deck_id',  v_preset.face_deck_id,  p_unlock_method)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.theme_unlocks (user_id, theme_id, unlock_method)
  VALUES (p_user_id, v_preset.theme_id, p_unlock_method)
  ON CONFLICT (user_id, theme_id) DO NOTHING;

  RETURN v_preset.theme_id;
END;
$$;

REVOKE ALL ON FUNCTION public.sp_grant_theme_preset(uuid, text, text)
  FROM PUBLIC, anon, authenticated;

-- Existing permanent preset owners must receive the new sixth component too.
DO $backfill_preset_face_decks$
DECLARE
  owned record;
BEGIN
  FOR owned IN
    SELECT DISTINCT unlock.user_id, unlock.asset_id AS theme_id,
           COALESCE(unlock.unlock_method, 'face_deck_backfill') AS unlock_method
      FROM public.theme_asset_unlocks unlock
     WHERE unlock.category = 'theme_id'
  LOOP
    PERFORM public.sp_grant_theme_preset(
      owned.user_id,
      owned.theme_id,
      owned.unlock_method
    );
  END LOOP;
END;
$backfill_preset_face_decks$;

-- ── 2. The equip and receipt guards understand the sixth category ─────────

CREATE OR REPLACE FUNCTION public.trg_user_theme_settings_entitlement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.theme_id IS DISTINCT FROM OLD.theme_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id, 'theme_id', NEW.theme_id) THEN
      RAISE EXCEPTION 'Theme "%" is not owned by this account', NEW.theme_id USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.table_id IS DISTINCT FROM OLD.table_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id, 'table_id', NEW.table_id) THEN
      RAISE EXCEPTION 'Table felt "%" is not owned by this account', NEW.table_id USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.button_id IS DISTINCT FROM OLD.button_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id, 'button_id', NEW.button_id) THEN
      RAISE EXCEPTION 'Dealer button "%" is not owned by this account', NEW.button_id USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.background_id IS DISTINCT FROM OLD.background_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id, 'background_id', NEW.background_id) THEN
      RAISE EXCEPTION 'Background "%" is not owned by this account', NEW.background_id USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.cards_id IS DISTINCT FROM OLD.cards_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id, 'cards_id', NEW.cards_id) THEN
      RAISE EXCEPTION 'Card back "%" is not owned by this account', NEW.cards_id USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.face_deck_id IS DISTINCT FROM OLD.face_deck_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id, 'face_deck_id', NEW.face_deck_id) THEN
      RAISE EXCEPTION 'Face deck "%" is not owned by this account', NEW.face_deck_id USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_deliver_table_studio_entitlement()
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

  IF v_category NOT IN (
       'theme_id', 'table_id', 'button_id', 'background_id', 'face_deck_id'
     )
     OR v_asset_id IS NULL OR btrim(v_asset_id) = ''
     OR NOT EXISTS (
       SELECT 1 FROM public.cosmetic_catalog c
        WHERE c.category = v_category AND c.asset_id = v_asset_id AND c.tier = 'vip'
     ) THEN
    RAISE EXCEPTION 'Invalid Table Studio entitlement SKU %', NEW.feature
      USING ERRCODE = '23514';
  END IF;

  IF v_category = 'theme_id' THEN
    v_theme_id := public.sp_grant_theme_preset(NEW.user_id, v_asset_id, 'diamond_purchase');
    IF v_theme_id IS NULL THEN
      RAISE EXCEPTION 'Table Studio preset % cannot be delivered', v_asset_id
        USING ERRCODE = '23514';
    END IF;
  ELSE
    INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
    VALUES (NEW.user_id, v_category, v_asset_id, 'diamond_purchase')
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trg_deliver_table_studio_entitlement()
  FROM PUBLIC, anon, authenticated;

-- Preserve the current request-receipt and debit semantics. Change only the
-- authoritative customization category allow-list in the latest v2 function.
DO $patch_purchase_feature_v2$
DECLARE
  v_definition text :=
    pg_get_functiondef('public.fn_purchase_feature_v2(uuid,text,uuid)'::regprocedure);
  v_needle text := '''theme_id'', ''table_id'', ''button_id'', ''background_id''';
BEGIN
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'fn_purchase_feature_v2 is missing';
  END IF;
  IF length(v_definition) - length(replace(v_definition, v_needle, ''))
       <> length(v_needle) THEN
    RAISE EXCEPTION
      'fn_purchase_feature_v2 customization allow-list did not match exactly once';
  END IF;
  EXECUTE replace(
    v_definition,
    v_needle,
    v_needle || ', ''face_deck_id'''
  );
END;
$patch_purchase_feature_v2$;

-- ── 3. Existing cloud loadouts gain a deterministic deck ─────────────────

CREATE OR REPLACE FUNCTION public.fn_table_studio_loadout_is_valid(p_loadout jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE WHEN jsonb_typeof(p_loadout) <> 'object' THEN false ELSE (
         p_loadout ?& ARRAY[
           'theme_id', 'table_id', 'button_id', 'background_id', 'cards_id', 'face_deck_id'
         ]
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_object_keys(p_loadout) AS key
        WHERE key NOT IN (
          'theme_id', 'table_id', 'button_id', 'background_id', 'cards_id',
          'face_deck_id', 'name', 'saved_at'
        )
     )
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_each(p_loadout) AS field(key, value)
        WHERE key IN (
          'theme_id', 'table_id', 'button_id', 'background_id', 'cards_id', 'face_deck_id'
        )
          AND (
            jsonb_typeof(value) <> 'string'
            OR value #>> '{}' <> btrim(value #>> '{}')
            OR length(value #>> '{}') NOT BETWEEN 1 AND 128
            OR value #>> '{}' !~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'
          )
     )
     AND (
       NOT (p_loadout ? 'name')
       OR (
         jsonb_typeof(p_loadout -> 'name') = 'string'
         AND length(p_loadout ->> 'name') BETWEEN 1 AND 32
         AND p_loadout ->> 'name' = btrim(p_loadout ->> 'name')
       )
     )
     AND (
       NOT (p_loadout ? 'saved_at')
       OR (
         jsonb_typeof(p_loadout -> 'saved_at') = 'string'
         AND length(p_loadout ->> 'saved_at') <= 64
         AND p_loadout ->> 'saved_at' ~
           '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
       )
     )
  ) END;
$$;

UPDATE public.user_table_studio_preferences AS preferences
   SET loadouts = (
    SELECT jsonb_agg(
      CASE
        WHEN slot.value = 'null'::jsonb THEN slot.value
        WHEN slot.value ? 'face_deck_id' THEN slot.value
        ELSE slot.value || jsonb_build_object('face_deck_id', 'house-classic')
      END
      ORDER BY slot.ordinality
    )
      FROM jsonb_array_elements(preferences.loadouts) WITH ORDINALITY AS slot(value, ordinality)
  )
 WHERE EXISTS (
   SELECT 1
     FROM jsonb_array_elements(preferences.loadouts) AS slot(value)
    WHERE slot.value <> 'null'::jsonb AND NOT (slot.value ? 'face_deck_id')
 );

ALTER TABLE public.user_table_studio_preferences
  DROP CONSTRAINT IF EXISTS table_studio_loadouts_payload_valid,
  ADD CONSTRAINT table_studio_loadouts_payload_valid
    CHECK (public.fn_table_studio_loadouts_are_valid(loadouts)) NOT VALID;
ALTER TABLE public.user_table_studio_preferences
  VALIDATE CONSTRAINT table_studio_loadouts_payload_valid;

-- Backfill defensively if a receipt was imported before this schema landed.
INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
SELECT DISTINCT fp.user_id,
       'face_deck_id',
       substring(fp.feature from length('studio:face_deck_id:') + 1),
       'purchase_backfill'
  FROM public.feature_purchases fp
  JOIN public.cosmetic_catalog c
    ON c.category = 'face_deck_id'
   AND c.asset_id = substring(fp.feature from length('studio:face_deck_id:') + 1)
 WHERE fp.feature LIKE 'studio:face_deck_id:%'
ON CONFLICT DO NOTHING;

-- ── 4. Post-apply proof: ten real choices, seven exact prices, no orphans ─

DO $verify$
DECLARE
  v_count integer;
  v_default text;
  v_purchase_source text;
  v_delivery_source text;
  v_guard_source text;
  v_preset_grant_source text;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.cosmetic_catalog WHERE category = 'face_deck_id';
  IF v_count <> 10 THEN
    RAISE EXCEPTION 'face-deck catalog has % rows, expected 10', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM public.cosmetic_catalog
   WHERE category = 'face_deck_id' AND tier = 'free';
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'face-deck catalog has % free rows, expected 3', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM public.feature_pricing p
    JOIN (VALUES
      ('studio:face_deck_id:midnight-foil', 75),
      ('studio:face_deck_id:carbon-edge', 75),
      ('studio:face_deck_id:royal-purple', 100),
      ('studio:face_deck_id:emerald-room', 100),
      ('studio:face_deck_id:crimson-signature', 125),
      ('studio:face_deck_id:platinum-line', 175),
      ('studio:face_deck_id:neon-circuit', 200)
    ) AS expected(feature, diamond_cost)
      ON p.feature = expected.feature
     AND p.diamond_cost = expected.diamond_cost
     AND p.usage_type = 'permanent';
  IF v_count <> 7 THEN
    RAISE EXCEPTION 'only % of 7 face-deck prices match the authoritative catalog', v_count;
  END IF;

  IF (
    SELECT count(*) FROM public.theme_preset_catalog
     WHERE face_deck_id IS NOT NULL
  ) <> 10 OR EXISTS (
    SELECT 1
      FROM public.theme_preset_catalog preset
      LEFT JOIN public.cosmetic_catalog deck
        ON deck.category = 'face_deck_id' AND deck.asset_id = preset.face_deck_id
     WHERE deck.asset_id IS NULL
  ) THEN
    RAISE EXCEPTION 'the ten composite Looks do not each reference a real face deck';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.theme_asset_unlocks look_unlock
      JOIN public.theme_preset_catalog preset
        ON preset.theme_id = look_unlock.asset_id
     WHERE look_unlock.category = 'theme_id'
       AND NOT EXISTS (
         SELECT 1
           FROM public.theme_asset_unlocks deck_unlock
          WHERE deck_unlock.user_id = look_unlock.user_id
            AND deck_unlock.category = 'face_deck_id'
            AND deck_unlock.asset_id = preset.face_deck_id
       )
  ) THEN
    RAISE EXCEPTION 'an owned composite Look is missing its face-deck entitlement';
  END IF;

  SELECT column_default INTO v_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'user_theme_settings'
     AND column_name = 'face_deck_id'
     AND is_nullable = 'NO';
  IF v_default IS NULL OR v_default NOT LIKE '%house-classic%' THEN
    RAISE EXCEPTION 'face_deck_id is nullable or lacks the House Classic default';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.user_theme_settings s
     WHERE NOT public.sp_theme_asset_is_owned(s.user_id, 'face_deck_id', s.face_deck_id)
  ) THEN
    RAISE EXCEPTION 'an equipped face deck is not owned';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.user_table_studio_preferences preferences
      CROSS JOIN LATERAL jsonb_array_elements(preferences.loadouts) AS slot(value)
     WHERE slot.value <> 'null'::jsonb
       AND (
         NOT (slot.value ? 'face_deck_id')
         OR NOT EXISTS (
           SELECT 1 FROM public.cosmetic_catalog c
            WHERE c.category = 'face_deck_id'
              AND c.asset_id = slot.value ->> 'face_deck_id'
         )
       )
  ) THEN
    RAISE EXCEPTION 'a saved loadout lacks a catalogued face deck';
  END IF;

  SELECT pg_get_functiondef(
           'public.fn_purchase_feature_v2(uuid,text,uuid)'::regprocedure
         )
    INTO v_purchase_source;
  SELECT p.prosrc INTO v_delivery_source
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'trg_deliver_table_studio_entitlement';
  SELECT p.prosrc INTO v_guard_source
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'trg_user_theme_settings_entitlement';
  SELECT p.prosrc INTO v_preset_grant_source
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'sp_grant_theme_preset';

  IF position('face_deck_id' in COALESCE(v_purchase_source, '')) = 0
     OR position('face_deck_id' in COALESCE(v_delivery_source, '')) = 0
     OR position('face_deck_id' in COALESCE(v_guard_source, '')) = 0
     OR position('face_deck_id' in COALESCE(v_preset_grant_source, '')) = 0 THEN
    RAISE EXCEPTION 'face-deck purchase, preset delivery, or equip authority is incomplete';
  END IF;

  IF NOT has_function_privilege(
       'authenticated', 'public.fn_purchase_feature_v2(uuid, text, uuid)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'authenticated players lost the idempotent purchase RPC';
  END IF;
END;
$verify$;

-- ── Ten avatar frames and ten avatar auras ──────────────────────────────────

-- `avatar_unlocks` is an entitlement ledger, not a user-editable preference.
-- The original World Hub bootstrap granted every authenticated browser INSERT
-- on its own rows. Because sp_cosmetic_is_owned trusts this ledger, that policy
-- let a player mint any premium frame or aura without checkout. Keep owner
-- reads, keep trusted SECURITY DEFINER/service-role writers, and close every
-- browser mutation route before the expanded catalog can rely on the ledger.
ALTER TABLE public.avatar_unlocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can insert their own unlocks" ON public.avatar_unlocks;
DROP POLICY IF EXISTS "Users can update their own unlocks" ON public.avatar_unlocks;
DROP POLICY IF EXISTS "Users can delete their own unlocks" ON public.avatar_unlocks;
DROP POLICY IF EXISTS "Users can view their own unlocks" ON public.avatar_unlocks;
DROP POLICY IF EXISTS "v4" ON public.avatar_unlocks;
DROP POLICY IF EXISTS "v5" ON public.avatar_unlocks;
DROP POLICY IF EXISTS avatar_unlocks_insert_own ON public.avatar_unlocks;
DROP POLICY IF EXISTS avatar_unlocks_update_own ON public.avatar_unlocks;
DROP POLICY IF EXISTS avatar_unlocks_delete_own ON public.avatar_unlocks;
DROP POLICY IF EXISTS avatar_unlocks_select_own ON public.avatar_unlocks;
DROP POLICY IF EXISTS patch_maintain_access ON public.avatar_unlocks;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE public.avatar_unlocks
  FROM PUBLIC, anon, authenticated;
REVOKE SELECT ON TABLE public.avatar_unlocks FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.avatar_unlocks TO authenticated;

CREATE POLICY avatar_unlocks_select_own
  ON public.avatar_unlocks
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

INSERT INTO public.avatar_style_catalog (unlock_token) VALUES
  ('frame_obsidian'),
  ('frame_emerald'),
  ('frame_royal'),
  ('aura_frost'),
  ('aura_neon'),
  ('aura_royal'),
  ('aura_ember'),
  ('aura_aurora')
ON CONFLICT (unlock_token) DO NOTHING;

-- VIP has three columns and exactly one active-membership rule. A stale
-- is_vip=true bit from an expired monthly membership is not an entitlement;
-- lifetime remains active even if a historical expiry value is present.
CREATE OR REPLACE FUNCTION public.sp_avatar_cosmetic_vip_is_active(
  p_is_vip boolean,
  p_vip_tier text,
  p_expires_at timestamp with time zone,
  p_now timestamp with time zone DEFAULT now()
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT coalesce(p_is_vip, false)
     AND (
       lower(coalesce(p_vip_tier, '')) = 'lifetime'
       OR p_expires_at IS NULL
       OR p_expires_at > p_now
     );
$function$;

REVOKE ALL ON FUNCTION public.sp_avatar_cosmetic_vip_is_active(
  boolean, text, timestamp with time zone, timestamp with time zone
) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sp_cosmetic_is_owned(
  p_user uuid,
  p_token text,
  p_kind text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_token text := public.sp_normalize_cosmetic_token(p_token);
  v_is_vip boolean;
  v_free constant text[] := ARRAY[
    'frame_slate', 'frame_ivory', 'frame_copper',
    'aura_mist', 'aura_dusk', 'aura_moss'
  ];
BEGIN
  -- Clearing either cosmetic is always allowed.
  IF v_token = '' THEN
    RETURN true;
  END IF;

  -- A frame cannot be written into the aura column (or vice versa), and an
  -- invented kind must never turn LIKE into an accidental wildcard grant.
  IF p_kind IS NOT NULL AND p_kind NOT IN ('frame', 'aura') THEN
    RETURN false;
  END IF;
  IF p_kind IS NOT NULL AND split_part(v_token, '_', 1) <> p_kind THEN
    RETURN false;
  END IF;

  -- Every account owns the three free styles in each category.
  IF v_token = ANY (v_free) THEN
    RETURN true;
  END IF;

  -- The locked catalog is the fail-closed premium authority. This removes the
  -- second hand-maintained paid array that caused the original wiring gap.
  IF NOT EXISTS (
    SELECT 1
      FROM public.avatar_style_catalog c
     WHERE c.unlock_token = v_token
  ) THEN
    RETURN false;
  END IF;

  IF p_user IS NULL THEN
    RETURN false;
  END IF;

  SELECT public.sp_avatar_cosmetic_vip_is_active(
           p.is_vip,
           p.vip_tier,
           p.vip_expires_at
         )
    INTO v_is_vip
    FROM public.profiles p
   WHERE p.id = p_user;
  IF coalesce(v_is_vip, false) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.avatar_unlocks au
     WHERE au.user_id = p_user
       AND public.sp_normalize_cosmetic_token(au.avatar_id) = v_token
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.sp_cosmetic_is_owned(uuid, text, text)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.sp_cosmetic_is_owned(uuid, text, text) IS
  'Fail-closed avatar cosmetic ownership: six free literals plus server-issued unlocks or an active VIP membership.';

DO $$
DECLARE
  v_supported_premium constant text[] := ARRAY[
    'frame_gold', 'frame_diamond', 'frame_cyber', 'frame_hellfire',
    'frame_obsidian', 'frame_emerald', 'frame_royal',
    'aura_fire', 'aura_glitch', 'aura_frost', 'aura_neon', 'aura_royal',
    'aura_ember', 'aura_aurora'
  ];
  v_free constant text[] := ARRAY[
    'frame_slate', 'frame_ivory', 'frame_copper',
    'aura_mist', 'aura_dusk', 'aura_moss'
  ];
  v_token text;
  v_dirty bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'avatar_unlocks'
       AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'avatar_unlocks must have row-level security enabled';
  END IF;

  IF has_table_privilege('anon', 'public.avatar_unlocks', 'INSERT')
     OR has_table_privilege('anon', 'public.avatar_unlocks', 'UPDATE')
     OR has_table_privilege('anon', 'public.avatar_unlocks', 'DELETE')
     OR has_table_privilege('anon', 'public.avatar_unlocks', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.avatar_unlocks', 'INSERT')
     OR has_table_privilege('authenticated', 'public.avatar_unlocks', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.avatar_unlocks', 'DELETE')
     OR has_table_privilege('authenticated', 'public.avatar_unlocks', 'TRUNCATE') THEN
    RAISE EXCEPTION 'browser roles can still forge or alter avatar entitlements';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.avatar_unlocks', 'SELECT')
     OR NOT EXISTS (
       SELECT 1
         FROM pg_policies p
        WHERE p.schemaname = 'public'
          AND p.tablename = 'avatar_unlocks'
          AND p.policyname = 'avatar_unlocks_select_own'
          AND p.cmd = 'SELECT'
          AND p.roles && ARRAY['authenticated'::name]
     ) THEN
    RAISE EXCEPTION 'players lost owner-scoped reads of avatar entitlements';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policies p
     WHERE p.schemaname = 'public'
       AND p.tablename = 'avatar_unlocks'
       AND p.cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE')
       AND p.roles && ARRAY['public'::name, 'anon'::name, 'authenticated'::name]
  ) THEN
    RAISE EXCEPTION 'a browser mutation policy still exists on avatar_unlocks';
  END IF;

  IF public.sp_avatar_cosmetic_vip_is_active(
       true, 'monthly', now() - interval '1 second', now()
     ) THEN
    RAISE EXCEPTION 'an expired monthly VIP still owns premium avatar cosmetics';
  END IF;
  IF NOT public.sp_avatar_cosmetic_vip_is_active(
       true, 'monthly', now() + interval '1 second', now()
     ) THEN
    RAISE EXCEPTION 'an active monthly VIP lost premium avatar cosmetics';
  END IF;
  IF NOT public.sp_avatar_cosmetic_vip_is_active(
       true, 'lifetime', now() - interval '1 year', now()
     ) THEN
    RAISE EXCEPTION 'a lifetime VIP was incorrectly expired';
  END IF;
  IF public.sp_avatar_cosmetic_vip_is_active(
       false, 'lifetime', NULL, now()
     ) THEN
    RAISE EXCEPTION 'is_vip=false incorrectly grants lifetime cosmetics';
  END IF;

  IF (
    SELECT count(*) FROM public.avatar_style_catalog
  ) <> cardinality(v_supported_premium)
     OR EXISTS (
       SELECT 1
         FROM public.avatar_style_catalog c
        WHERE NOT (c.unlock_token = ANY (v_supported_premium))
     )
     OR EXISTS (
       SELECT 1
         FROM unnest(v_supported_premium) AS supported(token)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.avatar_style_catalog c
           WHERE c.unlock_token = supported.token
        )
     ) THEN
    RAISE EXCEPTION
      'avatar_style_catalog must contain exactly the fourteen Club Arena premium styles';
  END IF;

  IF (SELECT count(*) FROM public.avatar_style_catalog WHERE unlock_token LIKE 'frame\_%') <> 7
     OR (SELECT count(*) FROM public.avatar_style_catalog WHERE unlock_token LIKE 'aura\_%') <> 7 THEN
    RAISE EXCEPTION 'avatar_style_catalog must contain seven premium frames and seven premium auras';
  END IF;

  FOREACH v_token IN ARRAY v_free LOOP
    IF NOT public.sp_cosmetic_is_owned(
      NULL,
      v_token,
      split_part(v_token, '_', 1)
    ) THEN
      RAISE EXCEPTION 'free avatar cosmetic % was refused', v_token;
    END IF;
  END LOOP;

  FOREACH v_token IN ARRAY v_supported_premium LOOP
    IF public.sp_cosmetic_is_owned(
      NULL,
      v_token,
      split_part(v_token, '_', 1)
    ) THEN
      RAISE EXCEPTION 'premium avatar cosmetic % leaked to an anonymous owner', v_token;
    END IF;
    IF public.sp_resolve_avatar_entitlement(v_token) IS DISTINCT FROM v_token THEN
      RAISE EXCEPTION 'premium avatar cosmetic % does not resolve as a recognized entitlement', v_token;
    END IF;
  END LOOP;

  IF public.sp_cosmetic_is_owned(NULL, 'frame_invented', 'frame')
     OR public.sp_cosmetic_is_owned(NULL, 'frame_gold', 'aura')
     OR public.sp_cosmetic_is_owned(NULL, 'aura_fire', 'frame')
     OR public.sp_cosmetic_is_owned(NULL, 'frame_gold', 'invented') THEN
    RAISE EXCEPTION 'avatar cosmetic ownership no longer fails closed';
  END IF;

  SELECT count(*) INTO v_dirty
    FROM public.profiles p
   WHERE (p.equipped_frame IS NOT NULL
          AND NOT public.sp_cosmetic_is_owned(p.id, p.equipped_frame, 'frame'))
      OR (p.equipped_aura IS NOT NULL
          AND NOT public.sp_cosmetic_is_owned(p.id, p.equipped_aura, 'aura'));
  IF v_dirty > 0 THEN
    RAISE EXCEPTION '% profiles rows hold an unowned or unknown avatar cosmetic', v_dirty;
  END IF;

  SELECT count(*) INTO v_dirty
    FROM public.user_avatars a
   WHERE (a.equipped_frame IS NOT NULL
          AND NOT public.sp_cosmetic_is_owned(a.user_id, a.equipped_frame, 'frame'))
      OR (a.equipped_aura IS NOT NULL
          AND NOT public.sp_cosmetic_is_owned(a.user_id, a.equipped_aura, 'aura'));
  IF v_dirty > 0 THEN
    RAISE EXCEPTION '% user_avatars rows hold an unowned or unknown avatar cosmetic', v_dirty;
  END IF;
END
$$;

-- ── Durable client + engine cutover seal ──────────────────────────────────

-- The post-cutover migration revokes paths used by the serving client and
-- constrains a column written by the serving engine. Documentation is not an
-- interlock: retain append-only service-role seals that the protected
-- post-deploy job may write only after both exact live Git identities carry
-- the v1 contract. A later protected descendant gets a new row; no prior
-- release receipt is rewritten.
CREATE TABLE IF NOT EXISTS public.phase_one_customization_prerequisite (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO public.phase_one_customization_prerequisite (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.phase_one_customization_cutover_seals (
  contract text NOT NULL DEFAULT 'phase1-customization-v1'
    CHECK (contract = 'phase1-customization-v1'),
  client_sha text NOT NULL CHECK (client_sha ~ '^[0-9a-f]{40}$'),
  engine_sha text NOT NULL CHECK (engine_sha ~ '^[0-9a-f]{40}$'),
  engine_heartbeat_at timestamptz NOT NULL,
  sealed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (contract, client_sha, engine_sha)
);

ALTER TABLE public.phase_one_customization_prerequisite ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phase_one_customization_cutover_seals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.phase_one_customization_prerequisite
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.phase_one_customization_cutover_seals
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_seal_phase_one_customization_cutover(
  p_client_sha text,
  p_engine_sha text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $phase_one_cutover$
DECLARE
  v_prerequisite_installed_at timestamptz;
  v_deploy_at timestamptz;
  v_heartbeat_at timestamptz;
  v_live_versions bigint;
  v_wrong_versions bigint;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'PHASE_ONE_CUTOVER_SERVICE_ROLE_REQUIRED'
      USING ERRCODE = '42501';
  END IF;
  IF p_client_sha IS NULL OR p_client_sha !~ '^[0-9a-f]{40}$'
     OR p_engine_sha IS NULL OR p_engine_sha !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'PHASE_ONE_CUTOVER_EXACT_SHA_REQUIRED'
      USING ERRCODE = '22023';
  END IF;

  SELECT s.installed_at
    INTO v_prerequisite_installed_at
    FROM public.phase_one_customization_prerequisite s
   WHERE s.singleton;

  SELECT max(a.at)
    INTO v_deploy_at
    FROM public.ca_engine_deploy_attempts a
   WHERE a.shipped IS TRUE
     AND a.target_sha = p_engine_sha
     AND a.at >= v_prerequisite_installed_at;

  IF v_deploy_at IS NULL THEN
    RAISE EXCEPTION 'PHASE_ONE_CUTOVER_ENGINE_RELEASE_NOT_SHIPPED'
      USING ERRCODE = '55000';
  END IF;

  -- Engine lease writers intentionally persist the eight-character runtime
  -- version. The append-only deploy receipt above binds that prefix to the
  -- exact full release SHA; the trusted post-deploy workflow also reads the
  -- full live /health identity before calling this function. Reject NULL or
  -- any other heartbeat value here so SQL's three-valued logic cannot turn an
  -- unknown engine into a valid cutover.
  WITH live AS (
    SELECT l.engine_version, l.heartbeat_at
      FROM public.engine_leader l
     WHERE l.heartbeat_at > clock_timestamp() - interval '180 seconds'
    UNION ALL
    SELECT l.engine_version, l.heartbeat_at
      FROM public.engine_table_leases l
     WHERE l.heartbeat_at > clock_timestamp() - interval '180 seconds'
  )
  SELECT max(live.heartbeat_at),
         count(DISTINCT coalesce(live.engine_version, '<null>')),
         count(*) FILTER (
           WHERE live.engine_version IS DISTINCT FROM left(p_engine_sha, 8)
         )
    INTO v_heartbeat_at, v_live_versions, v_wrong_versions
    FROM live;

  IF v_heartbeat_at IS NULL OR v_heartbeat_at < v_deploy_at
     OR v_live_versions <> 1 OR v_wrong_versions <> 0 THEN
    RAISE EXCEPTION 'PHASE_ONE_CUTOVER_ENGINE_IS_NOT_EXACT_LIVE_RELEASE'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.phase_one_customization_cutover_seals (
    contract,
    client_sha,
    engine_sha,
    engine_heartbeat_at
  ) VALUES (
    'phase1-customization-v1',
    p_client_sha,
    p_engine_sha,
    v_heartbeat_at
  )
  ON CONFLICT (contract, client_sha, engine_sha) DO NOTHING;

  RETURN jsonb_build_object(
    'sealed', true,
    'contract', 'phase1-customization-v1',
    'client_sha', p_client_sha,
    'engine_sha', p_engine_sha,
    'engine_heartbeat_at', v_heartbeat_at
  );
END;
$phase_one_cutover$;

ALTER FUNCTION public.fn_seal_phase_one_customization_cutover(text, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_seal_phase_one_customization_cutover(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_seal_phase_one_customization_cutover(text, text)
  TO service_role;

COMMENT ON TABLE public.phase_one_customization_cutover_seals IS
  'Append-only protected receipts proving exact live client and engine artifacts both carry the Phase 1 customization contract before legacy paths are retired.';

-- ── Backward-compatible Final Table transition prerequisite ───────────────

DO $final_table_guard$
DECLARE
  v_missing text;
BEGIN
  IF to_regclass('public.tournaments') IS NULL THEN
    RAISE EXCEPTION 'final-table prerequisite: public.tournaments is missing';
  END IF;

  SELECT string_agg(required.column_name, ', ' ORDER BY required.column_name)
    INTO v_missing
    FROM (VALUES ('final_table_triggered'), ('format_contract')) AS required(column_name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM information_schema.columns actual
      WHERE actual.table_schema = 'public'
        AND actual.table_name = 'tournaments'
        AND actual.column_name = required.column_name
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'final-table prerequisite: required columns are missing: %', v_missing;
  END IF;
END;
$final_table_guard$;

-- A transition and its one allowed announcer are one transaction. A stable
-- manager token can recover a committed RPC whose HTTP response was lost,
-- while a new manager token hydrates state without replaying the announcement.
-- Deliberately do not foreign-key these ledgers to the hot tournaments table:
-- the owning RPC locks and validates that row, while a FK would hold a
-- SHARE ROW EXCLUSIVE lock on tournaments for the whole migration.
CREATE TABLE IF NOT EXISTS public.tournament_final_table_transition_receipts (
  tournament_id uuid PRIMARY KEY,
  ownership_token uuid NOT NULL UNIQUE,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  announced_at timestamptz,
  CONSTRAINT tournament_final_table_receipt_claimed_at_finite
    CHECK (isfinite(claimed_at)),
  CONSTRAINT tournament_final_table_receipt_announced_at_finite
    CHECK (announced_at IS NULL OR isfinite(announced_at)),
  CONSTRAINT tournament_final_table_receipt_announcement_order
    CHECK (announced_at IS NULL OR announced_at >= claimed_at)
);

-- This public, payload-minimal projection is the mounted-table recovery path
-- if the owning engine dies after the claim commits but before its broadcast.
-- The private ownership token is never published.
CREATE TABLE IF NOT EXISTS public.tournament_final_table_events (
  tournament_id uuid PRIMARY KEY,
  reached_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tournament_final_table_event_reached_at_finite
    CHECK (isfinite(reached_at))
);

ALTER TABLE public.tournament_final_table_transition_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_final_table_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tournament_final_table_transition_receipts
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.tournament_final_table_events
  FROM PUBLIC, anon, authenticated, service_role;

DROP POLICY IF EXISTS tournament_final_table_events_read ON public.tournament_final_table_events;
CREATE POLICY tournament_final_table_events_read
  ON public.tournament_final_table_events
  FOR SELECT
  TO anon, authenticated
  USING (true);

GRANT SELECT ON TABLE public.tournament_final_table_events TO anon, authenticated, service_role;

-- The old engine can remain live after this prerequisite. Backfill only rows
-- that already carry a persisted unlimited-MTT contract; existing short-format
-- false positives remain untouched until the compatible engine is serving.
INSERT INTO public.tournament_final_table_transition_receipts (
  tournament_id,
  ownership_token
)
SELECT t.id, gen_random_uuid()
  FROM public.tournaments t
 WHERE t.final_table_triggered IS TRUE
   AND (t.format_contract IN ('mtt-v1', 'mtt-v2')) IS TRUE
ON CONFLICT (tournament_id) DO NOTHING;

INSERT INTO public.tournament_final_table_events (tournament_id)
SELECT t.id
  FROM public.tournaments t
 WHERE t.final_table_triggered IS TRUE
   AND (t.format_contract IN ('mtt-v1', 'mtt-v2')) IS TRUE
ON CONFLICT (tournament_id) DO NOTHING;

DO $final_table_publication$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) AND NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'tournament_final_table_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime
      ADD TABLE public.tournament_final_table_events;
  END IF;
END;
$final_table_publication$;

CREATE OR REPLACE FUNCTION public.fn_claim_final_table_transition(
  p_tournament_id uuid,
  p_ownership_token uuid
)
RETURNS TABLE(state text, ownership_token uuid, announced_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $final_table_claim$
DECLARE
  v_format_contract text;
  v_triggered boolean;
  v_owner uuid;
  v_announced_at timestamptz;
BEGIN
  IF p_tournament_id IS NULL OR p_ownership_token IS NULL THEN
    RAISE EXCEPTION 'FINAL_TABLE_CLAIM_INVALID: tournament and ownership token are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT t.format_contract, t.final_table_triggered
    INTO v_format_contract, v_triggered
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINAL_TABLE_CLAIM_NOT_FOUND: tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;

  IF (v_format_contract IN ('mtt-v1', 'mtt-v2')) IS NOT TRUE THEN
    RAISE EXCEPTION 'FINAL_TABLE_CLAIM_FORMAT: % is not an unlimited MTT',
      coalesce(v_format_contract, '<unresolved>')
      USING ERRCODE = '23514';
  END IF;

  SELECT r.ownership_token, r.announced_at
    INTO v_owner, v_announced_at
    FROM public.tournament_final_table_transition_receipts r
   WHERE r.tournament_id = p_tournament_id;

  IF v_triggered IS TRUE THEN
    -- A legacy direct writer may win during deployment overlap. Give that
    -- historical transition a different owner so no new manager replays it.
    IF v_owner IS NULL THEN
      INSERT INTO public.tournament_final_table_transition_receipts (
        tournament_id,
        ownership_token
      ) VALUES (
        p_tournament_id,
        gen_random_uuid()
      )
      ON CONFLICT (tournament_id) DO NOTHING;

      SELECT r.ownership_token, r.announced_at
        INTO v_owner, v_announced_at
        FROM public.tournament_final_table_transition_receipts r
       WHERE r.tournament_id = p_tournament_id;
    END IF;
  ELSE
    INSERT INTO public.tournament_final_table_transition_receipts (
      tournament_id,
      ownership_token
    ) VALUES (
      p_tournament_id,
      p_ownership_token
    )
    ON CONFLICT (tournament_id) DO NOTHING;

    SELECT r.ownership_token, r.announced_at
      INTO v_owner, v_announced_at
      FROM public.tournament_final_table_transition_receipts r
     WHERE r.tournament_id = p_tournament_id;

    IF v_owner IS DISTINCT FROM p_ownership_token THEN
      RAISE EXCEPTION 'FINAL_TABLE_CLAIM_CORRUPT: an untriggered tournament already has another owner'
        USING ERRCODE = '40001';
    END IF;

    UPDATE public.tournaments
       SET final_table_triggered = true
     WHERE id = p_tournament_id
       AND final_table_triggered IS DISTINCT FROM true;
  END IF;

  INSERT INTO public.tournament_final_table_events (tournament_id)
  VALUES (p_tournament_id)
  ON CONFLICT (tournament_id) DO NOTHING;

  RETURN QUERY
  SELECT CASE
           WHEN v_owner = p_ownership_token AND v_announced_at IS NULL
             THEN 'announcement_owned'::text
           ELSE 'already_persisted'::text
         END,
         v_owner,
         v_announced_at;
END;
$final_table_claim$;

CREATE OR REPLACE FUNCTION public.fn_read_final_table_transition(
  p_tournament_id uuid
)
RETURNS TABLE(triggered boolean, ownership_token uuid, announced_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $final_table_read$
  SELECT t.final_table_triggered,
         r.ownership_token,
         r.announced_at
    FROM public.tournaments t
    LEFT JOIN public.tournament_final_table_transition_receipts r
      ON r.tournament_id = t.id
   WHERE t.id = p_tournament_id
$final_table_read$;

CREATE OR REPLACE FUNCTION public.fn_ack_final_table_announcement(
  p_tournament_id uuid,
  p_ownership_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $final_table_ack$
BEGIN
  IF p_tournament_id IS NULL OR p_ownership_token IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.tournament_final_table_transition_receipts
     SET announced_at = coalesce(announced_at, clock_timestamp())
   WHERE tournament_id = p_tournament_id
     AND ownership_token = p_ownership_token;

  RETURN EXISTS (
    SELECT 1
      FROM public.tournament_final_table_transition_receipts r
     WHERE r.tournament_id = p_tournament_id
       AND r.ownership_token = p_ownership_token
       AND r.announced_at IS NOT NULL
  );
END;
$final_table_ack$;

ALTER FUNCTION public.fn_claim_final_table_transition(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_read_final_table_transition(uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_ack_final_table_announcement(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_claim_final_table_transition(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_read_final_table_transition(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ack_final_table_announcement(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_claim_final_table_transition(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_read_final_table_transition(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ack_final_table_announcement(uuid, uuid)
  TO service_role;

COMMENT ON TABLE public.tournament_final_table_transition_receipts IS
  'One durable owner per unlimited-MTT Final Table transition. The owner recovers an ambiguous claim response without allowing a fresh manager to replay the one-shot announcement.';
COMMENT ON TABLE public.tournament_final_table_events IS
  'Public payload-minimal Final Table signal inserted atomically with the private transition receipt so mounted clients converge if the owner dies before broadcast.';

DO $final_table_verify$
DECLARE
  v_invalid bigint;
BEGIN
  SELECT count(*)
    INTO v_invalid
    FROM public.tournament_final_table_transition_receipts r
    JOIN public.tournaments t ON t.id = r.tournament_id
   WHERE t.final_table_triggered IS NOT TRUE
      OR (t.format_contract IN ('mtt-v1', 'mtt-v2')) IS NOT TRUE;

  IF v_invalid <> 0 THEN
    RAISE EXCEPTION 'final-table prerequisite: % invalid transition receipt(s)', v_invalid;
  END IF;

  SELECT count(*)
    INTO v_invalid
    FROM public.tournament_final_table_events e
    JOIN public.tournaments t ON t.id = e.tournament_id
   WHERE t.final_table_triggered IS NOT TRUE
      OR (t.format_contract IN ('mtt-v1', 'mtt-v2')) IS NOT TRUE;

  IF v_invalid <> 0 THEN
    RAISE EXCEPTION 'final-table prerequisite: % invalid public event(s)', v_invalid;
  END IF;

  SELECT count(*)
    INTO v_invalid
    FROM public.tournaments t
   WHERE t.final_table_triggered IS TRUE
     AND (t.format_contract IN ('mtt-v1', 'mtt-v2')) IS TRUE
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_final_table_transition_receipts r
        WHERE r.tournament_id = t.id
     );

  IF v_invalid <> 0 THEN
    RAISE EXCEPTION 'final-table prerequisite: % MTT transition(s) lack an owner', v_invalid;
  END IF;

  SELECT count(*)
    INTO v_invalid
    FROM public.tournaments t
   WHERE t.final_table_triggered IS TRUE
     AND (t.format_contract IN ('mtt-v1', 'mtt-v2')) IS TRUE
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_final_table_events e
        WHERE e.tournament_id = t.id
     );

  IF v_invalid <> 0 THEN
    RAISE EXCEPTION 'final-table prerequisite: % MTT transition(s) lack a public event', v_invalid;
  END IF;

  IF to_regprocedure('public.fn_claim_final_table_transition(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_read_final_table_transition(uuid)') IS NULL
     OR to_regprocedure('public.fn_ack_final_table_announcement(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'final-table prerequisite: transition receipt RPCs are incomplete';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) AND NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'tournament_final_table_events'
  ) THEN
    RAISE EXCEPTION 'final-table prerequisite: public event is not in supabase_realtime';
  END IF;

  IF has_table_privilege('anon', 'public.tournament_final_table_events', 'INSERT')
     OR has_table_privilege('anon', 'public.tournament_final_table_events', 'UPDATE')
     OR has_table_privilege('anon', 'public.tournament_final_table_events', 'DELETE')
     OR has_table_privilege('authenticated', 'public.tournament_final_table_events', 'INSERT')
     OR has_table_privilege('authenticated', 'public.tournament_final_table_events', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.tournament_final_table_events', 'DELETE')
     OR has_table_privilege('service_role', 'public.tournament_final_table_events', 'INSERT')
     OR has_table_privilege('service_role', 'public.tournament_final_table_events', 'UPDATE')
     OR has_table_privilege('service_role', 'public.tournament_final_table_events', 'DELETE') THEN
    RAISE EXCEPTION 'final-table prerequisite: public event has a direct writer';
  END IF;
END;
$final_table_verify$;

COMMIT;
