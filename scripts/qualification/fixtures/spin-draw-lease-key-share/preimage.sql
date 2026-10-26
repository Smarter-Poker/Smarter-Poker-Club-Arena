-- Trimmed preimage of public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)
-- as installed on production 2026-10-25 22:40 UTC (pg_get_functiondef MD5
-- 1e5b6175ed91b8fc2112cc2f634fd2e7), before 20261025224305. The header, the
-- declarations it needs, the maintenance advisory lock, the lease lock
-- clause (the defect, byte for byte: the migration's anchor) and the launch
-- receipt check are the production text; the draw, entry proofs, settlement
-- and contract stamp that follow are replaced by a parked stub, because the
-- proof is about the lock the function holds while that body runs, not the
-- body. Fixture bootstrap for scripts/ci/test-spin-draw-lease-key-share-postgres.py
-- only. The FOR UPDATE below is the defect, not a pattern to copy.
CREATE OR REPLACE FUNCTION public.fn_spin_draw_and_settle_atomic(p_tournament_id uuid, p_launch_id uuid, p_lease_generation uuid, p_rule_manifest jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_lease public.engine_tournament_leases%ROWTYPE;
  v_launch public.tournament_launch_receipts%ROWTYPE;
  v_t public.tournaments%ROWTYPE;
BEGIN
  IF public.fn_ca_launch_tournament_start_refused(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','operator_floor_parked');
  END IF;
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;
  SELECT * INTO v_lease FROM public.engine_tournament_leases
   WHERE tournament_id = p_tournament_id FOR UPDATE;
  IF NOT FOUND OR v_lease.protocol_version IS DISTINCT FROM 2
     OR v_lease.lease_generation IS DISTINCT FROM p_lease_generation
     OR v_lease.heartbeat_at IS NULL
     OR v_lease.heartbeat_at < clock_timestamp() - interval '30 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_lease_lost');
  END IF;

  -- Same receipt -> parent order as registration, launch and cancellation.
  PERFORM * FROM public.fn_lock_tournament_launch_proof_parents(ARRAY[p_tournament_id]);
  SELECT * INTO v_launch FROM public.tournament_launch_receipts
   WHERE tournament_id = p_tournament_id;
  SELECT * INTO v_t FROM public.tournaments WHERE id = p_tournament_id;
  IF v_launch.launch_id IS DISTINCT FROM p_launch_id
     OR v_launch.lease_generation IS DISTINCT FROM p_lease_generation
     OR v_launch.completed_at IS NOT NULL
     OR v_t.status IS DISTINCT FROM 'REGISTERING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_state_mismatch');
  END IF;
  -- FIXTURE: the draw, entry proofs, settlement, receipt and contract stamp
  -- (the remaining ~15 KB of the production body) are not reproduced here.
  RETURN jsonb_build_object('ok', true, 'fixture', true, 'launch_id', p_launch_id);
END;
$function$;
