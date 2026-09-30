-- ============================================================================
-- A FORGED REQUEST IS REFUSED
-- ============================================================================
--
-- Diamond Arena Phase 11, line 1: "Test cross-asset request forgery and
-- unauthorized membership/management access." Every door a caller can reach
-- was attacked (docs/evidence/diamond-phase-11/request-forgery-and-access.md).
-- Nearly all of them already refuse by name. Three holes did not, and none of
-- them needs an owner decision:
--
--   1. FOUR DIAMOND STAFF DOORS STILL TRUSTED A SIGNED-OUT TOKEN. This
--      project issues seven-day access tokens and PostgREST checks only a
--      token's signature and expiry, so signing out leaves a token the
--      database still accepts (Dan, 2026-09-03: a dead session moves no
--      money). Five Phase 10 staff doors asked fn_caller_session_is_live()
--      after their staff check; the attack found fourteen that did not, and
--      migration 20260930131500 (Phase 11 line 7, applied minutes before this
--      one) closed ten of them - the table doors, the correction doors and the
--      incident review and family doors. Four remained: creating a Diamond
--      tournament, and the three staff reads - the staff books (register,
--      trial balance, the correction queue with player names), the incident
--      board and an incident's trail. A signed-out or stolen staff token could
--      still create events and read the books for as long as it lived. The
--      estate already refuses a dead session a sensitive read (a player's own
--      buy-in and cash-out receipts), and a staff read is more sensitive than
--      those. Each of the four now asks the same question right after its
--      staff check, in the words its desk already uses:
--      diamond_staff_session_required (raised by the creation door, answered
--      by the books) and authentication_required (answered by the two incident
--      reads, as the incident review and family doors answer it). The server
--      (service_role) is the engine to fn_caller_session_is_live(), so the two
--      incident reads that admit it are unchanged for it. All nineteen staff
--      doors are asserted at the end.
--
--   2. THE DIAMOND ARENA COULD BE A CLUB-COMMERCE HOST. fn_wheel_host resolved
--      the arena's club id like any chip club, so every club-games door (wheel,
--      plinko, crash, crossing, mines, Diamond Spins, promo funding, owner
--      terms) accepted the arena as a host whose games pay chips and whose
--      entries go to the host owner. The arena has players only (Ruling 16) and
--      the client already never offers these games there. fn_wheel_host now
--      finds no host for a Diamond club, so each door answers as it does for
--      any club it cannot find. No arena host row exists today.
--
--   3. ANY CLUB OWNER COULD OPERATE ANY HOST'S GAMES. fn_wheel_can_operate
--      admitted fn_ca_caller_is_management(), which is true for every club
--      owner, every union owner and every incident recipient - not only
--      platform staff - so any of them could change another host's game
--      limits, fund its promo wallet from its bank and read its players and
--      P&L. The door's own refusal says "Only The Host Owner Or An Admin".
--      Operating another host is now platform staff (fn_is_platform_admin).
--      Today every member of that wider set is platform staff, so nobody who
--      operates a game now loses anything.
--
-- Every edit is an asserted substitution: the live md5 is pinned, the old
-- clause must occur exactly once, and the reverse substitution must reproduce
-- the pinned text. No grant, table, column or new function. Nothing opens a
-- Diamond switch; nothing moves a Diamond.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_poker_diamond_create_tournament         6a607f496ce39df2835a38f0bf6d62e8
--   fn_ca_diamond_staff_books                  009790718e52c2038001ae6497c5e11c
--   fn_ca_diamond_incident_board               f95d591f4207b99d8bc2aa282ee3c318
--   fn_ca_diamond_incident_trail               a995c29a971a743460ad470a5dacbfbd
--   fn_wheel_host                              4f0e8d659cd213bc151b51f59acaa849
--   fn_wheel_can_operate                       8b9931f54b3bc41b791ef531cb2cb89e
--
-- @live-proof: (SELECT count(*) = 4 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('fn_poker_diamond_create_tournament', 'fn_ca_diamond_staff_books', 'fn_ca_diamond_incident_board', 'fn_ca_diamond_incident_trail') AND position('fn_caller_session_is_live()' IN pg_get_functiondef(p.oid)) > 0 AND (position('diamond_staff_session_required' IN pg_get_functiondef(p.oid)) > 0 OR position('''authentication_required''' IN pg_get_functiondef(p.oid)) > 0))
-- @live-proof: (SELECT position('AND c.asset IS DISTINCT FROM ''diamonds''' IN pg_get_functiondef('public.fn_wheel_host(uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('fn_ca_caller_is_management' IN pg_get_functiondef('public.fn_wheel_can_operate(uuid,text,uuid)'::regprocedure)) = 0 AND position('IF public.fn_is_platform_admin() THEN RETURN true; END IF;' IN pg_get_functiondef('public.fn_wheel_can_operate(uuid,text,uuid)'::regprocedure)) > 0)
-- ============================================================================

DO $m$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'a Diamond switch is open; this migration expects both closed';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 1, 2 and 3: every edit, one asserted substitution each
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  r record; v_oid oid; v_def text; v_n integer;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ($f$fn_poker_diamond_create_tournament$f$, $p$6a607f496ce39df2835a38f0bf6d62e8$p$,
     $o$  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_tournament_staff_only' USING ERRCODE='42501';
  END IF;$o$,
     $n$  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_tournament_staff_only' USING ERRCODE='42501';
  END IF;
  -- DIAMOND PHASE 11: a signed-out staff token moves nothing here either.
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';
  END IF;$n$),
    ($f$fn_ca_diamond_staff_books$f$, $p$009790718e52c2038001ae6497c5e11c$p$,
     $o$  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'platform_staff_only');
  END IF;$o$,
     $n$  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'platform_staff_only');
  END IF;
  -- DIAMOND PHASE 11: a signed-out staff token moves nothing here either.
  IF NOT public.fn_caller_session_is_live() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'diamond_staff_session_required');
  END IF;$n$),
    ($f$fn_ca_diamond_incident_board$f$, $p$f95d591f4207b99d8bc2aa282ee3c318$p$,
     $o$  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;$o$,
     $n$  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  -- DIAMOND PHASE 11: a signed-out staff token moves nothing here either.
  IF NOT public.fn_caller_session_is_live() THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;$n$),
    ($f$fn_ca_diamond_incident_trail$f$, $p$a995c29a971a743460ad470a5dacbfbd$p$,
     $o$  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;$o$,
     $n$  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  -- DIAMOND PHASE 11: a signed-out staff token moves nothing here either.
  IF NOT public.fn_caller_session_is_live() THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;$n$),
    ($f$fn_wheel_host$f$, $p$4f0e8d659cd213bc151b51f59acaa849$p$,
     $o$    FROM public.clubs c WHERE c.id = p_club_id;$o$,
     $n$    FROM public.clubs c WHERE c.id = p_club_id
     -- DIAMOND PHASE 11: the Diamond Arena hosts no club games (players only,
     -- Ruling 16), so no club-commerce door can find it as a host.
     AND c.asset IS DISTINCT FROM 'diamonds';$n$),
    ($f$fn_wheel_can_operate$f$, $p$8b9931f54b3bc41b791ef531cb2cb89e$p$,
     $o$  IF public.fn_ca_caller_is_management() THEN RETURN true; END IF;$o$,
     $n$  -- DIAMOND PHASE 11: another host's games are operated by platform staff.
  -- The estate's wider management test also admits every club owner, every
  -- union owner and every incident recipient, which let any of them configure,
  -- fund and read the games of every other host.
  IF public.fn_is_platform_admin() THEN RETURN true; END IF;$n$)
  ) AS v(fn, pin, old, new)
  LOOP
    SELECT p.oid INTO STRICT v_oid FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.fn;
    v_def := pg_get_functiondef(v_oid);
    IF md5(v_def) <> r.pin THEN
      RAISE EXCEPTION '% is not the pinned text (md5 %, pinned %)', r.fn, md5(v_def), r.pin;
    END IF;
    v_n := (length(v_def) - length(replace(v_def, r.old, ''))) / length(r.old);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: the clause to change occurs % times, expected 1', r.fn, v_n;
    END IF;
    EXECUTE replace(v_def, r.old, r.new);
    IF md5(replace(pg_get_functiondef(v_oid), r.new, r.old)) <> r.pin THEN
      RAISE EXCEPTION '%: the reverse substitution does not reproduce the pinned text', r.fn;
    END IF;
  END LOOP;
END $m$;

-- ---------------------------------------------------------------------------
-- What must be true now
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  r record; v_txt text; v_arena uuid; v_chip uuid; v_bad text; v_n integer := 0;
BEGIN
  -- 1. every Diamond staff door asks for staff, then a live session, and names the
  --    refusal: the four this migration changes, the ten 20260930131500 changed
  --    and the five Phase 10 doors that always asked
  FOR r IN SELECT p.oid, p.proname, p.prosecdef FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('fn_poker_diamond_create_tournament', 'fn_ca_diamond_staff_books', 'fn_ca_diamond_incident_board', 'fn_ca_diamond_incident_trail',
                                'fn_poker_diamond_open_cash_table', 'fn_poker_diamond_set_table_straddle',
                                'fn_poker_diamond_set_table_run_it_twice', 'fn_poker_diamond_set_table_bomb_pot',
                                'fn_ca_diamond_adjustment_propose', 'fn_ca_diamond_adjustment_approve',
                                'fn_ca_diamond_adjustment_reject', 'fn_ca_diamond_adjustment_settle',
                                'fn_ca_diamond_incident_review', 'fn_ca_diamond_incident_resolve_family',
                                'fn_poker_diamond_edit_cash_table', 'fn_poker_diamond_close_cash_table',
                                'fn_poker_diamond_remove_tournament_player', 'fn_poker_diamond_cancel_tournament',
                                'fn_poker_diamond_create_seat_first_board')
  LOOP
    v_txt := pg_get_functiondef(r.oid);
    v_n := v_n + 1;
    IF NOT r.prosecdef
       OR position('fn_is_platform_admin()' IN v_txt) = 0
       OR position('fn_caller_session_is_live()' IN v_txt) = 0
       OR (position('diamond_staff_session_required' IN v_txt) = 0 AND position('''authentication_required''' IN v_txt) = 0)
       OR position('fn_caller_session_is_live()' IN v_txt) < position('fn_is_platform_admin()' IN v_txt) THEN
      RAISE EXCEPTION '% does not ask for staff and then a live session', r.proname;
    END IF;
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable without an account', r.proname;
    END IF;
    IF NOT has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is no longer reachable by a signed-in operator', r.proname;
    END IF;
  END LOOP;
  IF v_n <> 19 THEN
    RAISE EXCEPTION 'expected nineteen Diamond staff doors, found %', v_n;
  END IF;

  -- 2. the arena is no club-commerce host; a chip club still is
  SELECT c.id INTO STRICT v_arena FROM public.clubs c
   WHERE c.asset = 'diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL;
  IF EXISTS (SELECT 1 FROM public.fn_wheel_host(v_arena) h WHERE h.host_id IS NOT NULL) THEN
    RAISE EXCEPTION 'fn_wheel_host still finds the Diamond Arena as a host';
  END IF;
  SELECT c.id INTO v_chip FROM public.clubs c WHERE c.asset = 'chips' ORDER BY c.created_at LIMIT 1;
  IF v_chip IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fn_wheel_host(v_chip) h WHERE h.host_id IS NOT NULL) THEN
    RAISE EXCEPTION 'fn_wheel_host no longer finds a chip club';
  END IF;
  IF EXISTS (SELECT 1 FROM public.wheel_configs WHERE host_id = v_arena)
     OR EXISTS (SELECT 1 FROM public.diamond_game_configs WHERE host_id = v_arena)
     OR EXISTS (SELECT 1 FROM public.diamond_game_pools WHERE host_id = v_arena)
     OR EXISTS (SELECT 1 FROM public.diamond_spins_owner_consents WHERE host_id = v_arena) THEN
    RAISE EXCEPTION 'a club-commerce row names the Diamond Arena as its host';
  END IF;

  -- 3. another host's games are operated by platform staff only
  v_txt := pg_get_functiondef('public.fn_wheel_can_operate(uuid,text,uuid)'::regprocedure);
  IF position('fn_ca_caller_is_management' IN v_txt) > 0
     OR position('IF public.fn_is_platform_admin() THEN RETURN true; END IF;' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'fn_wheel_can_operate still admits more than platform staff to another host';
  END IF;
  IF has_function_privilege('anon', 'public.fn_wheel_can_operate(uuid,text,uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_wheel_can_operate(uuid,text,uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_wheel_can_operate is reachable from a browser';
  END IF;

  -- the switches stay off, the identity is whole, every watched guard is on its baseline
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
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
  RAISE NOTICE 'a forged request is refused: all nineteen Diamond staff doors refuse a signed-out token, the Diamond Arena hosts no club games, and only platform staff operate another host''s games';
END $m$;
