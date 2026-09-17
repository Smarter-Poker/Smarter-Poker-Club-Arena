CREATE OR REPLACE FUNCTION public.fn_agent_downline_commission(p_club_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_id',  d.id,
           'user_id',   d.user_id,
           'club_id',   d.club_id,
           'unclaimed', COALESCE(t.unclaimed, 0))), '[]'::jsonb)
    INTO v_result
    FROM public.agents me
    JOIN public.agents d ON d.parent_agent_id = me.id
    LEFT JOIN LATERAL (
           SELECT SUM(ac.amount) AS unclaimed
             FROM public.agent_commissions ac
            WHERE ac.club_id = d.club_id
              AND ac.user_id = d.user_id
              AND ac.settled_at IS NULL AND NOT public.fn_agent_commission_paid_by_period(ac.club_id, ac.user_id, ac.created_at)
         ) t ON TRUE
   WHERE me.user_id = v_uid
     AND (p_club_id IS NULL OR me.club_id = p_club_id);

  RETURN v_result;
END;
$function$;

