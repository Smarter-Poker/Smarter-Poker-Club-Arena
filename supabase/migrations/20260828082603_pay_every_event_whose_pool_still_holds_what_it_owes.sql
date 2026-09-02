-- PAY EVERY EVENT WHOSE POOL STILL HOLDS WHAT IT OWES.
--
-- fn_pay_backed_payout_shortfalls was written this morning scoped to the 146
-- events whose survivors had just been ranked. The rule it applies - pay only
-- when fn_tournament_conservation_delta >= total_top_up, so an event can never
-- be pushed into deficit to make a player whole - is not specific to that set.
-- It is the correct rule for any completed event, and there are events outside
-- that set sitting on money they collected and never paid out.
--
-- A CORRECTION TO AN EARLIER NUMBER. I reported 206,116 chips as "stranded -
-- players' money collected and never paid out". That was wrong, and wrong in
-- the direction that matters: 204,872 of it is SPIN, and a Spin measured by the
-- naive conservation delta is meaningless. A 2x Spin collects 3 buy-ins and
-- pays out 2 BY DESIGN; the difference is not stranded, it is the Reserve Pool
-- contribution, banked in spin_reserve_ledger. Measured properly:
--
--     positive spin deltas   +204,880.12   (2x/3x games funding the reserve)
--     negative spin deltas   -171,789.44   (high multipliers drawing on it)
--     net spin delta          +33,090.68
--     reserve net flow        +39,457.94
--
-- The two sides net out to within 6,367.26 across 23,000+ events. That residual
-- deserves its own look, but it is not 204,872 of missing player money, and
-- calling it that was measuring one format with another format's yardstick.
-- This is precisely why fn_tournament_money_conservation excludes
-- variant='spin'.
--
-- A further 1,381.50 across 7 events is SATELLITE, which awards seats rather
-- than cash - fn_tournament_payout_reconcile skips satellites for that reason
-- and so does this.
--
-- The genuinely unexplained remainder is 1,110.87 across 17 events, of which
-- the reconciler identifies 819.56 as owed to identifiable finishers. Of that,
-- only 41.46 sits in events that still HOLD the chips; the other 778.10 is in
-- pools inflated by an unfunded guarantee and is withheld, because paying out
-- of one mints.
--
-- WHAT CHANGES: the scope predicate drops the survivor-backfill restriction and
-- gains explicit satellite and spin exclusions. Everything protective is kept
-- exactly - the delta >= top_up rule, the post-payment refusal if conservation
-- would go negative, and the per-event log that makes a second run a no-op.

CREATE OR REPLACE FUNCTION public.fn_pay_backed_payout_shortfalls(
  p_apply boolean DEFAULT false,
  p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record; v_res jsonb;
  v_paid numeric := 0; v_events integer := 0;
  v_withheld numeric := 0; v_withheld_events integer := 0;
  v_delta_after numeric;
BEGIN
  FOR r IN
    SELECT t.id,
           COALESCE((public.fn_tournament_payout_reconcile(t.id, false)->>'total_top_up')::numeric, 0) AS topup,
           public.fn_tournament_conservation_delta(t.id) AS delta
      FROM public.tournaments t
     WHERE t.status = 'COMPLETED'
       -- Satellites award seats, not cash.
       AND COALESCE(t.variant, '') <> 'satellite'
       -- A Spin's pool is funded by the reserve, not by this game's own
       -- collections, so its delta does not mean what it means elsewhere.
       AND COALESCE(t.variant, '') <> 'spin'
       AND NOT EXISTS (SELECT 1 FROM public.tournament_payout_backfill_log l
                        WHERE l.tournament_id = t.id)
       -- Filter the debt in the query, not after the limit.
       AND public.fn_tournament_conservation_delta(t.id) > 0.01
     ORDER BY t.ended_at ASC NULLS LAST
     LIMIT GREATEST(p_limit, 1)
  LOOP
    CONTINUE WHEN r.topup <= 0.005;

    -- The event must hold at least what it is about to pay. Not `delta >= 0` -
    -- that would let an event with 3 chips spare pay out 300.
    IF r.delta < r.topup THEN
      v_withheld := v_withheld + r.topup;
      v_withheld_events := v_withheld_events + 1;
      CONTINUE;
    END IF;

    IF p_apply THEN
      v_res := public.fn_tournament_payout_reconcile(r.id, true);
      v_delta_after := public.fn_tournament_conservation_delta(r.id);
      IF v_delta_after < -0.01 THEN
        RAISE EXCEPTION 'paying % would leave conservation at %; refusing', r.id, v_delta_after;
      END IF;
      INSERT INTO public.tournament_payout_backfill_log
        (tournament_id, top_up, delta_before, delta_after)
      VALUES (r.id, COALESCE((v_res->>'total_top_up')::numeric, r.topup), r.delta, v_delta_after)
      ON CONFLICT (tournament_id) DO NOTHING;
      v_paid := v_paid + COALESCE((v_res->>'total_top_up')::numeric, 0);
    ELSE
      v_paid := v_paid + r.topup;
    END IF;
    v_events := v_events + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
    'events_paid', v_events, 'chips_paid', round(v_paid, 2),
    'events_withheld_unfunded_pool', v_withheld_events,
    'chips_withheld_unfunded_pool', round(v_withheld, 2));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer) TO service_role;

DO $post$
DECLARE v_res jsonb;
BEGIN
  v_res := public.fn_pay_backed_payout_shortfalls(false, 500);
  IF (v_res->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'dry run failed: %', v_res;
  END IF;
END
$post$;
