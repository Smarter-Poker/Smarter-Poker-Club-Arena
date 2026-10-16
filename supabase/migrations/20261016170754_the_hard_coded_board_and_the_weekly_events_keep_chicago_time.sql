-- 20261016170754_the_hard_coded_board_and_the_weekly_events_keep_chicago_time.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (2026-10-16 audit of the fixed board, #7071/#7093):
--
-- Dan, 2026-10-15 and 2026-10-16: "PUT THEM ON A HARD CODED SCHEDULE" and "I
-- WANT ALL HARD CODED SCHEDULED EVENTS ONLY".
--
-- 1. THE WEEKLY EVENTS KEEP THEIR CHICAGO TIME THROUGH DAYLIGHT SAVING.
--    The 25-event daily board is on America/Chicago wall clock. The 63 other
--    active schedules in each of the Midway Union and the Diamond Arena (the
--    weekly MTTs, PKOs, mystery bounties, the Sunday 200 Deep Stack, its three
--    satellites and the four "100 Chip / 100 Diamond Guarantee Freeroll" rows)
--    were still UTC rows (time_zone NULL). Every one was authored for Chicago
--    summer time: "100 Chip Guarantee Freeroll - 6:00 PM" is 23:00 UTC,
--    "Friday Night Feature" is Saturday 02:00 UTC (Friday 9 PM). On Sunday
--    2026-11-01 Chicago falls back to UTC-6 and each of them would have
--    started an hour EARLY by the players' clock: the 6:00 PM freeroll at
--    5:00 PM, the 12:00 AM one at 11:00 PM the night before.
--
--    Each row is rewritten to the SAME Chicago wall-clock days and times it
--    runs at today, with time_zone = 'America/Chicago'. The conversion is
--    computed per (day, time) through the zone itself on the week of
--    2026-10-18 (all CDT), and the migration aborts if any row's local
--    (day, time) pairs are not a clean days x times product, so no row can be
--    widened or narrowed by the rewrite.
--
--    A zoned schedule keys its occurrences on the LOCAL calendar
--    ("<id>:<local date>:<local HH:MM>", ScheduledTournamentService
--    zonedSpawnsDue) where a UTC row keyed them on the UTC calendar. Every
--    occurrence already spawned inside the look-ahead therefore gets its local
--    key written beside the old one, pointing at the same tournament, so the
--    rewrite can never spawn a second copy of an event that already exists.
--
-- 2. AN OWNER SCREEN CANNOT FIGHT THE ENGINE OVER THE BOARD.
--    The engine now re-writes the hard-coded board every ten minutes
--    (FIXED_BOARD_RESYNC_MS). The union owner's Recurring Schedules list still
--    offered Deactivate on those rows, which would have looked like it worked
--    and been undone within ten minutes. A board row is now written only by
--    the engine (service role) or a migration: an authenticated or anonymous
--    session is refused with a plain sentence, and the screen shows the row as
--    part of the fixed board instead of offering the button.
--
-- @live-proof: (SELECT count(*) FROM public.tournament_schedules WHERE active AND time_zone IS NULL AND COALESCE(array_length(start_times_utc,1),0) > 0 AND club_id IN ('fade0000-0000-0000-0000-000000000001','002c2d27-9584-4e52-835a-bb2be148fc81')) = 0 AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'a01_tournament_schedule_board_is_hard_coded' AND tgrelid = 'public.tournament_schedules'::regclass)

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 2. The board is written by the engine only.
CREATE OR REPLACE FUNCTION public.fn_tournament_schedule_board_is_hard_coded()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') IN ('authenticated', 'anon')
     AND (
       (TG_OP <> 'INSERT' AND (OLD.config->>'type' = 'fixed_board' OR OLD.config ? 'fixedBoard'))
       OR (TG_OP <> 'DELETE' AND (NEW.config->>'type' = 'fixed_board' OR NEW.config ? 'fixedBoard'))
     ) THEN
    RAISE EXCEPTION 'This event is on the hard coded daily board. Its times are set by the engine and cannot be changed here.'
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS a01_tournament_schedule_board_is_hard_coded ON public.tournament_schedules;
CREATE TRIGGER a01_tournament_schedule_board_is_hard_coded
  BEFORE INSERT OR UPDATE OR DELETE ON public.tournament_schedules
  FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_schedule_board_is_hard_coded();

-- 1. The weekly events keep their Chicago time.
CREATE TEMP TABLE pg_temp.chicago_pin ON COMMIT DROP AS
WITH target AS (
  SELECT s.id, s.days_of_week, s.start_times_utc
    FROM public.tournament_schedules s
   WHERE s.active
     AND s.time_zone IS NULL
     AND COALESCE(array_length(s.start_times_utc, 1), 0) > 0
     AND s.club_id IN ('fade0000-0000-0000-0000-000000000001'::uuid,  -- Midway Union
                       '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid)  -- Diamond Arena
),
pairs AS (
  SELECT t.id,
         (((DATE '2026-10-18' + d) + tm::time) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Chicago' AS local_at
    FROM target t,
         unnest(t.days_of_week) AS d,
         unnest(t.start_times_utc) AS tm
),
local_pairs AS (
  SELECT DISTINCT id,
         extract(dow FROM local_at)::int AS local_dow,
         to_char(local_at, 'HH24:MI') AS local_time
    FROM pairs
)
SELECT id,
       array_agg(DISTINCT local_dow ORDER BY local_dow) AS new_days,
       array_agg(DISTINCT local_time ORDER BY local_time) AS new_times,
       count(*) AS pair_count
  FROM local_pairs
 GROUP BY id;

DO $do$
DECLARE
  v_bad int;
  v_rows int;
BEGIN
  SELECT count(*) INTO v_rows FROM pg_temp.chicago_pin;
  -- Every row's local pairs must be exactly days x times, or one row cannot
  -- hold them and the rewrite would add or drop an occurrence.
  SELECT count(*) INTO v_bad
    FROM pg_temp.chicago_pin p
   WHERE p.pair_count <> array_length(p.new_days, 1) * array_length(p.new_times, 1);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'chicago pin: % schedule(s) do not map to one days x times row', v_bad;
  END IF;
  IF v_rows <> 126 THEN
    RAISE EXCEPTION 'chicago pin: expected 126 UTC schedules (63 per club), found %', v_rows;
  END IF;
END $do$;

-- The occurrences already spawned keep their identity under the local key.
INSERT INTO public.tournament_schedule_spawns (schedule_id, spawn_key, tournament_id, created_at)
SELECT sp.schedule_id,
       sp.schedule_id::text || ':' ||
         to_char(local_at, 'YYYY-MM-DD') || ':' || to_char(local_at, 'HH24:MI'),
       sp.tournament_id,
       sp.created_at
  FROM (
    SELECT sp.*,
           (to_timestamp(right(sp.spawn_key, 16), 'YYYY-MM-DD:HH24:MI')::timestamp AT TIME ZONE 'UTC')
             AT TIME ZONE 'America/Chicago' AS local_at,
           to_timestamp(right(sp.spawn_key, 16), 'YYYY-MM-DD:HH24:MI')::timestamp AT TIME ZONE 'UTC' AS utc_at
      FROM public.tournament_schedule_spawns sp
      JOIN pg_temp.chicago_pin p ON p.id = sp.schedule_id
     WHERE sp.spawn_key ~ ('^' || sp.schedule_id::text || ':\d{4}-\d{2}-\d{2}:\d{2}:\d{2}$')
  ) sp
 WHERE sp.utc_at >= now() - interval '1 day'
ON CONFLICT (spawn_key) DO NOTHING;

UPDATE public.tournament_schedules s
   SET days_of_week    = p.new_days,
       start_times_utc = p.new_times,
       time_zone       = 'America/Chicago',
       updated_at      = now()
  FROM pg_temp.chicago_pin p
 WHERE s.id = p.id;

DO $do$
DECLARE
  v_left int;
  v_missing int;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.tournament_schedules s
   WHERE s.active AND s.time_zone IS NULL
     AND COALESCE(array_length(s.start_times_utc, 1), 0) > 0
     AND s.club_id IN ('fade0000-0000-0000-0000-000000000001'::uuid,
                       '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid);
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'chicago pin: % UTC schedule(s) left in the two clubs', v_left;
  END IF;
  -- Every live pre-start occurrence of a pinned schedule is reachable by its
  -- new local key, so the scheduler sees it as already spawned.
  SELECT count(*) INTO v_missing
    FROM public.tournaments t
    JOIN pg_temp.chicago_pin p ON p.id = t.schedule_id
   WHERE upper(t.status) IN ('ANNOUNCED', 'REGISTERING')
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_schedule_spawns sp
        WHERE sp.spawn_key = t.schedule_id::text || ':' ||
              to_char(t.start_time AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD:HH24:MI')
     );
  IF v_missing <> 0 THEN
    RAISE EXCEPTION 'chicago pin: % pre-start occurrence(s) have no local spawn key', v_missing;
  END IF;
END $do$;

COMMIT;
