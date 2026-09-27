-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424023246 "20260421187000_hg_revoke_anon_grants_on_admin_and_pii_tables"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 286390ce126048dc679fa5864cfcba24 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Deeper hunt: anon had lingering SELECT grants on 3 sensitive HG tables
-- (audit_log, content_reports, ban_appeals). RLS already filtered anon
-- to 0 rows, but granting SELECT means anon can evaluate the table at
-- all — wasted IO + weaker defense-in-depth. REVOKE from anon.
--
-- Authenticated keeps SELECT; RLS filters to the right row set
-- (audit_log → staff, content_reports → self, ban_appeals → self).

REVOKE SELECT ON public.commander_home_audit_log       FROM anon;
REVOKE SELECT ON public.commander_home_content_reports FROM anon;
REVOKE SELECT ON public.commander_home_ban_appeals     FROM anon;

-- Also tighten audit_log: authenticated should not have raw SELECT — 
-- group-staff audit trail access happens via SECDEF RPCs with
-- a service_role pathway. Drop raw grant + drop the RLS policy
-- that mirrored the staff check (belt-and-suspenders removal).
REVOKE SELECT ON public.commander_home_audit_log FROM authenticated;
DROP POLICY IF EXISTS home_audit_log_select ON public.commander_home_audit_log;
