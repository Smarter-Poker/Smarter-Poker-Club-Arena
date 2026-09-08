-- Run after the stage-one terminal authority is installed. Legacy bounty
-- backpay remains available during the rolling engine cutover and is verified
-- separately before its deferred retirement. The final PASS exception is
-- intentional so the probe cannot preserve locks or accidental mutations.
DO $probe$
DECLARE
  v_settle text;
  v_receipt text;
  v_count integer;
  v_row record;
  v_result jsonb;
  v_replay jsonb;
  v_outcome jsonb;
  v_before jsonb;
  v_after jsonb;
  v_immutable_refused boolean := false;
BEGIN
  IF to_regprocedure(
       'public.fn_complete_tournament_terminal(uuid,uuid,text)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_tournament_terminal_receipt(uuid,uuid)') IS NULL
     OR to_regclass('public.tournament_terminal_settlements') IS NULL
     OR to_regclass('public.tournament_terminal_settlement_cutover') IS NULL THEN
    RAISE EXCEPTION 'FAIL atomic terminal authority or immutable evidence is absent';
  END IF;

  SELECT prosrc INTO v_settle FROM pg_proc
   WHERE oid = 'public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure;
  SELECT prosrc INTO v_receipt FROM pg_proc
   WHERE oid = 'public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure;
  IF (length(v_settle)-length(replace(v_settle,
       'public.fn_settle_tournament_places(','')))
       / length('public.fn_settle_tournament_places(') <> 1
     OR (length(v_settle)-length(replace(v_settle,
       'public.fn_settle_tournament_final_table_deal(','')))
       / length('public.fn_settle_tournament_final_table_deal(') <> 1
     OR v_settle !~ 'IF v_mode = ''places'' THEN'
     OR v_settle !~ 'public.fn_mystery_bounty_settle\('
     OR v_settle !~ 'public.fn_finalize_bounty_pool\('
     OR v_settle !~ 'public.fn_settle_tournament_rake\('
     OR v_settle !~ 'INSERT INTO public.tournament_terminal_settlements'
     OR v_settle !~ 'SET status = ''COMPLETED'''
     OR v_settle ~* 'EXCEPTION\s+WHEN' THEN
    RAISE EXCEPTION 'FAIL installed terminal authority lost its atomic sequence';
  END IF;
  IF v_receipt ~* '\m(insert|update|delete|merge|call|perform)\M'
     OR (SELECT provolatile FROM pg_proc
          WHERE oid = 'public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure)
          <> 's' THEN
    RAISE EXCEPTION 'FAIL terminal replay verifier is not read-only STABLE code';
  END IF;

  IF NOT has_function_privilege(
       'service_role','public.fn_complete_tournament_terminal(uuid,uuid,text)',
       'EXECUTE')
     OR has_function_privilege(
       'anon','public.fn_complete_tournament_terminal(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.fn_complete_tournament_terminal(uuid,uuid,text)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role','public.fn_ca_tournament_terminal_receipt(uuid,uuid)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_settle_tournament_places(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_settle_tournament_final_table_deal(uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_finalize_bounty_pool(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_mystery_bounty_settle(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_settle_tournament_rake(uuid,text)','EXECUTE')
     OR has_table_privilege(
       'service_role','public.tournament_terminal_settlements','SELECT') THEN
    RAISE EXCEPTION 'FAIL terminal service, owner or table privilege boundary changed';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.tournament_terminal_settlement_cutover c
   WHERE c.authority = 'fn_complete_tournament_terminal:v1'
     AND c.migration_version = '20260908065324';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL terminal cutover watermark is not exact';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.tournament_terminal_settlements;
  IF v_count < 1 THEN
    RAISE EXCEPTION 'FAIL terminal completion probe has no real receipt to replay';
  END IF;

  FOR v_row IN
    SELECT h.tournament_id,h.winner_id
      FROM public.tournament_terminal_settlements h
     ORDER BY h.tournament_id
  LOOP
    v_result := public.fn_ca_tournament_terminal_receipt(
      v_row.tournament_id,v_row.winner_id);
    IF v_result->>'ok' IS DISTINCT FROM 'true'
       OR v_result->>'fully_settled' IS DISTINCT FROM 'true'
       OR v_result->>'status' IS DISTINCT FROM 'COMPLETED'
       OR v_result->>'winner_id' IS DISTINCT FROM v_row.winner_id::text
       OR v_result->>'receipt_version' IS DISTINCT FROM '1'
       OR jsonb_typeof(v_result->'deal_shares') <> 'array'
       OR jsonb_typeof(v_result->'table_closure') <> 'object'
       OR (v_result->>'closed_table_count')::integer IS DISTINCT FROM
            (v_result->'table_closure'->>'closed_table_count')::integer
       OR (v_result->>'released_seat_count')::integer IS DISTINCT FROM
            (v_result->'table_closure'->>'released_seat_count')::integer
       OR v_result->'rake'->>'attributed' IS DISTINCT FROM 'true'
       OR (v_result->'escrow'->>'prize_balance')::numeric <> 0
       OR (v_result->'escrow'->>'bounty_balance')::numeric <> 0
       OR (v_result->'escrow'->>'fee_balance')::numeric <> 0 THEN
      RAISE EXCEPTION 'FAIL terminal receipt does not verify: %',v_result;
    END IF;
  END LOOP;

  SELECT h.tournament_id INTO v_row
    FROM public.tournament_terminal_settlements h
   ORDER BY h.tournament_id LIMIT 1;
  IF FOUND THEN
    SELECT jsonb_build_object(
      'payouts',(SELECT count(*) FROM public.tournament_payouts p
                  WHERE p.tournament_id=v_row.tournament_id),
      'obligations',(SELECT count(*) FROM public.tournament_obligations o
                      WHERE o.tournament_id=v_row.tournament_id),
      'wallet_transactions',(SELECT count(*) FROM public.wallet_transactions w
                              WHERE w.related_entity_id=v_row.tournament_id),
      'rake',(SELECT to_jsonb(r) FROM public.tournament_rake_settlements r
               WHERE r.tournament_id=v_row.tournament_id),
      'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e
                 WHERE e.tournament_id=v_row.tournament_id),
      'receipt',(SELECT to_jsonb(h) FROM public.tournament_terminal_settlements h
                  WHERE h.tournament_id=v_row.tournament_id),
      'tables',(SELECT jsonb_agg(to_jsonb(tb) ORDER BY tb.id) FROM public.tables tb
                 WHERE tb.tournament_id=v_row.tournament_id),
      'seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
                 FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
                WHERE tb.tournament_id=v_row.tournament_id))
      INTO v_before;
    SELECT * INTO v_row FROM public.tournament_terminal_settlements h
     WHERE h.tournament_id=v_row.tournament_id;
    v_result := public.fn_complete_tournament_terminal(
      v_row.tournament_id,v_row.winner_id,v_row.settlement_mode);
    v_replay := public.fn_complete_tournament_terminal(
      v_row.tournament_id,v_row.winner_id,v_row.settlement_mode);
    v_outcome := public.fn_resolve_tournament_terminal_outcome(
      v_row.tournament_id,v_row.winner_id,v_row.settlement_mode);
    SELECT jsonb_build_object(
      'payouts',(SELECT count(*) FROM public.tournament_payouts p
                  WHERE p.tournament_id=v_row.tournament_id),
      'obligations',(SELECT count(*) FROM public.tournament_obligations o
                      WHERE o.tournament_id=v_row.tournament_id),
      'wallet_transactions',(SELECT count(*) FROM public.wallet_transactions w
                              WHERE w.related_entity_id=v_row.tournament_id),
      'rake',(SELECT to_jsonb(r) FROM public.tournament_rake_settlements r
               WHERE r.tournament_id=v_row.tournament_id),
      'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e
                 WHERE e.tournament_id=v_row.tournament_id),
      'receipt',(SELECT to_jsonb(h) FROM public.tournament_terminal_settlements h
                  WHERE h.tournament_id=v_row.tournament_id),
      'tables',(SELECT jsonb_agg(to_jsonb(tb) ORDER BY tb.id) FROM public.tables tb
                 WHERE tb.tournament_id=v_row.tournament_id),
      'seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
                 FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
                WHERE tb.tournament_id=v_row.tournament_id))
      INTO v_after;
    IF v_replay IS DISTINCT FROM v_result
       OR v_replay::text IS DISTINCT FROM v_result::text
       OR v_before IS DISTINCT FROM v_after
       OR COALESCE((v_outcome->>'terminal_committed')::boolean,false) IS NOT TRUE
       OR v_outcome->'receipt' IS DISTINCT FROM v_result THEN
      RAISE EXCEPTION 'FAIL wrapper replay or serialized outcome changed durable state';
    END IF;
    BEGIN
      UPDATE public.tournament_terminal_settlements
         SET settled_at = settled_at
       WHERE tournament_id = v_row.tournament_id;
    EXCEPTION WHEN restrict_violation THEN
      v_immutable_refused := true;
    END;
    IF NOT v_immutable_refused THEN
      RAISE EXCEPTION 'FAIL immutable terminal receipt accepted an update';
    END IF;
  END IF;

  RAISE EXCEPTION
    'AUDIT_TEST_PASS: stage-one terminal cash, bounty, mystery, attributed rake, exact escrow/table closure, byte-identical wrapper replay, serialized outcome and service ACL pass; all probe work rolled back';
END;
$probe$;
