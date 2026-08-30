-- Revert is_club_admin(uuid) from STABLE back to VOLATILE.
-- 
-- The migration 20260825450000_is_club_admin_is_stable_not_volatile.sql changed this
-- function to STABLE in the hopes that the planner would optimize it. However, because
-- it is a SECURITY DEFINER function that queries club_members, and it is used inside
-- the RLS policies for club_members, marking it STABLE causes a catastrophic query
-- planner issue in PostgREST (likely an infinite expansion or a terrible Seq Scan
-- that hangs the database connection, resulting in Cloudflare 520 errors and PGRST timeouts).
--
-- This resulted in users being completely unable to load their clubs or log into
-- any clubs because any query joining club_members to clubs would hang indefinitely.
-- Reverting it to VOLATILE forces Postgres to treat it as a black box and evaluates
-- it safely row-by-row after cheaper RLS predicates, instantly restoring performance.

ALTER FUNCTION public.is_club_admin(uuid) VOLATILE;

DO $$
BEGIN
  IF (SELECT provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'is_club_admin'
         AND pg_get_function_identity_arguments(p.oid) = 'p_club_id uuid') <> 'v' THEN
    RAISE EXCEPTION 'is_club_admin(uuid) is not VOLATILE.';
  END IF;
END $$;
