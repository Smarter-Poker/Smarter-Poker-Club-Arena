-- A REAL ROOM'S DAY (Dan, 2026-10-16). The clubs' own weekly events, the
-- Sunday Funday series, the Nightly 10K and every satellite, for the Midway
-- Union and the Diamond Arena. The daily board is in the engine
-- (server/src/config/fixedBoard.ts); this is everything else.
--
-- Dan, verbatim:
--   "WHY THE FUCK DO WE HAVE A TOURNAMENT EVERY 20 MINUTES IN THE MIDDLE OF
--    THE NIGHT, LOOK AT REAL ONLINE POKER SCHEDULES FROM THE TOP SITES"
--   "WE NEED A DAILY 7PM TOURNAMENT THAT IS A 35 REBUY ADD ON WITH A 10K
--    GUARANTEE MONDAY - SATURDAY. DOUBLE ALL THE OTHER CURRENT GUARANTEES,
--    THEN ROUND THEM ALL UP TO THE NEAREST 1000 OR 500. NO 25 75 OR 50 AMOUNTS."
--   "SATELLITES ARE NEVER 'PRIME TOURNAMENTS'. YOU SHOULD ALWAYS HAVE A REAL
--    TOURNAMENT RUNNING IN THOSE SPOTS, ALL SATELLITES SHOULD START AT THE :15
--    OR :45. EVERY TOURNAMENT WITH A 25 BUY IN OR HIGHER SHOULD HAVE
--    SATELLITES INTO IT."
--   "TOURNAMENTS FROM 6PM -10PM SHOULD BE LARGER BUY IN, AND SUNDAY SHOULD BE
--    JAM PACKED FROM 11AM TO 11PM WITH TOURNAMENTS, BIGGER BUY IN'S BIGGER
--    GUARANTEES."
--
-- What this does, in both clubs:
--   1. Retires the four "100 Guarantee Freerolls" a day. The board keeps the
--      five Free Buys (8:30 AM, 12:30 PM, 4:30 PM, 8:30 PM, 12:30 AM) and the
--      Coffee Break Freeroll.
--   2. Moves the weekly events onto the half hours the board leaves them:
--      8:20 PM -> 8 PM (8:30 PM is the Prime Time Free Buy), the 2:40 AM
--      graveyards -> 1 AM, and the 7 PM openers -> 7:30 PM (7 PM is the
--      Nightly 10K, Monday to Saturday). The Sunday Deep Stack satellites move
--      onto the :15 and :45.
--   3. Doubles every weekly guarantee and rounds it up to the next 500. An
--      event with no guarantee gets 500, the smallest amount the rule allows.
--   4. Prices every weekly event that starts between 6 PM and 10 PM at 22 or
--      more (33 on the marquee nights), its bounty and guarantee scaled with
--      it and the guarantee rounded up to the next 500.
--   5. Adds the Nightly 10K (NLH), Monday to Saturday at 7 PM: 35 to enter,
--      35 rebuys and one 35 add-on, 10,000 guaranteed.
--   6. Fills Sunday from 11 AM to 11 PM: on Sunday the board leaves those half
--      hours to the Sunday Funday series, fourteen new events from 22 to 109
--      with guarantees from 2,000 to 7,500, plus the 7:30 PM PLO Opener.
--   7. Adds satellites on the :15 and :45 into every event of 25 or more whose
--      finish can seat a satellite winner. Bounty, PKO and mystery events are
--      refused by the satellite settlement today (a seat booked as prize would
--      seed an unfunded bounty head) and get theirs with that change. The
--      engine's rolling feeder stands down for these two clubs in the same
--      release. Satellite names never begin with their target's name, because
--      the scheduler finds a target by name prefix and would otherwise find the
--      satellite itself.
--
-- Times move without doubling a date: a moved row records the times it had
-- (previousStartTimes) and, if it had moved before, the timetable before that
-- (retiredStartTimes). A date already on the board keeps what it has; a date
-- that ran on the retired timetable takes nothing more. The 8 PM moves take
-- effect from 2026-10-16 because their retired 8 PM is their new time, and
-- today already ran at 8 PM. Every new event carries an empty
-- previousStartTimes and starts on 2026-10-20, the first date the new
-- timetable owns outright. The engine that reads these keys must be serving
-- before this is applied.
--
-- No DDL. One transaction.

-- @live-proof: (SELECT (SELECT count(*) FROM public.tournament_schedules s WHERE s.active AND s.name = 'Nightly 10K (NLH)' AND s.club_id IN ('fade0000-0000-0000-0000-000000000001', '002c2d27-9584-4e52-835a-bb2be148fc81')) = 2 AND NOT EXISTS (SELECT 1 FROM public.tournament_schedules s WHERE s.active AND s.name LIKE '100 % Guarantee Freeroll%' AND s.club_id IN ('fade0000-0000-0000-0000-000000000001', '002c2d27-9584-4e52-835a-bb2be148fc81')))
BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  c_midway CONSTANT uuid := 'fade0000-0000-0000-0000-000000000001';
  c_arena  CONSTANT uuid := '002c2d27-9584-4e52-835a-bb2be148fc81';
  v_n integer;
  v_slots text[];
  v_club uuid;
BEGIN
  -- 1. The 100 Guarantee Freerolls.
  UPDATE public.tournament_schedules
     SET active = false, updated_at = now()
   WHERE active
     AND club_id IN (c_midway, c_arena)
     AND (name LIKE '100 Chip Guarantee Freeroll%' OR name LIKE '100 Diamond Guarantee Freeroll%');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 8 THEN
    RAISE EXCEPTION 'expected to retire 8 freeroll schedules, found %', v_n;
  END IF;

  -- 2. Times.
  WITH moves(name, new_times, effective_from) AS (
    VALUES
      ('Five-Card Big Stack', ARRAY['20:00'], '2026-10-16'),
      ('PLO8 Hi-Lo Turbo', ARRAY['20:00'], '2026-10-16'),
      ('Midweek Bounty', ARRAY['20:00'], '2026-10-16'),
      ('Five-Card Bounty', ARRAY['20:00'], '2026-10-16'),
      ('Friday Five-Card Bounty', ARRAY['20:00'], '2026-10-16'),
      ('Saturday Mystery', ARRAY['20:00'], '2026-10-16'),
      ('Sunday Funday Mystery', ARRAY['20:00'], '2026-10-16'),
      ('Monday Graveyard PLO', ARRAY['01:00'], '2026-10-17'),
      ('Turbo Tuesday Graveyard', ARRAY['01:00'], '2026-10-17'),
      ('Midweek Five-Card Graveyard', ARRAY['01:00'], '2026-10-17'),
      ('Omaha Thursday Graveyard', ARRAY['01:00'], '2026-10-17'),
      ('Friday Graveyard', ARRAY['01:00'], '2026-10-17'),
      ('Saturday Graveyard PLO', ARRAY['01:00'], '2026-10-17'),
      ('Sunday Funday Graveyard', ARRAY['01:00'], '2026-10-17'),
      ('Monday Night Turbo', ARRAY['19:30'], '2026-10-17'),
      ('Turbo Tuesday Opener', ARRAY['19:30'], '2026-10-17'),
      ('Wednesday PLO Stack', ARRAY['19:30'], '2026-10-17'),
      ('Omaha Thursday Opener', ARRAY['19:30'], '2026-10-17'),
      ('Friday Fight Night Opener', ARRAY['19:30'], '2026-10-17'),
      ('Saturday Stackfest Opener', ARRAY['19:30'], '2026-10-17'),
      ('Sunday Deep Stack Satellite 25', ARRAY['11:15'], '2026-10-17'),
      ('Sunday Deep Stack Satellite 10', ARRAY['17:45'], '2026-10-17'),
      ('Sunday Deep Stack Satellite 5', ARRAY['13:15', '20:15'], '2026-10-17')
  ),
  planned AS (
    SELECT s.id,
           m.new_times,
           m.effective_from,
           s.start_times_utc AS old_times,
           (SELECT jsonb_agg(t ORDER BY t)
              FROM jsonb_array_elements_text(COALESCE(s.config->'previousStartTimes', '[]'::jsonb)) t
             WHERE t <> ALL (s.start_times_utc) AND t <> ALL (m.new_times)) AS retired
      FROM public.tournament_schedules s
      JOIN moves m ON m.name = s.name
     WHERE s.active
       AND s.club_id IN (c_midway, c_arena)
       AND COALESCE(s.config->>'type', '') <> 'fixed_board'
       AND s.config->>'fixedBoard' IS NULL
  )
  UPDATE public.tournament_schedules s
     SET start_times_utc = p.new_times,
         config = (s.config - 'retiredStartTimes')
                  || jsonb_build_object(
                       'previousStartTimes', to_jsonb(p.old_times),
                       'startTimesEffectiveFrom', p.effective_from)
                  || CASE WHEN p.retired IS NULL THEN '{}'::jsonb
                          ELSE jsonb_build_object('retiredStartTimes', p.retired) END,
         updated_at = now()
    FROM planned p
   WHERE s.id = p.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 46 THEN
    RAISE EXCEPTION 'expected to move 46 schedules (23 in each club), moved %', v_n;
  END IF;

  -- 3. Guarantees: doubled, rounded up to the next 500; none becomes 500.
  UPDATE public.tournament_schedules s
     SET config = (s.config - 'guarantee')
                  || jsonb_build_object(
                       'guaranteedPrize',
                       CASE
                         WHEN COALESCE(NULLIF(s.config->>'guaranteedPrize', '')::numeric,
                                       NULLIF(s.config->>'guarantee', '')::numeric, 0) <= 0 THEN 500
                         ELSE (ceil(2 * COALESCE(NULLIF(s.config->>'guaranteedPrize', '')::numeric,
                                                 NULLIF(s.config->>'guarantee', '')::numeric) / 500) * 500)::integer
                       END),
         updated_at = now()
   WHERE s.active
     AND s.club_id IN (c_midway, c_arena)
     AND COALESCE(s.config->>'type', '') NOT IN ('fixed_board', 'satellite')
     AND s.config->>'fixedBoard' IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 112 THEN
    RAISE EXCEPTION 'expected to reprice 112 weekly events (56 in each club), repriced %', v_n;
  END IF;

  -- 4. 6 PM to 10 PM costs more. The bounty keeps its share of the entry, and
  --    the guarantee grows with the buy-in, rounded up to the next 500.
  WITH prime(name, buy_in) AS (
    VALUES
      ('Monday Night Turbo', 22), ('Turbo Tuesday Opener', 22), ('Wednesday PLO Stack', 22),
      ('Omaha Thursday Opener', 22), ('Friday Fight Night Opener', 33), ('Saturday Stackfest Opener', 33),
      ('Five-Card Big Stack', 22), ('PLO8 Hi-Lo Turbo', 22), ('Midweek Bounty', 22),
      ('Five-Card Bounty', 22), ('Friday Five-Card Bounty', 33), ('Saturday Mystery', 33),
      ('Monday Knockout', 33), ('Tuesday Bounty Hunt', 33), ('Wednesday Feature', 33),
      ('Six-Card Feature', 33),
      ('Monday Mystery', 22), ('Turbo Tuesday PKO', 22), ('Midweek Mystery', 22),
      ('Thursday Night PKO', 22), ('Friday Fight Night PKO', 33)
  )
  UPDATE public.tournament_schedules s
     SET config = s.config
                  || jsonb_build_object(
                       'buyIn', p.buy_in,
                       'guaranteedPrize',
                       (ceil((s.config->>'guaranteedPrize')::numeric * p.buy_in
                             / (s.config->>'buyIn')::numeric / 500) * 500)::integer)
                  || CASE WHEN s.config ? 'bountyAmount'
                          THEN jsonb_build_object('bountyAmount',
                                 round((s.config->>'bountyAmount')::numeric * p.buy_in
                                       / (s.config->>'buyIn')::numeric, 2))
                          ELSE '{}'::jsonb END,
         updated_at = now()
    FROM prime p
   WHERE s.active
     AND s.club_id IN (c_midway, c_arena)
     AND s.name = p.name
     AND COALESCE(s.config->>'type', '') NOT IN ('fixed_board', 'satellite')
     AND (s.config->>'buyIn')::numeric < p.buy_in;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 42 THEN
    RAISE EXCEPTION 'expected to raise 42 prime-time buy-ins (21 in each club), raised %', v_n;
  END IF;

  -- 5 and 6. The Nightly 10K, and the Sunday Funday series.
  INSERT INTO public.tournament_schedules
    (club_id, union_id, name, description, active, days_of_week, start_times_utc, time_zone, config)
  SELECT club.id, club.union_id, ev.name, ev.description, true, ev.days, ARRAY[ev.at], 'America/Chicago',
         jsonb_build_object(
           'name', ev.name, 'type', ev.kind, 'gameVariant', ev.variant, 'buyIn', ev.buy_in,
           'startingStack', ev.stack, 'blindPreset', ev.preset, 'bigBlindAnte', true,
           'lateRegistrationLevels', ev.late_reg, 'payoutPreset', 'NINE', 'tableSize', ev.seats,
           'maxPlayers', 1000, 'minPlayers', 4, 'banChat', true, 'horsesToRegister', 0,
           'guaranteedPrize', ev.guarantee,
           'previousStartTimes', '[]'::jsonb, 'startTimesEffectiveFrom', '2026-10-20',
           'shortDescription', to_char(ev.guarantee, 'FM999,999') || ' Guaranteed. '
                               || to_char(ev.stack, 'FM999,999') || ' Starting Chips.')
         || CASE WHEN ev.bounty > 0 THEN jsonb_build_object('bountyAmount', ev.bounty) ELSE '{}'::jsonb END
         || CASE WHEN ev.kind = 'mystery_bounty'
                 THEN jsonb_build_object('mysteryBountyMin', 0.5, 'mysteryBountyMax', 10) ELSE '{}'::jsonb END
         || CASE WHEN ev.rebuy
                 THEN jsonb_build_object('isRebuy', true, 'rebuyCost', ev.buy_in, 'rebuyChips', ev.stack,
                        'rebuyLevels', ev.late_reg, 'addOnAvailable', true, 'addonCost', ev.buy_in,
                        'addonChips', ev.stack + ev.stack / 2, 'isFeatured', true)
                 ELSE '{}'::jsonb END
    FROM (VALUES (c_midway, c_midway), (c_arena, NULL::uuid)) AS club(id, union_id)
   CROSS JOIN (VALUES
      ('Nightly 10K (NLH)', 'The Nightly 10K', ARRAY[1, 2, 3, 4, 5, 6], '19:00', 'mtt', 'nlh', 35, 0, 20000, 'DEEPSTACK', 9, 9, 10000, true),
      ('Sunday Funday Kickoff', 'Sunday Funday', ARRAY[0], '11:00', 'mtt', 'nlh', 22, 0, 15000, 'STANDARD', 8, 9, 2000, false),
      ('Sunday Funday PLO Classic', 'Sunday Funday', ARRAY[0], '11:30', 'mtt', 'plo4', 33, 0, 20000, 'DEEPSTACK', 9, 9, 3000, false),
      ('Sunday Funday Turbo', 'Sunday Funday', ARRAY[0], '12:00', 'mtt', 'nlh', 33, 0, 15000, 'TURBO', 8, 9, 3000, false),
      ('Sunday Funday Bounty Builder', 'Sunday Funday', ARRAY[0], '13:30', 'bounty', 'nlh', 55, 20, 25000, 'STANDARD', 9, 9, 5000, false),
      ('Sunday Funday PLO PKO', 'Sunday Funday', ARRAY[0], '14:00', 'progressive_bounty', 'plo4', 55, 25, 25000, 'STANDARD', 9, 9, 5000, false),
      ('Sunday Funday Big Stack', 'Sunday Funday', ARRAY[0], '14:30', 'mtt', 'nlh', 55, 0, 40000, 'DEEPSTACK', 10, 9, 5000, false),
      ('Sunday Funday PLO5 Mystery', 'Sunday Funday', ARRAY[0], '15:30', 'mystery_bounty', 'plo5', 55, 20, 25000, 'STANDARD', 9, 8, 5000, false),
      ('Sunday Funday Six-Max', 'Sunday Funday', ARRAY[0], '16:00', 'mtt', 'nlh', 33, 0, 20000, 'STANDARD', 9, 6, 3000, false),
      ('Sunday Funday Championship', 'Sunday Funday', ARRAY[0], '17:00', 'mtt', 'nlh', 77, 0, 40000, 'DEEPSTACK', 10, 9, 7500, false),
      ('Sunday Funday Happy Hour', 'Sunday Funday', ARRAY[0], '17:30', 'mtt', 'nlh', 33, 0, 20000, 'TURBO', 8, 9, 3000, false),
      ('Sunday Funday Prime Time', 'Sunday Funday', ARRAY[0], '18:00', 'mtt', 'nlh', 55, 0, 25000, 'STANDARD', 9, 9, 7500, true),
      ('Sunday Funday PLO High Roller', 'Sunday Funday', ARRAY[0], '18:30', 'mtt', 'plo4', 109, 0, 40000, 'DEEPSTACK', 10, 9, 7500, false),
      ('Sunday Funday PLO Opener', 'Sunday Funday', ARRAY[0], '19:30', 'mtt', 'plo4', 33, 0, 20000, 'DEEPSTACK', 9, 9, 3000, false),
      ('Sunday Funday Late PKO', 'Sunday Funday', ARRAY[0], '21:30', 'progressive_bounty', 'nlh', 55, 25, 25000, 'STANDARD', 9, 9, 5000, false),
      ('Sunday Funday Night Owl', 'Sunday Funday', ARRAY[0], '22:30', 'bounty', 'nlh', 33, 8, 20000, 'TURBO', 8, 9, 3000, false)
   ) AS ev(name, description, days, at, kind, variant, buy_in, bounty, stack, preset, late_reg, seats, guarantee, rebuy);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 32 THEN RAISE EXCEPTION 'expected 32 new events (16 in each club), inserted %', v_n; END IF;

  -- 7. Satellites, on the :15 and :45 only.
  INSERT INTO public.tournament_schedules
    (club_id, union_id, name, description, active, days_of_week, start_times_utc, time_zone, config)
  SELECT club.id, club.union_id, sat.name, 'Satellite', true, sat.days, sat.times, 'America/Chicago',
         jsonb_build_object(
           'name', sat.name, 'type', 'satellite', 'satelliteTargetName', sat.target,
           'buyIn', sat.buy_in, 'satelliteSeats', 1, 'gameVariant', sat.variant,
           'tableSize', CASE sat.variant WHEN 'plo5' THEN 8 WHEN 'plo6' THEN 7 ELSE 9 END,
           'startingStack', sat.stack, 'blindPreset', sat.preset,
           'lateRegistrationLevels', sat.late_reg, 'payoutPreset', 'FIVE',
           'maxPlayers', 200, 'minPlayers', 4, 'banChat', true, 'horsesToRegister', 0,
           'shortDescription', 'Win A Seat In The ' || sat.target || '. 1 Seat Guaranteed.')
    FROM (VALUES (c_midway, c_midway), (c_arena, NULL::uuid)) AS club(id, union_id)
   CROSS JOIN (VALUES
      ('Prime Time Satellite 3', 'Prime Time Main Event', ARRAY[1, 2, 3, 4, 5, 6], ARRAY['14:15'], 3, 'nlh', 8000, 'TURBO', 4),
      ('Prime Time Satellite 10', 'Prime Time Main Event', ARRAY[1, 2, 3, 4, 5, 6], ARRAY['15:45'], 10, 'nlh', 10000, 'STANDARD', 5),
      ('Nightly 10K Satellite 5', 'Nightly 10K (NLH)', ARRAY[1, 2, 3, 4, 5, 6], ARRAY['14:45'], 5, 'nlh', 8000, 'TURBO', 4),
      ('Nightly 10K Satellite 15', 'Nightly 10K (NLH)', ARRAY[1, 2, 3, 4, 5, 6], ARRAY['16:15'], 15, 'nlh', 10000, 'STANDARD', 5),
      ('Fight Night Opener Satellite 5', 'Friday Fight Night Opener', ARRAY[5], ARRAY['15:15'], 5, 'nlh', 8000, 'TURBO', 4),
      ('Stackfest Opener Satellite 5', 'Saturday Stackfest Opener', ARRAY[6], ARRAY['15:15'], 5, 'nlh', 8000, 'TURBO', 4),
      ('Midweek Feature Satellite 5', 'Wednesday Feature', ARRAY[3], ARRAY['17:15'], 5, 'nlh', 8000, 'TURBO', 4),
      ('Thursday Six-Card Satellite 5', 'Six-Card Feature', ARRAY[4], ARRAY['17:15'], 5, 'plo6', 8000, 'TURBO', 4),
      ('Friday Feature Satellite 5', 'Friday Night Feature', ARRAY[3, 4, 5], ARRAY['18:45'], 5, 'nlh', 8000, 'TURBO', 4),
      ('Friday Feature Satellite 10', 'Friday Night Feature', ARRAY[5], ARRAY['17:15'], 10, 'nlh', 10000, 'STANDARD', 5),
      ('Saturday Big Stack Satellite 5', 'Saturday Night Big Stack', ARRAY[4, 5, 6], ARRAY['19:45'], 5, 'nlh', 8000, 'TURBO', 4),
      ('Saturday Big Stack Satellite 10', 'Saturday Night Big Stack', ARRAY[6], ARRAY['17:15'], 10, 'nlh', 10000, 'STANDARD', 5),
      ('Funday PLO Classic Satellite 5', 'Sunday Funday PLO Classic', ARRAY[0], ARRAY['08:15'], 5, 'plo4', 8000, 'TURBO', 4),
      ('Funday Turbo Satellite 5', 'Sunday Funday Turbo', ARRAY[0], ARRAY['08:45'], 5, 'nlh', 8000, 'TURBO', 4),
      ('Funday Big Stack Satellite 10', 'Sunday Funday Big Stack', ARRAY[0], ARRAY['09:15'], 10, 'nlh', 10000, 'STANDARD', 5),
      ('Funday Six-Max Satellite 5', 'Sunday Funday Six-Max', ARRAY[0], ARRAY['09:45'], 5, 'nlh', 8000, 'TURBO', 4),
      ('Funday Championship Satellite 10', 'Sunday Funday Championship', ARRAY[0], ARRAY['10:15'], 10, 'nlh', 10000, 'STANDARD', 5),
      ('Funday PLO5 Satellite 10', 'Sunday Funday PLO5 Big Stack', ARRAY[0], ARRAY['10:45'], 10, 'plo5', 10000, 'STANDARD', 5),
      ('Funday PLO5 Satellite 5', 'Sunday Funday PLO5 Big Stack', ARRAY[5, 6], ARRAY['21:15'], 5, 'plo5', 8000, 'TURBO', 4),
      ('Funday Happy Hour Satellite 5', 'Sunday Funday Happy Hour', ARRAY[0], ARRAY['11:45'], 5, 'nlh', 8000, 'TURBO', 4),
      ('Funday Warm-Up Satellite 10', 'Sunday Funday Warm-Up', ARRAY[0], ARRAY['12:15'], 10, 'nlh', 10000, 'STANDARD', 5),
      ('Funday Warm-Up Satellite 5', 'Sunday Funday Warm-Up', ARRAY[5, 6], ARRAY['12:15'], 5, 'nlh', 8000, 'TURBO', 4),
      ('Funday Main Event Satellite 10', 'Sunday Funday Main Event', ARRAY[0, 5, 6], ARRAY['12:45'], 10, 'nlh', 10000, 'STANDARD', 5),
      ('Funday Main Event Satellite 25', 'Sunday Funday Main Event', ARRAY[0, 6], ARRAY['18:15'], 25, 'nlh', 12000, 'STANDARD', 6),
      ('Funday Prime Time Satellite 10', 'Sunday Funday Prime Time', ARRAY[0], ARRAY['13:45'], 10, 'nlh', 10000, 'STANDARD', 5),
      ('Funday PLO High Roller Satellite 15', 'Sunday Funday PLO High Roller', ARRAY[0], ARRAY['14:15'], 15, 'plo4', 10000, 'STANDARD', 5),
      ('Funday PLO Opener Satellite 5', 'Sunday Funday PLO Opener', ARRAY[0], ARRAY['14:45'], 5, 'plo4', 8000, 'TURBO', 4),
      ('Funday Six-Card Satellite 10', 'Sunday Funday Six-Card Closer', ARRAY[0], ARRAY['16:45'], 10, 'plo6', 10000, 'STANDARD', 5),
      ('Funday Six-Card Satellite 5', 'Sunday Funday Six-Card Closer', ARRAY[6], ARRAY['21:45'], 5, 'plo6', 8000, 'TURBO', 4)
   ) AS sat(name, target, days, times, buy_in, variant, stack, preset, late_reg);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 58 THEN RAISE EXCEPTION 'expected 58 new satellite schedules, inserted %', v_n; END IF;

  -- The day each club is left with.
  FOREACH v_club IN ARRAY ARRAY[c_midway, c_arena] LOOP
    -- Real events hold exactly the weekly half hours the board leaves them
    -- (fixedBoard.ts WEEKLY_EVENT_SLOTS) ...
    SELECT array_agg(DISTINCT t ORDER BY t) INTO v_slots
      FROM public.tournament_schedules s, unnest(s.start_times_utc) t
     WHERE s.active AND s.club_id = v_club
       AND COALESCE(s.config->>'type', '') NOT IN ('fixed_board', 'satellite')
       AND s.config->>'fixedBoard' IS NULL;
    IF v_slots IS DISTINCT FROM ARRAY['01:00', '09:00', '11:00', '11:30', '12:00', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '21:00', '21:30', '22:00', '22:30', '23:00']::text[] THEN
      RAISE EXCEPTION 'club % weekly slots are %', v_club, v_slots;
    END IF;

    -- ... on exactly the days fixedBoard.ts WEEKLY_EVENT_DAYS gives them.
    SELECT count(*) INTO v_n FROM (
      SELECT d, t
        FROM public.tournament_schedules s, unnest(s.days_of_week) d, unnest(s.start_times_utc) t
       WHERE s.active AND s.club_id = v_club
         AND COALESCE(s.config->>'type', '') NOT IN ('fixed_board', 'satellite')
         AND s.config->>'fixedBoard' IS NULL
       GROUP BY d, t) used
     WHERE (d = 0) = false AND t NOT IN ('01:00', '09:00', '15:00', '19:00', '19:30', '20:00', '21:00', '22:00', '23:00');
    IF v_n > 0 THEN RAISE EXCEPTION 'club % has % weekday weekly starts on a board half hour', v_club, v_n; END IF;
    SELECT count(DISTINCT (d, t)) INTO v_n
      FROM public.tournament_schedules s, unnest(s.days_of_week) d, unnest(s.start_times_utc) t
     WHERE s.active AND s.club_id = v_club
       AND COALESCE(s.config->>'type', '') NOT IN ('fixed_board', 'satellite')
       AND s.config->>'fixedBoard' IS NULL;
    IF v_n <> 6 * 9 + 24 THEN
      RAISE EXCEPTION 'club % holds % weekly day-slots, expected 78 (nine a weekday, 24 on Sunday)', v_club, v_n;
    END IF;

    -- One real event per day and half hour.
    SELECT count(*) INTO v_n FROM (
      SELECT d, t
        FROM public.tournament_schedules s, unnest(s.days_of_week) d, unnest(s.start_times_utc) t
       WHERE s.active AND s.club_id = v_club
         AND COALESCE(s.config->>'type', '') NOT IN ('fixed_board', 'satellite')
         AND s.config->>'fixedBoard' IS NULL
       GROUP BY d, t HAVING count(*) > 1) dup;
    IF v_n > 0 THEN RAISE EXCEPTION 'club % has % doubled weekly starts', v_club, v_n; END IF;

    -- 6 PM to 10 PM costs 22 or more.
    SELECT count(*) INTO v_n
      FROM public.tournament_schedules s, unnest(s.start_times_utc) t
     WHERE s.active AND s.club_id = v_club
       AND COALESCE(s.config->>'type', '') NOT IN ('fixed_board', 'satellite')
       AND s.config->>'fixedBoard' IS NULL
       AND t BETWEEN '18:00' AND '22:00'
       AND (s.config->>'buyIn')::numeric < 22;
    IF v_n > 0 THEN RAISE EXCEPTION 'club % has % prime-time events under 22', v_club, v_n; END IF;

    -- Satellites only on the :15 and :45, one per day and slot.
    SELECT count(*) INTO v_n
      FROM public.tournament_schedules s, unnest(s.start_times_utc) t
     WHERE s.active AND s.club_id = v_club AND s.config->>'type' = 'satellite'
       AND right(t, 2) NOT IN ('15', '45');
    IF v_n > 0 THEN RAISE EXCEPTION 'club % has % satellite starts off the :15 and :45', v_club, v_n; END IF;
    SELECT count(*) INTO v_n FROM (
      SELECT d, t
        FROM public.tournament_schedules s, unnest(s.days_of_week) d, unnest(s.start_times_utc) t
       WHERE s.active AND s.club_id = v_club AND s.config->>'type' = 'satellite'
       GROUP BY d, t HAVING count(*) > 1) dup;
    IF v_n > 0 THEN RAISE EXCEPTION 'club % has % doubled satellite starts', v_club, v_n; END IF;

    -- Every weekly guarantee is a whole 500.
    SELECT count(*) INTO v_n
      FROM public.tournament_schedules s
     WHERE s.active AND s.club_id = v_club
       AND COALESCE(s.config->>'type', '') NOT IN ('fixed_board', 'satellite')
       AND s.config->>'fixedBoard' IS NULL
       AND (COALESCE((s.config->>'guaranteedPrize')::numeric, 0) <= 0
            OR (s.config->>'guaranteedPrize')::numeric % 500 <> 0);
    IF v_n > 0 THEN RAISE EXCEPTION 'club % has % guarantees off the 500 grid', v_club, v_n; END IF;
  END LOOP;
END $$;

COMMIT;
