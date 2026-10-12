-- Reader compatibility only. Existing original compaction functions are used
-- on a captured financial hand in a rolled-back isolated fixture. This does
-- not qualify or invoke the production retention/disposal writer.
SET TIMEZONE='UTC';
DO $test$
DECLARE target uuid; tbl uuid; hn bigint; stack_hand uuid; p cash_hand_provenance_receipts;
 a hand_atomic_commits; request_after jsonb; atomic_after jsonb; cert_kind text;
BEGIN
 SELECT q.ledger_id,s.table_id,(k.result->>'hand_number')::bigint,s.hand_id INTO target,tbl,hn,stack_hand
 FROM union_pnl_original_flows q JOIN ca_settlements s ON s.id=(q.ledger_snapshot->>'settlement_id')::uuid
 JOIN settlement_idempotency_keys k ON k.table_id=s.table_id AND k.hand_id=s.hand_id ORDER BY q.ledger_id LIMIT 1;
 SELECT * INTO STRICT p FROM cash_hand_provenance_receipts WHERE table_id=tbl AND hand_number=hn;
 SELECT * INTO STRICT a FROM hand_atomic_commits WHERE table_id=tbl AND hand_number=hn;
 request_after:=smarter_private.horse_cash_compact_request(p.accepted_request);
 atomic_after:=smarter_private.horse_cash_compact_atomic(p.atomic_receipt);
 IF request_after=p.accepted_request THEN RAISE EXCEPTION 'captured request has no real compaction difference';END IF;
 FOREACH cert_kind IN ARRAY ARRAY['payload','postprune'] LOOP
 BEGIN
 INSERT INTO smarter_private.horse_settlement_key_certificates(table_id,stack_hand_id,hand_number,history_hand_id,manifest_id,
  original_result_sha256,original_request_sha256,compact_result,accounting_evidence_sha256,settled_at)
 VALUES(tbl,stack_hand,hn,p.hand_id,p.manifest_id,
  encode(extensions.digest(convert_to(a.stack_result::text,'UTF8'),'sha256'),'hex'),
  encode(extensions.digest(convert_to((a.stack_result->'request')::text,'UTF8'),'sha256'),'hex'),
  a.stack_result-'request',encode(extensions.digest(convert_to((SELECT evidence::text FROM union_pnl_cash_outcomes WHERE table_id=tbl AND hand_number=hn),'UTF8'),'sha256'),'hex'),a.post_commit_completed_at);
 UPDATE settlement_idempotency_keys SET result=result-'request' WHERE table_id=tbl AND hand_id=stack_hand;
 IF cert_kind='payload' THEN
 INSERT INTO smarter_private.horse_cash_payload_certificates(table_id,hand_number,hand_id,manifest_id,original_request_sha256,
  compact_request_sha256,compact_atomic_sha256,immutable_financial_sha256,accepted_at,settled_at)
 VALUES(tbl,hn,p.hand_id,p.manifest_id,p.payload_hash,
  encode(extensions.digest(convert_to(request_after::text,'UTF8'),'sha256'),'hex'),
  encode(extensions.digest(convert_to(atomic_after::text,'UTF8'),'sha256'),'hex'),
  encode(extensions.digest(convert_to((to_jsonb(p)-ARRAY['accepted_request','atomic_receipt','accepted_at'])::text,'UTF8'),'sha256'),'hex'),p.accepted_at,a.post_commit_completed_at);
 ELSE
 INSERT INTO smarter_private.horse_cash_postprune_certificates(table_id,hand_number,hand_id,manifest_id,original_request_sha256,
  compact_request_sha256,compact_atomic_sha256,immutable_financial_sha256,accepted_at,settled_at)
 VALUES(tbl,hn,p.hand_id,p.manifest_id,p.payload_hash,
  encode(extensions.digest(convert_to(request_after::text,'UTF8'),'sha256'),'hex'),
  encode(extensions.digest(convert_to(atomic_after::text,'UTF8'),'sha256'),'hex'),
  encode(extensions.digest(convert_to((to_jsonb(p)-ARRAY['accepted_request','atomic_receipt','accepted_at'])::text,'UTF8'),'sha256'),'hex'),p.accepted_at,a.post_commit_completed_at);
 END IF;
 UPDATE cash_hand_provenance_receipts SET accepted_request=request_after,atomic_receipt=atomic_after WHERE table_id=tbl AND hand_number=hn;
 IF (SELECT count(*) FROM fn_union_pnl_prove_late_settlement(target))<>1 THEN RAISE EXCEPTION 'qualified compact request/key reader refused';END IF;
 RAISE NOTICE 'PASS actual retained % signed request and compact key keep original late quantity',cert_kind;
 DELETE FROM hand_atomic_commits WHERE table_id=tbl AND hand_number=hn;
 IF (SELECT count(*) FROM fn_union_pnl_prove_late_settlement(target))<>1 THEN RAISE EXCEPTION 'original completed retained boundary refused';END IF;
 RAISE NOTICE 'PASS missing live row uses exact original immutable completion/key certificate, never a fabricated row';
 BEGIN
  UPDATE smarter_private.horse_settlement_key_certificates SET accounting_evidence_sha256=repeat('0',64) WHERE table_id=tbl AND stack_hand_id=stack_hand;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'mismatched original accounting certificate admitted';END IF;
  RAISE EXCEPTION 'rollback negative' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS mismatched original accounting certificate refuses';END;
 BEGIN
  UPDATE settlement_idempotency_keys SET result=p.atomic_receipt->'stack_result' WHERE table_id=tbl AND hand_id=stack_hand;
  UPDATE smarter_private.horse_settlement_key_certificates SET original_result_sha256=repeat('0',64),accounting_evidence_sha256=repeat('0',64) WHERE table_id=tbl AND stack_hand_id=stack_hand;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'raw key with wrong original result/accounting certificate admitted';END IF;
  RAISE EXCEPTION 'rollback negative' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS raw key cannot bypass wrong original result/accounting certificate';END;
 BEGIN
  UPDATE smarter_private.horse_settlement_key_certificates SET settled_at=NULL WHERE table_id=tbl AND stack_hand_id=stack_hand;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'NULL original completion admitted';END IF;
  RAISE EXCEPTION 'rollback negative' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS missing original completion refuses';END;
 BEGIN
  UPDATE smarter_private.horse_settlement_key_certificates SET original_result_sha256=repeat('0',64) WHERE table_id=tbl AND stack_hand_id=stack_hand;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'mismatched original key certificate admitted';END IF;
  RAISE EXCEPTION 'rollback negative' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS mismatched original key certificate refuses';END;
 BEGIN
  DELETE FROM smarter_private.horse_settlement_key_certificates WHERE table_id=tbl AND stack_hand_id=stack_hand;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'missing key/boundary certificate admitted';END IF;
  RAISE EXCEPTION 'rollback negative' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS missing key/boundary certificate refuses';END;
 BEGIN
  UPDATE cash_hand_provenance_receipts SET participants=jsonb_set(participants,'{0,stack_before}','1') WHERE table_id=tbl AND hand_number=hn;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'changed immutable financial original admitted';END IF;
  RAISE EXCEPTION 'rollback negative' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS changed immutable financial original refuses';END;
 BEGIN
  DELETE FROM smarter_private.horse_cash_payload_certificates WHERE table_id=tbl AND hand_number=hn;
  DELETE FROM smarter_private.horse_cash_postprune_certificates WHERE table_id=tbl AND hand_number=hn;
  IF EXISTS(SELECT 1 FROM fn_union_pnl_prove_late_settlement(target)) THEN RAISE EXCEPTION 'missing compact signed certificate admitted';END IF;
  RAISE EXCEPTION 'rollback negative' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS missing compact signed certificate refuses';END;
 RAISE EXCEPTION 'rollback retained fixture' USING ERRCODE='PT002';
 EXCEPTION WHEN SQLSTATE 'PT002' THEN RAISE NOTICE 'PASS retained fixture rolled back';END;
 END LOOP;
 IF (SELECT count(*) FROM union_pnl_original_flows q CROSS JOIN LATERAL fn_union_pnl_prove_late_settlement(q.ledger_id))<>31 THEN RAISE EXCEPTION 'retained fixture changed originals';END IF;
END $test$;
