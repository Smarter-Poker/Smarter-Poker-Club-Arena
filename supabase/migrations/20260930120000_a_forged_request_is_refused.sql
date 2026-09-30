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
--   1. FOURTEEN DIAMOND STAFF DOORS TRUSTED A SIGNED-OUT TOKEN. This project
--      issues seven-day access tokens and PostgREST checks only a token's
--      signature and expiry, so signing out leaves a token the database still
--      accepts (Dan, 2026-09-03: a dead session moves no money). Five Phase 10
--      staff doors already ask fn_caller_session_is_live() after the staff
--      check. Fourteen did not: open a cash table, the three table-feature
--      switches, create a tournament, propose/approve/reject/settle a Diamond
--      correction, read the staff books, and read/review/trail/resolve the
--      incident board. A staff member's stolen or signed-out token could still
--      open tables, change them, create events, move corrections and close
--      incidents. Each door now asks the same question right after its staff
--      check and refuses with the same name the other five use,
--      diamond_staff_session_required (raised where the door raises, answered
--      where the door answers). The server (service_role) is the engine to
--      fn_caller_session_is_live(), so the two incident reads that admit it are
--      unchanged for it.
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
--   fn_poker_diamond_open_cash_table           2138b087d05ff2d955f094e386b79bc1
--   fn_poker_diamond_set_table_straddle        1c1fc8287aa28a9d5e32e26e0e65c902
--   fn_poker_diamond_set_table_run_it_twice    28245a7edbc2b9679075d1976553c817
--   fn_poker_diamond_set_table_bomb_pot        f2aab78a92d0728c7303f00394089a25
--   fn_poker_diamond_create_tournament         6a607f496ce39df2835a38f0bf6d62e8
--   fn_ca_diamond_adjustment_propose           b91c395cd31fa5eeeca43a3b841a6659
--   fn_ca_diamond_adjustment_approve           611f14b9610294426c7809414c52a216
--   fn_ca_diamond_adjustment_reject            56ff1a2e519d61965b10b9c6521106ba
--   fn_ca_diamond_adjustment_settle            50db88d01f931d157268d6adc033ac72
--   fn_ca_diamond_staff_books                  009790718e52c2038001ae6497c5e11c
--   fn_ca_diamond_incident_review              fbf3786814730bcb30353a6fe31731d9
--   fn_ca_diamond_incident_resolve_family      8345bdab05012dc989014a8455fecd26
--   fn_ca_diamond_incident_board               f95d591f4207b99d8bc2aa282ee3c318
--   fn_ca_diamond_incident_trail               a995c29a971a743460ad470a5dacbfbd
--   fn_wheel_host                              4f0e8d659cd213bc151b51f59acaa849
--   fn_wheel_can_operate                       8b9931f54b3bc41b791ef531cb2cb89e
--
-- @live-proof: (SELECT count(*) = 14 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('fn_poker_diamond_open_cash_table', 'fn_poker_diamond_set_table_straddle', 'fn_poker_diamond_set_table_run_it_twice', 'fn_poker_diamond_set_table_bomb_pot', 'fn_poker_diamond_create_tournament', 'fn_ca_diamond_adjustment_propose', 'fn_ca_diamond_adjustment_approve', 'fn_ca_diamond_adjustment_reject', 'fn_ca_diamond_adjustment_settle', 'fn_ca_diamond_staff_books', 'fn_ca_diamond_incident_review', 'fn_ca_diamond_incident_resolve_family', 'fn_ca_diamond_incident_board', 'fn_ca_diamond_incident_trail') AND position('fn_caller_session_is_live()' IN pg_get_functiondef(p.oid)) > 0 AND position('diamond_staff_session_required' IN pg_get_functiondef(p.oid)) > 0)
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
    ($f$fn_poker_diamond_open_cash_table$f$, $p$2138b087d05ff2d955f094e386b79bc1$p$,
     $o$  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE = '42501';
  END IF;$o$,
     $n$  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE = '42501';
  END IF;
  -- DIAMOND PHASE 11: a signed-out staff token moves nothing here either.
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';
  END IF;$n$),
    ($f$fn_poker_diamond_set_table_straddle$f$, $p$1c1fc8287aa28a9d5e32e26e0e65c902$p$,
     $o$ IF NOT public.fn_is_platform_admin() THEN
  RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE='42501';
 END IF;$o$,
     $n$ IF NOT public.fn_is_platform_admin() THEN
  RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE='42501';
 END IF;
 -- DIAMOND PHASE 11: a signed-out staff token moves nothing here either.
 IF NOT public.fn_caller_session_is_live() THEN
  RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';
 END IF;$n$),
    ($f$fn_poker_diamond_set_table_run_it_twice$f$, $p$28245a7edbc2b9679075d1976553c817$p$,
     $o$ IF NOT public.fn_is_platform_admin() THEN
  RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE='42501';
 END IF;$o$,
     $n$ IF NOT public.fn_is_platform_admin() THEN
  RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE='42501';
 END IF;
 -- DIAMOND PHASE 11: a signed-out staff token moves nothing here either.
 IF NOT public.fn_caller_session_is_live() THEN
  RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';
 END IF;$n$),
    ($f$fn_poker_diamond_set_table_bomb_pot$f$, $p$f2aab78a92d0728c7303f00394089a25$p$,
     $o$ IF NOT public.fn_is_platform_admin() THEN
  RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE='42501';
 END IF;$o$,
     $n$ IF NOT public.fn_is_platform_admin() THEN
  RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE='42501';
 END IF;
 -- DIAMOND PHASE 11: a signed-out staff token moves nothing here either.
 IF NOT public.fn_caller_session_is_live() THEN
  RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';
 END IF;$n$),
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
    ($f$fn_ca_diamond_adjustment_propose$f$, $p$b91c395cd31fa5eeeca43a3b841a6659$p$,
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
    ($f$fn_ca_diamond_adjustment_approve$f$, $p$611f14b9610294426c7809414c52a216$p$,
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
    ($f$fn_ca_diamond_adjustment_reject$f$, $p$56ff1a2e519d61965b10b9c6521106ba$p$,
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
    ($f$fn_ca_diamond_adjustment_settle$f$, $p$50db88d01f931d157268d6adc033ac72$p$,
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
    ($f$fn_ca_diamond_incident_review$f$, $p$fbf3786814730bcb30353a6fe31731d9$p$,
     $o$  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;$o$,
     $n$  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  -- DIAMOND PHASE 11: a signed-out staff token moves nothing here either.
  IF NOT public.fn_caller_session_is_live() THEN
    RETURN jsonb_build_object('success', false, 'error', 'diamond_staff_session_required');
  END IF;$n$),
    ($f$fn_ca_diamond_incident_resolve_family$f$, $p$8345bdab05012dc989014a8455fecd26$p$,
     $o$  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;$o$,
     $n$  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  -- DIAMOND PHASE 11: a signed-out staff token moves nothing here either.
  IF NOT public.fn_caller_session_is_live() THEN
    RETURN jsonb_build_object('success', false, 'error', 'diamond_staff_session_required');
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
    RETURN jsonb_build_object('success', false, 'error', 'diamond_staff_session_required');
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
    RETURN jsonb_build_object('success', false, 'error', 'diamond_staff_session_required');
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
  -- fn_ca_caller_is_management() also admits every club owner, every union
  -- owner and every incident recipient, which let any of them configure,
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
  r record; v_txt text; v_arena uuid; v_chip uuid; v_bad text;
BEGIN
  -- 1. every Diamond staff door asks for staff, then a live session, and names the refusal
  FOR r IN SELECT p.oid, p.proname, p.prosecdef FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('fn_poker_diamond_open_cash_table', 'fn_poker_diamond_set_table_straddle', 'fn_poker_diamond_set_table_run_it_twice', 'fn_poker_diamond_set_table_bomb_pot', 'fn_poker_diamond_create_tournament', 'fn_ca_diamond_adjustment_propose', 'fn_ca_diamond_adjustment_approve', 'fn_ca_diamond_adjustment_reject', 'fn_ca_diamond_adjustment_settle', 'fn_ca_diamond_staff_books', 'fn_ca_diamond_incident_review', 'fn_ca_diamond_incident_resolve_family', 'fn_ca_diamond_incident_board', 'fn_ca_diamond_incident_trail',
                                'fn_poker_diamond_edit_cash_table', 'fn_poker_diamond_close_cash_table',
                                'fn_poker_diamond_remove_tournament_player', 'fn_poker_diamond_cancel_tournament',
                                'fn_poker_diamond_create_seat_first_board')
  LOOP
    v_txt := pg_get_functiondef(r.oid);
    IF NOT r.prosecdef
       OR position('fn_is_platform_admin()' IN v_txt) = 0
       OR position('fn_caller_session_is_live()' IN v_txt) = 0
       OR position('diamond_staff_session_required' IN v_txt) = 0
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
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('fn_poker_diamond_open_cash_table', 'fn_poker_diamond_set_table_straddle', 'fn_poker_diamond_set_table_run_it_twice', 'fn_poker_diamond_set_table_bomb_pot', 'fn_poker_diamond_create_tournament', 'fn_ca_diamond_adjustment_propose', 'fn_ca_diamond_adjustment_approve', 'fn_ca_diamond_adjustment_reject', 'fn_ca_diamond_adjustment_settle', 'fn_ca_diamond_staff_books', 'fn_ca_diamond_incident_review', 'fn_ca_diamond_incident_resolve_family', 'fn_ca_diamond_incident_board', 'fn_ca_diamond_incident_trail',
                         'fn_poker_diamond_edit_cash_table', 'fn_poker_diamond_close_cash_table',
                         'fn_poker_diamond_remove_tournament_player', 'fn_poker_diamond_cancel_tournament',
                         'fn_poker_diamond_create_seat_first_board')) <> 19 THEN
    RAISE EXCEPTION 'expected nineteen Diamond staff doors';
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
  RAISE NOTICE 'a forged request is refused: fourteen staff doors now refuse a signed-out token, the Diamond Arena hosts no club games, and only platform staff operate another host''s games';
END $m$;
