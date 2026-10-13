DO $before_null$
BEGIN
 UPDATE pg_proc SET proacl=NULL WHERE oid='public.fn_engine_lease_stale_seconds()'::regprocedure;
 IF smarter_private.original_hand_correction_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'BEFORE_NULL_ACL_COUNTEREXAMPLE_NOT_REPRODUCED';END IF;
 RAISE NOTICE 'PASS BEFORE counterexample: old nullable bool_and wrongly accepts one NULL source ACL';
END $before_null$;
