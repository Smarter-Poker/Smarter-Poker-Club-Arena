-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419155735 "phase24c1_game_group_lifecycle_rpcs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 185236372ea9b467bafa2f15b7b523e4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 24 PART C1 — Game + group lifecycle RPCs
--  -----------------------------------------------------------------------
--  P1.1  cancel_home_game       — host cancels scheduled game
--  P1.2  complete_home_game     — mark done, increment stats
--  P1.3  edit_home_group        — update group meta (host only)
--  P1.4  edit_home_game         — update game meta (host only)
--  P1.7  transfer_home_group_ownership — owner hands control to admin
-- =========================================================================

-- ────────────────────────────────────────────────────────────────────────
-- P1.1: cancel_home_game
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_home_game(
    p_game_id          uuid,
    p_caller_user_id   uuid,
    p_reason           text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_game   RECORD;
    v_group  RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;

    IF v_game.status IN ('completed','cancelled') THEN
        RAISE EXCEPTION 'GAME_ALREADY_FINAL' 
              USING HINT = 'status is ' || v_game.status;
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    -- Only game host, group owner, or group admin can cancel
    IF v_game.host_id <> p_caller_user_id 
       AND v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (
           SELECT 1 FROM commander_home_members 
            WHERE group_id = v_game.group_id 
              AND user_id = p_caller_user_id
              AND role = 'admin' AND status = 'approved')
    THEN
        RAISE EXCEPTION 'NOT_AUTHORIZED_TO_CANCEL';
    END IF;

    UPDATE commander_home_games
       SET status              = 'cancelled',
           cancelled_at        = NOW(),
           cancelled_by        = p_caller_user_id,
           cancellation_reason = p_reason,
           updated_at          = NOW()
     WHERE id = p_game_id;

    -- Audit
    INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (v_game.group_id, p_caller_user_id, 'game', p_game_id, 'cancelled',
            jsonb_build_object('reason', p_reason, 'scheduled_date', v_game.scheduled_date));

    RETURN jsonb_build_object(
        'success', true,
        'game_id', p_game_id,
        'new_status', 'cancelled',
        'rsvps_to_notify', (SELECT COUNT(*) FROM commander_home_rsvps 
                             WHERE game_id = p_game_id AND response IN ('yes','maybe','waitlist'))
    );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.cancel_home_game(uuid, uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cancel_home_game(uuid, uuid, text) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P1.2: complete_home_game
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_home_game(
    p_game_id          uuid,
    p_caller_user_id   uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_game    RECORD;
    v_group   RECORD;
    v_attended int;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;

    IF v_game.status = 'completed' THEN
        RAISE EXCEPTION 'ALREADY_COMPLETED';
    END IF;
    IF v_game.status = 'cancelled' THEN
        RAISE EXCEPTION 'CANNOT_COMPLETE_CANCELLED';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    IF v_game.host_id <> p_caller_user_id 
       AND v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (
           SELECT 1 FROM commander_home_members 
            WHERE group_id = v_game.group_id 
              AND user_id = p_caller_user_id
              AND role = 'admin' AND status = 'approved')
    THEN
        RAISE EXCEPTION 'NOT_AUTHORIZED';
    END IF;

    -- Flip to completed
    UPDATE commander_home_games
       SET status = 'completed', updated_at = NOW()
     WHERE id = p_game_id;

    -- Bump group's games_hosted
    UPDATE commander_home_groups
       SET games_hosted = COALESCE(games_hosted, 0) + 1
     WHERE id = v_game.group_id;

    -- Mark flakes: yes RSVPs that weren't checked in
    UPDATE commander_home_rsvps
       SET flaked = true
     WHERE game_id = p_game_id 
       AND response = 'yes' 
       AND checked_in_at IS NULL;

    -- Increment games_attended for checked-in members
    UPDATE commander_home_members m
       SET games_attended = COALESCE(m.games_attended, 0) + 1,
           last_attended  = NOW()
      FROM commander_home_rsvps r
     WHERE r.game_id = p_game_id
       AND r.user_id = m.user_id
       AND m.group_id = v_game.group_id
       AND r.checked_in_at IS NOT NULL;

    SELECT COUNT(*) INTO v_attended FROM commander_home_rsvps
     WHERE game_id = p_game_id AND checked_in_at IS NOT NULL;

    -- Audit
    INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (v_game.group_id, p_caller_user_id, 'game', p_game_id, 'completed',
            jsonb_build_object('attended', v_attended));

    RETURN jsonb_build_object(
        'success', true,
        'game_id', p_game_id,
        'attended_count', v_attended,
        'flaked_count', (SELECT COUNT(*) FROM commander_home_rsvps 
                          WHERE game_id = p_game_id AND flaked = true)
    );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.complete_home_game(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.complete_home_game(uuid, uuid) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P1.3: edit_home_group
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.edit_home_group(
    p_group_id        uuid,
    p_caller_user_id  uuid,
    p_updates         jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
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

    -- Guard: validate all keys are in allowlist
    FOR v_key IN SELECT jsonb_object_keys(p_updates) LOOP
        IF NOT (v_key = ANY (v_allowed)) THEN
            v_bad_keys := array_append(v_bad_keys, v_key);
        END IF;
    END LOOP;
    IF array_length(v_bad_keys, 1) > 0 THEN
        RAISE EXCEPTION 'DISALLOWED_FIELDS: %', array_to_string(v_bad_keys, ',');
    END IF;

    -- Additional validation: if profile_photo_url is being set, cannot clear it
    IF p_updates ? 'profile_photo_url' 
       AND (p_updates->>'profile_photo_url' IS NULL OR trim(p_updates->>'profile_photo_url') = '') THEN
        RAISE EXCEPTION 'CANNOT_CLEAR_LOGO';
    END IF;

    -- Apply individual updates via dynamic SQL to keep it simple
    -- (UPDATE ... SET col = COALESCE(jsonb->>col, col) pattern)
    UPDATE commander_home_groups SET
        name               = COALESCE(p_updates->>'name', name),
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
$fn$;

REVOKE EXECUTE ON FUNCTION public.edit_home_group(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.edit_home_group(uuid, uuid, jsonb) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P1.4: edit_home_game
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.edit_home_game(
    p_game_id         uuid,
    p_caller_user_id  uuid,
    p_updates         jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_game    RECORD;
    v_group   RECORD;
    v_is_host boolean;
    v_allowed text[] := ARRAY[
        'title','description','game_type','stakes','format',
        'buyin_min','buyin_max','scheduled_date','start_time','end_time',
        'address','address_visible_to','location_notes','neighborhood',
        'max_players','min_players','allow_guests','guest_limit',
        'food_drinks','special_rules','cover_photo_url','status'
    ];
    v_key text;
    v_bad_keys text[] := ARRAY[]::text[];
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    IF v_game.status IN ('completed','cancelled') THEN
        RAISE EXCEPTION 'GAME_IS_FINAL';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    v_is_host := (v_game.host_id = p_caller_user_id)
              OR (v_group.owner_id = p_caller_user_id)
              OR EXISTS (SELECT 1 FROM commander_home_members 
                          WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                            AND role = 'admin' AND status = 'approved');
    IF NOT v_is_host THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;

    FOR v_key IN SELECT jsonb_object_keys(p_updates) LOOP
        IF NOT (v_key = ANY (v_allowed)) THEN
            v_bad_keys := array_append(v_bad_keys, v_key);
        END IF;
    END LOOP;
    IF array_length(v_bad_keys, 1) > 0 THEN
        RAISE EXCEPTION 'DISALLOWED_FIELDS: %', array_to_string(v_bad_keys, ',');
    END IF;

    -- Validate status transition
    IF p_updates ? 'status' AND NOT (p_updates->>'status' IN ('draft','scheduled','confirmed','in_progress')) THEN
        RAISE EXCEPTION 'INVALID_STATUS' 
              USING HINT = 'use cancel_home_game or complete_home_game for final states';
    END IF;

    UPDATE commander_home_games SET
        title              = CASE WHEN p_updates ? 'title' THEN p_updates->>'title' ELSE title END,
        description        = CASE WHEN p_updates ? 'description' THEN p_updates->>'description' ELSE description END,
        game_type          = CASE WHEN p_updates ? 'game_type' THEN p_updates->>'game_type' ELSE game_type END,
        stakes             = CASE WHEN p_updates ? 'stakes' THEN p_updates->>'stakes' ELSE stakes END,
        format             = CASE WHEN p_updates ? 'format' THEN p_updates->>'format' ELSE format END,
        buyin_min          = CASE WHEN p_updates ? 'buyin_min' THEN (p_updates->>'buyin_min')::int ELSE buyin_min END,
        buyin_max          = CASE WHEN p_updates ? 'buyin_max' THEN (p_updates->>'buyin_max')::int ELSE buyin_max END,
        scheduled_date     = CASE WHEN p_updates ? 'scheduled_date' THEN (p_updates->>'scheduled_date')::date ELSE scheduled_date END,
        start_time         = CASE WHEN p_updates ? 'start_time' THEN (p_updates->>'start_time')::time ELSE start_time END,
        end_time           = CASE WHEN p_updates ? 'end_time' THEN (p_updates->>'end_time')::time ELSE end_time END,
        address            = CASE WHEN p_updates ? 'address' THEN p_updates->>'address' ELSE address END,
        address_visible_to = CASE WHEN p_updates ? 'address_visible_to' THEN p_updates->>'address_visible_to' ELSE address_visible_to END,
        location_notes     = CASE WHEN p_updates ? 'location_notes' THEN p_updates->>'location_notes' ELSE location_notes END,
        neighborhood       = CASE WHEN p_updates ? 'neighborhood' THEN p_updates->>'neighborhood' ELSE neighborhood END,
        max_players        = CASE WHEN p_updates ? 'max_players' THEN (p_updates->>'max_players')::int ELSE max_players END,
        min_players        = CASE WHEN p_updates ? 'min_players' THEN (p_updates->>'min_players')::int ELSE min_players END,
        allow_guests       = CASE WHEN p_updates ? 'allow_guests' THEN (p_updates->>'allow_guests')::boolean ELSE allow_guests END,
        guest_limit        = CASE WHEN p_updates ? 'guest_limit' THEN (p_updates->>'guest_limit')::int ELSE guest_limit END,
        food_drinks        = CASE WHEN p_updates ? 'food_drinks' THEN p_updates->>'food_drinks' ELSE food_drinks END,
        special_rules      = CASE WHEN p_updates ? 'special_rules' THEN p_updates->>'special_rules' ELSE special_rules END,
        cover_photo_url    = CASE WHEN p_updates ? 'cover_photo_url' THEN p_updates->>'cover_photo_url' ELSE cover_photo_url END,
        status             = CASE WHEN p_updates ? 'status' THEN p_updates->>'status' ELSE status END,
        updated_at         = NOW()
     WHERE id = p_game_id;

    INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (v_game.group_id, p_caller_user_id, 'game', p_game_id, 'edited',
            jsonb_build_object('fields', (SELECT array_agg(k) FROM jsonb_object_keys(p_updates) k)));

    RETURN jsonb_build_object('success', true, 'game_id', p_game_id);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.edit_home_game(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.edit_home_game(uuid, uuid, jsonb) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P1.7: transfer_home_group_ownership
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.transfer_home_group_ownership(
    p_group_id            uuid,
    p_new_owner_user_id   uuid,
    p_caller_user_id      uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_group          RECORD;
    v_target_member  RECORD;
    v_old_owner      uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;

    -- Only current owner can transfer
    IF v_group.owner_id <> p_caller_user_id THEN
        RAISE EXCEPTION 'OWNER_ONLY_ACTION';
    END IF;
    IF v_group.owner_id = p_new_owner_user_id THEN
        RAISE EXCEPTION 'ALREADY_OWNER';
    END IF;

    -- New owner must be an approved admin of the group
    SELECT * INTO v_target_member 
      FROM commander_home_members 
     WHERE group_id = p_group_id AND user_id = p_new_owner_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'TARGET_NOT_MEMBER';
    END IF;
    IF v_target_member.status <> 'approved' THEN
        RAISE EXCEPTION 'TARGET_NOT_APPROVED';
    END IF;
    IF v_target_member.role <> 'admin' THEN
        RAISE EXCEPTION 'TARGET_NOT_ADMIN' 
              USING HINT = 'promote to admin first, then transfer';
    END IF;

    v_old_owner := v_group.owner_id;

    -- Atomic swap
    UPDATE commander_home_groups 
       SET owner_id = p_new_owner_user_id, updated_at = NOW()
     WHERE id = p_group_id;

    -- Old owner becomes admin
    UPDATE commander_home_members 
       SET role = 'admin'
     WHERE group_id = p_group_id AND user_id = v_old_owner;

    -- New owner's member row becomes role='owner'
    UPDATE commander_home_members 
       SET role = 'owner'
     WHERE group_id = p_group_id AND user_id = p_new_owner_user_id;

    INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (p_group_id, p_caller_user_id, 'group', p_group_id, 'ownership_transferred',
            jsonb_build_object('from_user', v_old_owner, 'to_user', p_new_owner_user_id));

    RETURN jsonb_build_object(
        'success', true,
        'group_id', p_group_id,
        'previous_owner', v_old_owner,
        'new_owner', p_new_owner_user_id
    );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.transfer_home_group_ownership(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.transfer_home_group_ownership(uuid, uuid, uuid) TO authenticated, service_role;
