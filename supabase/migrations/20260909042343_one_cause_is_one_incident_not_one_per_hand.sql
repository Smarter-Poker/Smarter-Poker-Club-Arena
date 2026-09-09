-- ONE CAUSE IS ONE INCIDENT, NOT ONE PER HAND (2026-09-09)
-- The board showed 500 open criticals (3,402 in the table). 3,330 of them were
-- THREE engine conditions re-filed once per hand, because the dedupe key was
--     'fa:' || source || ':' || md5(left(message, 200))
-- and all three messages name the hand. Proof: for those three sources the
-- count of distinct message hashes equalled the row count EXACTLY
-- (1154/1154, 1118/1118, 1058/1058), while Satellite.stuck_completing_unawarded
-- - whose message names nothing per-occurrence - folded 534 alerts into ONE
-- incident with occurrences=534, which is what the code comment promises.
-- Cost: a club treasury reconciliation and a diamond-supply breach sat unread
-- behind 3,330 rows of the same three sentences.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_normalize_alert_text(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  /* Order matters. UUIDs first (digits and hyphens), then timestamps, then
     decimals, then bare integers, then whitespace. What is left is the WORDS,
     which is what distinguishes one cause from another. */
  SELECT regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   lower(coalesce(p_text, '')),
                   '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
                   '<id>', 'g'),
                 '\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:?\d{2}|z)?',
                 '<ts>', 'g'),
               '\d+\.\d+', '<amt>', 'g'),
             '\d+', '<n>', 'g'),
           '\s+', ' ', 'g')
$$;

COMMENT ON FUNCTION public.fn_ca_normalize_alert_text(text) IS
  'Strip per-occurrence identifiers (uuid, timestamp, amount, integer) from alert text so the same condition about a different hand hashes to the same incident dedupe key. Added 2026-09-09 after three engine conditions filed 3,330 separate incidents.';

DO $pre$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_financial_alert_to_incident';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_ca_financial_alert_to_incident is missing - the bridge this migration fixes does not exist';
  END IF;
  IF position('md5(left(NEW.message, 200))' in v_src) = 0 THEN
    RAISE EXCEPTION 'the per-hand dedupe expression this migration replaces is not present; the bridge changed underneath this migration - re-read it before applying';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.fn_ca_financial_alert_to_incident()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_dedupe text;
  v_echo_id uuid;
  v_severity text;
  v_shape text;
BEGIN
  IF NEW.severity <> 'critical' THEN RETURN NEW; END IF;
  IF NEW.source LIKE 'drift_incident:%' THEN RETURN NEW; END IF;

  /* ONE CAUSE IS ONE INCIDENT (2026-09-09). The key is the SHAPE of the
     finding, not its instance. The error joins the key because a refusal
     message often names the hand but not the reason - "Table <id> hand #<n>
     was refused by the atomic settlement contract" is one sentence for a
     stale lease and for a vacated seat, and those are different bugs. */
  v_shape := public.fn_ca_normalize_alert_text(left(NEW.message, 200))
             || '|' ||
             public.fn_ca_normalize_alert_text(left(COALESCE(NEW.context->>'error', ''), 200));

  v_dedupe := CASE
      WHEN NEW.source ~* 'prize_credit_failed' AND NULLIF(NEW.context->>'tournament_id','') IS NOT NULL
        THEN 'fa:prize_credit_failed:' || (NEW.context->>'tournament_id')
      ELSE 'fa:' || NEW.source || ':' || md5(v_shape) END;

  SELECT i.id INTO v_echo_id FROM public.ca_drift_incidents i
   WHERE i.dedupe_key = v_dedupe AND i.status = 'resolved'
     AND i.resolved_at > now() - interval '48 hours'
     AND i.suspected_cause = left(NEW.message, 300)
   ORDER BY i.resolved_at DESC LIMIT 1;
  IF v_echo_id IS NOT NULL THEN
    UPDATE public.ca_drift_incidents SET occurrences = occurrences + 1 WHERE id = v_echo_id;
    INSERT INTO public.ca_incident_events (incident_id, at, kind, actor_label, detail)
    VALUES (v_echo_id, now(), 'comment', 'system',
            jsonb_build_object('note', 'Byte-identical echo of this resolved incident re-reported by '
              || NEW.source || '; folded without re-paging (alert ' || NEW.id || ').'));
    RETURN NEW;
  END IF;

  v_severity := CASE
      WHEN NEW.source ~* 'conservation' THEN 'info'
      WHEN NEW.source ~* 'prize_credit_failed'
           AND NULLIF(NEW.context->>'user_id','') IS NOT NULL
           AND public.fn_ca_is_cert_account((NEW.context->>'user_id')::uuid) THEN 'info'
      ELSE 'critical' END;

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
    p_severity       => v_severity,
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

DO $post$
DECLARE v_a text; v_b text; v_c text; v_d text;
BEGIN
  IF position('fn_ca_normalize_alert_text' in
      (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='fn_ca_financial_alert_to_incident')) = 0 THEN
    RAISE EXCEPTION 'the replacement did not take: the bridge still does not normalise';
  END IF;

  v_a := public.fn_ca_normalize_alert_text('Hand 0ece0c6c-6c8e-4133-903a-f34f2d202529#8510686 committed, but its durable post-commit envelope remains behind the causal settlement barrier');
  v_b := public.fn_ca_normalize_alert_text('Hand 926c5a4f-343e-4157-86a0-2b13fea8c865#8511021 committed, but its durable post-commit envelope remains behind the causal settlement barrier');
  IF v_a <> v_b THEN
    RAISE EXCEPTION 'normalisation failed to fold two hands of one condition: [%] vs [%]', v_a, v_b;
  END IF;

  v_c := public.fn_ca_normalize_alert_text('atomic hand commit refused (lease_proof_expired)');
  v_d := public.fn_ca_normalize_alert_text('atomic hand commit refused (rolled_back): seat missing or left for 9ee591b7-2360-4ea8-ad3b-942ef829fbda - hand write rejected whole');
  IF v_c = v_d THEN
    RAISE EXCEPTION 'normalisation over-folded two distinct causes into one key';
  END IF;

  IF public.fn_ca_normalize_alert_text('supply moved 1553.60 unexplained')
     <> public.fn_ca_normalize_alert_text('supply moved 885.27 unexplained') THEN
    RAISE EXCEPTION 'amount normalisation is not working';
  END IF;
END $post$;

COMMIT;
