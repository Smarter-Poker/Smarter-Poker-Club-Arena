-- ═════════════════════════════════════════════════════════════════════════════
-- THE SUNDAY $200 DEEP STACK, AND THE SATELLITES THAT FEED IT ALL WEEK
-- Dan 2026-08-26
-- ═════════════════════════════════════════════════════════════════════════════
--
-- "ADD IN A SUNDAY $200 12PM STARTING STACK DEEP STACK, 30K STARTING CHIPS,
--  10 MIN LEVELS, REBUYS FOR THE FIRST 12 LEVELS, AND RUN SATELITES INTO THIS
--  EVENT THROUGHOUT THE WHOLE WEEK. ANY WHERE FROM $5, TO $25 SATELITES THAT
--  AWARD SEATS INTO THIS EVENT."
--
-- THE CLOCK. `start_times_utc` is UTC and this room runs on UTC-5: the
-- existing "$100 Freeroll - 12:00 PM" is stored as 17:00, and the midnight one
-- as 05:00. So 12:00 PM Sunday is 17:00 UTC on Sunday, and Sunday is still
-- day 0 at that instant (17:00 UTC does not cross midnight), which is why
-- days_of_week is {0} and not {1}.
--
-- THE STRUCTURE. 20 levels, every one of them 10 minutes, written out
-- explicitly rather than borrowed from a preset -- none of SLOW / STANDARD /
-- TURBO is uniformly 10 minutes, and "10 MIN LEVELS" is the ask. The ramp is
-- deliberately gentle through level 12 because that is where rebuys close: at
-- level 12 the big blind is 1,200, so a fresh 30,000 rebuy is 25 big blinds
-- and still a playable stack. A stock preset reaches that depth around level
-- 9, which would have sold people a rebuy that was already a short stack.
-- Starting depth is 600bb.
--
-- WHY THE MAIN EVENT CARRIES spawnAheadMinutes 10080 (7 days). A satellite
-- resolves its target BY NAME against tournaments that already EXIST
-- (ScheduledTournamentService.resolveSatelliteTarget: status ANNOUNCED or
-- REGISTERING, start_time in the future). Satellites run every day, so the
-- Sunday event has to be on the board for the whole week ahead of it -- a
-- Monday satellite is looking six and a half days forward. The house window
-- for a $200 event is 6 days, which is NOT enough, and this is precisely the
-- case the per-schedule override exists for. It still works because the
-- override RAISES the floor (see spawnAheadMsFor); a week is longer than six
-- days, so a week wins.
--
-- NO GUARANTEE IS SET, deliberately. A guaranteed prize pool is a financial
-- commitment and nobody asked for one; the field decides the prize pool.
-- Add `guaranteedPrize` to the config if the room wants to advertise one.
--
-- SATELLITE ECONOMICS, each sized to break even at a full field rather than
-- to a number that looked good:
--   $5  x 200 seats = $1,000 -> 5 seats at $200
--   $10 x 100 seats = $1,000 -> 5 seats at $200
--   $25 x  40 seats = $1,000 -> 5 seats at $200
--
-- IDEMPOTENT: re-runnable end to end. Deletes by name first, because
-- tournament_schedules has no unique constraint on name.

DO $$
DECLARE
  v_club uuid := 'fade0000-0000-0000-0000-000000000001';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clubs WHERE id = v_club AND is_union) THEN
    RAISE EXCEPTION 'Midway Union % is missing or is not a union - refusing to attach schedules to it', v_club;
  END IF;
END $$;

DELETE FROM public.tournament_schedules
WHERE club_id = 'fade0000-0000-0000-0000-000000000001'
  AND name IN (
    'Sunday $200 Deep Stack',
    'Sunday Deep Stack Satellite $5',
    'Sunday Deep Stack Satellite $10',
    'Sunday Deep Stack Satellite $25'
  );

INSERT INTO public.tournament_schedules
  (union_id, club_id, name, description, active, days_of_week, start_times_utc, interval_minutes, config)
SELECT k.mid, k.mid, v.name, v.descr, true, v.dow, v.times, v.intv, v.cfg::jsonb
FROM (VALUES

  ('Sunday $200 Deep Stack',
   'The Sunday flagship. 30,000 chips, 10 minute levels, rebuys through level 12.',
   '{0}'::int[], '{17:00}'::text[], NULL::int,
   '{"name":"Sunday $200 Deep Stack","type":"mtt","gameVariant":"nlh","buyIn":200,"startingStack":30000,"maxPlayers":1000,"minPlayers":4,"tableSize":9,"blindStructure":[{"level":1,"smallBlind":25,"bigBlind":50,"ante":0,"durationMinutes":10},{"level":2,"smallBlind":50,"bigBlind":100,"ante":0,"durationMinutes":10},{"level":3,"smallBlind":75,"bigBlind":150,"ante":150,"durationMinutes":10},{"level":4,"smallBlind":100,"bigBlind":200,"ante":200,"durationMinutes":10},{"level":5,"smallBlind":125,"bigBlind":250,"ante":250,"durationMinutes":10},{"level":6,"smallBlind":150,"bigBlind":300,"ante":300,"durationMinutes":10},{"level":7,"smallBlind":200,"bigBlind":400,"ante":400,"durationMinutes":10},{"level":8,"smallBlind":250,"bigBlind":500,"ante":500,"durationMinutes":10},{"level":9,"smallBlind":300,"bigBlind":600,"ante":600,"durationMinutes":10},{"level":10,"smallBlind":400,"bigBlind":800,"ante":800,"durationMinutes":10},{"level":11,"smallBlind":500,"bigBlind":1000,"ante":1000,"durationMinutes":10},{"level":12,"smallBlind":600,"bigBlind":1200,"ante":1200,"durationMinutes":10},{"level":13,"smallBlind":800,"bigBlind":1600,"ante":1600,"durationMinutes":10},{"level":14,"smallBlind":1000,"bigBlind":2000,"ante":2000,"durationMinutes":10},{"level":15,"smallBlind":1200,"bigBlind":2400,"ante":2400,"durationMinutes":10},{"level":16,"smallBlind":1500,"bigBlind":3000,"ante":3000,"durationMinutes":10},{"level":17,"smallBlind":2000,"bigBlind":4000,"ante":4000,"durationMinutes":10},{"level":18,"smallBlind":2500,"bigBlind":5000,"ante":5000,"durationMinutes":10},{"level":19,"smallBlind":3000,"bigBlind":6000,"ante":6000,"durationMinutes":10},{"level":20,"smallBlind":4000,"bigBlind":8000,"ante":8000,"durationMinutes":10}],"payoutPreset":"NINE","isRebuy":true,"rebuyCost":200,"rebuyChips":30000,"rebuyLevels":12,"lateRegistrationLevels":12,"bigBlindAnte":true,"actionTimeSeconds":20,"finalTableDealEnabled":true,"bubbleProtection":true,"isFeatured":true,"spawnAheadMinutes":10080,"shortDescription":"30,000 Starting Chips. 10 Minute Levels. Rebuys Through Level 12. Satellites Run All Week.","horsesToRegister":0}'),

  ('Sunday Deep Stack Satellite $5',
   'Cheapest road in. Turbo, twice a day, every day.',
   '{0,1,2,3,4,5,6}', '{01:00,19:00}', NULL,
   '{"name":"Sunday Deep Stack Satellite $5","type":"satellite","gameVariant":"nlh","buyIn":5,"startingStack":8000,"maxPlayers":200,"minPlayers":4,"tableSize":9,"blindPreset":"TURBO","payoutPreset":"FIVE","lateRegistrationLevels":4,"satelliteTargetName":"Sunday $200 Deep Stack","satelliteSeats":5,"shortDescription":"Win A Seat In The Sunday $200 Deep Stack. 5 Seats Guaranteed.","horsesToRegister":0}'),

  ('Sunday Deep Stack Satellite $10',
   'Mid-price satellite, once a day, every day.',
   '{0,1,2,3,4,5,6}', '{23:00}', NULL,
   '{"name":"Sunday Deep Stack Satellite $10","type":"satellite","gameVariant":"nlh","buyIn":10,"startingStack":10000,"maxPlayers":100,"minPlayers":4,"tableSize":9,"blindPreset":"STANDARD","payoutPreset":"FIVE","lateRegistrationLevels":5,"satelliteTargetName":"Sunday $200 Deep Stack","satelliteSeats":5,"shortDescription":"Win A Seat In The Sunday $200 Deep Stack. 5 Seats Guaranteed.","horsesToRegister":0}'),

  ('Sunday Deep Stack Satellite $25',
   'Shortest road in. Forty runners fund five seats.',
   '{0,1,2,3,4,5,6}', '{15:00}', NULL,
   '{"name":"Sunday Deep Stack Satellite $25","type":"satellite","gameVariant":"nlh","buyIn":25,"startingStack":12000,"maxPlayers":40,"minPlayers":4,"tableSize":9,"blindPreset":"STANDARD","payoutPreset":"FIVE","lateRegistrationLevels":6,"satelliteTargetName":"Sunday $200 Deep Stack","satelliteSeats":5,"shortDescription":"Win A Seat In The Sunday $200 Deep Stack. 5 Seats Guaranteed.","horsesToRegister":0}')

) AS v(name, descr, dow, times, intv, cfg)
CROSS JOIN (SELECT 'fade0000-0000-0000-0000-000000000001'::uuid AS mid) k;

-- ── POST-APPLY ASSERTIONS ───────────────────────────────────────────────────

DO $$
DECLARE
  v_main    jsonb;
  v_sats    integer;
  v_badlvl  integer;
BEGIN
  SELECT config INTO v_main FROM public.tournament_schedules
  WHERE name = 'Sunday $200 Deep Stack' AND active;
  IF v_main IS NULL THEN
    RAISE EXCEPTION 'the Sunday $200 Deep Stack was not created';
  END IF;

  IF (v_main->>'buyIn')::numeric <> 200 THEN
    RAISE EXCEPTION 'buy-in is %, expected 200', v_main->>'buyIn';
  END IF;
  IF (v_main->>'startingStack')::numeric <> 30000 THEN
    RAISE EXCEPTION 'starting stack is %, expected 30000', v_main->>'startingStack';
  END IF;
  IF (v_main->>'rebuyLevels')::numeric <> 12 THEN
    RAISE EXCEPTION 'rebuy levels is %, expected 12', v_main->>'rebuyLevels';
  END IF;

  -- EVERY level is 10 minutes. This is the ask that a preset could not meet,
  -- so it is the one worth asserting.
  SELECT count(*) INTO v_badlvl
  FROM jsonb_array_elements(v_main->'blindStructure') lv
  WHERE (lv->>'durationMinutes')::numeric <> 10;
  IF v_badlvl > 0 THEN
    RAISE EXCEPTION '% blind level(s) are not 10 minutes', v_badlvl;
  END IF;

  -- A rebuy on the last legal level must still be a real stack.
  IF (SELECT 30000 / (lv->>'bigBlind')::numeric
      FROM jsonb_array_elements(v_main->'blindStructure') lv
      WHERE (lv->>'level')::numeric = 12) < 25 THEN
    RAISE EXCEPTION 'a level-12 rebuy would be under 25 big blinds';
  END IF;

  -- The week-long look-ahead is what lets satellites find this event at all.
  IF (v_main->>'spawnAheadMinutes')::numeric < 10080 THEN
    RAISE EXCEPTION 'spawnAheadMinutes is % - satellites cannot resolve a target that is not on the board yet', v_main->>'spawnAheadMinutes';
  END IF;

  -- Every satellite must point at a target whose name actually exists,
  -- otherwise resolveSatelliteTarget silently skips every spawn forever.
  SELECT count(*) INTO v_sats
  FROM public.tournament_schedules s
  WHERE s.active
    AND s.config->>'type' = 'satellite'
    AND s.config->>'satelliteTargetName' = 'Sunday $200 Deep Stack';
  IF v_sats <> 3 THEN
    RAISE EXCEPTION 'expected 3 satellites feeding the Deep Stack, found %', v_sats;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_schedules s
    WHERE s.active AND s.config->>'type' = 'satellite'
      AND s.config->>'satelliteTargetName' = 'Sunday $200 Deep Stack'
      AND NOT EXISTS (
        SELECT 1 FROM public.tournament_schedules t
        WHERE t.active AND t.name = s.config->>'satelliteTargetName'
      )
  ) THEN
    RAISE EXCEPTION 'a satellite points at a target schedule that does not exist';
  END IF;
END $$;

-- ROLLBACK
--   DELETE FROM public.tournament_schedules
--   WHERE name IN ('Sunday $200 Deep Stack','Sunday Deep Stack Satellite $5',
--                  'Sunday Deep Stack Satellite $10','Sunday Deep Stack Satellite $25');
