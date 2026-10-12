DO $test$ DECLARE proof text;original text;candidate text;BEGIN
 proof:=md5(fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)::text);
 original:=encode(extensions.digest(convert_to(smarter_private.posthand_escrow_original_snapshot('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)::text,'UTF8'),'sha256'),'hex');
 FOREACH candidate IN ARRAY ARRAY[NULL::text,repeat('0',64),'malformed'] LOOP
  BEGIN PERFORM fn_union_pnl_certify_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564,proof,candidate);RAISE EXCEPTION 'wrong original hash admitted';
  EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'POSTHAND_ESCROW_EXPECTED_ORIGINAL_PROOF_CHANGED' THEN RAISE;END IF;END;
 END LOOP;
 FOREACH candidate IN ARRAY ARRAY[NULL::text,repeat('0',32),'malformed'] LOOP
  BEGIN PERFORM fn_union_pnl_certify_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564,candidate,original);RAISE EXCEPTION 'wrong proof hash admitted';
  EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'POSTHAND_ESCROW_EXPECTED_ORIGINAL_PROOF_CHANGED' THEN RAISE;END IF;END;
 END LOOP;
 IF EXISTS(SELECT 1 FROM smarter_private.posthand_escrow_certificates) THEN RAISE EXCEPTION 'refused writer left certificate';END IF;
 RAISE NOTICE 'PASS writer refuses NULL/malformed/wrong original and proof pins without effects';
END $test$;
BEGIN;
INSERT INTO engine_maintenance_break VALUES(true,'counting_down',clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '4 minutes','native freeze refusal',NULL,clock_timestamp(),true,'00000000-0000-0000-0000-000000000001');
DO $test$BEGIN
 BEGIN PERFORM fn_union_pnl_certify_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564,repeat('0',32),repeat('0',64));RAISE EXCEPTION 'frozen writer admitted';
 EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'POSTHAND_ESCROW_PLATFORM_FROZEN' THEN RAISE;END IF;END;
 RAISE NOTICE 'PASS live financial freeze refuses original certificate admission';
END $test$;
ROLLBACK;
