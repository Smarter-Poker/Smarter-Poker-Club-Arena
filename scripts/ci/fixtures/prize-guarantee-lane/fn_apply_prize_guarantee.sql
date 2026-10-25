CREATE OR REPLACE FUNCTION public.fn_apply_prize_guarantee(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_overlay numeric;
  v_ledger_count integer;
  v_escrow public.tournament_escrow%ROWTYPE;
  v_return jsonb := NULL;
  v_refusal jsonb;
BEGIN
  /* A GUARANTEE IS A FLOOR (2026-10-01). The start-time overlay part that
     money collected since has made unnecessary goes back to its bank before
     the pool is finalized, so the final pool is max(guarantee, collected).
     One subtransaction with the finalization: a refused finalization rolls
     the return back too, and the caller sees the refusal unchanged. */
  BEGIN
    v_return := public.fn_ca_return_excess_start_overlay_locked(p_tournament_id);
    v_result:=public.fn_ca_apply_prize_guarantee_core(
      p_tournament_id,p_source);
    IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE THEN
      v_refusal := v_result;
      RAISE EXCEPTION USING ERRCODE='P0405',
        MESSAGE='guarantee finalization refused; the excess return is rolled back with it';
    END IF;
  EXCEPTION WHEN SQLSTATE 'P0405' THEN
    RETURN v_refusal;
  END;
  v_overlay:=COALESCE((v_result->>'overlay')::numeric,0);
  IF v_overlay::text IN ('NaN','Infinity','-Infinity')
     OR v_overlay<0 OR v_overlay IS DISTINCT FROM round(v_overlay,2) THEN
    RAISE EXCEPTION 'guarantee core returned invalid overlay %',v_overlay
      USING ERRCODE='P0404';
  END IF;
  IF v_overlay>0 THEN
    SELECT count(*) INTO v_ledger_count
      FROM public.chip_ledger l
     WHERE l.idempotency_key=
             'tourney:'||p_tournament_id::text||':guarantee_overlay'
       AND l.tournament_id=p_tournament_id
       AND l.to_type='prize_liability'
       AND l.to_entity_id=p_tournament_id
       AND l.category='overlay'
       AND l.amount=v_overlay
       AND l.from_entity_id=(v_result->>'bank_entity_id')::uuid
       AND l.from_type=CASE WHEN v_result->>'bank_type'='union'
                            THEN 'union_bank' ELSE 'club_treasury' END;
    SELECT * INTO v_escrow
      FROM public.tournament_escrow e
     WHERE e.tournament_id=p_tournament_id
     FOR UPDATE;
    IF v_ledger_count<>1 OR NOT FOUND
       OR COALESCE(v_escrow.enforced,false) IS NOT TRUE
       OR v_result->>'escrow_after' IS NULL
       OR v_escrow.prize_balance IS DISTINCT FROM
            (v_result->>'escrow_after')::numeric THEN
      RAISE EXCEPTION
        'guarantee overlay is not one exact journaled escrow credit'
        USING ERRCODE='P0404';
    END IF;
  END IF;
  RETURN v_result||jsonb_build_object('overlay_journaled',true)
    ||CASE WHEN v_return IS NOT NULL
           THEN jsonb_build_object('excess_overlay_returned',v_return)
           ELSE '{}'::jsonb END;
END;
$function$
