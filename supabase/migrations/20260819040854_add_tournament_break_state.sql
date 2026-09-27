-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819040854 "add_tournament_break_state"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e40ae9ab9eac4a20efaf67128bd147b1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Dan 2026-08-19: synchronized breaks were IN-MEMORY ONLY. The engine held
-- `onBreak` on the TournamentManager instance and wrote nothing down, so:
--   * a break could not be verified from the database at all;
--   * a restart mid-break lost the fact a break was in progress;
--   * the lobby and table UI had no way to show "on break" truthfully.
--
-- Breaks run :55 -> :00 every hour. These columns make the state observable and
-- survivable.
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS on_break boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS break_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS break_ends_at timestamptz;

COMMENT ON COLUMN tournaments.on_break IS
  'True while a synchronized break is in progress (breaks run :55 to :00 hourly).';
COMMENT ON COLUMN tournaments.break_ends_at IS
  'When the current synchronized break ends; NULL when not on break.';

CREATE INDEX IF NOT EXISTS idx_tournaments_on_break
  ON tournaments (on_break) WHERE on_break = true;

DO $$
DECLARE v_cols int;
BEGIN
  SELECT count(*) INTO v_cols FROM information_schema.columns
   WHERE table_schema='public' AND table_name='tournaments'
     AND column_name IN ('on_break','break_started_at','break_ends_at');
  IF v_cols <> 3 THEN
    RAISE EXCEPTION 'Expected 3 break columns, found %', v_cols;
  END IF;
  RAISE NOTICE 'Tournament break state columns present (%).', v_cols;
END $$;
