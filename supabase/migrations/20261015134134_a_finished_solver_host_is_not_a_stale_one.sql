-- 20261015134134_a_finished_solver_host_is_not_a_stale_one.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_audit_solver_pipeline_liveness raised CRITICAL solver_worker_stale for M1
-- and M2 on every daily audit since 2026-10-07, because it judged a host stale
-- on heartbeat age alone. Measured against production 2026-10-15: both hosts'
-- liveness rows read worker_state 'completed', phase 'completed', rows_done =
-- rows_planned (M1 32/32, M2 16/16), last beat 2026-10-07 03:36-03:37 UTC. The
-- V31 hosts are finite one-shot runs that exit 0 and stop beating: that is a
-- finished host, not a stale one. The critical named the wrong cause and hid
-- the real one.
--
-- The real one: three gto_v31_datasets rows have sat in state 'building'
-- since 2026-10-07. Two of them (horse-v31-authored-study-20261006-r2 and
-- horse-v31-relative-v2-pilot-20261007-r1) have every host run completed and
-- a compactor whose last heartbeat is 'failed' ("cell has no live training
-- combinations"; "required Phase 4 street, family, utility, table, pot, or
-- response coverage is incomplete"). Nothing will ever move them.
--
-- So:
--  1. solver_worker_stale (critical) now requires a NON-TERMINAL worker_state
--     -- starting, self_test, solving, harvesting, compacting, paused, the
--     states of the solver_worker_heartbeats CHECK other than completed and
--     failed -- AND a heartbeat over 15 minutes old. A stale 'failed' host
--     reaches solver_worker_failed instead (it did not before: stale won the
--     ELSIF chain); a 'completed' host with invalid rows still does.
--  2. NEW solver_dataset_abandoned (critical, one per dataset): state
--     'building' for over 24 hours, the latest run of EVERY machine in
--     machine_ids under the dataset's pipeline_commit + manifest_checksum
--     ended 'completed', and the compactor's latest heartbeat for the
--     dataset_key is 'failed'. Title and evidence carry the compactor's
--     error_detail verbatim.
--
-- Output shape unchanged: a jsonb array of {severity, category, code, title,
-- evidence, recommendation} objects, which fn_run_horse_daily_audit appends
-- with `v_findings || fn_audit_solver_pipeline_liveness(p_day)`.
--
-- NOT CHANGED: the uncommissioned branch, solver_worker_missing,
-- solver_worker_failed, solver_worker_stalled, solver_worker_provenance_split,
-- solver_compactor_missing, solver_compactor_unhealthy, solver_pipeline_live,
-- the signature, STABLE SECURITY DEFINER, search_path and the grants
-- (service_role EXECUTE only).
--
-- Preimage: production's live body, md5(pg_get_functiondef) 845d4d7ab0169c63ccf6efaeaa7f4a12
-- (read 2026-10-15). Function only: no table DDL, no lock on a hot relation.
--
-- Pinned by server/src/engine/aFinishedSolverHostIsNotAStaleOne.law.test.ts.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_audit_solver_pipeline_liveness(date)'::regprocedure)) IS DISTINCT FROM '845d4d7ab0169c63ccf6efaeaa7f4a12' THEN
    RAISE EXCEPTION 'fn_audit_solver_pipeline_liveness is not the live text this migration was written against (md5 %)',
      md5(pg_get_functiondef('public.fn_audit_solver_pipeline_liveness(date)'::regprocedure)) USING ERRCODE = '55000';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.fn_audit_solver_pipeline_liveness(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_findings jsonb := '[]'::jsonb;
  v_machine text;
  v_worker public.solver_worker_liveness%ROWTYPE;
  v_compact public.solver_compact_liveness%ROWTYPE;
  v_peer public.solver_worker_liveness%ROWTYPE;
  v_progress bigint;
  v_workers_healthy boolean := true;
  v_provenance_matches boolean := true;
  v_dataset record;
BEGIN
  -- 2026-09-27 (CLAUDE.md 10.86 rule 1): a pipeline that was never commissioned
  -- is not a pipeline that stopped. Both heartbeat tables are append-only and
  -- nothing prunes them, so empty means never -- not "not lately". While no
  -- input bundle has ever been approved and neither table has ever held a row,
  -- there is no process to restart and no host to reach, and the three critical
  -- "missing" findings below would name an outage that has not happened.
  IF NOT EXISTS (SELECT 1 FROM public.gto_v31_input_bundles
                  WHERE approval_status = 'approved')
     AND NOT EXISTS (SELECT 1 FROM public.solver_worker_heartbeats)
     AND NOT EXISTS (SELECT 1 FROM public.solver_compact_heartbeats) THEN
    RETURN jsonb_build_array(jsonb_build_object(
      'severity','note','category','gto',
      'code','solver_pipeline_not_commissioned',
      'title','Certified V31 solver pipeline has never been commissioned - no approved input bundle, and M1, M2 and the compactor have never sent one heartbeat',
      'evidence',jsonb_build_object(
        'day',p_day,
        'approved_input_bundles',0,
        'worker_heartbeats_ever',0,
        'compact_heartbeats_ever',0,
        'v31_datasets',(SELECT count(*) FROM public.gto_v31_datasets),
        'v31_source_artifacts',(SELECT count(*) FROM public.gto_v31_source_artifacts),
        'v31_runtime_cells',(SELECT count(*) FROM public.gto_v31_runtime_cells),
        'heartbeat_tables_are_append_only',true,
        'human_gate','ca_gto_v31_approve_input_bundle'),
      'recommendation',
        'This is a standing fact, not an outage, and no software change can clear '||
        'it. The pipeline has produced nothing because it was never started, and '||
        'it cannot be started from this repository. Phase 4 needs, in order: '||
        '(1) a horse administrator reviews one immutable NLH input package and '||
        'approves it through ca_gto_v31_approve_input_bundle; (2) a licensed '||
        'PioSOLVER console executable installed on two genuinely independent '||
        'Windows hosts designated M1 and M2; (3) three independently generated '||
        '32-byte HMAC secrets installed by name - '||
        'HORSE_SOLVER_V31_M1_HMAC_SECRET, HORSE_SOLVER_V31_M2_HMAC_SECRET and '||
        'HORSE_SOLVER_V31_COMPACTOR_HMAC_SECRET on the World Hub gateway, and '||
        'each host its own value as HORSE_SOLVER_V31_HMAC_SECRET. The exact '||
        'sequence is World Hub '||
        '.agent/handoffs/2026-09-09-horse-v31-licensed-corpus-activation.md. '||
        'Until then V30 remains the live policy path and is unaffected: the '||
        'certified store being empty is the fail-closed design working, not a '||
        'regression. The moment a bundle is approved or any heartbeat arrives, '||
        'this check reverts to reporting missing, stale, failed and stalled '||
        'hosts as critical.'));
  END IF;

  FOREACH v_machine IN ARRAY ARRAY['M1','M2'] LOOP
    SELECT * INTO v_worker FROM public.solver_worker_liveness WHERE machine_id=v_machine;
    IF NOT FOUND THEN
      v_workers_healthy := false;
      v_findings := v_findings || jsonb_build_object('severity','critical','category','gto',
        'code','solver_worker_missing','title','Solver host '||v_machine||' has no heartbeat',
        'evidence',jsonb_build_object('machine_id',v_machine,'day',p_day),
        'recommendation','Start the checksum-pinned supervised worker on '||v_machine||' and confirm fn_solver_worker_heartbeat is accepted.');
      CONTINUE;
    END IF;
    -- 2026-10-15: stale means a process that should still be beating has
    -- gone quiet. The V31 hosts are FINITE one-shot runs: a host that exits 0
    -- writes worker_state 'completed' and never beats again, by design, so
    -- age alone is not staleness. Only the non-terminal states of the
    -- solver_worker_heartbeats CHECK can be stale; 'failed' falls through to
    -- solver_worker_failed below, 'completed' to nothing (its invalid_rows
    -- still reach solver_worker_failed).
    IF v_worker.worker_state IN ('starting','self_test','solving','harvesting','compacting','paused')
       AND v_worker.received_at < now()-interval '15 minutes' THEN
      v_workers_healthy := false;
      v_findings := v_findings || jsonb_build_object('severity','critical','category','gto',
        'code','solver_worker_stale','title','Solver host '||v_machine||' heartbeat is stale',
        'evidence',jsonb_build_object('machine_id',v_machine,'last_heartbeat',v_worker.received_at,
          'state',v_worker.worker_state,'phase',v_worker.phase_id,'rows_done',v_worker.rows_done),
        'recommendation','Restore the supervised worker. A stale host cannot satisfy the two-machine provenance gate.');
    ELSIF v_worker.worker_state='failed' OR v_worker.invalid_rows>0 THEN
      v_workers_healthy := false;
      v_findings := v_findings || jsonb_build_object('severity','critical','category','gto',
        'code','solver_worker_failed','title','Solver host '||v_machine||' reports failure or invalid rows',
        'evidence',jsonb_build_object('machine_id',v_machine,'state',v_worker.worker_state,
          'invalid_rows',v_worker.invalid_rows,'error',v_worker.error_detail),
        'recommendation','Quarantine the run; correct the solver/export contract and restart from a new run id.');
    ELSIF v_worker.worker_state IN ('solving','harvesting','compacting')
       AND v_worker.run_started_at < now() - (CASE WHEN v_worker.worker_state='solving'
         THEN interval '2 hours' ELSE interval '15 minutes' END) THEN
      SELECT COALESCE(max(rows_done)-min(rows_done),0) INTO v_progress
        FROM public.solver_worker_heartbeats
       WHERE machine_id=v_machine AND run_id=v_worker.run_id
         AND received_at>=now()-(CASE WHEN v_worker.worker_state='solving'
           THEN interval '2 hours' ELSE interval '15 minutes' END);
      IF v_progress=0 THEN
        v_workers_healthy := false;
        v_findings := v_findings || jsonb_build_object('severity','critical','category','gto',
          'code','solver_worker_stalled','title','Solver host '||v_machine||' made no progress inside its phase ceiling',
          'evidence',jsonb_build_object('machine_id',v_machine,'state',v_worker.worker_state,
            'phase',v_worker.phase_id,'rows_done',v_worker.rows_done,'rows_per_hour',v_worker.rows_per_hour),
          'recommendation','Inspect the Pio UPI process and worker log. Solves have a two-hour ceiling; harvest and compaction have a 15-minute ceiling. A fresh heartbeat with frozen counters is not progress.');
      END IF;
    END IF;
  END LOOP;

  SELECT * INTO v_worker FROM public.solver_worker_liveness WHERE machine_id='M1';
  SELECT * INTO v_peer FROM public.solver_worker_liveness WHERE machine_id='M2';
  IF v_worker.machine_id IS NOT NULL AND v_peer.machine_id IS NOT NULL AND (
    v_worker.pipeline_commit<>v_peer.pipeline_commit OR
    v_worker.pipeline_bundle_checksum<>v_peer.pipeline_bundle_checksum OR
    v_worker.manifest_version<>v_peer.manifest_version OR
    v_worker.manifest_checksum<>v_peer.manifest_checksum OR
    v_worker.solver_binary_checksum<>v_peer.solver_binary_checksum OR
    v_worker.range_bundle_checksum<>v_peer.range_bundle_checksum OR
    v_worker.source_combo_order_checksum<>v_peer.source_combo_order_checksum
  ) THEN
    v_provenance_matches := false;
    v_findings := v_findings || jsonb_build_object('severity','critical','category','gto',
      'code','solver_worker_provenance_split','title','M1 and M2 are not running identical approved inputs',
      'evidence',jsonb_build_object('M1',jsonb_build_object('commit',v_worker.pipeline_commit,
        'manifest',v_worker.manifest_checksum,'binary',v_worker.solver_binary_checksum),
        'M2',jsonb_build_object('commit',v_peer.pipeline_commit,'manifest',v_peer.manifest_checksum,
        'binary',v_peer.solver_binary_checksum)),
      'recommendation','Stop both workers and redeploy one protected commit, manifest, binary and range bundle to both hosts.');
  END IF;

  SELECT * INTO v_compact FROM public.solver_compact_liveness WHERE singleton;
  IF NOT FOUND THEN
    v_findings := v_findings || jsonb_build_object('severity','critical','category','gto',
      'code','solver_compactor_missing','title','Certified V31 compactor has no heartbeat',
      'evidence',jsonb_build_object('day',p_day),
      'recommendation','Start the pinned compact builder. Solver rows are not runtime policy until source receipts and held-out gates produce a certified candidate.');
  ELSIF v_compact.received_at<now()-interval '20 minutes' OR v_compact.compact_state='failed'
     OR v_compact.invalid_rows>0 OR COALESCE(v_compact.compact_lag_seconds,0)>21600 THEN
    v_findings := v_findings || jsonb_build_object('severity','critical','category','gto',
      'code','solver_compactor_unhealthy','title','Certified V31 compact build is stale, failed, invalid, or over six hours behind',
      'evidence',jsonb_build_object('last_heartbeat',v_compact.received_at,'state',v_compact.compact_state,
        'invalid_rows',v_compact.invalid_rows,'lag_seconds',v_compact.compact_lag_seconds,
        'source_rows',v_compact.source_rows,'receipt_rows',v_compact.receipt_rows,'cells',v_compact.cells,
        'error',v_compact.error_detail),
      'recommendation','Repair the compact builder and source reconciliation. Keep the candidate inactive until invalid rows are zero and lag recovers.');
  ELSIF v_workers_healthy AND v_provenance_matches THEN
    v_findings := v_findings || jsonb_build_object('severity','info','category','gto',
      'code','solver_pipeline_live','title','Both solver-host slots and the V31 compactor are instrumented',
      'evidence',jsonb_build_object('M1_at',v_worker.received_at,'M2_at',v_peer.received_at,
        'compact_at',v_compact.received_at,'compact_lag_seconds',v_compact.compact_lag_seconds,
        'dataset',v_compact.dataset_key),
      'recommendation','Continue monitoring independent host progress, checksums, invalid rows and compact lag.');
  END IF;

  -- 2026-10-15: A DATASET NOTHING IS WORKING ON ANY MORE. Every host run for
  -- it has finished (each machine's latest run under the dataset's commit and
  -- manifest ended 'completed'), the compactor's last word on it is 'failed',
  -- and it has sat in 'building' for over a day. No process will ever move it:
  -- before this finding it surfaced only as two false solver_worker_stale
  -- criticals that named the wrong cause. The compactor's own error is the
  -- cause, so the finding carries it verbatim.
  FOR v_dataset IN
    WITH latest_beat AS (
      SELECT DISTINCT ON (h.machine_id, h.run_id)
             h.machine_id, h.run_id, h.pipeline_commit, h.manifest_checksum,
             h.worker_state, h.received_at
        FROM public.solver_worker_heartbeats h
       ORDER BY h.machine_id, h.run_id, h.received_at DESC, h.sequence DESC
    )
    SELECT d.dataset_id, d.dataset_key, d.created_at, d.machine_ids,
           w.runs, c.run_id AS compact_run_id, c.received_at AS compact_failed_at,
           c.error_detail AS compact_error
      FROM public.gto_v31_datasets d
      CROSS JOIN LATERAL (
        SELECT count(*) AS machines_finished,
               bool_and(lr.worker_state = 'completed') AS all_completed,
               jsonb_agg(jsonb_build_object('machine_id',lr.machine_id,'run_id',lr.run_id,
                 'state',lr.worker_state,'last_heartbeat',lr.received_at)
                 ORDER BY lr.machine_id) AS runs
          FROM (SELECT DISTINCT ON (lb.machine_id) lb.*
                  FROM latest_beat lb
                 WHERE lb.pipeline_commit = d.pipeline_commit
                   AND lb.manifest_checksum = d.manifest_checksum
                   AND lb.machine_id = ANY (d.machine_ids)
                 ORDER BY lb.machine_id, lb.received_at DESC) lr
      ) w
      CROSS JOIN LATERAL (
        SELECT ch.run_id, ch.received_at, ch.compact_state, ch.error_detail
          FROM public.solver_compact_heartbeats ch
         WHERE ch.dataset_key = d.dataset_key
         ORDER BY ch.received_at DESC, ch.sequence DESC
         LIMIT 1
      ) c
     WHERE d.state = 'building'
       AND d.created_at < now() - interval '24 hours'
       AND w.machines_finished = cardinality(d.machine_ids)
       AND w.all_completed
       AND c.compact_state = 'failed'
     ORDER BY d.created_at
  LOOP
    v_findings := v_findings || jsonb_build_object('severity','critical','category','gto',
      'code','solver_dataset_abandoned',
      'title','V31 dataset '||v_dataset.dataset_key||' has been building for '||
        floor(extract(epoch FROM now()-v_dataset.created_at)/3600)::bigint||
        ' hours with every solver run completed and its compactor failed: '||
        COALESCE(v_dataset.compact_error,'(no error recorded)'),
      'evidence',jsonb_build_object('day',p_day,'dataset_id',v_dataset.dataset_id,
        'dataset_key',v_dataset.dataset_key,'created_at',v_dataset.created_at,
        'building_hours',floor(extract(epoch FROM now()-v_dataset.created_at)/3600)::bigint,
        'worker_runs',v_dataset.runs,'compactor_run_id',v_dataset.compact_run_id,
        'compactor_failed_at',v_dataset.compact_failed_at,
        'compactor_error',v_dataset.compact_error),
      'recommendation','Nothing is working on this dataset any more: both hosts exited after '||
        'completing their runs and the compactor stopped on "'||
        COALESCE(v_dataset.compact_error,'(no error recorded)')||'". Fix what the compactor '||
        'names (declared coverage, manifest or source rows), then re-run the compactor on it, '||
        'or reject the dataset and start a new dataset key. It cannot become a candidate on its '||
        'own; V30 remains the live policy path meanwhile.');
  END LOOP;

  RETURN v_findings;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_audit_solver_pipeline_liveness(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_solver_pipeline_liveness(date) TO service_role;

DO $post$
DECLARE
  v_def text := pg_get_functiondef('public.fn_audit_solver_pipeline_liveness(date)'::regprocedure);
BEGIN
  IF position('''starting'',''self_test'',''solving'',''harvesting'',''compacting'',''paused''' IN v_def) = 0
     OR position('solver_dataset_abandoned' IN v_def) = 0 THEN
    RAISE EXCEPTION 'fn_audit_solver_pipeline_liveness is not the reviewed text' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_audit_solver_pipeline_liveness(date)'::regprocedure
       AND p.prosecdef AND p.provolatile = 's'
       AND p.proconfig @> ARRAY['search_path=public']
  ) OR has_function_privilege('anon', 'public.fn_audit_solver_pipeline_liveness(date)'::regprocedure, 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.fn_audit_solver_pipeline_liveness(date)'::regprocedure, 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.fn_audit_solver_pipeline_liveness(date)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_audit_solver_pipeline_liveness lost its definer posture or its grants' USING ERRCODE = '55000';
  END IF;
  -- The function must still run and still return an array.
  IF jsonb_typeof(public.fn_audit_solver_pipeline_liveness(current_date)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'fn_audit_solver_pipeline_liveness no longer returns a jsonb array' USING ERRCODE = '55000';
  END IF;
END $post$;

COMMIT;
