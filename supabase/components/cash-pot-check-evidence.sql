-- SOURCE ONLY / UNRUN. Guarded installation; outside automatic migrations.
-- Requires complete native-qualified positive + independently scheduled failed-cron bundle.
-- Single immutable complete row and typed read-only view; no FK or caller mode change.
-- Exact DDL/resource/provider admission remains mandatory. No checker invocation here.
DO $component$
DECLARE
  v_rollback constant boolean := false;
  v_pre constant text := $captured_pre$CREATE OR REPLACE FUNCTION public.fn_cash_pot_conservation_check(p_since_hours integer DEFAULT 24)
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
$captured_pre$;
  v_post constant text := $candidate_post$CREATE OR REPLACE FUNCTION public.fn_cash_pot_conservation_check(p_since_hours integer DEFAULT 24)
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

  v_check_id uuid := gen_random_uuid();
  v_scan_started timestamptz;
  v_scan_finished timestamptz;
  v_timezone text := current_setting('TimeZone');
  v_r record;
  v_s record;
  v_kind text;
  v_residual numeric;
  v_count integer := 0;
  v_row_bytes integer;
  v_detail_bytes bigint := 2;
  v_rows jsonb[] := ARRAY[]::jsonb[];
  v_anomalies jsonb;
  v_header_bytes integer;
  v_row jsonb;
  v_summary jsonb;
  v_result jsonb;
  v_bad_alert uuid;
  v_nowin_alert uuid;
  v_link uuid;
  v_condition_count bigint;
  v_condition_amount numeric;
  v_severity text;
  v_payload jsonb;
  v_trial jsonb;
  v_preview jsonb;
  v_event_id bigint;
  v_event_key text;

BEGIN
  v_since := now() - make_interval(hours => v_hours);


  v_scan_started := clock_timestamp();
  -- One cursor SQL statement owns the source snapshot. Only admitted narrow
  -- anomalies enter the bounded buffer. An overflow aborts; it is never a sample.
  FOR v_r IN
    SELECT hh.id AS hand_id, hh.table_id, hh.hand_number, hh.created_at,
           COALESCE(hh.pot_size, 0) AS pot,
           COALESCE(hh.rake_amount, 0) AS rake,
           COALESCE(hh.bbj_amount, 0) AS bbj,
           COALESCE((SELECT sum((e->>'amount')::numeric)
                       FROM jsonb_array_elements(
                         CASE WHEN jsonb_typeof(hh.winners) = 'array'
                              THEN hh.winners ELSE '[]'::jsonb END) e
                      WHERE e ? 'amount'), 0) AS awarded,
           COALESCE(jsonb_array_length(
             CASE WHEN jsonb_typeof(hh.winners) = 'array'
                  THEN hh.winners ELSE '[]'::jsonb END), 0) AS winner_count,
           CASE WHEN hh.winners IS NULL THEN 'sql_null'
                WHEN jsonb_typeof(hh.winners) = 'null' THEN 'json_null'
                ELSE jsonb_typeof(hh.winners) END AS winner_state
      FROM public.hand_history hh
     WHERE hh.tournament_id IS NULL
       AND hh.created_at >= v_since
       AND COALESCE(hh.pot_size, 0) > 0
  LOOP
    v_hands := v_hands + 1;
    v_residual := v_r.pot - v_r.rake - v_r.bbj - v_r.awarded;
    IF v_r.winner_count > 0 AND abs(v_residual) > 0.01 THEN
      v_kind := 'pot_not_distributed';
      v_bad := v_bad + 1;
      v_chips := v_chips + abs(v_residual);
    ELSIF v_r.winner_count = 0 AND v_r.pot - v_r.rake - v_r.bbj > 0.01 THEN
      v_kind := 'no_winner_recorded';
      v_nowin := v_nowin + 1;
      v_nowin_chips := v_nowin_chips + (v_r.pot - v_r.rake - v_r.bbj);
    ELSE
      CONTINUE;
    END IF;
    v_count := v_count + 1;
    IF v_count > 10000 THEN
      RAISE EXCEPTION USING ERRCODE='54000', MESSAGE='cash_pot_check_evidence_limit',
        DETAIL=jsonb_build_object('check_id',v_check_id,'limit_kind','anomaly_rows',
          'maximum',10000,'observed_lower_bound',v_count,'partial',true)::text;
    END IF;
    v_row := jsonb_build_object(
      'check_id',v_check_id,'ordinal',v_count,'condition_kind',v_kind,
      'hand_id',v_r.hand_id,'table_id',v_r.table_id,'hand_number',v_r.hand_number,
      'created_at',v_r.created_at,'pot',v_r.pot,'rake',v_r.rake,'bbj',v_r.bbj,
      'recorded_awarded',v_r.awarded,'winner_count',v_r.winner_count,
      'winner_state',v_r.winner_state,'signed_residual',v_residual,
      'absolute_residual',abs(v_residual));
    v_row_bytes := octet_length(convert_to(v_row::text,'UTF8'));
    -- Bound every narrow element before buffering. JSONB array text uses
    -- comma-space separators; verify the final serializer length below too.
    v_row := v_row || jsonb_build_object('evidence_bytes',v_row_bytes);
    v_detail_bytes := v_detail_bytes + octet_length(convert_to(v_row::text,'UTF8'))
      + CASE WHEN v_count>1 THEN 2 ELSE 0 END;
    IF v_detail_bytes > 8388608 THEN
      RAISE EXCEPTION USING ERRCODE='54000', MESSAGE='cash_pot_check_evidence_limit',
        DETAIL=jsonb_build_object('check_id',v_check_id,'limit_kind','narrow_evidence_bytes',
          'maximum',8388608,'observed_lower_bound',v_detail_bytes,'partial',true)::text;
    END IF;
    v_rows := array_append(v_rows,v_row);
  END LOOP;
  v_scan_finished := clock_timestamp();
  -- Preserve the original SUM/ROUND/COALESCE values, including numeric zero.
  v_chips := CASE WHEN v_bad > 0 THEN round(v_chips,2) ELSE 0 END;
  v_nowin_chips := CASE WHEN v_nowin > 0 THEN round(v_nowin_chips,2) ELSE 0 END;

  /* One OPEN alert per condition, refreshed by resolving it. A per-hand alert
     would file thousands of rows on a bad day and bury itself, which is the
     failure 20260901170000 exists to stop. */
  IF v_bad > 0 THEN
    v_bad_alert := public.fn_raise_server_financial_alert(
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
    v_nowin_alert := public.fn_raise_server_financial_alert(
      'warning', 'fn_cash_pot_conservation_check',
      format('%s cash hand(s) in the last %sh recorded no winner at all while still holding %s chips after rake and jackpot',
             v_nowin, v_hours, v_nowin_chips),
      jsonb_build_object('kind','no_winner_recorded','hands',v_nowin,
        'chips',v_nowin_chips,'since_hours',v_hours,
        'detail','a hand whose whole pot goes to the jackpot has no winner and owes nobody; this counts only the ones still holding chips'),
      'no_winner_recorded');
    v_alerts := v_alerts + 1;
  END IF;

  v_result := jsonb_build_object(
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

  IF v_count > 0 THEN
    v_summary := jsonb_build_object(
      'check_id',v_check_id,'schema_version',1,'source_contract','cash-pot-check-evidence/v1',
      'baseline_definition_md5','484ca087624199de5a28678a2799ff75',
      'requested_since_hours',p_since_hours,'effective_since_hours',v_hours,
      'transaction_reference_at',now(),'lower_bound_inclusive',v_since,
      'upper_bound',NULL,'window_semantics','lower_only_statement_snapshot',
      'scan_started_at',v_scan_started,'scan_finished_at',v_scan_finished,
      'serialization_timezone',v_timezone,'result',v_result,
      'financial_alert_ids',jsonb_build_object('pot_not_distributed',v_bad_alert,
                                              'no_winner_recorded',v_nowin_alert),
      'financial_link_semantics','exact_rpc_return_not_new_versus_reused',
      'amount_semantics','recorded_hand_arithmetic_not_payment_proof');
    -- One conversion of an already admitted buffer, not an unbounded source
    -- aggregation. Copy/allocation costs still require native resource proof.
    v_anomalies := to_jsonb(v_rows);
    IF jsonb_array_length(v_anomalies) IS DISTINCT FROM v_count
       OR octet_length(convert_to(v_anomalies::text,'UTF8')) IS DISTINCT FROM v_detail_bytes THEN
      RAISE EXCEPTION 'cash_pot_check_evidence_serialization_mismatch check_id=%',v_check_id;
    END IF;
    v_header_bytes := octet_length(convert_to(v_summary::text,'UTF8'));
    IF v_detail_bytes + v_header_bytes > 8388608 THEN
      RAISE EXCEPTION USING ERRCODE='54000', MESSAGE='cash_pot_check_evidence_limit',
        DETAIL=jsonb_build_object('check_id',v_check_id,'limit_kind','narrow_evidence_bytes',
          'maximum',8388608,'observed_lower_bound',v_detail_bytes+v_header_bytes,'partial',true)::text;
    END IF;
    -- A single immutable complete record. There is no provisional header or
    -- deferred FK, and no caller constraint mode is changed.
    INSERT INTO public.ca_cash_pot_check_evidence(
      check_id,schema_version,source_contract,summary,anomalies,anomaly_rows,detail_bytes,header_bytes)
    VALUES(v_check_id,1,'cash-pot-check-evidence/v1',v_summary,v_anomalies,v_count,v_detail_bytes,v_header_bytes);

    FOREACH v_kind IN ARRAY ARRAY['pot_not_distributed','no_winner_recorded'] LOOP
      v_condition_count := CASE WHEN v_kind='pot_not_distributed' THEN v_bad ELSE v_nowin END;
      IF v_condition_count=0 THEN CONTINUE; END IF;
      v_link := CASE WHEN v_kind='pot_not_distributed' THEN v_bad_alert ELSE v_nowin_alert END;
      v_condition_amount := CASE WHEN v_kind='pot_not_distributed' THEN v_chips ELSE v_nowin_chips END;
      v_severity := CASE WHEN v_kind='pot_not_distributed' THEN 'critical' ELSE 'warning' END;
      v_preview := '[]'::jsonb;
      v_payload := jsonb_build_object(
        'schema_version',1,'check_id',v_check_id,'source_contract','cash-pot-check-evidence/v1',
        'target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca',
        'condition_kind',v_kind,'condition_count',v_condition_count,
        'condition_amount',v_condition_amount,'financial_alert_id',v_link,
        'financial_link_outcome',CASE WHEN v_link IS NULL THEN 'rpc_returned_null' ELSE 'linked' END,
        'evidence_table','ca_cash_pot_check_evidence','detail_table','ca_cash_pot_check_anomalies',
        'stored_anomaly_rows',v_count,'stored_omitted_count',0,
        'narrow_evidence_bytes',v_detail_bytes+v_header_bytes,
        'preview_order','created_at,hand_id','preview_limit',20,
        'preview',v_preview,'preview_count',0,'preview_omitted_count',v_condition_count,
        'amount_semantics','recorded_hand_arithmetic_not_payment_proof',
        'window',jsonb_build_object('transaction_reference_at',now(),'lower_bound_inclusive',v_since,
          'upper_bound',NULL,'effective_since_hours',v_hours,'semantics','lower_only_statement_snapshot'),
        'scan_started_at',v_scan_started,'scan_finished_at',v_scan_finished);
      IF octet_length(convert_to(v_payload::text,'UTF8')) > 32768 THEN
        RAISE EXCEPTION USING ERRCODE='54000', MESSAGE='cash_pot_check_evidence_limit',
          DETAIL=jsonb_build_object('check_id',v_check_id,'limit_kind','queue_envelope_bytes',
            'maximum',32768,'observed_lower_bound',octet_length(convert_to(v_payload::text,'UTF8')),
            'partial',true)::text;
      END IF;
      FOR v_s IN SELECT * FROM public.ca_cash_pot_check_anomalies
        WHERE check_id=v_check_id AND condition_kind=v_kind
        ORDER BY created_at,hand_id LIMIT 20
      LOOP
        v_trial := v_preview || jsonb_build_array(to_jsonb(v_s)-'check_id'-'evidence_bytes');
        v_trial := v_payload || jsonb_build_object('preview',v_trial,
          'preview_count',jsonb_array_length(v_trial),
          'preview_omitted_count',v_condition_count-jsonb_array_length(v_trial));
        IF octet_length(convert_to(v_trial::text,'UTF8')) > 32768 THEN EXIT; END IF;
        v_payload := v_trial;
        v_preview := v_payload->'preview';
      END LOOP;
      v_event_key := v_check_id::text || ':' || v_kind;
      v_event_id := public.fn_record_operational_alert(
        'cash-pot-conservation-measurement',v_event_key,'CashPotConservation:'||v_kind,
        'firing',v_severity,v_payload);
      IF v_event_id IS NULL OR v_event_id <= 0 OR NOT EXISTS (
        SELECT 1 FROM public.operational_alert_events e WHERE e.id=v_event_id
          AND e.source='cash-pot-conservation-measurement' AND e.event_key=v_event_key
          AND e.alertname='CashPotConservation:'||v_kind AND e.status='firing'
          AND e.severity=v_severity AND e.payload=v_payload) THEN
        RAISE EXCEPTION 'cash_pot_check_evidence_receipt_mismatch check_id=% condition=%',v_check_id,v_kind;
      END IF;
    END LOOP;
  END IF;
  RETURN v_result;

END;
$function$
$candidate_post$;
  v_guard constant text := $guard_definition$CREATE OR REPLACE FUNCTION public.fn_ca_cash_pot_evidence_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_actual record; v_j jsonb; v_r record; v_position integer:=0; v_keys text[];
BEGIN
  IF TG_OP IN ('UPDATE','DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'cash_pot_check_evidence_is_immutable';
  END IF;
  IF TG_OP <> 'INSERT' OR TG_TABLE_SCHEMA <> 'public'
     OR TG_TABLE_NAME <> 'ca_cash_pot_check_evidence' THEN
    RAISE EXCEPTION 'cash_pot_check_evidence_guard_wrong_target';
  END IF;
  IF jsonb_typeof(NEW.anomalies) IS DISTINCT FROM 'array'
     OR jsonb_array_length(NEW.anomalies) NOT BETWEEN 1 AND 10000
     OR NEW.detail_bytes IS DISTINCT FROM octet_length(convert_to(NEW.anomalies::text,'UTF8'))
     OR NEW.header_bytes IS DISTINCT FROM octet_length(convert_to(NEW.summary::text,'UTF8'))
     OR NEW.detail_bytes+NEW.header_bytes>8388608 THEN
    RAISE EXCEPTION 'cash_pot_check_evidence_array_mismatch';
  END IF;
  FOR v_j IN SELECT value FROM jsonb_array_elements(NEW.anomalies) LOOP
    v_position:=v_position+1;
    IF jsonb_typeof(v_j) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'cash_pot_check_evidence_detail_mismatch';
    END IF;
    SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(v_j) k;
    IF v_keys IS DISTINCT FROM ARRAY['absolute_residual','bbj','check_id','condition_kind','created_at','evidence_bytes','hand_id','hand_number','ordinal','pot','rake','recorded_awarded','signed_residual','table_id','winner_count','winner_state']::text[]
       OR jsonb_typeof(v_j->'check_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_j->'hand_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_j->'ordinal') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_j->'evidence_bytes') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_j->'winner_count') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_j->'condition_kind') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_j->'winner_state') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_j->'created_at') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_j->'table_id') NOT IN ('string','null')
       OR jsonb_typeof(v_j->'hand_number') NOT IN ('number','null')
       OR EXISTS(SELECT 1 FROM unnest(ARRAY['pot','rake','bbj','recorded_awarded','signed_residual','absolute_residual']) k
          WHERE jsonb_typeof(v_j->k)<>'number'
            AND NOT(jsonb_typeof(v_j->k)='string' AND v_j->>k IN ('NaN','Infinity','-Infinity'))) THEN
      RAISE EXCEPTION 'cash_pot_check_evidence_detail_mismatch';
    END IF;
    SELECT * INTO v_r FROM jsonb_to_record(v_j) AS d(
      check_id uuid,
      ordinal integer,
      condition_kind text,
      hand_id uuid,
      table_id uuid,
      hand_number integer,
      created_at timestamptz,
      pot numeric,
      rake numeric,
      bbj numeric,
      recorded_awarded numeric,
      winner_count integer,
      winner_state text,
      signed_residual numeric,
      absolute_residual numeric,
      evidence_bytes integer);
    IF v_r.check_id IS DISTINCT FROM NEW.check_id OR v_j->>'check_id' IS DISTINCT FROM NEW.check_id::text
       OR v_r.hand_id IS NULL OR v_j->>'hand_id' IS DISTINCT FROM v_r.hand_id::text
       OR v_r.ordinal IS DISTINCT FROM v_position OR v_r.created_at IS NULL
       OR v_r.winner_count IS NULL OR v_r.winner_count<0
       OR (v_r.pot>0) IS DISTINCT FROM true
       OR (v_r.winner_state<>'array' AND v_r.winner_count<>0)
       OR (v_r.winner_count=0 AND v_r.recorded_awarded<>0)
       OR v_r.winner_state NOT IN ('sql_null','json_null','array','object','string','number','boolean')
       OR v_r.evidence_bytes IS DISTINCT FROM octet_length(convert_to((v_j-'evidence_bytes')::text,'UTF8'))
       OR v_r.signed_residual IS DISTINCT FROM v_r.pot-v_r.rake-v_r.bbj-v_r.recorded_awarded
       OR v_r.absolute_residual IS DISTINCT FROM abs(v_r.signed_residual)
       OR (CASE WHEN v_r.condition_kind='pot_not_distributed'
            THEN v_r.winner_count>0 AND v_r.absolute_residual>0.01
            WHEN v_r.condition_kind='no_winner_recorded'
            THEN v_r.winner_count=0 AND v_r.pot-v_r.rake-v_r.bbj>0.01
            ELSE false END) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'cash_pot_check_evidence_detail_mismatch';
    END IF;
  END LOOP;
  SELECT count(*) n,count(DISTINCT hand_id) distinct_hands,
         count(*) FILTER (WHERE condition_kind='pot_not_distributed') bad,
         COALESCE(round(sum(absolute_residual) FILTER (WHERE condition_kind='pot_not_distributed'),2),0) bad_chips,
         count(*) FILTER (WHERE condition_kind='no_winner_recorded') nowin,
         COALESCE(round(sum(pot-rake-bbj) FILTER (WHERE condition_kind='no_winner_recorded'),2),0) nowin_chips
    INTO v_actual FROM jsonb_to_recordset(NEW.anomalies) AS d(
      check_id uuid,
      ordinal integer,
      condition_kind text,
      hand_id uuid,
      table_id uuid,
      hand_number integer,
      created_at timestamptz,
      pot numeric,
      rake numeric,
      bbj numeric,
      recorded_awarded numeric,
      winner_count integer,
      winner_state text,
      signed_residual numeric,
      absolute_residual numeric,
      evidence_bytes integer);
  IF v_actual.n IS DISTINCT FROM NEW.anomaly_rows OR v_actual.distinct_hands IS DISTINCT FROM v_actual.n
     OR NEW.summary->>'check_id' IS DISTINCT FROM NEW.check_id::text
     OR NEW.summary->>'schema_version' IS DISTINCT FROM NEW.schema_version::text
     OR NEW.summary->>'source_contract' IS DISTINCT FROM NEW.source_contract
     OR (NEW.summary#>>'{result,ok}')::boolean IS DISTINCT FROM true
     OR (NEW.summary#>>'{result,hands_checked}')::bigint < v_actual.n
     OR (NEW.summary#>>'{result,hands_checked}') IS NULL
     OR (NEW.summary#>>'{result,pot_not_distributed}')::bigint IS DISTINCT FROM v_actual.bad
     OR (NEW.summary#>>'{result,pot_not_distributed_chips}')::numeric IS DISTINCT FROM v_actual.bad_chips
     OR (NEW.summary#>>'{result,no_winner_recorded}')::bigint IS DISTINCT FROM v_actual.nowin
     OR (NEW.summary#>>'{result,no_winner_recorded_chips}')::numeric IS DISTINCT FROM v_actual.nowin_chips
     OR (NEW.summary#>>'{result,conditions_alerted}')::integer IS DISTINCT FROM
       (CASE WHEN v_actual.bad>0 THEN 1 ELSE 0 END+CASE WHEN v_actual.nowin>0 THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'cash_pot_check_evidence_header_mismatch';
  END IF;
  RETURN NEW;
END;
$function$
$guard_definition$;
  v_header_body constant text := $header_shape$(
  check_id uuid CONSTRAINT ca_cash_pot_check_evidence_pkey PRIMARY KEY,
  schema_version smallint NOT NULL DEFAULT 1 CONSTRAINT cash_check_schema_version CHECK (schema_version=1),
  source_contract text NOT NULL CONSTRAINT cash_check_source_contract CHECK (source_contract='cash-pot-check-evidence/v1'),
  summary jsonb NOT NULL CONSTRAINT cash_check_summary_object CHECK (jsonb_typeof(summary)='object'),
  anomalies jsonb NOT NULL CONSTRAINT cash_check_anomalies_array CHECK (jsonb_typeof(anomalies)='array'),
  anomaly_rows integer NOT NULL CONSTRAINT cash_check_anomaly_rows CHECK (anomaly_rows BETWEEN 1 AND 10000),
  detail_bytes bigint NOT NULL CONSTRAINT cash_check_detail_bytes CHECK (detail_bytes BETWEEN 1 AND 8388608),
  header_bytes integer NOT NULL CONSTRAINT cash_check_header_bytes CHECK (header_bytes BETWEEN 1 AND 8388608),
  evidence_bytes bigint GENERATED ALWAYS AS (detail_bytes+header_bytes) STORED
    CONSTRAINT cash_check_evidence_bytes CHECK (evidence_bytes<=8388608),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
)$header_shape$;
  v_view_select constant text := $view_shape$SELECT d.* FROM %s h
CROSS JOIN LATERAL jsonb_to_recordset(h.anomalies) AS d(
      check_id uuid,
      ordinal integer,
      condition_kind text,
      hand_id uuid,
      table_id uuid,
      hand_number integer,
      created_at timestamptz,
      pot numeric,
      rake numeric,
      bbj numeric,
      recorded_awarded numeric,
      winner_count integer,
      winner_state text,
      signed_residual numeric,
      absolute_residual numeric,
      evidence_bytes integer)$view_shape$;
  v_oid oid; v_actual text; v_target text; v_new boolean;
  v_model_h text; v_model_d text; v_model_header_oid oid; v_suffix text;
  v_dep record; v_actual_rel oid; v_model_rel oid; v_actual_json jsonb; v_model_json jsonb;
BEGIN
  PERFORM set_config('search_path','public, pg_temp',true);
  PERFORM pg_advisory_xact_lock(hashtextextended('component:cash-pot-check-evidence',0));
  IF current_user<>'postgres' OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR md5(v_pre)<>'484ca087624199de5a28678a2799ff75' THEN
    RAISE EXCEPTION 'cash evidence owner/server/preimage mismatch';
  END IF;
  v_oid := to_regprocedure('public.fn_cash_pot_conservation_check(integer)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'cash evidence exact target missing'; END IF;
  v_actual := pg_get_functiondef(v_oid);
  IF v_actual IS DISTINCT FROM v_pre AND v_actual IS DISTINCT FROM v_post THEN
    RAISE EXCEPTION 'cash evidence unknown target preimage/postimage';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=v_oid
      AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
      AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}')
    OR (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace
          AND proname='fn_cash_pot_conservation_check')<>1 THEN
    RAISE EXCEPTION 'cash evidence target authority/overload drift';
  END IF;
  FOR v_dep IN SELECT * FROM (VALUES
    ('public.fn_raise_server_financial_alert(text,text,text,jsonb,text,text)','264d32bcba8f6430ea68b7ca9738fbc8',true,'search_path=public'),
    ('public.fn_record_operational_alert(text,text,text,text,text,jsonb)','36601e205494e8768f5a1dce09f4a186',false,'search_path=pg_catalog, public'),
    ('public.fn_ca_financial_alert_to_incident()','00a43ae03ab12cec9505e2bfed71d937',true,'search_path=public'),
    ('public.fn_ca_guard_watchlist()','92ee208d0887728444bda396d0b4d442',false,'search_path=public')
  ) d(signature,definition_md5,secdef,setting) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(v_dep.signature)
       AND md5(pg_get_functiondef(p.oid))=v_dep.definition_md5
       AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=v_dep.secdef
       AND p.proconfig IS NOT DISTINCT FROM ARRAY[v_dep.setting]::text[]
       AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
      RAISE EXCEPTION 'cash evidence dependency drift %',v_dep.signature;
    END IF;
  END LOOP;
  IF 'fn_cash_pot_conservation_check'=ANY(public.fn_ca_guard_watchlist())
     OR EXISTS(SELECT 1 FROM public.ca_guard_defs WHERE proname='fn_cash_pot_conservation_check') THEN
    RAISE EXCEPTION 'cash evidence target guard mode changed';
  END IF;
  LOCK TABLE public.hand_history,public.financial_alerts,public.operational_alert_events IN ACCESS SHARE MODE;
  FOR v_dep IN SELECT * FROM (VALUES
    ('id','uuid',true),('table_id','uuid',false),('hand_number','integer',false),
    ('created_at','timestamp with time zone',false),('tournament_id','uuid',false),
    ('pot_size','numeric(12,2)',false),('rake_amount','numeric(12,2)',false),
    ('bbj_amount','numeric(12,2)',true),('winners','jsonb',false)
  ) d(column_name,type_name,not_null) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.hand_history'::regclass
        AND a.attname=v_dep.column_name AND a.attnum>0 AND NOT a.attisdropped
        AND format_type(a.atttypid,a.atttypmod)=v_dep.type_name AND a.attnotnull=v_dep.not_null) THEN
      RAISE EXCEPTION 'cash evidence source column drift %',v_dep.column_name;
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.hand_history'::regclass
       AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (id)')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.operational_alert_events'::regclass
       AND contype='u' AND convalidated AND pg_get_constraintdef(oid)='UNIQUE (source, event_key)')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.operational_alert_events'::regclass
       AND contype='p' AND convalidated AND pg_get_constraintdef(oid)='PRIMARY KEY (id)')
    OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.operational_alert_events'::regclass
       AND relrowsecurity AND NOT relforcerowsecurity AND pg_get_userbyid(relowner)='postgres'
       AND relacl::text='{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}')
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.operational_alert_events'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'cash evidence source/queue identity or authority drift';
  END IF;

  FOR v_dep IN SELECT * FROM (VALUES
    ('operational_alert_events','alertname','text',true,'',NULL),
    ('financial_alerts','context','jsonb',false,'','''{}''::jsonb'),
    ('financial_alerts','created_at','timestamp with time zone',true,'','now()'),
    ('operational_alert_events','delivery_count','bigint',true,'','1'),
    ('operational_alert_events','event_key','text',true,'',NULL),
    ('operational_alert_events','id','bigint',true,'a',NULL),
    ('financial_alerts','id','uuid',true,'','gen_random_uuid()'),
    ('operational_alert_events','investigation','jsonb',true,'','''{}''::jsonb'),
    ('operational_alert_events','investigation_status','text',true,'','''new''::text'),
    ('operational_alert_events','last_received_at','timestamp with time zone',true,'','clock_timestamp()'),
    ('financial_alerts','message','text',true,'',NULL),
    ('operational_alert_events','payload','jsonb',true,'',NULL),
    ('operational_alert_events','received_at','timestamp with time zone',true,'','clock_timestamp()'),
    ('financial_alerts','resolution','text',false,'',NULL),
    ('financial_alerts','resolved','boolean',true,'','false'),
    ('financial_alerts','resolved_at','timestamp with time zone',false,'',NULL),
    ('financial_alerts','resolved_by','uuid',false,'',NULL),
    ('financial_alerts','severity','text',true,'',NULL),
    ('operational_alert_events','severity','text',true,'',NULL),
    ('financial_alerts','source','text',true,'',NULL),
    ('operational_alert_events','source','text',true,'',NULL),
    ('operational_alert_events','status','text',true,'',NULL)
  ) d(table_name,column_name,type_name,not_null,identity_kind,default_expression) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_attribute a LEFT JOIN pg_attrdef x
        ON x.adrelid=a.attrelid AND x.adnum=a.attnum
      WHERE a.attrelid=to_regclass('public.'||v_dep.table_name) AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname=v_dep.column_name AND format_type(a.atttypid,a.atttypmod)=v_dep.type_name
        AND a.attnotnull=v_dep.not_null AND a.attidentity::text=v_dep.identity_kind
        AND pg_get_expr(x.adbin,x.adrelid) IS NOT DISTINCT FROM v_dep.default_expression) THEN
      RAISE EXCEPTION 'cash evidence dependency column/default drift %.%',v_dep.table_name,v_dep.column_name;
    END IF;
  END LOOP;
  FOR v_dep IN SELECT * FROM (VALUES
    ('public.hand_history','CREATE INDEX idx_hand_history_created ON public.hand_history USING btree (created_at DESC)'),
    ('public.financial_alerts','CREATE UNIQUE INDEX financial_alerts_pkey ON public.financial_alerts USING btree (id)'),
    ('public.operational_alert_events','CREATE UNIQUE INDEX operational_alert_events_pkey ON public.operational_alert_events USING btree (id)'),
    ('public.operational_alert_events','CREATE UNIQUE INDEX operational_alert_events_source_event_key_key ON public.operational_alert_events USING btree (source, event_key)')
  ) d(table_name,definition) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=to_regclass(v_dep.table_name)
      AND pg_get_indexdef(i.indexrelid)=v_dep.definition AND i.indisvalid AND i.indisready) THEN
      RAISE EXCEPTION 'cash evidence dependency index drift %',v_dep.table_name;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.operational_alert_events'::regclass) THEN
    RAISE EXCEPTION 'cash evidence queue read authority drift';
  END IF;

  FOR v_dep IN SELECT * FROM (VALUES
    ('operational_alert_events_alertname_check','CHECK (((length(alertname) >= 1) AND (length(alertname) <= 240)))'),
    ('operational_alert_events_event_key_check','CHECK (((length(event_key) >= 1) AND (length(event_key) <= 512)))'),
    ('operational_alert_events_investigation_status_check','CHECK ((investigation_status = ANY (ARRAY[''new''::text, ''investigating''::text, ''blocked''::text, ''verified_fixed''::text, ''historical''::text, ''test''::text])))'),
    ('operational_alert_events_payload_check','CHECK (((jsonb_typeof(payload) = ''object''::text) AND (octet_length((payload)::text) <= 262144)))'),
    ('operational_alert_events_pkey','PRIMARY KEY (id)'),
    ('operational_alert_events_severity_check','CHECK (((length(severity) >= 1) AND (length(severity) <= 40)))'),
    ('operational_alert_events_source_check','CHECK (((length(source) >= 1) AND (length(source) <= 120)))'),
    ('operational_alert_events_source_event_key_key','UNIQUE (source, event_key)'),
    ('operational_alert_events_status_check','CHECK ((status = ANY (ARRAY[''firing''::text, ''resolved''::text, ''info''::text])))')
  ) d(constraint_name,definition) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_constraint x WHERE x.conrelid='public.operational_alert_events'::regclass
      AND x.conname=v_dep.constraint_name AND x.convalidated AND NOT x.condeferrable
      AND pg_get_constraintdef(x.oid)=v_dep.definition) THEN
      RAISE EXCEPTION 'cash evidence queue constraint drift %',v_dep.constraint_name;
    END IF;
  END LOOP;

  v_new := to_regclass('public.ca_cash_pot_check_evidence') IS NULL;
  IF v_new IS DISTINCT FROM (to_regclass('public.ca_cash_pot_check_anomalies') IS NULL) THEN
    RAISE EXCEPTION 'cash evidence partial existing storage';
  END IF;
  IF v_new THEN
    IF v_rollback OR v_actual IS DISTINCT FROM v_pre
       OR to_regprocedure('public.fn_ca_cash_pot_evidence_append_only()') IS NOT NULL THEN
      RAISE EXCEPTION 'cash evidence cannot recreate missing receipt storage';
    END IF;
    EXECUTE 'CREATE TABLE public.ca_cash_pot_check_evidence '||v_header_body||' USING heap';
    EXECUTE 'CREATE VIEW public.ca_cash_pot_check_anomalies WITH (security_invoker=true) AS '||
      format(v_view_select,'public.ca_cash_pot_check_evidence');
    EXECUTE v_guard;
    REVOKE ALL ON FUNCTION public.fn_ca_cash_pot_evidence_append_only() FROM PUBLIC,anon,authenticated,service_role;
    ALTER FUNCTION public.fn_ca_cash_pot_evidence_append_only() OWNER TO postgres;
    ALTER TABLE public.ca_cash_pot_check_evidence OWNER TO postgres;
    ALTER VIEW public.ca_cash_pot_check_anomalies OWNER TO postgres;
    REVOKE ALL ON public.ca_cash_pot_check_evidence,public.ca_cash_pot_check_anomalies FROM PUBLIC,anon,authenticated,service_role;
    GRANT SELECT ON public.ca_cash_pot_check_evidence,public.ca_cash_pot_check_anomalies TO service_role;
    ALTER TABLE public.ca_cash_pot_check_evidence ENABLE ROW LEVEL SECURITY;
    COMMENT ON TABLE public.ca_cash_pot_check_evidence IS 'cash-pot-check-evidence/v1';
    COMMENT ON VIEW public.ca_cash_pot_check_anomalies IS 'cash-pot-check-evidence/v1';
    CREATE POLICY cash_pot_header_service_read ON public.ca_cash_pot_check_evidence FOR SELECT TO service_role USING (true);
    CREATE TRIGGER cash_pot_header_row_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ca_cash_pot_check_evidence
      FOR EACH ROW EXECUTE FUNCTION public.fn_ca_cash_pot_evidence_append_only();
    CREATE TRIGGER cash_pot_header_truncate_guard BEFORE TRUNCATE ON public.ca_cash_pot_check_evidence
      FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_cash_pot_evidence_append_only();
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_cash_pot_evidence_append_only()')
      AND pg_get_functiondef(p.oid)=v_guard AND pg_get_userbyid(p.proowner)='postgres'
      AND NOT p.prosecdef AND p.proacl::text='{postgres=X/postgres}')
    OR (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_cash_pot_evidence_append_only')<>1 THEN
    RAISE EXCEPTION 'cash evidence immutable guard drift';
  END IF;
  -- An old unreleased detail TABLE is never silently converted/dropped.
  IF NOT EXISTS(SELECT 1 FROM pg_class r WHERE r.oid='public.ca_cash_pot_check_anomalies'::regclass
      AND r.relkind='v' AND r.relpersistence='p' AND pg_get_userbyid(r.relowner)='postgres'
      AND r.reloptions=ARRAY['security_invoker=true']::text[]
      AND r.relacl::text='{postgres=arwdDxtm/postgres,service_role=r/postgres}'
      AND NOT r.relrowsecurity AND NOT r.relforcerowsecurity
      AND obj_description(r.oid,'pg_class')='cash-pot-check-evidence/v1')
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.ca_cash_pot_check_anomalies'::regclass AND NOT tgisinternal)
    OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.ca_cash_pot_check_anomalies'::regclass)
    OR (SELECT count(*) FROM pg_rewrite WHERE ev_class='public.ca_cash_pot_check_anomalies'::regclass)<>1 THEN
    RAISE EXCEPTION 'cash evidence detail view kind/authority drift';
  END IF;
  LOCK TABLE public.ca_cash_pot_check_evidence IN ACCESS SHARE MODE;
  v_suffix := replace(gen_random_uuid()::text,'-','');
  v_model_h := 'cash_header_shape_'||v_suffix;
  v_model_d := 'cash_detail_shape_'||v_suffix;
  EXECUTE format('CREATE TEMP TABLE %I %s USING heap ON COMMIT DROP',v_model_h,v_header_body);
  EXECUTE format('CREATE TEMP VIEW %I WITH (security_invoker=true) AS %s',v_model_d,
    format(v_view_select,format('pg_temp.%I',v_model_h)));
  v_model_header_oid := to_regclass(format('pg_temp.%I',v_model_h));
  v_actual_rel := 'public.ca_cash_pot_check_evidence'::regclass;
  v_model_rel := v_model_header_oid;
  IF NOT EXISTS(SELECT 1 FROM pg_class r WHERE r.oid=v_actual_rel
      AND r.relkind='r' AND r.relpersistence='p' AND NOT r.relispartition
      AND pg_get_userbyid(r.relowner)='postgres' AND r.relrowsecurity AND NOT r.relforcerowsecurity
      AND r.relacl::text='{postgres=arwdDxtm/postgres,service_role=r/postgres}'
      AND r.reloptions IS NULL AND r.relam=(SELECT oid FROM pg_am WHERE amname='heap')
      AND obj_description(r.oid,'pg_class')='cash-pot-check-evidence/v1') THEN
    RAISE EXCEPTION 'cash evidence header authority drift';
  END IF;
    SELECT jsonb_agg(jsonb_build_object('num',a.attnum,'name',a.attname,'type',a.atttypid,
             'mod',a.atttypmod,'not_null',a.attnotnull,'identity',a.attidentity,
             'generated',a.attgenerated,'collation',a.attcollation,'storage',a.attstorage,
             'compression',a.attcompression,'default',pg_get_expr(d.adbin,d.adrelid))
             ORDER BY a.attnum)
      INTO v_actual_json FROM pg_attribute a LEFT JOIN pg_attrdef d
        ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=v_actual_rel AND a.attnum>0 AND NOT a.attisdropped;
    SELECT jsonb_agg(jsonb_build_object('num',a.attnum,'name',a.attname,'type',a.atttypid,
             'mod',a.atttypmod,'not_null',a.attnotnull,'identity',a.attidentity,
             'generated',a.attgenerated,'collation',a.attcollation,'storage',a.attstorage,
             'compression',a.attcompression,'default',pg_get_expr(d.adbin,d.adrelid))
             ORDER BY a.attnum)
      INTO v_model_json FROM pg_attribute a LEFT JOIN pg_attrdef d
        ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=v_model_rel AND a.attnum>0 AND NOT a.attisdropped;
    IF v_actual_json IS DISTINCT FROM v_model_json
       OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=v_actual_rel AND attnum>0 AND attisdropped) THEN
      RAISE EXCEPTION 'cash evidence column/default drift %','ca_cash_pot_check_evidence';
    END IF;
    SELECT jsonb_agg(jsonb_build_object('name',x.conname,'type',x.contype,
      'keys',x.conkey,'foreign_keys',x.confkey,'deferrable',x.condeferrable,
      'deferred',x.condeferred,'validated',x.convalidated,'update',x.confupdtype,
      'delete',x.confdeltype,'match',x.confmatchtype,
      'foreign_relation',CASE WHEN x.confrelid='public.ca_cash_pot_check_evidence'::regclass THEN 'header' ELSE x.confrelid::text END,
      'definition',CASE WHEN x.contype='f' THEN NULL ELSE pg_get_constraintdef(x.oid) END)
      ORDER BY x.conname) INTO v_actual_json FROM pg_constraint x WHERE x.conrelid=v_actual_rel;
    SELECT jsonb_agg(jsonb_build_object('name',x.conname,'type',x.contype,
      'keys',x.conkey,'foreign_keys',x.confkey,'deferrable',x.condeferrable,
      'deferred',x.condeferred,'validated',x.convalidated,'update',x.confupdtype,
      'delete',x.confdeltype,'match',x.confmatchtype,
      'foreign_relation',CASE WHEN x.confrelid=v_model_header_oid THEN 'header' ELSE x.confrelid::text END,
      'definition',CASE WHEN x.contype='f' THEN NULL ELSE pg_get_constraintdef(x.oid) END)
      ORDER BY x.conname) INTO v_model_json FROM pg_constraint x WHERE x.conrelid=v_model_rel;
    IF v_actual_json IS DISTINCT FROM v_model_json THEN
      RAISE EXCEPTION 'cash evidence constraint drift %','ca_cash_pot_check_evidence';
    END IF;
    SELECT jsonb_agg(jsonb_build_object('name',r.relname,'method',am.amname,'keys',i.indkey::text,
      'classes',i.indclass::text,'options',i.indoption::text,'collations',i.indcollation::text,
      'unique',i.indisunique,'primary',i.indisprimary,'exclusion',i.indisexclusion,
      'nulls_not_distinct',i.indnullsnotdistinct,'valid',i.indisvalid,'ready',i.indisready,
      'attributes',i.indnatts,'key_attributes',i.indnkeyatts,
      'predicate',pg_get_expr(i.indpred,i.indrelid),'expressions',pg_get_expr(i.indexprs,i.indrelid))
      ORDER BY r.relname) INTO v_actual_json FROM pg_index i JOIN pg_class r ON r.oid=i.indexrelid
      JOIN pg_am am ON am.oid=r.relam WHERE i.indrelid=v_actual_rel;
    SELECT jsonb_agg(jsonb_build_object('name',r.relname,'method',am.amname,'keys',i.indkey::text,
      'classes',i.indclass::text,'options',i.indoption::text,'collations',i.indcollation::text,
      'unique',i.indisunique,'primary',i.indisprimary,'exclusion',i.indisexclusion,
      'nulls_not_distinct',i.indnullsnotdistinct,'valid',i.indisvalid,'ready',i.indisready,
      'attributes',i.indnatts,'key_attributes',i.indnkeyatts,
      'predicate',pg_get_expr(i.indpred,i.indrelid),'expressions',pg_get_expr(i.indexprs,i.indrelid))
      ORDER BY r.relname) INTO v_model_json FROM pg_index i JOIN pg_class r ON r.oid=i.indexrelid
      JOIN pg_am am ON am.oid=r.relam WHERE i.indrelid=v_model_rel;
    IF v_actual_json IS DISTINCT FROM v_model_json THEN
      RAISE EXCEPTION 'cash evidence index drift %','ca_cash_pot_check_evidence';
    END IF;
    IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid=v_actual_rel AND NOT t.tgisinternal)<>2
      OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=v_actual_rel AND t.tgname='cash_pot_header_row_guard'
        AND NOT t.tgisinternal AND t.tgtype=31 AND t.tgenabled='O' AND t.tgqual IS NULL
        AND t.tgnargs=0 AND t.tgfoid='public.fn_ca_cash_pot_evidence_append_only()'::regprocedure
        AND t.tgconstraint=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred)
      OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=v_actual_rel AND t.tgname='cash_pot_header_truncate_guard'
        AND NOT t.tgisinternal AND t.tgtype=34 AND t.tgenabled='O' AND t.tgqual IS NULL
        AND t.tgnargs=0 AND t.tgfoid='public.fn_ca_cash_pot_evidence_append_only()'::regprocedure
        AND t.tgconstraint=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred) THEN
      RAISE EXCEPTION 'cash evidence immutable trigger drift %','ca_cash_pot_check_evidence';
    END IF;
    IF (SELECT count(*) FROM pg_policy p WHERE p.polrelid=v_actual_rel)<>1
      OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=v_actual_rel
        AND p.polname='cash_pot_header_service_read' AND p.polcmd='r' AND p.polpermissive
        AND p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='service_role')]::oid[]
        AND pg_get_expr(p.polqual,p.polrelid)='true' AND p.polwithcheck IS NULL) THEN
      RAISE EXCEPTION 'cash evidence read policy drift %','ca_cash_pot_check_evidence';
    END IF;

  v_actual_rel := 'public.ca_cash_pot_check_anomalies'::regclass;
  v_model_rel := to_regclass(format('pg_temp.%I',v_model_d));
    SELECT jsonb_agg(jsonb_build_object('num',a.attnum,'name',a.attname,'type',a.atttypid,
             'mod',a.atttypmod,'not_null',a.attnotnull,'identity',a.attidentity,
             'generated',a.attgenerated,'collation',a.attcollation,'storage',a.attstorage,
             'compression',a.attcompression,'default',pg_get_expr(d.adbin,d.adrelid))
             ORDER BY a.attnum)
      INTO v_actual_json FROM pg_attribute a LEFT JOIN pg_attrdef d
        ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=v_actual_rel AND a.attnum>0 AND NOT a.attisdropped;
    SELECT jsonb_agg(jsonb_build_object('num',a.attnum,'name',a.attname,'type',a.atttypid,
             'mod',a.atttypmod,'not_null',a.attnotnull,'identity',a.attidentity,
             'generated',a.attgenerated,'collation',a.attcollation,'storage',a.attstorage,
             'compression',a.attcompression,'default',pg_get_expr(d.adbin,d.adrelid))
             ORDER BY a.attnum)
      INTO v_model_json FROM pg_attribute a LEFT JOIN pg_attrdef d
        ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=v_model_rel AND a.attnum>0 AND NOT a.attisdropped;
    IF v_actual_json IS DISTINCT FROM v_model_json
       OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=v_actual_rel AND attnum>0 AND attisdropped) THEN
      RAISE EXCEPTION 'cash evidence column/default drift %','ca_cash_pot_check_anomalies';
    END IF;

  IF pg_get_viewdef(v_actual_rel,false) IS DISTINCT FROM
       replace(pg_get_viewdef(v_model_rel,false),quote_ident(v_model_h),'ca_cash_pot_check_evidence')
     OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=v_actual_rel)
     OR EXISTS(SELECT 1 FROM pg_index WHERE indrelid=v_actual_rel) THEN
    RAISE EXCEPTION 'cash evidence exact detail view definition drift';
  END IF;
  EXECUTE format('DROP VIEW pg_temp.%I',v_model_d);
  EXECUTE format('DROP TABLE pg_temp.%I',v_model_h);
  v_target := CASE WHEN v_rollback THEN v_pre ELSE v_post END;
  IF v_actual IS DISTINCT FROM v_target THEN EXECUTE v_target; END IF;
  IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_target OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=v_oid
      AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
      AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'cash evidence exact target/authority readback mismatch';
  END IF;
  -- Retaining rollback changes only future checker source. No evidence/view is dropped.
END;
$component$;
