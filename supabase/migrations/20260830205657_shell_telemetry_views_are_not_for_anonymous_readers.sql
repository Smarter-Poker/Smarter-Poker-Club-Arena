-- =====================================================================
-- OPERATOR TELEMETRY IS NOT PUBLIC
-- =====================================================================
-- Applied to production 2026-08-30 20:56 UTC via Supabase apply_migration.
--
-- `v_shell_staleness_rate` and `v_shell_reload_lateness` are SECURITY DEFINER
-- views granted SELECT to `anon`. Supabase's security advisor flags both as
-- ERROR (security_definer_view) - they run as owner and bypass RLS for whoever
-- can reach them, and `anon` is unauthenticated. They are 2 of only 3 ERROR
-- level lints on the project (the third is `spatial_ref_sys`, a PostGIS-owned
-- table that cannot take RLS and is flagged on every PostGIS project).
--
-- WHAT THEY ACTUALLY EXPOSE is only aggregate operator telemetry:
--   v_shell_staleness_rate   (day, source, checks, stale_checks, stale_pct)
--   v_shell_reload_lateness  (day, reloads, within_startup_window, after_paint,
--                             worst_page_age_ms)
-- No user, club, hand or balance data. This is a posture fix, not a leak.
--
-- SAFE BECAUSE NOTHING ANONYMOUS READS THEM. They appear in the codebase only
-- in a comment in `src/services/ShellTelemetryService.ts` describing them as
-- operator dashboards; no client code selects from either view. Operators are
-- authenticated, and `authenticated` keeps its grant.
--
-- SECURITY DEFINER IS DELIBERATELY LEFT IN PLACE. Flipping these to
-- security_invoker would make them respect the caller's RLS on the underlying
-- telemetry tables, which would silently empty an operator dashboard instead of
-- fixing anything. Removing the anonymous grant addresses the exposure directly.
--
-- ROLLBACK:
--   GRANT SELECT ON public.v_shell_staleness_rate  TO anon;
--   GRANT SELECT ON public.v_shell_reload_lateness TO anon;
-- =====================================================================

REVOKE ALL ON public.v_shell_staleness_rate  FROM anon;
REVOKE ALL ON public.v_shell_reload_lateness FROM anon;

DO $$
DECLARE v_anon int; v_auth int;
BEGIN
    SELECT count(*) INTO v_anon FROM information_schema.role_table_grants
     WHERE table_name IN ('v_shell_staleness_rate','v_shell_reload_lateness') AND grantee = 'anon';
    SELECT count(*) INTO v_auth FROM information_schema.role_table_grants
     WHERE table_name IN ('v_shell_staleness_rate','v_shell_reload_lateness')
       AND grantee = 'authenticated' AND privilege_type = 'SELECT';

    IF v_anon <> 0 THEN
        RAISE EXCEPTION 'Post-apply: anon still holds % grant(s).', v_anon;
    END IF;
    IF v_auth <> 2 THEN
        RAISE EXCEPTION 'Post-apply: authenticated should retain SELECT on both views, found %.', v_auth;
    END IF;
    RAISE NOTICE 'anon revoked on both telemetry views; authenticated SELECT intact.';
END $$;
