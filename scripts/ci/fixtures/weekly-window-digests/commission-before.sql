CREATE OR REPLACE FUNCTION public.fn_settle_accounting_commission_combine(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- Builds round 2's _routed_nodes, _routed_edges and _routed_clubs from the
-- proved windows exactly as the stage builds them from its own reads, and
-- returns the fingerprint, the source count and the tests' outcome; NULL
-- outside a chunked close attempt or while any window is missing.
DECLARE v_kind text:='round2_'||p_scope_kind||'_window'; n_have bigint; n_expected bigint; fp text; agg record;
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NULL
  OR p_scope_kind NOT IN('union','club') OR p_scope_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
  OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end) OR p_period_start>=p_period_end OR p_period_end>clock_timestamp() THEN
  RETURN NULL;
 END IF;
 CREATE TEMP TABLE IF NOT EXISTS _close_r2_windows(window_start timestamptz PRIMARY KEY,value jsonb,cash_ids uuid[],cash_md5 bytea,fee_ids uuid[],fee_md5 bytea) ON COMMIT DROP;
 TRUNCATE pg_temp._close_r2_windows;
 INSERT INTO pg_temp._close_r2_windows SELECT p.window_start,p.value,p.cash_ids,p.cash_md5,p.fee_ids,p.fee_md5
  FROM public.fn_accounting_close_windows(p_period_start,p_period_end) w JOIN public.accounting_close_partials p
   ON p.kind=v_kind AND p.union_id=p_scope_id AND p.period_start=p_period_start AND p.period_end=p_period_end
   AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_period_end AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime();
 GET DIAGNOSTICS n_have=ROW_COUNT;
 SELECT count(*) INTO n_expected FROM public.fn_accounting_close_windows(p_period_start,p_period_end);
 IF n_have<>n_expected OR n_expected=0 THEN RETURN NULL; END IF;
 SELECT bool_or((value->>'read_failed')::boolean) AS read_failed,
  COALESCE(sum((value->>'sources')::bigint),0) AS sources,
  COALESCE(sum((value->>'unclassified')::bigint),0) AS unclassified,
  bool_or((value->>'odd')::bigint>0 OR (value->>'tiers_failed')::boolean) AS full_path,
  COALESCE(sum((value->>'tier_bad')::bigint+(value->>'dup')::bigint),0) AS tier_bad,
  COALESCE(sum((value->>'e1')::bigint+(value->>'e2')::bigint+(value->>'e3')::bigint),0) AS entitlement_bad
  INTO agg FROM pg_temp._close_r2_windows;
 IF agg.read_failed THEN RETURN jsonb_build_object('read_failed',true); END IF;
 -- The stage's fingerprint: md5 of every source's row md5 in
 -- (source_type, source_id) order; cash_rake_accrual sorts first.
 SELECT md5(COALESCE((SELECT string_agg(encode(substring(w.cash_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)
     FROM pg_temp._close_r2_windows w CROSS JOIN LATERAL unnest(w.cash_ids) WITH ORDINALITY u(id,ord)),'')
  ||COALESCE((SELECT string_agg(encode(substring(w.fee_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)
     FROM pg_temp._close_r2_windows w CROSS JOIN LATERAL unnest(w.fee_ids) WITH ORDINALITY u(id,ord)),'')) INTO fp;
 CREATE TEMP TABLE IF NOT EXISTS _routed_nodes(club_id uuid,user_id uuid,agent_id uuid,role text,own_amount numeric,rows_count int,
  opening_balance numeric,sort_order int,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_nodes;
 CREATE TEMP TABLE IF NOT EXISTS _routed_edges(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text,sort_order int) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_edges;
 CREATE TEMP TABLE IF NOT EXISTS _routed_clubs(club_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_clubs;
 INSERT INTO pg_temp._routed_clubs SELECT DISTINCT (c#>>'{}')::uuid FROM pg_temp._close_r2_windows w CROSS JOIN LATERAL jsonb_array_elements(w.value->'clubs') c;
 IF agg.full_path OR agg.unclassified>0 THEN
  RETURN jsonb_build_object('read_failed',false,'fingerprint',fp,'sources',agg.sources,'unclassified',agg.unclassified,'full_path',agg.full_path,
   'hierarchy_bad',false,'entitlement_bad',false);
 END IF;
 INSERT INTO pg_temp._routed_nodes(club_id,user_id,agent_id,role,own_amount,rows_count)
  SELECT (e->>'club_id')::uuid,(e->>'user_id')::uuid,min(e->>'agent_min')::uuid,min(e->>'role_min'),sum((e->>'own')::numeric),sum((e->>'rows')::bigint)
   FROM pg_temp._close_r2_windows w CROSS JOIN LATERAL jsonb_array_elements(w.value->'nodes') e
   GROUP BY (e->>'club_id')::uuid,(e->>'user_id')::uuid;
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role)
  SELECT (e->>'club_id')::uuid,(e->>'payer_user')::uuid,(e->>'payee_user')::uuid,sum((e->>'amount')::numeric),min(e->>'role_min')
   FROM pg_temp._close_r2_windows w CROSS JOIN LATERAL jsonb_array_elements(w.value->'edges') e
   GROUP BY (e->>'club_id')::uuid,(e->>'payer_user')::uuid,(e->>'payee_user')::uuid
   HAVING sum((e->>'amount')::numeric)>0;
 RETURN jsonb_build_object('read_failed',false,'fingerprint',fp,'sources',agg.sources,'unclassified',agg.unclassified,'full_path',false,
  'hierarchy_bad',agg.tier_bad>0 OR EXISTS(SELECT 1 FROM pg_temp._close_r2_windows w CROSS JOIN LATERAL jsonb_array_elements(w.value->'nodes') e
    GROUP BY (e->>'club_id'),(e->>'user_id') HAVING min(e->>'agent_min') IS DISTINCT FROM max(e->>'agent_max') OR min(e->>'role_min') IS DISTINCT FROM max(e->>'role_max')),
  'entitlement_bad',agg.entitlement_bad>0);
END $function$
