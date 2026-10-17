-- 20261016105000_a_parked_v31_pipeline_is_one_finding_not_three.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Found by the 2026-10-15 daily horse audit analysis, Dan's call: fix the
-- alarm, do not launch a solve. Every day since 2026-10-07 the audit has
-- raised three criticals for one standing fact: solver_worker_stale for M1,
-- solver_worker_stale for M2 and solver_compactor_unhealthy. Read from
-- production on 2026-10-16: both workers report worker_state 'completed'
-- (M1 32 rows, M2 16 rows, last heartbeats 2026-10-07 03:37Z and 03:36Z); the
-- compactor failed at 03:38Z on the pilot (48 source rows, 8 cells, 1 invalid:
-- "required Phase 4 ... coverage is incomplete"). The coverage gate was right
-- to refuse; the hosts finished and were switched off. The datasets are pilot
-- and study runs that will never seal.
--
-- fn_audit_solver_pipeline_liveness now reports that state as ONE warn,
-- solver_pipeline_parked, with the hosts' and the compactor's last facts. It
-- applies only when BOTH hosts say 'completed', both are silent, and the
-- compactor stopped within an hour of the last worker. Any other state is
-- judged exactly as before. certified_v31_missing (fn_audit_gto_v31_certified)
-- is untouched and stays critical while nothing is certified.
--
-- Built on the installed body (md5(prosrc) d9dc1d105080109bffc17c4291e50310,
-- equal to 20260927220533_uncommissioned_solver_pipeline_is_not_an_outage.sql).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

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

  -- 2026-10-16: A PARKED PIPELINE IS ONE FINDING, NOT THREE. When both hosts
  -- report worker_state 'completed' (they finished the run they were given),
  -- neither has sent a heartbeat since, and the compactor stopped within an
  -- hour of the last worker, nothing crashed: a run ended and the hosts were
  -- switched off. That is one standing fact. Reported as two stale-worker
  -- criticals plus a compactor critical, it read as an outage every day
  -- (2026-10-07 pilot, 48 source rows, 8 cells). fn_audit_gto_v31_certified
  -- still raises certified_v31_missing (critical) while nothing is certified.
  IF EXISTS (SELECT 1 FROM public.solver_worker_liveness WHERE machine_id='M1'
              AND worker_state='completed' AND received_at < now()-interval '15 minutes')
     AND EXISTS (SELECT 1 FROM public.solver_worker_liveness WHERE machine_id='M2'
              AND worker_state='completed' AND received_at < now()-interval '15 minutes')
     AND EXISTS (SELECT 1 FROM public.solver_compact_liveness c WHERE c.singleton
              AND c.received_at < now()-interval '20 minutes'
              AND c.received_at <= (SELECT max(w.received_at) FROM public.solver_worker_liveness w
                                     WHERE w.machine_id IN ('M1','M2')) + interval '1 hour') THEN
    SELECT * INTO v_worker FROM public.solver_worker_liveness WHERE machine_id='M1';
    SELECT * INTO v_peer FROM public.solver_worker_liveness WHERE machine_id='M2';
    SELECT * INTO v_compact FROM public.solver_compact_liveness WHERE singleton;
    RETURN jsonb_build_array(jsonb_build_object(
      'severity','warn','category','gto','code','solver_pipeline_parked',
      'title','V31 solver pipeline is parked: M1 and M2 finished their last run and have been off since '
              || greatest(v_worker.received_at, v_peer.received_at)::date,
      'evidence',jsonb_build_object(
        'day',p_day,
        'M1',jsonb_build_object('state',v_worker.worker_state,'last_heartbeat',v_worker.received_at,'rows_done',v_worker.rows_done),
        'M2',jsonb_build_object('state',v_peer.worker_state,'last_heartbeat',v_peer.received_at,'rows_done',v_peer.rows_done),
        'compactor',jsonb_build_object('state',v_compact.compact_state,'last_heartbeat',v_compact.received_at,
          'source_rows',v_compact.source_rows,'cells',v_compact.cells,'invalid_rows',v_compact.invalid_rows,
          'error',v_compact.error_detail,'dataset',v_compact.dataset_key)),
      'recommendation','Nothing crashed and nothing in this repository can clear it. The last run ended and the licensed PioSOLVER hosts were switched off. '||
        'Producing a certified V31 dataset needs M1 and M2 powered on and linked and a full run (not a pilot) started; '||
        'the compactor then certifies it only when Phase 4 coverage is complete. Until then V30 stays the live policy path. '||
        'The moment either host sends a heartbeat this check goes back to reporting stale, failed and stalled hosts as critical.'));
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
    IF v_worker.received_at < now()-interval '15 minutes' THEN
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
  RETURN v_findings;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_audit_solver_pipeline_liveness(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_solver_pipeline_liveness(date) TO service_role;

COMMIT;
