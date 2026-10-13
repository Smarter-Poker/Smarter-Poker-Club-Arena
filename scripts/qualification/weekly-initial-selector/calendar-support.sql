CREATE OR REPLACE FUNCTION public.fn_union_prev_week_start(p_at timestamp with time zone DEFAULT now())
 RETURNS timestamp with time zone
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT (date_trunc('week', (p_at AT TIME ZONE 'America/Los_Angeles')) - interval '7 days')
           AT TIME ZONE 'America/Los_Angeles';
$function$;
CREATE OR REPLACE FUNCTION public.fn_union_accounting_run_at(p_period_end timestamptz)
RETURNS timestamptz LANGUAGE sql IMMUTABLE
SET search_path = public
AS $function$
  SELECT (((p_period_end AT TIME ZONE 'America/Chicago')::date + time '04:00')
           AT TIME ZONE 'America/Chicago');
$function$;
