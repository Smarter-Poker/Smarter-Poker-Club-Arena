-- tests/fixtures/ledger-invariant/refusal-bootstrap.sql
--
-- The state production is in when *_a_ledger_refusal_is_recorded_outside_its_rollback
-- applies, and the slices of it the recorder touches:
--   * every chip store refuses, settlement_suspense included (20261002073930;
--     suspense-regression.sql leaves it in observe for its last case);
--   * dblink, installed in public as on production;
--   * Supabase Vault: secrets, decrypted_secrets, create_secret, update_secret
--     (the signatures production's vault schema exposes);
--   * the drift board: ca_detector_registry, ca_drift_incidents and
--     fn_ca_raise_drift_incident, which folds a recurrence into the open
--     incident with the same dedupe key exactly as production's does;
--   * fn_ca_cron_failure_watch, production's body verbatim, so the
--     migration's preimage reads the same md5 it reads on production.

UPDATE public.ca_ledger_invariant_store_mode
   SET mode = 'refuse', reason = 'fixture: settlement_suspense refuses (20261002073930)'
 WHERE store = 'settlement_suspense';

CREATE EXTENSION IF NOT EXISTS dblink;

CREATE SCHEMA IF NOT EXISTS vault;
CREATE TABLE vault.secrets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text UNIQUE,
  description text NOT NULL DEFAULT '',
  secret      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE VIEW vault.decrypted_secrets AS
  SELECT id, name, description, secret, secret AS decrypted_secret, created_at, updated_at
    FROM vault.secrets;
CREATE FUNCTION vault.create_secret(new_secret text, new_name text DEFAULT NULL, new_description text DEFAULT '', new_key_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO vault.secrets (name, description, secret) VALUES (new_name, COALESCE(new_description, ''), new_secret) RETURNING id
$$;
CREATE FUNCTION vault.update_secret(secret_id uuid, new_secret text DEFAULT NULL, new_name text DEFAULT NULL, new_description text DEFAULT NULL, new_key_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  UPDATE vault.secrets
     SET secret = COALESCE(new_secret, secret), name = COALESCE(new_name, name),
         description = COALESCE(new_description, description), updated_at = now()
   WHERE id = secret_id
$$;

CREATE TABLE public.ca_detector_registry (
  source             text PRIMARY KEY,
  owner              text,
  sla_hours          integer,
  status             text NOT NULL DEFAULT 'active',
  auto_resolve_hours integer,
  retired_by         text,
  note               text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.ca_drift_incidents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source             text NOT NULL,
  classification     text NOT NULL,
  severity           text NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  dedupe_key         text NOT NULL,
  status             text NOT NULL DEFAULT 'open',
  occurrences        integer NOT NULL DEFAULT 1,
  discrepancy_amount numeric,
  expected_amount    numeric,
  actual_amount      numeric,
  layer              text CHECK (layer IN ('ledger', 'projection', 'cache', 'reporting', 'settlement', 'unknown')),
  entity_type        text,
  suspected_cause    text,
  metadata           jsonb,
  detected_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION public.fn_ca_raise_drift_incident(p_source text, p_classification text, p_severity text, p_dedupe_key text, p_discrepancy numeric DEFAULT NULL::numeric, p_expected numeric DEFAULT NULL::numeric, p_actual numeric DEFAULT NULL::numeric, p_layer text DEFAULT NULL::text, p_entity_type text DEFAULT NULL::text, p_entity_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_union_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid, p_tournament_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_settlement_id text DEFAULT NULL::text, p_wallet_ids uuid[] DEFAULT NULL::uuid[], p_transaction_ids uuid[] DEFAULT NULL::uuid[], p_suspected_cause text DEFAULT NULL::text, p_ledger_balanced boolean DEFAULT NULL::boolean, p_metadata jsonb DEFAULT NULL::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.ca_detector_registry (source, owner, sla_hours, note)
  VALUES (p_source, 'unassigned', 24, 'auto-registered on first sight')
  ON CONFLICT (source) DO NOTHING;
  UPDATE public.ca_drift_incidents
     SET occurrences = occurrences + 1, last_seen_at = now(),
         discrepancy_amount = COALESCE(p_discrepancy, discrepancy_amount),
         actual_amount = COALESCE(p_actual, actual_amount),
         expected_amount = COALESCE(p_expected, expected_amount),
         suspected_cause = COALESCE(p_suspected_cause, suspected_cause),
         metadata = COALESCE(p_metadata, metadata)
   WHERE dedupe_key = p_dedupe_key AND status <> 'resolved'
   RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  INSERT INTO public.ca_drift_incidents
    (source, classification, severity, dedupe_key, discrepancy_amount, expected_amount, actual_amount,
     layer, entity_type, suspected_cause, metadata)
  VALUES
    (p_source, p_classification, lower(COALESCE(p_severity, 'critical')), p_dedupe_key, p_discrepancy, p_expected, p_actual,
     COALESCE(p_layer, 'unknown'), p_entity_type, p_suspected_cause, p_metadata)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.fn_ca_cron_failure_watch()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record; n integer := 0; v_is_guard boolean;
BEGIN
  FOR r IN
    SELECT j.jobname,
           count(*) FILTER (WHERE d.status = 'failed')    AS fails,
           count(*) FILTER (WHERE d.status = 'succeeded') AS successes,
           max(d.start_time) FILTER (WHERE d.status = 'succeeded') AS last_success,
           max(left(d.return_message, 200)) FILTER (WHERE d.status = 'failed') AS sample_error
    FROM cron.job j
    JOIN cron.job_run_details d ON d.jobid = j.jobid
    WHERE j.active AND d.start_time > now() - interval '2 hours'
    GROUP BY j.jobname
    HAVING count(*) FILTER (WHERE d.status = 'failed') >= 5
       AND count(*) FILTER (WHERE d.status = 'succeeded') = 0
    LIMIT 20
  LOOP
    SELECT EXISTS (SELECT 1 FROM public.ca_guard_inventory g
                    WHERE g.kind = 'cron' AND g.object_a = r.jobname AND g.active)
      INTO v_is_guard;
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_cron_failure_watch', 'unknown',
      CASE WHEN v_is_guard THEN 'critical' ELSE 'warning' END,
      'cron-failing:' || r.jobname || ':' || CURRENT_DATE::text,
      0, NULL, NULL, 'reporting', 'cron.job_run_details',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'scheduled job ' || r.jobname || ' has failed ' || r.fails
        || ' times in 2h with zero successes. Last error: ' || COALESCE(r.sample_error, '?'),
      NULL, jsonb_build_object('jobname', r.jobname, 'fails_2h', r.fails,
                               'last_success', r.last_success));
    n := n + 1;
  END LOOP;
  RETURN n;
END $function$;
