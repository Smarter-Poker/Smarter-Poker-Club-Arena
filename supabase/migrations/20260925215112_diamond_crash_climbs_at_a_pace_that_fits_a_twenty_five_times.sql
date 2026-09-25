-- 20260925215112_diamond_crash_climbs_at_a_pace_that_fits_a_twenty_five_times.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (mobile spins programme, phase 2; follows
-- 20260925143159 which set the Diamond Crash ceiling at 25.00x):
--
-- The curve is e^(k t). The live k of 0.04 was set on 2026-09-19 together
-- with a 100x ceiling ("a slower curve and a 100x ceiling"), so that the long
-- tail took long enough to watch. With the ceiling at 25x that pace is the
-- wrong shape: 2x took 17 s, 5x 40 s and the 25x ceiling 80 s, so the top of
-- the range was practically never reached and every round felt slow.
--
-- k becomes 0.10: 1.10x (the floor, and the moment cash-out opens at 1.11x)
-- at 1.0 s, 2x at 6.9 s, 5x at 16.1 s, 10x at 23.0 s and the 25x ceiling at
-- 32.2 s. The pace changes nothing about the money: the crash point is sealed
-- from the roll before the round starts, cash-out books the multiplier shown
-- at the server's clock, and P(point >= x) does not depend on k, so every
-- cash-out target still returns 0.80 of the stake. Rounds already open keep
-- their own growth_k, which crash_rounds carries per row.
--
-- The trigger's ceiling on growth_k moves from 0.04 to 0.10 with it, so no
-- operator setting can make the curve faster than this.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.fn_crash_config_limits()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
 IF NEW.game='crash' THEN
  -- 25.00x is the most any Diamond Crash flight can pay (Dan, 2026-09-21),
  -- and 0.10 the fastest it may climb: the ceiling in about 32 seconds.
  NEW.max_multiplier_cents:=least(NEW.max_multiplier_cents,2500);
  NEW.growth_k:=least(NEW.growth_k,0.10);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fn_crash_config_limits() FROM PUBLIC,anon,authenticated;

UPDATE public.diamond_game_configs
   SET growth_k=0.10, updated_at=now()
 WHERE game='crash' AND growth_k<>0.10;

DO $$
DECLARE v_off integer;
BEGIN
  SELECT count(*) INTO v_off FROM public.diamond_game_configs
   WHERE game='crash' AND (growth_k<>0.10 OR max_multiplier_cents>2500);
  IF v_off>0 THEN
    RAISE EXCEPTION 'diamond crash pace: % crash config(s) not at k=0.10 under a 2500 cap', v_off;
  END IF;
END $$;

COMMIT;
