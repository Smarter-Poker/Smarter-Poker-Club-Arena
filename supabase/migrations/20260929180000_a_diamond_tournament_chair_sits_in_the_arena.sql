-- ============================================================================
-- A DIAMOND TOURNAMENT CHAIR SITS IN THE ARENA
-- ============================================================================
--
-- Phase 9 of the Diamond Arena programme. Found by the satellites rehearsal
-- on 2026-09-29 and proved the same day before this was written: no Diamond
-- tournament could be launched, and no Diamond Spin could fill a seat.
--
-- ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
--
-- The deferred seat guard (constraint zzz_diamond_seat_keeps_custody,
-- fn_poker_diamond_seat_keeps_custody, DEFERRABLE INITIALLY DEFERRED) asks
-- every live Diamond chair, at COMMIT, for custody held by the CHAIR'S club:
-- a tournament chair needs an active tournament_entry custody row with
-- arena_id = table_seats.club_id (P0812), a cash chair its cash_seat custody
-- row with the same arena_id. Custody is always held by the arena:
-- fn_poker_diamond_reserve writes arena_id = the table's club or the event's.
--
-- The door that writes a chair does not choose the chair's club. The stamp
-- trigger (trg_table_seats_stamp_club, fn_stamp_seat_club) overwrites it with
-- fn_seat_club_for_user, and that resolver knew only club_members. The Diamond
-- Arena has no membership rows by design (membership is automatic, and
-- fn_poker_guard_arena_structure refuses the insert), so the resolver answered
-- the player's oldest chip club, or no club at all:
--
--   * a player with no chip membership (349 of 361 human accounts today):
--     no club. Every launch chair (fn_ca_assign_tournament_player_seat_locked
--     passes the resolver's answer) and every seat-first chair (Spins,
--     fn_take_seat_and_buy_in passes none) failed P0812 at COMMIT. Late
--     registration and the Diamond cash door survived only because they pass
--     the arena and the stamp falls back to it.
--   * a player with a chip membership (12 of 361): the chip club. Every
--     Diamond chair failed at COMMIT, cash included
--     ('diamond_seat_and_custody_must_commit_together').
--
-- The before-insert guard (P0810) compares custody with the TABLE's club and
-- so passed. Only the deferred arm compares the chair's, and a rolled-back
-- rehearsal never reaches COMMIT, which is why no Phase 8 or 9 rehearsal saw
-- it. The proof (rolled back, 2026-09-29 18:04 UTC) launched a plain Diamond
-- MTT through the real doors and forced the commit after the seat assignment:
-- chair club none, entry custody held by the arena, refused with P0812 'A
-- Diamond Tournament Seat Must Hold Its Funded Entry'.
--
-- ── THE FIX, AT THE ONE PLACE EVERY CHAIR ASKS ─────────────────────────────
--
-- fn_seat_club_for_user answers the table's own club for a table whose club
-- plays in Diamonds - the predicate the Diamond seat guards themselves use
-- (clubs.asset = 'diamonds'). Every writer of a Diamond chair reaches it,
-- directly or through the stamp: the launch assignment (which also proves the
-- chair against it), late registration and a satellite seat into a running
-- target (fn_seat_late_registrant), the seat-first door, table balancing
-- (fn_move_tournament_player), the rebuy (process_tournament_rebuy), the
-- multi-day stage seat, and the Diamond cash door (fn_poker_diamond_buyin,
-- which already passes the arena and now keeps it for a member too). A Diamond
-- chair's club is the arena, the one system Diamond identity, which is the
-- club its custody is held by.
--
-- ── CHIP BEHAVIOUR IS UNCHANGED, BYTE FOR BYTE ─────────────────────────────
--
-- The edit is an asserted substitution: the live md5 is pinned, the anchor
-- occurs exactly once, and the reverse substitution reproduces the pinned
-- text. The new clause returns only for a table whose club's asset is
-- 'diamonds'; for every other table the function runs the text it ran before.
-- It is also proved on the live population as this applies: the pinned text is
-- kept as a session-temporary copy, and for every live chair (1,569 on
-- 2026-09-29, none of them Diamond) the copy and the new function must give
-- the same answer, with the chair's club as the preferred club and with none,
-- in one statement and so on one snapshot.
--
-- ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
--
-- It opens nothing: tournaments_enabled and cash_games_enabled are not touched
-- and stay false. No money moves and no row is written. No chair is repaired:
-- no seat has ever been written at an arena table (read 2026-09-29; asserted
-- below), so there is nothing to repair. No guard is weakened: the seat guards,
-- the stamp trigger and every door keep their text. No new function, table,
-- column or grant; the resolver keeps its owner, grants, volatility and
-- search_path. It is not a watched guard.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_seat_club_for_user(uuid,uuid,uuid)   c8300bf22e0130ab5dffde1508a98a75
--
-- @live-proof: position('A DIAMOND TOURNAMENT CHAIR SITS IN THE ARENA' in pg_get_functiondef('public.fn_seat_club_for_user(uuid,uuid,uuid)'::regprocedure)) > 0
--
-- Applied once to kuklfnapbkmacvwxktbh. Never reapply.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 0. NOTHING IS OPEN AND NO DIAMOND CHAIR EXISTS
-- ---------------------------------------------------------------------------
DO $m$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'an arena switch is already open; this migration expects both closed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.table_seats s
              WHERE s.table_id IN (SELECT t.id FROM public.tables t JOIN public.clubs c ON c.id = t.club_id
                                    WHERE c.asset = 'diamonds')) THEN
    RAISE EXCEPTION 'a seat exists at a Diamond table; this migration was written when none had ever been written';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 1. THE CHAIR ASKS THE ARENA
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid := 'public.fn_seat_club_for_user(uuid,uuid,uuid)'::regprocedure;
  v_def text; v_old text; v_new text; v_n integer;
  v_acl text; v_cfg text; v_secdef boolean; v_volatile "char";
  v_chairs integer; v_differ integer;
BEGIN
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'c8300bf22e0130ab5dffde1508a98a75' THEN
    RAISE EXCEPTION 'fn_seat_club_for_user is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'    FROM public.tables t WHERE t.id = p_table_id;\n'
        || E'  IF v_union IS NULL THEN\n';
  v_new := E'    FROM public.tables t WHERE t.id = p_table_id;\n'
        || E'  -- A DIAMOND TOURNAMENT CHAIR SITS IN THE ARENA (2026-09-29). A Diamond\n'
        || E'  -- chair''s money is custody held by the arena, and the deferred seat guard\n'
        || E'  -- (zzz_diamond_seat_keeps_custody: P0812 and its cash arm) matches that\n'
        || E'  -- custody to the chair''s club at COMMIT. Diamond membership is automatic\n'
        || E'  -- and has no club_members row, so the lookups below never find the arena:\n'
        || E'  -- they answered a chip club or none, and every Diamond chair was refused.\n'
        || E'  -- A table whose club plays in Diamonds seats every player in that club.\n'
        || E'  IF EXISTS (SELECT 1 FROM public.clubs c\n'
        || E'              WHERE c.id = v_table_club AND c.asset = ''diamonds'') THEN\n'
        || E'    RETURN v_table_club;\n'
        || E'  END IF;\n'
        || E'  IF v_union IS NULL THEN\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_seat_club_for_user: the table read occurs % times, expected 1', v_n;
  END IF;
  SELECT p.proacl::text, p.proconfig::text, p.prosecdef, p.provolatile
    INTO v_acl, v_cfg, v_secdef, v_volatile FROM pg_proc p WHERE p.oid = v_oid;

  -- The pinned text, kept for this session only, so the old and the new answer
  -- can be read side by side on one snapshot.
  v_n := (length(v_def) - length(replace(v_def, 'public.fn_seat_club_for_user(p_user_id uuid', '')))
         / length('public.fn_seat_club_for_user(p_user_id uuid');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_seat_club_for_user: the signature occurs % times, expected 1', v_n;
  END IF;
  EXECUTE replace(v_def, 'public.fn_seat_club_for_user(p_user_id uuid',
                         'pg_temp.fn_seat_club_for_user_as_pinned(p_user_id uuid');

  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> 'c8300bf22e0130ab5dffde1508a98a75' THEN
    RAISE EXCEPTION 'fn_seat_club_for_user: the reverse substitution does not reproduce the pinned text';
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM v_acl
     OR (SELECT p.proconfig::text FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM v_cfg
     OR (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM v_secdef
     OR (SELECT p.provolatile FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM v_volatile THEN
    RAISE EXCEPTION 'fn_seat_club_for_user changed its grants, settings, security or volatility';
  END IF;

  -- Every live chair gets the answer it got before.
  SELECT count(*),
         count(*) FILTER (
           WHERE public.fn_seat_club_for_user(s.user_id, s.table_id, s.club_id)
                   IS DISTINCT FROM pg_temp.fn_seat_club_for_user_as_pinned(s.user_id, s.table_id, s.club_id)
              OR public.fn_seat_club_for_user(s.user_id, s.table_id, NULL)
                   IS DISTINCT FROM pg_temp.fn_seat_club_for_user_as_pinned(s.user_id, s.table_id, NULL))
    INTO v_chairs, v_differ
    FROM public.table_seats s
   WHERE s.left_at IS NULL AND s.user_id IS NOT NULL;
  IF v_differ <> 0 THEN
    RAISE EXCEPTION 'fn_seat_club_for_user: % of % live chairs would change club', v_differ, v_chairs;
  END IF;
  RAISE NOTICE 'the chair asks the arena: % live chairs keep their answer', v_chairs;
END $m$;

-- ---------------------------------------------------------------------------
-- 2. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_txt text; v_bad text; v_arena uuid; v_table uuid; v_member uuid;
BEGIN
  v_txt := pg_get_functiondef('public.fn_seat_club_for_user(uuid,uuid,uuid)'::regprocedure);
  IF position('A DIAMOND TOURNAMENT CHAIR SITS IN THE ARENA' IN v_txt) = 0
     OR position('WHERE c.id = v_table_club AND c.asset = ''diamonds'') THEN' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the resolver does not seat a Diamond chair in its table''s club';
  END IF;
  -- The arena answers for a player with no membership and for one with a chip
  -- membership, at a Diamond cash table (read only).
  SELECT c.id INTO v_arena FROM public.clubs c
   WHERE c.asset = 'diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL;
  SELECT t.id INTO v_table FROM public.tables t WHERE t.club_id = v_arena ORDER BY t.id LIMIT 1;
  SELECT cm.user_id INTO v_member FROM public.club_members cm
   WHERE cm.status IN ('active','approved') AND cm.club_id <> v_arena ORDER BY cm.user_id LIMIT 1;
  IF v_table IS NOT NULL AND (
       public.fn_seat_club_for_user(v_member, v_table, NULL) IS DISTINCT FROM v_arena
    OR public.fn_seat_club_for_user(v_member, v_table, v_arena) IS DISTINCT FROM v_arena
    OR public.fn_seat_club_for_user(gen_random_uuid(), v_table, NULL) IS DISTINCT FROM v_arena) THEN
    RAISE EXCEPTION 'a Diamond chair does not resolve to the arena';
  END IF;
  -- The guards and the stamp keep their text.
  IF md5(pg_get_functiondef('public.fn_stamp_seat_club()'::regprocedure)) <> '467104f7e791b76328ce5e20b42ba81b' THEN
    RAISE EXCEPTION 'the seat stamp changed';
  END IF;
  IF has_function_privilege('anon', 'public.fn_seat_club_for_user(uuid,uuid,uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_seat_club_for_user is reachable without an account';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'this migration must not open an arena switch';
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
  RAISE NOTICE 'a Diamond tournament chair sits in the arena: every Diamond chair resolves to the arena, every chip chair keeps its answer, nothing opened';
END $m$;

COMMIT;
