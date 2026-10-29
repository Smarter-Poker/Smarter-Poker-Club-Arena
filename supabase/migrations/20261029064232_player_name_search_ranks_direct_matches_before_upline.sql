-- @live-proof: md5(pg_get_functiondef('public.ca_club_members_page(uuid,text,text,text,jsonb,integer)'::regprocedure)) = '26534151abe40fb79489066fb10bcc05'
-- @live-proof: md5(pg_get_functiondef('public.ca_club_members_export(uuid,text,text,text,uuid[])'::regprocedure)) = '1343c221fe33536a3445f98535eb9a72'
-- Exact names, prefixes and contained names precede contextual matches across the
-- authorized roster, before LIMIT. Search uses v3 cursors; empty searches retain
-- the chosen manual sort and v2 cursors. Preserve scope, privacy, grants and audit.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $install_name_search$
DECLARE v_definition text;
BEGIN
  SELECT pg_get_functiondef('public.ca_club_members_page(uuid,text,text,text,jsonb,integer)'::regprocedure) INTO v_definition;
  IF md5(v_definition) <> '6d447b10687e83e3916136cc79567d31' THEN
    RAISE EXCEPTION 'Roster name search source preimage changed: public.ca_club_members_page(uuid,text,text,text,jsonb,integer)';
  END IF;
  EXECUTE $definition$CREATE OR REPLACE FUNCTION public.ca_club_members_page(p_club_id uuid, p_search text DEFAULT ''::text, p_filter text DEFAULT 'all'::text, p_sort text DEFAULT 'hierarchy'::text, p_cursor jsonb DEFAULT NULL::jsonb, p_limit integer DEFAULT 80)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_search text := lower(left(btrim(coalesce(p_search, '')), 120));
  v_filter text := lower(coalesce(nullif(btrim(p_filter), ''), 'all'));
  v_sort text := lower(coalesce(nullif(btrim(p_sort), ''), 'hierarchy'));
  v_limit int := greatest(20, least(coalesce(p_limit, 80), 200));
  v_cursor jsonb := p_cursor;
  v_out jsonb;
BEGIN
  IF v_filter NOT IN (
    'all', 'mine', 'seated', 'online', 'agents', 'admins',
    'inactive_30', 'inactive_60', 'inactive_90', 'high_fees'
  ) THEN
    v_filter := 'all';
  END IF;
  IF v_sort NOT IN ('newest', 'oldest', 'hierarchy', 'activity', 'name', 'downlines', 'wallet', 'fees') THEN
    v_sort := 'hierarchy';
  END IF;
  -- Rank authorized search matches before pagination.
  IF v_search <> '' THEN v_sort := 'search'; END IF;

  -- A cursor belongs to one viewer, club and normalized query. A token from
  -- another tab or saved view restarts safely instead of skipping rows.
  IF v_cursor IS NOT NULL AND (
    coalesce(v_cursor->>'v', '') <> CASE WHEN v_sort = 'search' THEN '3' ELSE '2' END
    OR coalesce(v_cursor->>'club', '') <> p_club_id::text
    OR coalesce(v_cursor->>'actor', '') <> coalesce(v_actor::text, 'service')
    OR coalesce(v_cursor->>'search', '') <> md5(v_search)
    OR coalesce(v_cursor->>'filter', '') <> v_filter
    OR coalesce(v_cursor->>'sort', '') <> v_sort
  ) THEN
    v_cursor := NULL;
  END IF;

  -- A cursor is an opaque server token, but it still crosses a hostile client
  -- boundary. Treat malformed numeric components as an expired cursor instead
  -- of letting a text-to-number cast turn the whole roster into a 500.
  IF v_cursor IS NOT NULL AND (
    (v_cursor ? 'rank' AND coalesce(v_cursor->>'rank', '') !~ '^-?[0-9]+$')
    OR (v_cursor ? 'downlines' AND coalesce(v_cursor->>'downlines', '') !~ '^-?[0-9]+$')
    OR (v_cursor ? 'presence' AND coalesce(v_cursor->>'presence', '') !~ '^-?[0-9]+$')
    OR (v_cursor ? 'activity' AND coalesce(v_cursor->>'activity', '') !~ '^-?[0-9]+([.][0-9]+)?$')
    OR (v_cursor ? 'metric' AND coalesce(v_cursor->>'metric', '') !~ '^-?[0-9]+([.][0-9]+)?$')
  ) THEN
    v_cursor := NULL;
  END IF;

  WITH rows AS MATERIALIZED (
    SELECT r.*,
           CASE WHEN r.joined_at IS NULL THEN 1e30::numeric
                WHEN v_sort = 'newest' THEN -extract(epoch FROM r.joined_at)
                ELSE extract(epoch FROM r.joined_at) END AS joined_sort,
           CASE
             WHEN lower(r.alias) = v_search OR lower(r.username) = v_search THEN 0
             WHEN position(v_search in lower(r.alias)) = 1 OR position(v_search in lower(r.username)) = 1 THEN 1
             WHEN position(v_search in lower(r.alias)) > 0 OR position(v_search in lower(r.username)) > 0 THEN 2
             ELSE 3
           END AS search_rank,
           lower(r.alias) AS sort_name,
           CASE WHEN r.is_seated THEN 2 WHEN r.is_online THEN 1 ELSE 0 END AS presence_rank,
           coalesce(extract(epoch FROM r.last_login), 0)::numeric AS activity_epoch,
           coalesce(r.player_wallet, 0) + coalesce(r.agent_wallet, 0) AS wallet_total
      FROM public.ca_club_roster_rows(p_club_id) r
     WHERE (
       v_search = ''
       OR position(v_search in lower(r.alias)) > 0
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
         ELSE true
       END
  ), eligible AS MATERIALIZED (
    SELECT r.*
      FROM rows r
     WHERE v_cursor IS NULL OR CASE v_sort
       WHEN 'search' THEN
         (r.search_rank, r.sort_name, r.user_id::text) >
         (coalesce((v_cursor->>'rank')::int, 0), coalesce(v_cursor->>'name', ''), coalesce(v_cursor->>'id', ''))
       WHEN 'newest' THEN
         (r.joined_sort, r.user_id::text) >
         (coalesce((v_cursor->>'metric')::numeric, 0), coalesce(v_cursor->>'id', ''))
       WHEN 'oldest' THEN
         (r.joined_sort, r.user_id::text) >
         (coalesce((v_cursor->>'metric')::numeric, 0), coalesce(v_cursor->>'id', ''))
       WHEN 'name' THEN
         (r.sort_name, r.user_id::text) >
         (coalesce(v_cursor->>'name', ''), coalesce(v_cursor->>'id', ''))
       WHEN 'activity' THEN
         r.presence_rank < coalesce((v_cursor->>'presence')::int, 0)
         OR (r.presence_rank = coalesce((v_cursor->>'presence')::int, 0)
             AND r.activity_epoch < coalesce((v_cursor->>'activity')::numeric, 0))
         OR (r.presence_rank = coalesce((v_cursor->>'presence')::int, 0)
             AND r.activity_epoch = coalesce((v_cursor->>'activity')::numeric, 0)
             AND r.user_id::text > coalesce(v_cursor->>'id', ''))
       WHEN 'downlines' THEN
         coalesce(r.downline_total, 0) < coalesce((v_cursor->>'metric')::numeric, 0)
         OR (coalesce(r.downline_total, 0) = coalesce((v_cursor->>'metric')::numeric, 0)
             AND r.user_id::text > coalesce(v_cursor->>'id', ''))
       WHEN 'wallet' THEN
         r.wallet_total < coalesce((v_cursor->>'metric')::numeric, 0)
         OR (r.wallet_total = coalesce((v_cursor->>'metric')::numeric, 0)
             AND r.user_id::text > coalesce(v_cursor->>'id', ''))
       WHEN 'fees' THEN
         coalesce(r.total_fees, 0) < coalesce((v_cursor->>'metric')::numeric, 0)
         OR (coalesce(r.total_fees, 0) = coalesce((v_cursor->>'metric')::numeric, 0)
             AND r.user_id::text > coalesce(v_cursor->>'id', ''))
       ELSE
         r.role_rank < coalesce((v_cursor->>'rank')::int, 0)
         OR (r.role_rank = coalesce((v_cursor->>'rank')::int, 0)
             AND coalesce(r.downline_total, 0) < coalesce((v_cursor->>'downlines')::int, 0))
         OR (r.role_rank = coalesce((v_cursor->>'rank')::int, 0)
             AND coalesce(r.downline_total, 0) = coalesce((v_cursor->>'downlines')::int, 0)
             AND r.sort_name > coalesce(v_cursor->>'name', ''))
         OR (r.role_rank = coalesce((v_cursor->>'rank')::int, 0)
             AND coalesce(r.downline_total, 0) = coalesce((v_cursor->>'downlines')::int, 0)
             AND r.sort_name = coalesce(v_cursor->>'name', '')
             AND r.user_id::text > coalesce(v_cursor->>'id', ''))
       END
  ), ordered AS MATERIALIZED (
    SELECT e.*,
           row_number() OVER (
             ORDER BY
               CASE WHEN v_sort = 'search' THEN e.search_rank END ASC,
       CASE WHEN v_sort = 'search' THEN e.sort_name END ASC,
       CASE WHEN v_sort IN ('newest', 'oldest') THEN e.joined_sort END ASC,
               CASE WHEN v_sort = 'hierarchy' THEN e.role_rank END DESC,
               CASE WHEN v_sort = 'hierarchy' THEN coalesce(e.downline_total, 0) END DESC,
               CASE WHEN v_sort = 'hierarchy' THEN e.sort_name END ASC,
               CASE WHEN v_sort = 'activity' THEN e.presence_rank END DESC,
               CASE WHEN v_sort = 'activity' THEN e.activity_epoch END DESC,
               CASE WHEN v_sort = 'name' THEN e.sort_name END ASC,
               CASE WHEN v_sort = 'downlines' THEN coalesce(e.downline_total, 0) END DESC,
               CASE WHEN v_sort = 'wallet' THEN e.wallet_total END DESC,
               CASE WHEN v_sort = 'fees' THEN coalesce(e.total_fees, 0) END DESC,
               e.user_id ASC
           ) AS rn
      FROM eligible e
     ORDER BY
       CASE WHEN v_sort = 'search' THEN e.search_rank END ASC,
       CASE WHEN v_sort = 'search' THEN e.sort_name END ASC,
       CASE WHEN v_sort IN ('newest', 'oldest') THEN e.joined_sort END ASC,
               CASE WHEN v_sort = 'hierarchy' THEN e.role_rank END DESC,
       CASE WHEN v_sort = 'hierarchy' THEN coalesce(e.downline_total, 0) END DESC,
       CASE WHEN v_sort = 'hierarchy' THEN e.sort_name END ASC,
       CASE WHEN v_sort = 'activity' THEN e.presence_rank END DESC,
       CASE WHEN v_sort = 'activity' THEN e.activity_epoch END DESC,
       CASE WHEN v_sort = 'name' THEN e.sort_name END ASC,
       CASE WHEN v_sort = 'downlines' THEN coalesce(e.downline_total, 0) END DESC,
       CASE WHEN v_sort = 'wallet' THEN e.wallet_total END DESC,
       CASE WHEN v_sort = 'fees' THEN coalesce(e.total_fees, 0) END DESC,
       e.user_id ASC
     LIMIT v_limit + 1
  ), visible AS MATERIALIZED (
    SELECT * FROM ordered WHERE rn <= v_limit
  ), last_row AS (
    SELECT * FROM visible ORDER BY rn DESC LIMIT 1
  )
  SELECT jsonb_build_object(
    'items', coalesce((
      SELECT jsonb_agg(
        to_jsonb(v) - ARRAY['search_rank', 'joined_sort', 'sort_name', 'presence_rank', 'activity_epoch', 'wallet_total', 'rn']::text[]
        ORDER BY v.rn
      ) FROM visible v
    ), '[]'::jsonb),
    'next_cursor', CASE WHEN (SELECT count(*) FROM ordered) > v_limit THEN (
      SELECT jsonb_build_object(
        'v', CASE WHEN v_sort = 'search' THEN 3 ELSE 2 END,
        'club', p_club_id,
        'actor', coalesce(v_actor::text, 'service'),
        'search', md5(v_search),
        'filter', v_filter,
        'sort', v_sort,
        'id', l.user_id,
        'name', l.sort_name,
        'rank', CASE WHEN v_sort = 'search' THEN l.search_rank ELSE l.role_rank END,
        'downlines', coalesce(l.downline_total, 0),
        'presence', l.presence_rank,
        'activity', l.activity_epoch,
        'metric', CASE WHEN v_sort IN ('newest', 'oldest') THEN to_jsonb(l.joined_sort::text) ELSE to_jsonb(CASE v_sort
          WHEN 'wallet' THEN l.wallet_total
          WHEN 'fees' THEN coalesce(l.total_fees, 0)
          WHEN 'downlines' THEN coalesce(l.downline_total, 0)
          ELSE 0 END) END
      ) FROM last_row l
    ) ELSE NULL END,
    'has_more', (SELECT count(*) FROM ordered) > v_limit,
    'filtered_total', (SELECT count(*) FROM rows),
    'query', jsonb_build_object('filter', v_filter, 'sort', v_sort)
  ) INTO v_out;

  RETURN coalesce(v_out, jsonb_build_object(
    'items', '[]'::jsonb,
    'next_cursor', NULL,
    'has_more', false,
    'filtered_total', 0,
    'query', jsonb_build_object('filter', v_filter, 'sort', v_sort)
  ));
END;
$function$
$definition$;
END
$install_name_search$;

DO $install_name_search$
DECLARE v_definition text;
BEGIN
  SELECT pg_get_functiondef('public.ca_club_members_export(uuid,text,text,text,uuid[])'::regprocedure) INTO v_definition;
  IF md5(v_definition) <> '010f6e78ed97f6a5918df54bf101bb1b' THEN
    RAISE EXCEPTION 'Roster name search source preimage changed: public.ca_club_members_export(uuid,text,text,text,uuid[])';
  END IF;
  EXECUTE $definition$CREATE OR REPLACE FUNCTION public.ca_club_members_export(p_club_id uuid, p_search text DEFAULT ''::text, p_filter text DEFAULT 'all'::text, p_sort text DEFAULT 'hierarchy'::text, p_user_ids uuid[] DEFAULT NULL::uuid[])
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
  IF v_sort NOT IN ('newest', 'oldest', 'hierarchy', 'activity', 'name', 'downlines', 'wallet', 'fees') THEN v_sort := 'hierarchy'; END IF;
  -- Rank authorized search matches before pagination.
  IF v_search <> '' THEN v_sort := 'search'; END IF;
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
           CASE WHEN r.joined_at IS NULL THEN 1e30::numeric
                WHEN v_sort = 'newest' THEN -extract(epoch FROM r.joined_at)
                ELSE extract(epoch FROM r.joined_at) END AS joined_sort,
           CASE
             WHEN lower(r.alias) = v_search OR lower(r.username) = v_search THEN 0
             WHEN position(v_search in lower(r.alias)) = 1 OR position(v_search in lower(r.username)) = 1 THEN 1
             WHEN position(v_search in lower(r.alias)) > 0 OR position(v_search in lower(r.username)) > 0 THEN 2
             ELSE 3
           END AS search_rank,
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
       CASE WHEN v_sort = 'search' THEN r.search_rank END ASC,
       CASE WHEN v_sort = 'search' THEN r.sort_name END ASC,
       CASE WHEN v_sort IN ('newest', 'oldest') THEN r.joined_sort END ASC,
       CASE WHEN v_sort IN ('newest', 'oldest') THEN r.user_id END ASC,
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
           to_jsonb(o) - ARRAY['search_rank', 'joined_sort', 'sort_name', 'presence_rank', 'activity_epoch', 'wallet_total',
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
$definition$;
END
$install_name_search$;

COMMIT;
