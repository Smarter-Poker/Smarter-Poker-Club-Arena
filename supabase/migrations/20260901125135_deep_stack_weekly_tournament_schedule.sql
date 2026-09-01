-- =============================================================================
-- deep_stack_weekly_tournament_schedule
-- Applied to production via Supabase MCP 2026-09-01 12:51 UTC.
--
-- Dan, 2026-09-01: create the tournament tables for Deep Stack Society —
-- the 84-event weekly recurring schedule (28 freerolls + 56 paid, 12 events
-- per day, America/Chicago). Spawned by ScheduledTournamentService, which
-- reads every active tournament_schedules row club-scoped — no engine change.
--
-- Chicago slots 10:00-21:00 hourly; stored in UTC (CDT = UTC-5). Slots at
-- 19:00-21:00 Chicago land 00:00-02:00 UTC the NEXT day, so days_of_week
-- shifts by one for those rows (the spawner evaluates days in UTC).
--
-- horsesToRegister is 0 on every row — identical to every Midway schedule —
-- and all 416 Deep Stack horses are benched until Dan's green light, so
-- nothing fills these until he says go.
-- Idempotent: refuses to run if any DSS-prefixed schedule already exists.
-- =============================================================================
DO $$
DECLARE
  v_club uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_day int; v_utc_day int; v_slot record; v_cfg jsonb;
  v_utc_hour int; v_name text; v_count int;
  day_names text[] := array['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
BEGIN
  IF EXISTS (SELECT 1 FROM tournament_schedules WHERE club_id=v_club AND name LIKE 'DSS %') THEN
    RAISE EXCEPTION 'DSS schedules already exist; refusing to double-seed';
  END IF;

  FOR v_day IN 0..6 LOOP
    FOR v_slot IN
      SELECT * FROM (VALUES
        -- (chicago_hour, title, type, variant, buyIn, stack, blinds, tableSize, gtd, bounty, mystmin, mystmax, rebuy)
        (10, '$100 Freeroll',            'mtt',               'nlh',  0::numeric,     5000,  'STANDARD', 9, 100::numeric, null::numeric, null::numeric, null::numeric, true),
        (11, '$11 NLH Daily',            'mtt',               'nlh',  11::numeric,   10000,  'STANDARD', 9, null, null, null, null, false),
        (12, '$5.50 PLO4 Turbo',         'mtt',               'plo',  5.50,          12000,  'TURBO',    8, null, null, null, null, false),
        (13, '$100 Turbo Freeroll',      'mtt',               'nlh',  0,             12000,  'TURBO',    9, 100, null, null, null, false),
        (14, '$22 NLH Deepstack',        'mtt',               'nlh',  22,            30000,  'DEEPSTACK',9, null, null, null, null, false),
        (15, '$11 PLO5 Deepstack',       'mtt',               'plo5', 11,            30000,  'DEEPSTACK',7, null, null, null, null, false),
        (16, '$100 PLO4 Freeroll',       'mtt',               'plo',  0,             10000,  'STANDARD', 8, 100, null, null, null, false),
        (17, '$16.50 NLH Bounty Hunter', 'progressive_bounty','nlh',  16.50,         22000,  'STANDARD', 9, null, 7.50, null, null, false),
        (18, '$8.80 PLO6 Turbo',         'mtt',               'plo6', 8.80,          12000,  'TURBO',    6, null, null, null, null, false),
        (19, '$150 Evening Freeroll',    'mtt',               'nlh',  0,              5000,  'STANDARD', 9, 150, null, null, null, true),
        (20, '$11 NLH Mystery Bounty',   'mystery_bounty',    'nlh',  11,            25000,  'STANDARD', 9, null, null, 5::numeric, 500::numeric, false),
        (21, '$5.50 NLH Turbo',          'mtt',               'nlh',  5.50,          12000,  'TURBO',    9, null, null, null, null, false)
      ) s(h, title, typ, variant, buyin, stack, blinds, tsize, gtd, bounty, mmin, mmax, rebuy)
    LOOP
      v_utc_hour := (v_slot.h + 5) % 24;
      v_utc_day  := CASE WHEN v_slot.h + 5 >= 24 THEN (v_day + 1) % 7 ELSE v_day END;
      v_name := 'DSS ' || day_names[v_day+1] || ' ' || v_slot.title || ' • ' ||
                CASE WHEN v_slot.h = 12 THEN '12 PM'
                     WHEN v_slot.h > 12 THEN (v_slot.h-12)::text || ' PM'
                     ELSE v_slot.h::text || ' AM' END || ' CT';

      v_cfg := jsonb_strip_nulls(jsonb_build_object(
        'name', v_name,
        'type', v_slot.typ,
        'buyIn', v_slot.buyin,
        'tableSize', v_slot.tsize,
        'maxPlayers', 200,
        'minPlayers', 4,
        'blindPreset', v_slot.blinds,
        'gameVariant', v_slot.variant,
        'payoutPreset', 'NINE',
        'startingStack', v_slot.stack,
        'bigBlindAnte', true,
        'guaranteedPrize', v_slot.gtd,
        'bountyAmount', v_slot.bounty,
        'mysteryBountyMin', v_slot.mmin,
        'mysteryBountyMax', v_slot.mmax,
        'isRebuy', CASE WHEN v_slot.rebuy THEN true ELSE null END,
        'rebuyCost', CASE WHEN v_slot.rebuy THEN 1 ELSE null END,
        'rebuyChips', CASE WHEN v_slot.rebuy THEN 5000 ELSE null END,
        'addOnAvailable', CASE WHEN v_slot.rebuy THEN true ELSE null END,
        'addonCost', CASE WHEN v_slot.rebuy THEN 1 ELSE null END,
        'addonChips', CASE WHEN v_slot.rebuy THEN 10000 ELSE null END,
        'horsesToRegister', 0,
        'lateRegistrationLevels', 4,
        'shortDescription',
          CASE WHEN v_slot.buyin = 0
               THEN 'Free Entry. $' || v_slot.gtd::int || ' Base Prize Pool.'
               ELSE 'Daily ' || v_slot.title || '. Registration Open Now.' END
      ));

      INSERT INTO tournament_schedules
        (club_id, union_id, name, description, active, days_of_week, start_times_utc, config)
      VALUES
        (v_club, NULL, v_name,
         'Deep Stack Society weekly schedule (12 daily events, America/Chicago)',
         true, ARRAY[v_utc_day], ARRAY[to_char(v_utc_hour,'FM00')||':00'], v_cfg);
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_count FROM tournament_schedules WHERE club_id=v_club AND name LIKE 'DSS %';
  IF v_count <> 84 THEN
    RAISE EXCEPTION 'schedule seeded % rows, expected 84', v_count;
  END IF;

  -- 28 freerolls + 56 paid
  IF (SELECT count(*) FROM tournament_schedules WHERE club_id=v_club AND name LIKE 'DSS %'
        AND (config->>'buyIn')::numeric = 0) <> 28
     OR (SELECT count(*) FROM tournament_schedules WHERE club_id=v_club AND name LIKE 'DSS %'
        AND (config->>'buyIn')::numeric > 0) <> 56 THEN
    RAISE EXCEPTION 'freeroll/paid split wrong';
  END IF;

  -- every row spawns for exactly one UTC day at one time
  IF EXISTS (SELECT 1 FROM tournament_schedules WHERE club_id=v_club AND name LIKE 'DSS %'
              AND (array_length(days_of_week,1) <> 1 OR array_length(start_times_utc,1) <> 1)) THEN
    RAISE EXCEPTION 'a schedule row carries more than one day/time';
  END IF;
END $$;
