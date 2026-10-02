-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820152525 "lock_down_remaining_union_rpcs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b754de3558f0f3c3aac48251c4e6de98 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- SWEEP: the rest of the fn_union_* family exposed to anon (2026-08-20)
--
-- Earlier today I locked six named union RPCs and noted that the
-- default-PUBLIC-EXECUTE trap applies to EVERY SECURITY DEFINER function
-- nobody explicitly revoked, and that a project-wide sweep was owed. A broad
-- check then found 24 fn_union_* functions still callable by `anon` — i.e. by
-- anyone holding the publishable key, with no login.
--
-- Among them, SECURITY DEFINER + writes + NO auth check:
--   fn_union_integrity_sweep, fn_union_law_selftest
-- and financial readers wide open to anon:
--   fn_union_pnl_all_clubs (every club's P&L), fn_union_club_player_pnl
--   (per-player P&L), fn_union_commingling_report, fn_union_money_path_check,
--   fn_union_agent_coverage, fn_union_pnl_baseline, and the law/integrity
--   breach reports.
--
-- SAFETY CHECKS RUN FIRST, because a careless revoke here is an outage:
--   * fn_union_oversees_club is referenced by SIXTEEN RLS policies, including
--     the `tables` SELECT policy. Revoking it from authenticated would break
--     row-level security evaluation for every logged-in user and could hide
--     every table from every player. IT IS DELIBERATELY LEFT UNTOUCHED.
--   * fn_union_setting and fn_union_oversight_tables are SECURITY INVOKER
--     helpers, so an inner call runs as the invoking user. They keep
--     `authenticated` and lose only `anon`.
--   * fn_union_leaderboard_period_v2 is called from the browser
--     (LeaderboardService.ts) — keeps `authenticated`, loses `anon`.
--   * fn_union_send_to_club_atomic and fn_union_club_player_pnl are called
--     only by World Hub API routes using the service-role key (supabaseAdmin),
--     so both are safe to close entirely.
--   * Functions carrying their own auth.uid() check (expel_club,
--     agent_risk_report, player_directory, weekly_agent_statements) keep
--     `authenticated` and lose `anon`.
--   * Every other function below has zero RLS references and only
--     SECURITY DEFINER callers, which run as the owner regardless of the
--     caller's grants.
--
-- Signatures below were generated from pg_proc rather than typed by hand.

-- Tier 1 — service role only.
REVOKE EXECUTE ON FUNCTION public.fn_union_agent_coverage(p_union_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_club_exit_blockers(p_union_id uuid, p_club_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_club_player_pnl(p_club_id uuid, p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_commingling_report(p_union_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_governance_check() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_hierarchy_warnings() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_house_club_stamp_check() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_integrity_sweep(p_union_id uuid, p_hours integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_law_extra_breaches() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_law_integrity_breaches() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_law_selftest() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_money_path_check() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_overload_check() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_pnl_all_clubs(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_include_horses boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_pnl_baseline(p_union_id uuid, p_at timestamp with time zone) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_send_to_club_atomic(p_union_id uuid, p_club_id uuid, p_amount numeric, p_notes text, p_created_by uuid, p_op_id uuid) FROM PUBLIC, anon, authenticated;

-- Tier 2 — anon closed, authenticated retained.
REVOKE EXECUTE ON FUNCTION public.fn_union_agent_risk_report(p_union_id uuid, p_since timestamp with time zone) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_union_expel_club(p_union_id uuid, p_club_id uuid, p_reason text, p_force boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_union_leaderboard_period_v2(p_union_id uuid, p_metric text, p_period text, p_limit integer, p_offset integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_union_oversight_tables() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_union_player_directory(p_union_id uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_union_setting(p_union_id uuid, p_key text, p_default numeric) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_union_weekly_agent_statements(p_union_id uuid, p_period_start timestamp with time zone) FROM PUBLIC, anon;

-- fn_union_oversees_club: intentionally NOT revoked (16 RLS policies).
