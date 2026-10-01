-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260421035953 "20260421040100_phase_b_pass7_edit_home_group_hardening"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 425b9fd24514a343b4a24beb9fe0cdb4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase B Pass 7 — edit_home_group input hardening
--
-- F165 (MEDIUM — defacement / availability):
--   edit_home_group used COALESCE(p_updates->>'name', name) for the name
--   field. Because jsonb_extract_text('') returns '' (not NULL), a caller
--   sending {"name": ""} would set the group name to an empty string.
--   DB CHECK is length(name) <= 120 with no lower bound, so the empty
--   value passes. Impact: admin griefer on a co-hosted group blanks the
--   group name; the public slug page renders "" as the group title until
--   an owner notices and re-fixes it. Low-exploit but easy to weaponize.
--
--   Fix: validate p_updates->>'name' is non-empty when provided, matching
--   the existing profile_photo_url guard pattern (CANNOT_CLEAR_LOGO).
--
-- F166 (LOW — input hygiene on lat/lng):
--   Latitude and longitude have no CHECK constraint. A caller could set
--   lat=500, lng=-1000. Breaks distance sorts and map display for every
--   subsequent viewer. No data corruption, no auth bypass, but bad data.
--
--   Fix: validate ranges inside the RPC (lat ∈ [-90, 90], lng ∈ [-180, 180])
--   before the UPDATE. DB-level CHECK would require a backfill of any
--   existing bad data; RPC-level validation ships without migration risk.
--
-- Also caught while reviewing the body: `name` used a COALESCE pattern
-- where every other field uses CASE-WHEN-THEN-ELSE. That inconsistency
-- hid the F165 bug. Normalized to CASE-WHEN to match the rest.

CREATE OR REPLACE FUNCTION public.edit_home_group(
    p_group_id uuid,
    p_caller_user_id uuid,
    p_updates jsonb
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_group       RECORD;
    v_is_host     boolean;
    v_allowed     text[] := ARRAY[
        'name','description','tagline','profile_photo_url','cover_photo_url',
        'city','state','zip_code','latitude','longitude',
        'default_game_type','default_stakes','typical_buyin_min','typical_buyin_max',
        'max_players','typical_day','typical_time','frequency',
        'is_private','requires_approval','tags'
    ];
    v_key         text;
    v_bad_keys    text[] := ARRAY[]::text[];
    v_new_name    text;
    v_new_lat     numeric;
    v_new_lng     numeric;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;

    v_is_host := (v_group.owner_id = p_caller_user_id) OR EXISTS (
        SELECT 1 FROM commander_home_members
         WHERE group_id = p_group_id AND user_id = p_caller_user_id
           AND role = 'admin' AND status = 'approved');

    IF NOT v_is_host THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    -- Allow-list validation
    FOR v_key IN SELECT jsonb_object_keys(p_updates) LOOP
        IF NOT (v_key = ANY (v_allowed)) THEN
            v_bad_keys := array_append(v_bad_keys, v_key);
        END IF;
    END LOOP;
    IF array_length(v_bad_keys, 1) > 0 THEN
        RAISE EXCEPTION 'DISALLOWED_FIELDS: %', array_to_string(v_bad_keys, ',');
    END IF;

    -- F165: reject empty name if name is being set
    IF p_updates ? 'name' THEN
        v_new_name := p_updates->>'name';
        IF v_new_name IS NULL OR length(trim(v_new_name)) = 0 THEN
            RAISE EXCEPTION 'INVALID_NAME'
                  USING HINT = 'name cannot be empty or whitespace';
        END IF;
        -- Also surface the CHECK constraint as a clean app error
        IF length(v_new_name) > 120 THEN
            RAISE EXCEPTION 'NAME_TOO_LONG'
                  USING HINT = 'max 120 characters';
        END IF;
    END IF;

    -- F166: validate lat/lng ranges (Earth coords only)
    IF p_updates ? 'latitude' AND p_updates->>'latitude' IS NOT NULL THEN
        v_new_lat := (p_updates->>'latitude')::numeric;
        IF v_new_lat < -90 OR v_new_lat > 90 THEN
            RAISE EXCEPTION 'INVALID_LATITUDE'
                  USING HINT = 'latitude must be in [-90, 90]';
        END IF;
    END IF;
    IF p_updates ? 'longitude' AND p_updates->>'longitude' IS NOT NULL THEN
        v_new_lng := (p_updates->>'longitude')::numeric;
        IF v_new_lng < -180 OR v_new_lng > 180 THEN
            RAISE EXCEPTION 'INVALID_LONGITUDE'
                  USING HINT = 'longitude must be in [-180, 180]';
        END IF;
    END IF;

    -- Existing guard: profile_photo_url cannot be cleared
    IF p_updates ? 'profile_photo_url'
       AND (p_updates->>'profile_photo_url' IS NULL
            OR trim(p_updates->>'profile_photo_url') = '') THEN
        RAISE EXCEPTION 'CANNOT_CLEAR_LOGO';
    END IF;

    UPDATE commander_home_groups SET
        -- F165 fix: use CASE-WHEN like every other field (was COALESCE)
        name               = CASE WHEN p_updates ? 'name' THEN p_updates->>'name' ELSE name END,
        description        = CASE WHEN p_updates ? 'description' THEN p_updates->>'description' ELSE description END,
        tagline            = CASE WHEN p_updates ? 'tagline' THEN p_updates->>'tagline' ELSE tagline END,
        profile_photo_url  = COALESCE(p_updates->>'profile_photo_url', profile_photo_url),
        cover_photo_url    = CASE WHEN p_updates ? 'cover_photo_url' THEN p_updates->>'cover_photo_url' ELSE cover_photo_url END,
        city               = CASE WHEN p_updates ? 'city' THEN p_updates->>'city' ELSE city END,
        state              = CASE WHEN p_updates ? 'state' THEN p_updates->>'state' ELSE state END,
        zip_code           = CASE WHEN p_updates ? 'zip_code' THEN p_updates->>'zip_code' ELSE zip_code END,
        latitude           = CASE WHEN p_updates ? 'latitude' THEN (p_updates->>'latitude')::numeric ELSE latitude END,
        longitude          = CASE WHEN p_updates ? 'longitude' THEN (p_updates->>'longitude')::numeric ELSE longitude END,
        default_game_type  = CASE WHEN p_updates ? 'default_game_type' THEN p_updates->>'default_game_type' ELSE default_game_type END,
        default_stakes     = CASE WHEN p_updates ? 'default_stakes' THEN p_updates->>'default_stakes' ELSE default_stakes END,
        typical_buyin_min  = CASE WHEN p_updates ? 'typical_buyin_min' THEN (p_updates->>'typical_buyin_min')::int ELSE typical_buyin_min END,
        typical_buyin_max  = CASE WHEN p_updates ? 'typical_buyin_max' THEN (p_updates->>'typical_buyin_max')::int ELSE typical_buyin_max END,
        max_players        = CASE WHEN p_updates ? 'max_players' THEN (p_updates->>'max_players')::int ELSE max_players END,
        typical_day        = CASE WHEN p_updates ? 'typical_day' THEN p_updates->>'typical_day' ELSE typical_day END,
        typical_time       = CASE WHEN p_updates ? 'typical_time' THEN (p_updates->>'typical_time')::time ELSE typical_time END,
        frequency          = CASE WHEN p_updates ? 'frequency' THEN p_updates->>'frequency' ELSE frequency END,
        is_private         = CASE WHEN p_updates ? 'is_private' THEN (p_updates->>'is_private')::boolean ELSE is_private END,
        requires_approval  = CASE WHEN p_updates ? 'requires_approval' THEN (p_updates->>'requires_approval')::boolean ELSE requires_approval END,
        tags               = CASE WHEN p_updates ? 'tags'
                                  THEN ARRAY(SELECT jsonb_array_elements_text(p_updates->'tags'))::text[]
                                  ELSE tags END,
        updated_at         = NOW()
     WHERE id = p_group_id;

    INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (p_group_id, p_caller_user_id, 'group', p_group_id, 'edited',
            jsonb_build_object('fields', (SELECT array_agg(k) FROM jsonb_object_keys(p_updates) k)));

    RETURN jsonb_build_object(
        'success', true,
        'group_id', p_group_id,
        'fields_updated', (SELECT array_agg(k) FROM jsonb_object_keys(p_updates) k)
    );
END;
$function$;
