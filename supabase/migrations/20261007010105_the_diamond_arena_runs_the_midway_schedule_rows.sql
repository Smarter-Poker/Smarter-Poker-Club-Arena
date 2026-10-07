-- 20261007010105_the_diamond_arena_runs_the_midway_schedule_rows.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-06 13:09 CT: "USE THE SAME TOURNAMENT SCHEDULE AND RAKE AS THE
-- MIDWAY UNION FOR NOW" - for the Diamond Arena.
--
-- This copies every ACTIVE Midway Union schedule (union fade0000-...0001; 63
-- rows when written) onto the Diamond Arena (club 002c2d27-...), unchanged
-- except for ownership: club_id = the arena and union_id NULL, because a
-- Diamond game can never belong to a union. The config jsonb is copied byte for
-- byte, so names, days, start times, prices, guarantees, rebuys, add-ons,
-- bounties and satellite targets (resolved by name inside the arena's own
-- events) are Midway's. Prices are read 1 chip = 1 Diamond, the arena's cash
-- scale. The engine sends an arena schedule to
-- fn_poker_diamond_spawn_scheduled_tournament (20261007000010), which prices
-- the fee at Midway's 10% (5% capped at two) to the whole Diamond and sets each
-- guarantee aside on the house at creation.
--
-- Data only: no DDL, so no schema-cache reload. Deep Stack Society's schedules
-- are not touched and stay inactive. Runs once: if the arena already has any
-- schedule this refuses rather than duplicating the line-up.
--
-- @live-proof: (SELECT count(*) FROM public.tournament_schedules WHERE club_id = '002c2d27-9584-4e52-835a-bb2be148fc81' AND union_id IS NULL) > 0

BEGIN;

DO $$
DECLARE
  c_arena  constant uuid := '002c2d27-9584-4e52-835a-bb2be148fc81';
  c_midway constant uuid := 'fade0000-0000-0000-0000-000000000001';
  v_source int;
  v_copied int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clubs WHERE id = c_arena) THEN
    RAISE EXCEPTION 'the Diamond Arena club % does not exist', c_arena;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_schedules WHERE club_id = c_arena) THEN
    RAISE EXCEPTION 'the Diamond Arena already has schedules; refusing to duplicate the line-up';
  END IF;

  SELECT count(*) INTO v_source
    FROM public.tournament_schedules
   WHERE union_id = c_midway AND active;
  IF v_source = 0 THEN
    RAISE EXCEPTION 'no active Midway Union schedules to copy';
  END IF;

  INSERT INTO public.tournament_schedules
    (union_id, club_id, name, description, active, days_of_week,
     start_times_utc, interval_minutes, config, time_zone)
  SELECT NULL, c_arena, s.name, s.description, true, s.days_of_week,
         s.start_times_utc, s.interval_minutes, s.config, s.time_zone
    FROM public.tournament_schedules s
   WHERE s.union_id = c_midway AND s.active;
  GET DIAGNOSTICS v_copied = ROW_COUNT;

  IF v_copied <> v_source THEN
    RAISE EXCEPTION 'copied % of % Midway schedules', v_copied, v_source;
  END IF;
  RAISE NOTICE 'the Diamond Arena now runs % Midway schedules', v_copied;
END $$;

COMMIT;
