-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503090731 "phase42_lockdown_signup_health_view_to_service_role"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ee91e12e88f0d4298ebc63d921d19f68 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- Phase 42 — lock down signup_health_view to service_role only.
--
-- Decision: this view aggregates auth.users (counts + max(created_at) +
-- probe metrics — no per-user PII). All 3 legitimate consumers
-- (pages/admin/signup-health.js, pages/api/health/signup.js, the cron
-- handlers) use SUPABASE_SERVICE_ROLE_KEY. Anon SELECT was never needed.
-- Locking removes the auth_users_exposed advisor warning + closes a
-- tiny information-disclosure surface (signup velocity timing).
--
-- If the parallel session needs anon access for an external uptime
-- monitor, they can re-grant explicitly: GRANT SELECT ON signup_health_view TO anon;
-- ═══════════════════════════════════════════════════════════════════════
REVOKE ALL ON public.signup_health_view FROM anon, authenticated;
GRANT SELECT ON public.signup_health_view TO service_role;

DO $$
DECLARE v_anon integer; v_auth integer; v_svc integer;
BEGIN
    SELECT COUNT(*) INTO v_anon FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='signup_health_view' AND grantee='anon';
    SELECT COUNT(*) INTO v_auth FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='signup_health_view' AND grantee='authenticated';
    SELECT COUNT(*) INTO v_svc FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='signup_health_view' AND grantee='service_role' AND privilege_type='SELECT';

    IF v_anon > 0 OR v_auth > 0 THEN
        RAISE EXCEPTION 'Post-apply: anon=% auth=% grants still exist', v_anon, v_auth;
    END IF;
    IF v_svc <> 1 THEN
        RAISE EXCEPTION 'Post-apply: service_role missing SELECT grant';
    END IF;
    RAISE NOTICE 'Post-apply: signup_health_view restricted to service_role only';
END $$;
