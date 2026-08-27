-- ═══════════════════════════════════════════════════════════════════════════
--  THE BREAK COLUMNS ARE DECLARED SOMEWHERE (2026-08-27)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- TIER 1. Additive, IF NOT EXISTS, no data change. Nothing here alters a
-- single row: on production these three columns ALREADY EXIST with exactly
-- the shapes written below (verified against information_schema before
-- writing this). This migration exists so that a fresh database built from
-- supabase/migrations has them too.
--
-- WHY IT IS NEEDED
--
-- `tournaments.on_break`, `tournaments.break_started_at` and
-- `tournaments.break_ends_at` are the entire persisted state of the
-- platform-wide :55 synchronized break. They are read and written by
-- TournamentManagerBase (pauseForBreak, beginBreakCountdown,
-- clearPersistedBreak, the resume() break-recovery block), by
-- TournamentManagerEliminations on both completion paths, and by the client's
-- BlindsTab. They appear in scripts/ci/supabase-columns-manifest.json.
--
-- And until now NO MIGRATION IN THIS REPO CREATED ANY OF THEM. An exhaustive
-- grep of supabase/migrations/**/*.sql for those three names returned exactly
-- one file, 20260825_clear_stranded_on_break_flag.sql, which UPDATEs them and
-- assumes they are there. They were added out of band, so the repo's migration
-- history could not rebuild the schema its own code depends on, and the
-- columns' types and defaults lived nowhere a reader could find them.
--
-- 20260822100000_tournament_feature_parity_columns.sql declares the fourth
-- break column, `synchronized_breaks`; it is repeated here (also IF NOT
-- EXISTS, also a no-op) purely so all four are legible in one place.
--
-- ASSUMPTIONS, ASSERTED BELOW
--   * public.tournaments exists.
--   * If the columns already exist, they have these types. A pre-existing
--     column with a DIFFERENT type is a real conflict and must abort rather
--     than be silently tolerated, because the engine writes these by name.
--
-- ROLLBACK
--   Not applicable: this migration adds nothing that is not already present
--   on production and changes no data. Dropping these columns would break
--   every break code path and must never be done as a "rollback" of this file.

DO $$
BEGIN
  IF to_regclass('public.tournaments') IS NULL THEN
    RAISE EXCEPTION 'public.tournaments does not exist - wrong database?';
  END IF;
END $$;

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS on_break            boolean NOT NULL DEFAULT false;

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS break_started_at    timestamptz;

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS break_ends_at       timestamptz;

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS synchronized_breaks boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.tournaments.on_break IS
  'True while this tournament is inside the platform-wide :55 synchronized break. Written by TournamentManagerBase.pauseForBreak, cleared by clearPersistedBreak.';

COMMENT ON COLUMN public.tournaments.break_started_at IS
  'When the break was ANNOUNCED (:55), not when the five minutes began. The last hand on every table still has to land first.';

COMMENT ON COLUMN public.tournaments.break_ends_at IS
  'When play resumes. Deliberately NULL between :55 and the moment every table has finished its last hand - there is no honest end time during that window, and beginBreakCountdown fills it in. A client that finds this NULL while on_break is true must render the last-hand state, never a guessed countdown.';

COMMENT ON COLUMN public.tournaments.synchronized_breaks IS
  'The ONLY opt-out from the :55 break. Set false per tournament, on purpose, by an operator. Format is never an opt-out: every MTT, Spin and Heads-Up takes the break (Dan 2026-08-27).';

-- ── Post-apply assertions ────────────────────────────────────────────────
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(column_name || ' is ' || data_type, ', ')
    INTO v_bad
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'tournaments'
     AND (   (column_name = 'on_break'            AND data_type <> 'boolean')
          OR (column_name = 'synchronized_breaks' AND data_type <> 'boolean')
          OR (column_name = 'break_started_at'    AND data_type <> 'timestamp with time zone')
          OR (column_name = 'break_ends_at'       AND data_type <> 'timestamp with time zone'));

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'break column type conflict: %', v_bad;
  END IF;

  IF (SELECT count(*)
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'tournaments'
         AND column_name IN ('on_break', 'break_started_at', 'break_ends_at',
                             'synchronized_breaks')) <> 4 THEN
    RAISE EXCEPTION 'expected all four break columns on public.tournaments';
  END IF;
END $$;
