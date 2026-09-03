-- FIND A PLAYER: TRIGRAM FUZZY MATCHING + CLUB/UNION AFFILIATIONS
--
-- Three additions to the locator, all load-bearing for the UI:
--
-- 1. Fuzzy matching. Substring LIKE only finds a player if the typed run of
--    characters appears verbatim. Once the caller has typed three characters
--    we additionally accept trigram-similar names, so "kingfsh" and "kngfish"
--    both reach @kingfish.
--
--    The predicate is written as `lower(p.username) % v_query`, NOT
--    `lower(coalesce(p.username,'')) % v_query`. The indexes are on the bare
--    expression `lower(username)`; wrapping the column in coalesce() produces a
--    different expression, the planner cannot match it to the index, and the
--    whole of profiles is scanned on every keystroke past the third. The
--    coalesce is unnecessary anyway: `NULL % x` is NULL, which the OR-chain
--    discards exactly like false. alias gets its own trigram index below for
--    the same reason - without one it forces a scan no matter what the other
--    two columns do.
--
--    `%` reads pg_trgm.similarity_threshold from the session. It is paired with
--    an explicit `similarity() >= 0.3` floor so a session that LOWERED the
--    threshold cannot widen discovery underneath us. (A session that raised it
--    would narrow results; that is a degradation, not a disclosure, and the
--    floor cannot help there.)
--
-- 2. Affiliations. The locator previously answered "is this player online" but
--    never "where do they belong". We now return the clubs and unions a matched
--    player is in, with the viewer's own membership status and the join action
--    they would need, so the UI can route a non-member into the correct
--    join / request-approval flow instead of a dead end.
--
--    A club is GATED when it requires approval or is not public. `is_private`
--    is deliberately NOT consulted: it is false on every row in this database
--    and every reference to it in the client is about tables and tournaments,
--    not clubs. src/components/clubs/ClubDiscovery.tsx is the app's own
--    definition and it reads `requires_approval || !is_public` - this function
--    now agrees with it. The first draft of this migration used is_private and
--    therefore treated the two largest approval-gated clubs on the platform as
--    open, naming their members to any searcher. That is the bug this comment
--    exists to stop someone re-introducing.
--
--    A gated club is named only to a viewer who already shares it (same club,
--    or same union), who is looking at their own profile, or who can ALREADY
--    see that club named in this same response because the player is sitting at
--    one of its live tables. Everything else is counted, not named, so this
--    endpoint cannot be used to enumerate a private roster. That last clause
--    matters: without it a response could say "1 Private Club Not Shown"
--    directly above a game card naming the very same club.
--
-- 3. Search privacy preferences are finally enforced. player_search_preferences
--    has existed since 20260831150200 and the settings UI writes to it, but
--    fn_search_players never read it, so `discoverable = false` did nothing.
--    That was survivable while the endpoint only revealed a name; it is not
--    survivable now that it reveals club and union membership. Self and
--    accounts the viewer administers are exempt, so an agent can still find
--    their own downline.
--
-- Wallets, stats, notes and hierarchy are untouched - they still flow
-- exclusively through ca_club_member_detail's authorization decision.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_club_members_user_active
  ON public.club_members (user_id, club_id)
  WHERE status IN ('active', 'approved');

-- Without this, alias matching forces a sequential scan of profiles even when
-- username and display_name can both be answered from their trigram indexes.
CREATE INDEX IF NOT EXISTS idx_profiles_alias_trgm
  ON public.profiles USING gin (lower(alias) gin_trgm_ops);

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

  -- Fuzzy matching turns on at three characters. Below that, trigram
  -- similarity is noise: a two-character query shares trigrams with a large
  -- fraction of the directory and would bury exact matches.
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
  ), matched AS MATERIALIZED (
    SELECT p.id, p.username, p.display_name,
           coalesce(nullif(p.arena_avatar_url, ''), p.avatar_url) AS avatar_url,
           CASE
             WHEN lower(coalesce(p.username, '')) = v_query THEN 0
             WHEN lower(coalesce(p.display_name, '')) = v_query THEN 1
             WHEN lower(coalesce(p.alias, '')) = v_query THEN 2
             WHEN coalesce(p.player_number, '') = v_query THEN 2
             WHEN lower(coalesce(p.username, '')) LIKE v_query || '%' THEN 3
             WHEN lower(coalesce(p.display_name, '')) LIKE v_query || '%' THEN 4
             WHEN lower(coalesce(p.username, '')) LIKE '%' || v_query || '%'
               OR lower(coalesce(p.display_name, '')) LIKE '%' || v_query || '%'
               OR lower(coalesce(p.alias, '')) LIKE '%' || v_query || '%' THEN 5
             ELSE 6
           END AS relevance,
           greatest(
             similarity(lower(coalesce(p.username, '')), v_query),
             similarity(lower(coalesce(p.display_name, '')), v_query),
             similarity(lower(coalesce(p.alias, '')), v_query)
           ) AS match_score,
           -- Defaults are permissive, so a player with no preferences row keeps
           -- exactly the behaviour they had before this migration.
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
     WHERE lower(coalesce(p.username, '')) LIKE '%' || v_query || '%'
        OR lower(coalesce(p.display_name, '')) LIKE '%' || v_query || '%'
        OR lower(coalesce(p.alias, '')) LIKE '%' || v_query || '%'
        OR coalesce(p.player_number, '') = v_query
        -- Bare lower(col), no coalesce: this is the indexed expression.
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
       -- Opting out of discovery hides you from strangers, never from yourself
       -- or from the staff/agents who administer your account.
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
    -- Clubs whose NAME this response already discloses through a live game
    -- card. Treating them as visible in the affiliations panel is not a
    -- widening: it stops the panel claiming to withhold a club that the card
    -- beside it has just named.
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
        'hidden_count', coalesce(af.hidden_count, 0)
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
           WHERE ts.user_id = pg.id AND ts.left_at IS NULL AND pg.can_show_tables
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
      -- Club and union affiliations under disclosure rules. `visible` decides
      -- whether this specific viewer may learn that this player is in this
      -- club; hidden_count lets the UI say "2 Private Clubs Not Shown" without
      -- naming them.
      WITH club_rows AS (
        SELECT c.id AS club_uuid, c.club_id AS club_number, c.slug AS club_slug,
               c.name::text AS club_name, cm.role::text AS role,
               -- Matches ClubDiscovery.tsx: approval-gated OR not public.
               -- is_private is NOT consulted; see the header comment.
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
              -- Never offer to join a club that is not currently active.
              WHEN NOT cr.club_active THEN 'unavailable'
              WHEN cr.is_gated THEN 'request_join'
              ELSE 'join'
            END
          ) ORDER BY cr.club_name)
           FROM club_rows cr WHERE cr.visible) AS clubs,
        (SELECT jsonb_agg(DISTINCT jsonb_build_object(
            'union_id', u.id,
            'union_name', u.name::text,
            -- union_code is integer, code is text; both go out as text.
            'union_code', coalesce(u.union_code::text, u.code)
          ))
           FROM club_rows cr
           JOIN public.union_clubs uc ON uc.club_id = cr.club_uuid
           JOIN public.unions u ON u.id = uc.union_id
          WHERE cr.visible
            AND (coalesce(u.is_public, true)
                 OR EXISTS (SELECT 1 FROM viewer_unions vu WHERE vu.union_id = u.id))
        ) AS unions,
        (SELECT count(*) FROM club_rows cr WHERE NOT cr.visible) AS hidden_count
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

COMMENT ON FUNCTION public.fn_search_players(text, integer, integer, text, text, text) IS
  'Global safe player locator. Trigram fuzzy matching engages at three characters. Returns club/union affiliations under approval-gated disclosure rules, live cash and tournament seats with a membership-aware watch decision, honours player_search_preferences, and includes sensitive account contexts only where canonical club/union/downline authorization permits.';

-- Post-apply assertions. Each aborts the migration on its own violated
-- assumption rather than leaving a half-correct function in production.
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

  -- The bug this migration exists to fix. c.is_private is false on every club
  -- row in this database, so gating on it silently disclosed every
  -- approval-gated roster. Assert the dead flag never comes back.
  IF position('c.is_private' IN v_src) > 0 THEN
    RAISE EXCEPTION 'is_gated is keyed off the dead c.is_private flag again';
  END IF;
  IF position('AS is_gated' IN v_src) = 0 THEN
    RAISE EXCEPTION 'affiliations no longer compute is_gated';
  END IF;

  -- The index-defeating coalesce must not come back on the fuzzy predicate:
  -- the trigram indexes are on bare lower(username) / lower(display_name).
  IF position('lower(coalesce(p.username, '''')) %' IN v_src) > 0
     OR position('lower(coalesce(p.display_name, '''')) %' IN v_src) > 0 THEN
    RAISE EXCEPTION 'fuzzy predicate wraps a column in coalesce and cannot use the trigram index';
  END IF;
  IF position('lower(p.username) %' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fuzzy predicate lost its indexable username clause';
  END IF;

  IF position('player_search_preferences' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_search_players no longer reads player_search_preferences';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'idx_profiles_alias_trgm'
  ) THEN
    RAISE EXCEPTION 'idx_profiles_alias_trgm missing';
  END IF;
END;
$assert$;

COMMIT;
