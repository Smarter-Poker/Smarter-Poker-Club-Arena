-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260510161912 "commander_access_rpc_fix_consistency"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fa9e8110732c43cc082304cd5bc6d03e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: align has_commander_access with get_commander_access_details.
-- Both must require venue_id IS NOT NULL on the staff check, since null-venue
-- staff rows are test seed data ('Staff_owner_1', email='staff1@venue.com', etc.)
-- with no real venue context to grant access to.
--
-- Without this filter, has_commander_access leaked access to non-managerial
-- staff members of JAQK (e.g., a 'floor' role) because they happened to ALSO
-- have a null-venue test-seed 'owner' row attached to their auth user_id.

CREATE OR REPLACE FUNCTION public.has_commander_access(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM clubs WHERE owner_id = p_user_id) OR
    EXISTS (SELECT 1 FROM commander_subscriptions WHERE owner_id = p_user_id) OR
    EXISTS (
      SELECT 1 FROM commander_staff
      WHERE (user_id = p_user_id OR linked_user_id = p_user_id)
        AND role IN ('owner','manager')
        AND venue_id IS NOT NULL  -- exclude null-venue test seed rows
    ) OR
    EXISTS (SELECT 1 FROM commander_home_groups WHERE owner_id = p_user_id);
$$;
