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
