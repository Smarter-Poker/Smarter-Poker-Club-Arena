CREATE OR REPLACE FUNCTION public.ca_club_members_export(p_club_id uuid, p_search text DEFAULT ''::text, p_filter text DEFAULT 'all'::text, p_sort text DEFAULT 'hierarchy'::text, p_user_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_scope uuid[] := public.fn_club_scope_ids(p_club_id);
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_platform_admin boolean := false;
  v_union_staff boolean := false;
  v_staff boolean := false;
  v_actor_role text := 'service_role';
  v_search text := lower(left(btrim(coalesce(p_search, '')), 120));
  v_filter text := lower(coalesce(nullif(btrim(p_filter), ''), 'all'));
  v_sort text := lower(coalesce(nullif(btrim(p_sort), ''), 'hierarchy'));
  v_rows jsonb;
  v_count int := 0;
  v_audit_id uuid;
BEGIN
  IF v_filter NOT IN ('all', 'mine', 'seated', 'online', 'agents', 'admins',
    'inactive_30', 'inactive_60', 'inactive_90', 'high_fees') THEN v_filter := 'all'; END IF;
  IF v_sort NOT IN ('hierarchy', 'activity', 'name', 'downlines', 'wallet', 'fees') THEN v_sort := 'hierarchy'; END IF;
  IF coalesce(array_length(p_user_ids, 1), 0) > 5000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Select No More Than 5,000 Players Per Export';
  END IF;

  IF v_scope IS NULL OR array_length(v_scope, 1) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Club Not Found');
  END IF;

  IF NOT v_service AND v_actor IS NOT NULL THEN
    SELECT coalesce(p.is_admin, false) INTO v_platform_admin
      FROM public.profiles p WHERE p.id = v_actor;
    v_union_staff := coalesce(public.fn_is_union_overseer(p_club_id, v_actor), false);
    SELECT cm.role INTO v_actor_role
      FROM public.club_members cm
     WHERE cm.user_id = v_actor AND cm.club_id = p_club_id
       AND cm.role IN ('owner', 'co_owner', 'admin')
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     ORDER BY public.fn_club_role_rank(cm.role) DESC LIMIT 1;
    v_staff := v_platform_admin OR v_union_staff OR v_actor_role IS NOT NULL;
  ELSE
    v_staff := v_service;
  END IF;

  IF NOT v_staff THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Roster Export Requires Club Staff Access';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Roster Export Requires An Auditable Actor';
  END IF;

  IF v_actor_role IS NULL THEN
    v_actor_role := CASE
      WHEN v_platform_admin THEN 'platform_admin'
      WHEN v_union_staff THEN 'union_admin'
      ELSE 'system'
    END;
  END IF;

  WITH rows AS MATERIALIZED (
    SELECT r.*,
           lower(r.alias) AS sort_name,
           CASE WHEN r.is_seated THEN 2 WHEN r.is_online THEN 1 ELSE 0 END AS presence_rank,
           coalesce(extract(epoch FROM r.last_login), 0)::numeric AS activity_epoch,
           coalesce(r.player_wallet, 0) + coalesce(r.agent_wallet, 0) AS wallet_total
      FROM public.ca_club_roster_rows(p_club_id) r
     WHERE r.can_view_financials
       AND (p_user_ids IS NULL OR r.user_id = ANY(p_user_ids))
       AND (
         v_search = '' OR position(v_search in lower(r.alias)) > 0
         OR position(v_search in lower(r.username)) > 0
         OR position(v_search in lower(coalesce(r.player_number, ''))) > 0
         OR position(v_search in lower(coalesce(r.home_club_name, ''))) > 0
         OR position(v_search in lower(coalesce(r.upline_name, ''))) > 0
       )
       AND CASE v_filter
         WHEN 'mine' THEN r.in_viewer_downline
         WHEN 'seated' THEN r.is_seated
         WHEN 'online' THEN r.is_online
         WHEN 'agents' THEN r.role IN ('super_agent', 'agent', 'sub_agent')
         WHEN 'admins' THEN r.role IN ('owner', 'co_owner', 'admin')
         WHEN 'inactive_30' THEN r.last_login IS NOT NULL AND r.last_login < now() - interval '30 days'
         WHEN 'inactive_60' THEN r.last_login IS NOT NULL AND r.last_login < now() - interval '60 days'
         WHEN 'inactive_90' THEN r.last_login IS NOT NULL AND r.last_login < now() - interval '90 days'
         WHEN 'high_fees' THEN coalesce(r.total_fees, 0) >= 100
         ELSE true END
  ), ordered AS (
    SELECT r.* FROM rows r
     ORDER BY
       CASE WHEN v_sort = 'hierarchy' THEN r.role_rank END DESC,
       CASE WHEN v_sort = 'hierarchy' THEN coalesce(r.downline_total, 0) END DESC,
       CASE WHEN v_sort = 'activity' THEN r.presence_rank END DESC,
       CASE WHEN v_sort = 'activity' THEN r.activity_epoch END DESC,
       CASE WHEN v_sort = 'name' THEN r.sort_name END ASC,
       CASE WHEN v_sort = 'downlines' THEN coalesce(r.downline_total, 0) END DESC,
       CASE WHEN v_sort = 'wallet' THEN r.wallet_total END DESC,
       CASE WHEN v_sort = 'fees' THEN coalesce(r.total_fees, 0) END DESC,
       r.sort_name ASC, r.user_id ASC
  )
  SELECT coalesce(jsonb_agg(
           to_jsonb(o) - ARRAY['sort_name', 'presence_rank', 'activity_epoch', 'wallet_total',
                                  'can_view_financials', 'can_view_notes', 'in_viewer_downline']::text[]
         ), '[]'::jsonb), count(*)::int
    INTO v_rows, v_count
    FROM ordered o;

  INSERT INTO public.audit_trail (
    actor_id, actor_role, action, target_type, target_id, club_id,
    after_state, reason
  ) VALUES (
    v_actor, v_actor_role,
    'export_club_roster', 'club', p_club_id, p_club_id,
    jsonb_build_object(
      'row_count', v_count,
      'selected_only', p_user_ids IS NOT NULL,
      'selected_count', coalesce(array_length(p_user_ids, 1), 0),
      'filter', v_filter,
      'sort', v_sort,
      'search_used', v_search <> ''
    ),
    'Authorized Club Roster Export'
  ) RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object(
    'success', true,
    'rows', v_rows,
    'row_count', v_count,
    'audit_id', v_audit_id
  );
END;
$function$
;
