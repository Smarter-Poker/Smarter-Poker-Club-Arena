-- Owner 2026-10-27 explicitly authorizes the Midway daily 8 PM series as a
-- 40-total-entry freezeout with a 10-chip fixed bounty. No other bounty rule
-- changes. No money/seat/player writes. The event configuration is changed
-- separately only after checking that no participant has registered.
-- @live-proof: (position('a70c1028-2000-4000-8000-000000000001' in pg_get_functiondef('public.fn_ca_bounty_mtt_rebuys_until_registration_closes()'::regprocedure)) > 0)
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_bounty_mtt_rebuys_until_registration_closes()'::regprocedure))
     <> 'b3916a219f24417179eca73251b68b4d' THEN
    RAISE EXCEPTION 'MIDWAY_BOUNTY_FREEZEOUT_PREIMAGE_CHANGED';
  END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_bounty_mtt_rebuys_until_registration_closes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_total numeric;
BEGIN
  IF NOT (COALESCE(NEW.is_bounty, false) OR COALESCE(NEW.is_pko, false)
          OR COALESCE(NEW.is_mystery_bounty, false)) THEN
    RETURN NEW;
  END IF;
  IF upper(COALESCE(NEW.tournament_type, 'MTT')) <> 'MTT'
     OR lower(COALESCE(NEW.variant, '')) = 'satellite'
     OR NEW.satellite_target_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- A game that has started keeps the contract it started with.
  IF upper(COALESCE(NEW.status, 'REGISTERING')) NOT IN ('REGISTERING', 'ANNOUNCED') THEN
    RETURN NEW;
  END IF;
  v_total := COALESCE(NEW.buy_in_amount, 0) + COALESCE(NEW.buy_in_fee, 0);
  -- A freeroll keeps its Free Buy rules (fn_freerolls_are_free_buy).
  IF v_total <= 0 THEN
    RETURN NEW;
  END IF;

  -- Owner 2026-10-27: the Midway daily 8 PM series is a bounty FREEZEOUT.
  -- Its stable schedule identity is retained on every future occurrence.
  -- The existing spawner applies the general bounty defaults before INSERT;
  -- normalize this explicitly authorized series at the persisted boundary.
  IF (NEW.id = 'a70c1028-2000-4000-8000-000000000001'::uuid
      OR NEW.schedule_id = 'a70c1028-2000-4000-9000-000000000001'::uuid)
     AND NEW.club_id = 'fade0000-0000-0000-0000-000000000001'::uuid
     AND NEW.union_id = NEW.club_id
     AND NEW.is_bounty IS TRUE AND NEW.is_pko IS FALSE AND NEW.is_mystery_bounty IS FALSE
     AND NEW.bounty_amount = 10 AND v_total = 40 THEN
    NEW.is_rebuy := false;
    NEW.is_reentry := false;
    NEW.add_on_available := false;
    NEW.rebuy_cost := 0;
    NEW.rebuy_chips := 0;
    NEW.rebuy_levels := 0;
    NEW.max_rebuys := 0;
    NEW.max_reentries := 0;
    NEW.addon_cost := 0;
    NEW.addon_chips := 0;
    NEW.addon_levels := 0;
    RETURN NEW;
  END IF;

  NEW.is_rebuy := true;
  NEW.is_reentry := true;
  IF COALESCE(NEW.rebuy_cost, 0) <= 0 THEN
    NEW.rebuy_cost := v_total;
  END IF;
  IF COALESCE(NEW.rebuy_chips, 0) <= 0 THEN
    NEW.rebuy_chips := COALESCE(NULLIF(NEW.starting_chips, 0), 10000);
  END IF;
  IF COALESCE(NEW.late_reg_levels, 0) > 0 THEN
    NEW.rebuy_levels := NEW.late_reg_levels;
  ELSIF COALESCE(NEW.rebuy_levels, 0) <= 0 THEN
    NEW.rebuy_levels := 6;
  END IF;
  IF COALESCE(NEW.max_rebuys, 0) <= 0 THEN
    NEW.max_rebuys := NULL;
  END IF;
  IF COALESCE(NEW.max_reentries, 0) <= 0 THEN
    NEW.max_reentries := NULL;
  END IF;
  RETURN NEW;
END;
$fn$;


COMMIT;
