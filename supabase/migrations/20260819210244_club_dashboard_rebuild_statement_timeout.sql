-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819210244 "club_dashboard_rebuild_statement_timeout"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3c5691ac1f79549f70a41a05a8258575 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The per-table exception block could not rescue a statement timeout: 57014
-- aborts the whole outer statement, so a nested BEGIN/EXCEPTION never runs.
-- Backfill functions instead get their own generous statement_timeout at
-- function scope. This is a service_role-only maintenance path (no EXECUTE for
-- authenticated/anon), so it cannot be used to tie up a request-facing role,
-- and the read RPCs the dashboard actually calls keep the default timeout.
ALTER FUNCTION public.ca_rebuild_club_member_stats_table(uuid)
  SET statement_timeout = '180s';

ALTER FUNCTION public.ca_rebuild_club_member_stats(uuid, integer, timestamptz)
  SET statement_timeout = '600s';
