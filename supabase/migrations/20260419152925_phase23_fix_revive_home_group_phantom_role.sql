-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419152925 "phase23_fix_revive_home_group_phantom_role"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 baa6676055922f8ca4474654afc3a73b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 23 — Remove phantom 'co_host' role from revive_home_group
--  -----------------------------------------------------------------------
--  The CHECK constraint on commander_home_members.role permits only
--  owner/admin/member. The revive_home_group function authorized 'admin'
--  OR 'co_host' — but co_host can never exist (CHECK would reject). Dead
--  branch with no functional impact but worth removing for correctness.
--
--  Zero-behavior change — no row has role='co_host' so the OR branch
--  was always false.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.revive_home_group(p_group_id uuid, p_caller_user_id uuid)
RETURNS timestamp with time zone
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    g_owner_id uuid;
    g_is_active boolean;
    new_ts timestamptz;
BEGIN
    IF p_group_id IS NULL OR p_caller_user_id IS NULL THEN
        RAISE EXCEPTION 'revive_home_group: both p_group_id and p_caller_user_id are required'
          USING ERRCODE = '22004';
    END IF;

    SELECT owner_id, is_active
      INTO g_owner_id, g_is_active
      FROM commander_home_groups
     WHERE id = p_group_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'revive_home_group: home group % not found', p_group_id
          USING ERRCODE = 'P0002';
    END IF;

    IF NOT g_is_active THEN
        RAISE EXCEPTION 'revive_home_group: group is deactivated and cannot be revived by host'
          USING ERRCODE = '22023';
    END IF;

    -- Authorization: caller must be the group owner OR an approved admin
    IF p_caller_user_id <> g_owner_id
       AND NOT EXISTS (
           SELECT 1 FROM commander_home_members m
            WHERE m.group_id = p_group_id
              AND m.user_id  = p_caller_user_id
              AND m.status   = 'approved'
              AND m.role     = 'admin'
       )
    THEN
        RAISE EXCEPTION 'revive_home_group: caller is not authorized for this group'
          USING ERRCODE = '42501';
    END IF;

    UPDATE commander_home_groups
       SET last_activity_at = NOW(),
           updated_at       = NOW()
     WHERE id = p_group_id
     RETURNING last_activity_at INTO new_ts;

    RETURN new_ts;
END;
$function$;
