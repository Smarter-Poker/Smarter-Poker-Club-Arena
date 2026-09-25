-- 20260925143159_diamond_crash_is_capped_at_twenty_five_times_the_stake.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (Dan, 2026-09-21, on Diamond Crash):
--   "the multiplier should be 25x max and that should be displayed to the user
--    so they know thats the max they can get."
--
-- Every Diamond Crash flight is now capped at 25.00x (cap 2,500 cents). The
-- cap was 100.00x on both live crash configs (the club host and the union
-- host), clamped there by the crash_config_limits trigger installed on
-- 2026-09-19. Two things change, in one transaction:
--
-- 1. fn_crash_config_limits clamps max_multiplier_cents to 2,500 for every
--    crash config written from now on (a new host's default of 100,000 lands
--    at 2,500), so no operator setting can advertise more than 25x.
-- 2. The two live crash configs are set to 2,500 now, so the very next round
--    a player starts is sealed with cap_cents = 2,500 (fn_crash_start reads
--    the config's max_multiplier_cents through fn_diamond_game_cap_cents, and
--    a pool that cannot cover 25x still caps lower, as before).
--
-- What does NOT change: the crash-point distribution (still floored at 1.10x,
-- still P(point >= x) = (0.8B - L)/(xB - L)), the 0.80 return of every
-- cash-out target at or below the cap, the growth curve, the 1.11x cash-out
-- opening, and every round already sealed: a round carries its own cap_cents,
-- and rounds sealed under the old cap settle under the old cap. Reserving
-- ceil(bet x cap)/100 per round now reserves a quarter of what it did, so the
-- pool admits more concurrent rounds at the same exposure allowance.
--
-- A round whose sealed crash point is above 25x books at 25x the moment the
-- curve reaches the cap (fn_crash_decide, unchanged), which the client says
-- as "It Would Have Gone To The 25.00x Max".
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- Only future flights take the new limit. Existing round snapshots, sealed
-- outcomes, payouts and proofs are immutable and are never rewritten.
CREATE OR REPLACE FUNCTION public.fn_crash_config_limits()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
 IF NEW.game='crash' THEN
  -- 25.00x is the most any Diamond Crash flight can pay (Dan, 2026-09-21).
  NEW.max_multiplier_cents:=least(NEW.max_multiplier_cents,2500);
  NEW.growth_k:=least(NEW.growth_k,0.04);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fn_crash_config_limits() FROM PUBLIC,anon,authenticated;

UPDATE public.diamond_game_configs
   SET max_multiplier_cents=least(max_multiplier_cents,2500), updated_at=now()
 WHERE game='crash' AND max_multiplier_cents>2500;

DO $$
DECLARE v_over integer;
BEGIN
  SELECT count(*) INTO v_over FROM public.diamond_game_configs WHERE game='crash' AND max_multiplier_cents>2500;
  IF v_over>0 THEN
    RAISE EXCEPTION 'diamond crash cap: % crash config(s) still above 2500 cents', v_over;
  END IF;
END $$;

COMMIT;
