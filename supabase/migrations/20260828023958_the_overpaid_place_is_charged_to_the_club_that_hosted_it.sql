-- THE OVERPAID PLACE IS CHARGED TO THE CLUB THAT HOSTED IT.
--
-- 259 duplicate finishing places were renumbered by
-- a_finishing_place_is_renumbered_not_shared. 19 of the demoted rows had
-- already collected a prize larger than their corrected place is worth:
-- 190.22 chips that were minted out of nothing when the same place paid twice.
-- Dan, 2026-08-28: no clawback from players; the hosting club absorbs it.
--
--   Midway Union  126.82   SHARK CLUB  34.40   Club JAQK  29.00
--
-- WHY THIS IS A DRAINING QUEUE AND NOT THREE UPDATE STATEMENTS. The canonical
-- treasury is clubs.chip_treasury and fn_debit_treasury REFUSES a debit that
-- would overdraw it. Midway Union sits at -4,346.80 today from funding
-- advertised guarantees, so its 126.82 cannot be taken now and will not be
-- takeable until the weekly 90% rakeback close puts union rake back. Writing
-- the debit anyway means bypassing a guard that is correct; leaving it "for
-- later" by hand means it never happens. So the obligation is recorded per
-- club, the charge is attempted whenever the sweep runs, and a row leaves the
-- queue only when a debit actually succeeded.
--
-- THE DEBT IS FILTERED IN THE QUERY (charged_at IS NULL AND overpaid > 0.005).
-- Selecting a page of rows and discovering afterwards that they owe nothing is
-- what starved the Heads-Up back-pay: every pass reported success while an
-- oldest-first queue never advanced.
--
-- WATCH clubs.chip_treasury, NOT club_wallets.chip_balance. They are different
-- pools and they disagree - for Midway Union, -4,346.80 against 1,019,914.65.
-- Reading the wrong one says the treasury is healthy while the money path that
-- matters is overdrawn. This was written after doing exactly that.
--
-- ROLLBACK
--   Charges already made are real chip_transactions rows of type
--   'treasury_debit'; reverse with fn_credit_treasury for the same amounts and
--   reason before dropping anything.
--   DROP FUNCTION public.fn_charge_place_overpays(integer);
--   DROP TABLE public.tournament_place_overpay_charges;

CREATE TABLE IF NOT EXISTS public.tournament_place_overpay_charges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL,
  club_id        uuid,
  user_id        uuid NOT NULL,
  old_position   integer NOT NULL,
  new_position   integer NOT NULL,
  prize_paid     numeric NOT NULL,
  entitled       numeric NOT NULL,
  overpaid       numeric NOT NULL,
  charged_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_place_overpay_uncharged
  ON public.tournament_place_overpay_charges (club_id)
  WHERE charged_at IS NULL;

ALTER TABLE public.tournament_place_overpay_charges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_place_overpay_charges FROM PUBLIC;
GRANT SELECT ON public.tournament_place_overpay_charges TO service_role;

-- What one place is worth in one event. The column is sometimes a json array
-- and sometimes a string holding one, so normalise before reading it, and
-- treat anything that is neither as "this place pays nothing" rather than
-- letting a cast error abort the sweep.
CREATE OR REPLACE FUNCTION public.fn_place_entitlement(
  p_pool numeric, p_structure anyelement, p_place integer)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_raw jsonb; v_arr jsonb; v_pct numeric;
BEGIN
  IF p_place IS NULL OR COALESCE(p_pool, 0) <= 0 THEN
    RETURN 0;
  END IF;
  BEGIN
    v_raw := to_jsonb(p_structure);
    IF jsonb_typeof(v_raw) = 'string' THEN
      v_arr := (v_raw #>> '{}')::jsonb;
    ELSE
      v_arr := v_raw;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN 0;
  END;
  IF v_arr IS NULL OR jsonb_typeof(v_arr) <> 'array' THEN
    RETURN 0;
  END IF;
  SELECT (el->>'percentage')::numeric INTO v_pct
    FROM jsonb_array_elements(v_arr) el
   WHERE (el->>'place')::int = p_place
   LIMIT 1;
  RETURN round(COALESCE(p_pool, 0) * COALESCE(v_pct, 0) / 100.0, 2);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_charge_place_overpays(p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club record; v_res jsonb;
  v_charged numeric := 0; v_clubs integer := 0;
  v_blocked numeric := 0; v_blocked_clubs integer := 0;
  v_owed_before numeric; v_owed_after numeric;
BEGIN
  INSERT INTO public.tournament_place_overpay_charges
    (tournament_id, club_id, user_id, old_position, new_position,
     prize_paid, entitled, overpaid)
  SELECT r.tournament_id, t.club_id, r.user_id, r.old_position, r.new_position,
         r.prize_paid,
         public.fn_place_entitlement(t.prize_pool, t.payout_structure, r.new_position),
         round(GREATEST(r.prize_paid - public.fn_place_entitlement(
           t.prize_pool, t.payout_structure, r.new_position), 0), 2)
    FROM public.tournament_place_renumbers r
    JOIN public.tournaments t ON t.id = r.tournament_id
  ON CONFLICT (tournament_id, user_id) DO NOTHING;

  SELECT COALESCE(sum(overpaid), 0) INTO v_owed_before
    FROM public.tournament_place_overpay_charges
   WHERE charged_at IS NULL AND overpaid > 0.005;

  FOR v_club IN
    SELECT club_id, round(sum(overpaid), 2) AS owed
      FROM public.tournament_place_overpay_charges
     WHERE charged_at IS NULL AND overpaid > 0.005 AND club_id IS NOT NULL
     GROUP BY club_id
     ORDER BY 2 DESC
     LIMIT GREATEST(p_limit, 1)
  LOOP
    v_res := public.fn_debit_treasury(
      v_club.club_id, v_club.owed,
      'Duplicate finishing place paid twice; overpay absorbed by club treasury',
      jsonb_build_object('source', 'fn_charge_place_overpays'));

    IF COALESCE((v_res->>'success')::boolean, false) THEN
      UPDATE public.tournament_place_overpay_charges
         SET charged_at = now()
       WHERE club_id = v_club.club_id AND charged_at IS NULL AND overpaid > 0.005;
      v_charged := v_charged + v_club.owed;
      v_clubs := v_clubs + 1;
    ELSE
      v_blocked := v_blocked + v_club.owed;
      v_blocked_clubs := v_blocked_clubs + 1;
    END IF;
  END LOOP;

  -- Second measurement. A pass that says it charged something must also be
  -- able to show the queue got smaller.
  SELECT COALESCE(sum(overpaid), 0) INTO v_owed_after
    FROM public.tournament_place_overpay_charges
   WHERE charged_at IS NULL AND overpaid > 0.005;

  RETURN jsonb_build_object('ok', true,
    'owed_before', round(v_owed_before, 2), 'owed_after', round(v_owed_after, 2),
    'charged', round(v_charged, 2), 'clubs_charged', v_clubs,
    'blocked_insufficient_treasury', round(v_blocked, 2),
    'clubs_blocked', v_blocked_clubs);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_charge_place_overpays(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_charge_place_overpays(integer) TO service_role;

DO $post$
DECLARE v_t numeric;
BEGIN
  IF to_regclass('public.tournament_place_overpay_charges') IS NULL THEN
    RAISE EXCEPTION 'tournament_place_overpay_charges was not created';
  END IF;
  IF to_regprocedure('public.fn_charge_place_overpays(integer)') IS NULL THEN
    RAISE EXCEPTION 'fn_charge_place_overpays was not created';
  END IF;
  -- The entitlement helper must read a real structure, not silently return 0
  -- for everything, or every renumbered row would look fully overpaid.
  SELECT public.fn_place_entitlement(
           100::numeric,
           '[{"place":1,"percentage":40},{"place":2,"percentage":25}]'::jsonb,
           2) INTO v_t;
  IF v_t IS DISTINCT FROM 25.00 THEN
    RAISE EXCEPTION 'fn_place_entitlement returned % for place 2 of a 40/25 structure on a pool of 100; expected 25.00', v_t;
  END IF;
END
$post$;
