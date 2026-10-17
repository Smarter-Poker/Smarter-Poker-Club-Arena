-- SATELLITES INTO THE BOUNTY EVENTS (Dan, 2026-10-16). The second half of
-- "EVERY TOURNAMENT WITH A 25 BUY IN OR HIGHER SHOULD HAVE SATELLITES INTO
-- IT": the bounty, PKO and mystery-bounty events, which 20261017031617 had to
-- leave out because the satellite settlement refused them. Since
-- 20261017004440_satellites_seat_bounty_targets both settlement authorities
-- seat a bounty target exactly like a paid entry (prize, bounty and fee, with
-- a funded bounty head), so these events can be fed.
--
-- Midway Union only. A Diamond Arena bounty event still cannot be fed: the
-- Diamond seat transfer has no bounty part, so fn_satellite_target_is_deliverable
-- refuses it and fn_ca_guard_new_satellite_target refuses the satellite. The
-- Diamond Arena's plain events of 25 or more already have their satellites.
--
-- Every satellite starts on a :15 or :45, on a day and slot no other Midway
-- satellite holds, and its name never begins with its target's name (the
-- target is found by name prefix, so such a name could match itself).
-- The schedule rows only describe satellites; each spawn waits until its
-- target is on the board and deliverable, as every satellite schedule does.
--
-- Targets (buy-in) and their satellites, Chicago time:
--   Union Mystery Bounty (PLO5), 27.50, Mon-Sat 3:30 PM   <- 11:45 AM, 5
--   Union Grand Championship (NLH), 55, Mon-Sat 5:00 PM   <- 1:45 PM, 10
--   Monday Knockout, 33, Mon 9:00 PM                      <- Mon 7:15 PM, 5
--   Tuesday Bounty Hunt, 33, Tue 9:00 PM                  <- Tue 7:15 PM, 5
--   Friday Five-Card Bounty, 33, Fri 8:00 PM              <- Fri 4:45 PM, 5
--   Friday Fight Night PKO, 33, Fri 10:00 PM              <- Fri 7:15 PM, 5
--   Saturday Mystery, 33, Sat 8:00 PM                     <- Sat 4:45 PM, 5
--   Saturday Stackfest PKO, 33, Sat 10:00 PM              <- Sat 7:15 PM, 5
--   Sunday Funday Bounty Builder, 55, Sun 1:30 PM         <- Sat 8:45 PM, 10
--   Sunday Funday PLO PKO, 55, Sun 2:00 PM                <- Sat 6:45 PM, 10
--   Sunday Funday PLO5 Mystery, 55, Sun 3:30 PM           <- Sat 10:15 PM, 10
--   Sunday Funday Mystery, 55, Sun 8:00 PM                <- Sun 3:45 PM, 10
--   Sunday Funday Late PKO, 55, Sun 9:30 PM               <- Sun 5:15 PM, 10
--   Sunday Funday High Roller PKO, 77, Sun 10:00 PM       <- Sun 6:45 PM, 15
--   Sunday Funday Night Owl, 33, Sun 10:30 PM             <- Sun 7:15 PM, 5
-- The Sunday Funday events before 3:30 PM are fed on Saturday evening,
-- because every Sunday :15 and :45 before then already holds a satellite.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  c_midway CONSTANT uuid := 'fade0000-0000-0000-0000-000000000001';
  v_n integer;
  v_missing text;
BEGIN
  -- Every target exists, once, as an active Midway event.
  SELECT string_agg(t.name, ', ') INTO v_missing
    FROM unnest(ARRAY[
      'Union Mystery Bounty (PLO5)', 'Union Grand Championship (NLH)', 'Monday Knockout',
      'Tuesday Bounty Hunt', 'Friday Five-Card Bounty', 'Friday Fight Night PKO',
      'Saturday Mystery', 'Saturday Stackfest PKO', 'Sunday Funday Bounty Builder',
      'Sunday Funday PLO PKO', 'Sunday Funday PLO5 Mystery', 'Sunday Funday Mystery',
      'Sunday Funday Late PKO', 'Sunday Funday High Roller PKO', 'Sunday Funday Night Owl'
    ]) AS t(name)
   WHERE (SELECT count(*) FROM public.tournament_schedules s
           WHERE s.active AND s.club_id = c_midway AND s.name = t.name
             AND COALESCE(s.config->>'type', '') <> 'satellite') <> 1;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'satellite targets not found exactly once in the Midway Union: %', v_missing;
  END IF;

  INSERT INTO public.tournament_schedules
    (club_id, union_id, name, description, active, days_of_week, start_times_utc, time_zone, config)
  SELECT c_midway, c_midway, sat.name, 'Satellite', true, sat.days, sat.times, 'America/Chicago',
         jsonb_build_object(
           'name', sat.name, 'type', 'satellite', 'satelliteTargetName', sat.target,
           'buyIn', sat.buy_in, 'satelliteSeats', 1, 'gameVariant', sat.variant,
           'tableSize', CASE sat.variant WHEN 'plo5' THEN 8 WHEN 'plo6' THEN 7 ELSE 9 END,
           'startingStack', sat.stack, 'blindPreset', sat.preset,
           'lateRegistrationLevels', sat.late_reg, 'payoutPreset', 'FIVE',
           'maxPlayers', 200, 'minPlayers', 4, 'banChat', true, 'horsesToRegister', 0,
           'shortDescription', 'Win A Seat In The ' || sat.target || '. 1 Seat Guaranteed.')
    FROM (VALUES
      ('PLO5 Mystery Bounty Satellite 5', 'Union Mystery Bounty (PLO5)', ARRAY[1, 2, 3, 4, 5, 6], ARRAY['11:45'], 5, 'plo5', 8000, 'TURBO', 4),
      ('Grand Championship Satellite 10', 'Union Grand Championship (NLH)', ARRAY[1, 2, 3, 4, 5, 6], ARRAY['13:45'], 10, 'nlh', 10000, 'STANDARD', 5),
      ('Knockout Satellite 5', 'Monday Knockout', ARRAY[1], ARRAY['19:15'], 5, 'nlh', 8000, 'TURBO', 4),
      ('Bounty Hunt Satellite 5', 'Tuesday Bounty Hunt', ARRAY[2], ARRAY['19:15'], 5, 'nlh', 8000, 'TURBO', 4),
      ('Friday PLO5 Bounty Satellite 5', 'Friday Five-Card Bounty', ARRAY[5], ARRAY['16:45'], 5, 'plo5', 8000, 'TURBO', 4),
      ('Fight Night PKO Satellite 5', 'Friday Fight Night PKO', ARRAY[5], ARRAY['19:15'], 5, 'nlh', 8000, 'TURBO', 4),
      ('Saturday Night Mystery Satellite 5', 'Saturday Mystery', ARRAY[6], ARRAY['16:45'], 5, 'nlh', 8000, 'TURBO', 4),
      ('Stackfest PKO Satellite 5', 'Saturday Stackfest PKO', ARRAY[6], ARRAY['19:15'], 5, 'nlh', 8000, 'TURBO', 4),
      ('Funday Bounty Builder Satellite 10', 'Sunday Funday Bounty Builder', ARRAY[6], ARRAY['20:45'], 10, 'nlh', 10000, 'STANDARD', 5),
      ('Funday PLO PKO Satellite 10', 'Sunday Funday PLO PKO', ARRAY[6], ARRAY['18:45'], 10, 'plo4', 10000, 'STANDARD', 5),
      ('Funday PLO5 Mystery Satellite 10', 'Sunday Funday PLO5 Mystery', ARRAY[6], ARRAY['22:15'], 10, 'plo5', 10000, 'STANDARD', 5),
      ('Funday Mystery Satellite 10', 'Sunday Funday Mystery', ARRAY[0], ARRAY['15:45'], 10, 'nlh', 10000, 'STANDARD', 5),
      ('Funday Late PKO Satellite 10', 'Sunday Funday Late PKO', ARRAY[0], ARRAY['17:15'], 10, 'nlh', 10000, 'STANDARD', 5),
      ('Funday High Roller PKO Satellite 15', 'Sunday Funday High Roller PKO', ARRAY[0], ARRAY['18:45'], 15, 'nlh', 10000, 'STANDARD', 5),
      ('Funday Night Owl Satellite 5', 'Sunday Funday Night Owl', ARRAY[0], ARRAY['19:15'], 5, 'nlh', 8000, 'TURBO', 4)
    ) AS sat(name, target, days, times, buy_in, variant, stack, preset, late_reg);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 15 THEN RAISE EXCEPTION 'expected 15 new satellite schedules, inserted %', v_n; END IF;

  -- Satellites only on the :15 and :45, one per day and slot.
  SELECT count(*) INTO v_n
    FROM public.tournament_schedules s, unnest(s.start_times_utc) t
   WHERE s.active AND s.club_id = c_midway AND s.config->>'type' = 'satellite'
     AND right(t, 2) NOT IN ('15', '45');
  IF v_n > 0 THEN RAISE EXCEPTION 'Midway has % satellite starts off the :15 and :45', v_n; END IF;
  SELECT count(*) INTO v_n FROM (
    SELECT d, t
      FROM public.tournament_schedules s, unnest(s.days_of_week) d, unnest(s.start_times_utc) t
     WHERE s.active AND s.club_id = c_midway AND s.config->>'type' = 'satellite'
     GROUP BY d, t HAVING count(*) > 1) dup;
  IF v_n > 0 THEN RAISE EXCEPTION 'Midway has % doubled satellite starts', v_n; END IF;

  -- No satellite name begins with its target's name.
  SELECT count(*) INTO v_n
    FROM public.tournament_schedules s
   WHERE s.active AND s.club_id = c_midway AND s.config->>'type' = 'satellite'
     AND s.name LIKE (s.config->>'satelliteTargetName') || '%';
  IF v_n > 0 THEN RAISE EXCEPTION 'Midway has % satellites named like their target', v_n; END IF;

  -- Every active Midway event of 25 or more now has a satellite into it.
  SELECT string_agg(e.name, ', ') INTO v_missing
    FROM public.tournament_schedules e
   WHERE e.active AND e.club_id = c_midway
     AND COALESCE(e.config->>'type', '') NOT IN ('fixed_board', 'satellite')
     AND e.config->>'fixedBoard' IS NULL
     AND (e.config->>'buyIn')::numeric >= 25
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_schedules s
        WHERE s.active AND s.club_id = c_midway AND s.config->>'type' = 'satellite'
          AND e.name LIKE (s.config->>'satelliteTargetName') || '%');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Midway events of 25 or more with no satellite: %', v_missing;
  END IF;
END $$;

COMMIT;
