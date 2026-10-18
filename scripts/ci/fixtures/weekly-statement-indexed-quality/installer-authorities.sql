CREATE TABLE public.accounting_close_certificates(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,value jsonb,certified_at timestamptz,PRIMARY KEY(kind,union_id,period_start,period_end));
CREATE OR REPLACE FUNCTION public.fn_accounting_close_certify(p_kind text, p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('app.accounting_close_memo',true) IS DISTINCT FROM 'on'
  OR p_value IS NULL OR p_end>clock_timestamp() THEN RETURN; END IF;
 DELETE FROM public.accounting_close_certificates WHERE certified_at<clock_timestamp()-interval '8 days';
 INSERT INTO public.accounting_close_certificates(kind,union_id,period_start,period_end,value,certified_at)
 VALUES(p_kind,p_union_id,p_start,p_end,p_value,clock_timestamp())
 ON CONFLICT(kind,union_id,period_start,period_end) DO UPDATE SET value=EXCLUDED.value,certified_at=EXCLUDED.certified_at;
 PERFORM set_config('app.accounting_close_certified','on',true);
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_accounting_close_certificate(p_kind text, p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT c.value FROM public.accounting_close_certificates c
  WHERE COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
    AND current_setting('app.accounting_close_memo',true)='on'
    AND c.kind=p_kind AND c.union_id=p_union_id AND c.period_start=p_start AND c.period_end=p_end
    AND c.certified_at>=p_end AND c.certified_at>clock_timestamp()-interval '12 hours'
$function$
;
CREATE FUNCTION public.fn_accounting_close_report_seed(uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT NULL::jsonb$$;
