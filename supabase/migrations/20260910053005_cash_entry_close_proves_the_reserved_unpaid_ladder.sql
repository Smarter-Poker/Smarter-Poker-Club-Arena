-- The final cash result cache and the terminal payer must name the same
-- reserved pool. This changes no payout amount, wallet, or settlement policy.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';

DO $reprice_prerequisites$
DECLARE
  v_target regprocedure := to_regprocedure('public.fn_complete_tournament_entry_reprice(uuid)');
  v_amounts regprocedure := to_regprocedure('public.fn_ca_tournament_place_amounts(uuid)');
  v_body text;
BEGIN
  -- Replacement must never create a fresh PUBLIC-executable definer. Accept
  -- only the independently observed original or this exact idempotent result.
  IF v_target IS NULL OR v_amounts IS NULL
     OR to_regprocedure('public.fn_safe_jsonb_array(text)') IS NULL
     OR to_regprocedure('public.fn_tournament_place_prize_exact(numeric,text,integer)') IS NULL
     OR to_regclass('public.tournament_entry_close_receipts') IS NULL THEN
    RAISE EXCEPTION 'cash entry reprice prerequisite function or receipt table is missing';
  END IF;
  SELECT md5(prosrc) INTO v_body FROM pg_proc WHERE oid=v_target;
  IF v_body NOT IN ('51c598a2fdb9a805485dec239eb70169','784df9021f906ca9e42e43942b692e2f')
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_amounts)
        <> '8f6cde5f5b799949506259f3064568b9' THEN
    RAISE EXCEPTION 'cash entry reprice source prerequisite changed';
  END IF;
  IF NOT COALESCE((SELECT prosecdef AND prorettype='jsonb'::regtype
                 AND proconfig @> ARRAY['search_path=public, pg_temp']
            FROM pg_proc WHERE oid=v_target),false)
     OR has_function_privilege('anon',v_target,'EXECUTE')
     OR has_function_privilege('authenticated',v_target,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_target,'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_proc p,
         LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.oid=v_target AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN
    RAISE EXCEPTION 'cash entry reprice existing security contract is unexpected';
  END IF;
  PERFORM set_config('ca.cash_entry_reprice_acl',
    (SELECT proacl::text FROM pg_proc WHERE oid=v_target),true);
END;
$reprice_prerequisites$;

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

DO $reprice_postconditions$
DECLARE
  v_target regprocedure := to_regprocedure('public.fn_complete_tournament_entry_reprice(uuid)');
BEGIN
  IF NOT COALESCE((SELECT md5(prosrc)='784df9021f906ca9e42e43942b692e2f'
                 AND prosecdef AND prorettype='jsonb'::regtype
                 AND proconfig @> ARRAY['search_path=public, pg_temp']
                 AND proacl::text IS NOT DISTINCT FROM
                     current_setting('ca.cash_entry_reprice_acl')
            FROM pg_proc WHERE oid=v_target),false)
     OR has_function_privilege('anon',v_target,'EXECUTE')
     OR has_function_privilege('authenticated',v_target,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_target,'EXECUTE') THEN
    RAISE EXCEPTION 'cash entry reprice replacement body or ACL postcondition failed';
  END IF;
END;
$reprice_postconditions$;

COMMIT;
