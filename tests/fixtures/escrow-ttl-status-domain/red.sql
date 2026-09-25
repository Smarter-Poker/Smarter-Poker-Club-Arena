-- RED: the installed sweep, over 31 expired held holds, sees nothing.
BEGIN;
DO $$
DECLARE v_n int; v_inc bigint; v_expired bigint;
BEGIN
  SELECT count(*) INTO v_expired FROM public.chip_escrow_holds
   WHERE status = 'held' AND expires_at < now() - interval '10 minutes';
  IF v_expired < 1 THEN RAISE EXCEPTION 'RED setup failed: nothing is expired'; END IF;

  -- Scoped to THIS detector only. An unqualified DELETE here would wipe the
  -- incident board of whatever else is sharing the cluster (2026-09-25: this
  -- rehearsal base is used by more than one task at a time).
  DELETE FROM public.ca_incident_events e
   USING public.ca_drift_incidents i
   WHERE i.id = e.incident_id AND i.source = 'fn_ca_escrow_ttl_sweep';
  DELETE FROM public.ca_drift_incidents WHERE source = 'fn_ca_escrow_ttl_sweep';

  v_n := public.fn_ca_escrow_ttl_sweep();
  SELECT count(*) INTO v_inc FROM public.ca_drift_incidents
   WHERE source = 'fn_ca_escrow_ttl_sweep';

  IF v_n <> 0 THEN
    RAISE EXCEPTION 'RED FAIL: the installed sweep returned %, so the phantom predicate is not the defect', v_n;
  END IF;
  IF v_inc <> 0 THEN
    RAISE EXCEPTION 'RED FAIL: the installed sweep filed % incident(s)', v_inc;
  END IF;
  RAISE NOTICE 'RED PASS: % expired held holds on the table, installed sweep returned 0 and filed 0 incidents', v_expired;
END $$;
COMMIT;
