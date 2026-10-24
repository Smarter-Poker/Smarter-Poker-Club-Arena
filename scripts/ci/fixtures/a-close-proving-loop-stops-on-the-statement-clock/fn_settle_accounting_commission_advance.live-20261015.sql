CREATE OR REPLACE FUNCTION public.fn_settle_accounting_commission_advance(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE w record; r record; sc record; began timestamptz; proved boolean:=false; v_kind text:='round2_'||p_scope_kind||'_window';
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NULL
  OR p_scope_kind NOT IN('union','club') OR p_scope_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
  OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end) OR p_period_start>=p_period_end OR p_period_end>clock_timestamp() THEN
  RETURN NULL;
 END IF;
 began:=NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz
  -COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval;
 DELETE FROM public.accounting_close_partials WHERE computed_at<clock_timestamp()-interval '8 days';
 -- The book's scope (and its week lock, which every accrual of the week
 -- shares), resolved once for every window.
 SELECT * INTO sc FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_period_start,p_period_end) ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_close_partials p WHERE p.kind=v_kind AND p.union_id=p_scope_id
   AND p.period_start=p_period_start AND p.period_end=p_period_end AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_period_end AND p.computed_at>clock_timestamp()-interval '12 hours');
  IF proved AND clock_timestamp()>began+interval '120 seconds' THEN RETURN false; END IF;
  SELECT * INTO r FROM public.fn_settle_accounting_commission_window(sc.union_id,sc.standalone_club_id,sc.club_ids,w.window_start,w.window_end);
  INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,cash_ids,cash_md5,fee_ids,fee_md5,computed_at)
  VALUES(v_kind,p_scope_id,p_period_start,p_period_end,w.window_start,w.window_end,r.value,r.cash_ids,r.cash_md5,r.fee_ids,r.fee_md5,clock_timestamp())
  ON CONFLICT(kind,union_id,period_start,period_end,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,
   cash_ids=EXCLUDED.cash_ids,cash_md5=EXCLUDED.cash_md5,fee_ids=EXCLUDED.fee_ids,fee_md5=EXCLUDED.fee_md5,computed_at=EXCLUDED.computed_at;
  proved:=true;
 END LOOP;
 RETURN true;
END $function$
