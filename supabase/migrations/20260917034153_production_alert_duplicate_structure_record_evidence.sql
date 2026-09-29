-- SOURCE ONLY / UNRUN. Standalone guarded component, deliberately outside
-- migrations. Protected admission, native qualification and deployment are
-- separate owner responsibilities. This statement never invokes the detector.
-- Do not install after a selected retirement of this detector; missing or
-- changed source fails closed. Exact-postimage replay is a no-op. No historical
-- record or status is rewritten. The protected publisher serializes installers.
DO $component$
DECLARE
  v_oid oid := to_regprocedure('public.fn_ca_duplicate_structure_payout_check(integer)');
  v_before pg_proc%ROWTYPE;
  v_current text;
  v_candidate text := $candidate$CREATE OR REPLACE FUNCTION public.fn_ca_duplicate_structure_payout_check(p_hours integer DEFAULT 24)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_players int := 0;
  v_events int := 0;
  v_excess numeric := 0;
  v_sample jsonb;
  v_evidence jsonb;
  v_classes jsonb;
  v_records bigint;
  v_evidence_records bigint;
  v_evidence_groups bigint;
  v_context jsonb;
  v_since timestamptz := now() - make_interval(hours => GREATEST(p_hours, 1));
BEGIN
  -- Preserve the original positive-record population and insertion-time window.
  -- Neither paid_at nor a reserved replay key proves that money moved.
  WITH eligible AS MATERIALIZED (
    SELECT p.tournament_id,p.user_id,p.position,p.amount,p.created_at
    FROM public.tournament_payouts p
    WHERE p.source = 'structure' AND p.amount > 0 AND p.created_at > v_since
  ), positions AS (
    SELECT tournament_id,user_id,position,count(*) AS records
    FROM eligible GROUP BY tournament_id,user_id,position
  ), classes AS (
    SELECT tournament_id,user_id,
      count(*) FILTER (WHERE position > 0 AND records > 1) AS repeated_positive_places,
      COALESCE(sum(records) FILTER (WHERE position > 0 AND records > 1),0) AS repeated_positive_place_records,
      count(*) FILTER (WHERE position > 0) AS distinct_positive_places,
      COALESCE(sum(records) FILTER (WHERE position IS NULL OR position <= 0),0) AS unknown_or_invalid_place_records
    FROM positions GROUP BY tournament_id,user_id
  ), dup AS MATERIALIZED (
    SELECT p.tournament_id,p.user_id,count(*) AS rows_,sum(p.amount) AS paid,
           max(p.amount) AS largest,max(p.created_at) AS last_at
    FROM eligible p GROUP BY p.tournament_id,p.user_id HAVING count(*) > 1
  ), ranked AS MATERIALIZED (
    SELECT d.*,c.repeated_positive_places,c.repeated_positive_place_records,
      c.distinct_positive_places,c.unknown_or_invalid_place_records,
      row_number() OVER (ORDER BY d.paid-d.largest DESC,d.tournament_id,d.user_id) AS ordinal
    FROM dup d JOIN classes c USING (tournament_id,user_id)
  ), evidence AS MATERIALIZED (
    -- Restrict groups AND records before looking up reservation keys. The legacy
    -- sample remains complete; only this new evidence array is bounded.
    SELECT d.ordinal,p.*,w.key IS NOT NULL AS key_registered,
      w.user_id = p.user_id AS key_user_matches,
      w.amount = p.amount AS key_amount_matches,
      w.created_at AS key_created_at
    FROM (SELECT * FROM ranked ORDER BY ordinal LIMIT 30) d
    CROSS JOIN LATERAL (
      SELECT e.id,e.tournament_id,e.user_id,e.position,e.amount,e.source,
             e.created_at,e.paid_at,e.idempotency_key
      FROM public.tournament_payouts e
      WHERE e.tournament_id = d.tournament_id AND e.user_id = d.user_id
        AND e.source = 'structure' AND e.amount > 0 AND e.created_at > v_since
      ORDER BY e.created_at,e.id LIMIT 4
    ) p
    LEFT JOIN public.wallet_credit_idempotency w ON w.key = p.idempotency_key
  )
  SELECT count(*),count(DISTINCT tournament_id),COALESCE(sum(paid-largest),0),
    COALESCE(sum(rows_),0),
    COALESCE(jsonb_agg(jsonb_build_object(
      'tournament_id',tournament_id,'user_id',user_id,'rows',rows_,
      'paid',round(paid,2),'excess',round(paid-largest,2),'last_at',last_at,
      'same_positive_place_duplicate',repeated_positive_places > 0,
      'repeated_positive_places',repeated_positive_places,
      'repeated_positive_place_records',repeated_positive_place_records,
      'cross_positive_places',distinct_positive_places > 1,
      'distinct_positive_places',distinct_positive_places,
      'unknown_or_invalid_place_records',unknown_or_invalid_place_records,
      'evidence_records',CASE WHEN ordinal <= 30 THEN LEAST(rows_,4) ELSE 0 END,
      'evidence_records_omitted',rows_ - CASE WHEN ordinal <= 30 THEN LEAST(rows_,4) ELSE 0 END
    ) ORDER BY ordinal),'[]'::jsonb),
    jsonb_build_object(
      'groups_with_same_positive_place_duplicates',count(*) FILTER (WHERE repeated_positive_places > 0),
      'groups_with_cross_positive_places',count(*) FILTER (WHERE distinct_positive_places > 1),
      'groups_with_unknown_or_invalid_places',count(*) FILTER (WHERE unknown_or_invalid_place_records > 0),
      'classes_overlap',true),
    (SELECT count(*) FROM evidence),
    (SELECT count(DISTINCT ordinal) FROM evidence),
    (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'payout_id',id,'tournament_id',tournament_id,'user_id',user_id,
      'position',position,'amount',amount,'source',source,'created_at',created_at,'paid_at',paid_at,
      'idempotency_key',left(idempotency_key,512),
      'key_characters',length(idempotency_key),
      'key_truncated',COALESCE(length(idempotency_key) > 512,false),
      'full_key_md5',md5(idempotency_key),
      'key_registered',key_registered,'key_user_matches',key_user_matches,
      'key_amount_matches',key_amount_matches,'key_created_at',key_created_at,
      'key_evidence',CASE
        WHEN idempotency_key IS NULL THEN 'no_payout_key'
        WHEN NOT key_registered THEN 'key_not_registered'
        WHEN (key_user_matches AND key_amount_matches) IS TRUE THEN 'registered_key_match'
        ELSE 'registered_key_mismatch_or_unknown' END
    ) ORDER BY ordinal,created_at,id),'[]'::jsonb) FROM evidence)
  INTO v_players,v_events,v_excess,v_records,v_sample,v_classes,
       v_evidence_records,v_evidence_groups,v_evidence
  FROM ranked;

  v_context := jsonb_build_object(
    'players',v_players,'tournaments',v_events,'excess',round(v_excess,2),
    'hours',GREATEST(p_hours,1),'sample',v_sample,
    'report_version',2,'measurement','positive_structure_payout_records',
    'window_column','created_at','window_start_exclusive',v_since,
    'nominal_record_discrepancy',round(v_excess,2),'payout_records',v_records,
    'payment_evidence','not_established_by_this_detector',
    'legacy_key_semantics',jsonb_build_object(
      'players_double_paid','tournament_user_groups_with_multiple_records',
      'sample.paid','sum_of_recorded_amounts',
      'excess','sum_of_recorded_amounts_minus_largest_record_per_group'),
    'classifications',v_classes,
    'record_evidence',v_evidence,
    'evidence_limits',jsonb_build_object('groups',30,'records_per_group',4,'key_characters',512),
    'evidence_groups',v_evidence_groups,'evidence_groups_omitted',v_players-v_evidence_groups,
    'evidence_records',v_evidence_records,'evidence_records_omitted',v_records-v_evidence_records,
    'key_evidence_semantics','reservation_only_not_proof_of_wallet_credit');

  IF v_players > 0 THEN
    INSERT INTO public.financial_alerts(severity,source,message,context)
    SELECT 'critical','fn_ca_duplicate_structure_payout_check',
      format('%s tournament/player group(s) across %s tournament(s) have multiple positive structure payout records inserted in the last %s hour(s); nominal record discrepancy %s. Payment and place lineage require investigation.',
        v_players,v_events,GREATEST(p_hours,1),round(v_excess,2)),v_context
    WHERE NOT EXISTS (
      SELECT 1 FROM public.financial_alerts fa
      WHERE fa.source = 'fn_ca_duplicate_structure_payout_check' AND fa.resolved IS NOT TRUE);
  END IF;
  RETURN v_context || jsonb_build_object('ok',true,'players_double_paid',v_players);
END;
$function$
$candidate$;
BEGIN
  SELECT * INTO v_before FROM pg_proc WHERE oid = v_oid;
  v_current := pg_get_functiondef(v_oid);
  IF v_oid IS NULL
     OR (md5(v_current) IS DISTINCT FROM 'c2ceec953ff4cb6b31741fe20b75b635'
         AND v_current IS DISTINCT FROM v_candidate)
     OR pg_get_userbyid(v_before.proowner) IS DISTINCT FROM 'postgres'
     OR v_before.prosecdef IS DISTINCT FROM true
     OR v_before.proconfig IS DISTINCT FROM ARRAY['search_path=public','statement_timeout=120s']
     OR v_before.proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'duplicate structure detector preimage or authority changed';
  END IF;

  -- Pin every column consumed below, including nullable reservation evidence.
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('tournament_payouts','id','uuid',true),
      ('tournament_payouts','tournament_id','uuid',true),
      ('tournament_payouts','user_id','uuid',true),
      ('tournament_payouts','position','integer',false),
      ('tournament_payouts','amount','numeric(15,2)',true),
      ('tournament_payouts','source','text',true),
      ('tournament_payouts','created_at','timestamp with time zone',true),
      ('tournament_payouts','paid_at','timestamp with time zone',true),
      ('tournament_payouts','idempotency_key','text',false),
      ('wallet_credit_idempotency','key','text',true),
      ('wallet_credit_idempotency','user_id','uuid',false),
      ('wallet_credit_idempotency','amount','numeric',false),
      ('wallet_credit_idempotency','created_at','timestamp with time zone',true),
      ('financial_alerts','severity','text',true),
      ('financial_alerts','source','text',true),
      ('financial_alerts','message','text',true),
      ('financial_alerts','context','jsonb',false),
      ('financial_alerts','resolved','boolean',true)
    ) AS expected(relation,column_name,column_type,not_null)
    LEFT JOIN pg_attribute a ON a.attrelid = to_regclass('public.' || expected.relation)
      AND a.attname = expected.column_name AND a.attnum > 0 AND NOT a.attisdropped
    WHERE format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM expected.column_type
       OR a.attnotnull IS DISTINCT FROM expected.not_null
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.wallet_credit_idempotency'::regclass
      AND c.contype = 'p' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
        WHERE attrelid = c.conrelid AND attname = 'key')]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.tournament_payouts'::regclass
      AND c.contype = 'p' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
        WHERE attrelid = c.conrelid AND attname = 'id')]::smallint[]
  ) THEN
    RAISE EXCEPTION 'duplicate structure detector evidence schema changed';
  END IF;

  IF v_current = v_candidate THEN RETURN; END IF;
  EXECUTE v_candidate;

  IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_candidate
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid AND
    (p.proowner IS DISTINCT FROM v_before.proowner
     OR p.proacl IS DISTINCT FROM v_before.proacl
     OR p.proconfig IS DISTINCT FROM v_before.proconfig
     OR p.prosecdef IS DISTINCT FROM v_before.prosecdef
     OR p.prorettype IS DISTINCT FROM v_before.prorettype
     OR p.proargtypes IS DISTINCT FROM v_before.proargtypes)) THEN
    RAISE EXCEPTION 'duplicate structure detector authority changed during replacement';
  END IF;
END;
$component$;
