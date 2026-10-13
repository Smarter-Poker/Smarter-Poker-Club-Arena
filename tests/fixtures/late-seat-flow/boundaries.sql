SET TIMEZONE='UTC';
DO $test$
DECLARE target uuid; tbl uuid; hn bigint; usr uuid; funding uuid; baseline bigint;
BEGIN
 SELECT q.ledger_id,s.table_id,(k.result->>'hand_number')::bigint,
  CASE WHEN q.ledger_snapshot->>'to_type'='player_wallet' THEN (q.ledger_snapshot->>'to_entity_id')::uuid ELSE (q.ledger_snapshot->>'from_entity_id')::uuid END
 INTO target,tbl,hn,usr FROM union_pnl_original_flows q JOIN ca_settlements s ON s.id=(q.ledger_snapshot->>'settlement_id')::uuid
 JOIN settlement_idempotency_keys k ON k.table_id=s.table_id AND k.hand_id=s.hand_id ORDER BY q.ledger_id LIMIT 1;
 SELECT (x->'funding_receipt_ids'->>0)::uuid INTO funding FROM union_pnl_cash_outcomes o CROSS JOIN LATERAL jsonb_array_elements(o.evidence->'participants') x
 WHERE o.table_id=tbl AND o.hand_number=hn AND x->>'user_id'=usr::text;
 IF target IS NULL OR funding IS NULL OR (SELECT count(*) FROM fn_union_pnl_prove_late_settlement(target))<>1 THEN RAISE EXCEPTION 'baseline target unavailable';END IF;
 BEGIN
  UPDATE chip_ledger SET amount=amount+1 WHERE id=target;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: posted ledger drift';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS posted ledger drift';END;
 BEGIN
  UPDATE wallet_credit_idempotency SET amount=amount+1 WHERE key=(SELECT ledger_snapshot->>'idempotency_key' FROM union_pnl_original_flows WHERE ledger_id=target);
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: wallet wrong amount';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS wallet wrong amount';END;
 BEGIN
  UPDATE wallet_credit_idempotency SET amount=NULL WHERE key=(SELECT ledger_snapshot->>'idempotency_key' FROM union_pnl_original_flows WHERE ledger_id=target);
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: wallet NULL amount';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS wallet NULL amount';END;
 BEGIN
  UPDATE ca_settlements SET state='failed' WHERE id=(SELECT ledger_snapshot->>'settlement_id' FROM union_pnl_original_flows WHERE ledger_id=target)::uuid;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: settlement failed';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS settlement failed';END;
 BEGIN
  UPDATE ca_settlements SET totals=jsonb_set(totals,'{ref}','"wrong"') WHERE table_id=tbl AND hand_id=(SELECT split_part(ledger_snapshot->>'idempotency_key',':',2)::uuid FROM union_pnl_original_flows WHERE ledger_id=target);
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: legacy ref disagrees';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS legacy ref disagrees';END;
 BEGIN
  UPDATE settlement_idempotency_keys SET status='failed' WHERE table_id=tbl AND (result->>'hand_number')::bigint=hn;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: claim failed';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS claim failed';END;
 BEGIN
  UPDATE hand_atomic_commits SET post_commit_result=jsonb_set(post_commit_result,'{ok}','false') WHERE table_id=tbl AND hand_number=hn;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: postcommit false';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS postcommit false';END;
 BEGIN
  UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{conservation_checked}','false') WHERE table_id=tbl AND hand_number=hn;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: conservation false';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS conservation false';END;
 BEGIN
  UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{departed}',(stack_result->'departed')||(stack_result->'departed')) WHERE table_id=tbl AND hand_number=hn;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: duplicate departed identity';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS duplicate departed identity';END;
 BEGIN
  UPDATE cash_hand_provenance_receipts SET accepted_request=jsonb_set(accepted_request,'{inflow}','1') WHERE table_id=tbl AND hand_number=hn;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: signed request hash drift';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS signed request hash drift';END;
 BEGIN
  UPDATE cash_hand_provenance_receipts SET participants=(SELECT jsonb_agg(CASE WHEN x->>'user_id'=usr::text THEN jsonb_set(x,'{stack_before}','null') ELSE x END) FROM jsonb_array_elements(participants) x) WHERE table_id=tbl AND hand_number=hn;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: original participant NULL stack';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS original participant NULL stack';END;
 BEGIN
  UPDATE cash_hand_provenance_receipts SET participants=(SELECT jsonb_agg(CASE WHEN x->>'user_id'=usr::text THEN jsonb_set(x,'{stack_before}','"12.00"') ELSE x END) FROM jsonb_array_elements(participants) x) WHERE table_id=tbl AND hand_number=hn;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: original participant string stack';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS original participant string stack';END;
 BEGIN
  UPDATE cash_hand_provenance_receipts SET participants=(SELECT jsonb_agg(CASE WHEN x->>'user_id'=usr::text THEN jsonb_set(x,'{stack_before}','12.001') ELSE x END) FROM jsonb_array_elements(participants) x) WHERE table_id=tbl AND hand_number=hn;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: original participant subcent stack';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS original participant subcent stack';END;
 BEGIN
  UPDATE cash_participant_funding_receipts SET user_id='00000000-0000-0000-0000-000000000099' WHERE id=funding;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: original funding wrong owner';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS original funding wrong owner';END;
 BEGIN
  UPDATE cash_participant_funding_receipts SET amount=NULL WHERE id=funding;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: original funding NULL amount';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS original funding NULL amount';END;
 BEGIN
  UPDATE cash_participant_funding_receipts SET amount=amount+0.001 WHERE id=funding;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: original funding subcent';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS original funding subcent';END;
 BEGIN
  UPDATE cash_participant_funding_receipts SET balance_after=balance_after+1 WHERE id=funding;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: original funding balance disagreement';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS original funding balance disagreement';END;
 BEGIN
  UPDATE cash_participant_funding_receipts SET source_ledger_id=NULL WHERE id=funding;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: original funding missing ledger';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS original funding missing ledger';END;
 BEGIN
  UPDATE cash_participant_funding_receipts SET funding_union_id='00000000-0000-0000-0000-000000000099' WHERE id=funding;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: original funding wrong union';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS original funding wrong union';END;
 BEGIN
  UPDATE union_pnl_cash_outcomes SET game_scope=jsonb_set(game_scope,'{game_union_id}','"00000000-0000-0000-0000-000000000099"') WHERE table_id=tbl AND hand_number=hn;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'negative admitted: scope disagreement';END IF;
  RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS scope disagreement';END;
 BEGIN
 UPDATE cash_participant_funding_receipts SET table_id='00000000-0000-0000-0000-000000000099' WHERE id=funding;
 IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'wrong funding table_id admitted';END IF;
 RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS wrong funding table_id';END;
 BEGIN
 UPDATE cash_participant_funding_receipts SET seat_id='00000000-0000-0000-0000-000000000099' WHERE id=funding;
 IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'wrong funding seat_id admitted';END IF;
 RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS wrong funding seat_id';END;
 BEGIN
 UPDATE cash_participant_funding_receipts SET occupancy_id='00000000-0000-0000-0000-000000000099' WHERE id=funding;
 IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'wrong funding occupancy_id admitted';END IF;
 RAISE EXCEPTION 'qualified negative rollback' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS wrong funding occupancy_id';END;
 IF (SELECT count(*) FROM union_pnl_original_flows q CROSS JOIN LATERAL fn_union_pnl_prove_late_settlement(q.ledger_id))<>31 THEN RAISE EXCEPTION 'negative rollback changed originals';END IF;
 RAISE NOTICE 'PASS 23 refusals rolled back; all 31 originals still proved';
END $test$;
