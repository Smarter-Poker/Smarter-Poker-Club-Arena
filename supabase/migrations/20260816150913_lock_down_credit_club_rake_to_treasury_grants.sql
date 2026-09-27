-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260816150913 "lock_down_credit_club_rake_to_treasury_grants"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2d33fc0a22c1f93b223e4be6eec94087 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- credit_club_rake_to_treasury was created on 2026-08-15 without an explicit
-- REVOKE, so it inherited EXECUTE for PUBLIC (and this project's default grant
-- to anon). The function it replaced, increment_club_chip_pool, is service_role
-- only -- so this was a least-privilege regression introduced by the rename.
--
-- It was NOT exploitable: the function is not SECURITY DEFINER, so it runs with
-- the caller's privileges and RLS on public.clubs made the UPDATE a no-op for an
-- authenticated caller (verified by probe: treasury delta 0.00). Locking it down
-- anyway -- defence in depth, and to match the posture of the function it
-- replaced. Only the engine (service_role) credits rake.
REVOKE EXECUTE ON FUNCTION public.credit_club_rake_to_treasury(uuid, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credit_club_rake_to_treasury(uuid, numeric) FROM anon;
REVOKE EXECUTE ON FUNCTION public.credit_club_rake_to_treasury(uuid, numeric) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.credit_club_rake_to_treasury(uuid, numeric) TO service_role;
