-- @live-proof: md5(pg_get_functiondef('public.fn_ca_alert_resolution_reaches_the_incident()'::regprocedure))='792e3db7ccbde4efa527176035fce9af'
-- @live-proof: position('storm_member_version' IN pg_get_functiondef('public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure))>0
-- Original incident d205bf24: capped tournament refusals lost their member alert IDs,
-- so the existing resolved-alert trigger could never close the aggregate. Preserve
-- exact members at the original raise; finish their aggregate in the original last
-- member resolution transaction. Private ownership and direct alert mirrors remain.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $pre$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='fn_ca_alert_resolution_reaches_the_incident()'::regprocedure AND md5(pg_get_functiondef(p.oid))='e4a7c3e2099706adf19c4bd3885c6dbb' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.proconfig=ARRAY['search_path=public']::text[] AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'STORM_SOURCE_PREIMAGE_OR_AUTHORITY_CHANGED: fn_ca_alert_resolution_reaches_the_incident'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure AND md5(pg_get_functiondef(p.oid))='b5025fd1a0f856767f3a91166722ed7f' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.proconfig=ARRAY['search_path=public']::text[] AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'STORM_SOURCE_PREIMAGE_OR_AUTHORITY_CHANGED: fn_ca_raise_drift_incident'; END IF;
END $pre$;
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_raise_drift_incident','migration 20261020145408_resolved_financial_alert_storms_close_with_their_exact_membe');
-- Maintained original aggregate/alert resolution transition. No scheduler or money writes.
CREATE OR REPLACE FUNCTION public.fn_ca_alert_resolution_reaches_the_incident()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_state text; v_msg text; v_storm record; v_members bigint; v_bad bigint; v_current boolean;
BEGIN
  IF NOT COALESCE(NEW.resolved,false) OR COALESCE(OLD.resolved,false) THEN
    RETURN NEW;
  END IF;
  UPDATE public.ca_drift_incidents i
     SET status      = 'resolved',
         resolved_at = GREATEST(COALESCE(NEW.resolved_at, now()), i.detected_at),
         correction_ref = COALESCE(NULLIF(i.correction_ref,''),
                                   'verified: closed with financial alert ' || NEW.id::text),
         root_cause  = COALESCE(NULLIF(i.root_cause,''),
                        'This incident is a mirror of financial alert ' || NEW.id::text
                        || ', raised by ' || COALESCE(NEW.source,'an unnamed source')
                        || '. The condition it describes was diagnosed and closed on that '
                        || 'alert; this row exists only because the alert was copied onto '
                        || 'the drift board when it was raised.'),
         resolution  = COALESCE(NULLIF(i.resolution,'') || ' | ', '')
                       || 'Closed with the financial alert it mirrors ('
                       || NEW.id::text || '): '
                       || COALESCE(NULLIF(NEW.resolution,''), 'no note given on the alert')
   WHERE i.status <> 'resolved'
     AND i.metadata->>'alert_id' ~ '^[0-9a-fA-F-]{36}$'
     AND (i.metadata->>'alert_id')::uuid = NEW.id;
  -- The same original resolution transition also owns its capped aggregate.
  -- Lock first, then read membership in a NEW command snapshot: concurrent last
  -- members must observe the predecessor commit, rather than both leave it open.
  IF NEW.source='Tournament.atomic_finish_refused' THEN
    FOR v_storm IN
      SELECT i.id,i.occurrences,i.detected_at FROM public.ca_drift_incidents i
      WHERE i.source='financial_alerts:Tournament.atomic_finish_refused'
        AND i.dedupe_key='storm:financial_alerts:Tournament.atomic_finish_refused'
        AND i.status<>'resolved' AND i.metadata->>'storm_member_version'='1'
      ORDER BY i.id FOR UPDATE
    LOOP
      SELECT count(*),count(*) FILTER(WHERE a.id IS NULL
                 OR a.source IS DISTINCT FROM NEW.source OR a.resolved IS DISTINCT FROM true),
             COALESCE(bool_or(a.id=NEW.id),false)
        INTO v_members,v_bad,v_current
        FROM public.ca_incident_events e
        LEFT JOIN public.financial_alerts a ON a.id=CASE
          WHEN jsonb_typeof(e.detail->'alert_id')='string'
            AND e.detail->>'alert_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          THEN (e.detail->>'alert_id')::uuid END
       WHERE e.incident_id=v_storm.id AND e.kind='recurred';
      IF v_members>0 AND v_members=v_storm.occurrences AND v_bad=0 AND v_current THEN
        UPDATE public.ca_drift_incidents SET status='resolved',
          resolved_at=GREATEST(now(),detected_at),
          closure_basis='verified_remeasured',
          correction_ref='verified: every exact storm member financial alert is resolved',
          root_cause='The original tournament finish refusals were resolved by their authoritative financial alert transitions. This capped incident retained their exact alert identities and every member now has a resolved financial record.',
          resolution='Closed in the last member financial alert resolution transaction after verifying all exact members exist, belong to this source and are resolved. No chips moved for incident closure.'
        WHERE id=v_storm.id AND status<>'resolved';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  /* Never roll back the resolve that triggered us - but never disappear
     either. RAISE WARNING alone is how this defect hid from its own author. */
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  BEGIN
    INSERT INTO public.ca_incident_file_failures
      (source, dedupe_key, classification, severity, discrepancy, sqlstate, message)
    VALUES ('fn_ca_alert_resolution_reaches_the_incident',
            'propagate:alert->incident:' || NEW.id::text,
            'unknown', 'warning', 0, v_state,
            'a resolved alert did not close the incident mirroring it: ' || v_msg);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RAISE WARNING 'fn_ca_alert_resolution_reaches_the_incident failed: %', v_msg;
  RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_ca_raise_drift_incident(p_source text, p_classification text, p_severity text, p_dedupe_key text, p_discrepancy numeric DEFAULT NULL::numeric, p_expected numeric DEFAULT NULL::numeric, p_actual numeric DEFAULT NULL::numeric, p_layer text DEFAULT NULL::text, p_entity_type text DEFAULT NULL::text, p_entity_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_union_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid, p_tournament_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_settlement_id text DEFAULT NULL::text, p_wallet_ids uuid[] DEFAULT NULL::uuid[], p_transaction_ids uuid[] DEFAULT NULL::uuid[], p_suspected_cause text DEFAULT NULL::text, p_ledger_balanced boolean DEFAULT NULL::boolean, p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_class text := p_classification;
  v_sev   text := lower(COALESCE(p_severity,'critical'));
  v_stable text;
  /* A FINDING RECORDS ITS CURRENCY (2026-09-29, Diamond Phase 10). A finding
     whose metadata says asset = diamonds is recorded in diamonds, and its
     alert and headline say Diamonds: the engine's DiamondCustody alerts
     (their context already carries the tag), the Diamond supply snapshot and
     the Diamond rule trigger. Every other finding is filed in chips, word for
     word as before. The headline names the rule when there is one, else the
     detector, and the Diamonds in doubt when there are any. */
  v_currency text := CASE WHEN lower(COALESCE(p_metadata->>'asset', '')) = 'diamonds'
                          THEN 'diamonds' ELSE 'club_chips' END;
  v_diamond_headline text := COALESCE('Diamond rule ' || (p_metadata->>'rule'), p_source)
    || CASE WHEN COALESCE(p_discrepancy, 0) <> 0
            THEN ': ' || to_char(p_discrepancy, 'FM999999999990') || ' Diamonds in doubt'
            ELSE ' is ' || v_sev END;
BEGIN
  IF NOT public.fn_ca_is_midway_scope(
    p_union_id, p_club_id, p_table_id, p_tournament_id, p_metadata
  ) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_detector_registry r WHERE r.source = p_source AND r.status = 'retired') THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.ca_detector_registry (source, owner, sla_hours, note)
  VALUES (p_source, 'unassigned', 24, 'auto-registered on first sight (Phase 6 gate); give it an owner')
  ON CONFLICT (source) DO NOTHING;

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
         expected_amount    = COALESCE(p_expected, expected_amount),
         suspected_cause    = COALESCE(p_suspected_cause, suspected_cause),
         metadata           = COALESCE(p_metadata, metadata)
   WHERE dedupe_key = p_dedupe_key AND status <> 'resolved'
   RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    INSERT INTO public.ca_incident_events (incident_id, kind, detail)
    VALUES (v_id, 'recurred', jsonb_build_object('source', p_source,
            'discrepancy', p_discrepancy));
    RETURN v_id;
  END IF;

  /* ONE STANDING CONDITION IS ONE INCIDENT (2026-09-06).
     A sweep that puts the date in its key defeats the exact-match fold above
     and files a fresh critical every run: sweep:fn_bbj_promo_bank_check:
     2026-09-02 .. -09-06, five rows, all 6705.21, one condition.

     The amount is what makes this safe. `diamond-unexplained:2026-09-02-18`
     is an hourly bucket where each bucket is a DIFFERENT event, so folding on
     the key alone would hide real ones. A standing condition re-reports the
     same number; a new event reports a new one. Same detector, same key
     without its period label, same discrepancy - then and only then is it the
     same finding said twice. */
  v_stable := public.fn_ca_stable_dedupe_key(p_dedupe_key);
  IF v_stable <> p_dedupe_key THEN
    UPDATE public.ca_drift_incidents
       SET occurrences     = occurrences + 1,
           last_seen_at    = now(),
           suspected_cause = COALESCE(p_suspected_cause, suspected_cause),
           metadata        = COALESCE(p_metadata, metadata)
     WHERE status <> 'resolved'
       AND source = p_source
       AND public.fn_ca_stable_dedupe_key(dedupe_key) = v_stable
       AND COALESCE(discrepancy_amount,0) = COALESCE(p_discrepancy,0)
     RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      INSERT INTO public.ca_incident_events (incident_id, kind, detail)
      VALUES (v_id, 'recurred', jsonb_build_object(
        'source', p_source, 'rotated_key', p_dedupe_key,
        'note', 'same condition under a new period label; folded rather than re-filed'));
      RETURN v_id;
    END IF;
  END IF;

  /* DETECTOR STORM CAP (2026-09-09). One source cannot own the board.
     Reached only after the exact-key fold and the stable-key fold above have
     both declined to absorb this finding, i.e. it really would be a NEW row. */
  IF (SELECT count(*) FROM public.ca_drift_incidents
       WHERE source = p_source AND status <> 'resolved') >= 25 THEN
    UPDATE public.ca_drift_incidents
       SET occurrences = occurrences + 1, last_seen_at = now()
     WHERE dedupe_key = 'storm:' || p_source AND status <> 'resolved'
     RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      INSERT INTO public.ca_drift_incidents (
        classification, severity, layer, source, dedupe_key,
        discrepancy_amount, suspected_cause, metadata)
      VALUES ('unknown', v_sev, COALESCE(p_layer,'unknown'), p_source,
        'storm:' || p_source, 0,
        'DETECTOR STORM: this source has 25 or more open incidents, so further findings are counted here rather than filed as new rows. See this incident''s event log for the original capped finding keys and reported discrepancies; this branch does not create a separate financial_alerts row for each finding. Fix the detector, or the condition behind it, then resolve this.',
        jsonb_build_object('storm', true, 'capped_from', p_dedupe_key)
          || CASE WHEN p_source='financial_alerts:Tournament.atomic_finish_refused'
               THEN jsonb_build_object('storm_member_version',1) ELSE '{}'::jsonb END)
      ON CONFLICT (dedupe_key) WHERE status <> 'resolved' DO NOTHING
      RETURNING id INTO v_id;
      IF v_id IS NULL THEN
        UPDATE public.ca_drift_incidents
           SET occurrences = occurrences + 1, last_seen_at = now()
         WHERE dedupe_key = 'storm:' || p_source AND status <> 'resolved'
         RETURNING id INTO v_id;
      END IF;
    END IF;
    IF v_id IS NOT NULL THEN
      INSERT INTO public.ca_incident_events (incident_id, kind, detail)
      VALUES (v_id, 'recurred', jsonb_build_object(
        'source', p_source, 'capped_dedupe_key', p_dedupe_key,
        'discrepancy', p_discrepancy, 'suspected_cause', p_suspected_cause,
        'note', 'counted on the storm incident: this source is over its open-incident cap')
        || CASE WHEN p_source='financial_alerts:Tournament.atomic_finish_refused'
             THEN jsonb_build_object('alert_id',p_metadata->'alert_id') ELSE '{}'::jsonb END);
    END IF;
    RETURN v_id;
  END IF;

  INSERT INTO public.ca_drift_incidents (
    classification, severity, layer, source, dedupe_key,
    union_id, club_id, entity_type, entity_id, table_id, tournament_id,
    hand_id, settlement_id, wallet_ids, transaction_ids,
    expected_amount, actual_amount, discrepancy_amount,
    ledger_balanced, suspected_cause, metadata, currency)
  VALUES (
    v_class, v_sev, COALESCE(p_layer,'unknown'), p_source, p_dedupe_key,
    p_union_id, p_club_id, p_entity_type, p_entity_id, p_table_id, p_tournament_id,
    p_hand_id, p_settlement_id, p_wallet_ids, p_transaction_ids,
    p_expected, p_actual, COALESCE(p_discrepancy, 0),
    p_ledger_balanced, p_suspected_cause, COALESCE(p_metadata,'{}'::jsonb), v_currency)
  ON CONFLICT (dedupe_key) WHERE status <> 'resolved' DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    UPDATE public.ca_drift_incidents
       SET occurrences     = occurrences + 1,
           last_seen_at    = now(),
           suspected_cause = COALESCE(p_suspected_cause, suspected_cause),
           metadata        = COALESCE(p_metadata, metadata)
     WHERE dedupe_key = p_dedupe_key AND status <> 'resolved'
     RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  INSERT INTO public.ca_incident_events (incident_id, kind, detail)
  VALUES (v_id, 'created', jsonb_build_object('source', p_source));

  BEGIN
    PERFORM public.fn_raise_server_financial_alert(
      v_sev, 'drift_incident:' || p_source,
      CASE WHEN v_currency = 'diamonds' THEN v_diamond_headline
           ELSE v_class || ' drift ' || COALESCE(p_discrepancy,0)::text || ' chips' END,
      jsonb_build_object('incident_id', v_id) || COALESCE(p_metadata,'{}'::jsonb));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  IF p_severity = 'info' THEN
    NULL;
  ELSIF (SELECT count(*) FROM public.ca_drift_incidents
       WHERE created_at > now() - interval '2 minutes') >= 10 THEN
    INSERT INTO public.ca_incident_events (incident_id, kind, detail)
    VALUES (v_id, 'notified', jsonb_build_object('storm_suppressed', true));
  ELSE
    PERFORM public.fn_ca_incident_notify(
      v_id, 'notified',
      CASE WHEN v_currency = 'diamonds' THEN v_diamond_headline
           /* A FINDING WITH NO AMOUNT IS NOT A CHIP DRIFT (2026-10-15). A
              liveness check (the knockout door, tables that cannot deal)
              files at 0.00 and is let through by fn_ca_incident_notify; its
              title named "0.00 chip drift" and hid which check fired. It is
              headlined by its detector, as a Diamond rule already is. */
           WHEN COALESCE(p_discrepancy, 0) = 0 THEN p_source || ' is ' || v_sev
           ELSE to_char(COALESCE(p_discrepancy,0),'FM999999999990.00') || ' chip drift: ' || v_class END,
      false);
  END IF;

  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  DECLARE v_state text; v_msg text;
  BEGIN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    RAISE WARNING 'fn_ca_raise_drift_incident(%) failed: %', p_source, v_msg;
    BEGIN
      INSERT INTO public.ca_incident_file_failures
        (source, dedupe_key, classification, severity, discrepancy, sqlstate, message)
      VALUES (p_source, p_dedupe_key, v_class, v_sev, p_discrepancy, v_state, v_msg);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RETURN NULL;
  END;
END $function$
;
REVOKE ALL ON FUNCTION public.fn_ca_alert_resolution_reaches_the_incident() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_alert_resolution_reaches_the_incident() TO postgres,service_role;

REVOKE ALL ON FUNCTION public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb) TO postgres,service_role;

DO $post$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM(VALUES
 ('fn_ca_raise_drift_incident','0d59dc950cdc32ce9df9ac12b02b2c89'),
 ('fn_ca_alert_resolution_reaches_the_incident','792e3db7ccbde4efa527176035fce9af'))v(name,hash)
 LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE pronamespace='public'::regnamespace
 AND proname=r.name AND md5(pg_get_functiondef(p.oid))=r.hash
 AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
 AND p.proconfig=ARRAY['search_path=public']::text[]
 AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}')
 THEN RAISE EXCEPTION 'STORM_POSTIMAGE_OR_AUTHORITY_CHANGED: %',r.name;END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.ca_guard_defs WHERE proname='fn_ca_raise_drift_incident'
 AND def_hash='0d59dc950cdc32ce9df9ac12b02b2c89'
 AND declared_ref='migration 20261020145408_resolved_financial_alert_storms_close_with_their_exact_membe')
 THEN RAISE EXCEPTION 'STORM_GUARD_DECLARATION_CHANGED';END IF;
END $post$;

-- Finite original damage: the pre-version storm has no member alert IDs.
-- Resolve ONLY its frozen 966 original tournament witnesses, never another
-- source or the unrelated cash-settler lag incident. This moves no chips.
DO $historical$
DECLARE v_i public.ca_drift_incidents%ROWTYPE;v_n bigint;v_hash text;v_bad bigint;
BEGIN
 SELECT * INTO v_i FROM public.ca_drift_incidents
 WHERE id='d205bf24-b6ef-4969-9ec7-5e3c03b8b1ec' FOR UPDATE;
 IF NOT FOUND
    OR v_i.source IS DISTINCT FROM 'financial_alerts:Tournament.atomic_finish_refused'
    OR v_i.dedupe_key IS DISTINCT FROM 'storm:financial_alerts:Tournament.atomic_finish_refused'
    OR v_i.occurrences<>966 OR v_i.last_seen_at IS DISTINCT FROM '2026-10-19T21:03:59.928348Z'::timestamptz
 THEN RAISE EXCEPTION 'HISTORICAL_STORM_STATE_CHANGED';END IF;
 IF NOT (
   (v_i.status='open' AND v_i.resolved_at IS NULL)
   OR (v_i.status='resolved'
     AND v_i.resolved_at IS NOT DISTINCT FROM '2026-10-20T15:10:51.090351Z'::timestamptz
     AND v_i.resolved_by IS NOT DISTINCT FROM '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid
     AND v_i.closure_basis IS NOT DISTINCT FROM 'verified_remeasured'
     AND v_i.root_cause IS NOT DISTINCT FROM 'The storm aggregated original terminal-close refusals. Original owner-fee recovery migration 20261019180622 is installed, and every financial alert from both atomic finish refusal and finished-but-not-completed sources is now explicitly resolved. The aggregate retained the historical storm after its source findings resolved.'
     AND v_i.correction_ref IS NOT DISTINCT FROM 'verified: original-close migration 20261019180622; zero unresolved findings across both terminal-close financial sources'
     AND v_i.resolution IS NOT DISTINCT FROM 'Reviewed the resolved source records and their receipt-backed resolution notes. The newest atomic refusal completed with terminal receipt v1, closed zero escrow and 47 payout rows totaling 37100. This closes the historical storm summary only; underlying alerts and receipts remain. No payment or tournament operation was replayed.')
 ) THEN RAISE EXCEPTION 'HISTORICAL_STORM_STATE_CHANGED';END IF;

 IF EXISTS(SELECT 1 FROM public.financial_alerts
   WHERE source='Tournament.atomic_finish_refused' AND NOT COALESCE(resolved,false))
 THEN RAISE EXCEPTION 'HISTORICAL_STORM_HAS_UNRESOLVED_ALERT';END IF;
 IF (SELECT count(*) FROM public.ca_incident_events WHERE incident_id=v_i.id AND kind='recurred')<>966
 OR EXISTS(SELECT 1 FROM public.ca_incident_events WHERE incident_id=v_i.id AND kind='recurred'
   AND COALESCE(detail->>'capped_dedupe_key','')!~'^fa:Tournament[.]atomic_finish_refused:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}$')
 THEN RAISE EXCEPTION 'HISTORICAL_STORM_MEMBERSHIP_CHANGED';END IF;
 WITH ids AS MATERIALIZED(
  SELECT DISTINCT split_part(detail->>'capped_dedupe_key',':',3)::uuid id
  FROM public.ca_incident_events WHERE incident_id=v_i.id AND kind='recurred'
 ) SELECT count(*),md5(string_agg(ids.id::text,',' ORDER BY ids.id)),
 count(*) FILTER(WHERE t.id IS NULL OR t.status IS DISTINCT FROM 'COMPLETED'
   OR ts.tournament_id IS NULL OR es.tournament_id IS NULL
   OR es.prize_balance IS DISTINCT FROM 0 OR es.bounty_balance IS DISTINCT FROM 0
   OR es.fee_balance IS DISTINCT FROM 0 OR ts.completed_at IS NULL
   OR es.terminal_closed_at IS NULL)
 INTO v_n,v_hash,v_bad FROM ids LEFT JOIN public.tournaments t USING(id)
 LEFT JOIN public.tournament_terminal_settlements ts ON ts.tournament_id=ids.id
 LEFT JOIN public.tournament_escrow es ON es.tournament_id=ids.id;
 IF v_n<>966 OR v_hash IS DISTINCT FROM 'b5a9452de4d603aee51225842c389b7f' OR v_bad<>0
 THEN RAISE EXCEPTION 'HISTORICAL_STORM_TERMINAL_PROOF_CHANGED: % % %',v_n,v_hash,v_bad;END IF;
 -- The independently verified closure is preserved only after the same full proof.
 IF v_i.status='resolved' THEN RETURN;END IF;
 UPDATE public.ca_drift_incidents SET status='resolved',closure_basis='verified_remeasured',
 resolved_at=GREATEST(now(),detected_at),resolved_by='2d1cd6c3-5700-4af9-a271-d4863fdab20d',
 root_cause='Direct-owner tournament earning terms caused original fee capture and terminal refusals. Their capped incident dropped member alert IDs, so resolved source alerts could not close the aggregate. The earning and original close source fixes are installed and all 966 exact tournament witnesses are completed.',
 correction_ref='verified: migration 20261020145408; all 966 exact original terminal receipts and zero escrow; no unresolved source alerts',
 resolution='All 966 original referenced tournaments have durable completed terminal receipts and zero prize, bounty and fee escrow. Every original source financial alert is resolved. Exact aggregate membership is now retained and closed by the last member resolution transition. No chips moved for this incident closure.'
 WHERE id=v_i.id AND status='open' AND resolved_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'HISTORICAL_STORM_CLOSURE_LOST';END IF;
END $historical$;

COMMIT;
