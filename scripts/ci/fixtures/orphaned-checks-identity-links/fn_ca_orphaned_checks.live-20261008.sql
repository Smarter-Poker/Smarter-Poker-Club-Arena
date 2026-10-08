CREATE OR REPLACE FUNCTION public.fn_ca_orphaned_checks()
 RETURNS TABLE(proname text, args text, why text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH sweep AS (
    SELECT COALESCE(
      (SELECT pg_get_functiondef(p.oid)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname='fn_ca_conservation_sweep'
        LIMIT 1), '') AS body
  ),
  candidates AS (
    SELECT p.oid AS oid, p.proname::text AS pn,
           pg_get_function_identity_arguments(p.oid) AS ar
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.prorettype <> 'trigger'::regtype
       AND p.proname ~ '(conservation|_check$|_audit$|_watch$|integrity)'
       AND p.proname NOT LIKE '%selftest%'
       /* A DOOR IS NOT A CHECK. A function taking an actor, an op id, a
          case id or a request id is a write-side RPC with an audit trail -
          open a case, assign it, decide it, sanction. It matches on the
          word "integrity" in its name and on nothing else. */
       AND pg_get_function_identity_arguments(p.oid) !~ '(p_actor|p_op_id|p_case_id|p_request_id|p_value)'
  )
  SELECT c.pn, c.ar,
         'exists but nothing runs it: no cron entry, not called by fn_ca_conservation_sweep, and no exemption reason'
    FROM candidates c, sweep s
   WHERE NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.command LIKE '%' || c.pn || '%')
     /* A CHECK ANOTHER FUNCTION CALLS IS RUN. The weekly cascade calls
        fn_union_settlement_conservation_assert between its rounds; nothing
        in cron names it, and it is not orphaned. */
     AND NOT EXISTS (SELECT 1 FROM pg_proc q JOIN pg_namespace qn ON qn.oid = q.pronamespace
                      WHERE qn.nspname = 'public' AND q.oid <> c.oid
                        AND q.prosrc LIKE '%' || c.pn || '%')
     AND position(c.pn IN s.body) = 0
     AND NOT EXISTS (SELECT 1 FROM public.ca_check_sweep_exemptions e WHERE e.proname = c.pn)
   ORDER BY 1;
$function$
