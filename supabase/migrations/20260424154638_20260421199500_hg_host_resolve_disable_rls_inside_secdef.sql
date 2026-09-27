-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424154638 "20260421199500_hg_host_resolve_disable_rls_inside_secdef"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 05e32e62b6e965e27742935e5f71e6a6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: FORCE RLS on commander_home_content_reports prevents the SECDEF
-- fn from reading rows owned by other users. Add SET row_security = off
-- to the fn — same pattern used by broadcast_to_home_group_roster and
-- other cross-row SECDEF functions.
--
-- Authz is still enforced via the explicit is_staff + escalation checks
-- inside the body — RLS-off only affects the SECDEF-path reads, not
-- user-direct table access.

ALTER FUNCTION public.resolve_home_report_as_host(uuid, uuid, text, text)
  SET row_security = off;

ALTER FUNCTION public.list_home_group_reports_for_host(uuid, text, integer, integer)
  SET row_security = off;
