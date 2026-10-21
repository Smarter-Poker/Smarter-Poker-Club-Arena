CREATE OR REPLACE FUNCTION public.ca_club_members_page(p_club_id uuid, p_search text DEFAULT ''::text, p_filter text DEFAULT 'all'::text, p_sort text DEFAULT 'hierarchy'::text, p_cursor jsonb DEFAULT NULL::jsonb, p_limit integer DEFAULT 80)
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
  IF v_sort NOT IN ('hierarchy', 'activity', 'name', 'downlines', 'wallet', 'fees') THEN
    v_sort := 'hierarchy';
  END IF;

  -- A cursor belongs to one viewer, club and normalized query. A token from
  -- another tab or saved view restarts safely instead of skipping rows.
  IF v_cursor IS NOT NULL AND (
    coalesce(v_cursor->>'v', '') <> '2'
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
        to_jsonb(v) - ARRAY['sort_name', 'presence_rank', 'activity_epoch', 'wallet_total', 'rn']::text[]
        ORDER BY v.rn
      ) FROM visible v
    ), '[]'::jsonb),
    'next_cursor', CASE WHEN (SELECT count(*) FROM ordered) > v_limit THEN (
      SELECT jsonb_build_object(
        'v', 2,
        'club', p_club_id,
        'actor', coalesce(v_actor::text, 'service'),
        'search', md5(v_search),
        'filter', v_filter,
        'sort', v_sort,
        'id', l.user_id,
        'name', l.sort_name,
        'rank', l.role_rank,
        'downlines', coalesce(l.downline_total, 0),
        'presence', l.presence_rank,
        'activity', l.activity_epoch,
        'metric', CASE v_sort
          WHEN 'wallet' THEN l.wallet_total
          WHEN 'fees' THEN coalesce(l.total_fees, 0)
          WHEN 'downlines' THEN coalesce(l.downline_total, 0)
          ELSE 0 END
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
;
