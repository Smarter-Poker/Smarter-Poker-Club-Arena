-- Exact read-only production capture, 2026-09-17. History delegates to the
-- existing receipt constructor and preserves its stored versioned snapshot.
CREATE OR REPLACE FUNCTION public.fn_wheel_history(p_club_id uuid, p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(public.fn_wheel_spin_result(s) ORDER BY s.created_at DESC), '[]'::jsonb)
    FROM (SELECT * FROM public.wheel_spins w
           WHERE w.user_id = auth.uid()
             AND w.host_id = (SELECT h.host_id FROM public.fn_wheel_host(p_club_id) h)
           ORDER BY w.created_at DESC
           LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)) s;
$function$
;
REVOKE ALL ON FUNCTION public.fn_wheel_history(uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_history(uuid,integer) TO authenticated,service_role;

