-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819160911 "leaderboard_backfill_staging"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3ef2f21c7668a1bb260e86311733546c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Staging for the 2026-08-19 leaderboard profit backfill (rake_records x
-- hand_history, hands created before 2026-08-19 16:07:23 UTC = the moment the
-- real-profit trigger went live). Dropped by a follow-up migration once the
-- backfill is verified.
CREATE TABLE IF NOT EXISTS _lb_backfill_daily (
  user_id uuid    NOT NULL,
  club_id uuid    NOT NULL,
  day     date    NOT NULL,
  win     numeric NOT NULL DEFAULT 0,
  loss    numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, club_id, day)
);
ALTER TABLE _lb_backfill_daily ENABLE ROW LEVEL SECURITY;
