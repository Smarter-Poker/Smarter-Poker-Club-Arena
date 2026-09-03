-- ============================================================================
-- THE ARENA NAME IS THE ALIAS - IN SQL TOO
--
-- Dan, 2026-09-02: "THE CLUB ARENA SHOULD ALWAYS 100% OF THE TIME USE THE
-- POKER ALIAS AND NOT THE REAL NAME, THE REAL NAME IS USED IN THE WORLD HUB."
--
-- WHY THIS MIGRATION EXISTS
--
-- src/utils/playerDisplayName.ts settled this question for the client on
-- 2026-08-23. Postgres never got the memo, and it had grown THREE separate
-- resolvers that disagreed with each other and with the client:
--
--   fn_hg_caller_display_name   display_name -> full_name -> username
--   fn_notify_display_name      username     -> full_name
--   fn_player_display_name      (use_real_name ? display_name) -> alias
--                               -> username -> display_name
--
-- The first two name `full_name` explicitly as a fallback, so a home-game
-- roster or a dispute notification could print a player's legal name outright.
--
-- WHAT IT WAS COSTING, measured before this ran
--
--   * 18,873 rows of tournament_players.username hold a value equal to that
--     player's full_name. That column is DENORMALISED by
--     trg_tournament_player_name and is what a tournament lobby and a results
--     screen render, so those are real names already on real screens.
--   * fn_search_players searches alias but EMITS display_name and never emits
--     alias at all, so the Find Player modal answered every query with real
--     names.
--   * 0 of 1,308 profiles have use_real_name = true. Nobody opted in to any
--     of it.
--
-- THIS REVERSES ONE EARLIER DECISION, deliberately.
-- 20260823020000_tournament_player_name_respects_alias.sql added the
-- `use_real_name ? display_name` branch at the top of fn_player_display_name,
-- to honour the setting. The client resolver written the same day does the
-- opposite and is pinned that way ("ignores the legacy use_real_name boolean
-- at the table"), because choosing to show your real name on a social profile
-- is not consent to have it printed beside your stack. Dan's 2026-09-02
-- instruction settles it in the client's favour: in the arena, always the
-- alias. The branch is dropped so the two halves of the platform stop
-- disagreeing. No live row is affected either way - the flag is false
-- everywhere.
--
-- WHAT THIS DOES
--
-- One resolver, public.fn_arena_name, mirroring the client's arena branch
-- exactly: alias -> username -> display_name (only when it is not the real
-- name) -> 'Player'. The three legacy functions become thin wrappers over it,
-- so every existing caller is corrected without being rewritten, and
-- fn_search_players emits it.
--
-- HORSES ARE INCLUDED, deliberately (CLAUDE.md 10.5). All 1,000 horse rows
-- carry an alias that differs from their display_name, so this renames them
-- from person-shaped seed names ("Drake Dunmore") to poker handles
-- ("SqueezeWardenNine"). That is the point: if humans moved to handles and
-- horses stayed on person-names, "has a first and last name" would become a
-- perfect horse tell at every table. Identical treatment, not equivalent.
--
-- THE ONE RESIDUAL CASE, stated rather than hidden: 3 profiles have no alias,
-- no usable display_name, and a username that IS their full_name, so the
-- handle step still returns a real name for them. All 3 are dormant - none
-- seated, none with a tournament row. Suppressing the username there would
-- render them nameless while the app still prints "@username" beside search
-- results and on profiles, which is an inconsistency rather than a privacy
-- gain. Left as-is, on purpose, and asserted below so the number cannot grow
-- quietly.
--
-- DDL POLICY (CLAUDE.md, 2026-08-31): every statement below is inside ONE
-- transaction so PostgREST coalesces the schema-cache reloads into a single
-- ~28s rebuild instead of one per function. The tournament_players backfill
-- is DML and ships as a SEPARATE migration so this one does not hold a write
-- lock on a 245k-row table across a schema reload.
--
-- ROLLBACK: this migration only replaces function bodies; nothing is dropped
-- and no column changes. To revert, re-apply
-- 20260823020000_tournament_player_name_respects_alias.sql (restores
-- fn_player_display_name) and restore fn_hg_caller_display_name /
-- fn_notify_display_name / fn_search_players from their definitions quoted at
-- the top of this file and in docs/changelog/2026-09-02-the-arena-is-always-the-alias.md.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- The one resolver. Takes columns rather than a uuid so it can be used inline
-- in a query without a correlated subquery per row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_arena_name(
  p_alias        text,
  p_username     text,
  p_display_name text,
  p_first_name   text,
  p_last_name    text,
  p_full_name    text
) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  WITH real_name AS (
    SELECT COALESCE(
             NULLIF(btrim(p_full_name), ''),
             NULLIF(btrim(concat_ws(' ',
               NULLIF(btrim(p_first_name), ''),
               NULLIF(btrim(p_last_name),  ''))), '')
           ) AS rn
  )
  SELECT COALESCE(
           NULLIF(btrim(p_alias), ''),
           NULLIF(btrim(p_username), ''),
           -- display_name has no owner: it has held seed data, a horse's name,
           -- a chosen nickname, and an exact copy of full_name. Allowed through
           -- only when it is demonstrably not the real name.
           CASE
             WHEN NULLIF(btrim(p_display_name), '') IS NOT NULL
              AND (SELECT rn FROM real_name) IS NOT NULL
              AND lower(btrim(p_display_name)) = lower((SELECT rn FROM real_name))
             THEN NULL
             ELSE NULLIF(btrim(p_display_name), '')
           END,
           'Player')
$function$;

COMMENT ON FUNCTION public.fn_arena_name(text, text, text, text, text, text) IS
  'The Club Arena name: alias -> username -> display_name (never when it is the '
  'real name) -> Player. Mirrors src/utils/playerDisplayName.ts arena branch. '
  'Dan 2026-09-02: the arena is always the poker alias; the real name lives in '
  'the World Hub.';

-- ---------------------------------------------------------------------------
-- The three legacy resolvers become wrappers, so their callers are fixed
-- without being touched: trg_tournament_player_name, fn_notify_credit_request,
-- fn_notify_dispute, rpc_hg_claim_seat, rpc_hg_list_roster,
-- rpc_hg_list_tables_and_reservations, rpc_hg_start_table,
-- fn_home_game_unseated_confirmed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_player_display_name(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.fn_arena_name(p.alias, p.username, p.display_name,
                              p.first_name, p.last_name, p.full_name)
    FROM public.profiles p
   WHERE p.id = p_user_id;
$function$;

CREATE OR REPLACE FUNCTION public.fn_hg_caller_display_name(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT public.fn_arena_name(p.alias, p.username, p.display_name,
                              p.first_name, p.last_name, p.full_name)
    FROM public.profiles p
   WHERE p.id = p_user_id
   LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION public.fn_notify_display_name(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  -- Keeps its own 'Someone' voice for notification copy, but never reaches
  -- for full_name to get there.
  SELECT COALESCE(
           NULLIF(public.fn_arena_name(p.alias, p.username, p.display_name,
                                       p.first_name, p.last_name, p.full_name),
                  'Player'),
           'Someone')
    FROM public.profiles p
   WHERE p.id = p_user_id;
$function$;

-- ---------------------------------------------------------------------------
-- Find Player: searched on alias, answered with the real name.
--
-- Only three things change from the definition that was live before this ran:
-- `matched` computes arena_name, the payload emits it in place of
-- display_name, and the name sort orders by it. The WHERE clause still matches
-- on display_name so a staff member who types a real name still finds the
-- account - searching is a lookup, displaying is a disclosure.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_search_players(
  p_query text,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_scope text DEFAULT 'all'::text,
  p_presence text DEFAULT 'all'::text,
  p_sort text DEFAULT 'relevance'::text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
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
           public.fn_arena_name(p.alias, p.username, p.display_name,
                                p.first_name, p.last_name, p.full_name) AS arena_name,
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
       CASE WHEN p_sort = 'name' THEN lower(coalesce(arena_name, username, '')) END,
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
      'display_name', arena_name,
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
$function$;

-- ---------------------------------------------------------------------------
-- Assertions. This migration aborts rather than half-applying.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_leaks integer;
  v_horses integer;
BEGIN
  -- The alias always wins.
  IF public.fn_arena_name('KingFish', 'kingfish', 'Dan Bekavac', 'Dan', 'Bekavac', 'Dan Bekavac')
     IS DISTINCT FROM 'KingFish' THEN
    RAISE EXCEPTION 'fn_arena_name did not prefer the alias';
  END IF;

  -- display_name is refused when it IS the real name, whatever its case.
  IF public.fn_arena_name(NULL, NULL, 'jane doe', NULL, NULL, 'Jane Doe')
     IS DISTINCT FROM 'Player' THEN
    RAISE EXCEPTION 'fn_arena_name leaked a real name through display_name';
  END IF;

  -- ...and assembled from first/last, not only full_name.
  IF public.fn_arena_name(NULL, NULL, 'Jane Doe', 'Jane', 'Doe', NULL)
     IS DISTINCT FROM 'Player' THEN
    RAISE EXCEPTION 'fn_arena_name leaked a real name assembled from first/last';
  END IF;

  -- A nickname that is not the real name still shows.
  IF public.fn_arena_name(NULL, NULL, 'Shortstack', NULL, NULL, 'Jane Doe')
     IS DISTINCT FROM 'Shortstack' THEN
    RAISE EXCEPTION 'fn_arena_name suppressed a legitimate nickname';
  END IF;

  -- Across the real table, the only rows still resolving to a real name are
  -- the 3 documented above: no alias, no usable display_name, username IS the
  -- full name. If that count grows, something upstream changed and this
  -- migration should not land silently on top of it.
  SELECT count(*) INTO v_leaks
    FROM public.profiles p
   WHERE nullif(btrim(p.full_name), '') IS NOT NULL
     AND lower(public.fn_arena_name(p.alias, p.username, p.display_name,
                                    p.first_name, p.last_name, p.full_name))
         = lower(btrim(p.full_name));
  IF v_leaks > 3 THEN
    RAISE EXCEPTION 'fn_arena_name still returns a real name for % profiles (expected at most 3)', v_leaks;
  END IF;

  -- Every horse resolves to its handle, so no seat is identifiable by the
  -- shape of its name (CLAUDE.md 10.5).
  SELECT count(*) INTO v_horses
    FROM public.profiles p
   WHERE p.is_horse
     AND public.fn_arena_name(p.alias, p.username, p.display_name,
                              p.first_name, p.last_name, p.full_name)
         IS DISTINCT FROM btrim(p.alias);
  IF v_horses > 0 THEN
    RAISE EXCEPTION '% horses do not resolve to their alias', v_horses;
  END IF;
END $$;

COMMIT;
