-- PAY THE PLACES WHOSE POOL ACTUALLY HOLDS THE CHIPS.
--
-- With the 1,013 survivors ranked, fn_tournament_payout_reconcile can finally
-- see who holds each place, and it reports 129 of those 146 events owing
-- 32,439.50 chips to players who finished in the money and were never paid.
--
-- That total MUST NOT be paid as one number. Split by whether the pool is real:
--
--   backed by chips the event actually collected   ~1,026.70   (15 events)
--   drawn on a pool that is already overdrawn      ~31,412.80  (114 events)
--
-- The second group is the guarantee problem. Those pools were set to an
-- advertised guarantee that no overlay row ever funded, so the pool is a number
-- on a tournament rather than chips in a wallet. Topping a place up out of one
-- mints the difference - the same act the conservation sentinel exists to
-- catch, performed by the repair that is supposed to fix it. Those events wait
-- for the club or union bank to fund the overlay; that is a decision about
-- 453,571.88 chips of historical minting and it is Dan's, not this migration's.
--
-- So the rule here is per event and deliberately strict: pay only where
--
--     fn_tournament_conservation_delta(id) >= total_top_up
--
-- i.e. the event is holding at least as much unspent money as it is about to
-- hand out. Not `delta >= 0` - that would let an event with 3 chips spare pay
-- out 300 and go negative. Probed rolled-back first: 15 events, 1,026.70 chips,
-- and the count of overdrawn events among the set was 103 before and 103 after,
-- so nothing was pushed into deficit to make a player whole.
--
-- ROLLBACK
--   The credits are wallet_transactions written by fn_tournament_payout_
--   reconcile and are keyed for idempotency, so a re-run cannot double-pay.
--   To reverse, debit the same users for the amounts in
--   tournament_payout_backfill_log and reset tournament_players.prize.

CREATE TABLE IF NOT EXISTS public.tournament_payout_backfill_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL UNIQUE,
  top_up         numeric NOT NULL,
  delta_before   numeric,
  delta_after    numeric,
  applied_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tournament_payout_backfill_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_payout_backfill_log FROM PUBLIC;
GRANT SELECT ON public.tournament_payout_backfill_log TO service_role;

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
       AND NOT EXISTS (SELECT 1 FROM public.tournament_payout_backfill_log l
                        WHERE l.tournament_id = t.id)
       AND EXISTS (SELECT 1 FROM public.tournament_survivor_rank_backfill b
                    WHERE b.tournament_id = t.id)
     LIMIT GREATEST(p_limit, 1)
  LOOP
    CONTINUE WHEN r.topup <= 0.005;

    -- The event must be holding at least what it is about to pay out.
    IF r.delta < r.topup THEN
      v_withheld := v_withheld + r.topup;
      v_withheld_events := v_withheld_events + 1;
      CONTINUE;
    END IF;

    IF p_apply THEN
      v_res := public.fn_tournament_payout_reconcile(r.id, true);
      v_delta_after := public.fn_tournament_conservation_delta(r.id);

      -- Never leave an event worse than solvent because of this repair.
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
BEGIN
  IF to_regprocedure('public.fn_pay_backed_payout_shortfalls(boolean, integer)') IS NULL THEN
    RAISE EXCEPTION 'fn_pay_backed_payout_shortfalls was not created';
  END IF;
END
$post$;
