-- Phase 5: Table Management content commands are fail-closed, versioned, and
-- hostile-input safe. One transaction intentionally coalesces the PostgREST
-- schema-cache reload for this complete contract change.

BEGIN;

ALTER TABLE public.game_ticker_settings
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;
ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS message_revision bigint NOT NULL DEFAULT 1;
ALTER TABLE public.club_announcements
  ADD COLUMN IF NOT EXISTS management_revision bigint NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'game_ticker_settings_revision_positive'
      AND conrelid = 'public.game_ticker_settings'::regclass
  ) THEN
    ALTER TABLE public.game_ticker_settings
      ADD CONSTRAINT game_ticker_settings_revision_positive CHECK (revision > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clubs_message_revision_positive'
      AND conrelid = 'public.clubs'::regclass
  ) THEN
    ALTER TABLE public.clubs
      ADD CONSTRAINT clubs_message_revision_positive CHECK (message_revision > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'club_announcements_management_revision_positive'
      AND conrelid = 'public.club_announcements'::regclass
  ) THEN
    ALTER TABLE public.club_announcements
      ADD CONSTRAINT club_announcements_management_revision_positive
      CHECK (management_revision > 0);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_game_management_color_luminance(p_color text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path TO 'pg_catalog'
AS $$
DECLARE
  v_red numeric;
  v_green numeric;
  v_blue numeric;
BEGIN
  IF p_color !~ '^#[0-9A-Fa-f]{6}$' THEN
    RETURN NULL;
  END IF;
  v_red := get_byte(decode(substr(p_color, 2, 2), 'hex'), 0) / 255.0;
  v_green := get_byte(decode(substr(p_color, 4, 2), 'hex'), 0) / 255.0;
  v_blue := get_byte(decode(substr(p_color, 6, 2), 'hex'), 0) / 255.0;
  v_red := CASE WHEN v_red <= 0.03928 THEN v_red / 12.92 ELSE power((v_red + 0.055) / 1.055, 2.4) END;
  v_green := CASE WHEN v_green <= 0.03928 THEN v_green / 12.92 ELSE power((v_green + 0.055) / 1.055, 2.4) END;
  v_blue := CASE WHEN v_blue <= 0.03928 THEN v_blue / 12.92 ELSE power((v_blue + 0.055) / 1.055, 2.4) END;
  RETURN 0.2126 * v_red + 0.7152 * v_green + 0.0722 * v_blue;
END $$;

CREATE OR REPLACE FUNCTION public.fn_game_management_contrast_ratio(p_foreground text, p_background text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN public.fn_game_management_color_luminance(p_foreground) IS NULL
      OR public.fn_game_management_color_luminance(p_background) IS NULL THEN NULL
    ELSE
      (GREATEST(
        public.fn_game_management_color_luminance(p_foreground),
        public.fn_game_management_color_luminance(p_background)
      ) + 0.05)
      /
      (LEAST(
        public.fn_game_management_color_luminance(p_foreground),
        public.fn_game_management_color_luminance(p_background)
      ) + 0.05)
  END
$$;

CREATE OR REPLACE FUNCTION public.fn_get_game_ticker_settings_for_management(
  p_scope text,
  p_scope_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_settings jsonb;
  v_revision bigint;
  v_updated_at timestamptz;
  v_access jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  IF p_scope NOT IN ('club', 'union') OR p_scope_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_scope');
  END IF;
  IF p_scope = 'club' THEN
    v_access := public.fn_game_creation_access(p_scope_id);
    IF COALESCE((v_access->>'allowed')::boolean, false) = false
      OR v_access->>'union_id' IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
    SELECT settings, revision, updated_at
      INTO v_settings, v_revision, v_updated_at
      FROM public.game_ticker_settings
      WHERE club_id = p_scope_id;
  ELSE
    IF NOT public.fn_is_union_operator(p_scope_id, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
    SELECT settings, revision, updated_at
      INTO v_settings, v_revision, v_updated_at
      FROM public.game_ticker_settings
      WHERE union_id = p_scope_id;
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'settings', COALESCE(v_settings, '{}'::jsonb),
    'revision', COALESCE(v_revision, 0),
    'updated_at', v_updated_at
  );
END $$;

CREATE OR REPLACE FUNCTION public.fn_save_game_ticker_settings_versioned(
  p_scope text,
  p_scope_id uuid,
  p_expected_revision bigint,
  p_settings jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_access jsonb;
  v_existing_revision bigint;
  v_next_revision bigint;
  v_updated_at timestamptz;
  v_sanitized jsonb;
  v_sources jsonb := '{}'::jsonb;
  v_custom_messages jsonb := '[]'::jsonb;
  v_service_messages jsonb := '[]'::jsonb;
  v_source text;
  v_font text;
  v_speed integer;
  v_background text;
  v_text text;
  v_accent text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  IF p_scope NOT IN ('club', 'union') OR p_scope_id IS NULL
    OR COALESCE(p_expected_revision, -1) < 0
    OR jsonb_typeof(p_settings) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  IF p_scope = 'club' THEN
    v_access := public.fn_game_creation_access(p_scope_id);
    IF COALESCE((v_access->>'allowed')::boolean, false) = false
      OR v_access->>'union_id' IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
    -- Serialize the first write as well as updates. A row lock cannot protect
    -- two simultaneous inserts when neither transaction can see a row yet.
    PERFORM pg_advisory_xact_lock(hashtextextended('ticker:club:' || p_scope_id::text, 0));
    SELECT revision INTO v_existing_revision
      FROM public.game_ticker_settings WHERE club_id = p_scope_id FOR UPDATE;
  ELSE
    IF NOT public.fn_is_union_operator(p_scope_id, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('ticker:union:' || p_scope_id::text, 0));
    SELECT revision INTO v_existing_revision
      FROM public.game_ticker_settings WHERE union_id = p_scope_id FOR UPDATE;
  END IF;

  IF COALESCE(v_existing_revision, 0) <> p_expected_revision THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'version_conflict',
      'current_revision', COALESCE(v_existing_revision, 0)
    );
  END IF;

  IF p_settings ? 'enabled' AND jsonb_typeof(p_settings->'enabled') <> 'boolean' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  IF COALESCE(p_settings->>'speed_seconds', '') !~ '^[0-9]{1,3}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  v_speed := (p_settings->>'speed_seconds')::integer;
  IF v_speed NOT BETWEEN 8 AND 60 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  v_background := p_settings->>'background_color';
  v_text := p_settings->>'text_color';
  v_accent := p_settings->>'accent_color';
  IF COALESCE(v_background, '') !~ '^#[0-9A-Fa-f]{6}$'
    OR COALESCE(v_text, '') !~ '^#[0-9A-Fa-f]{6}$'
    OR COALESCE(v_accent, '') !~ '^#[0-9A-Fa-f]{6}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_colors');
  END IF;
  IF public.fn_game_management_contrast_ratio(v_text, v_background) < 4.5
    OR public.fn_game_management_contrast_ratio(v_accent, v_background) < 3.0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'inaccessible_colors');
  END IF;
  v_font := p_settings->>'font_family';
  IF v_font NOT IN ('Rajdhani', 'Inter', 'Roboto Condensed', 'System') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_font');
  END IF;
  IF jsonb_typeof(p_settings->'sources') <> 'object'
    OR jsonb_typeof(p_settings->'custom_messages') <> 'array'
    OR jsonb_typeof(p_settings->'service_messages') <> 'array'
    OR jsonb_array_length(p_settings->'custom_messages') > 10
    OR jsonb_array_length(p_settings->'service_messages') > 5 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;

  FOREACH v_source IN ARRAY ARRAY[
    'overlays', 'starting_soon', 'custom_messages', 'registration_closing',
    'guarantees', 'table_openings', 'maintenance', 'winner_results'
  ] LOOP
    IF p_settings->'sources' ? v_source
      AND jsonb_typeof(p_settings->'sources'->v_source) <> 'boolean' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
    END IF;
    v_sources := v_sources || jsonb_build_object(
      v_source,
      COALESCE((p_settings->'sources'->>v_source)::boolean, false)
    );
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_settings->'custom_messages') item
    WHERE jsonb_typeof(item) <> 'string'
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_settings->'service_messages') item
    WHERE jsonb_typeof(item) <> 'string'
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p_settings->'custom_messages') item(value)
    WHERE char_length(value) > 160 OR btrim(value) = ''
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p_settings->'service_messages') item(value)
    WHERE char_length(value) > 160 OR btrim(value) = ''
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_messages');
  END IF;

  SELECT COALESCE(jsonb_agg(regexp_replace(btrim(value), '\s+', ' ', 'g') ORDER BY ord), '[]'::jsonb)
    INTO v_custom_messages
    FROM jsonb_array_elements_text(p_settings->'custom_messages') WITH ORDINALITY item(value, ord);
  SELECT COALESCE(jsonb_agg(regexp_replace(btrim(value), '\s+', ' ', 'g') ORDER BY ord), '[]'::jsonb)
    INTO v_service_messages
    FROM jsonb_array_elements_text(p_settings->'service_messages') WITH ORDINALITY item(value, ord);

  v_sanitized := jsonb_build_object(
    'enabled', COALESCE((p_settings->>'enabled')::boolean, true),
    'speed_seconds', v_speed,
    'background_color', lower(v_background),
    'text_color', lower(v_text),
    'accent_color', lower(v_accent),
    'font_family', v_font,
    'sources', v_sources,
    'custom_messages', v_custom_messages,
    'service_messages', v_service_messages
  );
  v_next_revision := COALESCE(v_existing_revision, 0) + 1;

  IF p_scope = 'club' THEN
    INSERT INTO public.game_ticker_settings(club_id, settings, created_by, revision, updated_at)
    VALUES (p_scope_id, v_sanitized, v_uid, v_next_revision, now())
    ON CONFLICT (club_id) WHERE club_id IS NOT NULL DO UPDATE
      SET settings = EXCLUDED.settings,
          revision = EXCLUDED.revision,
          updated_at = now()
    RETURNING updated_at INTO v_updated_at;
  ELSE
    INSERT INTO public.game_ticker_settings(union_id, settings, created_by, revision, updated_at)
    VALUES (p_scope_id, v_sanitized, v_uid, v_next_revision, now())
    ON CONFLICT (union_id) WHERE union_id IS NOT NULL DO UPDATE
      SET settings = EXCLUDED.settings,
          revision = EXCLUDED.revision,
          updated_at = now()
    RETURNING updated_at INTO v_updated_at;
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'settings', v_sanitized,
    'revision', v_next_revision,
    'updated_at', v_updated_at
  );
END $$;

CREATE OR REPLACE FUNCTION public.fn_get_club_message_management(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_identity jsonb;
  v_identity_revision bigint;
  v_announcements jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.fn_can_create_games(p_club_id, v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;
  SELECT jsonb_build_object(
      'tagline', COALESCE(c.tagline, ''),
      'lobby_message', COALESCE(c.lobby_message, ''),
      'description', COALESCE(c.description, '')
    ), c.message_revision
    INTO v_identity, v_identity_revision
    FROM public.clubs c WHERE c.id = p_club_id;
  IF v_identity IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', a.id,
      'title', a.title,
      'content', a.content,
      'is_pinned', COALESCE(a.is_pinned, false),
      'is_active', COALESCE(a.is_active, true),
      'created_at', a.created_at,
      'updated_at', a.updated_at,
      'revision', a.management_revision
    ) ORDER BY a.is_pinned DESC, a.created_at DESC), '[]'::jsonb)
    INTO v_announcements
    FROM public.club_announcements a WHERE a.club_id = p_club_id;
  RETURN jsonb_build_object(
    'ok', true,
    'identity', v_identity,
    'identity_revision', v_identity_revision,
    'announcements', v_announcements
  );
END $$;

CREATE OR REPLACE FUNCTION public.fn_save_club_identity_messages_versioned(
  p_club_id uuid,
  p_expected_revision bigint,
  p_tagline text,
  p_lobby_message text,
  p_description text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_current_revision bigint;
  v_tagline text;
  v_lobby text;
  v_description text;
BEGIN
  IF v_uid IS NULL OR NOT public.fn_can_create_games(p_club_id, v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;
  SELECT message_revision INTO v_current_revision
    FROM public.clubs WHERE id = p_club_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');
  END IF;
  IF v_current_revision <> p_expected_revision THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'version_conflict',
      'current_revision', v_current_revision
    );
  END IF;
  IF char_length(COALESCE(p_tagline, '')) > 72
    OR char_length(COALESCE(p_lobby_message, '')) > 72
    OR char_length(COALESCE(p_description, '')) > 500 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'character_limit');
  END IF;
  v_tagline := trim(regexp_replace(COALESCE(p_tagline, ''), '[\r\n\t ]+', ' ', 'g'));
  v_lobby := trim(regexp_replace(COALESCE(p_lobby_message, ''), '[\r\n\t ]+', ' ', 'g'));
  v_description := trim(COALESCE(p_description, ''));
  UPDATE public.clubs
    SET tagline = NULLIF(v_tagline, ''),
        lobby_message = NULLIF(v_lobby, ''),
        description = NULLIF(v_description, ''),
        message_revision = message_revision + 1,
        updated_at = now()
    WHERE id = p_club_id
    RETURNING message_revision INTO v_current_revision;
  RETURN jsonb_build_object(
    'ok', true,
    'revision', v_current_revision,
    'identity', jsonb_build_object(
      'tagline', v_tagline,
      'lobby_message', v_lobby,
      'description', v_description
    )
  );
END $$;

CREATE OR REPLACE FUNCTION public.fn_manage_club_announcement_versioned(
  p_action text,
  p_club_id uuid,
  p_announcement_id uuid DEFAULT NULL,
  p_expected_revision bigint DEFAULT 0,
  p_title text DEFAULT NULL,
  p_content text DEFAULT NULL,
  p_is_pinned boolean DEFAULT false,
  p_is_active boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid := p_announcement_id;
  v_current_revision bigint;
  v_title text;
  v_content text;
BEGIN
  IF v_uid IS NULL OR NOT public.fn_can_create_games(p_club_id, v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;
  IF p_action NOT IN ('save', 'delete', 'set_pin', 'set_active') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_action');
  END IF;
  IF v_id IS NOT NULL THEN
    SELECT management_revision INTO v_current_revision
      FROM public.club_announcements
      WHERE id = v_id AND club_id = p_club_id
      FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'announcement_not_found');
    END IF;
    IF v_current_revision <> p_expected_revision THEN
      RETURN jsonb_build_object(
        'ok', false,
        'reason', 'version_conflict',
        'current_revision', v_current_revision
      );
    END IF;
  ELSIF p_action <> 'save' OR p_expected_revision <> 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;

  IF p_action = 'delete' THEN
    DELETE FROM public.club_announcements WHERE id = v_id AND club_id = p_club_id;
    RETURN jsonb_build_object('ok', true, 'id', v_id);
  ELSIF p_action = 'set_pin' THEN
    UPDATE public.club_announcements
      SET is_pinned = p_is_pinned,
          management_revision = management_revision + 1,
          updated_at = now()
      WHERE id = v_id AND club_id = p_club_id
      RETURNING management_revision INTO v_current_revision;
    RETURN jsonb_build_object('ok', true, 'id', v_id, 'revision', v_current_revision);
  ELSIF p_action = 'set_active' THEN
    UPDATE public.club_announcements
      SET is_active = p_is_active,
          management_revision = management_revision + 1,
          updated_at = now()
      WHERE id = v_id AND club_id = p_club_id
      RETURNING management_revision INTO v_current_revision;
    RETURN jsonb_build_object('ok', true, 'id', v_id, 'revision', v_current_revision);
  END IF;

  IF char_length(COALESCE(p_title, '')) > 100
    OR char_length(COALESCE(p_content, '')) > 2000 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'character_limit');
  END IF;
  v_title := trim(regexp_replace(COALESCE(p_title, ''), '[\r\n\t ]+', ' ', 'g'));
  v_content := trim(COALESCE(p_content, ''));
  IF v_title = '' OR v_content = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'message_required');
  END IF;
  IF v_id IS NULL THEN
    INSERT INTO public.club_announcements(
      club_id, author_id, created_by, title, content, message,
      is_pinned, is_active, management_revision
    ) VALUES (
      p_club_id, v_uid, v_uid, v_title, v_content, v_content,
      p_is_pinned, p_is_active, 1
    ) RETURNING id, management_revision INTO v_id, v_current_revision;
  ELSE
    UPDATE public.club_announcements
      SET title = v_title,
          content = v_content,
          message = v_content,
          is_pinned = p_is_pinned,
          is_active = p_is_active,
          management_revision = management_revision + 1,
          updated_at = now()
      WHERE id = v_id AND club_id = p_club_id
      RETURNING management_revision INTO v_current_revision;
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'revision', v_current_revision);
END $$;

-- The unversioned content commands remain callable by service-role recovery
-- code only. Browser operators have one compare-and-swap command door.
REVOKE ALL ON FUNCTION public.fn_save_game_ticker_settings(text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_save_club_identity_messages(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_manage_club_announcement(text, uuid, uuid, text, text, boolean, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_save_game_ticker_settings(text, uuid, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_save_club_identity_messages(uuid, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_manage_club_announcement(text, uuid, uuid, text, text, boolean, boolean)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_game_management_color_luminance(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_game_management_contrast_ratio(text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_get_game_ticker_settings_for_management(text, uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_save_game_ticker_settings_versioned(text, uuid, bigint, jsonb)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_save_club_identity_messages_versioned(uuid, bigint, text, text, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_manage_club_announcement_versioned(text, uuid, uuid, bigint, text, text, boolean, boolean)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_get_game_ticker_settings_for_management(text, uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_save_game_ticker_settings_versioned(text, uuid, bigint, jsonb)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_save_club_identity_messages_versioned(uuid, bigint, text, text, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_manage_club_announcement_versioned(text, uuid, uuid, bigint, text, text, boolean, boolean)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_save_game_ticker_settings_versioned(text, uuid, bigint, jsonb)
  IS 'Versioned, hostile-input-safe Table Management ticker command. Stale operators cannot overwrite newer saves.';
COMMENT ON FUNCTION public.fn_save_club_identity_messages_versioned(uuid, bigint, text, text, text)
  IS 'Compare-and-swap command for player-facing club identity messages.';
COMMENT ON FUNCTION public.fn_manage_club_announcement_versioned(text, uuid, uuid, bigint, text, text, boolean, boolean)
  IS 'Compare-and-swap announcement command. Revision zero is reserved for a new announcement.';

COMMIT;
