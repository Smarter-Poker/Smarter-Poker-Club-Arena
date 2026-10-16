CREATE OR REPLACE FUNCTION public.fn_union_rake_basis_windowed(p_union_id uuid, p_start timestamp with time zone, p_through timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- THE OPEN-WEEK RAKE BASIS, TWO HOURS AT A TIME (20261003). The basis detail
-- of fn_accounting_union_earned_plan(p_union_id,p_start,p_through), combined
-- from proved two-hour windows exactly as fn_accounting_union_earned_plan_combine
-- combines a closed week's. NULL sends the caller to the one-read plan.
DECLARE began timestamptz:=statement_timestamp(); w record; r record; v jsonb; st jsonb; stamps jsonb;
 vals jsonb:='[]'::jsonb; n_win int:=0; n_reused int:=0; n_computed int:=0; t0 timestamptz; closed boolean;
 v_sref text; digest text; bank numeric; src numeric; detail jsonb;
BEGIN
 IF p_union_id IS NULL OR p_start IS NULL OR p_through IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_through)
  OR p_through<=p_start
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND starts_at<=p_start) THEN
  RETURN NULL;
 END IF;
 -- A period with a final settlement is read from its witness, as before.
 v_sref := p_union_id::text || ':'
   || to_char(p_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
   || to_char(p_through at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
 IF EXISTS (SELECT 1 FROM public.ca_settlements s
             WHERE s.settlement_type = 'union_rakeback_close' AND s.union_id = p_union_id
               AND s.state = 'final' AND s.external_ref = v_sref AND s.totals ? 'basis_detail') THEN
  RETURN NULL;
 END IF;
 digest:=public.fn_accounting_clubs_scope_digest();
 -- Every window's input stamp, one read per table.
 WITH win AS (SELECT * FROM public.fn_accounting_close_windows(p_start,p_through)),
 bank AS (SELECT date_bin('2 hours',t.created_at,p_start) AS ws,jsonb_build_array(count(*),sum(t.amount)) AS v
   FROM public.union_wallet_transactions t
  WHERE t.union_id=p_union_id AND t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake'
    AND t.created_at>=p_start AND t.created_at<p_through GROUP BY 1),
 rcpt AS (SELECT date_bin('2 hours',c.banked_at,p_start) AS ws,count(*) AS n FROM public.accounting_cash_bank_receipts c
  WHERE c.union_id=p_union_id AND c.banked_at>=p_start AND c.banked_at<p_through GROUP BY 1),
 recog AS (SELECT date_bin('2 hours',f.recognized_at,p_start) AS ws,count(*) AS n FROM public.accounting_tournament_fee_recognitions f
  WHERE f.union_id=p_union_id AND f.recognized_at>=p_start AND f.recognized_at<p_through GROUP BY 1),
 rsrc AS (SELECT date_bin('2 hours',rs.recognized_at,p_start) AS ws,count(*) AS n FROM public.accounting_tournament_recognized_sources rs
  WHERE rs.recognized_at>=p_start AND rs.recognized_at<p_through GROUP BY 1),
 bat AS (SELECT date_bin('2 hours',b.earned_at,p_start) AS ws,count(*) AS n FROM public.accounting_cash_accrual_batches b
  WHERE b.earned_at>=p_start AND b.earned_at<p_through GROUP BY 1)
 SELECT jsonb_object_agg(win.window_start::text,jsonb_build_object('end',win.window_end,
   'bank',COALESCE(bank.v,jsonb_build_array(0,NULL)),'receipts',COALESCE(rcpt.n,0),'recognitions',COALESCE(recog.n,0),
   'recognized',COALESCE(rsrc.n,0),'batches',COALESCE(bat.n,0),
   'agreements',(SELECT jsonb_build_array(count(*),max(h.id)) FROM public.accounting_agreement_history h WHERE h.observed_at<win.window_end),
   'clubs',digest))
  INTO stamps
  FROM win LEFT JOIN bank ON bank.ws=win.window_start LEFT JOIN rcpt ON rcpt.ws=win.window_start
   LEFT JOIN recog ON recog.ws=win.window_start LEFT JOIN rsrc ON rsrc.ws=win.window_start LEFT JOIN bat ON bat.ws=win.window_start;
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_through) ORDER BY 1 LOOP
  n_win:=n_win+1;
  st:=stamps->(w.window_start::text);
  closed:=w.window_end=w.window_start+interval '2 hours';
  v:=NULL;
  IF closed THEN
   SELECT b.value INTO v FROM public.union_rake_basis_windows b
    WHERE b.union_id=p_union_id AND b.period_start=p_start AND b.window_start=w.window_start
      AND b.window_end=w.window_end AND b.input_stamp=st;
  END IF;
  IF v IS NOT NULL THEN
   n_reused:=n_reused+1;
  ELSE
   IF clock_timestamp()>began+(CASE WHEN closed THEN interval '120 seconds' ELSE interval '180 seconds' END) THEN
    RETURN jsonb_build_object('status','in_progress','windows',(SELECT count(*) FROM public.fn_accounting_close_windows(p_start,p_through)),
     'reused',n_reused,'computed',n_computed);
   END IF;
   t0:=clock_timestamp();
   SELECT * INTO r FROM public.fn_accounting_union_earned_plan_window(p_union_id,w.window_start,w.window_end);
   IF NOT FOUND THEN RETURN NULL; END IF;
   v:=r.value;
   n_computed:=n_computed+1;
   IF closed THEN
    INSERT INTO public.union_rake_basis_windows AS b(union_id,period_start,window_start,window_end,input_stamp,value,compute_ms,computed_at)
    VALUES(p_union_id,p_start,w.window_start,w.window_end,st,v,(extract(epoch FROM clock_timestamp()-t0)*1000)::int,clock_timestamp())
    ON CONFLICT(union_id,period_start,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,input_stamp=EXCLUDED.input_stamp,
     value=EXCLUDED.value,compute_ms=EXCLUDED.compute_ms,computed_at=EXCLUDED.computed_at;
   END IF;
  END IF;
  vals:=vals||jsonb_build_array(v);
 END LOOP;
 IF n_win=0 THEN RETURN NULL; END IF;
 -- fn_accounting_union_earned_plan_combine's own sums, test and basis.
 SELECT COALESCE(sum((x->>'bank_sum')::numeric),0),COALESCE(sum((x->>'source_sum')::numeric),0)
   INTO bank,src FROM jsonb_array_elements(vals) x;
 IF src IS DISTINCT FROM bank THEN RETURN NULL; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY club_id,game_type),'[]') INTO detail FROM (
  SELECT (e->>'club_id')::uuid AS club_id,e->>'game_type' AS game_type,sum((e->>'rake_in')::numeric) AS rake_in,
   CASE WHEN sum((e->>'rake_in')::numeric)>0 THEN sum((e->>'weighted')::numeric)/sum((e->>'rake_in')::numeric) ELSE 0 END AS rate,
   trunc(sum((e->>'weighted')::numeric),2) AS payout
   FROM jsonb_array_elements(vals) x CROSS JOIN LATERAL jsonb_array_elements(x->'basis') e
   GROUP BY (e->>'club_id')::uuid,e->>'game_type') b;
 RETURN jsonb_build_object('status','ready','basis_detail',detail,'windows',n_win,'reused',n_reused,'computed',n_computed);
END
$function$
