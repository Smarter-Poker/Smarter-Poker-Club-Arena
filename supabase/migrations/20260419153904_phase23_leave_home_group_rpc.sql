-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419153904 "phase23_leave_home_group_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 09eaacbc6a02921650dc60db13860c5e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 23 — leave_home_group RPC
--  -----------------------------------------------------------------------
--  Self-exit from a home group. Complements manage_home_group_member
--  which blocks self-management.
--
--  Rules:
--    - Caller must match auth.uid()
--    - Owner CANNOT leave their own group (must transfer ownership first)
--    - Hard-deletes the commander_home_members row (consistent with
--      manage_home_group_member 'remove' action)
--    - Idempotent: if no membership exists, returns success=true with
--      already_gone=true
-- =========================================================================

CREATE OR REPLACE FUNCTION public.leave_home_group(
    p_group_id        uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_group       RECORD;
    v_existed     boolean := false;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;

    -- Owner cannot leave — must transfer ownership first
    IF v_group.owner_id = p_caller_user_id THEN
        RAISE EXCEPTION 'OWNER_CANNOT_LEAVE' 
              USING HINT = 'transfer ownership first, then leave';
    END IF;

    -- Delete membership row
    DELETE FROM commander_home_members
     WHERE group_id = p_group_id 
       AND user_id = p_caller_user_id
    RETURNING true INTO v_existed;

    RETURN jsonb_build_object(
        'success', true,
        'group_id', p_group_id,
        'already_gone', COALESCE(NOT v_existed, true)
    );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.leave_home_group(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.leave_home_group(uuid, uuid) 
    TO authenticated, service_role;

COMMENT ON FUNCTION public.leave_home_group(uuid, uuid) IS
  'Phase 23: Self-exit from a home group. Owner cannot leave (must transfer first). Idempotent. Hard-deletes membership row.';
