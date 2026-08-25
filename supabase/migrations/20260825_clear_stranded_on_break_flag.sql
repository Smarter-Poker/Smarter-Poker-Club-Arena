-- ═══════════════════════════════════════════════════════════════════════════
--  A FINISHED TOURNAMENT IS NOT ON A BREAK (2026-08-25)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- APPLIED to production via the Supabase MCP as migration
-- 20260825081617 clear_stranded_on_break_flag_on_finished_tournaments.
-- This file is the auditable copy.
--
-- Data repair for two engine defects fixed in the same pull request
-- (server/src/tournament/TournamentManagerBase.ts):
--
--   1. resumeFromBreak()'s guard was `if (!this.running || !this.onBreak)
--      return`, which fired BEFORE the persisted break was cleared. stop()
--      sets running = false, so a tournament whose last hand landed during a
--      break left `on_break = true` on its row with nothing alive to clear it.
--
--   2. resume() required `break_ends_at` to be non-null before re-entering a
--      live break, and pauseForBreak writes that column as NULL on purpose
--      (at :55 only the LAST HAND is announced; the end time is stamped up to
--      LAST_HAND_GRACE_MS later, once every table has parked). A restart
--      inside that window left `this.onBreak` false against a row saying true,
--      which guarantees resumeFromBreak can never clear it -- and, worse, left
--      the fresh engines un-paused so the tournament dealt through its own
--      break.
--
-- Measured before this migration: 7 rows, ALL of them status COMPLETED, 5 with
-- break_ends_at NULL. Oldest 2026-08-22 09:55:15 (70 hours), newest
-- 2026-08-23 14:56:39. Four of them -- Daily Freeroll, Sunday Freeroll
-- Special, Sunday Kickoff and Blitz Bounty -- were stamped inside a single
-- 99-second window, the signature of a restart during one :55 last-hand wait.
--
-- SCOPE: finished tournaments ONLY. A COMPLETED or CANCELLED event cannot be
-- on a live break, so this can never interrupt one. RUNNING rows are left
-- alone deliberately -- the engine fix heals those on their next resume, and a
-- running row is the only one where the flag could still legitimately be true.
--
-- ROLLBACK: none needed. The statement is idempotent, and re-setting a
-- finished tournament's on_break to true would itself be the defect. To
-- identify what was touched:
--   select id, name, break_started_at from tournaments
--    where status in ('COMPLETED','CANCELLED') and break_started_at is not null;

DO $$
DECLARE
  v_before integer;
  v_after  integer;
  v_running integer;
BEGIN
  SELECT count(*) INTO v_before
    FROM tournaments
   WHERE on_break IS TRUE AND status IN ('COMPLETED', 'CANCELLED');

  -- Assumption check: nothing RUNNING is caught by this statement. If a
  -- running break exists it must be left to the engine, not to this migration.
  SELECT count(*) INTO v_running
    FROM tournaments
   WHERE on_break IS TRUE AND status NOT IN ('COMPLETED', 'CANCELLED');

  UPDATE tournaments
     SET on_break = false,
         break_ends_at = NULL
   WHERE on_break IS TRUE
     AND status IN ('COMPLETED', 'CANCELLED');

  SELECT count(*) INTO v_after
    FROM tournaments
   WHERE on_break IS TRUE AND status IN ('COMPLETED', 'CANCELLED');

  IF v_after <> 0 THEN
    RAISE EXCEPTION
      'on_break repair did not converge: % finished tournaments still flagged (was %)',
      v_after, v_before;
  END IF;

  RAISE NOTICE 'Cleared on_break on % finished tournament(s); % running row(s) left to the engine',
    v_before, v_running;
END $$;
