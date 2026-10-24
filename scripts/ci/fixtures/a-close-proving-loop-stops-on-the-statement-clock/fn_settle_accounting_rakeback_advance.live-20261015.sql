CREATE OR REPLACE FUNCTION public.fn_settle_accounting_rakeback_advance(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- Proves the missing round-3 windows of a closed week (at least one, none
-- started 120 s after the attempt began), then, in an attempt that has not
-- spent 60 s on windows, the certificates' read. True when it did work.
DECLARE w record; sc record; began timestamptz; proved boolean:=false; v_kind text:='round3_'||p_scope_kind||'_window';
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NULL
  OR p_scope_kind NOT IN('union','club') OR p_scope_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
  OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end) OR p_period_start>=p_period_end OR p_period_end>clock_timestamp() THEN
  RETURN NULL;
 END IF;
 began:=NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz
  -COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval;
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_period_start,p_period_end) ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_close_partials p WHERE p.kind=v_kind AND p.union_id=p_scope_id
   AND p.period_start=p_period_start AND p.period_end=p_period_end AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_period_end AND p.computed_at>clock_timestamp()-interval '12 hours');
  IF proved AND clock_timestamp()>began+interval '120 seconds' THEN RETURN true; END IF;
  IF sc IS NULL THEN
   SELECT * INTO sc FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
  END IF;
  INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)
  VALUES(v_kind,p_scope_id,p_period_start,p_period_end,w.window_start,w.window_end,
   public.fn_settle_accounting_rakeback_window(sc.union_id,sc.standalone_club_id,w.window_start,w.window_end),clock_timestamp())
  ON CONFLICT(kind,union_id,period_start,period_end,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,
   cash_ids=NULL,cash_md5=NULL,fee_ids=NULL,fee_md5=NULL,computed_at=EXCLUDED.computed_at;
  proved:=true;
 END LOOP;
 IF proved AND clock_timestamp()>began+interval '60 seconds' THEN RETURN true; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.accounting_close_partials p WHERE p.kind='round3_'||p_scope_kind||'_plan' AND p.union_id=p_scope_id
   AND p.period_start=p_period_start AND p.period_end=p_period_end AND p.window_start=p_period_start
   AND p.computed_at>=p_period_end AND p.computed_at>clock_timestamp()-interval '12 hours') THEN
  PERFORM public.fn_settle_accounting_rakeback_plan(p_scope_kind,p_scope_id,p_period_start,p_period_end);
  proved:=true;
 END IF;
 RETURN proved;
END $function$
