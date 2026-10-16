-- 20261016042047_the_midway_board_and_the_diamond_arena_board_are_a_fixed_sch.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-15, verbatim: "TOURNAMENTS CAN NEVER FAIL, AND MUST ALWAYS RUN
-- AND SPAWN, INSTEAD OF RANDOMLY SPAWNING THEM, PUT THEM ON A HARD CODED
-- SCHEDULE", then "THESE SAME CORRECTIONS NEED TO BE MADE INSIDE OF THE
-- DIAMOND ARENA AS WELL."
--
-- On 2026-10-13 08:15 Chicago the engine's board timers (Free Buys, hourly
-- lobby MTTs, union MTTs - TournamentRecurringService) stopped for ~34 hours
-- after the 13:15 UTC engine kill storm: 2 of 5 Free Buys ran on the 13th, 1 of
-- 5 on the 14th, and ~90 lobby MTTs never existed. Every tournament_schedules
-- row kept spawning on time through the same window (16 of 16 a day). The
-- timers fire relative to "now", keep one live instance per name and stand
-- down on the fleet and board switches; a schedule row is a fixed calendar
-- with a spawn-key claim per occurrence and a page for every missed one.
--
-- So the whole board is now schedule rows at fixed America/Chicago times
-- (daylight saving safe), for BOTH the Midway Union and the Diamond Arena:
--   5 Free Buys a day (00:00, 08:00, 12:00, 16:00, 20:00 - Dan 2026-09-04),
--   15 lobby MTT templates and 5 union MTT templates at the times they were
--   already running, 53 fixed starts a day in all.
-- Each row's config names its template (`fixedBoard`); the engine builds the
-- occurrence with the same builder the timer used (fixedBoardRow in
-- ScheduledTournamentService.ts), and the timers stand down for the Midway
-- Union (MIDWAY_BOARD_IS_ON_THE_FIXED_SCHEDULE). Diamond Arena occurrences go
-- through the arena's own priced door like every other arena schedule.
--
-- Idempotent: a (club, name) already carried by an active schedule row is
-- left alone. No DDL; data only.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

WITH board(name, times, horses) AS (
  VALUES
    ('Midnight Free Buy (NLH)', ARRAY['00:00']::text[], 0),
    ('Morning Free Buy (NLH)', ARRAY['08:00']::text[], 0),
    ('Midday Free Buy (NLH)', ARRAY['12:00']::text[], 0),
    ('Afternoon Free Buy (NLH)', ARRAY['16:00']::text[], 0),
    ('Prime Time Free Buy (NLH)', ARRAY['20:00']::text[], 0),
    ('Early Bird Freeroll (NLH)', ARRAY['22:30','23:45','01:00']::text[], 20),
    ('Pre-Dawn Mystery Bounty (PLO5)', ARRAY['22:30','23:45','01:00']::text[], 15),
    ('Sunrise Bounty (NLH)', ARRAY['01:30','02:50','04:10']::text[], 16),
    ('Morning Grinder (PLO)', ARRAY['01:30','02:50','04:10']::text[], 14),
    ('Mid-Morning Turbo (6-Max NLH)', ARRAY['04:30','05:50','07:10']::text[], 12),
    ('Brunch Special PKO (PLO8)', ARRAY['04:30','05:50','07:10']::text[], 15),
    ('Union Morning Classic (NLH)', ARRAY['05:30']::text[], 20),
    ('Lunch Rush (NLH Deep)', ARRAY['07:30']::text[], 20),
    ('Union PKO Afternoon (PLO4)', ARRAY['09:30']::text[], 18),
    ('Afternoon Bounty (NLH)', ARRAY['10:30','11:50','13:10']::text[], 18),
    ('Coffee Break Freeroll (PLO4)', ARRAY['10:30','11:45','13:00']::text[], 14),
    ('Prime Time Main Event (NLH)', ARRAY['13:30']::text[], 30),
    ('Evening Mystery Bounty (PLO5)', ARRAY['13:30','14:50','16:10']::text[], 18),
    ('Union Grand Championship (NLH)', ARRAY['14:30']::text[], 30),
    ('Union Mystery Bounty (PLO5)', ARRAY['14:30','15:50']::text[], 22),
    ('Night Owl Special (NLH)', ARRAY['16:30','17:50','19:10']::text[], 25),
    ('Late Night PKO (PLO4)', ARRAY['16:30','17:50','19:10']::text[], 20),
    ('Union Late Night Turbo (NLH)', ARRAY['17:30','18:50']::text[], 16),
    ('Late Night Grind (PLO4)', ARRAY['19:30','20:40','21:50']::text[], 10),
    ('Midnight Bounty (NLH)', ARRAY['19:30','20:45','22:00']::text[], 12)
), host(club_id, union_id) AS (
  VALUES
    ('fade0000-0000-0000-0000-000000000001'::uuid, 'fade0000-0000-0000-0000-000000000001'::uuid),
    ('002c2d27-9584-4e52-835a-bb2be148fc81'::uuid, NULL::uuid)
)
INSERT INTO public.tournament_schedules
  (union_id, club_id, name, description, active, days_of_week, start_times_utc,
   interval_minutes, config, time_zone)
SELECT h.union_id, h.club_id, b.name, 'Fixed daily board', true,
       ARRAY[0,1,2,3,4,5,6], b.times, NULL,
       jsonb_build_object('type', 'fixed_board', 'fixedBoard', b.name, 'horsesToRegister', b.horses),
       'America/Chicago'
FROM board b CROSS JOIN host h
WHERE NOT EXISTS (
  SELECT 1 FROM public.tournament_schedules s
  WHERE s.club_id = h.club_id AND s.active AND s.config->>'fixedBoard' = b.name
);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.tournament_schedules
  WHERE active AND config ? 'fixedBoard'
    AND club_id IN ('fade0000-0000-0000-0000-000000000001', '002c2d27-9584-4e52-835a-bb2be148fc81');
  IF n <> 50 THEN
    RAISE EXCEPTION 'fixed board: expected 50 active rows (25 per club), found %', n;
  END IF;
END $$;

COMMIT;
