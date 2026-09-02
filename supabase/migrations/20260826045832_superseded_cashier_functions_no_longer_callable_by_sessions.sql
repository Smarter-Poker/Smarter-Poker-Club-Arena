-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826045832; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

revoke execute on function public.fn_cashier_send_chips(uuid, uuid, numeric, text, text) from authenticated;
revoke execute on function public.fn_cashier_claim_back(uuid, uuid, numeric, text, text) from authenticated;
