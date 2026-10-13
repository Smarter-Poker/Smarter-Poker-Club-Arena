CREATE OR REPLACE FUNCTION public.fn_ca_break_window_governs(p_session_role text, p_application text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(p_application, '') <> 'pg_cron'
     AND EXISTS (
           SELECT 1
             FROM pg_catalog.pg_roles r
            WHERE r.rolname = p_session_role
              AND NOT r.rolsuper
              AND pg_catalog.pg_has_role(r.oid, 'postgres', 'MEMBER')
         );
$function$;
