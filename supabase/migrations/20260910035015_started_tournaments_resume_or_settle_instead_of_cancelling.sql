-- Preserve the existing receipt replay and unstarted expiry authority.
-- Dan's never-cancel rule is recorded in tests/unit/tournamentsNeverCancel.test.ts.
DO $migration$
DECLARE
  v_oid oid:=to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)');
  v_body text;
  v_definition text;
  v_guard text:=$guard$  -- A tournament that has started is resumed or settled, never voided.
  -- start_time is a schedule/fill deadline; it is not proof that play began.
  -- The stored receipt above remains replayable without another cancellation.
  IF v_t.started_at IS NOT NULL
     OR upper(COALESCE(v_t.status::text,'')) IN ('RUNNING','BREAK')
     OR COALESCE(v_t.spin_multiplier,0)>0
     OR EXISTS (SELECT 1 FROM public.tournament_launch_receipts r
                 WHERE r.tournament_id=p_tournament_id AND r.completed_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.spin_draw_receipts r
                 WHERE r.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger r
                 WHERE r.tournament_id=p_tournament_id AND r.kind='jackpot_draw')
     OR EXISTS (SELECT 1 FROM public.hand_history hh
                 WHERE hh.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tables tb
                 JOIN public.hand_history hh ON hh.table_id=tb.id
                 WHERE tb.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id=p_tournament_id
                   AND o.kind<>'refund' AND o.amount_paid>0) THEN
    RAISE EXCEPTION
      'Tournament has started or committed awards; resume or settle it instead of cancelling'
      USING ERRCODE='55000';
  END IF;

$guard$;
BEGIN
  SELECT prosrc,pg_get_functiondef(oid) INTO v_body,v_definition
    FROM pg_proc WHERE oid=v_oid;
  IF md5(v_body)='16f0bf17983ec0ced4a8f8127d6af979' THEN RETURN; END IF;
  IF v_body IS NULL OR md5(v_body)<>'6aae8b91e135ac1eac7e6a768b574c13' THEN
    RAISE EXCEPTION 'atomic cancellation source changed; review its composed authority before applying';
  END IF;
  EXECUTE replace(v_definition,v_body,
    replace(v_body,'  -- Freeze every identity before any payer runs.',
      v_guard||'  -- Freeze every identity before any payer runs.'));
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid)<>'16f0bf17983ec0ced4a8f8127d6af979' THEN
    RAISE EXCEPTION 'atomic cancellation refusal body did not match its reviewed definition';
  END IF;
END;
$migration$;
