-- ═══════════════════════════════════════════════════════════════════════════════
--  AN ALARM THAT FAILS TO FILE SAYS SO, AND THE MONEY CHECKS REACH IT
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ── 1. THE SILENT FAILURE ──────────────────────────────────────────────────
--
-- fn_ca_raise_drift_incident ends in:
--
--     EXCEPTION WHEN OTHERS THEN
--       RAISE WARNING 'fn_ca_raise_drift_incident(%) failed: %', p_source, SQLERRM;
--       RETURN NULL;
--
-- Swallowing is CORRECT here and is kept: this is called from inside
-- settlement paths, and an alarm that can roll back a money transaction is
-- worse than an alarm that misses. What is wrong is where the evidence goes.
-- RAISE WARNING lands in the Postgres log, which nothing on this estate reads
-- and which no runbook points at. A failure to file is therefore
-- indistinguishable from nothing being wrong.
--
-- FOUND THE HARD WAY, 2026-09-02. Wiring the reconciler's money criticals into
-- incidents, I called this 901 times and it filed nothing, returning NULL every
-- time. The cause was mine and trivial: I passed layer 'database', and the
-- allowed set is ledger/projection/cache/reporting/settlement/unknown, so every
-- INSERT died on ca_drift_incidents_layer_check. A caller bug that one visible
-- error would have fixed in a minute instead cost an hour and nearly shipped a
-- gate that silently did nothing. A REAL alarm failing would look exactly the
-- same, and would keep looking that way indefinitely.
--
-- ── 2. THE MONEY CHECKS WERE NEVER WIRED ───────────────────────────────────
--
--     ledger_reconcile_log  club_treasury critical rows : 12
--     ca_drift_incidents    club_treasury incidents ever:  0
--
-- Three ledger_reconcile_log sources reach ca_drift_incidents today, and all
-- three are REPORTING checks - no_flop_no_drop, board_not_recorded, and a
-- legacy '?'. Not one money check is wired: club_treasury, player_wallet,
-- seat_stack_exit, negative_balance, frozen_wallets_pool and
-- bomb_award_ledger_gap land in the log and stop.
--
-- So the estate can currently report that a board was not written down, and
-- cannot report that a club treasury is out by ten million. There is one
-- sitting in that log right now: Deep Stack Society holds 2,466,795.25 having
-- paid out 7,500,228.38 against 5,315.38 of journalled income - roughly 9.98
-- million arrived with no chip_ledger row. The drift is constant to the cent
-- across nightly runs while both sides move, which is one historical event
-- rather than a leak. This migration does not touch that money and does not
-- explain it. It makes the finding reachable.
--
-- ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
--
-- It does not widen fn_ca_is_midway_scope, which gates every incident on one
-- hard-coded union (fade0000-...-0001). Deep Stack Society is outside it, so
-- its drift still will not file after this change. Widening that gate would
-- immediately begin filing for ~575 player_wallet and ~320 seat_stack_exit
-- entities that are quietly critical today; that is a paging-volume decision,
-- and it is one line when it is wanted. The wiring is built and correct so
-- that flipping it is all that is left.
--
-- It does not edit reconcile_ledger_nightly. That is a Tier-3 money function
-- whose own migration reproduces every check byte-for-byte and asserts on
-- their presence, because a careless edit there deletes a check silently.
-- Escalation is not reconciliation, so it sits beside it and reads the log the
-- reconciler already writes.
--
-- ONE INCIDENT PER FINDING, NOT ONE PER ROW (issue #2543). The dedupe key
-- carries no date: a treasury out by the same amount for nine nights is one
-- incident seen nine times, which is what occurrences and last_seen_at are for.
--
-- ONE TRANSACTION, one PostgREST schema reload (CLAUDE.md section 2).

BEGIN;

SET LOCAL lock_timeout = '30s';

-- ── 1. Somewhere durable for a failed filing ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_incident_file_failures (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  source       text,
  dedupe_key   text,
  classification text,
  severity     text,
  discrepancy  numeric,
  sqlstate     text,
  message      text,
  db_role      text NOT NULL DEFAULT current_user,
  app_name     text NOT NULL DEFAULT COALESCE(current_setting('application_name', true), '')
);

COMMENT ON TABLE public.ca_incident_file_failures IS
  'Every time fn_ca_raise_drift_incident could not file an incident. The function still swallows the error - it is called from settlement paths and must never roll one back - but the evidence now lands somewhere a person can read instead of only in the Postgres log. Added 2026-09-02 after 901 consecutive silent failures caused by one bad layer value.';

ALTER TABLE public.ca_incident_file_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_incident_file_failures FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.ca_incident_file_failures TO service_role;

CREATE INDEX IF NOT EXISTS idx_ca_incident_file_failures_recent
  ON public.ca_incident_file_failures (occurred_at DESC);

CREATE OR REPLACE FUNCTION public.fn_ca_raise_drift_incident(p_source text, p_classification text, p_severity text, p_dedupe_key text, p_discrepancy numeric, p_expected numeric DEFAULT NULL::numeric, p_actual numeric DEFAULT NULL::numeric, p_layer text DEFAULT 'unknown'::text, p_entity_type text DEFAULT NULL::text, p_entity_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_union_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid, p_tournament_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_settlement_id text DEFAULT NULL::text, p_wallet_ids uuid[] DEFAULT NULL::uuid[], p_transaction_ids uuid[] DEFAULT NULL::uuid[], p_suspected_cause text DEFAULT NULL::text, p_ledger_balanced boolean DEFAULT NULL::boolean, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_class text := p_classification;
  v_sev   text := lower(COALESCE(p_severity,'critical'));
BEGIN
  IF NOT public.fn_ca_is_midway_scope(
    p_union_id, p_club_id, p_table_id, p_tournament_id, p_metadata
  ) THEN
    RETURN NULL;
  END IF;

  IF v_class IS NULL OR v_class NOT IN (
      'ledger_imbalance','settlement_error','duplicate_payment','missing_payment',
      'projection_delay','cache_mismatch','reporting_mismatch','delayed_event',
      'duplicate_event','rounding_error','incorrect_rake','incorrect_weighted_rake',
      'incorrect_rakeback','bbj_error','treasury_error','credit_line_error',
      'cross_club_posting','cross_union_posting','unauthorized_adjustment',
      'historical_migration','unknown') THEN
    v_class := 'unknown';
  END IF;
  IF v_sev NOT IN ('critical','warning','info') THEN v_sev := 'critical'; END IF;

  UPDATE public.ca_drift_incidents
     SET occurrences  = occurrences + 1,
         last_seen_at = now(),
         discrepancy_amount = COALESCE(p_discrepancy, discrepancy_amount),
         actual_amount      = COALESCE(p_actual, actual_amount),
         expected_amount    = COALESCE(p_expected, expected_amount)
   WHERE dedupe_key = p_dedupe_key AND status <> 'resolved'
   RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    INSERT INTO public.ca_incident_events (incident_id, kind, detail)
    VALUES (v_id, 'recurred', jsonb_build_object('source', p_source,
            'discrepancy', p_discrepancy));
    RETURN v_id;
  END IF;

  INSERT INTO public.ca_drift_incidents (
    classification, severity, layer, source, dedupe_key,
    union_id, club_id, entity_type, entity_id, table_id, tournament_id,
    hand_id, settlement_id, wallet_ids, transaction_ids,
    expected_amount, actual_amount, discrepancy_amount,
    ledger_balanced, suspected_cause, metadata)
  VALUES (
    v_class, v_sev, COALESCE(p_layer,'unknown'), p_source, p_dedupe_key,
    p_union_id, p_club_id, p_entity_type, p_entity_id, p_table_id, p_tournament_id,
    p_hand_id, p_settlement_id, p_wallet_ids, p_transaction_ids,
    p_expected, p_actual, COALESCE(p_discrepancy, 0),
    p_ledger_balanced, p_suspected_cause, COALESCE(p_metadata,'{}'::jsonb))
  ON CONFLICT (dedupe_key) WHERE status <> 'resolved' DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    UPDATE public.ca_drift_incidents
       SET occurrences = occurrences + 1, last_seen_at = now()
     WHERE dedupe_key = p_dedupe_key AND status <> 'resolved'
     RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  INSERT INTO public.ca_incident_events (incident_id, kind, detail)
  VALUES (v_id, 'created', jsonb_build_object('source', p_source));

  BEGIN
    PERFORM public.fn_raise_server_financial_alert(
      v_sev, 'drift_incident:' || p_source,
      v_class || ' drift ' || COALESCE(p_discrepancy,0)::text || ' chips',
      jsonb_build_object('incident_id', v_id) || COALESCE(p_metadata,'{}'::jsonb));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  IF p_severity = 'info' THEN
    -- dashboard-only by definition: record, never page
    NULL;
  ELSIF (SELECT count(*) FROM public.ca_drift_incidents
       WHERE created_at > now() - interval '2 minutes') >= 10 THEN
    INSERT INTO public.ca_incident_events (incident_id, kind, detail)
    VALUES (v_id, 'notified', jsonb_build_object('storm_suppressed', true));
  ELSE
    PERFORM public.fn_ca_incident_notify(
      v_id, 'notified',
      '🚨 Chip drift: ' || v_class || ' (' ||
        to_char(COALESCE(p_discrepancy,0),'FM999999999990.00') || ')',
      false);
  END IF;

  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  -- Still swallowed: this runs inside settlement paths and an alarm must never
  -- roll a money transaction back. What changed on 2026-09-02 is that the
  -- evidence now lands somewhere a person reads. RAISE WARNING alone goes to
  -- the Postgres log, so 901 consecutive failures caused by one bad `layer`
  -- value looked exactly like nothing being wrong.
  DECLARE v_state text; v_msg text;
  BEGIN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    RAISE WARNING 'fn_ca_raise_drift_incident(%) failed: %', p_source, v_msg;
    BEGIN
      INSERT INTO public.ca_incident_file_failures
        (source, dedupe_key, classification, severity, discrepancy, sqlstate, message)
      VALUES (p_source, p_dedupe_key, v_class, v_sev, p_discrepancy, v_state, v_msg);
    EXCEPTION WHEN OTHERS THEN
      -- The recorder itself must never be the thing that breaks a settlement.
      NULL;
    END;
    RETURN NULL;
  END;
END $function$;

-- Re-declaring the function above resets nothing about who may call it, but
-- the migration has to SAY so: check-definer-authorization reads the source,
-- not the database, and a SECURITY DEFINER writer that never consults
-- auth.uid() must not be reachable from a browser. Nobody in a browser calls
-- this - it is raised from inside other definer functions, which run as the
-- owner and are unaffected. Production already enforces exactly this (the
-- estate's autorevoke event trigger stripped PUBLIC/anon on apply); these two
-- lines are a no-op there and are what makes a replay into a fresh database
-- correct.
REVOKE ALL ON FUNCTION public.fn_ca_raise_drift_incident(
  text, text, text, text, numeric, numeric, numeric, text, text, uuid, uuid,
  uuid, uuid, uuid, uuid, text, uuid[], uuid[], text, boolean, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_raise_drift_incident(
  text, text, text, text, numeric, numeric, numeric, text, text, uuid, uuid,
  uuid, uuid, uuid, uuid, text, uuid[], uuid[], text, boolean, jsonb
) TO service_role;

-- ── 3. The reconciler's money criticals reach the incident system ──────────
CREATE OR REPLACE FUNCTION public.fn_ca_escalate_reconcile_criticals(
  p_lookback interval DEFAULT interval '36 hours'
)
RETURNS TABLE(considered integer, filed integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $escalate$
DECLARE
  r        record;
  v_seen   integer := 0;
  v_filed  integer := 0;
  v_id     uuid;
  v_class  text;
BEGIN
  FOR r IN
    -- Newest row per entity. An entity critical for a week must not raise
    -- seven incidents; fn_ca_raise_drift_incident counts the recurrence.
    SELECT DISTINCT ON (l.entity_type, l.entity_id)
           l.entity_type, l.entity_id, l.drift, l.ledger_balance,
           l.stored_balance, l.run_date, l.metadata
      FROM public.ledger_reconcile_log l
     WHERE l.severity = 'critical'
       AND l.created_at >= now() - p_lookback
     ORDER BY l.entity_type, l.entity_id, l.created_at DESC
  LOOP
    v_seen := v_seen + 1;

    -- Map onto the classifications the estate already routes on rather than
    -- inventing one; an unknown value silently becomes 'unknown' upstream.
    v_class := CASE r.entity_type
      WHEN 'club_treasury'       THEN 'treasury_error'
      WHEN 'frozen_wallets_pool' THEN 'unauthorized_adjustment'
      ELSE 'ledger_imbalance'
    END;

    v_id := public.fn_ca_raise_drift_incident(
      'ledger_reconcile_log:' || r.entity_type,
      v_class,
      'critical',
      'reconcile:' || r.entity_type || ':' || COALESCE(r.entity_id::text, 'global'),
      COALESCE(r.drift, 0),
      r.ledger_balance,
      r.stored_balance,
      -- MUST be one of ledger/projection/cache/reporting/settlement/unknown.
      -- 'database' is not, and passing it is what made 901 calls vanish.
      'ledger',
      r.entity_type,
      r.entity_id,
      CASE WHEN r.entity_type = 'club_treasury' THEN r.entity_id END,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'reconcile_ledger_nightly reported a critical drift for this '
        || r.entity_type || ': the stored balance and the journal disagree.',
      false,
      COALESCE(r.metadata, '{}'::jsonb)
        || jsonb_build_object('run_date', r.run_date,
                              'escalated_by', 'fn_ca_escalate_reconcile_criticals')
    );

    -- NULL means the incident was not filed. Today that is almost always
    -- fn_ca_is_midway_scope declining an entity outside the piloted union,
    -- which is deliberate; anything else now leaves a row in
    -- ca_incident_file_failures instead of disappearing.
    IF v_id IS NOT NULL THEN
      v_filed := v_filed + 1;
    END IF;
  END LOOP;

  considered := v_seen;
  filed := v_filed;
  RETURN NEXT;
END;
$escalate$;

REVOKE ALL ON FUNCTION public.fn_ca_escalate_reconcile_criticals(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_escalate_reconcile_criticals(interval) TO service_role;

COMMENT ON FUNCTION public.fn_ca_escalate_reconcile_criticals(interval) IS
  'Raises a deduped ca_drift_incidents row for each critical in ledger_reconcile_log. The reconciler writes findings; this is what makes a human hear them. Returns considered/filed so a run that files nothing is visible rather than silent.';

-- ── 4. Something has to call it ────────────────────────────────────────────
-- Hourly, on :52 so it does not collide with the estate's other scheduled
-- work. pg_cron rather than Open Claw deliberately: this reads a database
-- table the reconciler wrote and files into another database table. It is the
-- same shape and the same home as reconcile-ledger-integrity-6h and the seven
-- other ca-* reconciliation jobs already on this database, and it has no
-- application layer to reach.
--
-- The advisory lock is the estate's standard pattern: a slow run must never
-- stack on the next tick.
--
-- The 36-hour DEFAULT window matters. A longer backfill files every historical
-- critical at once, which on 2026-09-02 meant 900 incidents in one call for
-- classes that had stopped days earlier, burying the single current finding.
-- Backfills are for a human running the function by hand with an explicit
-- interval, never for the schedule.
SELECT cron.unschedule('ca-escalate-reconcile-criticals-hourly')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-escalate-reconcile-criticals-hourly');

SELECT cron.schedule(
  'ca-escalate-reconcile-criticals-hourly',
  '52 * * * *',
  $cron$SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-escalate-reconcile-criticals'))
      THEN (SELECT filed FROM public.fn_ca_escalate_reconcile_criticals())
      ELSE NULL END$cron$
);

COMMIT;
