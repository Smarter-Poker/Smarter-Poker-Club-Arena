-- Read counters BEFORE any direct helper tests: installation must not revisit
-- even this genuine pre-existing legacy row's JSON keys under a DDL lock.
SELECT pg_stat_force_next_flush();
SELECT pg_stat_clear_snapshot();
DO $proof$
DECLARE specs jsonb:='{"c":{"family":"check","size_unit":"none","size_value":null,"all_in":false},"f":{"family":"fold","size_unit":"none","size_value":null,"all_in":false}}';v jsonb;failed boolean;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_stat_user_functions WHERE funcid IN('public.fn_gto_v31_hand_matrix_valid(jsonb,text,text)'::regprocedure,'public.fn_gto_v31_compact_matrices_valid(jsonb,jsonb,jsonb,jsonb,text,text)'::regprocedure)AND calls<>0)THEN RAISE EXCEPTION 'installation revalidated historical matrix keys';END IF;
 IF(SELECT count(*)FROM public215_prior_checks p JOIN pg_constraint c ON c.oid=p.oid AND c.conname=p.conname AND c.convalidated AND c.conrelid='public.gto_v31_runtime_cells'::regclass)<>2 THEN RAISE EXCEPTION 'validated original CHECK OIDs were replaced';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.gto_v31_runtime_cells'::regclass AND conname='gto_v31_runtime_cells_representation_payload_chk'AND convalidated)THEN RAISE EXCEPTION 'new shape constraint is not validated';END IF;
 IF public.fn_gto_v31_hand_matrix_valid(NULL,'flop','holdem-public-hist215-v1')IS NOT TRUE OR public.fn_gto_v31_hand_matrix_valid(NULL,NULL,'holdem-public-hist215-v1')IS NOT FALSE OR public.fn_gto_v31_hand_matrix_valid('{}','flop','holdem-public-hist215-v1')IS NOT FALSE OR public.fn_gto_v31_hand_matrix_valid(NULL,'flop',NULL)IS NOT FALSE THEN RAISE EXCEPTION 'versioned hand NULL boundary differs';END IF;
 IF public.fn_gto_v31_compact_matrices_valid(NULL,specs,NULL,NULL,'flop','holdem-public-hist215-v1')IS NOT TRUE THEN RAISE EXCEPTION 'complete numeric NULL matrix shape refused';END IF;
 FOR v IN SELECT x FROM jsonb_array_elements('[{"m":{},"p":null,"q":null},{"m":null,"p":{},"q":null},{"m":null,"p":null,"q":{}},{"m":null,"p":{},"q":{}}]')x LOOP
  IF public.fn_gto_v31_compact_matrices_valid(NULLIF(v->'m','null'),specs,NULLIF(v->'p','null'),NULLIF(v->'q','null'),'flop','holdem-public-hist215-v1')IS NOT FALSE THEN RAISE EXCEPTION 'partial numeric matrix shape accepted';END IF;
 END LOOP;
 IF public.fn_gto_v31_compact_matrices_valid(NULL,specs,NULL,NULL,NULL,'holdem-public-hist215-v1')IS NOT FALSE OR public.fn_gto_v31_compact_matrices_valid(NULL,'{}',NULL,NULL,'flop','holdem-public-hist215-v1')IS NOT FALSE OR public.fn_gto_v31_compact_matrices_valid(NULL,specs,NULL,NULL,'flop',NULL)IS NOT FALSE THEN RAISE EXCEPTION 'invalid numeric or legacy NULL boundary accepted';END IF;
 failed:=false;BEGIN UPDATE public.gto_v31_runtime_cells SET hand_matrix='{"invalid":{"c":0.5,"f":0.5}}'WHERE cell_id='ac220000-0000-4000-8000-000000000003';EXCEPTION WHEN check_violation THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'invalid legacy write passed retained constraint';END IF;
END $proof$;
SELECT 'PUBLIC215_RETAINED_VALIDATED_CONSTRAINTS_NO_HISTORICAL_KEY_SCAN_PASS'AS result;
SELECT oid::regprocedure::text,md5(pg_get_functiondef(oid))FROM pg_proc WHERE oid IN('public.fn_gto_v31_hand_matrix_valid(jsonb,text,text)'::regprocedure,'public.fn_gto_v31_compact_matrices_valid(jsonb,jsonb,jsonb,jsonb,text,text)'::regprocedure);
-- Storage-boundary probes are rollback-only and never certified model cells.
-- Full independent model/source admission stays in public215-admission.sql.
BEGIN;
DO $storage$
DECLARE row_value jsonb;bad jsonb;failed boolean;patch jsonb;
BEGIN
 SELECT to_jsonb(c)INTO STRICT row_value FROM public.gto_v31_runtime_cells c WHERE cell_id='ac220000-0000-4000-8000-000000000003';
 row_value:=row_value||jsonb_build_object('cell_id','ac220000-0000-4000-8000-000000000004','cell_key_checksum',repeat('4',64),'depth_bucket',80,'feature_contract_version','holdem-public-hist215-v1','policy_export_schema','smarter-poker.pio-policy.v4','policy_representation','public_hist215_v1','hand_matrix',NULL,'policy_ev_matrix',NULL,'action_ev_matrix',NULL,'public_model','{}'::jsonb,'public_template','{}'::jsonb,'public_training_provenance','{}'::jsonb,'public_model_build_receipt','{}'::jsonb,'model_checksum',repeat('4',64),'template_checksum',repeat('5',64),'feature_schema_checksum',repeat('6',64),'training_provenance_checksum',repeat('7',64),'model_build_receipt_checksum',repeat('8',64),'sql_physics_checksum',repeat('9',64));
 INSERT INTO public.gto_v31_runtime_cells SELECT(jsonb_populate_record(NULL::public.gto_v31_runtime_cells,row_value)).*;
 IF NOT EXISTS(SELECT 1 FROM public.gto_v31_runtime_cells WHERE cell_id='ac220000-0000-4000-8000-000000000004'AND hand_matrix IS NULL AND policy_ev_matrix IS NULL AND action_ev_matrix IS NULL)THEN RAISE EXCEPTION 'numeric NULL representation was not stored';END IF;
 FOR patch IN SELECT v FROM jsonb_array_elements('[{"policy_representation":null},{"hand_matrix":{}},{"policy_ev_matrix":{}},{"action_ev_matrix":{}},{"public_model":null}]')v LOOP
  bad:=row_value||patch||jsonb_build_object('cell_id','ac220000-0000-4000-8000-000000000005','cell_key_checksum',repeat('5',64),'depth_bucket',150);failed:=false;
  BEGIN INSERT INTO public.gto_v31_runtime_cells SELECT(jsonb_populate_record(NULL::public.gto_v31_runtime_cells,bad)).*;EXCEPTION WHEN check_violation THEN failed:=true;END;
  IF NOT failed THEN RAISE EXCEPTION 'partial or UNKNOWN numeric representation storage accepted';END IF;
 END LOOP;
END $storage$;
ROLLBACK;
SELECT 'PUBLIC215_STORAGE_SHAPE_AND_UNKNOWN_REFUSALS_PASS'AS result;
