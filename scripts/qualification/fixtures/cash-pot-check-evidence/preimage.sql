-- SOURCE ONLY / UNRUN. Included only after the primary fixture admission guard.
-- Narrow schema model, not a copied production database. No wallets/payment RPCs.
DO $admission$
BEGIN
  IF current_user<>'postgres'
    OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
    OR current_database()<>'qual_cash_'||replace(current_setting('cash_qualification.execution_uuid')::uuid::text,'-','')
    OR (inet_server_addr() IS NOT NULL AND inet_server_addr() NOT IN ('127.0.0.1'::inet,'::1'::inet))
    OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace)
    OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace)
    OR to_regnamespace('cash_qualification') IS NOT NULL
    OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role'))<>3 THEN
    RAISE EXCEPTION 'cash preimage requires fresh approved local allocation';
  END IF;
END $admission$;
CREATE SCHEMA cash_qualification;
CREATE TABLE cash_qualification.admission(execution_uuid uuid PRIMARY KEY);
INSERT INTO cash_qualification.admission VALUES(current_setting('cash_qualification.execution_uuid')::uuid);
CREATE FUNCTION cash_qualification.assert_true(p_ok boolean,p_label text)
RETURNS void LANGUAGE plpgsql AS $f$ BEGIN
  IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'qualification assertion: %',p_label; END IF;
END $f$;
CREATE FUNCTION cash_qualification.expect_error(p_sql text,p_message text,p_state text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_message text; v_detail text; v_state text; v_caught boolean:=false;
BEGIN
  BEGIN EXECUTE p_sql; EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
    v_caught:=true;
  END;
  PERFORM cash_qualification.assert_true(v_caught AND position(p_message IN v_message)>0
    AND (p_state IS NULL OR p_state=v_state),'expected error: '||p_message);
  RETURN jsonb_build_object('message',v_message,'detail',v_detail,'sqlstate',v_state);
END $f$;
CREATE TABLE public.hand_history(
  id uuid PRIMARY KEY,table_id uuid,hand_number integer,created_at timestamptz,
  tournament_id uuid,pot_size numeric(12,2),rake_amount numeric(12,2),
  bbj_amount numeric(12,2) NOT NULL,winners jsonb
);
CREATE INDEX idx_hand_history_created ON public.hand_history USING btree(created_at DESC);
CREATE TABLE public.financial_alerts(
  context jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  message text NOT NULL,
  resolution text,
  resolved boolean DEFAULT false NOT NULL,
  resolved_at timestamp with time zone,
  resolved_by uuid,
  severity text NOT NULL,
  source text NOT NULL,
  CONSTRAINT financial_alerts_pkey PRIMARY KEY(id)
);
CREATE TABLE public.operational_alert_events(
  alertname text NOT NULL,
  delivery_count bigint DEFAULT 1 NOT NULL,
  event_key text NOT NULL,
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  investigation jsonb DEFAULT '{}'::jsonb NOT NULL,
  investigation_status text DEFAULT 'new'::text NOT NULL,
  last_received_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  severity text NOT NULL,
  source text NOT NULL,
  status text NOT NULL,
  CONSTRAINT operational_alert_events_alertname_check CHECK (((length(alertname) >= 1) AND (length(alertname) <= 240))),
  CONSTRAINT operational_alert_events_event_key_check CHECK (((length(event_key) >= 1) AND (length(event_key) <= 512))),
  CONSTRAINT operational_alert_events_investigation_status_check CHECK ((investigation_status = ANY (ARRAY['new'::text, 'investigating'::text, 'blocked'::text, 'verified_fixed'::text, 'historical'::text, 'test'::text]))),
  CONSTRAINT operational_alert_events_payload_check CHECK (((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 262144))),
  CONSTRAINT operational_alert_events_pkey PRIMARY KEY (id),
  CONSTRAINT operational_alert_events_severity_check CHECK (((length(severity) >= 1) AND (length(severity) <= 40))),
  CONSTRAINT operational_alert_events_source_check CHECK (((length(source) >= 1) AND (length(source) <= 120))),
  CONSTRAINT operational_alert_events_source_event_key_key UNIQUE (source, event_key),
  CONSTRAINT operational_alert_events_status_check CHECK ((status = ANY (ARRAY['firing'::text, 'resolved'::text, 'info'::text])))
);
ALTER TABLE public.operational_alert_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.operational_alert_events FROM PUBLIC,anon,authenticated,service_role;
GRANT ALL ON public.operational_alert_events TO service_role;
CREATE TABLE public.ca_guard_defs(proname text PRIMARY KEY);
-- Captured functions are literal pg_get_functiondef values. The bridge is
-- present for authority checks, but its full production trigger graph is NOT
-- silently mocked as covered. Full integration is an additional bundle gate.
CREATE OR REPLACE FUNCTION public.fn_ca_financial_alert_to_incident()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dedupe text;
  v_echo_id uuid;
  v_severity text;
  v_shape text;
BEGIN
  IF NEW.severity <> 'critical' THEN RETURN NEW; END IF;
  IF NEW.source LIKE 'drift_incident:%' THEN RETURN NEW; END IF;

  /* A REFUSED HAND IS A RATE, NOT AN INCIDENT (2026-09-09). */
  IF NEW.source = 'ServerTableEngine.authoritative_hand_semantic_refusal'
     OR COALESCE(NEW.context->>'error', '') LIKE '%authoritative_hand_semantic_refusal%' THEN
    RETURN NEW;
  END IF;

  /* A HANDOFF THAT NAMES ITS SUCCESSOR IS NOT AN INCIDENT (2026-09-10). */
  IF NEW.source = 'ServerTableEngine.post_commit_obligations_pending' THEN
    RETURN NEW;
  END IF;

  /* ONE CAUSE IS ONE INCIDENT (2026-09-09). The key is the SHAPE of the
     finding, not its instance. */
  v_shape := public.fn_ca_normalize_alert_text(left(NEW.message, 200))
             || '|' ||
             public.fn_ca_normalize_alert_text(left(COALESCE(NEW.context->>'error', ''), 200));

  v_dedupe := CASE
      -- A failed leave can strand this table/hand's stack obligation. Keep its
      -- exact entity; normalizing hand numbers must not merge another leave.
      WHEN NEW.source = 'postHandTasks.leave_pending_failed'
        THEN 'fa:postHandTasks.leave_pending_failed:'
          || CASE
              WHEN jsonb_typeof(NEW.context->'table_id') = 'string'
               AND (NEW.context->>'table_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
               AND jsonb_typeof(NEW.context->'hand_number') = 'number'
               AND (NEW.context->>'hand_number') ~ '^[1-9][0-9]*$'
               AND (length(NEW.context->>'hand_number') < 19
                    OR (length(NEW.context->>'hand_number') = 19
                        AND (NEW.context->>'hand_number') COLLATE "C" <= '9223372036854775807'))
              THEN 'table:' || (NEW.context->>'table_id')::uuid::text
                   || ':hand:' || (NEW.context->>'hand_number')
              ELSE 'alert:' || NEW.id::text
             END
          || ':' || md5(v_shape)
      -- A terminal refusal belongs to one tournament. Normalizing the error
      -- removes its UUID; shape-only folding then mixes different events.
      -- Without an entity, retain the original alert as its own unknown.
      WHEN NEW.source = 'Tournament.atomic_finish_refused'
        THEN 'fa:Tournament.atomic_finish_refused:'
          || COALESCE(NULLIF(lower(NEW.context->>'tournament_id'), ''),
                      'alert:' || NEW.id::text)
          || ':' || md5(v_shape)
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

  /* A DRIFT INCIDENT IS CRITICAL WHEN CHIPS ARE AT STAKE (2026-09-10). */
  v_severity := CASE
      WHEN NEW.source ~* 'conservation' THEN 'info'
      /* THE ENGINE ALREADY DECIDED THIS ONE (2026-09-12, incident bf4ef6e0).
         ServerTableEngineSettlement.runStep raises a financial alert ONLY when
         its moneyCritical argument is true, so every postHandTasks.* row here
         is already filtered to "this moves chips" - the five steps that move
         none (promo_playthrough, horse_rebuys, chip_continuity, horse_cashouts,
         deferred_sitouts) never arrive. Re-deciding it in SQL downgraded all of
         them, on two broken tests: a source-name scan for money words, which
         'leave_pending' fails while returning a player's whole stack to their
         wallet; and COALESCE(discrepancy, amount, 0) = 0 as proof of zero, when
         runStep writes neither key - 0 of 1,551 alerts in seven days carry one,
         so the test was unconditionally true and this branch could only ever
         return info. And info is not a colour: fn_ca_raise_drift_incident opens
         with IF p_severity = 'info' THEN NULL, so six failures across six
         tables paged nobody. When the engine asserts moves_chips in the
         context, that fact decides; absent, critical, because absent must fail
         toward being seen. Compared as text rather than cast to boolean on
         purpose: this trigger ends in EXCEPTION WHEN OTHERS ... RETURN NEW, so
         a bad cast would silently stop creating incidents rather than raise. */
      WHEN NEW.source LIKE 'postHandTasks.%'
        THEN CASE WHEN lower(COALESCE(NEW.context->>'moves_chips','true')) IN ('false','f','0')
                  THEN 'info' ELSE 'critical' END
      WHEN NEW.source LIKE 'ServerTableEngine.%'
           AND NOT (NEW.source ~* 'prize|payout|bounty|rake|treasury|guarantee|insurance|bbj|rakeback')
           AND COALESCE(NULLIF(NEW.context->>'discrepancy','')::numeric,
                        NULLIF(NEW.context->>'amount','')::numeric, 0) = 0
        THEN 'info'
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
    p_table_id       => CASE WHEN NEW.source = 'postHandTasks.leave_pending_failed'
                            THEN CASE WHEN jsonb_typeof(NEW.context->'table_id') = 'string'
                                       AND (NEW.context->>'table_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                                      THEN (NEW.context->>'table_id')::uuid
                                      ELSE NULL::uuid END
                            ELSE NULLIF(NEW.context->>'table_id','')::uuid END,
    p_suspected_cause => left(NEW.message, 300),
    p_metadata       => COALESCE(NEW.context,'{}'::jsonb) ||
                        jsonb_build_object('alert_id', NEW.id));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_financial_alert_to_incident failed: %', SQLERRM;
  RETURN NEW;
END $function$
;
ALTER FUNCTION public.fn_ca_financial_alert_to_incident() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_financial_alert_to_incident() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_financial_alert_to_incident() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist()
 RETURNS text[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY(
    SELECT DISTINCT x FROM unnest(ARRAY[
      'fn_ca_raise_drift_incident','fn_ca_incident_notify','fn_ca_incident_action',
      'fn_ca_incident_escalation_tick','fn_ca_incident_recipient_ids',
      'fn_ca_quick_reconcile','fn_ca_supply_snapshot','fn_ca_diamond_snapshot',
      'fn_ca_suspense_regression_check','fn_ca_settlement_correctness_check',
      'fn_ca_autoledger','fn_ca_autoledger_delete','fn_ca_chip_ledger_enrich',
      'fn_ca_journal_append_only','fn_ca_is_midway_scope',
      'fn_ca_negative_balance_watch','fn_ca_mint_velocity_watch',
      'fn_ca_cron_failure_watch','fn_ca_burnin_gate_tick','fn_ca_midway_burnin_gate',
      'fn_ca_epoch3_preflight','fn_ca_execute_epoch3_reset',
      'fn_club_members_ledger_writer','fn_ca_financial_alert_to_incident',
      'fn_ca_settlement_transition_guard','fn_ca_guard_defs_watch',
      'fn_ca_post_correction','fn_ca_repair_write_failure',
      -- The Diamond money doors (2026-09-12).
      'fn_poker_diamond_reserve','fn_poker_diamond_release',
      'fn_poker_diamond_cashout','fn_poker_diamond_settle_cash_hand',
      'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
      'fn_poker_diamond_seat_keeps_custody','fn_poker_diamond_plain_cash_table',
      -- The unit rules (2026-09-12).
      'fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents',
      'fn_ca_prize_ladder','fn_ca_recovery_fee_cents',
      -- The seat guards that know a tournament seat (2026-09-13).
      'fn_poker_guard_chip_seat','fn_poker_bind_diamond_seat',
      'fn_poker_diamond_entry_custody_is_the_entry',
      -- The Diamond tournament money doors (Phase 8, 2026-09-14): an entry
      -- into custody, an add to it, its refund, its unregistration and
      -- cancellation, the drain, the prize, the fee, the close, the shadow.
      'fn_poker_diamond_tournament_charge','fn_poker_diamond_tournament_custody_add',
      'fn_poker_diamond_tournament_refund','fn_poker_diamond_tournament_unregister',
      'fn_poker_diamond_tournament_cancel','fn_poker_diamond_tournament_drain',
      'fn_poker_diamond_tournament_pay','fn_poker_diamond_tournament_settle_fee',
      'fn_poker_diamond_tournament_close_custody','fn_poker_diamond_tournament_open_shadow',
      -- The two guards Phase 8 taught new names, and the two chip readers it
      -- routes by asset. The wallet guard is the one thing between a browser
      -- and profiles.diamonds.
      'fn_guard_profile_privileged_columns','fn_poker_guard_arena_structure',
      'fn_ca_escrow_can_pay','fn_ca_tournament_escrow',
      -- And the list itself.
      'fn_ca_guard_watchlist'
    ]) x)
$function$
;
ALTER FUNCTION public.fn_ca_guard_watchlist() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_guard_watchlist() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_guard_watchlist() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_cash_pot_conservation_check(p_since_hours integer DEFAULT 24)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  /* BOUNDED AT 48 HOURS, MEASURED (2026-09-01, and the ceiling was 720 for
     about an hour before this).

     Cash hands arrive at roughly 59,000 a day and the per-row cost is a
     jsonb_array_elements sum over `winners`. A 24-hour window reads 58,932
     rows and returns comfortably. A 168-hour window read 463,506 rows and
     returned once, then hit the statement timeout on the very next call an
     hour later when the database was busier - which is the shape of every
     check on this platform that quietly stopped working. fn_spin_unpaid_check
     learned the same lesson the same way ("it read the unbounded view three
     times and timed out every call before 2026-08-31").

     48 hours is double what the engine asks for and still half of what has
     been seen to fail. An operator who wants a week walks it two days at a
     time; a check that cannot finish tells nobody anything. */
  v_hours   integer := LEAST(GREATEST(COALESCE(p_since_hours, 24), 1), 48);
  v_since   timestamptz;
  v_hands   bigint := 0;
  v_bad     bigint := 0;
  v_chips   numeric := 0;
  v_nowin   bigint := 0;
  v_nowin_chips numeric := 0;
  v_alerts  integer := 0;
BEGIN
  v_since := now() - make_interval(hours => v_hours);

  WITH h AS (
    SELECT hh.id, hh.table_id, hh.created_at,
           COALESCE(hh.pot_size, 0)    AS pot,
           COALESCE(hh.rake_amount, 0) AS rake,
           COALESCE(hh.bbj_amount, 0)  AS bbj,
           COALESCE((SELECT sum((e->>'amount')::numeric)
                       FROM jsonb_array_elements(
                         CASE WHEN jsonb_typeof(hh.winners) = 'array'
                              THEN hh.winners ELSE '[]'::jsonb END) e
                      WHERE e ? 'amount'), 0) AS awarded,
           COALESCE(jsonb_array_length(
             CASE WHEN jsonb_typeof(hh.winners) = 'array'
                  THEN hh.winners ELSE '[]'::jsonb END), 0) AS winner_count
      FROM public.hand_history hh
     WHERE hh.tournament_id IS NULL
       AND hh.created_at >= v_since
       AND COALESCE(hh.pot_size, 0) > 0
  )
  SELECT count(*),
         count(*) FILTER (WHERE winner_count > 0 AND abs(pot - rake - bbj - awarded) > 0.01),
         COALESCE(round(sum(abs(pot - rake - bbj - awarded))
                        FILTER (WHERE winner_count > 0
                                  AND abs(pot - rake - bbj - awarded) > 0.01), 2), 0),
         /* A HAND WITH NO WINNER IS NOT AUTOMATICALLY A HAND WITH A PROBLEM
            (2026-09-01, corrected on the first live run). Both hands this
            found - 86ff9441 and 139babb2, 2026-08-30 - had their whole pot
            after rake go to the Bad Beat Jackpot: pot 0.30, rake 0.03, bbj
            0.27, undistributed 0.00. Nobody was owed anything and there was
            nothing wrong. Only a no-winner hand that still HOLDS chips is
            worth an alert. */
         count(*) FILTER (WHERE winner_count = 0 AND pot - rake - bbj > 0.01),
         COALESCE(round(sum(pot - rake - bbj)
                        FILTER (WHERE winner_count = 0 AND pot - rake - bbj > 0.01), 2), 0)
    INTO v_hands, v_bad, v_chips, v_nowin, v_nowin_chips
    FROM h;

  /* One OPEN alert per condition, refreshed by resolving it. A per-hand alert
     would file thousands of rows on a bad day and bury itself, which is the
     failure 20260901170000 exists to stop. */
  IF v_bad > 0 THEN
    PERFORM public.fn_raise_server_financial_alert(
      'critical', 'fn_cash_pot_conservation_check',
      format('%s cash hand(s) in the last %sh did not distribute their pot: %s chips entered pots and did not come out to a player or the rake',
             v_bad, v_hours, v_chips),
      jsonb_build_object('kind','pot_not_distributed','hands',v_bad,
        'chips',v_chips,'since_hours',v_hours,'hands_checked',v_hands,
        'detail','no money was moved by this check'),
      'pot_not_distributed');
    v_alerts := v_alerts + 1;
  END IF;

  IF v_nowin > 0 THEN
    PERFORM public.fn_raise_server_financial_alert(
      'warning', 'fn_cash_pot_conservation_check',
      format('%s cash hand(s) in the last %sh recorded no winner at all while still holding %s chips after rake and jackpot',
             v_nowin, v_hours, v_nowin_chips),
      jsonb_build_object('kind','no_winner_recorded','hands',v_nowin,
        'chips',v_nowin_chips,'since_hours',v_hours,
        'detail','a hand whose whole pot goes to the jackpot has no winner and owes nobody; this counts only the ones still holding chips'),
      'no_winner_recorded');
    v_alerts := v_alerts + 1;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'since_hours', v_hours,
    'hands_checked', v_hands,
    'pot_not_distributed', v_bad,
    'pot_not_distributed_chips', v_chips,
    'no_winner_recorded', v_nowin,
    'no_winner_recorded_chips', v_nowin_chips,
    -- NOT "alerts_raised": the dedupe path returns an existing row's id, so a
    -- standing condition reports itself on every pass without a new row being
    -- written. This counts CONDITIONS that are open, which is what it means.
    'conditions_alerted', v_alerts);
END;
$function$
;
ALTER FUNCTION public.fn_cash_pot_conservation_check(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_cash_pot_conservation_check(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_cash_pot_conservation_check(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_raise_server_financial_alert(p_severity text, p_source text, p_message text, p_context jsonb DEFAULT '{}'::jsonb, p_dedupe_key text DEFAULT NULL::text, p_entity_id text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id     uuid;
  v_sev    text;
  v_source text;
  v_key    text;
  v_entity text;
  v_recent integer;
BEGIN
  v_sev := lower(coalesce(p_severity, 'info'));
  IF v_sev NOT IN ('critical', 'warning', 'info') THEN
    v_sev := 'info';
  END IF;

  v_source := left(coalesce(nullif(p_source, ''), 'unknown'), 200);
  v_entity := left(nullif(btrim(coalesce(p_entity_id, '')), ''), 200);
  v_key    := left(nullif(btrim(coalesce(p_dedupe_key, '')), ''), 200);
  IF v_key IS NULL THEN
    v_key := v_entity;
  END IF;

  /* ONE OPEN ALERT PER THING THAT IS WRONG. Not per pass over it. */
  IF v_key IS NOT NULL THEN
    SELECT fa.id INTO v_id
      FROM public.financial_alerts fa
     WHERE fa.source = v_source
       AND fa.resolved IS NOT TRUE
       AND fa.context ->> 'dedupe_key' = v_key
     ORDER BY fa.created_at DESC
     LIMIT 1;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  SELECT count(*) INTO v_recent
    FROM public.financial_alerts
   WHERE created_at > now() - interval '1 minute'
     AND source = v_source
     AND context ->> 'channel' = 'server_rpc';

  IF v_recent >= 60 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.financial_alerts (severity, source, message, context, resolved)
  VALUES (
    v_sev,
    v_source,
    left(coalesce(nullif(p_message, ''), '(no message)'), 4000),
    coalesce(p_context, '{}'::jsonb)
      || jsonb_build_object('channel', 'server_rpc')
      || CASE WHEN v_key IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object('dedupe_key', v_key) END
      || CASE WHEN v_entity IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object('entity_id', v_entity) END,
    false
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$
;
ALTER FUNCTION public.fn_raise_server_financial_alert(text,text,text,jsonb,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_raise_server_financial_alert(text,text,text,jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_raise_server_financial_alert(text,text,text,jsonb,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_record_operational_alert(p_source text, p_event_key text, p_alertname text, p_status text, p_severity text, p_payload jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_id bigint;
BEGIN
  INSERT INTO public.operational_alert_events(source,event_key,alertname,status,severity,payload)
  VALUES(p_source,p_event_key,p_alertname,p_status,p_severity,p_payload)
  ON CONFLICT (source,event_key) DO UPDATE
  SET last_received_at=clock_timestamp(), delivery_count=operational_alert_events.delivery_count+1
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$
;
ALTER FUNCTION public.fn_record_operational_alert(text,text,text,text,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_record_operational_alert(text,text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_record_operational_alert(text,text,text,text,text,jsonb) TO service_role;
