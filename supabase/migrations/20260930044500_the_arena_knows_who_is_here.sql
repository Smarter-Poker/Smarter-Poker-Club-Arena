-- 20260930044500_the_arena_knows_who_is_here
--
-- Diamond Arena Phase 10, line 3: "Show real member/online/seated/table
-- counts with meaningful zero/error states". Applied once to
-- kuklfnapbkmacvwxktbh.
--
-- Never apply between :50 and :03 of any hour (CLAUDE.md section 2 rule 8).
-- One transaction, as required by the same rule.
--
-- ═══ WHAT IS WRONG ════════════════════════════════════════════════════════
--
-- fn_diamond_arena_counts (20260929214500) answers members, seated and open
-- tables from rows, and ONLINE from the one presence feed it was built on:
-- profiles.is_online with last_seen inside five minutes. Only World Hub
-- writes that feed (its messenger's fn_update_presence and its social page);
-- Club Arena writes neither column. So ONLINE is a number only while the
-- messenger can see the person asking, and a player who uses only the arena
-- reads it as Unavailable. Read on production 2026-09-30 at 04:22 UTC: no
-- player's last_seen is newer than 2026-09-27 18:34 UTC.
--
-- ═══ WHERE "WHO IS HERE" IS ALREADY KNOWN (read 2026-09-30) ═══════════════
--
-- 1. The engine's sockets. The engine keeps who is connected in memory, per
--    process (server/src/hub/ChannelHub.ts, transport/TableStateHub.ts), and
--    publishes only platform totals, on its unauthenticated /ws-metrics. The
--    arena's lobby never opens the channel socket (the wallet, cashier,
--    tournament and table pages do), and a club channel admits only an
--    account with a club_members row, which the arena's automatic members do
--    not have. At 04:22 UTC it reported 1 channel user. Not a source without
--    engine and client changes.
-- 2. A Realtime presence channel. None covers the arena: the client tracks
--    presence only for a table's observers, a friend's status and voice, and
--    presence lives in the Realtime server's memory, which SQL cannot read.
-- 3. The messenger's presence, above. It cannot see Club Arena, because Club
--    Arena does not write it; making it do so is a profiles write per player
--    per heartbeat.
-- 4. Supabase Realtime's own register of live table feeds,
--    realtime.subscription. Realtime writes a row for every table feed a
--    signed-in page holds open, carrying the claims of the account that
--    opened it, and deletes it when the page closes or the connection drops.
--    Every signed-in Club Arena page holds the player's own waitlist feed for
--    its whole visit (GlobalWaitlistListener, mounted in App.tsx), and every
--    page under the global header also holds the header's notifications and
--    messages feeds (useHeaderDataStore). So an account with a row there has
--    the platform open now. It exists, it is live, and reading it writes
--    nothing. At 04:22 UTC it held 25 feeds for 4 signed-in accounts, 1 of
--    them a player.
--
-- ═══ WHAT THIS DOES ═══════════════════════════════════════════════════════
--
-- fn_diamond_arena_counts is redefined in full with the same signature, the
-- same definer and the same grants; its live md5 is pinned. Members, tables
-- and seated are word for word what they were. ONLINE becomes the players
-- who are here right now by any of three live sources: a live Realtime feed
-- (4), the messenger's presence (3, the chip roster's rule) or a live seat at
-- an open arena table. It is counted over players (fn_diamond_arena_is_player:
-- fixtures and deleted accounts out, horses in) and returned as a number
-- only: no name or id leaves the function. The sources say who has the
-- platform open, not which club page they are looking at; every player is a
-- member of the arena, so for the arena that is who is online, the way a chip
-- roster counts a member online wherever they are.
--
-- The witness stays. The caller is online by definition, so if none of the
-- sources shows the caller they are not seeing where players are, and ONLINE
-- is NULL ('presence_not_reported') rather than an undercount. Without a
-- caller it is NULL ('no_caller_to_witness'); a read that fails is NULL with
-- its SQLSTATE. A page that asks before its own feeds have registered (a cold
-- load) asks once more a few seconds later (DiamondPlayersPage).
--
-- Nothing is written, nothing is priced, no switch is touched, no Diamond
-- moves, and the function is not on fn_ca_guard_watchlist().
--
-- PINNED LIVE md5(pg_get_functiondef(oid)), read 2026-09-30:
--   fn_diamond_arena_counts()      62640c4a82bd621861fc6d0b84d5dd86
--
-- @live-proof: (SELECT position('FROM realtime.subscription rs' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_diamond_arena_counts')

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. THE PIN
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_diamond_arena_counts()'::regprocedure)) INTO v_md5;
  IF v_md5 <> '62640c4a82bd621861fc6d0b84d5dd86' THEN
    RAISE EXCEPTION 'fn_diamond_arena_counts is not the pinned text (md5 %)', v_md5;
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 2. THE FOUR FIGURES
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_diamond_arena_counts()
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

  -- ONLINE: the players who are here right now by any of three live sources,
  -- none of which this function writes: a live Realtime table feed (a row in
  -- realtime.subscription, which Realtime keeps for every feed a signed-in
  -- page holds open and deletes when it closes), the messenger's presence,
  -- or a live seat at an open arena table. A number only while the sources
  -- can be seen working: the caller is online by definition, so if none of
  -- them shows the caller they are not seeing where players are, and any
  -- count they give is short by an unknown amount. Without a caller there is
  -- nobody to check them against.
  IF v_uid IS NULL THEN
    v_unknown := v_unknown || jsonb_build_object('online', 'no_caller_to_witness');
  ELSE
    BEGIN
      SELECT coalesce(bool_or(present.user_id = v_uid), false),
             count(*) FILTER (WHERE public.fn_diamond_arena_is_player(present.user_id))
        INTO v_witness, v_online
        FROM (
          SELECT CASE
                   WHEN rs.claims ->> 'sub' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   THEN (rs.claims ->> 'sub')::uuid
                 END AS user_id
            FROM realtime.subscription rs
           WHERE rs.claims ->> 'role' = 'authenticated'
          UNION
          SELECT pr.id
            FROM public.profiles pr
           WHERE coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes'
          UNION
          SELECT s.user_id
            FROM public.fn_diamond_arena_seated_players(v_arena) AS s(user_id)
        ) present
       WHERE present.user_id IS NOT NULL;
      IF NOT v_witness THEN
        v_online := NULL;
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
  'Diamond Arena members, online, seated and open tables. Each figure is a number or NULL when it cannot be told; unknown names the reason. Online counts the players with a live Realtime feed, the messenger''s presence or a live arena seat, and is NULL unless one of those shows the caller. Migrations 20260929214500_the_arena_counts_its_players and 20260930044500_the_arena_knows_who_is_here.';

-- ---------------------------------------------------------------------------
-- 3. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_counts_oid oid := to_regprocedure('public.fn_diamond_arena_counts()');
  v_src text;
  v_counts jsonb;
  v_members bigint;
  v_bad text;
BEGIN
  IF v_counts_oid IS NULL
     OR (SELECT count(*) FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace AND proname = 'fn_diamond_arena_counts') <> 1 THEN
    RAISE EXCEPTION 'fn_diamond_arena_counts() must exist exactly once';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_counts_oid)
     OR has_function_privilege('anon', v_counts_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_counts_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_counts_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'the counts reader must stay a definer a signed-in player can call and a visitor cannot';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_counts_oid;
  IF (length(v_src) - length(replace(v_src, 'FROM realtime.subscription rs', ''))) / length('FROM realtime.subscription rs') <> 1
     OR position('''presence_not_reported''' in v_src) = 0
     OR position('''no_caller_to_witness''' in v_src) = 0 THEN
    RAISE EXCEPTION 'the counts reader does not read the live feeds once behind the caller witness';
  END IF;

  -- The live feeds Online reads: the register exists and this definer can
  -- read it, and the two feeds every signed-in page holds are published.
  IF to_regclass('realtime.subscription') IS NULL
     OR NOT has_table_privilege('postgres', 'realtime.subscription', 'SELECT') THEN
    RAISE EXCEPTION 'realtime.subscription is missing or unreadable';
  END IF;
  IF (SELECT count(*) FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
         AND tablename IN ('table_waitlist', 'notifications')) <> 2 THEN
    RAISE EXCEPTION 'the waitlist and notifications feeds are not both published';
  END IF;

  -- Asked with no caller, the figures answer as before and online says why
  -- it cannot.
  IF public.fn_diamond_arena_club() IS DISTINCT FROM '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid THEN
    RAISE EXCEPTION 'the arena found (%) is not the Diamond Arena the client knows', public.fn_diamond_arena_club();
  END IF;
  v_counts := public.fn_diamond_arena_counts();
  SELECT count(*) INTO v_members FROM public.profiles pr WHERE public.fn_diamond_arena_is_player(pr.id);
  IF jsonb_typeof(v_counts->'members') IS DISTINCT FROM 'number'
     OR (v_counts->>'members')::bigint IS DISTINCT FROM v_members
     OR jsonb_typeof(v_counts->'tables') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_counts->'seated') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_counts->'online') IS DISTINCT FROM 'null'
     OR v_counts->'unknown'->>'online' IS DISTINCT FROM 'no_caller_to_witness' THEN
    RAISE EXCEPTION 'the counts did not answer as this migration states: %', v_counts;
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
  RAISE NOTICE 'the arena knows who is here: % members, % seated, % open tables; online reads the live feeds behind the caller witness',
    v_counts->>'members', v_counts->>'seated', v_counts->>'tables';
END $m$;

COMMIT;
