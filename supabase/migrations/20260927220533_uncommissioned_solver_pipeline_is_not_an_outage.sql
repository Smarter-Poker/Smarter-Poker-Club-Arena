-- WHAT THIS CHANGES, AND WHY:
--
-- fn_audit_solver_pipeline_liveness reports three CRITICAL findings every day
-- -- solver_worker_missing for M1, solver_worker_missing for M2, and
-- solver_compactor_missing -- and has done so on every daily audit row since
-- the detector shipped on 2026-09-08. Measured 2026-09-27: every horse_daily_audit
-- row from 2026-09-17 to 2026-09-26 carries all three.
--
-- They are not an outage. The certified V31 pipeline has never been commissioned.
-- Measured against production 2026-09-27 21:48 UTC:
--
--   gto_v31_input_bundles        0     <- the human approval gate never passed
--   gto_v31_datasets             0
--   gto_v31_source_artifacts     0
--   gto_v31_runtime_cells        0
--   gto_v31_release_evaluations  0
--   solver_worker_heartbeats     0     <- APPEND-ONLY, never pruned: 0 means never
--   solver_compact_heartbeats    0     <- APPEND-ONLY, never pruned: 0 means never
--   solver_ingress_nonces        0     <- no signed request was ever even claimed
--
-- and the World Hub gateway holds none of the three HMAC secrets the principals
-- authenticate with (hub-vanguard has 68 environment variables and not one
-- HORSE_SOLVER_V31_* among them), so decodeV31IngressSecret returns null and
-- every heartbeat would be refused before it reached PostgreSQL. M1 and M2 are
-- two licensed-PioSOLVER Windows hosts that do not exist yet; the compactor is a
-- third operator-launched process. Nothing schedules any of them -- no cron, no
-- workflow, no systemd unit -- by design.
--
-- This is CLAUDE.md 10.86 rule 1: "I could not tell" is a distinct outcome and
-- must have its own name. "Never built" and "went down ten minutes ago" are
-- different facts with different owners, and this detector folded the first into
-- the second. It is also the 10.84 alarm-always-on failure: a permanent critical
-- that no software change can clear trains every reader to skip the gto category,
-- and it is indistinguishable from M1 genuinely dying overnight -- which is the
-- one thing this detector exists to catch.
--
-- So the uncommissioned case now gets its own name, at `note`, stating only what
-- was measured and naming the exact human gate that is open. It is deliberately
-- NOT silenced: an operator still sees one honest line every day.
--
-- HARDENED AGAINST REGRESSION: the branch is taken only while NO input bundle has
-- ever been approved AND the two append-only heartbeat tables are both empty. The
-- moment a horse administrator approves a bundle, or any principal lands a single
-- heartbeat, the original critical findings return unchanged and for good --
-- revoking a bundle later cannot re-silence them, because the heartbeat history
-- it produced is append-only. There is no flag, no date and nothing to remember
-- to undo.
--
-- NOT CHANGED, DELIBERATELY: every other branch of this function, including
-- solver_worker_stale, solver_worker_failed, solver_worker_stalled,
-- solver_worker_provenance_split, solver_compactor_unhealthy and
-- solver_pipeline_live, byte for byte. This migration repairs a detector; it
-- does not commission a pipeline and it does not touch the V30 policy path the
-- horses actually run on.
--
-- One transaction. Function only -- no table DDL, no foreign key, no lock on a
-- hot relation. Signature, volatility, security and search_path are reproduced
-- exactly as production holds them; the grants are restated because CREATE OR
-- REPLACE re-declares the function, and they match what production already
-- holds, so no privilege changes.

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
