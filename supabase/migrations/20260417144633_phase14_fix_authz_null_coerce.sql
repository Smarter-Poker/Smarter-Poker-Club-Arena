-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417144633 "phase14_fix_authz_null_coerce"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 19657dcc3634b294d44fe2bb46f90d3a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Harden the staff check: explicit false return when not a member.
-- Using IF EXISTS so NULL is never returned.
CREATE OR REPLACE FUNCTION fn_home_caller_is_game_staff(p_caller uuid, p_game_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_group_id uuid;
BEGIN
    IF p_caller IS NULL OR p_game_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT g.group_id INTO v_group_id
      FROM commander_home_games g WHERE g.id = p_game_id;
    IF v_group_id IS NULL THEN RETURN false; END IF;

    -- Owner short-circuit
    IF EXISTS (SELECT 1 FROM commander_home_groups
               WHERE id = v_group_id AND owner_id = p_caller) THEN
        RETURN true;
    END IF;

    -- Approved admin/owner in members table
    IF EXISTS (SELECT 1 FROM commander_home_members
               WHERE group_id = v_group_id
                 AND user_id = p_caller
                 AND status = 'approved'
                 AND role IN ('owner','admin')) THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_home_caller_is_game_staff(uuid, uuid) TO authenticated, service_role;
