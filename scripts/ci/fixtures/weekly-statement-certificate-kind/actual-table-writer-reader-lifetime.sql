CREATE ROLE service_role;CREATE ROLE anon;CREATE ROLE authenticated;CREATE SCHEMA smarter_private;CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);
CREATE TABLE public.accounting_close_certificates(
 kind text NOT NULL,
 union_id uuid NOT NULL,
 period_start timestamp with time zone NOT NULL,
 period_end timestamp with time zone NOT NULL,
 value jsonb NOT NULL,
 certified_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
 CONSTRAINT accounting_close_certificates_kind_check CHECK ((kind = ANY (ARRAY['earned_plan'::text, 'pnl_boundary'::text, 'pnl_flows'::text, 'pnl_touched'::text, 'pnl_clubs'::text, 'pnl_boundary_problem'::text, 'pnl_flows_problem'::text, 'pnl_touched_problem'::text, 'pnl_clubs_problem'::text]))),
 CONSTRAINT accounting_close_certificates_pkey PRIMARY KEY (kind, union_id, period_start, period_end)
);
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
$function$;
REVOKE ALL ON FUNCTION public.fn_accounting_close_certificate(text,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accounting_close_certificate(text,uuid,timestamp with time zone,timestamp with time zone) TO service_role;
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
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_close_certify(text,uuid,timestamp with time zone,timestamp with time zone,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accounting_close_certify(text,uuid,timestamp with time zone,timestamp with time zone,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_accounting_close_proof_lifetime()
 RETURNS interval
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$ SELECT interval '72 hours' $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_close_proof_lifetime() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accounting_close_proof_lifetime() TO service_role;
