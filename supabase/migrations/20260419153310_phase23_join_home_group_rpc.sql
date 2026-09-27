-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419153310 "phase23_join_home_group_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 069b7bfd10f8d4e36b172ec00a2e46be of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 23 — join_home_group RPC
--  -----------------------------------------------------------------------
--  User-facing action to request membership in a home group.
--
--  Rules:
--    - Auth: p_caller_user_id must match auth.uid()
--    - Private groups REQUIRE a valid invite_code or club_code
--    - Public groups + requires_approval=true  → status = 'pending'
--    - Public groups + requires_approval=false → status = 'approved'
--    - Idempotent: if caller already has a row, returns current status
--    - Banned users cannot rejoin (RAISE BANNED)
--    - Declined users can re-request (flip to pending)
-- =========================================================================

CREATE OR REPLACE FUNCTION public.join_home_group(
    p_group_id         uuid,
    p_caller_user_id   uuid,
    p_invite_code      text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_group       RECORD;
    v_existing    RECORD;
    v_new_status  text;
    v_new_id      uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF NOT v_group.is_active THEN RAISE EXCEPTION 'GROUP_INACTIVE'; END IF;

    -- Owner cannot join their own group (already owner)
    IF v_group.owner_id = p_caller_user_id THEN
        RAISE EXCEPTION 'ALREADY_OWNER';
    END IF;

    -- For private groups, require a valid invite or club code
    IF v_group.is_private THEN
        IF p_invite_code IS NULL THEN
            RAISE EXCEPTION 'INVITE_CODE_REQUIRED';
        END IF;
        IF p_invite_code <> v_group.invite_code 
           AND p_invite_code <> v_group.club_code THEN
            RAISE EXCEPTION 'INVALID_INVITE_CODE';
        END IF;
    END IF;

    -- Check existing membership
    SELECT * INTO v_existing
      FROM commander_home_members
     WHERE group_id = p_group_id
       AND user_id = p_caller_user_id;

    IF FOUND THEN
        CASE v_existing.status
          WHEN 'approved' THEN
            RETURN jsonb_build_object(
                'success', true, 'already_member', true,
                'status', 'approved', 'role', v_existing.role,
                'member_id', v_existing.id
            );
          WHEN 'pending' THEN
            RETURN jsonb_build_object(
                'success', true, 'already_pending', true,
                'status', 'pending', 'member_id', v_existing.id
            );
          WHEN 'banned' THEN
            RAISE EXCEPTION 'BANNED' 
                  USING HINT = 'user is banned from this group';
          WHEN 'declined' THEN
            -- Allow re-request: flip declined back to pending
            -- (or auto-approve if group doesn't require approval)
            v_new_status := CASE
              WHEN v_group.is_private THEN 'pending'
              WHEN COALESCE(v_group.requires_approval, true) THEN 'pending'
              ELSE 'approved'
            END;
            UPDATE commander_home_members
               SET status = v_new_status,
                   joined_at = CASE WHEN v_new_status='approved' THEN NOW() ELSE joined_at END
             WHERE id = v_existing.id;
            RETURN jsonb_build_object(
                'success', true, 're_requested', true,
                'status', v_new_status, 'member_id', v_existing.id
            );
        END CASE;
    END IF;

    -- Fresh insert
    -- Private groups with valid invite code: go straight to approved (invite implies approval)
    -- Public + requires_approval: pending
    -- Public + !requires_approval: approved
    v_new_status := CASE
      WHEN v_group.is_private THEN 'approved'   -- valid invite_code means pre-approved
      WHEN COALESCE(v_group.requires_approval, true) THEN 'pending'
      ELSE 'approved'
    END;

    INSERT INTO commander_home_members 
        (group_id, user_id, role, status, joined_at, created_at)
    VALUES 
        (p_group_id, p_caller_user_id, 'member', v_new_status,
         CASE WHEN v_new_status='approved' THEN NOW() ELSE NULL END,
         NOW())
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object(
        'success', true,
        'status', v_new_status,
        'role', 'member',
        'member_id', v_new_id,
        'requires_approval', (v_new_status = 'pending')
    );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.join_home_group(uuid, uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.join_home_group(uuid, uuid, text) 
    TO authenticated, service_role;

COMMENT ON FUNCTION public.join_home_group(uuid, uuid, text) IS
  'Phase 23: User-facing RPC to join/request membership in a home group. Private groups require valid invite/club code (auto-approved). Public groups: pending if requires_approval=true, approved otherwise. Idempotent; re-requests from declined allowed; banned raises.';
