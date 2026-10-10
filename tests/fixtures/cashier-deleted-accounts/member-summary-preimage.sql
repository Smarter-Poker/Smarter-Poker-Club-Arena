CREATE OR REPLACE FUNCTION public.ca_club_members_summary(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_scope uuid[];
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_platform_admin boolean := false;
  v_union_staff boolean := false;
  v_viewer_role text := 'player';
  v_has_agent_scope boolean := false;
  v_has_staff_scope boolean := false;
  v_can_export boolean := false;
  v_out jsonb;
BEGIN
  v_scope := public.fn_club_scope_ids(p_club_id);
  IF v_scope IS NULL OR array_length(v_scope, 1) IS NULL THEN
    RETURN NULL;
  END IF;

  IF NOT v_service AND v_actor IS NOT NULL THEN
    SELECT coalesce(p.is_admin, false)
      INTO v_platform_admin FROM public.profiles p WHERE p.id = v_actor;
    v_union_staff := coalesce(public.fn_is_union_overseer(p_club_id, v_actor), false);
  END IF;

  IF NOT v_service AND NOT v_platform_admin AND NOT v_union_staff THEN
    SELECT cm.role
      INTO v_viewer_role
      FROM public.club_members cm
     WHERE cm.user_id = v_actor
       AND cm.club_id = ANY(v_scope)
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     ORDER BY public.fn_club_role_rank(cm.role) DESC
     LIMIT 1;
    IF v_viewer_role IS NULL THEN
      RETURN NULL;
    END IF;
  ELSIF v_platform_admin OR v_union_staff OR v_service THEN
    v_viewer_role := 'owner';
  END IF;

  SELECT EXISTS (
           SELECT 1 FROM public.club_members cm
            WHERE cm.user_id = v_actor AND cm.club_id = ANY(v_scope)
              AND cm.role IN ('super_agent', 'agent', 'sub_agent')
              AND coalesce(cm.status, 'approved') IN ('active', 'approved')
         ),
         EXISTS (
           SELECT 1 FROM public.club_members cm
            WHERE cm.user_id = v_actor AND cm.club_id = ANY(v_scope)
              AND cm.role IN ('owner', 'co_owner', 'admin')
              AND coalesce(cm.status, 'approved') IN ('active', 'approved')
         )
    INTO v_has_agent_scope, v_has_staff_scope;

  v_can_export := v_service OR v_platform_admin OR v_union_staff OR EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.user_id = v_actor AND cm.club_id = p_club_id
       AND cm.role IN ('owner', 'co_owner', 'admin')
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  );

  WITH base AS MATERIALIZED (
    -- THIS club, as ca_club_roster_rows counts it since 2026-09-01. The
    -- scope above still decides who the VIEWER is; it no longer decides
    -- what is counted.
    SELECT DISTINCT ON (cm.user_id)
           cm.user_id, cm.role, public.fn_club_role_rank(cm.role) AS role_rank,
           cm.updated_at
      FROM public.club_members cm
     WHERE cm.club_id = p_club_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     ORDER BY cm.user_id, public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
  ), seated AS MATERIALIZED (
    SELECT DISTINCT live.user_id
      FROM (
        SELECT ts.user_id
          FROM public.table_seats ts
          JOIN public.tables t ON t.id = ts.table_id
         WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
           AND ts.club_id = p_club_id
           AND t.status IN ('waiting', 'running')
        UNION
        SELECT ts.user_id
          FROM public.tables t
          JOIN public.table_seats ts ON ts.table_id = t.id
         WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
           AND t.club_id = p_club_id
           AND t.status IN ('waiting', 'running')
      ) live
  )
  SELECT jsonb_build_object(
    'viewer_role', coalesce(v_viewer_role, 'player'),
    'capabilities', jsonb_build_object(
      'can_view_financials', v_service OR v_platform_admin OR v_union_staff
                              OR v_has_staff_scope OR v_has_agent_scope,
      'can_export', v_can_export,
      'can_manage_members', v_service OR v_platform_admin OR v_union_staff OR v_has_staff_scope,
      'can_view_notes', v_service OR v_platform_admin OR v_union_staff
                        OR v_has_staff_scope OR v_has_agent_scope
    ),
    'counts', jsonb_build_object(
      'total', count(*),
      'online', count(*) FILTER (
        WHERE s.user_id IS NOT NULL
           OR (coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes')
      ),
      'seated', count(*) FILTER (WHERE s.user_id IS NOT NULL),
      'agents', count(*) FILTER (WHERE b.role IN ('super_agent', 'agent', 'sub_agent')),
      'admins', count(*) FILTER (WHERE b.role IN ('owner', 'co_owner', 'admin'))
    ),
    'data_version', max(b.updated_at),
    'page_size', 80
  ) INTO v_out
  FROM base b
  LEFT JOIN seated s ON s.user_id = b.user_id
  LEFT JOIN public.profiles pr ON pr.id = b.user_id;

  RETURN v_out;
END;
$function$
;
