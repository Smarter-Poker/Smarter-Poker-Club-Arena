-- 20261015093549_diamond_spins_are_always_funded_to_twenty_five_hundred.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-15: "SPINS MUST ALWAYS BE FUNDED TO 2500 AND NEVER DISPLAY 'ONLY
-- FUNDED TO 2,480' OR ANY OTHER NUMBER LIKE THAT."
--
-- Read from production (Club JAQK / Midway Union, 2026-10-15 09:30 UTC):
-- fn_wheel_state_v2's max_funded_entry is the least of six bounds. The host's
-- real chip cover allowed 4,572,795; the owner's diamonds 229,358; the wheel's
-- diamond float 58,363. What pinned it near 2,500 were the two EXPOSURE
-- ALLOWANCES, configuration rows rather than money:
--   - plinko, double-diamond spin: 2,505 (game allowance 1,522.73 chips,
--     headroom 1,532.20 against 1,529 needed for a 2,500 spin), so a few
--     chips of ordinary payout variance printed "Funded To 2,480";
--   - the wheel itself: 3,637 (its allowance less what it has paid over
--     intake).
-- 1,116 hosts carry these rows; game allowances start at 1,250 and wheel
-- allowances at 500, so on most hosts a 2,500 spin was never fundable at all.
--
-- The fix is in the rows the bound is computed from, at the source:
--   1. Every wheel and bonus game allowance is raised to at least 25,000
--      chips: ten worst-case 2,500-diamond promises (the wheel's top 100x
--      secondary prize is 2,500 chips at the 100 diamonds-per-chip rate; a
--      double-diamond bonus game needs 1,529 of headroom). The bonus games'
--      own tables still cap every payout (Plinko 20x, Donkey Cross 20x), and
--      the host's real chip cover is still checked on every spin.
--   2. A trigger holds that floor on every future write, so an operator
--      setting or a new host can never put a 2,500 spin out of reach again.
--      The floor is derived from the live bridge rate, not typed.
-- @live-proof: NOT EXISTS (SELECT 1 FROM public.wheel_configs w WHERE w.exposure_allowance_chips < 25000 AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id=w.host_id AND c.lifecycle_status='retired')) AND to_regprocedure('public.fn_diamond_spins_allowance_floor()') IS NOT NULL

BEGIN;
SET LOCAL lock_timeout = '5s';

-- The smallest allowance that keeps ten 2,500-diamond worst-case promises
-- funded: 10 x 100x x 2,500 diamonds, in chips at the live bridge rate.
CREATE FUNCTION public.fn_diamond_spins_allowance_floor()
RETURNS numeric LANGUAGE sql STABLE SET search_path=public AS $function$
 SELECT round(10*100*2500::numeric/GREATEST(COALESCE(public.fn_ca_bridge_rate(),100),1),2)
$function$;
REVOKE ALL ON FUNCTION public.fn_diamond_spins_allowance_floor() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spins_allowance_floor() TO service_role;

CREATE FUNCTION public.fn_diamond_spins_hold_allowance_floor()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $function$
BEGIN
 -- Dan 2026-10-15: a spin is always funded to 2,500. The allowance can be set
 -- higher, never below what that takes.
 NEW.exposure_allowance_chips:=GREATEST(COALESCE(NEW.exposure_allowance_chips,0),public.fn_diamond_spins_allowance_floor());
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_diamond_spins_hold_allowance_floor() FROM PUBLIC,anon,authenticated;

CREATE TRIGGER wheel_configs_allowance_floor BEFORE INSERT OR UPDATE OF exposure_allowance_chips ON public.wheel_configs
 FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_spins_hold_allowance_floor();
CREATE TRIGGER diamond_game_configs_allowance_floor BEFORE INSERT OR UPDATE OF exposure_allowance_chips ON public.diamond_game_configs
 FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_spins_hold_allowance_floor();

-- A retired club's records are read-only (fn_guard_retired_club_mutation) and
-- it hosts no spins, so its rows are left exactly as they were.
UPDATE public.wheel_configs SET exposure_allowance_chips=public.fn_diamond_spins_allowance_floor()
 WHERE exposure_allowance_chips<public.fn_diamond_spins_allowance_floor() AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id=host_id AND c.lifecycle_status='retired');
UPDATE public.diamond_game_configs SET exposure_allowance_chips=public.fn_diamond_spins_allowance_floor()
 WHERE exposure_allowance_chips<public.fn_diamond_spins_allowance_floor() AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id=host_id AND c.lifecycle_status='retired');

DO $proof$
BEGIN
 IF public.fn_diamond_spins_allowance_floor()<25000 THEN RAISE EXCEPTION 'Allowance Floor Below 25,000: %',public.fn_diamond_spins_allowance_floor(); END IF;
 IF EXISTS(SELECT 1 FROM public.wheel_configs WHERE exposure_allowance_chips<public.fn_diamond_spins_allowance_floor() AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id=host_id AND c.lifecycle_status='retired'))
  OR EXISTS(SELECT 1 FROM public.diamond_game_configs WHERE exposure_allowance_chips<public.fn_diamond_spins_allowance_floor() AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id=host_id AND c.lifecycle_status='retired')) THEN
  RAISE EXCEPTION 'An Allowance Is Still Below The Floor'; END IF;
END
$proof$;

COMMIT;
