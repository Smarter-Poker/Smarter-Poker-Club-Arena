-- 20260908024019_the_engine_dashboard_asks_an_admin_rpc_for_the_fleet
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-08 UTC.
--
-- ═══════════════════════════════════════════════════════════════════════════════
--  THE ENGINE DASHBOARD ASKS AN ADMIN RPC FOR THE FLEET
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- `src/pages/admin/EngineDashboard.tsx` counted the horse fleet with two
-- browser queries on `profiles` filtered by `is_horse = true` and
-- `horse_status`. Since 2026-09-02 neither column is granted to
-- `authenticated` (docs/laws.d/horse-identity-is-not-readable.md), and
-- PostgREST refuses a FILTER on an ungranted column with 42501 - so the
-- admin-only "Hydra" panel has shown nothing to the admins it was built for,
-- and the same request shape from any other tab would be refused too. Both
-- halves are right: a player must not be able to ask, and an admin must
-- still be answered.
--
-- This is the answer for the admin: one SECURITY DEFINER function that counts
-- as the owner and refuses everyone `fn_is_horse_admin()` does not vouch for
-- (admin / superadmin / god). It returns counts only - no ids, no names - so
-- even the admin surface learns the SIZE of the fleet here, never a roster.
--
-- Probed as a plain player (raises 42501 'admin only') and as the god
-- account (returns {"available": n, "seated": m}) in a rolled-back block.
--
-- One function, one transaction: one PostgREST schema reload (~28s).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_admin_horse_fleet_counts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_available int := 0;
  v_seated int := 0;
BEGIN
  IF NOT public.fn_is_horse_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) FILTER (WHERE horse_status = 'available'),
         count(*) FILTER (WHERE horse_status = 'seated')
    INTO v_available, v_seated
    FROM public.profiles
   WHERE is_horse = true;

  RETURN jsonb_build_object('available', v_available, 'seated', v_seated);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_admin_horse_fleet_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_admin_horse_fleet_counts() TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_admin_horse_fleet_counts() IS
  'Fleet size for the admin Engine Dashboard: counts only, admins only (fn_is_horse_admin). Players get 42501. 2026-09-08.';

COMMIT;
