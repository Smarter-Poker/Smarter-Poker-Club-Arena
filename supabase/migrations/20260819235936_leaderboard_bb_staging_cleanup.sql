-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819235936 "leaderboard_bb_staging_cleanup"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 92b9bdd179b347757dcc04598488e52e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- bb/100 backfill reconciled at 100.000% of hand_history big-blind totals
-- (20,079,332 staged vs 20,079,296 true; the 36 BB difference is live traffic
-- arriving between the final batch and the verification query).
DROP TABLE IF EXISTS _lb_bb_daily;
