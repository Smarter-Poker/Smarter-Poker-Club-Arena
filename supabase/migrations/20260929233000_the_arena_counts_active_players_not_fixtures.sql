-- 20260929233000_the_arena_counts_active_players_not_fixtures
--
-- Diamond Arena Phase 10, line 6. Applied once to kuklfnapbkmacvwxktbh.
--
-- Never apply between :50 and :03 of any hour (CLAUDE.md section 2 rule 8).
-- One transaction, as required by the same rule.
--
-- ═══ WHAT IS WRONG ════════════════════════════════════════════════════════
--
-- The Diamond Arena's one live figure, ACTIVE on its home card and its lobby
-- rail (Dan 2026-09-11: "JUST 'ACTIVE' AND THE NUMBER UNDER IT"), is read
-- from get_club_players_playing: distinct users with a live seat at a table
-- the lobby can see. It counts every such user, certification fixtures
-- included. The rulings decided who counts: "Fixture accounts are not
-- players; horses are" (docs/DIAMOND-RULINGS.md). The arena's own counts
-- reader (fn_diamond_arena_counts, 20260929214500) applies that rule to its
-- seated figure through fn_diamond_arena_seated_players; ACTIVE did not.
--
-- ═══ WHAT THIS DOES ═══════════════════════════════════════════════════════
--
-- 1. fn_diamond_arena_players_playing(p_club_id), new: the players with a
--    live seat at an open arena table, counted by
--    fn_diamond_arena_seated_players, so it is the same rule and the same
--    number as the Players page's "At Tables" (fixtures and deleted accounts
--    out, horses in). NULL for any club that is not the one arena. It is a
--    definer because the rule reads auth.users and ca_cert_accounts, which a
--    player cannot; signed-in players and the service role may call it.
-- 2. get_club_players_playing gains one branch, by asserted substitution with
--    the live md5 pinned and the reverse proved: a club whose asset is
--    diamonds answers from (1). The chip count below the branch is byte for
--    byte what it was, and a chip club never reaches the branch. The function
--    stays SECURITY INVOKER with its grants and comment as they were. A caller
--    without an account is refused, as before: the tables policy this count
--    reads through calls fn_union_oversees_club, which anon may not execute,
--    so the count already failed for a visitor on every club, and for the
--    arena it now fails one step earlier, at the new reader, which is not
--    granted to anon (the arena's counts reader refuses a visitor too).
--
-- The client does not change: the home card (HomePage) and the lobby rail
-- (ClubHomePage, first read and realtime refresh) already ask
-- get_club_players_playing, and the rail stays as Dan set it on 2026-09-11.
--
-- Nothing is written, nothing is priced, no switch is touched, no Diamond
-- moves, and neither function is on fn_ca_guard_watchlist().
--
-- PINNED LIVE md5(pg_get_functiondef(oid)), read 2026-09-29:
--   get_club_players_playing       d0deada158658ba9e1f88cbfba85c6ae
--
-- The substitution runs through EXECUTE, which the liveness check cannot see,
-- so it states its own proof:
-- @live-proof: (SELECT position('RETURN public.fn_diamond_arena_players_playing(v_club.id);' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'get_club_players_playing')

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. THE ARENA'S ACTIVE FIGURE
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_diamond_arena_players_playing(p_club_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  -- Players with a live seat at an open arena table, by the arena's seated
  -- rule (fixtures and deleted accounts out, horses in). NULL for any club
  -- that is not the one arena.
  SELECT CASE
           WHEN p_club_id IS NOT NULL AND p_club_id = public.fn_diamond_arena_club() THEN
             (SELECT count(*)::integer
                FROM public.fn_diamond_arena_seated_players(p_club_id) AS s(user_id))
         END;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_arena_players_playing(uuid) IS
  'The Diamond Arena''s ACTIVE figure (home card and lobby rail, through get_club_players_playing): players with a live seat at an open arena table, by the rule of fn_diamond_arena_counts'' seated figure (fixtures and deleted accounts out, horses in). NULL for any club that is not the arena. Migration 20260929233000_the_arena_counts_active_players_not_fixtures.';

REVOKE ALL ON FUNCTION public.fn_diamond_arena_players_playing(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_arena_players_playing(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. THE LOBBY COUNT ASKS IT FOR THE ARENA
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid := to_regprocedure('public.get_club_players_playing(text)');
  v_def text;
  v_n integer;
  v_old text := $f$  IF v_club.id IS NULL THEN
    RETURN NULL;
  END IF;
$f$;
  v_new text := $f$  IF v_club.id IS NULL THEN
    RETURN NULL;
  END IF;

  -- THE DIAMOND ARENA COUNTS PLAYERS, NOT FIXTURES (migration
  -- 20260929233000): "Fixture accounts are not players; horses are"
  -- (docs/DIAMOND-RULINGS.md). A diamonds club answers from the arena's own
  -- seated rule. A chip club never enters this branch.
  IF v_club.asset = 'diamonds' THEN
    RETURN public.fn_diamond_arena_players_playing(v_club.id);
  END IF;
$f$;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'get_club_players_playing(text) is missing';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'd0deada158658ba9e1f88cbfba85c6ae' THEN
    RAISE EXCEPTION 'get_club_players_playing is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'get_club_players_playing: the club-not-found clause occurs % times, expected 1', v_n;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> 'd0deada158658ba9e1f88cbfba85c6ae' THEN
    RAISE EXCEPTION 'get_club_players_playing: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 3. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_reader oid := to_regprocedure('public.fn_diamond_arena_players_playing(uuid)');
  v_lobby oid := to_regprocedure('public.get_club_players_playing(text)');
  v_branch constant text := 'RETURN public.fn_diamond_arena_players_playing(v_club.id);';
  v_def text;
  v_arena uuid := public.fn_diamond_arena_club();
  v_number text;
  v_counts jsonb;
  v_by_id integer;
  v_by_slug integer;
  v_by_number integer;
  v_chip uuid;
  v_bad text;
BEGIN
  IF v_reader IS NULL
     OR (SELECT count(*) FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace
            AND proname = 'fn_diamond_arena_players_playing') <> 1 THEN
    RAISE EXCEPTION 'fn_diamond_arena_players_playing(uuid) must exist exactly once';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_reader)
     OR has_function_privilege('anon', v_reader, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_reader, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_reader, 'EXECUTE') THEN
    RAISE EXCEPTION 'the ACTIVE reader must be a definer a signed-in player can call and a visitor cannot';
  END IF;

  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace AND proname = 'get_club_players_playing') <> 1
     OR (SELECT prosecdef FROM pg_proc WHERE oid = v_lobby)
     OR NOT has_function_privilege('anon', v_lobby, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_lobby, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_lobby, 'EXECUTE') THEN
    RAISE EXCEPTION 'get_club_players_playing must stay one invoker read with the grants it had';
  END IF;
  v_def := pg_get_functiondef(v_lobby);
  IF (length(v_def) - length(replace(v_def, v_branch, ''))) / length(v_branch) <> 1 THEN
    RAISE EXCEPTION 'get_club_players_playing does not ask the arena''s reader exactly once';
  END IF;

  IF v_arena IS DISTINCT FROM '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid THEN
    RAISE EXCEPTION 'the arena found (%) is not the Diamond Arena the client knows', v_arena;
  END IF;
  SELECT c.club_id::text INTO v_number FROM public.clubs c WHERE c.id = v_arena;
  v_counts := public.fn_diamond_arena_counts();
  v_by_id := public.get_club_players_playing(v_arena::text);
  v_by_slug := public.get_club_players_playing('diamond-arena');
  v_by_number := public.get_club_players_playing(v_number);
  IF jsonb_typeof(v_counts->'seated') IS DISTINCT FROM 'number'
     OR v_by_id IS DISTINCT FROM (v_counts->>'seated')::integer
     OR v_by_slug IS DISTINCT FROM v_by_id
     OR v_by_number IS DISTINCT FROM v_by_id THEN
    RAISE EXCEPTION 'ACTIVE (% by id, % by slug, % by number) is not the arena''s seated figure: %',
      v_by_id, v_by_slug, v_by_number, v_counts;
  END IF;
  SELECT c.id INTO v_chip FROM public.clubs c WHERE c.asset = 'chips' ORDER BY c.created_at LIMIT 1;
  IF v_chip IS NULL
     OR public.fn_diamond_arena_players_playing(v_chip) IS NOT NULL
     OR public.fn_diamond_arena_players_playing(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'the ACTIVE reader answered for a club that is not the arena';
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
  RAISE NOTICE 'the arena counts active players, not fixtures: ACTIVE % equals the seated figure %, nothing opened',
    v_by_id, v_counts->>'seated';
END $m$;

COMMIT;
