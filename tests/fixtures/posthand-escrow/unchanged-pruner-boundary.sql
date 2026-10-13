BEGIN;
INSERT INTO hand_history_retention_policy(id,horse_retention_days,updated_at) VALUES(true,8,now());
-- Exact original history identity/age and roster from the accepted original request;
-- unrelated history fields are unobserved, not invented production evidence.
INSERT INTO hand_history(id,table_id,hand_number,tournament_id,has_human,reported,players,created_at)
 SELECT p.hand_id,p.table_id,p.hand_number,NULL,false,false,
 (SELECT jsonb_agg(jsonb_build_object('userId',x->>'user_id','is_horse',x->'is_horse')) FROM jsonb_array_elements(p.participants) x),p.accepted_at
 FROM cash_hand_provenance_receipts p WHERE p.hand_number=31008564;
SELECT fn_union_pnl_certify_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564,md5(fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)::text),encode(extensions.digest(convert_to(smarter_private.posthand_escrow_original_snapshot('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)::text,'UTF8'),'sha256'),'hex'));
DO $test$ DECLARE p_before text;m_before text; deleted integer;BEGIN
 SELECT md5(to_jsonb(p)::text) INTO STRICT p_before FROM cash_hand_provenance_receipts p WHERE hand_number=31008564;
 SELECT md5(to_jsonb(m)::text) INTO STRICT m_before FROM cash_hand_participant_manifests m WHERE hand_number=31008564;
 IF fn_pnl_cash_hand_evidence('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status' IS DISTINCT FROM 'ready'
  OR smarter_private.horse_cash_retention_accounting_ready('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'qualified public financial reader bypassed private stored classification guard';END IF;
 deleted:=sp_prune_hand_history(10);
 IF deleted IS DISTINCT FROM 0 OR NOT EXISTS(SELECT 1 FROM hand_atomic_commits WHERE hand_number=31008564)
  OR NOT EXISTS(SELECT 1 FROM hand_history WHERE hand_number=31008564)
  OR (SELECT md5(to_jsonb(p)::text) FROM cash_hand_provenance_receipts p WHERE hand_number=31008564) IS DISTINCT FROM p_before
  OR (SELECT md5(to_jsonb(m)::text) FROM cash_hand_participant_manifests m WHERE hand_number=31008564) IS DISTINCT FROM m_before THEN RAISE EXCEPTION 'unchanged retention owner failed original protection';END IF;
 RAISE NOTICE 'PASS actual unchanged pruner refuses; p/m original classification/hash untouched despite qualified financial reader';
END $test$;
ROLLBACK;
