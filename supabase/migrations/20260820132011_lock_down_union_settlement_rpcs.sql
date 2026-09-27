-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820132011 "lock_down_union_settlement_rpcs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 12a667c7f1ac55c570200f51fc65f179 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- SEC-1 (2026-08-20): money-moving union RPCs were callable by ANY logged-in
-- user with arbitrary arguments.
--
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and Supabase
-- exposes every function in `public` over PostgREST. So a user JWT could
-- POST /rest/v1/rpc/fn_union_settle_player_pnl with any union_id, any window
-- and p_dry_run=false, and the function is SECURITY DEFINER — it would run
-- with owner rights and move chips between club treasuries and the union
-- wallet. Same for the _guarded and _weekly wrappers. None of the three has
-- an auth.uid() check inside; they were written to be called by the workers
-- service and the World Hub settle-period API, both of which use the
-- service-role key.
--
-- Verified before revoking: the ONLY callers are
--   * smarter-poker-workers auto-settlement (service role)
--   * pages/api/club-arena/settle-period.js -> supabaseAdmin (service role)
-- and for the read/rollup functions below, no application caller at all.
-- Nothing in the browser bundle calls any of them.
--
-- fn_union_rake_paid_by_club additionally WRITES (it finalizes rollup days),
-- so leaving it open was both a data-exposure and a cheap DoS lever.

-- Money movers — service role only.
REVOKE EXECUTE ON FUNCTION public.fn_union_settle_player_pnl(uuid, timestamptz, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_settle_player_pnl_guarded(uuid, timestamptz, timestamptz, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_settle_player_pnl_weekly(uuid, numeric) FROM PUBLIC, anon, authenticated;

-- Financial reads with no application caller (fn_union_weekly_statement was
-- reachable by anon, i.e. fully unauthenticated).
REVOKE EXECUTE ON FUNCTION public.fn_union_weekly_statement(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_rake_basis_by_club(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_rake_paid_by_club(uuid, timestamptz, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
