-- The final cash result cache and the terminal payer must name the same
-- reserved pool. This changes no payout amount, wallet, or settlement policy.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_entry_reprice(
  p_tournament_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_receipt public.tournament_entry_close_receipts%ROWTYPE;
  v_mismatch integer;
BEGIN
  -- Match the lock order used by close/finalize and the satellite entitlement
  -- workflow: tournament first, then its child receipt. Taking these in the
  -- opposite order lets a close replay (tournament -> receipt) deadlock a
  -- completion attempt (receipt -> tournament) exactly when recovery is trying
  -- to prove the durable obligation complete.
  SELECT * INTO v_t
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;

  SELECT * INTO v_receipt
    FROM public.tournament_entry_close_receipts r
   WHERE r.tournament_id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','receipt_missing'); END IF;
  IF v_receipt.reprice_completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'already_completed',true,'mismatches',0);
  END IF;
  IF COALESCE(v_t.prize_pool_finalized,false) IS NOT TRUE
     OR round(COALESCE(v_t.prize_pool,0),2)<>round(v_receipt.final_prize_pool,2)
     OR public.fn_safe_jsonb_array(v_t.payout_structure::text)
        IS DISTINCT FROM v_receipt.payout_structure_snapshot THEN
    RETURN jsonb_build_object('ok',false,'reason','final_pool_or_structure_drifted');
  END IF;

  IF lower(COALESCE(v_t.variant,''))='satellite'
     OR upper(COALESCE(v_t.tournament_type,''))='SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    -- Satellite closeout remains under its existing seat-award contract.
    SELECT count(*)::integer INTO v_mismatch
      FROM public.tournament_players tp
      CROSS JOIN LATERAL (
        SELECT public.fn_tournament_place_prize_exact(
          v_receipt.final_prize_pool,
          v_receipt.payout_structure_snapshot::text,
          tp.position) AS expected
      ) entitlement
     WHERE tp.tournament_id=p_tournament_id
       AND tp.status='eliminated'
       AND (
         -- An eliminated row without its finishing place is unfinished causal
         -- work, not a zero-dollar entitlement. Letting it disappear from this
         -- proof would retire the close receipt before any later process can
         -- know which place must be repriced.
         tp.position IS NULL
         OR round(COALESCE(tp.prize,0),2) IS DISTINCT FROM round(entitlement.expected,2)
         OR (
           entitlement.expected>0
           AND (
             SELECT round(COALESCE(sum(p.amount),0),2)
               FROM public.tournament_payouts p
              WHERE p.tournament_id=p_tournament_id
                AND p.user_id=tp.user_id
                AND p.position=tp.position
                AND COALESCE(p.source,'')<>'satellite_seat'
           ) IS DISTINCT FROM round(entitlement.expected,2)
         )
       );
  ELSE
    -- Entry closure proves the cached result facts, not payment. Cash places
    -- are paid only by the terminal authority, so requiring a payout here
    -- leaves every positive unpaid finisher pending forever. Derive once with
    -- that same authority, including its final-field trim and Bubble reserve.
    WITH amounts AS MATERIALIZED (
      SELECT place,amount
        FROM public.fn_ca_tournament_place_amounts(p_tournament_id)
    )
    SELECT count(*)::integer INTO v_mismatch
      FROM public.tournament_players tp
      LEFT JOIN amounts a ON a.place=tp.position
     WHERE tp.tournament_id=p_tournament_id
       AND tp.status='eliminated'
       AND (tp.position IS NULL
            OR tp.prize IS DISTINCT FROM COALESCE(a.amount,0));
  END IF;
  IF v_mismatch>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','reprice_incomplete','mismatches',v_mismatch);
  END IF;

  UPDATE public.tournament_entry_close_receipts
     SET reprice_completed_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE tournament_id=p_tournament_id;
  RETURN jsonb_build_object('ok',true,'completed',true,'mismatches',0);
END;
$function$;

COMMIT;
