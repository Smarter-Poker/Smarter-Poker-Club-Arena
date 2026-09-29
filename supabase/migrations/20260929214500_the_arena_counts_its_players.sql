-- ============================================================================
-- THE ARENA COUNTS ITS PLAYERS
-- ============================================================================
-- @live-proof: (SELECT to_regprocedure('public.fn_diamond_arena_counts()') IS NOT NULL AND to_regprocedure('public.fn_diamond_arena_roster(text,text,jsonb,integer)') IS NOT NULL AND to_regprocedure('public.fn_diamond_arena_is_player(uuid)') IS NOT NULL)
--
-- Phase 10 of the Diamond Arena programme, line 3: "Show real
-- member/online/seated/table counts with meaningful zero/error states", and
-- the Players-page half of line 6: "Verify no agent panels, union menus, chip
-- metrics or synthetic players appear as real activity". Item 6 of the
-- ordered build list in docs/DIAMOND-PHASE-10-AUDIT-2026-09-21.md.
--
-- WHAT WAS TRUE BEFORE THIS (read on production 2026-09-29, 20:45 UTC):
--
--   * The arena's Players door opens the chip roster. Its summary read,
--     ca_club_members_summary, looks the viewer up in club_members with status
--     active or approved; the arena's one row has status automatic, so every
--     Diamond player is told the roster is for approved members only. Even
--     answered, that page is the chip roster: My Downline, Agents, Admins,
--     Fees 100+, Wallet Balance.
--   * Nothing counts the arena's members, who in it is online, who in it is
--     seated, or how many tables it has open. The chip readers answer a
--     structural 0 for it (fn_batch_club_realtime_member_counts,
--     fn_batch_club_realtime_active_counts, clubs.member_count).
--
-- WHO IS A PLAYER (fn_diamond_arena_is_player, the one place the rule lives)
--
--   Every account with a profile is a Diamond member: fn_poker_arena_context
--   grants the entitlement to any signed-in profile. Of those accounts:
--     - a certification fixture is not a player (docs/DIAMOND-RULINGS.md,
--       "Fixture accounts are not players; horses are"), read through the
--       estate's own predicate, fn_ca_is_fixture_account;
--     - a horse IS a player and counts like anyone (the same ruling, and
--       CLAUDE.md 10.5: a horse "COUNTS everywhere a human counts - player
--       counts ..."). Nothing here names horses, so nothing can leave them out;
--     - an account whose sign-in is deleted (auth.users.deleted_at) or whose
--       profile is closed (profiles.status 'deleted') cannot enter the arena
--       and is not a member. This matters today: 185 such profiles exist,
--       182 of them post-deploy and crest certification accounts (usernames
--       PostDeploy..., crest_cert_...) whose soft delete scrubbed the .invalid
--       address fn_ca_is_fixture_account recognises them by. Without this
--       clause they would count as 182 players who joined this week.
--   Read at 20:45 UTC: 1,369 profiles, 185 deleted sign-ins, 35 fixtures,
--   1,149 players (1,000 horses and 149 people), the audit's figure exactly.
--
-- THE FOUR FIGURES (fn_diamond_arena_counts), each a number or NULL
--
--   members  players, as above.
--   tables   open arena tables: status waiting or running, lifecycle not
--            closed, not deleted; cash and tournament tables alike.
--   seated   players with a live seat (left_at IS NULL) at an open arena table.
--   online   the chip roster's own rule (seated, or profiles.is_online with
--            last_seen inside five minutes), counted over players, and only
--            while the presence feed can be seen working. The caller is
--            online by definition (they are reading the page), so when the
--            feed does not show the caller it is not seeing where players
--            are, and the figure is NULL rather than an undercount. Read
--            today: the only writers of is_online and last_seen are World
--            Hub's messenger (fn_update_presence, through
--            /api/messenger/update-presence) and its social page; Club Arena
--            writes neither, and the newest person's last_seen is
--            2026-09-27 18:34 UTC. A player who only uses the arena therefore
--            reads Online as Unavailable, which is the truth.
--   A figure whose read fails is NULL and its reason is named under
--   `unknown`; the others still answer. Nothing here turns NULL into 0.
--
-- THE ROSTER (fn_diamond_arena_roster)
--
--   Players only, searchable by name, username or player number, filterable
--   to those at tables, ordered seated first, then online, then by name, and
--   paged by an opaque keyset cursor. A row carries the name, username,
--   avatar, player number and presence, and nothing else: no role, upline,
--   downline, fee, rake, wallet or chip field exists in it, and no field says
--   which players are horses (the chip roster's anonymity rule holds here).
--
-- New functions only. No chip or Diamond function is redefined, so nothing is
-- pinned; nothing is written, nothing is priced, no switch is touched.
-- Applied once to kuklfnapbkmacvwxktbh.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. THE ARENA, AND WHO PLAYS IN IT
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_diamond_arena_club()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  -- The one Diamond Arena, found the way the Diamond doors and
  -- fn_poker_arena_context find it. NULL unless there is exactly one: a count
  -- of the wrong club, or of one of two, is not the arena's count.
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(c.id))[1] END
    FROM public.clubs c
   WHERE c.asset = 'diamonds'
     AND c.is_platform IS TRUE
     AND c.union_id IS NULL
     AND c.lifecycle_status IS DISTINCT FROM 'retired'
     AND EXISTS (SELECT 1 FROM public.ca_arena_settings s WHERE s.club_id = c.id);
$fn$;

CREATE FUNCTION public.fn_diamond_arena_is_player(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  -- A profile whose sign-in is live and whose account is open, that is not a
  -- certification fixture. Horses are players and are not mentioned.
  SELECT EXISTS (
    SELECT 1
      FROM public.profiles pr
      JOIN auth.users u ON u.id = pr.id
     WHERE pr.id = p_user_id
       AND u.deleted_at IS NULL
       AND pr.status IS DISTINCT FROM 'deleted'
       AND NOT public.fn_ca_is_fixture_account(pr.id)
  );
$fn$;

-- ---------------------------------------------------------------------------
-- 2. ITS TABLES, AND WHO IS SEATED AT THEM
-- ---------------------------------------------------------------------------
-- Both take the club so the rule can be proved on a club that has live seats;
-- the readers only ever pass the arena.
CREATE FUNCTION public.fn_diamond_arena_open_tables(p_club_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT t.id
    FROM public.tables t
   WHERE t.club_id = p_club_id
     AND t.status IN ('waiting', 'running')
     AND t.lifecycle IS DISTINCT FROM 'closed'
     AND t.is_deleted IS NOT TRUE;
$fn$;

CREATE FUNCTION public.fn_diamond_arena_seated_players(p_club_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT DISTINCT ts.user_id
    FROM public.table_seats ts
   WHERE ts.table_id IN (SELECT o.id FROM public.fn_diamond_arena_open_tables(p_club_id) AS o(id))
     AND ts.left_at IS NULL
     AND ts.user_id IS NOT NULL
     AND public.fn_diamond_arena_is_player(ts.user_id);
$fn$;

REVOKE ALL ON FUNCTION public.fn_diamond_arena_club() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_diamond_arena_is_player(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_diamond_arena_open_tables(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_diamond_arena_seated_players(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_arena_club() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_arena_is_player(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_arena_open_tables(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_arena_seated_players(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. THE FOUR FIGURES
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_diamond_arena_counts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_arena uuid;
  v_members bigint;
  v_tables bigint;
  v_seated bigint;
  v_online bigint;
  v_witness boolean;
  v_unknown jsonb := '{}'::jsonb;
BEGIN
  IF v_uid IS NULL AND NOT v_service THEN
    RAISE EXCEPTION 'Authentication Required' USING ERRCODE = '28000';
  END IF;

  v_arena := public.fn_diamond_arena_club();
  IF v_arena IS NULL THEN
    RETURN jsonb_build_object(
      'members', NULL, 'online', NULL, 'seated', NULL, 'tables', NULL,
      'unknown', jsonb_build_object(
        'members', 'arena_not_identified', 'online', 'arena_not_identified',
        'seated', 'arena_not_identified', 'tables', 'arena_not_identified'),
      'as_of', now());
  END IF;

  -- Each figure is read on its own. A read that fails leaves that figure NULL
  -- with its reason and the other figures answering.
  BEGIN
    SELECT count(*) INTO v_members
      FROM public.profiles pr
     WHERE public.fn_diamond_arena_is_player(pr.id);
  EXCEPTION WHEN OTHERS THEN
    v_members := NULL;
    v_unknown := v_unknown || jsonb_build_object('members', 'read_failed_' || SQLSTATE);
  END;

  BEGIN
    SELECT count(*) INTO v_tables
      FROM public.fn_diamond_arena_open_tables(v_arena) AS o(id);
  EXCEPTION WHEN OTHERS THEN
    v_tables := NULL;
    v_unknown := v_unknown || jsonb_build_object('tables', 'read_failed_' || SQLSTATE);
  END;

  BEGIN
    SELECT count(*) INTO v_seated
      FROM public.fn_diamond_arena_seated_players(v_arena) AS s(user_id);
  EXCEPTION WHEN OTHERS THEN
    v_seated := NULL;
    v_unknown := v_unknown || jsonb_build_object('seated', 'read_failed_' || SQLSTATE);
  END;

  -- ONLINE: a number only while the presence feed can be seen working. The
  -- caller is online by definition; if the feed does not show them, it is not
  -- seeing where players are, and any count it gives is short by an unknown
  -- amount. Without a caller there is nobody to check the feed against.
  IF v_uid IS NULL THEN
    v_unknown := v_unknown || jsonb_build_object('online', 'no_caller_to_witness');
  ELSE
    BEGIN
      SELECT coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes'
        INTO v_witness
        FROM public.profiles pr
       WHERE pr.id = v_uid;
      IF coalesce(v_witness, false) THEN
        SELECT count(*) INTO v_online
          FROM (
            SELECT pr.id AS user_id
              FROM public.profiles pr
             WHERE coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes'
               AND public.fn_diamond_arena_is_player(pr.id)
            UNION
            SELECT s.user_id
              FROM public.fn_diamond_arena_seated_players(v_arena) AS s(user_id)
          ) present;
      ELSE
        v_unknown := v_unknown || jsonb_build_object('online', 'presence_not_reported');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_online := NULL;
      v_unknown := v_unknown || jsonb_build_object('online', 'read_failed_' || SQLSTATE);
    END;
  END IF;

  RETURN jsonb_build_object(
    'members', v_members,
    'online', v_online,
    'seated', v_seated,
    'tables', v_tables,
    'unknown', v_unknown,
    'as_of', now());
END;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_arena_counts() IS
  'Diamond Arena members, online, seated and open tables. Each figure is a number or NULL when it cannot be told; unknown names the reason. Online is NULL unless the presence feed shows the caller. Migration 20260929214500_the_arena_counts_its_players.';

REVOKE ALL ON FUNCTION public.fn_diamond_arena_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_arena_counts() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. THE ROSTER
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_diamond_arena_roster(
  p_search text DEFAULT '',
  p_filter text DEFAULT 'all',
  p_cursor jsonb DEFAULT NULL,
  p_limit integer DEFAULT 80
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_arena uuid;
  v_search text := lower(left(btrim(coalesce(p_search, '')), 120));
  v_filter text := lower(coalesce(nullif(btrim(p_filter), ''), 'all'));
  v_limit integer := greatest(20, least(coalesce(p_limit, 80), 200));
  v_cursor jsonb := p_cursor;
  v_out jsonb;
BEGIN
  IF v_uid IS NULL AND NOT v_service THEN
    RAISE EXCEPTION 'Authentication Required' USING ERRCODE = '28000';
  END IF;
  v_arena := public.fn_diamond_arena_club();
  IF v_arena IS NULL THEN
    RAISE EXCEPTION 'The Diamond Arena Could Not Be Identified' USING ERRCODE = 'P0002';
  END IF;
  IF v_filter NOT IN ('all', 'seated') THEN
    v_filter := 'all';
  END IF;

  -- A cursor belongs to one search and one filter. One that does not match,
  -- or that is malformed, restarts from the top instead of skipping rows.
  IF v_cursor IS NOT NULL AND (
       jsonb_typeof(v_cursor) IS DISTINCT FROM 'object'
    OR coalesce(v_cursor->>'v', '') <> 'd1'
    OR coalesce(v_cursor->>'search', '') <> md5(v_search)
    OR coalesce(v_cursor->>'filter', '') <> v_filter
    OR coalesce(v_cursor->>'presence', '') !~ '^[0-2]$'
    OR jsonb_typeof(v_cursor->'name') IS DISTINCT FROM 'string'
    OR coalesce(v_cursor->>'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    v_cursor := NULL;
  END IF;

  WITH seated AS MATERIALIZED (
    SELECT s.user_id
      FROM public.fn_diamond_arena_seated_players(v_arena) AS s(user_id)
  ), rows AS MATERIALIZED (
    SELECT x.*,
           lower(x.alias) AS sort_name,
           CASE WHEN x.is_seated THEN 2 WHEN x.is_online THEN 1 ELSE 0 END AS presence_rank
      FROM (
        SELECT pr.id AS user_id,
               coalesce(nullif(btrim(pr.alias), ''), nullif(btrim(pr.display_name), ''),
                        pr.username, 'Unknown')::text AS alias,
               coalesce(pr.username, '')::text AS username,
               coalesce(nullif(pr.arena_avatar_url, ''), pr.avatar_url)::text AS avatar_url,
               pr.player_number::text AS player_number,
               (s.user_id IS NOT NULL) AS is_seated,
               (s.user_id IS NOT NULL)
                 OR (coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes')
                 AS is_online
          FROM public.profiles pr
          LEFT JOIN seated s ON s.user_id = pr.id
         WHERE public.fn_diamond_arena_is_player(pr.id)
           AND (v_filter <> 'seated' OR s.user_id IS NOT NULL)
      ) x
     WHERE v_search = ''
        OR position(v_search IN lower(x.alias)) > 0
        OR position(v_search IN lower(x.username)) > 0
        OR position(v_search IN lower(coalesce(x.player_number, ''))) > 0
  ), page AS MATERIALIZED (
    SELECT r.*,
           row_number() OVER (ORDER BY r.presence_rank DESC, r.sort_name ASC, r.user_id ASC) AS rn
      FROM rows r
     WHERE v_cursor IS NULL
        OR r.presence_rank < (v_cursor->>'presence')::integer
        OR (r.presence_rank = (v_cursor->>'presence')::integer
            AND (r.sort_name, r.user_id) > (v_cursor->>'name', (v_cursor->>'id')::uuid))
     ORDER BY r.presence_rank DESC, r.sort_name ASC, r.user_id ASC
     LIMIT v_limit + 1
  )
  SELECT jsonb_build_object(
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'user_id', p.user_id,
               'alias', p.alias,
               'username', p.username,
               'avatar_url', p.avatar_url,
               'player_number', p.player_number,
               'is_seated', p.is_seated,
               'is_online', p.is_online) ORDER BY p.rn)
        FROM page p
       WHERE p.rn <= v_limit), '[]'::jsonb),
    'has_more', (SELECT count(*) FROM page) > v_limit,
    'next_cursor', (
      SELECT jsonb_build_object('v', 'd1', 'search', md5(v_search), 'filter', v_filter,
                                'presence', p.presence_rank, 'name', p.sort_name, 'id', p.user_id)
        FROM page p
       WHERE p.rn = v_limit
         AND (SELECT count(*) FROM page) > v_limit),
    'filtered_total', (SELECT count(*) FROM rows),
    'query', jsonb_build_object('filter', v_filter)
  ) INTO v_out;

  RETURN v_out;
END;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_arena_roster(text, text, jsonb, integer) IS
  'Diamond Arena players (fixtures and deleted accounts out, horses in): name, username, avatar, player number and presence only. Filters all and seated. Migration 20260929214500_the_arena_counts_its_players.';

REVOKE ALL ON FUNCTION public.fn_diamond_arena_roster(text, text, jsonb, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_arena_roster(text, text, jsonb, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  r record;
  v_n integer;
  v_bad text;
  v_counts jsonb;
  v_all jsonb;
  v_seated jsonb;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('fn_diamond_arena_club', 'fn_diamond_arena_is_player',
                       'fn_diamond_arena_open_tables', 'fn_diamond_arena_seated_players',
                       'fn_diamond_arena_counts', 'fn_diamond_arena_roster');
  IF v_n <> 6 THEN
    RAISE EXCEPTION 'expected the six arena count functions exactly once each, found %', v_n;
  END IF;

  FOR r IN SELECT p.oid, p.proname, p.prosecdef
             FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('fn_diamond_arena_club', 'fn_diamond_arena_is_player',
                                'fn_diamond_arena_open_tables', 'fn_diamond_arena_seated_players',
                                'fn_diamond_arena_counts', 'fn_diamond_arena_roster')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable without an account', r.proname;
    END IF;
    IF r.proname IN ('fn_diamond_arena_counts', 'fn_diamond_arena_roster') THEN
      IF NOT r.prosecdef OR NOT has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
        RAISE EXCEPTION '% must be a definer reader a signed-in player can call', r.proname;
      END IF;
    ELSIF r.prosecdef OR has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is an internal rule and must not be a player door', r.proname;
    END IF;
  END LOOP;

  IF public.fn_diamond_arena_club() IS DISTINCT FROM '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid THEN
    RAISE EXCEPTION 'the arena found (%) is not the Diamond Arena the client knows', public.fn_diamond_arena_club();
  END IF;

  -- Asked with no caller, the figures answer and online says why it cannot.
  v_counts := public.fn_diamond_arena_counts();
  IF jsonb_typeof(v_counts->'members') IS DISTINCT FROM 'number' OR (v_counts->>'members')::bigint < 1
     OR jsonb_typeof(v_counts->'tables') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_counts->'seated') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_counts->'online') IS DISTINCT FROM 'null'
     OR v_counts->'unknown'->>'online' IS DISTINCT FROM 'no_caller_to_witness' THEN
    RAISE EXCEPTION 'the counts did not answer as this migration states: %', v_counts;
  END IF;
  v_all := public.fn_diamond_arena_roster('', 'all', NULL, 20);
  v_seated := public.fn_diamond_arena_roster('', 'seated', NULL, 20);
  IF (v_all->>'filtered_total')::bigint IS DISTINCT FROM (v_counts->>'members')::bigint
     OR (v_seated->>'filtered_total')::bigint IS DISTINCT FROM (v_counts->>'seated')::bigint THEN
    RAISE EXCEPTION 'the roster (% players, % seated) disagrees with the counts %',
      v_all->>'filtered_total', v_seated->>'filtered_total', v_counts;
  END IF;

  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open a Diamond switch';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'the arena counts its players: % members, % seated, % open tables; online asks the caller',
    v_counts->>'members', v_counts->>'seated', v_counts->>'tables';
END $m$;
