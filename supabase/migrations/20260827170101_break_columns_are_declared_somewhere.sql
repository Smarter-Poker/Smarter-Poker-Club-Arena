-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827170101; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

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
