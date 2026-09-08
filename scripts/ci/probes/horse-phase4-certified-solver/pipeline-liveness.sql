BEGIN;
DO $probe$
DECLARE
  h1 jsonb;
  h2 jsonb;
  c0 jsonb;
  c1 jsonb;
  got jsonb;
  findings jsonb;
  failed boolean;
  z64 text := repeat('a',64);
  y64 text := repeat('b',64);
  x40 text := repeat('c',40);
BEGIN
  IF NOT public.fn_solver_ingress_claim('M1','55555555-5555-4555-8555-555555555555',
      'worker_heartbeat',now(),z64) THEN
    RAISE EXCEPTION 'signed ingress nonce was not claimed';
  END IF;
  failed := false;
  BEGIN
    PERFORM public.fn_solver_ingress_claim('M1','55555555-5555-4555-8555-555555555555',
      'worker_heartbeat',now(),z64);
  EXCEPTION WHEN OTHERS THEN failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'signed ingress nonce replay was accepted'; END IF;
  failed := false;
  BEGIN
    PERFORM public.fn_solver_ingress_claim('M2','66666666-6666-4666-8666-666666666666',
      'worker_heartbeat',now()-interval '6 minutes',z64);
  EXCEPTION WHEN OTHERS THEN failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'stale signed ingress request was accepted'; END IF;

  h1 := jsonb_build_object(
    'contract','smarter-poker.solver-worker-heartbeat.v1','machine_id','M1',
    'run_id','11111111-1111-4111-8111-111111111111','sequence',0,'phase_id','phase4.cash.flop',
    'state','starting','rows_planned',100,'rows_done',0,'rows_written',0,'invalid_rows',0,
    'solver_version','PioSOLVER-edge','solver_binary_checksum',z64,
    'pipeline_commit',x40,'pipeline_bundle_checksum',y64,'manifest_version','5',
    'manifest_checksum',z64,'range_bundle_checksum',y64,'source_combo_order_checksum',z64
  );
  got := public.fn_solver_worker_heartbeat(h1);
  IF got->>'idempotent' <> 'false' THEN RAISE EXCEPTION 'first worker pulse was not accepted'; END IF;
  got := public.fn_solver_worker_heartbeat(h1);
  IF got->>'idempotent' <> 'true' THEN RAISE EXCEPTION 'exact worker retry was not idempotent'; END IF;

  failed := false;
  BEGIN PERFORM public.fn_solver_worker_heartbeat(h1 || '{"rows_done":1}'::jsonb);
  EXCEPTION WHEN OTHERS THEN failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'worker idempotency collision was accepted'; END IF;

  h1 := h1 || jsonb_build_object('sequence',1,'state','completed','rows_done',100,
    'rows_written',100,'last_artifact_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'last_artifact_checksum',z64);
  got := public.fn_solver_worker_heartbeat(h1);
  IF (got->>'rows_per_hour')::numeric <= 0 THEN RAISE EXCEPTION 'worker rate was not computed'; END IF;

  failed := false;
  BEGIN PERFORM public.fn_solver_worker_heartbeat(h1 || jsonb_build_object('sequence',2,'rows_done',99));
  EXCEPTION WHEN OTHERS THEN failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'worker counter regression was accepted'; END IF;

  h2 := (h1 - 'last_artifact_id' - 'last_artifact_checksum') || jsonb_build_object(
    'machine_id','M2','run_id','22222222-2222-4222-8222-222222222222','sequence',0,
    'rows_done',0,'rows_written',0,'state','starting');
  PERFORM public.fn_solver_worker_heartbeat(h2);
  h2 := h2 || jsonb_build_object('sequence',1,'state','completed','rows_done',100,
    'rows_written',100,'last_artifact_id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'last_artifact_checksum',z64);
  PERFORM public.fn_solver_worker_heartbeat(h2);

  c0 := jsonb_build_object(
    'contract','smarter-poker.solver-compact-heartbeat.v1','run_id','33333333-3333-4333-8333-333333333333',
    'sequence',0,'state','scanning','dataset_key','phase4.v1','source_rows',100,
    'receipt_rows',125,'cells',0,'invalid_rows',0,'source_max_at',now(),
    'pipeline_commit',x40,'pipeline_bundle_checksum',y64,'manifest_version','5',
    'manifest_checksum',z64,'range_bundle_checksum',y64
  );
  PERFORM public.fn_solver_compact_heartbeat(c0);
  c1 := c0 || jsonb_build_object('sequence',1,'state','candidate','cells',12,
    'compacted_through',now(),'dataset_checksum',z64);
  PERFORM public.fn_solver_compact_heartbeat(c1);
  got := public.fn_solver_compact_heartbeat(c1);
  IF got->>'idempotent' <> 'true' THEN RAISE EXCEPTION 'exact compact retry was not idempotent'; END IF;

  findings := public.fn_audit_solver_pipeline_liveness(current_date);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(findings) f WHERE f->>'code'='solver_pipeline_live')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(findings) f WHERE f->>'severity'='critical') THEN
    RAISE EXCEPTION 'healthy liveness audit was not healthy: %',findings;
  END IF;

  h2 := (h2 - 'last_artifact_id' - 'last_artifact_checksum') || jsonb_build_object(
    'run_id','44444444-4444-4444-8444-444444444444','sequence',0,'state','completed',
    'rows_planned',0,'rows_done',0,'rows_written',0,'pipeline_commit',repeat('d',40));
  PERFORM public.fn_solver_worker_heartbeat(h2);
  findings := public.fn_audit_solver_pipeline_liveness(current_date);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(findings) f WHERE f->>'code'='solver_worker_provenance_split')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(findings) f WHERE f->>'code'='solver_pipeline_live') THEN
    RAISE EXCEPTION 'provenance split was not isolated: %',findings;
  END IF;
END;
$probe$;
ROLLBACK;
SELECT 'LIVENESS_BEHAVIOR_OK' AS result;
