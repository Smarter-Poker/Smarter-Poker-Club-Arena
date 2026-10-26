-- 20261026011835_player_search_lists_only_real_players.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT WAS WRONG (Dan, 2026-10-25: "YOU NEED TO REMOVE ALL OF THE DELETED AND
-- TEST ACCOUNT COMPLETLY")
--
-- Find A Player searched every row of public.profiles. Read from production on
-- 2026-10-26: of 2,740 non-horse profiles only 106 are real, live people. The
-- rest were 1,262 deleted accounts (status 'deleted', shown as DELETED-xxxx),
-- 1,222 accounts whose sign-in was deleted but whose profile still read
-- 'active' (post-deploy verification identities, PostDeployxxxxx), and live
-- test identities on example.invalid / example.com / hydra.bot (crest_cert_,
-- LobbyCert, PostDeploy, testuser, 120 hydra.bot seed names) plus four internal
-- QA/system sign-ins. Searching "333" returned the one real player "333"
-- followed by four DELETED rows and a crest_cert_ fixture.
--
-- THE FIX
--
-- The matched set now joins auth.users and lists a profile only when it is not
-- deleted, its sign-in is neither deleted nor banned, and (unless it is a
-- horse) public.is_system_user(email) - the platform's existing definition of
-- a non-person identity - says it is a real person. Horses are never filtered
-- by the test-identity rule (CLAUDE.md 10.5); a deleted horse is deleted.
-- Measured against production before writing this: 106 real players and 938
-- live horses remain searchable; 2,696 rows leave the results.
--
-- Only the matched CTE's FROM/WHERE changes. Every other line of the body is
-- byte-identical to 20261024193818, the live definition (prosrc md5
-- d4f2553b5a29d372d39b9c46e1679afe, read 2026-10-26).
--
-- One function, one transaction: one PostgREST schema reload.

BEGIN;

SET LOCAL lock_timeout = '5s';

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
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 5000);
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
  agent_downline(club_id, user_id) AS (
    SELECT cm.club_id, cm.user_id FROM public.club_members cm
     WHERE cm.user_id = v_uid AND cm.role IN ('super_agent', 'agent', 'sub_agent')
       AND cm.status IN ('active', 'approved')
    UNION
    SELECT child.club_id, child.user_id FROM agent_downline parent
      JOIN public.club_members child
        ON child.club_id = parent.club_id AND child.agent_id = parent.user_id
     WHERE child.status IN ('active', 'approved')
  ), viewer_clubs AS MATERIALIZED (
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
           public.fn_arena_name(p.alias, p.username, p.display_name,
                                p.first_name, p.last_name, p.full_name) AS arena_name,
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
           coalesce(sp.show_display_name, true) AS pref_show_display_name,
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
      JOIN auth.users au ON au.id = p.id
      LEFT JOIN public.player_search_preferences sp ON sp.user_id = p.id
     -- Only real, live players are listed. A deleted account, a deleted or
     -- banned sign-in, and a platform test identity (post-deploy, certification,
     -- QA and seed accounts) never appear. Horses are players (CLAUDE.md 10.5):
     -- the test-identity rule never applies to a horse.
     WHERE p.status IS DISTINCT FROM 'deleted'
       AND au.deleted_at IS NULL
       AND NOT coalesce(au.banned_until > now(), false)
       AND (coalesce(p.is_horse, false)
            OR NOT (public.is_system_user(au.email)
                    OR au.email IN ('reels-qa@smarter.poker', 'reels-qa-target@smarter.poker',
                                    'system@smarter.poker', 'developer@smarter.poker')))
       AND (lower(coalesce(p.username, '')) LIKE '%' || v_like || '%' ESCAPE '\'
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
        )))
  ), managed AS MATERIALIZED (
    SELECT DISTINCT m.id AS user_id
      FROM matched m
      JOIN public.club_members cm ON cm.user_id = m.id AND cm.status IN ('active', 'approved')
     WHERE m.id = v_uid
        OR EXISTS (SELECT 1 FROM agent_downline d WHERE d.user_id = m.id)
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
  ), presence_rows AS MATERIALIZED (
    SELECT s.*,
           (s.pref_show_presence OR s.is_privileged) AND (
             EXISTS (
               SELECT 1 FROM public.table_seats ts
               JOIN public.tables t ON t.id = ts.table_id
                WHERE ts.user_id = s.id AND ts.left_at IS NULL
                  AND t.tournament_id IS NULL
                  AND t.status IN ('waiting', 'running') AND coalesce(t.is_deleted, false) = false
             ) OR EXISTS (
               SELECT 1 FROM public.tournament_players tp
               JOIN public.tournaments tr ON tr.id = tp.tournament_id
               JOIN public.tables t ON t.id = tp.table_id AND t.tournament_id = tr.id
                WHERE tp.user_id = s.id AND tp.status = 'playing' AND tp.table_id IS NOT NULL
                  AND lower(coalesce(tr.status::text, '')) IN ('running', 'in_progress', 'active')
                  AND lower(coalesce(t.status::text, '')) IN ('waiting', 'running', 'active')
                  AND coalesce(t.is_deleted, false) = false
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
    SELECT *, row_number() OVER (
      ORDER BY
        CASE WHEN p_sort = 'relevance' THEN relevance END,
        CASE WHEN p_sort = 'relevance' THEN -coalesce(match_score, 0) END,
        CASE WHEN p_sort = 'name' THEN lower(coalesce(arena_name, username, '')) END,
        lower(coalesce(username, '')), id
    ) AS page_ordinal
      FROM filtered
     ORDER BY
       CASE WHEN p_sort = 'relevance' THEN relevance END,
       CASE WHEN p_sort = 'relevance' THEN -coalesce(match_score, 0) END,
       CASE WHEN p_sort = 'name' THEN lower(coalesce(arena_name, username, '')) END,
       lower(coalesce(username, '')), id
     LIMIT v_limit OFFSET v_offset
  ), live_clubs AS MATERIALIZED (
    SELECT DISTINCT pg.id AS user_id, t.club_id
      FROM page pg
      JOIN public.table_seats ts ON ts.user_id = pg.id AND ts.left_at IS NULL
      JOIN public.tables t ON t.id = ts.table_id AND t.tournament_id IS NULL
     WHERE (pg.can_show_tables OR public.fn_agent_can_watch_table(t.id, v_uid))
       AND t.status IN ('waiting', 'running')
       AND coalesce(t.is_deleted, false) = false
       AND (coalesce(t.is_anonymous, false) = false
         OR public.fn_agent_can_watch_table(t.id, v_uid))
    UNION
    SELECT DISTINCT pg.id, tr.club_id
      FROM page pg
      JOIN public.tournament_players tp
        ON tp.user_id = pg.id AND tp.status = 'playing' AND tp.table_id IS NOT NULL
      JOIN public.tournaments tr ON tr.id = tp.tournament_id
      JOIN public.tables t ON t.id = tp.table_id AND t.tournament_id = tr.id
     WHERE (pg.can_show_tables OR public.fn_agent_can_watch_table(t.id, v_uid))
       AND lower(coalesce(tr.status::text, '')) IN ('running', 'in_progress', 'active')
       AND lower(coalesce(t.status::text, '')) IN ('waiting', 'running', 'active')
       AND coalesce(t.is_deleted, false) = false
       AND (coalesce(t.is_anonymous, false) = false
         OR public.fn_agent_can_watch_table(t.id, v_uid))
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
            'can_watch', live.viewer_seated OR live.can_watch OR public.fn_agent_can_watch_table(live.table_id, v_uid),
            'access_action', CASE WHEN live.viewer_seated THEN 'play'
              WHEN public.fn_agent_can_watch_table(live.table_id, v_uid) THEN 'watch'
              ELSE live.access_action END
          ) AS game,
          live.is_tournament,
          live.name
        FROM (
          SELECT t.id AS table_id, NULL::uuid AS tournament_id, t.name::text,
                 coalesce(t.game_variant, t.game_type, 'Poker')::text AS game_variant,
                 concat(t.small_blind, '/', t.big_blind)::text AS stakes,
                 coalesce(t.club_id, t.union_id) AS club_uuid, c.club_id AS club_number, c.slug AS club_slug,
                 coalesce(c.name, 'Union Table')::text AS club_name, false AS is_tournament, cm.status AS membership_status,
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
            LEFT JOIN public.clubs c ON c.id = coalesce(t.club_id, t.union_id)
            LEFT JOIN public.club_members cm ON cm.club_id = c.id AND cm.user_id = v_uid
           WHERE ts.user_id = pg.id AND ts.left_at IS NULL AND (pg.can_show_tables OR public.fn_agent_can_watch_table(t.id, v_uid))
             AND t.status IN ('waiting', 'running') AND coalesce(t.is_deleted, false) = false
             AND (coalesce(t.is_anonymous, false) = false
         OR public.fn_agent_can_watch_table(t.id, v_uid))
          UNION ALL
          SELECT t.id, tr.id, coalesce(t.name, tr.name)::text,
                 coalesce(tr.variant, tr.game_type, 'MTT')::text,
                 (CASE WHEN coalesce(tr.buy_in_amount, 0) = 0 THEN 'Free Buy'
                       ELSE concat(tr.buy_in_amount, ' Buy-In') END)::text,
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
            JOIN public.tables t ON t.id = tp.table_id AND t.tournament_id = tr.id
            JOIN public.clubs c ON c.id = tr.club_id
            LEFT JOIN public.club_members cm ON cm.club_id = c.id AND cm.user_id = v_uid
           WHERE tp.user_id = pg.id AND tp.status = 'playing' AND tp.table_id IS NOT NULL
             AND (pg.can_show_tables OR public.fn_agent_can_watch_table(t.id, v_uid))
             AND lower(coalesce(tr.status::text, '')) IN ('running', 'in_progress', 'active')
             AND lower(coalesce(t.status::text, '')) IN ('waiting', 'running', 'active')
             AND coalesce(t.is_deleted, false) = false
             AND (coalesce(t.is_anonymous, false) = false
         OR public.fn_agent_can_watch_table(t.id, v_uid))
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
               c.name::text AS club_name,
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
      'display_name', CASE
        WHEN pref_show_display_name OR relationship IN ('self', 'friend') OR is_privileged
          THEN arena_name
        ELSE NULL
      END,
      'avatar_url', avatar_url,
      'relationship', CASE WHEN EXISTS (SELECT 1 FROM managed m WHERE m.user_id = id)
                           AND relationship = 'public' THEN 'managed' ELSE relationship END,
      'presence_status', presence_status,
      'match_score', round(coalesce(match_score, 0)::numeric, 3),
      'tables', tables,
      'affiliations', affiliations,
      'sensitive_accounts', sensitive_accounts
    ) ORDER BY page_ordinal), '[]'::jsonb),
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

COMMENT ON FUNCTION public.fn_search_players(text, integer, integer, text, text, text) IS
  'Authenticated global player locator over real, live players only (no deleted, banned or test identities; horses always included) with escaped indexed matching, display-name/presence/table privacy, arena aliases, and role-minimized club/union affiliations.';

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
  IF position('JOIN auth.users au ON au.id = p.id' IN v_src) = 0
     OR position('p.status IS DISTINCT FROM ''deleted''' IN v_src) = 0
     OR position('au.deleted_at IS NULL' IN v_src) = 0
     OR position('public.is_system_user(au.email)' IN v_src) = 0
     OR position('coalesce(p.is_horse, false)' IN v_src) = 0 THEN
    RAISE EXCEPTION 'player search no longer limits itself to real, live players';
  END IF;
  IF position('v_like' IN v_src) = 0
     OR position('lower(p.username) %' IN v_src) = 0
     OR position('player_search_preferences' IN v_src) = 0
     OR position('pref_show_display_name' IN v_src) = 0
     OR position('fn_arena_name' IN v_src) = 0
     OR position('viewer_seated' IN v_src) = 0 THEN
    RAISE EXCEPTION 'an earlier player search safeguard was lost';
  END IF;
END;
$assert$;

COMMIT;
