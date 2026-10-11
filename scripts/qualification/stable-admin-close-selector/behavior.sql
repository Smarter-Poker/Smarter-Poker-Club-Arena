BEGIN;
SET LOCAL request.jwt.claim.role='service_role';
DO $test$
DECLARE v_mode text; v_refused boolean; v_before jsonb; v_after jsonb; v_operation uuid; v_result jsonb;
BEGIN
 FOREACH v_mode IN ARRAY ARRAY['deleted','noncash','unknown_type','unknown_deleted'] LOOP
  v_operation:=gen_random_uuid();
  UPDATE public.tables SET game_type='cash',is_deleted=false;
  IF v_mode='deleted' THEN UPDATE public.tables SET is_deleted=true WHERE id='30000000-0000-4000-8000-000000000002';
  ELSIF v_mode='noncash' THEN UPDATE public.tables SET game_type='tournament' WHERE id='30000000-0000-4000-8000-000000000002';
  ELSIF v_mode='unknown_type' THEN UPDATE public.tables SET game_type=NULL WHERE id='30000000-0000-4000-8000-000000000002';
  ELSE UPDATE public.tables SET is_deleted=NULL WHERE id='30000000-0000-4000-8000-000000000002'; END IF;
  SELECT jsonb_build_object('seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s),'custody',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM poker_diamond_custody c),'wallet',(SELECT jsonb_agg(to_jsonb(w)) FROM club_members w),'diamonds',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM profiles p)) INTO v_before;
  v_refused:=false;
  BEGIN
   v_result:=public.fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001',v_operation,'floor','close_cash','Qualified original owner target refusal');
  EXCEPTION WHEN SQLSTATE '22023' THEN
   IF SQLERRM<>'cash_floor_close_target_not_executable' THEN RAISE; END IF;
   v_refused:=true;
  END;
  PERFORM floor_assert(v_refused=EXPECT_REFUSAL,'invalid target refusal mode '||v_mode);
  IF EXPECT_REFUSAL THEN
   PERFORM floor_assert(NOT EXISTS(SELECT 1 FROM ca_engine_operator_commands WHERE id=v_operation) AND NOT EXISTS(SELECT 1 FROM ca_operator_table_closes) AND NOT EXISTS(SELECT 1 FROM admin_audit_log WHERE request_id=v_operation::text||':close_cash'),'refusal commits no command, target or audit');
  ELSE
   PERFORM floor_assert((SELECT count(*)=2 FROM ca_operator_table_closes WHERE operation_id=v_operation),'baseline admits both valid and invalid targets');
  END IF;
  SELECT jsonb_build_object('seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s),'custody',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM poker_diamond_custody c),'wallet',(SELECT jsonb_agg(to_jsonb(w)) FROM club_members w),'diamonds',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM profiles p)) INTO v_after;
  PERFORM floor_assert(v_before=v_after,'no seat/custody/balance mutation '||v_mode);
  DELETE FROM ca_operator_table_closes; DELETE FROM ca_engine_operator_commands; DELETE FROM admin_audit_log;
 END LOOP;
 UPDATE public.tables SET game_type='cash',is_deleted=false;
 v_operation:=gen_random_uuid();
 v_result:=public.fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001',v_operation,'floor','close_cash','Qualified original owner valid target');
 PERFORM floor_assert((v_result->'result'->>'targetedTables')::int=2,'all valid chip and Diamond targets retained');
 PERFORM floor_assert(public.fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001',v_operation,'floor','close_cash','Qualified original owner valid target')=v_result,'same operation returns exact receipt');
 PERFORM floor_assert((SELECT count(*)=2 FROM ca_operator_table_closes) AND (SELECT count(*)=1 FROM admin_audit_log),'replay does not reserve/audit twice');
 UPDATE public.tables SET is_deleted=true;
 PERFORM floor_assert(public.fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001',v_operation,'floor','close_cash','Qualified original owner valid target')=v_result,'changed targets never obstruct original operation recovery');
 UPDATE public.tables SET is_deleted=false;
 BEGIN
  PERFORM public.fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001',gen_random_uuid(),'floor','close_cash','Second close while previous still pending');
  RAISE EXCEPTION 'pending-close exclusion lost';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'cash_floor_close_in_progress' THEN RAISE; END IF; END;
 BEGIN
  PERFORM public.fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000002',gen_random_uuid(),'floor','close_cash','Read-only actor may not close cash');
  RAISE EXCEPTION 'operator permission bypass';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM set_config('request.jwt.claim.role','authenticated',true);
 BEGIN
  PERFORM public.fn_ca_engine_operator_command('10000000-0000-4000-8000-000000000001',gen_random_uuid(),'floor','close_cash','User role may not invoke service owner');
  RAISE EXCEPTION 'caller role bypass';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM set_config('request.jwt.claim.role','service_role',true);
END $test$;
ROLLBACK;
