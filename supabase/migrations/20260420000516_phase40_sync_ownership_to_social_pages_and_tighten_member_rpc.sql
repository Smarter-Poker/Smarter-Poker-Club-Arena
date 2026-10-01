-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420000516 "phase40_sync_ownership_to_social_pages_and_tighten_member_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1b7b6812908022b15cdc8187bc283e49 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 continuation:
-- (1) sync_home_group_to_social_page now propagates owner_id so ownership
--     transfer keeps the public-facing social_page in step.
-- (2) manage_home_group_member tightens the owner-protection allowlist to
--     include 'promote_admin' — the DB trigger catches it anyway but users
--     should see 'CANNOT_MODIFY_OWNER' not a raw 42501.
-- ============================================================================

-- (1) Sync trigger — propagate owner_id
CREATE OR REPLACE FUNCTION public.sync_home_group_to_social_page()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  UPDATE public.social_pages sp
  SET owner_id      = NEW.owner_id,   -- Phase 40: keep owner in step
      name          = NEW.name,
      description   = coalesce(NEW.description, NEW.tagline, sp.description),
      avatar_url    = coalesce(NEW.profile_photo_url, sp.avatar_url),
      cover_url     = coalesce(NEW.cover_photo_url, sp.cover_url),
      location_city = NEW.city,
      location_state= NEW.state,
      is_public     = (coalesce(NEW.is_active, true) AND NOT coalesce(NEW.is_private, false)),
      metadata      = coalesce(sp.metadata, '{}'::jsonb) || jsonb_build_object(
        'home_group_id', NEW.id,
        'invite_code', NEW.invite_code,
        'club_code', NEW.club_code,
        'default_game_type', NEW.default_game_type,
        'default_stakes', NEW.default_stakes,
        'frequency', NEW.frequency
      ),
      updated_at    = now()
  WHERE sp.linked_entity_type = 'home_group'
    AND sp.linked_entity_id = NEW.id::text;

  IF NOT FOUND THEN
    INSERT INTO public.social_pages (
      owner_id, page_type, name, slug, description,
      avatar_url, cover_url, category,
      location_city, location_state, location_country,
      linked_entity_type, linked_entity_id,
      is_public, allow_member_posts, require_post_approval, metadata
    ) VALUES (
      NEW.owner_id, 'home_game', NEW.name,
      public.unique_home_game_slug(NEW.name),
      coalesce(NEW.description, NEW.tagline, ''),
      NEW.profile_photo_url, NEW.cover_photo_url, 'home game',
      NEW.city, NEW.state, 'US',
      'home_group', NEW.id::text,
      (coalesce(NEW.is_active, true) AND NOT coalesce(NEW.is_private, false)),
      true, false,
      jsonb_build_object(
        'home_group_id', NEW.id,
        'invite_code', NEW.invite_code,
        'club_code', NEW.club_code,
        'default_game_type', NEW.default_game_type,
        'default_stakes', NEW.default_stakes,
        'frequency', NEW.frequency
      )
    );
  END IF;
  RETURN NEW;
END;
$function$;

-- (2) manage_home_group_member: include promote_admin in owner-protection allowlist
CREATE OR REPLACE FUNCTION public.manage_home_group_member(
    p_group_id uuid, p_member_user_id uuid, p_action text, p_caller_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_group          RECORD;
    v_target         RECORD;
    v_caller_role    text;
    v_valid_actions  text[] := ARRAY['approve','decline','ban','unban','promote_admin','demote_member','remove'];
    v_result         jsonb;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED'
              USING HINT = 'manage_home_group_member requires auth.uid() = p_caller_user_id';
    END IF;

    IF p_action IS NULL OR NOT (p_action = ANY (v_valid_actions)) THEN
        RAISE EXCEPTION 'INVALID_ACTION'
              USING HINT = 'action must be one of: approve, decline, ban, unban, promote_admin, demote_member, remove';
    END IF;

    IF p_group_id IS NULL OR p_member_user_id IS NULL THEN
        RAISE EXCEPTION 'MISSING_PARAMS';
    END IF;

    IF p_caller_user_id = p_member_user_id THEN
        RAISE EXCEPTION 'CANNOT_SELF_MANAGE'
              USING HINT = 'use a separate leave-group RPC for self-exit';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;

    IF v_group.owner_id = p_caller_user_id THEN
        v_caller_role := 'owner';
    ELSE
        SELECT role INTO v_caller_role
          FROM commander_home_members
         WHERE group_id = p_group_id
           AND user_id = p_caller_user_id
           AND status = 'approved'
           AND role IN ('admin','owner');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'NOT_A_HOST';
        END IF;
    END IF;

    SELECT m.*, (v_group.owner_id = m.user_id) AS is_owner_row
      INTO v_target
      FROM commander_home_members m
     WHERE m.group_id = p_group_id AND m.user_id = p_member_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'MEMBER_NOT_FOUND';
    END IF;

    -- Phase 40: extended owner-protection allowlist. DB trigger
    -- trg_protect_home_group_owner_membership_upd also blocks this
    -- at the SQL layer; this guard gives users a clean error instead
    -- of a raw 42501. promote_admin added — promoting the owner to admin
    -- is effectively a demotion.
    IF v_target.is_owner_row AND p_action IN (
        'ban','demote_member','remove','decline','promote_admin'
    ) THEN
        RAISE EXCEPTION 'CANNOT_MODIFY_OWNER'
              USING HINT = 'Use transfer_home_group_ownership to change the owner.';
    END IF;

    IF v_caller_role = 'admin' THEN
        IF v_target.role IN ('admin','owner') AND p_action IN (
            'ban','demote_member','remove','decline'
        ) THEN
            RAISE EXCEPTION 'ADMIN_CANNOT_MODIFY_PEER';
        END IF;
        IF p_action IN ('promote_admin','demote_member') THEN
            RAISE EXCEPTION 'OWNER_ONLY_ACTION'
                  USING HINT = 'promote_admin and demote_member require owner';
        END IF;
    END IF;

    CASE p_action
      WHEN 'approve' THEN
        IF v_target.status <> 'pending' THEN
            RAISE EXCEPTION 'TARGET_NOT_PENDING' USING HINT = 'current status is ' || v_target.status;
        END IF;
        UPDATE commander_home_members
           SET status = 'approved', joined_at = COALESCE(joined_at, NOW())
         WHERE id = v_target.id;
      WHEN 'decline' THEN
        IF v_target.status <> 'pending' THEN RAISE EXCEPTION 'TARGET_NOT_PENDING'; END IF;
        UPDATE commander_home_members SET status='declined' WHERE id = v_target.id;
      WHEN 'ban' THEN
        UPDATE commander_home_members SET status='banned', role='member' WHERE id = v_target.id;
      WHEN 'unban' THEN
        IF v_target.status <> 'banned' THEN RAISE EXCEPTION 'TARGET_NOT_BANNED'; END IF;
        UPDATE commander_home_members SET status='approved' WHERE id = v_target.id;
      WHEN 'promote_admin' THEN
        IF v_target.status <> 'approved' THEN RAISE EXCEPTION 'TARGET_NOT_APPROVED'; END IF;
        IF v_target.role = 'admin' THEN RAISE EXCEPTION 'ALREADY_ADMIN'; END IF;
        UPDATE commander_home_members SET role='admin' WHERE id = v_target.id;
      WHEN 'demote_member' THEN
        IF v_target.role <> 'admin' THEN RAISE EXCEPTION 'TARGET_NOT_ADMIN'; END IF;
        UPDATE commander_home_members SET role='member' WHERE id = v_target.id;
      WHEN 'remove' THEN
        DELETE FROM commander_home_members WHERE id = v_target.id;
    END CASE;

    SELECT jsonb_build_object(
        'success', true,
        'action', p_action,
        'member_user_id', p_member_user_id,
        'new_state', CASE WHEN p_action = 'remove' THEN
            jsonb_build_object('removed', true)
        ELSE (
            SELECT jsonb_build_object('status', status, 'role', role, 'joined_at', joined_at)
              FROM commander_home_members WHERE id = v_target.id
        ) END
    ) INTO v_result;

    RETURN v_result;
END;
$function$;
