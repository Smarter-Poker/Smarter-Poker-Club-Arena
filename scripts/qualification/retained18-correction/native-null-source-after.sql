DO $after_null$
DECLARE e uuid;
BEGIN
 SELECT submission_id INTO e FROM smarter_private.hand_submissions ORDER BY submission_id LIMIT 1;
 BEGIN
  UPDATE pg_proc SET proacl=NULL WHERE oid='public.fn_engine_lease_stale_seconds()'::regprocedure;
  IF smarter_private.original_hand_correction_sources_match() IS DISTINCT FROM false OR smarter_private.original_hand_source_correction_proof(e) IS NOT NULL THEN RAISE EXCEPTION 'NULL_SOURCE_ACL_ACCEPTED';END IF;
  RAISE EXCEPTION 'restore isolated source ACL fault' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;END;
 BEGIN
  UPDATE pg_proc SET proconfig=NULL WHERE oid='public.fn_engine_lease_stale_seconds()'::regprocedure;
  IF smarter_private.original_hand_correction_sources_match() IS DISTINCT FROM false OR smarter_private.original_hand_source_correction_proof(e) IS NOT NULL THEN RAISE EXCEPTION 'NULL_SOURCE_CONFIG_ACCEPTED';END IF;
  RAISE EXCEPTION 'restore isolated source config fault' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;END;
 IF smarter_private.original_hand_correction_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'SOURCE_FAULT_RESTORATION_UNPROVEN';END IF;
 RAISE NOTICE 'PASS NULL ACL/config refuses original financial eligibility; exact source state restored after isolated faults';
END $after_null$;
