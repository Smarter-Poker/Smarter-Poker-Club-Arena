CREATE FUNCTION pg_temp.must_refuse(label text) RETURNS void LANGUAGE plpgsql AS $$DECLARE v jsonb;BEGIN
 v:=fn_union_pnl_prove_original_unchanged_stack('10000000-0000-0000-0000-000000000001',200);
 IF v->>'status' IS DISTINCT FROM 'refused' THEN RAISE EXCEPTION 'UNEXPECTED PROOF %: %',label,v;END IF;
 RAISE NOTICE 'PASS negative %: %',label,v->>'reason';END$$;
BEGIN;UPDATE cash_hand_provenance_receipts SET participants=jsonb_set(participants,'{0,stack_before}','null') WHERE hand_number=200;SELECT pg_temp.must_refuse('NULL original stack');ROLLBACK;
BEGIN;UPDATE cash_hand_provenance_receipts SET participants=jsonb_set(participants,'{0,stack_after}','"malformed"') WHERE hand_number=200;SELECT pg_temp.must_refuse('malformed original stack');ROLLBACK;
BEGIN;UPDATE cash_hand_provenance_receipts SET accepted_at=NULL WHERE hand_number=199;SELECT pg_temp.must_refuse('NULL predecessor accepted time');ROLLBACK;
BEGIN;UPDATE cash_hand_provenance_receipts SET stack_claim=jsonb_set(stack_claim,'{hand_id}','null') WHERE hand_number=200;SELECT pg_temp.must_refuse('NULL atomic claim identity');ROLLBACK;
BEGIN;UPDATE cash_hand_provenance_receipts SET payload_hash='foreign' WHERE hand_number=200;SELECT pg_temp.must_refuse('current signed payload drift');ROLLBACK;
BEGIN;UPDATE cash_hand_provenance_receipts SET payload_hash='foreign' WHERE hand_number=199;SELECT pg_temp.must_refuse('predecessor signed payload drift');ROLLBACK;
BEGIN;UPDATE cash_hand_provenance_receipts SET atomic_receipt=jsonb_set(atomic_receipt,'{stack_result,request,stacks,0,stack}',to_jsonb(999)) WHERE hand_number=199;SELECT pg_temp.must_refuse('predecessor original stack drift');ROLLBACK;
BEGIN;UPDATE cash_hand_participant_manifests SET game_scope=game_scope||'{"host_club_id":null}' WHERE hand_number=200;SELECT pg_temp.must_refuse('original scope drift');ROLLBACK;
BEGIN;UPDATE cash_participant_funding_receipts SET funding_club_id='aaaaaaaa-0000-0000-0000-000000000001';SELECT pg_temp.must_refuse('foreign original funding owner');ROLLBACK;
BEGIN;INSERT INTO cash_participant_funding_receipts(id,occupancy_id,recorded_at,table_id,user_id,seat_id,seat_joined_at,amount)
 SELECT gen_random_uuid(),occupancy_id,'2026-10-06 15:33:06+00',table_id,user_id,seat_id,seat_joined_at,1 FROM cash_participant_funding_receipts LIMIT 1;
 SELECT pg_temp.must_refuse('intervening funding receipt');ROLLBACK;
BEGIN;INSERT INTO cash_funding_application_receipts(pending_addon_id,funding_receipt_id,applied_at,original_occupancy_id,applied_occupancy_id,applied,refunded)
 SELECT gen_random_uuid(),id,'2026-10-06 15:33:06+00',occupancy_id,occupancy_id,1,0 FROM cash_participant_funding_receipts LIMIT 1;
 SELECT pg_temp.must_refuse('intervening pending application');ROLLBACK;
BEGIN;UPDATE cash_hand_provenance_receipts SET participants=participants||jsonb_build_array(participants->0) WHERE hand_number=200;SELECT pg_temp.must_refuse('duplicate signed participant');ROLLBACK;
BEGIN;UPDATE cash_hand_provenance_receipts SET rake=1 WHERE hand_number=200;SELECT pg_temp.must_refuse('original conservation drift');ROLLBACK;
BEGIN;ALTER TABLE union_pnl_cash_outcomes DISABLE TRIGGER original_pnl_immutable;
 UPDATE union_pnl_cash_outcomes SET evidence=jsonb_set(evidence,'{issues}',evidence->'issues'||'"pending_funding_application_unproven"'::jsonb) WHERE hand_number=200;
 SELECT pg_temp.must_refuse('unrelated fourth-case defect');ROLLBACK;
BEGIN;ALTER TABLE union_pnl_cash_outcomes DISABLE TRIGGER original_pnl_immutable;
 UPDATE union_pnl_cash_outcomes SET evidence=evidence||'{"status":"blocked","basis_certified":false}' WHERE hand_number=199;
 SELECT pg_temp.must_refuse('predecessor not accepted');ROLLBACK;
BEGIN;ALTER TABLE union_pnl_cash_outcomes DISABLE TRIGGER original_pnl_immutable;
 UPDATE union_pnl_cash_outcomes SET evidence=jsonb_set(evidence,'{participants,0,ownership_certified}','false') WHERE hand_number=200;
 SELECT pg_temp.must_refuse('original ownership uncertified');ROLLBACK;
BEGIN;ALTER TABLE union_pnl_cash_outcomes DISABLE TRIGGER original_pnl_immutable;
 UPDATE union_pnl_cash_outcomes SET evidence=jsonb_set(evidence,'{participants,0,earning_club_id}',to_jsonb('aaaaaaaa-0000-0000-0000-000000000001'::text)) WHERE hand_number=200;
 SELECT pg_temp.must_refuse('wrong earning club despite certified flag');ROLLBACK;
DO $$DECLARE n int; v jsonb; before_md5 text;BEGIN
 SELECT md5(string_agg(row_to_json(l)::text,'' ORDER BY id)) INTO before_md5 FROM chip_ledger l;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE hand_number=200) THEN RAISE EXCEPTION 'unresolved outcome accepted before certificate';END IF;
 v:=fn_union_pnl_resolve_original_unchanged_stack('10000000-0000-0000-0000-000000000001',200,'Native exact original signed stack continuity proof');
 IF v->>'status'<>'resolved' THEN RAISE EXCEPTION 'resolution refused %',v;END IF;
 IF NOT (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE hand_number=200) THEN RAISE EXCEPTION 'consumer did not accept exact hashbound certificate';END IF;
 v:=fn_union_pnl_resolve_original_unchanged_stack('10000000-0000-0000-0000-000000000001',200,'Duplicate exact original signed stack continuity proof');
 SELECT count(*) INTO n FROM union_pnl_cash_outcome_resolutions WHERE hand_number=200;
 IF v->>'status'<>'already_resolved' OR n<>1 THEN RAISE EXCEPTION 'duplicate certificate %/%',v,n;END IF;
 IF before_md5 IS DISTINCT FROM (SELECT md5(string_agg(row_to_json(l)::text,'' ORDER BY id)) FROM chip_ledger l) THEN RAISE EXCEPTION 'writer changed original money';END IF;
 RAISE NOTICE 'PASS writer/consumer/idempotence: one immutable certificate, unchanged original ledger';
END$$;
BEGIN;ALTER TABLE union_pnl_cash_outcomes DISABLE TRIGGER original_pnl_immutable;
 UPDATE union_pnl_cash_outcomes SET payload_hash='drift' WHERE hand_number=200;
 DO $$BEGIN IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE hand_number=200) THEN RAISE EXCEPTION 'drifted outcome still accepted';END IF;END$$;ROLLBACK;
DO $$BEGIN
 IF has_function_privilege('anon','fn_union_pnl_resolve_original_unchanged_stack(uuid,bigint,text)','EXECUTE')
 OR has_function_privilege('authenticated','fn_union_pnl_resolve_original_unchanged_stack(uuid,bigint,text)','EXECUTE') THEN RAISE EXCEPTION 'player can write original certificate';END IF;
 RAISE NOTICE 'PASS credential/consumer drift boundaries';
END$$;

DO $$DECLARE p record;BEGIN
 FOR p IN SELECT proname,prosecdef,proconfig,pg_get_userbyid(proowner) owner FROM pg_proc WHERE oid IN('fn_union_pnl_prove_original_unchanged_stack(uuid,bigint)'::regprocedure,'fn_union_pnl_resolve_original_unchanged_stack(uuid,bigint,text)'::regprocedure) LOOP
 IF p.owner<>'postgres' OR NOT p.proconfig @> ARRAY['search_path=public, pg_temp'] OR (p.proname='fn_union_pnl_resolve_original_unchanged_stack' AND NOT p.prosecdef) OR (p.proname='fn_union_pnl_prove_original_unchanged_stack' AND p.prosecdef) THEN RAISE EXCEPTION 'owner/searchpath/security drift %',p;END IF;
 END LOOP;
 IF NOT has_function_privilege('service_role','fn_union_pnl_resolve_original_unchanged_stack(uuid,bigint,text)','EXECUTE') OR has_table_privilege('service_role','union_pnl_cash_outcome_resolutions','INSERT') OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='union_pnl_cash_outcome_resolutions'::regclass) THEN RAISE EXCEPTION 'evidence writer ACL/RLS contract differs';END IF;
 RAISE NOTICE 'PASS installed exact owner, invoker/definer, search_path, ACL/RLS and consumer contracts';
END$$;
