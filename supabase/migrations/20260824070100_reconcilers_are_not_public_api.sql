-- ============================================================================
-- RECONCILERS ARE NOT A PUBLIC API (2026-08-24)
-- TIER: 2 | AFFECTS: EXECUTE privileges only, no function bodies change
--
-- REVOKE ... FROM PUBLIC does not remove a grant made to a NAMED role, and
-- Supabase's default privileges grant EXECUTE on every new function in the
-- `public` schema to `anon` and `authenticated`. So the revoke written into
-- 20260824070000 read as done and changed nothing:
--
--   fn_sweep_seatless_late_registrants   anon=X, authenticated=X
--   fn_tournament_primary_table          anon=X, authenticated=X
--   fn_reconcile_tournament_denormals    authenticated=X   (pre-existing)
--
-- All three are SECURITY DEFINER, and the sweep and the reconciler mutate
-- rows across every live tournament. An anonymous caller could drive a
-- fleet-wide sweep at any rate it liked. They are cron and engine plumbing:
-- nothing in the client calls them, verified by grep over src/ for each name
-- (the only hits are two comments describing the sweep).
--
-- fn_tournament_primary_table stays readable by `authenticated` because it is
-- STABLE, returns a single table id, and the lobby may legitimately ask which
-- table a game is on. `anon` has no reason to.
--
-- ROLLBACK:
--   GRANT EXECUTE ON FUNCTION public.fn_sweep_seatless_late_registrants() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.fn_reconcile_tournament_denormals()  TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.fn_tournament_primary_table(uuid)    TO anon;
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.fn_sweep_seatless_late_registrants() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_reconcile_tournament_denormals()  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_tournament_primary_table(uuid)    FROM anon;

-- The engine (service_role) and cron (postgres) keep what they need.
GRANT EXECUTE ON FUNCTION public.fn_sweep_seatless_late_registrants() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_reconcile_tournament_denormals()  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_primary_table(uuid)    TO service_role, authenticated;

DO $assert$
DECLARE v_acl text;
BEGIN
  SELECT array_to_string(proacl, ' | ') INTO v_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_sweep_seatless_late_registrants';
  IF v_acl LIKE '%anon=X%' OR v_acl LIKE '%authenticated=X%' THEN
    RAISE EXCEPTION 'the sweep is still callable by an untrusted role: %', v_acl;
  END IF;

  SELECT array_to_string(proacl, ' | ') INTO v_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_reconcile_tournament_denormals';
  IF v_acl LIKE '%anon=X%' OR v_acl LIKE '%authenticated=X%' THEN
    RAISE EXCEPTION 'the reconciler is still callable by an untrusted role: %', v_acl;
  END IF;

  SELECT array_to_string(proacl, ' | ') INTO v_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_tournament_primary_table';
  IF v_acl NOT LIKE '%service_role=X%' THEN
    RAISE EXCEPTION 'the engine cannot execute fn_tournament_primary_table: %', v_acl;
  END IF;
END
$assert$;
