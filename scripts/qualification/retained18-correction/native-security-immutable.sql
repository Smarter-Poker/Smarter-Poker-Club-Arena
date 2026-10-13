DO $security$
DECLARE n text;denied boolean;before_accept jsonb:=native_original_assert.accepted_sets();
BEGIN
 FOREACH n IN ARRAY ARRAY['hand_submission_source_corrections','hand_submission_correction_claims','hand_submission_correction_results'] LOOP
  IF NOT EXISTS(SELECT FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='smarter_private' AND c.relname=n AND pg_get_userbyid(c.relowner)='postgres' AND c.relrowsecurity AND c.relpersistence='p') THEN RAISE EXCEPTION 'PRIVATE_TABLE_SECURITY';END IF;
  IF has_table_privilege('anon','smarter_private.'||n,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR has_table_privilege('authenticated','smarter_private.'||n,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR has_table_privilege('service_role','smarter_private.'||n,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') THEN RAISE EXCEPTION 'PRIVATE_TABLE_OPEN';END IF;
  denied:=false;BEGIN EXECUTE format('UPDATE smarter_private.%I SET submission_id=submission_id',n);EXCEPTION WHEN SQLSTATE '55000' THEN denied:=true;END;IF NOT denied THEN RAISE EXCEPTION 'IMMUTABLE_UPDATE_ACCEPTED';END IF;
  denied:=false;BEGIN EXECUTE format('DELETE FROM smarter_private.%I',n);EXCEPTION WHEN SQLSTATE '55000' THEN denied:=true;END;IF NOT denied THEN RAISE EXCEPTION 'IMMUTABLE_DELETE_ACCEPTED';END IF;
  denied:=false;BEGIN EXECUTE format('TRUNCATE smarter_private.%I CASCADE',n);EXCEPTION WHEN SQLSTATE '55000' THEN denied:=true;END;IF NOT denied THEN RAISE EXCEPTION 'IMMUTABLE_TRUNCATE_ACCEPTED';END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='smarter_private' AND p.proname IN('original_hand_correction_sources_match','original_hand_source_correction_proof','hand_source_correction_certificate_guard','certify_original_hand_source_correction','hand_source_correction_claim_guard','hand_source_correction_result_guard','hand_source_correction_immutable') AND pg_get_userbyid(p.proowner)='postgres' AND NOT p.prosecdef AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND NOT has_function_privilege('service_role',p.oid,'EXECUTE'))<>7 THEN RAISE EXCEPTION 'PRIVATE_FUNCTION_SECURITY';END IF;
 IF NOT has_function_privilege('service_role','public.fn_ca_resume_hand_submission(uuid,text,uuid)','EXECUTE') OR has_function_privilege('anon','public.fn_ca_resume_hand_submission(uuid,text,uuid)','EXECUTE') OR has_function_privilege('authenticated','public.fn_ca_resume_hand_submission(uuid,text,uuid)','EXECUTE') THEN RAISE EXCEPTION 'RESUME_ACL_DRIFT';END IF;
 IF native_original_assert.accepted_sets() IS DISTINCT FROM before_accept THEN RAISE EXCEPTION 'SECURITY_REFUSAL_CHANGED_SOURCE';END IF;
 RAISE NOTICE 'PASS private3 postgres/RLS/closed ACL, seven private functions and preserved public engine ACL; immutable UPDATE DELETE TRUNCATE refusals retain all records';
END $security$;
