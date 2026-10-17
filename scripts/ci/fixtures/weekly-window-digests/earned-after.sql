CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_combine(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE n_expected bigint; n_have bigint; bank numeric; src numeric; house numeric; fp text; detail jsonb;
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('app.accounting_close_memo',true) IS DISTINCT FROM 'on'
  OR p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_start>=p_end
  OR p_end>clock_timestamp()
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND starts_at<=p_start) THEN
  RETURN NULL;
 END IF;
 CREATE TEMP TABLE IF NOT EXISTS _close_plan_windows(window_start timestamptz PRIMARY KEY,value jsonb,cash_ids uuid[],cash_md5 bytea,fee_ids uuid[],fee_md5 bytea) ON COMMIT DROP;
 TRUNCATE pg_temp._close_plan_windows;
 INSERT INTO pg_temp._close_plan_windows SELECT p.window_start,p.value,p.cash_ids,p.cash_md5,p.fee_ids,p.fee_md5
  FROM public.fn_accounting_close_windows(p_start,p_end) w JOIN public.accounting_close_partials p
   ON p.kind='earned_plan_window' AND p.union_id=p_union_id AND p.period_start=p_start AND p.period_end=p_end
   AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime();
 GET DIAGNOSTICS n_have=ROW_COUNT;
 SELECT count(*) INTO n_expected FROM public.fn_accounting_close_windows(p_start,p_end);
 IF n_have<>n_expected OR n_expected=0 THEN RETURN NULL; END IF;
 SELECT COALESCE(sum((value->>'bank_sum')::numeric),0),COALESCE(sum((value->>'source_sum')::numeric),0),
  COALESCE(sum((value->>'house_sum')::numeric),0) INTO bank,src,house FROM pg_temp._close_plan_windows;
 -- Every window passed the six source proofs, so the set path (and v3) would
 -- reach exactly this conservation test of the week, and refuse as v3 does.
 IF src IS DISTINCT FROM bank THEN RAISE EXCEPTION 'union_earned_rake_does_not_conserve_bank' USING ERRCODE='55000'; END IF;
 -- The set path's fingerprint: md5 of every source's row md5 in (source_type,
 -- source_id) order; every cash_rake_accrual sorts before every
 -- tournament_fee_accrual.
 WITH fingerprint_windows AS MATERIALIZED (SELECT w.cash_ids,w.cash_md5||''::bytea AS cash_md5,w.fee_ids,w.fee_md5||''::bytea AS fee_md5 FROM pg_temp._close_plan_windows w),
 cash_rows AS MATERIALIZED (SELECT u.id,encode(substring(w.cash_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex') AS row_md5 FROM fingerprint_windows w CROSS JOIN LATERAL unnest(w.cash_ids) WITH ORDINALITY u(id,ord)),
 fee_rows AS MATERIALIZED (SELECT u.id,encode(substring(w.fee_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex') AS row_md5 FROM fingerprint_windows w CROSS JOIN LATERAL unnest(w.fee_ids) WITH ORDINALITY u(id,ord))
 SELECT md5(COALESCE((SELECT string_agg(c.row_md5,'' ORDER BY c.id) FROM cash_rows c),'')
  ||COALESCE((SELECT string_agg(f.row_md5,'' ORDER BY f.id) FROM fee_rows f),'')) INTO fp;
 SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY club_id,game_type),'[]') INTO detail FROM (
  SELECT (e->>'club_id')::uuid AS club_id,e->>'game_type' AS game_type,sum((e->>'rake_in')::numeric) AS rake_in,
   CASE WHEN sum((e->>'rake_in')::numeric)>0 THEN sum((e->>'weighted')::numeric)/sum((e->>'rake_in')::numeric) ELSE 0 END AS rate,
   trunc(sum((e->>'weighted')::numeric),2) AS payout
   FROM pg_temp._close_plan_windows w CROSS JOIN LATERAL jsonb_array_elements(w.value->'basis') e
   GROUP BY (e->>'club_id')::uuid,e->>'game_type') b;
 RETURN jsonb_build_object('accounting_version',3,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,
  'period_rake',bank,'earned_rake',src,'house_rake',house,'source_fingerprint',fp,'basis_detail',detail);
END $function$
