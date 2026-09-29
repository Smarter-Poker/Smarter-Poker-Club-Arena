-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419153146 "phase23_manage_home_group_member_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fa31ddc041445d01d0a1fa35bee2d194 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 23 — manage_home_group_member RPC
--  -----------------------------------------------------------------------
--  Single consolidated RPC for all host→member state transitions. Actions:
--    approve         — pending → approved (sets joined_at)
--    decline         — pending → declined
--    ban             — any    → banned
--    unban           — banned → approved
--    promote_admin   — approved member → admin
--    demote_member   — admin → member
--    remove          — hard delete of membership row (full exit)
--
--  Authorization rules:
--    - owner can do everything to everyone except: ban/remove/demote owner
--    - admin can: approve, decline, ban non-admin, unban, remove non-admin
--    - admin CANNOT: promote, demote, modify other admins, modify owner
--
--  Owner safety: the owner row in commander_home_members (role='owner')
--  is protected — cannot be banned, demoted, or removed. Owner transfer
--  is a separate operation (not covered here).
-- =========================================================================

CREATE OR REPLACE FUNCTION public.manage_home_group_member(
    p_group_id         uuid,
    p_member_user_id   uuid,
    p_action           text,
    p_caller_user_id   uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_group          RECORD;
    v_target         RECORD;
    v_caller_role    text;
    v_valid_actions  text[] := ARRAY['approve','decline','ban','unban','promote_admin','demote_member','remove'];
    v_result         jsonb;
BEGIN
    -- Auth guard
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

    -- Load group
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;

    -- Determine caller role
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

    -- Load target (OR synthesize 'nothing' if not exists, for idempotency on decline/remove)
    SELECT m.*, 
           (v_group.owner_id = m.user_id) AS is_owner_row
      INTO v_target
      FROM commander_home_members m
     WHERE m.group_id = p_group_id
       AND m.user_id = p_member_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'MEMBER_NOT_FOUND';
    END IF;

    -- Protect owner row from all destructive actions
    IF v_target.is_owner_row AND p_action IN ('ban','demote_member','remove','decline') THEN
        RAISE EXCEPTION 'CANNOT_MODIFY_OWNER';
    END IF;

    -- Admins cannot modify other admins or owners (only owner can)
    IF v_caller_role = 'admin' THEN
        IF v_target.role IN ('admin','owner') AND p_action IN ('ban','demote_member','remove','decline') THEN
            RAISE EXCEPTION 'ADMIN_CANNOT_MODIFY_PEER';
        END IF;
        IF p_action IN ('promote_admin','demote_member') THEN
            RAISE EXCEPTION 'OWNER_ONLY_ACTION'
                  USING HINT = 'promote_admin and demote_member require owner';
        END IF;
    END IF;

    -- Execute action
    CASE p_action
      WHEN 'approve' THEN
        IF v_target.status <> 'pending' THEN
            RAISE EXCEPTION 'TARGET_NOT_PENDING'
                  USING HINT = 'current status is ' || v_target.status;
        END IF;
        UPDATE commander_home_members
           SET status = 'approved',
               joined_at = COALESCE(joined_at, NOW())
         WHERE id = v_target.id;

      WHEN 'decline' THEN
        IF v_target.status <> 'pending' THEN
            RAISE EXCEPTION 'TARGET_NOT_PENDING';
        END IF;
        UPDATE commander_home_members
           SET status = 'declined'
         WHERE id = v_target.id;

      WHEN 'ban' THEN
        UPDATE commander_home_members
           SET status = 'banned',
               role   = 'member'  -- demote on ban for safety
         WHERE id = v_target.id;

      WHEN 'unban' THEN
        IF v_target.status <> 'banned' THEN
            RAISE EXCEPTION 'TARGET_NOT_BANNED';
        END IF;
        UPDATE commander_home_members
           SET status = 'approved'
         WHERE id = v_target.id;

      WHEN 'promote_admin' THEN
        IF v_target.status <> 'approved' THEN
            RAISE EXCEPTION 'TARGET_NOT_APPROVED';
        END IF;
        IF v_target.role = 'admin' THEN
            RAISE EXCEPTION 'ALREADY_ADMIN';
        END IF;
        UPDATE commander_home_members
           SET role = 'admin'
         WHERE id = v_target.id;

      WHEN 'demote_member' THEN
        IF v_target.role <> 'admin' THEN
            RAISE EXCEPTION 'TARGET_NOT_ADMIN';
        END IF;
        UPDATE commander_home_members
           SET role = 'member'
         WHERE id = v_target.id;

      WHEN 'remove' THEN
        DELETE FROM commander_home_members
         WHERE id = v_target.id;
    END CASE;

    -- Return the updated state (or null if removed)
    SELECT jsonb_build_object(
        'success', true,
        'action', p_action,
        'member_user_id', p_member_user_id,
        'new_state', CASE WHEN p_action = 'remove' THEN 
            jsonb_build_object('removed', true)
        ELSE (
            SELECT jsonb_build_object('status', status, 'role', role, 'joined_at', joined_at)
              FROM commander_home_members
             WHERE id = v_target.id
        ) END
    ) INTO v_result;

    RETURN v_result;
END;
$fn$;

-- ACL: authenticated + service_role (hosts call via session)
REVOKE EXECUTE ON FUNCTION public.manage_home_group_member(uuid, uuid, text, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.manage_home_group_member(uuid, uuid, text, uuid) 
    TO authenticated, service_role;

COMMENT ON FUNCTION public.manage_home_group_member(uuid, uuid, text, uuid) IS
  'Phase 23: Consolidated host action for approve/decline/ban/unban/promote_admin/demote_member/remove on a group member. Enforces role hierarchy (owner > admin > member), owner row protection, and auth.uid() guard.';
