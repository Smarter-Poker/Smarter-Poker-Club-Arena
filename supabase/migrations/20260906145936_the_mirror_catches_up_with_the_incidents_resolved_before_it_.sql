-- THE MIRROR CATCHES UP WITH THE INCIDENTS RESOLVED BEFORE IT COULD FOLLOW.
--
-- 20260906113923 made resolution travel both ways between ca_drift_incidents
-- and its financial_alerts mirror ('drift_incident:<source>') - by trigger,
-- so from 11:39 UTC 2026-09-06 onwards. It did not look back. Measured at
-- 14:58 UTC: 75 mirrors still open whose incident had been resolved BEFORE
-- the trigger existed (oldest 2026-09-02 20:35), across fourteen sources -
-- 17 fn_ca_supply_snapshot, 12 fn_ca_guard_defs_watch, 11 fn_bbj_reconcile,
-- 7 fn_ca_erased_seat_credit_sweep, 6 fn_ca_escrow_balance_drift, and so on.
-- Each is a row on the alerts board that says a money question is open when
-- the incident that owns the question was answered days ago.
--
-- This closes each such mirror with the same note the trigger writes today,
-- carrying the incident's own resolution text and timestamp, so the mirror
-- says what happened rather than merely "resolved". It touches ONLY mirrors
-- whose incident is already resolved; an open incident keeps its open mirror.
-- No chips move. The trigger keeps this from recurring.

BEGIN;

DO $catch_up$
DECLARE v_before int; v_after int; v_n int;
BEGIN
  SELECT count(*) INTO v_before
    FROM public.financial_alerts f
    JOIN public.ca_drift_incidents i ON i.id = (f.context->>'incident_id')::uuid
   WHERE NOT COALESCE(f.resolved, false)
     AND f.source LIKE 'drift_incident:%'
     AND f.context->>'incident_id' ~ '^[0-9a-fA-F-]{36}$'
     AND i.status = 'resolved';

  UPDATE public.financial_alerts f
     SET resolved = true,
         resolved_at = now(),
         resolution = COALESCE(NULLIF(f.resolution,'') || ' | ', '')
                      || 'Closed with drift incident ' || i.id::text
                      || ' (resolved ' || to_char(i.resolved_at, 'YYYY-MM-DD HH24:MI:SS "UTC"')
                      || ', before the mirror could follow; caught up by migration 20260906145936): '
                      || COALESCE(NULLIF(i.resolution,''), NULLIF(i.root_cause,''), 'no note given on the incident')
    FROM public.ca_drift_incidents i
   WHERE NOT COALESCE(f.resolved, false)
     AND f.source LIKE 'drift_incident:%'
     AND f.context->>'incident_id' ~ '^[0-9a-fA-F-]{36}$'
     AND i.id = (f.context->>'incident_id')::uuid
     AND i.status = 'resolved';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  SELECT count(*) INTO v_after
    FROM public.financial_alerts f
    JOIN public.ca_drift_incidents i ON i.id = (f.context->>'incident_id')::uuid
   WHERE NOT COALESCE(f.resolved, false)
     AND f.source LIKE 'drift_incident:%'
     AND f.context->>'incident_id' ~ '^[0-9a-fA-F-]{36}$'
     AND i.status = 'resolved';

  IF v_after <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % mirrors of resolved incidents are still open after the catch-up', v_after;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_incident_file_failures
              WHERE occurred_at > now() - interval '1 minute'
                AND source = 'fn_ca_alert_resolution_reaches_the_incident') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the alert->incident propagation filed a failure during the catch-up';
  END IF;
  RAISE NOTICE 'MIRROR_CAUGHT_UP stale mirrors before % closed % still open %', v_before, v_n, v_after;
END $catch_up$;

COMMIT;
