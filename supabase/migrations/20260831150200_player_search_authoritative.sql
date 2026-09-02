-- Server-authoritative, indexed Club Arena player locator.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS public.player_search_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  discoverable boolean NOT NULL DEFAULT true,
  show_display_name boolean NOT NULL DEFAULT true,
  show_presence boolean NOT NULL DEFAULT true,
  show_current_table boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.player_search_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS player_search_preferences_own ON public.player_search_preferences;
CREATE POLICY player_search_preferences_own
  ON public.player_search_preferences FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_profiles_username_trgm
  ON public.profiles USING gin (lower(username) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_profiles_display_name_trgm
  ON public.profiles USING gin (lower(display_name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_club_members_search_scope
  ON public.club_members (club_id, user_id) WHERE status IN ('active', 'approved');

CREATE OR REPLACE FUNCTION public.fn_get_player_search_preferences()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_uid uuid := auth.uid(); v_row public.player_search_preferences%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  SELECT * INTO v_row FROM public.player_search_preferences WHERE user_id=v_uid;
  RETURN jsonb_build_object(
    'discoverable', COALESCE(v_row.discoverable, true),
    'show_display_name', COALESCE(v_row.show_display_name, true),
    'show_presence', COALESCE(v_row.show_presence, true),
    'show_current_table', COALESCE(v_row.show_current_table, true)
  );
END $$;

CREATE OR REPLACE FUNCTION public.fn_set_player_search_preferences(
  p_discoverable boolean,
  p_show_display_name boolean,
  p_show_presence boolean,
  p_show_current_table boolean
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  INSERT INTO public.player_search_preferences
    (user_id, discoverable, show_display_name, show_presence, show_current_table, updated_at)
  VALUES
    (v_uid, COALESCE(p_discoverable,true), COALESCE(p_show_display_name,true),
     COALESCE(p_show_presence,true), COALESCE(p_show_current_table,true), now())
  ON CONFLICT (user_id) DO UPDATE SET
    discoverable=EXCLUDED.discoverable,
    show_display_name=EXCLUDED.show_display_name,
    show_presence=EXCLUDED.show_presence,
    show_current_table=EXCLUDED.show_current_table,
    updated_at=now();
  RETURN public.fn_get_player_search_preferences();
END $$;

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
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_query text := lower(btrim(COALESCE(p_query,'')));
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit,20),1),50);
  v_offset integer := GREATEST(COALESCE(p_offset,0),0);
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.club_entry_feature_flags f WHERE f.key='find_player'
      AND (NOT f.enabled OR ((hashtextextended(v_uid::text || ':' || f.key,44119) & 9223372036854775807) % 100) >= f.rollout_percent)
  ) THEN RAISE EXCEPTION 'Player search is temporarily unavailable.' USING ERRCODE='P0001'; END IF;
  IF length(v_query) < 2 OR length(v_query) > 64 THEN
    RAISE EXCEPTION 'Search must be between 2 and 64 characters' USING ERRCODE='22023';
  END IF;
  IF p_scope NOT IN ('all','friends','clubs','union') THEN
    RAISE EXCEPTION 'Invalid search scope' USING ERRCODE='22023';
  END IF;
  IF p_presence NOT IN ('all','online','playing') THEN
    RAISE EXCEPTION 'Invalid presence filter' USING ERRCODE='22023';
  END IF;
  IF p_sort NOT IN ('relevance','name') THEN
    RAISE EXCEPTION 'Invalid search sort' USING ERRCODE='22023';
  END IF;

  WITH caller_memberships AS (
    SELECT club_id, role::text
      FROM public.club_members
     WHERE user_id=v_uid AND status IN ('active','approved')
  ), friend_ids AS (
    SELECT friend_id AS user_id FROM public.friendships WHERE user_id=v_uid
    UNION SELECT user_id FROM public.friendships WHERE friend_id=v_uid
  ), shared_club_ids AS (
    SELECT club_id FROM caller_memberships
     WHERE role IN ('owner','co_owner','admin','agent','super_agent','sub_agent')
  ), managed_union_ids AS (
    SELECT id AS union_id FROM public.unions WHERE owner_id=v_uid
    UNION SELECT union_id FROM public.union_admins WHERE user_id=v_uid
  ), union_club_ids AS (
    SELECT uc.club_id FROM public.union_clubs uc
      JOIN managed_union_ids mu ON mu.union_id=uc.union_id
  ), scoped AS (
    SELECT v_uid AS user_id, 'self'::text AS relationship
    UNION SELECT user_id, 'friend' FROM friend_ids
    UNION SELECT cm.user_id, 'club' FROM public.club_members cm
      JOIN shared_club_ids sc ON sc.club_id=cm.club_id
     WHERE cm.status IN ('active','approved')
    UNION SELECT cm.user_id, 'union' FROM public.club_members cm
      JOIN union_club_ids uc ON uc.club_id=cm.club_id
     WHERE cm.status IN ('active','approved')
  ), eligible AS (
    SELECT user_id,
      CASE min(CASE relationship WHEN 'self' THEN 0 WHEN 'friend' THEN 1 WHEN 'club' THEN 2 ELSE 3 END)
        WHEN 0 THEN 'self' WHEN 1 THEN 'friend' WHEN 2 THEN 'club' ELSE 'union' END AS relationship
      FROM scoped
     WHERE p_scope='all'
        OR (p_scope='friends' AND relationship IN ('self','friend'))
        OR (p_scope='clubs' AND relationship IN ('self','club'))
        OR (p_scope='union' AND relationship IN ('self','union'))
     GROUP BY user_id
  ), candidates AS (
    SELECT p.id, p.username,
      CASE WHEN COALESCE(pref.show_display_name,true) OR e.relationship IN ('self','friend')
           THEN p.display_name ELSE NULL END AS display_name,
      COALESCE(NULLIF(p.arena_avatar_url,''),p.avatar_url) AS avatar_url,
      e.relationship,
      CASE WHEN COALESCE(pref.show_presence,true) OR e.relationship='self'
           THEN COALESCE(up.status,'offline') ELSE 'hidden' END AS presence_status,
      CASE WHEN (COALESCE(pref.show_current_table,true) AND COALESCE(pref.show_presence,true))
                  OR e.relationship='self'
           THEN up.current_table_id ELSE NULL END AS current_table_id,
      CASE
        WHEN lower(COALESCE(p.username,''))=v_query THEN 0
        WHEN lower(COALESCE(p.display_name,''))=v_query THEN 1
        WHEN lower(COALESCE(p.username,'')) LIKE v_query || '%' THEN 2
        WHEN lower(COALESCE(p.display_name,'')) LIKE v_query || '%' THEN 3
        ELSE 4 END AS relevance
      FROM eligible e
      JOIN public.profiles p ON p.id=e.user_id
      LEFT JOIN public.player_search_preferences pref ON pref.user_id=p.id
      LEFT JOIN public.user_presence up ON up.user_id=p.id
     WHERE (COALESCE(pref.discoverable,true) OR e.relationship IN ('self','friend'))
       AND (lower(COALESCE(p.username,'')) LIKE '%' || v_query || '%'
         OR lower(COALESCE(p.display_name,'')) LIKE '%' || v_query || '%'
         OR COALESCE(p.player_number,'') = v_query)
       AND (p_presence='all'
         OR (p_presence='online' AND COALESCE(up.status,'offline') IN ('online','away','playing'))
         OR (p_presence='playing' AND COALESCE(up.status,'offline')='playing'))
  ), numbered AS (
    SELECT *, count(*) OVER() AS full_count FROM candidates
  ), page AS (
    SELECT * FROM numbered
     ORDER BY
       CASE WHEN p_sort='relevance' THEN relevance END,
       CASE WHEN p_sort='name' THEN lower(COALESCE(display_name,username,'')) END,
       lower(COALESCE(username,'')), id
     LIMIT v_limit OFFSET v_offset
  ), decorated AS (
    SELECT pg.*,
      COALESCE((
        SELECT jsonb_agg(t.item ORDER BY t.ordinal)
        FROM (
          (SELECT jsonb_build_object(
            'id', tb.id, 'name', tb.name, 'game_variant', tb.game_variant,
            'stakes', concat('$',tb.small_blind,'/$',tb.big_blind),
            'club_name', c.name, 'is_tournament', false
          ) AS item, 1 AS ordinal
          FROM public.table_seats ts
          JOIN public.tables tb ON tb.id=ts.table_id
          LEFT JOIN public.clubs c ON c.id=tb.club_id
          WHERE ts.user_id=pg.id AND ts.left_at IS NULL
            AND lower(COALESCE(tb.status::text,'')) IN ('running','waiting')
            AND pg.current_table_id IS NOT NULL
          LIMIT 4)
          UNION ALL
          (SELECT jsonb_build_object(
            'id', tr.id, 'name', tr.name, 'game_variant', 'MTT',
            'stakes', concat('$',COALESCE(tr.buy_in_amount,0),' Buy-In'),
            'club_name', c.name, 'is_tournament', true
          ) AS item, 2 AS ordinal
          FROM public.tournament_players tp
          JOIN public.tournaments tr ON tr.id=tp.tournament_id
          LEFT JOIN public.clubs c ON c.id=tr.club_id
          WHERE tp.user_id=pg.id
            AND lower(COALESCE(tp.status::text,'')) IN ('registered','playing')
            AND upper(COALESCE(tr.status::text,'')) IN ('RUNNING','REGISTERING')
            AND pg.current_table_id IS NOT NULL
          LIMIT 4)
        ) t
      ), '[]'::jsonb) AS tables
    FROM page pg
  )
  SELECT jsonb_build_object(
    'items', COALESCE(jsonb_agg(jsonb_build_object(
      'id',id,'username',COALESCE(username,''),'display_name',display_name,
      'avatar_url',avatar_url,'relationship',relationship,
      'presence_status',presence_status,'tables',tables
    )), '[]'::jsonb),
    'total', COALESCE(max(full_count),0),
    'limit', v_limit,
    'offset', v_offset,
    'has_more', COALESCE(max(full_count),0) > v_offset + v_limit
  ) INTO v_result FROM decorated;

  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.fn_search_players(text,integer,integer,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_get_player_search_preferences() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_set_player_search_preferences(boolean,boolean,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_search_players(text,integer,integer,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_get_player_search_preferences() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_set_player_search_preferences(boolean,boolean,boolean,boolean) TO authenticated;
