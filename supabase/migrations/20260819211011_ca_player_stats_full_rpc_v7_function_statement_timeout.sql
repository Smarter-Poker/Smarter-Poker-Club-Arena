-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819211011 "ca_player_stats_full_rpc_v7_function_statement_timeout"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c453d9d05cbeb6e8c5a352d48a2da3d9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- v7: the `authenticated` role has statement_timeout=8s. For very high-volume
-- accounts the dominant cost is the bitmap heap scan over every hand the user
-- appears in (measured: 71,238 rows / 35,807 heap blocks / ~12s for one horse)
-- before the LIMIT can apply, so those calls were being cancelled and the page
-- fell back to legacy per-club aggregates. Give the function its own timeout so
-- it returns real numbers instead of erroring. Typical human accounts are
-- unaffected (measured 93ms for a 92-hand player).
--
-- NOTE: the durable fix is a (user_id, created_at DESC) hand->player index table
-- so the top-N lookup never touches the full match set; that needs a scheduled
-- refresh (Open Claw per CLAUDE.md section 11) and is written up in the audit.
ALTER FUNCTION public.ca_player_stats_full(uuid) SET statement_timeout = '30s';
