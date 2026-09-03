-- ═══════════════════════════════════════════════════════════════════════════
-- MULTI-DAY MTT: THE CHECKBOX STOPS PROMISING SOMETHING THAT DOES NOT EXIST
-- ───────────────────────────────────────────────────────────────────────────
-- 2026-08-26.
--
-- WHAT ACTUALLY EXISTS TODAY, measured against production rather than taken
-- from the audit notes:
--
--   * `tournaments.is_multi_day` (bool), `total_days` (int, default 1),
--     `day_number` (int, default 1), `flight_number` (int), and
--     `flight_end_chips_snapshot` (jsonb) are all real columns.
--   * `tables.multi_day_mtt` is a real column on the config side.
--   * The engine NEVER READS ANY OF THEM. The only two occurrences of
--     `is_multi_day` under `server/` are lines 961-962 of
--     ScheduledTournamentService.ts, and both are entries in a column list
--     that copies a template. There is no day-end handler, no bagging, no
--     Day 2 seat draw, no flight merge, and nothing writes
--     `flight_end_chips_snapshot`.
--   * The only consumers are three pieces of chrome: a "Multi-Day" badge in
--     DetailOverviewTab.tsx:400, a lobby-card tag in
--     TournamentLobbyCard.tsx:530, and a line of copy at
--     DetailOverviewTab.tsx:516.
--
-- So the honest description of the current behaviour is: ticking Multi-Day
-- MTT changes NOTHING about how the event runs. It plays down from Day 1
-- registration to a single winner in one sitting, pays the whole prize pool,
-- and completes. The badge says Multi-Day. The tournament is a freezeout.
--
-- Production counts at the time of writing: 34,072 tournaments,
-- 0 with is_multi_day = true, 0 with total_days > 1, 0 with day_number > 1,
-- 0 with flight_number set, 0 with flight_end_chips_snapshot written.
--
-- WHY REFUSE RATHER THAN PART-BUILD IT
--
-- The tempting half is "end Day 1 correctly and bag the stacks, so a Day 2
-- becomes possible later". That half is not safe on its own, for two reasons:
--
--   1. There is no schema anywhere that says WHEN a day ends. No day_end_level,
--      no day_end_at, no bag-and-tag level. Inventing one here would be
--      guessing at the club owner's intent.
--   2. A day that ends with no resume path is strictly WORSE than today. Today
--      the event finishes and pays. A half-built version would stop mid-event
--      with chips bagged, no way to seat Day 2, and a prize pool nobody can
--      collect. That converts a cosmetic lie into a stuck tournament holding
--      real money.
--
-- So the flag refuses to be set, loudly, until the feature behind it exists.
-- Nothing is lost: no tournament has ever used it.
--
-- The refusal is a TRIGGER and not a CHECK constraint because the error text
-- is the point. It fires for every writer including `service_role` and the
-- SECURITY DEFINER `fn_create_tournament`, so there is no client, RPC or
-- engine path around it.
--
-- WHEN SOMEBODY BUILDS THIS: drop the trigger in the same migration that adds
-- the day-end handler and the Day 2 resume. The trigger existing is the signal
-- that the resume does not.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Pre-flight: this must be a no-op for every row that already exists ─────
DO $preflight$
DECLARE v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.tournaments
   WHERE COALESCE(is_multi_day, false) IS TRUE
      OR COALESCE(total_days, 1) > 1;

  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'refusing to install the guard: % existing tournaments already carry a multi-day flag, so this would strand them on their next update',
      v_bad;
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.fn_tournaments_refuse_unbuilt_multi_day()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF COALESCE(NEW.is_multi_day, false) IS TRUE OR COALESCE(NEW.total_days, 1) > 1 THEN
    RAISE EXCEPTION
      'Multi day tournaments are not built yet. There is no day end, no Day 2 resume and no flight merge, so this event would play down to a single winner in one session while the lobby promised otherwise. Leave multi day off.'
      USING ERRCODE = '0A000';
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.fn_tournaments_refuse_unbuilt_multi_day() IS
  'Refuses is_multi_day / total_days > 1 because no Day 2 resume or flight merge exists. Drop this trigger in the same migration that implements them.';

DROP TRIGGER IF EXISTS trg_tournaments_refuse_unbuilt_multi_day ON public.tournaments;

CREATE TRIGGER trg_tournaments_refuse_unbuilt_multi_day
BEFORE INSERT OR UPDATE OF is_multi_day, total_days ON public.tournaments
FOR EACH ROW
EXECUTE FUNCTION public.fn_tournaments_refuse_unbuilt_multi_day();

-- ── Post-apply assertions ──────────────────────────────────────────────────
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_tournaments_refuse_unbuilt_multi_day'
       AND tgrelid = 'public.tournaments'::regclass
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'the guard trigger did not land';
  END IF;

  -- It must fire for EVERY writer. A trigger that only fires for one role is
  -- the same class of bug as the RLS-visibility hole this pull request also
  -- closes, so assert the enable state is "origin and replica" (O) or the
  -- default "origin" (O), never disabled (D).
  IF EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_tournaments_refuse_unbuilt_multi_day'
       AND tgrelid = 'public.tournaments'::regclass
       AND tgenabled = 'D'
  ) THEN
    RAISE EXCEPTION 'the guard trigger landed disabled';
  END IF;
END
$verify$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
--
--   DROP TRIGGER IF EXISTS trg_tournaments_refuse_unbuilt_multi_day
--     ON public.tournaments;
--   DROP FUNCTION IF EXISTS public.fn_tournaments_refuse_unbuilt_multi_day();
--
-- Rolling back restores the previous behaviour exactly: the flag can be set
-- again, and it will again do nothing.
-- ═══════════════════════════════════════════════════════════════════════════
