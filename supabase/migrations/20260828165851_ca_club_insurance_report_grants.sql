-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828165851; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 2026-08-28: lock ca_club_insurance_report to the same grant set as its
-- siblings (ca_club_dashboard_stats, ca_union_statement_board). The authz
-- helper deliberately passes when auth.uid() IS NULL (service-role
-- convention), so leaving the default PUBLIC/anon EXECUTE grant would have
-- let the public anon key read any club's insurance report. Caught by
-- probing the RPC anonymously right after creation.
REVOKE ALL ON FUNCTION public.ca_club_insurance_report(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_club_insurance_report(uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.ca_club_insurance_report(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ca_club_insurance_report(uuid, integer) TO service_role;
