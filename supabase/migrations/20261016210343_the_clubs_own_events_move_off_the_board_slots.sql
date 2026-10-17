-- 20261016210343_the_clubs_own_events_move_off_the_board_slots.sql
--
-- Named for the version it was installed under (2026-10-16 21:03 UTC), after
-- engine 52ed250b (#7131) was verified serving: that engine reads a
-- schedule's previousStartTimes / startTimesEffectiveFrom (resolveTimeChange),
-- and the engine before it did not, so installing these moves any earlier
-- would have spawned both the old and the new time for three days.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-16: "REDO THEM SO TOURNAMENT DO NOT START AT THE SAME TIME,
-- THAT THEY ARE SPREAD OUT ACCORDINGLY THROUGHOUT THE DAY." #7131 put the
-- daily board on a 20-minute grid with one event per slot. This moves the
-- Midway Union's and the Diamond Arena's own events (63 schedules each) onto
-- the slots the board leaves them, WEEKLY_EVENT_SLOTS in
-- server/src/config/fixedBoard.ts:
--   the four 100 Guarantee Freerolls 12:00/6:00 -> 12:20/6:20 (renamed),
--   the 2:30 AM graveyard events -> 2:40 AM,
--   the 8:00 PM weekly event -> 8:20 PM (the Prime Time Free Buy keeps 8 PM),
--   the 8:00 PM Sunday Deep Stack Satellite 5 -> 8:40 PM,
--   the Sunday 200 Deep Stack 12:00 PM -> 1:00 PM (the Midday Free Buy keeps noon).
-- Each moved row carries previousStartTimes and startTimesEffectiveFrom, so a
-- date that already has an occurrence at the old time keeps it and only a
-- date with nothing on the board yet takes the new time. No date is doubled.
--
-- @live-proof: (SELECT count(*) FROM public.tournament_schedules WHERE active AND name = 'Sunday 200 Deep Stack' AND start_times_utc = ARRAY['13:00'] AND club_id IN ('fade0000-0000-0000-0000-000000000001','002c2d27-9584-4e52-835a-bb2be148fc81')) = 2

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE pg_temp.respace ON COMMIT DROP AS
SELECT s.id,
       s.start_times_utc AS old_times,
       ARRAY(
         SELECT CASE
                  WHEN s.name LIKE '100 % Guarantee Freeroll%'
                    THEN to_char(tm::time + interval '20 minutes', 'HH24:MI')
                  WHEN s.name = 'Sunday 200 Deep Stack' AND tm = '12:00' THEN '13:00'
                  WHEN s.config->>'type' = 'satellite' AND tm = '20:00' THEN '20:40'
                  WHEN tm = '02:30' THEN '02:40'
                  WHEN tm = '20:00' THEN '20:20'
                  ELSE tm
                END
           FROM unnest(s.start_times_utc) AS tm
          ORDER BY 1
       ) AS new_times
  FROM public.tournament_schedules s
 WHERE s.active
   AND s.time_zone = 'America/Chicago'
   AND COALESCE(array_length(s.start_times_utc, 1), 0) > 0
   AND s.club_id IN ('fade0000-0000-0000-0000-000000000001'::uuid,  -- Midway Union
                     '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid)  -- Diamond Arena
   AND s.config->>'type' IS DISTINCT FROM 'fixed_board'
   AND NOT (s.config ? 'fixedBoard')
   AND NOT (s.config ? 'previousStartTimes');

DO $do$
DECLARE
  v_rows int;
  v_moved int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE new_times IS DISTINCT FROM old_times)
    INTO v_rows, v_moved FROM pg_temp.respace;
  IF v_rows <> 126 OR v_moved <> 40 THEN
    RAISE EXCEPTION 'respace: expected 126 club schedules with 40 to move, found % and %', v_rows, v_moved;
  END IF;
END $do$;

UPDATE public.tournament_schedules s
   SET start_times_utc = r.new_times,
       name = CASE WHEN s.name LIKE '100 % Guarantee Freeroll%'
                   THEN replace(s.name, ':00 ', ':20 ') ELSE s.name END,
       config = s.config
         || jsonb_build_object('previousStartTimes', to_jsonb(r.old_times),
                               'startTimesEffectiveFrom', '2026-10-17')
         || CASE WHEN s.name LIKE '100 % Guarantee Freeroll%' AND s.config ? 'name'
                 THEN jsonb_build_object('name', replace(s.config->>'name', ':00 ', ':20 '))
                 ELSE '{}'::jsonb END,
       updated_at = now()
  FROM pg_temp.respace r
 WHERE r.id = s.id
   AND r.new_times IS DISTINCT FROM r.old_times;

DO $do$
DECLARE
  v_clash int;
  v_slots text[];
BEGIN
  SELECT count(*) INTO v_clash FROM (
    SELECT s.club_id, d, tm
      FROM public.tournament_schedules s
      JOIN pg_temp.respace r ON r.id = s.id,
           unnest(s.days_of_week) AS d, unnest(s.start_times_utc) AS tm
     GROUP BY 1, 2, 3 HAVING count(*) > 1
  ) x;
  IF v_clash <> 0 THEN
    RAISE EXCEPTION 'respace: % club/day/time slot(s) still start two events', v_clash;
  END IF;
  SELECT array_agg(DISTINCT tm ORDER BY tm) INTO v_slots
    FROM public.tournament_schedules s
    JOIN pg_temp.respace r ON r.id = s.id, unnest(s.start_times_utc) AS tm;
  -- The same list as WEEKLY_EVENT_SLOTS in server/src/config/fixedBoard.ts.
  IF v_slots IS DISTINCT FROM ARRAY['00:20','02:40','06:20','09:00','10:00','12:20','13:00',
       '14:00','15:00','18:00','18:20','19:00','20:20','20:40','21:00','22:00','23:00']::text[] THEN
    RAISE EXCEPTION 'respace: the clubs'' own events hold %, not the reserved weekly slots', v_slots;
  END IF;
END $do$;

COMMIT;
