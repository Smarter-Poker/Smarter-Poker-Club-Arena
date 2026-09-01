-- 03:54 re-page (incident 20336d08): FeeReconciler re-reports the SAME
-- already-root-caused 3.21 overpay every cycle for 24h (byte-identical
-- message), and each re-report after the incident was resolved spawned a
-- fresh critical incident and a fresh push. Under the one-push-per-drift
-- ruling, a byte-identical echo of an incident resolved in the last 48h now
-- FOLDS into that resolved incident (occurrences + an event) instead of
-- re-paging. A genuine recurrence carries different numbers in its message
-- and still raises a new incident.
CREATE OR REPLACE FUNCTION public.fn_ca_financial_alert_to_incident()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dedupe text;
  v_echo_id uuid;
BEGIN
  IF NEW.severity <> 'critical' THEN RETURN NEW; END IF;
  IF NEW.source LIKE 'drift_incident:%' THEN RETURN NEW; END IF;

  v_dedupe := CASE
      WHEN NEW.source ~* 'prize_credit_failed' AND NULLIF(NEW.context->>'tournament_id','') IS NOT NULL
        THEN 'fa:prize_credit_failed:' || (NEW.context->>'tournament_id')
      ELSE 'fa:' || NEW.source || ':' || md5(left(NEW.message, 200)) END;

  -- Echo of a recently resolved incident: identical dedupe key AND identical
  -- suspected cause, resolved within 48h. Fold, do not re-page.
  SELECT i.id INTO v_echo_id FROM public.ca_drift_incidents i
   WHERE i.dedupe_key = v_dedupe AND i.status = 'resolved'
     AND i.resolved_at > now() - interval '48 hours'
     AND i.suspected_cause = left(NEW.message, 300)
   ORDER BY i.resolved_at DESC LIMIT 1;
  IF v_echo_id IS NOT NULL THEN
    UPDATE public.ca_drift_incidents
       SET occurrences = occurrences + 1,
           events = events || jsonb_build_object(
             'at', now(), 'kind', 'comment', 'actor', 'system',
             'detail', 'Byte-identical echo of this resolved incident re-reported by ' || NEW.source || '; folded without re-paging (alert ' || NEW.id || ').')
     WHERE id = v_echo_id;
    RETURN NEW;
  END IF;

  PERFORM public.fn_ca_raise_drift_incident(
    p_source         => 'financial_alerts:' || NEW.source,
    p_classification => CASE
        WHEN NEW.source ~* 'rake'                   THEN 'incorrect_rake'
        WHEN NEW.source ~* 'bbj'                    THEN 'bbj_error'
        WHEN NEW.source ~* 'rakeback'               THEN 'incorrect_rakeback'
        WHEN NEW.source ~* 'treasury|guarantee'     THEN 'treasury_error'
        WHEN NEW.source ~* 'payout|prize|bounty'    THEN 'settlement_error'
        WHEN NEW.source ~* 'insurance'              THEN 'settlement_error'
        WHEN NEW.source ~* 'conservation'           THEN 'ledger_imbalance'
        ELSE 'unknown' END,
    /* Play-chip conservation (tournament AND spin/sng): in-game stacks are
       play chips - no wallet moved. Contained as info: tracked on the
       dashboard, counted by burn-in gate check #12, never paged. Everything
       else stays critical. Ruled 2026-08-31 (alert audit round 3). */
    p_severity       => CASE WHEN NEW.source ~* 'conservation' THEN 'info' ELSE 'critical' END,
    /* One root cause = one incident = one push (per-tournament key for
       prize-credit failures; message-hash key otherwise). */
    p_dedupe_key     => v_dedupe,
    p_discrepancy    => COALESCE(NULLIF(NEW.context->>'discrepancy','')::numeric,
                                 NULLIF(NEW.context->>'amount','')::numeric, 0),
    p_layer          => 'ledger',
    p_club_id        => NULLIF(NEW.context->>'club_id','')::uuid,
    p_tournament_id  => NULLIF(NEW.context->>'tournament_id','')::uuid,
    p_table_id       => NULLIF(NEW.context->>'table_id','')::uuid,
    p_suspected_cause => left(NEW.message, 300),
    p_metadata       => COALESCE(NEW.context,'{}'::jsonb) ||
                        jsonb_build_object('alert_id', NEW.id));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_financial_alert_to_incident failed: %', SQLERRM;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_financial_alert_to_incident() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_financial_alert_to_incident() TO service_role;
