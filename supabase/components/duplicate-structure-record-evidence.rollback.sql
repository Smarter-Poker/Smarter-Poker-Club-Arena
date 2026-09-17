-- SOURCE ONLY / UNRUN. Separately authorized rollback of this exact report.
-- This is outside automatic migrations. Never invoke the detector here.
-- Protected publisher must serialize precheck/restore/readback and refresh
-- installed dependency evidence. Exact-preimage replay is a no-op; any other
-- body or authority is refused. No money, alert or incident row is changed.
DO $rollback$
DECLARE
  v_oid oid := to_regprocedure('public.fn_ca_duplicate_structure_payout_check(integer)');
  v_actual text;
  v_preimage text := $preimage$CREATE OR REPLACE FUNCTION public.fn_ca_duplicate_structure_payout_check(p_hours integer DEFAULT 24)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_players int := 0;
  v_events  int := 0;
  v_excess  numeric := 0;
  v_sample  jsonb;
  v_since   timestamptz := now() - make_interval(hours => GREATEST(p_hours, 1));
BEGIN
  WITH dup AS (
    SELECT tpo.tournament_id,
           tpo.user_id,
           count(*)            AS rows_,
           sum(tpo.amount)     AS paid,
           max(tpo.amount)     AS largest,
           max(tpo.created_at) AS last_at
      FROM public.tournament_payouts tpo
     WHERE tpo.source = 'structure'
       AND tpo.amount > 0
       AND tpo.created_at > v_since
     GROUP BY 1, 2
    HAVING count(*) > 1
  )
  SELECT count(*),
         count(DISTINCT tournament_id),
         COALESCE(sum(paid - largest), 0),
         COALESCE(jsonb_agg(jsonb_build_object(
           'tournament_id', tournament_id, 'user_id', user_id,
           'rows', rows_, 'paid', round(paid, 2),
           'excess', round(paid - largest, 2), 'last_at', last_at)
           ORDER BY paid - largest DESC), '[]'::jsonb)
    INTO v_players, v_events, v_excess, v_sample
    FROM dup;

  IF v_players > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'critical',
           'fn_ca_duplicate_structure_payout_check',
           format('%s finisher(s) across %s tournament(s) hold more than one '
                  'structure payout row for the same place; %s paid beyond the '
                  'ladder in the last %s hour(s). A place pays once.',
                  v_players, v_events, round(v_excess, 2), GREATEST(p_hours, 1)),
           jsonb_build_object('players', v_players, 'tournaments', v_events,
                              'excess', round(v_excess, 2),
                              'hours', GREATEST(p_hours, 1),
                              'sample', v_sample)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'fn_ca_duplicate_structure_payout_check'
          AND fa.resolved IS NOT TRUE);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'hours', GREATEST(p_hours, 1),
    'players_double_paid', v_players,
    'tournaments', v_events,
    'excess', round(v_excess, 2),
    'sample', v_sample);
END;
$function$
$preimage$;
BEGIN
  v_actual := pg_get_functiondef(v_oid);
  IF v_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.oid=v_oid
      AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
      AND p.proconfig=ARRAY['search_path=public','statement_timeout=120s']
      AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}')
     OR (v_actual IS DISTINCT FROM v_preimage
       AND md5(v_actual) IS DISTINCT FROM '67d372ba4b1071cae4ac0d9f97035b31') THEN
    RAISE EXCEPTION 'duplicate structure rollback refuses changed definition or authority';
  END IF;
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
    RAISE EXCEPTION 'duplicate structure rollback evidence schema changed';
  END IF;

  IF v_actual=v_preimage THEN RETURN; END IF;
  EXECUTE v_preimage;
  IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_preimage OR NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.oid=v_oid
      AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
      AND p.proconfig=ARRAY['search_path=public','statement_timeout=120s']
      AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'duplicate structure rollback readback failed';
  END IF;
END;
$rollback$;
