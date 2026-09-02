-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831004705; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 20260830114000: definer writers in the spin path are engine-only.
-- Surfaced by the Definer Authorization CI gate on PR #2000: both functions
-- are SECURITY DEFINER, write, and were executable by browser roles.
REVOKE ALL ON FUNCTION public.fn_sync_seat_first_player_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sync_seat_first_player_count(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric) TO service_role;
