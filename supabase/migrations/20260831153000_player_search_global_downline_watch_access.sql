-- GLOBAL PLAYER DISCOVERY, DOWNLINE-SCOPED ACCOUNT DATA, AND WATCH ACCESS
--
-- Public discovery and account administration are deliberately different
-- capabilities. Every authenticated player may locate another account and
-- learn whether that account is currently playing. Financials, notes, stats,
-- and hierarchy details still flow through ca_club_member_detail, whose
-- server-side access decision limits owners/admins to their clubs (and union
-- overseers to their union), and agents to their recursive downlines.

CREATE INDEX IF NOT EXISTS idx_table_seats_live_user
  ON public.table_seats (user_id, table_id) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tournament_players_live_user_table
  ON public.tournament_players (user_id, table_id)
  WHERE status = 'playing' AND table_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_get_table_watch_access(p_table_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_table record;
  v_membership text;
  v_seated boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT t.id, t.club_id, t.restrict_observers, c.name AS club_name,
         c.club_id AS club_number, c.slug, c.requires_approval
    INTO v_table
    FROM public.tables t
    JOIN public.clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id
     AND coalesce(t.is_deleted, false) = false;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false, 'can_watch', false, 'action', 'unavailable');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.table_seats ts
     WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL
  ) INTO v_seated;

  SELECT cm.status INTO v_membership
    FROM public.club_members cm
   WHERE cm.club_id = v_table.club_id AND cm.user_id = v_uid;

  RETURN jsonb_build_object(
    'found', true,
    'table_id', v_table.id,
    'club_uuid', v_table.club_id,
    'club_id', v_table.club_number,
    'club_slug', v_table.slug,
    'club_name', v_table.club_name,
    'membership_status', v_membership,
    'can_watch', v_seated OR (
      v_membership IN ('active', 'approved') AND NOT coalesce(v_table.restrict_observers, false)
    ),
    'action', CASE
      WHEN v_seated THEN 'play'
      WHEN v_membership IN ('active', 'approved') AND coalesce(v_table.restrict_observers, false)
        THEN 'observers_restricted'
      WHEN v_membership IN ('active', 'approved') THEN 'watch'
      WHEN v_membership = 'pending' THEN 'pending'
      WHEN v_membership IN ('banned', 'suspended', 'rejected', 'left') THEN 'unavailable'
      WHEN coalesce(v_table.requires_approval, false) THEN 'request_join'
      ELSE 'join'
    END
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_search_players(
  p_query text,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_scope text DEFAULT 'all',
  p_presence text DEFAULT 'all',
  p_sort text DEFAULT 'relevance'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF length(v_query) < 2 OR length(v_query) > 64 THEN
    RAISE EXCEPTION 'Search must be between 2 and 64 characters' USING ERRCODE = '22023';
  END IF;
  IF p_scope NOT IN ('all', 'friends', 'clubs', 'union', 'managed') THEN
    RAISE EXCEPTION 'Invalid search scope' USING ERRCODE = '22023';
  END IF;
  IF p_presence NOT IN ('all', 'online', 'playing') THEN
    RAISE EXCEPTION 'Invalid presence filter' USING ERRCODE = '22023';
  END IF;
  IF p_sort NOT IN ('relevance', 'name') THEN
    RAISE EXCEPTION 'Invalid search sort' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.club_entry_feature_flags f WHERE f.key = 'find_player'
      AND (NOT f.enabled OR ((hashtextextended(v_uid::text || ':' || f.key, 44119)
          & 9223372036854775807) % 100) >= f.rollout_percent)
  ) THEN
    RAISE EXCEPTION 'Player search is temporarily unavailable.' USING ERRCODE = 'P0001';
  END IF;

  WITH RECURSIVE
  viewer_clubs AS MATERIALIZED (
    SELECT cm.club_id
      FROM public.club_members cm
     WHERE cm.user_id = v_uid AND cm.status IN ('active', 'approved')
  ), viewer_unions AS MATERIALIZED (
    SELECT DISTINCT uc.union_id
      FROM public.union_clubs uc JOIN viewer_clubs vc ON vc.club_id = uc.club_id
    UNION SELECT u.id FROM public.unions u WHERE u.owner_id = v_uid
    UNION SELECT ua.union_id FROM public.union_admins ua WHERE ua.user_id = v_uid
  ), friend_ids AS MATERIALIZED (
    SELECT f.friend_id AS user_id FROM public.friendships f WHERE f.user_id = v_uid
    UNION SELECT f.user_id FROM public.friendships f WHERE f.friend_id = v_uid
  ), matched AS MATERIALIZED (
    SELECT p.id, p.username, p.display_name,
           coalesce(nullif(p.arena_avatar_url, ''), p.avatar_url) AS avatar_url,
           CASE
             WHEN lower(coalesce(p.username, '')) = v_query THEN 0
             WHEN lower(coalesce(p.display_name, '')) = v_query THEN 1
             WHEN lower(coalesce(p.alias, '')) = v_query THEN 2
             WHEN lower(coalesce(p.username, '')) LIKE v_query || '%' THEN 3
             WHEN lower(coalesce(p.display_name, '')) LIKE v_query || '%' THEN 4
             ELSE 5
           END AS relevance,
           CASE
             WHEN p.id = v_uid THEN 'self'
             WHEN EXISTS (SELECT 1 FROM friend_ids f WHERE f.user_id = p.id) THEN 'friend'
             WHEN EXISTS (
               SELECT 1 FROM public.club_members target JOIN viewer_clubs vc ON vc.club_id = target.club_id
                WHERE target.user_id = p.id AND target.status IN ('active', 'approved')
             ) THEN 'club'
             WHEN EXISTS (
               SELECT 1 FROM public.club_members target
               JOIN public.union_clubs uc ON uc.club_id = target.club_id
               JOIN viewer_unions vu ON vu.union_id = uc.union_id
                WHERE target.user_id = p.id AND target.status IN ('active', 'approved')
             ) THEN 'union'
             ELSE 'public'
           END AS relationship
      FROM public.profiles p
     WHERE lower(coalesce(p.username, '')) LIKE '%' || v_query || '%'
        OR lower(coalesce(p.display_name, '')) LIKE '%' || v_query || '%'
        OR lower(coalesce(p.alias, '')) LIKE '%' || v_query || '%'
        OR coalesce(p.player_number, '') = v_query
  ), managed AS MATERIALIZED (
    SELECT DISTINCT m.id AS user_id
      FROM matched m
      JOIN public.club_members cm ON cm.user_id = m.id AND cm.status IN ('active', 'approved')
     WHERE m.id = v_uid
        OR public.ca_club_roster_access(cm.club_id, m.id) IN ('staff', 'downline', 'service')
  ), scoped AS MATERIALIZED (
    SELECT m.*
      FROM matched m
     WHERE p_scope = 'all'
        OR (p_scope = 'friends' AND m.relationship IN ('self', 'friend'))
        OR (p_scope = 'clubs' AND m.relationship IN ('self', 'club'))
        OR (p_scope = 'union' AND m.relationship IN ('self', 'union'))
        OR (p_scope = 'managed' AND EXISTS (SELECT 1 FROM managed x WHERE x.user_id = m.id))
  ), presence_rows AS MATERIALIZED (
    SELECT s.*,
           EXISTS (
             SELECT 1 FROM public.table_seats ts
             JOIN public.tables t ON t.id = ts.table_id
              WHERE ts.user_id = s.id AND ts.left_at IS NULL
                AND t.status IN ('waiting', 'running') AND coalesce(t.is_deleted, false) = false
           ) OR EXISTS (
             SELECT 1 FROM public.tournament_players tp
             JOIN public.tournaments tr ON tr.id = tp.tournament_id
              WHERE tp.user_id = s.id AND tp.status = 'playing' AND tp.table_id IS NOT NULL
                AND lower(coalesce(tr.status::text, '')) IN ('running', 'in_progress', 'active')
           ) AS is_playing,
           coalesce(p.is_online, false) AND p.last_seen > now() - interval '5 minutes' AS is_online
      FROM scoped s JOIN public.profiles p ON p.id = s.id
  ), filtered AS MATERIALIZED (
    SELECT *, count(*) OVER () AS full_count
      FROM presence_rows
     WHERE p_presence = 'all'
        OR (p_presence = 'playing' AND is_playing)
        OR (p_presence = 'online' AND (is_playing OR is_online))
  ), page AS MATERIALIZED (
    SELECT * FROM filtered
     ORDER BY
       CASE WHEN p_sort = 'relevance' THEN relevance END,
       CASE WHEN p_sort = 'name' THEN lower(coalesce(display_name, username, '')) END,
       lower(coalesce(username, '')), id
     LIMIT v_limit OFFSET v_offset
  ), decorated AS (
    SELECT pg.*,
      CASE WHEN pg.is_playing THEN 'playing' WHEN pg.is_online THEN 'online' ELSE 'offline' END
        AS presence_status,
      coalesce(g.games, '[]'::jsonb) AS tables,
      coalesce(a.accounts, '[]'::jsonb) AS sensitive_accounts
    FROM page pg
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(game ORDER BY is_tournament, name, table_id) AS games
      FROM (
        SELECT DISTINCT ON (live.table_id) live.table_id,
          jsonb_build_object(
            'id', live.table_id,
            'table_id', live.table_id,
            'tournament_id', live.tournament_id,
            'name', live.name,
            'game_variant', live.game_variant,
            'stakes', live.stakes,
            'club_uuid', live.club_uuid,
            'club_id', live.club_number,
            'club_slug', live.club_slug,
            'club_name', live.club_name,
            'is_tournament', live.is_tournament,
            'membership_status', live.membership_status,
            'can_watch', live.can_watch,
            'access_action', live.access_action
          ) AS game,
          live.is_tournament,
          live.name
        FROM (
          SELECT t.id AS table_id, NULL::uuid AS tournament_id, t.name::text,
                 coalesce(t.game_variant, t.game_type, 'Poker')::text AS game_variant,
                 concat('$', t.small_blind, '/$', t.big_blind)::text AS stakes,
                 c.id AS club_uuid, c.club_id AS club_number, c.slug AS club_slug,
                 c.name::text AS club_name, false AS is_tournament, cm.status AS membership_status,
                 (cm.status IN ('active', 'approved') AND NOT coalesce(t.restrict_observers, false)) AS can_watch,
                 CASE
                   WHEN cm.status IN ('active', 'approved') AND coalesce(t.restrict_observers, false) THEN 'observers_restricted'
                   WHEN cm.status IN ('active', 'approved') THEN 'watch'
                   WHEN cm.status = 'pending' THEN 'pending'
                   WHEN cm.status IN ('banned', 'suspended', 'rejected', 'left') THEN 'unavailable'
                   WHEN coalesce(c.requires_approval, false) THEN 'request_join' ELSE 'join'
                 END AS access_action
            FROM public.table_seats ts
            JOIN public.tables t ON t.id = ts.table_id AND t.tournament_id IS NULL
            JOIN public.clubs c ON c.id = t.club_id
            LEFT JOIN public.club_members cm ON cm.club_id = c.id AND cm.user_id = v_uid
           WHERE ts.user_id = pg.id AND ts.left_at IS NULL
             AND t.status IN ('waiting', 'running') AND coalesce(t.is_deleted, false) = false
             AND coalesce(t.is_anonymous, false) = false
          UNION ALL
          SELECT t.id, tr.id, coalesce(t.name, tr.name)::text,
                 coalesce(tr.variant, tr.game_type, 'MTT')::text,
                 concat('$', coalesce(tr.buy_in_amount, 0), ' Buy-In')::text,
                 c.id, c.club_id, c.slug, c.name::text, true, cm.status,
                 (cm.status IN ('active', 'approved') AND NOT coalesce(t.restrict_observers, false)),
                 CASE
                   WHEN cm.status IN ('active', 'approved') AND coalesce(t.restrict_observers, false) THEN 'observers_restricted'
                   WHEN cm.status IN ('active', 'approved') THEN 'watch'
                   WHEN cm.status = 'pending' THEN 'pending'
                   WHEN cm.status IN ('banned', 'suspended', 'rejected', 'left') THEN 'unavailable'
                   WHEN coalesce(c.requires_approval, false) THEN 'request_join' ELSE 'join'
                 END
            FROM public.tournament_players tp
            JOIN public.tournaments tr ON tr.id = tp.tournament_id
            JOIN public.tables t ON t.id = tp.table_id
            JOIN public.clubs c ON c.id = tr.club_id
            LEFT JOIN public.club_members cm ON cm.club_id = c.id AND cm.user_id = v_uid
           WHERE tp.user_id = pg.id AND tp.status = 'playing' AND tp.table_id IS NOT NULL
             AND lower(coalesce(tr.status::text, '')) IN ('running', 'in_progress', 'active')
             AND coalesce(t.is_anonymous, false) = false
        ) live
        ORDER BY live.table_id, live.is_tournament DESC
      ) deduped
    ) g ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'club_uuid', details.club_id,
        'club_name', details.club_name,
        'role', details.role,
        'access', details.detail->'capabilities'->>'access',
        'wallets', details.detail->'wallets',
        'downline', details.detail->'downline',
        'stats', details.detail->'stats'
      ) ORDER BY details.club_name) AS accounts
      FROM (
        SELECT DISTINCT ON (cm.club_id) cm.club_id, c.name::text AS club_name, cm.role::text,
               public.ca_club_member_detail(cm.club_id, pg.id, NULL, NULL) AS detail
          FROM public.club_members cm JOIN public.clubs c ON c.id = cm.club_id
         WHERE cm.user_id = pg.id AND cm.status IN ('active', 'approved')
           AND (pg.id = v_uid OR public.ca_club_roster_access(cm.club_id, pg.id)
                IN ('staff', 'downline', 'service'))
         ORDER BY cm.club_id, public.fn_club_role_rank(cm.role) DESC
      ) details
      WHERE details.detail->'wallets' IS NOT NULL
    ) a ON true
  )
  SELECT jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'id', id,
      'username', coalesce(username, ''),
      'display_name', display_name,
      'avatar_url', avatar_url,
      'relationship', CASE WHEN EXISTS (SELECT 1 FROM managed m WHERE m.user_id = id)
                           AND relationship = 'public' THEN 'managed' ELSE relationship END,
      'presence_status', presence_status,
      'tables', tables,
      'sensitive_accounts', sensitive_accounts
    )), '[]'::jsonb),
    'total', coalesce(max(full_count), 0),
    'limit', v_limit,
    'offset', v_offset,
    'has_more', coalesce(max(full_count), 0) > v_offset + v_limit
  ) INTO v_result FROM decorated;

  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_get_table_watch_access(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_search_players(text, integer, integer, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_table_watch_access(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_search_players(text, integer, integer, text, text, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_search_players(text, integer, integer, text, text, text) IS
  'Global safe player locator. Sensitive account contexts are included only when canonical club/union/downline authorization permits them.';
COMMENT ON FUNCTION public.fn_get_table_watch_access(uuid) IS
  'Membership-aware Watch/Join/Request decision for a live cash or tournament table.';
