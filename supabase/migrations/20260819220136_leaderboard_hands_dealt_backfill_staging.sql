-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819220136 "leaderboard_hands_dealt_backfill_staging"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3ffcd4b85a654826bf10d8d13d41205b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Staging for the hands_dealt backfill (seat-hands per user/club/day from
-- hand_history, for cash hands strictly BEFORE the trigger cutover
-- 2026-08-19 21:58:38 UTC). Dropped once the backfill is verified.
CREATE TABLE IF NOT EXISTS _lb_hands_daily (
  user_id uuid   NOT NULL,
  club_id uuid   NOT NULL,
  day     date   NOT NULL,
  hands   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, club_id, day)
);
ALTER TABLE _lb_hands_daily ENABLE ROW LEVEL SECURITY;
