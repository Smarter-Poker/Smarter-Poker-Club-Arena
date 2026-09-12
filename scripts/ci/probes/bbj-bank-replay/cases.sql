CREATE TEMP TABLE results(name text,actual jsonb,expected jsonb,passed boolean);
DO $test$ DECLARE c record; actual jsonb; BEGIN
 FOR c IN SELECT * FROM (VALUES
('identical_after_depletion','00000000-0000-0000-0000-000000000001'::uuid,'main','backup','10'::numeric,'original accepted reason','replay-op','{"ok": true, "replayed": true, "move_id": 1, "amount": 10}'::jsonb),
('mismatch_pool','00000000-0000-0000-0000-000000000002'::uuid,'main','backup','10'::numeric,'original accepted reason','replay-op','{"ok": false, "reason": "op_id_payload_mismatch"}'::jsonb),
('mismatch_from','00000000-0000-0000-0000-000000000001'::uuid,'promo','backup','10'::numeric,'original accepted reason','replay-op','{"ok": false, "reason": "op_id_payload_mismatch"}'::jsonb),
('mismatch_to','00000000-0000-0000-0000-000000000001'::uuid,'main','promo','10'::numeric,'original accepted reason','replay-op','{"ok": false, "reason": "op_id_payload_mismatch"}'::jsonb),
('mismatch_reverse','00000000-0000-0000-0000-000000000001'::uuid,'backup','main','10'::numeric,'original accepted reason','replay-op','{"ok": false, "reason": "op_id_payload_mismatch"}'::jsonb),
('mismatch_amount','00000000-0000-0000-0000-000000000001'::uuid,'main','backup','10.01'::numeric,'original accepted reason','replay-op','{"ok": false, "reason": "op_id_payload_mismatch"}'::jsonb),
('mismatch_rounding_boundary','00000000-0000-0000-0000-000000000001'::uuid,'main','backup','10.005'::numeric,'original accepted reason','replay-op','{"ok": false, "reason": "op_id_payload_mismatch"}'::jsonb),
('mismatch_null_from','00000000-0000-0000-0000-000000000001'::uuid,NULL,'backup','10'::numeric,'original accepted reason','replay-op','{"ok": false, "reason": "op_id_payload_mismatch"}'::jsonb),
('mismatch_null_to','00000000-0000-0000-0000-000000000001'::uuid,'main',NULL,'10'::numeric,'original accepted reason','replay-op','{"ok": false, "reason": "op_id_payload_mismatch"}'::jsonb),
('normalized_equivalent','00000000-0000-0000-0000-000000000001'::uuid,'main','backup','10.004'::numeric,'original accepted reason','replay-op','{"ok": true, "replayed": true, "move_id": 1, "amount": 10}'::jsonb),
('reason_not_bound','00000000-0000-0000-0000-000000000001'::uuid,'main','backup','10'::numeric,'  changed but valid reason  ','replay-op','{"ok": true, "replayed": true, "move_id": 1, "amount": 10}'::jsonb),
('invalid_reason','00000000-0000-0000-0000-000000000001'::uuid,'main','backup','10'::numeric,'short','replay-op','{"ok": false, "reason": "a_bank_move_needs_a_reason_and_an_op_id"}'::jsonb),
('invalid_bank','00000000-0000-0000-0000-000000000001'::uuid,'invalid','backup','10'::numeric,'original accepted reason','replay-op','{"ok": false, "reason": "banks_must_be_two_of_main_backup_promo"}'::jsonb),
('same_bank','00000000-0000-0000-0000-000000000001'::uuid,'main','main','10'::numeric,'original accepted reason','replay-op','{"ok": false, "reason": "banks_must_be_two_of_main_backup_promo"}'::jsonb),
('invalid_amount_0','00000000-0000-0000-0000-000000000001'::uuid,'main','backup','0'::numeric,'original accepted reason','replay-op','{"ok": false, "reason": "amount_must_be_positive"}'::jsonb),
('invalid_amount_-1','00000000-0000-0000-0000-000000000001'::uuid,'main','backup','-1'::numeric,'original accepted reason','replay-op','{"ok": false, "reason": "amount_must_be_positive"}'::jsonb),
('invalid_amount_None','00000000-0000-0000-0000-000000000001'::uuid,'main','backup',NULL::numeric,'original accepted reason','replay-op','{"ok": false, "reason": "amount_must_be_positive"}'::jsonb),
('missing_pool','00000000-0000-0000-0000-000000000003'::uuid,'main','backup','10'::numeric,'original accepted reason','replay-op','{"ok": false, "reason": "pool_not_found"}'::jsonb),
('blank_op','00000000-0000-0000-0000-000000000001'::uuid,'main','backup','10'::numeric,'original accepted reason',' ','{"ok": false, "reason": "a_bank_move_needs_a_reason_and_an_op_id"}'::jsonb)
 ) AS cases(name,pool,from_bank,to_bank,amount,reason,op,expected) LOOP
  BEGIN actual:=public.fn_bbj_move_between_banks(c.pool,c.from_bank,c.to_bank,c.amount,c.reason,c.op);
  EXCEPTION WHEN OTHERS THEN actual:=jsonb_build_object('error',SQLERRM,'sqlstate',SQLSTATE); END;
  INSERT INTO results VALUES(c.name,actual,c.expected,actual=c.expected);
 END LOOP;
END $test$;
SELECT jsonb_agg(to_jsonb(results) ORDER BY name) FROM results;
