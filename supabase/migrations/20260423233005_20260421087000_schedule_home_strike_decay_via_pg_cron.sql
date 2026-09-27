-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260423233005 "20260421087000_schedule_home_strike_decay_via_pg_cron"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 27413a275c3888ff212e0914420d90bb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Register the Phase 3 strike-decay job with pg_cron, matching the
-- existing Home Games cron pattern (jobs 12-25). All cron in this
-- codebase runs in-database via pg_cron — no Vercel cron routes.
--
-- Naming: "home-member-strike-decay" follows the "home-*-*" convention
-- used by the 10 existing home-* jobs.
--
-- Schedule: 30 4 * * *  (04:30 UTC daily)
--   Placed in the late-maintenance window used by vitality-refresh
--   (0 4) and vitality-refresh (15 4); the stale-sweep+log-prune
--   (0-3 AM UTC) finishes well before.
--   Decay granularity is days so exact start-of-day doesn't matter.
--
-- Idempotent: uses cron.schedule() which replaces any prior job with
-- the same name.

SELECT cron.schedule(
  'home-member-strike-decay',
  '30 4 * * *',
  $$SELECT public.fn_decay_home_member_strikes();$$
);
