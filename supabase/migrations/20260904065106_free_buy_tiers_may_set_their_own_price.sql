-- FREE BUY TIERS MAY SET THEIR OWN PRICE - Dan 2026-09-04.
-- Applied to production via Supabase MCP as
-- `free_buy_tiers_may_set_their_own_price`. This file is the auditable copy and
-- supersedes the PRICING half of 20260902183602_freerolls_are_free_buy.sql.
-- Every other clause of that law is reproduced here unchanged.
--
-- THE CONFLICT, and Dan's ruling on it.
--   2026-09-02: "FREE ROLLS MUST ALWAYS BE SET AS 'FREE BUY' ... REBUYS AND
--                ADD ON'S COST $1."
--   2026-09-04: "$250 FREE BUY IS $1 REBUY AND $1 ADD ON. FOR THE $500 REBUYS
--                ARE $2 AND ADD ON'S $2."
-- The first forced rebuy_cost and addon_cost to 1.00 on EVERY 0-buy-in MTT,
-- unconditionally, so the $500 tier would have been created at $2 and silently
-- rewritten to $1 before a single player registered. Dan ruled: keep $1 as the
-- default for every freeroll, and stop overwriting a SCHEDULED Free Buy that
-- deliberately set its own price. Neither law was deleted (CLAUDE.md 10.8).
--
-- What did NOT need changing, and was therefore left alone: rebuy_chips,
-- addon_chips, rebuy_levels and addon_levels were only ever filled when <= 0,
-- so the 10,000 chip add-on on a 3,000 stack already survived. Only the two
-- costs were forced.
--
-- Proven against real rows in a transaction that was rolled back (11.5):
--   plain freeroll (7, 7, 0)      -> rebuy 1.00, addon 1.00, chips 3000
--   scheduled tier (2, 2, 10000)  -> rebuy 2.00, addon 2.00, chips 10000
CREATE OR REPLACE FUNCTION public.fn_freerolls_are_free_buy()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_changed jsonb := '{}'::jsonb;
  v_stack   integer;
  v_op      text;
  v_priced  boolean;
BEGIN
  IF NOT public.fn_is_free_buy_event(
       NEW.buy_in_amount, NEW.buy_in_fee, NEW.tournament_type, NEW.variant
     ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND upper(COALESCE(NEW.status, '')) NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN NEW;
  END IF;

  v_stack := COALESCE(NULLIF(NEW.starting_chips, 0), 10000);

  /* A SCHEDULED FREE BUY PRICES ITSELF. Everything else still gets 1.00. A
     NULL or non-positive price is a missing value, not a decision, and falls
     through to the default. */
  v_priced := COALESCE(NEW.free_buy, false) AND COALESCE(NEW.rebuy_cost, 0) > 0;

  IF NEW.buy_in_fee IS DISTINCT FROM 0 THEN
    v_changed := v_changed || jsonb_build_object('buy_in_fee',
      jsonb_build_object('from', NEW.buy_in_fee, 'to', 0));
    NEW.buy_in_fee := 0;
  END IF;

  IF NOT COALESCE(NEW.is_rebuy, false) THEN
    v_changed := v_changed || jsonb_build_object('is_rebuy',
      jsonb_build_object('from', NEW.is_rebuy, 'to', true));
    NEW.is_rebuy := true;
  END IF;

  IF NOT COALESCE(NEW.add_on_available, false) THEN
    v_changed := v_changed || jsonb_build_object('add_on_available',
      jsonb_build_object('from', NEW.add_on_available, 'to', true));
    NEW.add_on_available := true;
  END IF;

  IF NOT v_priced AND NEW.rebuy_cost IS DISTINCT FROM 1.00 THEN
    v_changed := v_changed || jsonb_build_object('rebuy_cost',
      jsonb_build_object('from', NEW.rebuy_cost, 'to', 1.00));
    NEW.rebuy_cost := 1.00;
  END IF;

  IF NOT v_priced AND NEW.addon_cost IS DISTINCT FROM 1.00 THEN
    v_changed := v_changed || jsonb_build_object('addon_cost',
      jsonb_build_object('from', NEW.addon_cost, 'to', 1.00));
    NEW.addon_cost := 1.00;
  END IF;

  /* A priced Free Buy that forgot its add-on price gets the rebuy price, not
     1.00 under a 2.00 rebuy - which would be a price nobody chose. */
  IF v_priced AND COALESCE(NEW.addon_cost, 0) <= 0 THEN
    v_changed := v_changed || jsonb_build_object('addon_cost',
      jsonb_build_object('from', NEW.addon_cost, 'to', NEW.rebuy_cost));
    NEW.addon_cost := NEW.rebuy_cost;
  END IF;

  IF COALESCE(NEW.rebuy_chips, 0) <= 0 THEN
    v_changed := v_changed || jsonb_build_object('rebuy_chips',
      jsonb_build_object('from', NEW.rebuy_chips, 'to', v_stack));
    NEW.rebuy_chips := v_stack;
  END IF;

  IF COALESCE(NEW.addon_chips, 0) <= 0 THEN
    v_changed := v_changed || jsonb_build_object('addon_chips',
      jsonb_build_object('from', NEW.addon_chips, 'to', v_stack));
    NEW.addon_chips := v_stack;
  END IF;

  IF COALESCE(NEW.rebuy_levels, 0) <= 0 THEN
    v_changed := v_changed || jsonb_build_object('rebuy_levels',
      jsonb_build_object('from', NEW.rebuy_levels, 'to', 4));
    NEW.rebuy_levels := 4;
  END IF;

  IF COALESCE(NEW.addon_levels, 0) <= 0 THEN
    v_changed := v_changed || jsonb_build_object('addon_levels',
      jsonb_build_object('from', NEW.addon_levels, 'to', 1));
    NEW.addon_levels := 1;
  END IF;

  IF NEW.max_rebuys IS NOT NULL AND NEW.max_rebuys <= 0 THEN
    v_changed := v_changed || jsonb_build_object('max_rebuys',
      jsonb_build_object('from', NEW.max_rebuys, 'to', NULL));
    NEW.max_rebuys := NULL;
  END IF;

  IF v_changed <> '{}'::jsonb THEN
    v_op := CASE
      WHEN COALESCE(current_setting('app.freeroll_free_buy_backfill', true), '') = 'on'
        THEN 'BACKFILL'
      ELSE TG_OP
    END;
    BEGIN
      INSERT INTO public.ca_freeroll_free_buy_log
        (tournament_id, tournament_name, op, status, changed)
      VALUES
        (NEW.id, NEW.name, v_op, NEW.status, v_changed);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'fn_freerolls_are_free_buy: could not log % for %: %',
        v_op, NEW.id, SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$function$;
