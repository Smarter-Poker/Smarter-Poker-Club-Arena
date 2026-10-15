-- 20261015004335_browser_definer_helpers_are_service_role_only.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- ============================================================================
-- BROWSER-REACHABLE DEFINER HELPERS ARE SERVICE ROLE ONLY
-- ============================================================================
--
-- Telemetry Exposure (scripts/ci/check-telemetry-exposure.mjs) has failed on
-- main since 2026-10-11: four SECURITY DEFINER routines take no identity
-- argument, never look at the caller, and `authenticated` can execute them.
--
-- Read from production (kuklfnapbkmacvwxktbh) on 2026-10-15 before writing:
--   * No RLS policy expression references any of the four.
--   * No view or rule depends on any of them.
--   * Every routine that calls the three launch-accounting helpers is itself
--     SECURITY DEFINER (runs as owner), except fn_rakeback_split_counts, which
--     `authenticated` cannot execute. Revoking the browser grant therefore
--     changes no browser-reachable behaviour.
--   * fn_redeem_vip_points is the retired stub that only returns
--     {success:false, error:'vip_points_retired'}; no client code calls it.
--
-- Bodies, owners, SECURITY DEFINER, search_path and the service_role grant
-- are unchanged. Only the PUBLIC/anon/authenticated EXECUTE grant is removed.

-- @live-proof: (SELECT count(*)=4 AND count(*) FILTER (WHERE has_function_privilege('authenticated',p.oid,'EXECUTE') OR has_function_privilege('anon',p.oid,'EXECUTE'))=0 AND count(*) FILTER (WHERE NOT has_function_privilege('service_role',p.oid,'EXECUTE'))=0 FROM pg_proc p WHERE p.oid IN ('public.fn_ca_launch_accounting_cutoff(text,uuid)'::regprocedure,'public.fn_ca_launch_accounting_start(text,uuid,timestamptz)'::regprocedure,'public.fn_ca_launch_accounting_waived(text,uuid,timestamptz)'::regprocedure,'public.fn_redeem_vip_points(bigint,text,text)'::regprocedure))

BEGIN;

REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_cutoff(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_start(text, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_waived(text, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_redeem_vip_points(bigint, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_ca_launch_accounting_cutoff(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_launch_accounting_start(text, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_launch_accounting_waived(text, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_redeem_vip_points(bigint, text, text) TO service_role;

COMMIT;
