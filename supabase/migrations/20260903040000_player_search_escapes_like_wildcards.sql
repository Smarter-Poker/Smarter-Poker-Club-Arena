-- FIND A PLAYER: THE QUERY BOX IS NOT A PATTERN LANGUAGE
--
-- v_query went into `LIKE '%' || v_query || '%'` raw, so the two LIKE
-- metacharacters were live for anyone who typed them:
--
--   "a%"  matched 830 of 1308 profiles - 64% of the directory - because the
--         trailing % is "anything", not a percent sign.
--   "j_n" matched jon, jan, j5n and every other three-letter run starting j
--         and ending n, because _ is "any single character".
--
-- Neither is injection: the value is parameterised and cannot escape the
-- string. It is a correctness bug (the user asked for a literal and got a
-- pattern) and a performance one (the widest possible scan, on the surface we
-- just spent a migration teaching to use its indexes).
--
-- The intent already existed elsewhere and had simply never been written here:
-- src/components/admin/PlayerSearch.tsx escapes [\%_] and its comment says it
-- does so "the same way FindPlayerModal's escapeSearchQuery does it" - a
-- function that does not exist. The comment documented a guard that was never
-- built. That comment is corrected in the same commit as this migration.
--
-- Escaping applies ONLY to the LIKE patterns. The trigram operator %, the
-- similarity() calls, and the player_number equality all take the raw query:
-- they have no metacharacters, and escaping there would corrupt the match.

BEGIN;

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
  v_like text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_fuzzy boolean;
  v_min_similarity real := 0.3;
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

  -- Backslash first, or it would escape the escapes added after it.
  v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');

  v_fuzzy := length(v_query) >= 3;

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
  ), viewer_seats AS MATERIALIZED (
    SELECT ts.table_id
      FROM public.table_seats ts
     WHERE ts.user_id = v_uid AND ts.left_at IS NULL
  ), matched AS MATERIALIZED (
    SELECT p.id, p.username, p.display_name,
           coalesce(nullif(p.arena_avatar_url, ''), p.avatar_url) AS avatar_url,
           CASE
             WHEN lower(coalesce(p.username, '')) = v_query THEN 0
             WHEN lower(coalesce(p.display_name, '')) = v_query THEN 1
             WHEN lower(coalesce(p.alias, '')) = v_query THEN 2
             WHEN coalesce(p.player_number, '') = v_query THEN 2
             WHEN lower(coalesce(p.username, '')) LIKE v_like || '%' ESCAPE '\' THEN 3
             WHEN lower(coalesce(p.display_name, '')) LIKE v_like || '%' ESCAPE '\' THEN 4
             WHEN lower(coalesce(p.username, '')) LIKE '%' || v_like || '%' ESCAPE '\'
               OR lower(coalesce(p.display_name, '')) LIKE '%' || v_like || '%' ESCAPE '\'
               OR lower(coalesce(p.alias, '')) LIKE '%' || v_like || '%' ESCAPE '\' THEN 5
             ELSE 6
           END AS relevance,
           greatest(
             similarity(lower(coalesce(p.username, '')), v_query),
             similarity(lower(coalesce(p.display_name, '')), v_query),
             similarity(lower(coalesce(p.alias, '')), v_query)
           ) AS match_score,
           coalesce(sp.discoverable, true) AS pref_discoverable,
           coalesce(sp.show_presence, true) AS pref_show_presence,
           coalesce(sp.show_current_table, true) AS pref_show_current_table,
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
      LEFT JOIN public.player_search_preferences sp ON sp.user_id = p.id
     WHERE lower(coalesce(p.username, '')) LIKE '%' || v_like || '%' ESCAPE '\'
        OR lower(coalesce(p.display_name, '')) LIKE '%' || v_like || '%' ESCAPE '\'
        OR lower(coalesce(p.alias, '')) LIKE '%' || v_like || '%' ESCAPE '\'
        OR coalesce(p.player_number, '') = v_query
        OR (v_fuzzy AND (
              (lower(p.username) % v_query
                AND similarity(lower(p.username), v_query) >= v_min_similarity)
           OR (lower(p.display_name) % v_query
                AND similarity(lower(p.display_name), v_query) >= v_min_similarity)
           OR (lower(p.alias) % v_query
                AND similarity(lower(p.alias), v_query) >= v_min_similarity)
        ))
  ), managed AS MATERIALIZED (
    SELECT DISTINCT m.id AS user_id
      FROM matched m
      JOIN public.club_members cm ON cm.user_id = m.id AND cm.status IN ('active', 'approved')
     WHERE m.id = v_uid
        OR public.ca_club_roster_access(cm.club_id, m.id) IN ('staff', 'downline', 'service')
  ), scoped AS MATERIALIZED (
    SELECT m.*,
           (m.id = v_uid OR EXISTS (SELECT 1 FROM managed x WHERE x.user_id = m.id))
             AS is_privileged
      FROM matched m
     WHERE (p_scope = 'all'
        OR (p_scope = 'friends' AND m.relationship IN ('self', 'friend'))
        OR (p_scope = 'clubs' AND m.relationship IN ('self', 'club'))
        OR (p_scope = 'union' AND m.relationship IN ('self', 'union'))
        OR (p_scope = 'managed' AND EXISTS (SELECT 1 FROM managed x WHERE x.user_id = m.id)))
       AND (m.pref_discoverable
            OR m.id = v_uid
            OR EXISTS (SELECT 1 FROM managed x WHERE x.user_id = m.id))
  ), presence_rows AS MATERIALIZED (
    SELECT s.*,
           (s.pref_show_presence OR s.is_privileged) AND (
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
             )
           ) AS is_playing,
           (s.pref_show_presence OR s.is_privileged)
             AND coalesce(p.is_online, false)
             AND p.last_seen > now() - interval '5 minutes' AS is_online,
           (s.pref_show_current_table OR s.is_privileged) AS can_show_tables
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
       CASE WHEN p_sort = 'relevance' THEN -coalesce(match_score, 0) END,
       CASE WHEN p_sort = 'name' THEN lower(coalesce(display_name, username, '')) END,
       lower(coalesce(username, '')), id
     LIMIT v_limit OFFSET v_offset
  ), live_clubs AS MATERIALIZED (
    SELECT DISTINCT pg.id AS user_id, t.club_id
      FROM page pg
      JOIN public.table_seats ts ON ts.user_id = pg.id AND ts.left_at IS NULL
      JOIN public.tables t ON t.id = ts.table_id AND t.tournament_id IS NULL
     WHERE pg.can_show_tables
       AND t.status IN ('waiting', 'running')
       AND coalesce(t.is_deleted, false) = false
       AND coalesce(t.is_anonymous, false) = false
    UNION
    SELECT DISTINCT pg.id, tr.club_id
      FROM page pg
      JOIN public.tournament_players tp
        ON tp.user_id = pg.id AND tp.status = 'playing' AND tp.table_id IS NOT NULL
      JOIN public.tournaments tr ON tr.id = tp.tournament_id
      JOIN public.tables t ON t.id = tp.table_id
     WHERE pg.can_show_tables
       AND lower(coalesce(tr.status::text, '')) IN ('running', 'in_progress', 'active')
       AND coalesce(t.is_anonymous, false) = false
  ), decorated AS (
    SELECT pg.*,
      CASE WHEN pg.is_playing THEN 'playing' WHEN pg.is_online THEN 'online' ELSE 'offline' END
        AS presence_status,
      coalesce(g.games, '[]'::jsonb) AS tables,
      coalesce(a.accounts, '[]'::jsonb) AS sensitive_accounts,
      jsonb_build_object(
        'clubs', coalesce(af.clubs, '[]'::jsonb),
        'unions', coalesce(af.unions, '[]'::jsonb),
        'has_hidden', coalesce(af.has_hidden, false)
      ) AS affiliations
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
            'can_watch', live.viewer_seated OR live.can_watch,
            'access_action', CASE WHEN live.viewer_seated THEN 'play' ELSE live.access_action END
          ) AS game,
          live.is_tournament,
          live.name
        FROM (
          SELECT t.id AS table_id, NULL::uuid AS tournament_id, t.name::text,
                 coalesce(t.game_variant, t.game_type, 'Poker')::text AS game_variant,
                 concat('$', t.small_blind, '/$', t.big_blind)::text AS stakes,
                 c.id AS club_uuid, c.club_id AS club_number, c.slug AS club_slug,
                 c.name::text AS club_name, false AS is_tournament, cm.status AS membership_status,
                 EXISTS (SELECT 1 FROM viewer_seats vs WHERE vs.table_id = t.id) AS viewer_seated,
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
           WHERE ts.user_id = pg.id AND ts.left_at IS NULL AND pg.can_show_tables
             AND t.status IN ('waiting', 'running') AND coalesce(t.is_deleted, false) = false
             AND coalesce(t.is_anonymous, false) = false
          UNION ALL
          SELECT t.id, tr.id, coalesce(t.name, tr.name)::text,
                 coalesce(tr.variant, tr.game_type, 'MTT')::text,
                 concat('$', coalesce(tr.buy_in_amount, 0), ' Buy-In')::text,
                 c.id, c.club_id, c.slug, c.name::text, true, cm.status,
                 EXISTS (SELECT 1 FROM viewer_seats vs WHERE vs.table_id = t.id),
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
             AND pg.can_show_tables
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
    LEFT JOIN LATERAL (
      WITH club_rows AS (
        SELECT c.id AS club_uuid, c.club_id AS club_number, c.slug AS club_slug,
               c.name::text AS club_name, cm.role::text AS role,
               (coalesce(c.requires_approval, false)
                 OR coalesce(c.is_public, true) = false) AS is_gated,
               lower(coalesce(c.status, 'active')) = 'active' AS club_active,
               viewer.status AS viewer_status,
               (
                 pg.id = v_uid
                 OR NOT (coalesce(c.requires_approval, false)
                         OR coalesce(c.is_public, true) = false)
                 OR EXISTS (SELECT 1 FROM viewer_clubs vc WHERE vc.club_id = c.id)
                 OR EXISTS (
                   SELECT 1 FROM public.union_clubs uc
                   JOIN viewer_unions vu ON vu.union_id = uc.union_id
                    WHERE uc.club_id = c.id
                 )
                 OR EXISTS (
                   SELECT 1 FROM live_clubs lc
                    WHERE lc.user_id = pg.id AND lc.club_id = c.id
                 )
               ) AS visible
          FROM public.club_members cm
          JOIN public.clubs c ON c.id = cm.club_id
          LEFT JOIN public.club_members viewer
                 ON viewer.club_id = c.id AND viewer.user_id = v_uid
         WHERE cm.user_id = pg.id
           AND cm.status IN ('active', 'approved')
           AND lower(coalesce(c.status, 'active')) NOT IN ('deleted', 'archived')
      )
      SELECT
        (SELECT jsonb_agg(jsonb_build_object(
            'club_uuid', cr.club_uuid,
            'club_id', cr.club_number,
            'club_slug', cr.club_slug,
            'club_name', cr.club_name,
            'role', cr.role,
            'is_gated', cr.is_gated,
            'viewer_membership_status', cr.viewer_status,
            'viewer_action', CASE
              WHEN cr.viewer_status IN ('active', 'approved') THEN 'member'
              WHEN cr.viewer_status = 'pending' THEN 'pending'
              WHEN cr.viewer_status IN ('banned', 'suspended', 'rejected') THEN 'unavailable'
              WHEN NOT cr.club_active THEN 'unavailable'
              WHEN cr.is_gated THEN 'request_join'
              ELSE 'join'
            END
          ) ORDER BY cr.club_name)
           FROM club_rows cr WHERE cr.visible) AS clubs,
        (SELECT jsonb_agg(DISTINCT jsonb_build_object(
            'union_id', u.id,
            'union_name', u.name::text,
            'union_code', coalesce(u.union_code::text, u.code)
          ))
           FROM club_rows cr
           JOIN public.union_clubs uc ON uc.club_id = cr.club_uuid
           JOIN public.unions u ON u.id = uc.union_id
          WHERE cr.visible
            AND (coalesce(u.is_public, true)
                 OR EXISTS (SELECT 1 FROM viewer_unions vu WHERE vu.union_id = u.id))
        ) AS unions,
        EXISTS (SELECT 1 FROM club_rows cr WHERE NOT cr.visible) AS has_hidden
    ) af ON true
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
      'match_score', round(coalesce(match_score, 0)::numeric, 3),
      'tables', tables,
      'affiliations', affiliations,
      'sensitive_accounts', sensitive_accounts
    )), '[]'::jsonb),
    'total', coalesce(max(full_count), 0),
    'limit', v_limit,
    'offset', v_offset,
    'fuzzy', v_fuzzy,
    'has_more', coalesce(max(full_count), 0) > v_offset + v_limit
  ) INTO v_result FROM decorated;

  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_search_players(text, integer, integer, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_search_players(text, integer, integer, text, text, text)
  TO authenticated, service_role;

DO $assert$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_search_players';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_search_players did not survive the replace';
  END IF;

  -- No LIKE pattern may be built from the raw query again.
  IF position('LIKE ''%'' || v_query' IN v_src) > 0
     OR position('LIKE v_query' IN v_src) > 0 THEN
    RAISE EXCEPTION 'a LIKE pattern is built from the unescaped query again';
  END IF;
  IF position('v_like' IN v_src) = 0 THEN
    RAISE EXCEPTION 'the escaped LIKE term is gone';
  END IF;

  -- Everything the earlier migrations fixed must still hold.
  IF position('hidden_count' IN v_src) > 0 THEN
    RAISE EXCEPTION 'affiliations returns a count of hidden clubs again';
  END IF;
  IF position('c.is_private' IN v_src) > 0 THEN
    RAISE EXCEPTION 'is_gated is keyed off the dead c.is_private flag again';
  END IF;
  IF position('lower(p.username) %' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fuzzy predicate lost its indexable username clause';
  END IF;
  IF position('player_search_preferences' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_search_players no longer reads player_search_preferences';
  END IF;
  IF position('viewer_seated' IN v_src) = 0 THEN
    RAISE EXCEPTION 'search payload no longer distinguishes the viewer own seat';
  END IF;
END;
$assert$;

COMMIT;
