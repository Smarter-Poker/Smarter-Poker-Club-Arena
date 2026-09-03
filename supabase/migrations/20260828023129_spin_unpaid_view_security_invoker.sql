-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828023129; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
-- spin_unpaid_view_security_invoker
--
-- Housekeeping follow-up to spin_unpaid_settlement_detection.
--
-- public.v_spin_unpaid_settlements was created without security_invoker, so
-- it ran with the privileges of its owner (postgres) and tripped Supabase's
-- security_definer_view advisor. 28 of the 34 views in this schema already
-- set security_invoker=true; this one should not be the odd one out.
--
-- Nothing about the results changes. The only readers are service_role
-- (which bypasses RLS) and public.fn_spin_unpaid_check, which is SECURITY
-- DEFINER owned by postgres and is what the spin_unpaid_check cron job
-- calls. Both still see every row. This just stops the view handing out its
-- owner's privileges to any role that is granted SELECT on it later.
-- ============================================================================

ALTER VIEW public.v_spin_unpaid_settlements SET (security_invoker = true);

