-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831173000; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Keep receipt reconciliation behind the service-role API boundary.
-- This follow-up migration also reconciles environments where the original
-- function was deployed before its final grant list was narrowed.
REVOKE ALL ON FUNCTION public.confirm_push_subscription_receipt(text)
  FROM PUBLIC, anon, authenticated
GRANT EXECUTE ON FUNCTION public.confirm_push_subscription_receipt(text)
  TO service_role
