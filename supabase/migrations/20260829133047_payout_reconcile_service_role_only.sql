-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829133047; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Follow-up to reconciler_stamps_the_prize_it_pays (2026-08-29): the
-- pre-push definer-authorization check flagged that
-- fn_tournament_payout_reconcile is a SECURITY DEFINER writer a browser
-- role could execute, and it never asks who is calling. Its only
-- legitimate caller is the server-side payout sweep (service_role).

REVOKE ALL ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  TO service_role;
