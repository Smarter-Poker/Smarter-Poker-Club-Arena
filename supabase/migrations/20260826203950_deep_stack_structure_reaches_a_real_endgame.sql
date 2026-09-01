-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826203950; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═════════════════════════════════════════════════════════════════════════════
-- THE DEEP STACK NEEDS ENOUGH LEVELS TO ACTUALLY FINISH
-- Dan 2026-08-26, follow-up to the Sunday $200 Deep Stack
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The event shipped with 20 levels of 10 minutes: 3h20m of defined structure,
-- ending at 4,000/8,000. That is not enough for what it is.
--
-- With a full 1,000-runner field there are 30,000,000 chips in play, so at the
-- last defined level there are still 3,750 BIG BLINDS on the table. The event
-- is nowhere near over. What happens then is
-- TournamentManagerBase auto-escalation, which DOUBLES the last level's blinds
-- every level thereafter (16k, 32k, 64k, 128k...). That backstop is correct
-- and should stay - it is what stops a structure running out entirely - but it
-- is a 2.0x cliff bolted onto a ramp that had been climbing at 1.20x-1.33x.
-- A flagship deep stack should not change character the moment it gets
-- interesting.
--
-- Twelve more levels, same 10 minutes each, same 1.20x-1.33x ramp, sb always
-- half bb: 5,000/10,000 through 60,000/120,000. 32 levels, 5h20m defined.
--
-- What that buys, measured:
--   field  100 ->    25bb left at the last defined level (was 375)
--   field  300 ->    75bb (was 1,125)
--   field 1000 ->   250bb (was 3,750)
-- So any realistic field now plays its endgame inside a hand-written
-- structure, and auto-escalation goes back to being a backstop rather than
-- the thing that decides the tournament.
--
-- UNCHANGED: 30,000 chips, 10 minute levels, rebuys through level 12 (big
-- blind 1,200 there, so a fresh rebuy is still 25bb), late reg 12, the 200
-- buy-in, and the 7-day look-ahead the satellites depend on.
--
-- Only the SCHEDULE and pre-start instances with an empty field are touched.
-- An event that is already running keeps the structure it started on: changing
-- blinds under a live tournament is not a thing to do.

UPDATE public.tournament_schedules
SET config = jsonb_set(
      config, '{blindStructure}',
      '[{"level":1,"smallBlind":25,"bigBlind":50,"ante":0,"durationMinutes":10},{"level":2,"smallBlind":50,"bigBlind":100,"ante":0,"durationMinutes":10},{"level":3,"smallBlind":75,"bigBlind":150,"ante":150,"durationMinutes":10},{"level":4,"smallBlind":100,"bigBlind":200,"ante":200,"durationMinutes":10},{"level":5,"smallBlind":125,"bigBlind":250,"ante":250,"durationMinutes":10},{"level":6,"smallBlind":150,"bigBlind":300,"ante":300,"durationMinutes":10},{"level":7,"smallBlind":200,"bigBlind":400,"ante":400,"durationMinutes":10},{"level":8,"smallBlind":250,"bigBlind":500,"ante":500,"durationMinutes":10},{"level":9,"smallBlind":300,"bigBlind":600,"ante":600,"durationMinutes":10},{"level":10,"smallBlind":400,"bigBlind":800,"ante":800,"durationMinutes":10},{"level":11,"smallBlind":500,"bigBlind":1000,"ante":1000,"durationMinutes":10},{"level":12,"smallBlind":600,"bigBlind":1200,"ante":1200,"durationMinutes":10},{"level":13,"smallBlind":800,"bigBlind":1600,"ante":1600,"durationMinutes":10},{"level":14,"smallBlind":1000,"bigBlind":2000,"ante":2000,"durationMinutes":10},{"level":15,"smallBlind":1200,"bigBlind":2400,"ante":2400,"durationMinutes":10},{"level":16,"smallBlind":1500,"bigBlind":3000,"ante":3000,"durationMinutes":10},{"level":17,"smallBlind":2000,"bigBlind":4000,"ante":4000,"durationMinutes":10},{"level":18,"smallBlind":2500,"bigBlind":5000,"ante":5000,"durationMinutes":10},{"level":19,"smallBlind":3000,"bigBlind":6000,"ante":6000,"durationMinutes":10},{"level":20,"smallBlind":4000,"bigBlind":8000,"ante":8000,"durationMinutes":10},{"level":21,"smallBlind":5000,"bigBlind":10000,"ante":10000,"durationMinutes":10},{"level":22,"smallBlind":6000,"bigBlind":12000,"ante":12000,"durationMinutes":10},{"level":23,"smallBlind":7500,"bigBlind":15000,"ante":15000,"durationMinutes":10},{"level":24,"smallBlind":10000,"bigBlind":20000,"ante":20000,"durationMinutes":10},{"level":25,"smallBlind":12500,"bigBlind":25000,"ante":25000,"durationMinutes":10},{"level":26,"smallBlind":15000,"bigBlind":30000,"ante":30000,"durationMinutes":10},{"level":27,"smallBlind":20000,"bigBlind":40000,"ante":40000,"durationMinutes":10},{"level":28,"smallBlind":25000,"bigBlind":50000,"ante":50000,"durationMinutes":10},{"level":29,"smallBlind":30000,"bigBlind":60000,"ante":60000,"durationMinutes":10},{"level":30,"smallBlind":40000,"bigBlind":80000,"ante":80000,"durationMinutes":10},{"level":31,"smallBlind":50000,"bigBlind":100000,"ante":100000,"durationMinutes":10},{"level":32,"smallBlind":60000,"bigBlind":120000,"ante":120000,"durationMinutes":10}]'::jsonb,
      true),
    updated_at = now()
WHERE name = 'Sunday $200 Deep Stack' AND active;

UPDATE public.tournaments t
SET blind_structure = (
      SELECT s.config->'blindStructure'
      FROM public.tournament_schedules s
      WHERE s.name = 'Sunday $200 Deep Stack' AND s.active
      LIMIT 1
    )::text
WHERE t.name = 'Sunday $200 Deep Stack'
  AND t.status IN ('ANNOUNCED', 'REGISTERING')
  AND COALESCE(t.current_players, 0) = 0
  AND NOT EXISTS (
    SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = t.id
  );

-- ── POST-APPLY ASSERTIONS ───────────────────────────────────────────────────

DO $$
DECLARE
  v_cfg   jsonb;
  v_bad   integer;
  v_last  numeric;
  v_l12   numeric;
BEGIN
  SELECT config INTO v_cfg
  FROM public.tournament_schedules WHERE name = 'Sunday $200 Deep Stack' AND active;
  IF v_cfg IS NULL THEN RAISE EXCEPTION 'the Deep Stack schedule is missing'; END IF;

  IF jsonb_array_length(v_cfg->'blindStructure') <> 32 THEN
    RAISE EXCEPTION 'expected 32 levels, found %', jsonb_array_length(v_cfg->'blindStructure');
  END IF;

  -- Dan's ask, still true: EVERY level is 10 minutes.
  SELECT count(*) INTO v_bad
  FROM jsonb_array_elements(v_cfg->'blindStructure') lv
  WHERE (lv->>'durationMinutes')::numeric <> 10;
  IF v_bad > 0 THEN RAISE EXCEPTION '% level(s) are not 10 minutes', v_bad; END IF;

  -- Small blind is always half the big blind.
  SELECT count(*) INTO v_bad
  FROM jsonb_array_elements(v_cfg->'blindStructure') lv
  WHERE (lv->>'smallBlind')::numeric * 2 <> (lv->>'bigBlind')::numeric;
  IF v_bad > 0 THEN RAISE EXCEPTION '% level(s) have sb <> bb/2', v_bad; END IF;

  -- The rebuy window still ends on a playable stack.
  SELECT (lv->>'bigBlind')::numeric INTO v_l12
  FROM jsonb_array_elements(v_cfg->'blindStructure') lv
  WHERE (lv->>'level')::numeric = 12;
  IF 30000 / v_l12 < 25 THEN
    RAISE EXCEPTION 'a level-12 rebuy would be under 25 big blinds';
  END IF;

  -- THE POINT OF THIS MIGRATION: the structure must reach an endgame for a
  -- realistic field, so auto-escalation is a backstop and not the referee.
  SELECT (lv->>'bigBlind')::numeric INTO v_last
  FROM jsonb_array_elements(v_cfg->'blindStructure') lv
  WHERE (lv->>'level')::numeric = 32;
  IF (100 * 30000) / v_last > 60 THEN
    RAISE EXCEPTION 'at the last defined level a 100-runner field still has %bb - too short a structure', (100*30000)/v_last;
  END IF;

  -- Nothing that is already dealing may have had its blinds rewritten.
  SELECT count(*) INTO v_bad
  FROM public.tournaments t
  WHERE t.name = 'Sunday $200 Deep Stack'
    AND t.status IN ('RUNNING','LATE_REG','COMPLETING')
    AND jsonb_array_length(t.blind_structure::jsonb) <> 20;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% in-flight Deep Stack(s) had their structure changed mid-tournament', v_bad;
  END IF;
END $$;

-- ROLLBACK: re-run the original 20-level array from migration 20260826175613.
