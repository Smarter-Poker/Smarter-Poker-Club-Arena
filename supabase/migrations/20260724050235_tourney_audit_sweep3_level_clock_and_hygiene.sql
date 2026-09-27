-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260724050235 "tourney_audit_sweep3_level_clock_and_hygiene"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b9e709ddab0b749c5c82e68b79d61a9b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- TOURNEY-AUDIT SWEEP 3 (2026-07-24): tournament runtime persistence + hygiene
--
-- 1. level_started_at — persists the blind-level clock so an engine restart
--    resumes the level MID-FLIGHT instead of granting a fresh full level at
--    the current blinds (restart-heavy windows nearly froze blind escalation).
-- 2. addon_period_triggered — persists the add-on window flag so a restart
--    mid-add-on doesn't re-broadcast ADDON_PERIOD_START or permanently skip
--    finalizeAfterAddOn.
-- 3. Data hygiene: 755 tournament_players rows were stranded in
--    'playing'/'registered' inside COMPLETED/CANCELLED tournaments (the old
--    force-complete watchdog killed tournaments mid-flight). All 755 verified
--    to be horses — zero real players — so no retro-pay is owed; rows are
--    closed as eliminated for consistent standings/queries.

ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS level_started_at timestamptz;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS addon_period_triggered boolean DEFAULT false;

UPDATE tournament_players tp
SET status = 'eliminated',
    eliminated_at = COALESCE(tp.eliminated_at, t.ended_at, now())
FROM tournaments t
WHERE t.id = tp.tournament_id
  AND tp.status IN ('playing', 'registered')
  AND t.status IN ('COMPLETED', 'CANCELLED');
