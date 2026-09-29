-- ============================================================================
-- STAFF RUN A DIAMOND GAME, ON THE RECORD
-- ============================================================================
--
-- Phase 10 of the Diamond Arena programme, line 4 (staff-only game
-- configuration): item 4 of the ordered build list in
-- docs/DIAMOND-PHASE-10-AUDIT-2026-09-21.md, and the seat-first gap found on
-- 2026-09-29. Before this migration nobody, staff included, could edit or close
-- a Diamond cash table, cancel a Diamond event or remove a player from one
-- through a door a signed-in person can reach; a heads-up Diamond sit-and-go
-- could be created but never sat, because nothing opened its table; and none
-- of the five Diamond configuration doors left a trace of who used it.
--
-- What changes:
--
--   1. ONE AUDIT HOME. Every Diamond configuration door files exactly one row
--      in admin_audit_log through the estate's single entry point,
--      fn_log_admin_action: the actor (admin_user_id, and actor_role as it
--      was), the action (diamond.*), the target (diamond_table or
--      diamond_tournament), the row before and the row after, and which
--      columns changed. The audit named two homes. table_settings_changes
--      cannot hold an event (its table_id is required and an MTT has no
--      table); admin_audit_log holds tables and events alike, is what the
--      operator console already writes, and platform staff can already read
--      it (admin_audit_log_admin_select).
--   2. THE FIVE DOORS THAT EXIST go on the record. The four table doors
--      (fn_poker_diamond_open_cash_table, which also stamps tables.created_by,
--      and the straddle, run-it-twice and bomb-pot doors) are pinned and
--      redefined in full with the same signature. fn_poker_diamond_create_tournament
--      is shared with other work, so it changes by asserted substitution
--      only: each of its two answers (the Spin branch and the rest) passes
--      through fn_poker_diamond_audit_tournament_created on the way out, and
--      nothing else in it moves.
--   3. FIVE NEW PLATFORM-STAFF DOORS, each asking fn_is_platform_admin() and
--      a live session (as the chip operator doors ask fn_caller_session_is_live):
--        fn_poker_diamond_edit_cash_table - an EMPTY table's name, stakes,
--          buy-ins and seats, held to the open door's rules and the creation
--          guard's, and re-proved by fn_poker_diamond_plain_cash_table;
--        fn_poker_diamond_close_cash_table - refused while any seat holds
--          custody or a player sits;
--        fn_poker_diamond_remove_tournament_player - through
--          fn_ca_unregister_tournament_player_exact, whose Diamond branch
--          already sends the entry home from its own custody row;
--        fn_poker_diamond_cancel_tournament - onto the existing Diamond
--          cancellation, fn_poker_diamond_tournament_cancel, which returns
--          every entry and writes the immutable receipt naming the operator;
--        fn_poker_diamond_create_seat_first_board - a Spin or a heads-up
--          sit-and-go: the event through the Diamond creation door and its
--          one joinable table in the same transaction, as
--          fn_create_seat_first_game_atomic opens a chip board.
--   4. THE MANAGED LIFECYCLE GUARD (fn_guard_managed_game_lifecycle) admits a
--      cancellation after registration from the engine only. It now also
--      admits the one event fn_poker_diamond_cancel_tournament names, in that
--      door's own transaction, through a transaction-local setting; every
--      other caller meets the same refusal as before. Asserted substitution.
--
-- fn_can_create_games is not touched (widening it would hand Diamond games to
-- club roles and undo Phase 2) and is asserted unchanged at the end. Staff
-- lobby posting stays refused (Dan's decision 4). Both switches stay false.
-- Nothing is priced: every number a door writes is one staff enter or one the
-- existing doors already derive. A Diamond Spin is still refused at creation
-- until a reserve source is authorized; the board door changes nothing there.
-- Applied once to kuklfnapbkmacvwxktbh.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_poker_diamond_open_cash_table          f45465677a693da31100898b465b8210
--   fn_poker_diamond_set_table_straddle       ce002ad2be7891a84f489d58a1db24f9
--   fn_poker_diamond_set_table_run_it_twice   6ff7bcb1b51da39d7f1f998605b56ebe
--   fn_poker_diamond_set_table_bomb_pot       c1ebcba27664f73cec418400f33d22c1
--   fn_poker_diamond_create_tournament        11cd470d16bc4cd343e3e38b70caff76
--   fn_guard_managed_game_lifecycle           e4e6dbe534f8ed1fc7fa03fcad968114
--   fn_can_create_games (asserted unchanged)  a79e8264252e7f05bc2103a6ee8718f1
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. THE ESTATE THIS MIGRATION EXPECTS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE r record; v_md5 text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'a Diamond switch is already on; this migration expects both closed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('fn_poker_diamond_staff_audit','fn_poker_diamond_audit_tournament_created',
                                'fn_poker_diamond_edit_cash_table','fn_poker_diamond_close_cash_table',
                                'fn_poker_diamond_remove_tournament_player','fn_poker_diamond_cancel_tournament',
                                'fn_poker_diamond_create_seat_first_board')) THEN
    RAISE EXCEPTION 'a door this migration creates already exists';
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('public.fn_poker_diamond_open_cash_table(text,integer,integer,integer,integer,integer,text)', 'f45465677a693da31100898b465b8210'),
      ('public.fn_poker_diamond_set_table_straddle(uuid,boolean,boolean)', 'ce002ad2be7891a84f489d58a1db24f9'),
      ('public.fn_poker_diamond_set_table_run_it_twice(uuid,boolean)', '6ff7bcb1b51da39d7f1f998605b56ebe'),
      ('public.fn_poker_diamond_set_table_bomb_pot(uuid,boolean,integer,smallint)', 'c1ebcba27664f73cec418400f33d22c1'),
      ('public.fn_can_create_games(uuid,uuid)', 'a79e8264252e7f05bc2103a6ee8718f1')) AS x(sig, pin)
  LOOP
    v_md5 := md5(pg_get_functiondef(r.sig::regprocedure));
    IF v_md5 <> r.pin THEN
      RAISE EXCEPTION '% is not the pinned text (md5 %)', r.sig, v_md5;
    END IF;
  END LOOP;
END $m$;

-- ---------------------------------------------------------------------------
-- 1. THE NEW NAMES ARE DECLARED BEFORE THEY EXIST
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_poker_diamond_staff_audit', 'system',
   'Diamond Phase 10. Files one admin_audit_log row for a Diamond configuration door through fn_log_admin_action: the signed-in platform operator, the action, the target, the row before and after and which columns changed. Refuses any other caller. Owner-only. Moves no money.'),
  ('fn_poker_diamond_audit_tournament_created', 'system',
   'Diamond Phase 10. Files the audit row of fn_poker_diamond_create_tournament for the Diamond event its answer names, and returns the answer unchanged. Owner-only. Moves no money.'),
  ('fn_poker_diamond_edit_cash_table', 'system',
   'Diamond Phase 10. Platform-staff door with a live session: the name, stakes, buy-ins and seats of an EMPTY Diamond cash table (no live seat, no unreleased custody, waiting), held to the open door''s rules and the creation guard''s and re-proved by fn_poker_diamond_plain_cash_table; files its audit row. Moves no money.'),
  ('fn_poker_diamond_close_cash_table', 'system',
   'Diamond Phase 10. Platform-staff door with a live session: closes a Diamond cash table, refused while any seat holds custody or a player sits; files its audit row. Moves no money.'),
  ('fn_poker_diamond_remove_tournament_player', 'approved',
   'Diamond Phase 10. Platform-staff door with a live session: withdraws a registration from a Diamond event before it starts through fn_ca_unregister_tournament_player_exact, whose Diamond branch (fn_poker_diamond_tournament_unregister -> fn_poker_diamond_tournament_refund -> fn_poker_diamond_release) returns the entry from its own custody row and journals it there; request-bound replay; files its audit row. Moves money only through those approved doors.'),
  ('fn_poker_diamond_cancel_tournament', 'approved',
   'Diamond Phase 10. Platform-staff door with a live session onto fn_poker_diamond_tournament_cancel: every entry goes home from its own custody row and the immutable cancellation receipt names the operator; opens the managed lifecycle guard for that one event in its own transaction; files its audit row. Moves money only through the approved cancellation authority.'),
  ('fn_poker_diamond_create_seat_first_board', 'system',
   'Diamond Phase 10. Platform-staff door with a live session: a Diamond Spin or heads-up sit-and-go, the event through fn_poker_diamond_create_tournament and its one joinable table in the same transaction, as fn_create_seat_first_game_atomic opens a chip board; files its audit row. Moves no money.')
ON CONFLICT (proname) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. ONE AUDIT HOME
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_poker_diamond_staff_audit(p_action text, p_target_type text, p_target_id uuid, p_before jsonb, p_after jsonb, p_details jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_changed jsonb;
BEGIN
  -- Only a signed-in platform operator acts through a Diamond configuration
  -- door, so the row can only ever name one.
  IF v_actor IS NULL OR NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_staff_audit_requires_platform_staff' USING ERRCODE='42501';
  END IF;
  IF p_action IS NULL OR p_action !~ '^diamond\.[a-z_]+$'
     OR p_target_type IS NULL OR p_target_type NOT IN ('diamond_table','diamond_tournament')
     OR p_target_id IS NULL OR p_after IS NULL THEN
    RAISE EXCEPTION 'diamond_staff_audit_requires_an_action_a_target_and_a_state' USING ERRCODE='22023';
  END IF;
  -- Which columns moved, when there was a row before: every key whose value
  -- differs, the row's own clock aside.
  IF p_before IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(a.key ORDER BY a.key), '[]'::jsonb) INTO v_changed
      FROM jsonb_each(p_after) a
     WHERE a.key <> 'updated_at' AND a.value IS DISTINCT FROM p_before -> a.key;
  END IF;
  RETURN public.fn_log_admin_action(
    v_actor, p_action, p_target_type, p_target_id::text,
    COALESCE(p_details, '{}'::jsonb) || jsonb_build_object('asset', 'diamonds')
      || CASE WHEN v_changed IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('changed', v_changed) END,
    p_before, p_after);
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_staff_audit(text, text, uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_poker_diamond_audit_tournament_created(p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_id uuid;
BEGIN
  v_id := NULLIF(p_result ->> 'tournamentId', '')::uuid;
  IF v_id IS NULL OR NOT public.fn_poker_diamond_tournament(v_id) THEN
    RAISE EXCEPTION 'diamond_tournament_would_not_be_recognised' USING ERRCODE='23514';
  END IF;
  PERFORM public.fn_poker_diamond_staff_audit('diamond.tournament_create', 'diamond_tournament', v_id, NULL,
    (SELECT to_jsonb(t) FROM public.tournaments t WHERE t.id = v_id),
    jsonb_build_object('door', 'fn_poker_diamond_create_tournament', 'table_id', p_result -> 'table_id'));
  RETURN p_result;
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_audit_tournament_created(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. THE FOUR TABLE DOORS THAT EXIST GO ON THE RECORD
-- ---------------------------------------------------------------------------
-- Pinned in section 0 and redefined in full with the same signature. Each is
-- its live text with the audit row added after the write it makes, and the
-- open door also writes its operator to tables.created_by (NULL on all 17
-- Diamond tables until now).

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_open_cash_table(p_name text, p_small_blind integer, p_big_blind integer, p_min_buy_in integer, p_max_buy_in integer, p_max_players integer DEFAULT 6, p_game_variant text DEFAULT 'nlh'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_arena uuid;
  v_table uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  -- Platform staff only. The estate already has one answer to this question and
  -- it is fn_is_platform_admin(); never re-derive a role list.
  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE = '42501';
  END IF;

  SELECT c.id INTO v_arena
  FROM public.clubs c
  WHERE c.asset = 'diamonds' AND c.is_platform = true AND c.union_id IS NULL
  LIMIT 1;

  IF v_arena IS NULL THEN
    RAISE EXCEPTION 'diamond_arena_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_small_blind IS NULL OR p_big_blind IS NULL
     OR p_min_buy_in IS NULL OR p_max_buy_in IS NULL
     OR p_small_blind <= 0 OR p_big_blind <= 0
     OR p_min_buy_in <= 0 OR p_max_buy_in <= 0
     OR p_small_blind > p_big_blind
     OR p_min_buy_in > p_max_buy_in
     OR p_big_blind > p_min_buy_in
     OR p_max_buy_in > 2147483647
  THEN
    RAISE EXCEPTION 'diamond_table_requires_whole_positive_stakes' USING ERRCODE = '22023';
  END IF;

  IF p_max_players IS NULL OR p_max_players < 2 OR p_max_players > 10 THEN
    RAISE EXCEPTION 'diamond_table_requires_a_real_seat_count' USING ERRCODE = '22023';
  END IF;

  -- The door names the game, and refuses one this arena does not deal rather
  -- than opening a table the engine would then refuse to load.
  IF p_game_variant IS NULL OR NOT public.fn_poker_diamond_cash_variant(p_game_variant) THEN
    RAISE EXCEPTION 'diamond_table_requires_a_supported_game' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.tables (
    club_id, union_id, tournament_id, cluster_id,
    name, game_type, game_variant, status, max_players,
    small_blind, big_blind, ante,
    min_buy_in, max_buy_in,
    rake_percent, rake_cap_bb, bbj_percent,
    is_template, insurance_enabled, bomb_pot_enabled,
    run_it_twice, allow_run_it_twice, run_it_twice_enabled,
    straddle_enabled, auto_utg_straddle, voluntary_straddle,
    seven_deuce_enabled, nit_game, all_in_or_fold, pineapple_holdem, cap_enabled,
    created_by
  ) VALUES (
    v_arena, NULL, NULL, NULL,
    coalesce(nullif(btrim(p_name), ''), 'Diamond Cash'), 'cash', p_game_variant,
    'waiting', p_max_players,
    p_small_blind, p_big_blind, 0,
    p_min_buy_in, p_max_buy_in,
    0, 0, 0,
    false, false, false,
    false, false, false,
    false, false, false,
    false, false, false, false, false,
    v_actor
  )
  RETURNING id INTO v_table;

  -- The row this door just wrote must be one the engine will admit. A door
  -- that can open a table nobody can sit at is worse than no door.
  IF NOT EXISTS (
    SELECT 1 FROM public.tables t
     WHERE t.id = v_table AND public.fn_poker_diamond_plain_cash_table(t)
  ) THEN
    RAISE EXCEPTION 'diamond_table_would_not_be_admitted' USING ERRCODE = '23514';
  END IF;

  -- DIAMOND PHASE 10: on the record - the operator on the row (created_by,
  -- above) and one audit row holding the table as it was opened.
  PERFORM public.fn_poker_diamond_staff_audit('diamond.table_open', 'diamond_table', v_table, NULL,
    (SELECT to_jsonb(t) FROM public.tables t WHERE t.id = v_table),
    jsonb_build_object('door', 'fn_poker_diamond_open_cash_table'));

  RETURN v_table;
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_open_cash_table(text, integer, integer, integer, integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_open_cash_table(text, integer, integer, integer, integer, integer, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_set_table_straddle(p_table_id uuid, p_enabled boolean, p_auto_utg boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_t public.tables%ROWTYPE; v_after public.tables%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL THEN
  RAISE EXCEPTION 'authentication required' USING ERRCODE='28000';
 END IF;
 IF NOT public.fn_is_platform_admin() THEN
  RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE='42501';
 END IF;
 IF p_table_id IS NULL OR p_enabled IS NULL OR p_auto_utg IS NULL THEN
  RAISE EXCEPTION 'diamond_straddle_requires_explicit_flags' USING ERRCODE='22023';
 END IF;
 IF p_auto_utg AND NOT p_enabled THEN
  RAISE EXCEPTION 'diamond_straddle_auto_requires_straddles' USING ERRCODE='22023';
 END IF;
 SELECT t.* INTO v_t FROM public.tables t
   JOIN public.clubs c ON c.id=t.club_id
 WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
   AND c.union_id IS NULL AND t.union_id IS NULL
 FOR UPDATE OF t;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'diamond_table_not_found' USING ERRCODE='P0002';
 END IF;
 -- The row as it will be, not as it is: this door is about to change it.
 v_after:=v_t;
 v_after.straddle_enabled:=p_enabled;
 v_after.auto_utg_straddle:=CASE WHEN p_enabled THEN p_auto_utg ELSE false END;
 v_after.voluntary_straddle:=CASE WHEN p_enabled THEN NOT p_auto_utg ELSE false END;
 IF NOT public.fn_poker_diamond_plain_cash_table(v_after) THEN
  RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
 END IF;
 UPDATE public.tables
   SET straddle_enabled=v_after.straddle_enabled,
       auto_utg_straddle=v_after.auto_utg_straddle,
       voluntary_straddle=v_after.voluntary_straddle
 WHERE id=p_table_id;
 -- DIAMOND PHASE 10: one audit row - the table before and after, and its operator.
 PERFORM public.fn_poker_diamond_staff_audit('diamond.table_straddle','diamond_table',p_table_id,to_jsonb(v_t),
   (SELECT to_jsonb(t) FROM public.tables t WHERE t.id=p_table_id),
   jsonb_build_object('door','fn_poker_diamond_set_table_straddle','enabled',p_enabled,'auto_utg',p_auto_utg));
END $function$
;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_set_table_straddle(uuid, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_set_table_straddle(uuid, boolean, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_set_table_run_it_twice(p_table_id uuid, p_enabled boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_t public.tables%ROWTYPE; v_after public.tables%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL THEN
  RAISE EXCEPTION 'authentication required' USING ERRCODE='28000';
 END IF;
 IF NOT public.fn_is_platform_admin() THEN
  RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE='42501';
 END IF;
 IF p_table_id IS NULL OR p_enabled IS NULL THEN
  RAISE EXCEPTION 'diamond_run_it_twice_requires_an_explicit_flag' USING ERRCODE='22023';
 END IF;
 SELECT t.* INTO v_t FROM public.tables t
   JOIN public.clubs c ON c.id=t.club_id
 WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
   AND c.union_id IS NULL AND t.union_id IS NULL
 FOR UPDATE OF t;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'diamond_table_not_found' USING ERRCODE='P0002';
 END IF;
 v_after:=v_t;
 v_after.run_it_twice:=p_enabled;
 v_after.allow_run_it_twice:=p_enabled;
 v_after.run_it_twice_enabled:=false;
 IF NOT public.fn_poker_diamond_plain_cash_table(v_after) THEN
  RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
 END IF;
 UPDATE public.tables
   SET run_it_twice=v_after.run_it_twice,
       allow_run_it_twice=v_after.allow_run_it_twice,
       run_it_twice_enabled=v_after.run_it_twice_enabled
 WHERE id=p_table_id;
 -- DIAMOND PHASE 10: one audit row - the table before and after, and its operator.
 PERFORM public.fn_poker_diamond_staff_audit('diamond.table_run_it_twice','diamond_table',p_table_id,to_jsonb(v_t),
   (SELECT to_jsonb(t) FROM public.tables t WHERE t.id=p_table_id),
   jsonb_build_object('door','fn_poker_diamond_set_table_run_it_twice','enabled',p_enabled));
END $function$
;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_set_table_run_it_twice(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_set_table_run_it_twice(uuid, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_set_table_bomb_pot(p_table_id uuid, p_enabled boolean, p_ante_multiplier integer DEFAULT 2, p_board_count smallint DEFAULT 1)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_t public.tables%ROWTYPE; v_after public.tables%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL THEN
  RAISE EXCEPTION 'authentication required' USING ERRCODE='28000';
 END IF;
 IF NOT public.fn_is_platform_admin() THEN
  RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE='42501';
 END IF;
 IF p_table_id IS NULL OR p_enabled IS NULL THEN
  RAISE EXCEPTION 'diamond_bomb_pot_requires_an_explicit_flag' USING ERRCODE='22023';
 END IF;
 IF p_enabled AND (p_ante_multiplier IS NULL OR p_ante_multiplier < 1
    OR p_board_count IS NULL OR p_board_count NOT BETWEEN 1 AND 3) THEN
  RAISE EXCEPTION 'diamond_bomb_pot_requires_a_real_ante_and_board_count' USING ERRCODE='22023';
 END IF;
 SELECT t.* INTO v_t FROM public.tables t
   JOIN public.clubs c ON c.id=t.club_id
 WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
   AND c.union_id IS NULL AND t.union_id IS NULL
 FOR UPDATE OF t;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'diamond_table_not_found' USING ERRCODE='P0002';
 END IF;
 v_after:=v_t;
 v_after.bomb_pot_enabled:=p_enabled;
 v_after.bomb_pot_ante_multiplier:=CASE WHEN p_enabled THEN p_ante_multiplier ELSE 2 END;
 v_after.bomb_pot_ante_fixed:=0;
 v_after.bomb_pot_board_count:=CASE WHEN p_enabled THEN p_board_count ELSE 1 END;
 v_after.bomb_pot_double_board:=CASE WHEN p_enabled THEN p_board_count>=2 ELSE false END;
 v_after.bomb_pot_variant:=NULL;
 IF NOT public.fn_poker_diamond_plain_cash_table(v_after) THEN
  RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
 END IF;
 -- The ante this would produce has to be a whole Diamond, checked here so the
 -- refusal costs nobody a table they thought they had configured.
 IF p_enabled AND (v_t.big_blind*p_ante_multiplier) IS DISTINCT FROM
    trunc(v_t.big_blind*p_ante_multiplier) THEN
  RAISE EXCEPTION 'diamond_bomb_pot_requires_a_whole_ante' USING ERRCODE='23514';
 END IF;
 UPDATE public.tables
   SET bomb_pot_enabled=v_after.bomb_pot_enabled,
       bomb_pot_ante_multiplier=v_after.bomb_pot_ante_multiplier,
       bomb_pot_ante_fixed=v_after.bomb_pot_ante_fixed,
       bomb_pot_board_count=v_after.bomb_pot_board_count,
       bomb_pot_double_board=v_after.bomb_pot_double_board,
       bomb_pot_variant=v_after.bomb_pot_variant
 WHERE id=p_table_id;
 -- DIAMOND PHASE 10: one audit row - the table before and after, and its operator.
 PERFORM public.fn_poker_diamond_staff_audit('diamond.table_bomb_pot','diamond_table',p_table_id,to_jsonb(v_t),
   (SELECT to_jsonb(t) FROM public.tables t WHERE t.id=p_table_id),
   jsonb_build_object('door','fn_poker_diamond_set_table_bomb_pot','enabled',p_enabled,'ante_multiplier',p_ante_multiplier,'board_count',p_board_count));
END $function$
;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_set_table_bomb_pot(uuid, boolean, integer, smallint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_set_table_bomb_pot(uuid, boolean, integer, smallint) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. THE CREATION DOOR GOES ON THE RECORD
-- ---------------------------------------------------------------------------
-- Shared and changed often, so changed in place: live md5 pinned, each clause
-- found exactly once, the reverse substitution proved. Each of its two answers
-- (a Spin's, from fn_poker_diamond_create_spin, and every other format's)
-- passes through fn_poker_diamond_audit_tournament_created, which files the
-- row and returns the answer unchanged. Nothing else in the door moves.
DO $m$
DECLARE
  v_oid oid := 'public.fn_poker_diamond_create_tournament(jsonb)'::regprocedure;
  v_def text; v_old1 text; v_new1 text; v_old2 text; v_new2 text; v_n integer;
BEGIN
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '11cd470d16bc4cd343e3e38b70caff76' THEN
    RAISE EXCEPTION 'fn_poker_diamond_create_tournament is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old1 := $x$    RETURN public.fn_poker_diamond_create_spin(p_config, v_arena);$x$;
  v_new1 := $x$    -- DIAMOND PHASE 10: the answer files its audit row on the way out.
    RETURN public.fn_poker_diamond_audit_tournament_created(public.fn_poker_diamond_create_spin(p_config, v_arena));$x$;
  v_old2 := $x$  RETURN jsonb_build_object('success',true,'tournamentId',v_id,'id',v_id,'buy_in_amount',v_buy_in,'buy_in_fee',v_fee,
    'total',v_total,'bounty_amount',v_bounty,'is_mystery_bounty',v_mystery,'asset','diamonds',
    'satellite_target_id',v_target_id,'satellite_ticket',
    CASE WHEN v_satellite THEN v_target.buy_in_amount + COALESCE(v_target.buy_in_fee,0) END);$x$;
  v_new2 := $x$  -- DIAMOND PHASE 10: the answer files its audit row on the way out.
  RETURN public.fn_poker_diamond_audit_tournament_created(jsonb_build_object('success',true,'tournamentId',v_id,'id',v_id,'buy_in_amount',v_buy_in,'buy_in_fee',v_fee,
    'total',v_total,'bounty_amount',v_bounty,'is_mystery_bounty',v_mystery,'asset','diamonds',
    'satellite_target_id',v_target_id,'satellite_ticket',
    CASE WHEN v_satellite THEN v_target.buy_in_amount + COALESCE(v_target.buy_in_fee,0) END));$x$;
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the creation door: the Spin answer occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the creation door: the answer occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(replace(v_def, v_old1, v_new1), v_old2, v_new2);
  IF md5(replace(replace(pg_get_functiondef(v_oid), v_new1, v_old1), v_new2, v_old2)) <> '11cd470d16bc4cd343e3e38b70caff76' THEN
    RAISE EXCEPTION 'the creation door: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_create_tournament(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_create_tournament(jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4b. THE MANAGED LIFECYCLE GUARD ADMITS THE STAFF CANCELLATION OF ONE EVENT
-- ---------------------------------------------------------------------------
-- fn_guard_managed_game_lifecycle refuses to cancel an event that has a
-- registration unless the engine does it, and the Diamond cancellation
-- authority, reached from a staff session, is not the engine. The refusal
-- gains one condition: the event this transaction's
-- fn_poker_diamond_cancel_tournament named (app.poker_diamond_staff_cancel,
-- set with is_local, after that door proved a platform operator, a live
-- session and a Diamond event). Every other caller, every chip event and every
-- other Diamond event meets the refusal exactly as before. In place: live md5
-- pinned, the clause found exactly once, the reverse substitution proved.
DO $m$
DECLARE
  v_oid oid; v_def text; v_old text; v_new text; v_n integer;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'fn_guard_managed_game_lifecycle';
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'e4e6dbe534f8ed1fc7fa03fcad968114' THEN
    RAISE EXCEPTION 'fn_guard_managed_game_lifecycle is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := $x$       AND upper(COALESCE(OLD.status, '')) NOT IN ('CANCELLED', 'CANCELED') THEN
      RAISE EXCEPTION 'This tournament cannot be cancelled after a player has registered'$x$;
  v_new := $x$       AND upper(COALESCE(OLD.status, '')) NOT IN ('CANCELLED', 'CANCELED')
       -- DIAMOND PHASE 10: platform staff cancel a Diamond event through
       -- fn_poker_diamond_cancel_tournament, which names that one event here,
       -- in its own transaction, around the Diamond cancellation authority
       -- that first returns every entry from its own custody row.
       AND COALESCE(current_setting('app.poker_diamond_staff_cancel', true), '') IS DISTINCT FROM NEW.id::text THEN
      RAISE EXCEPTION 'This tournament cannot be cancelled after a player has registered'$x$;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the lifecycle guard: the registered-cancel refusal occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> 'e4e6dbe534f8ed1fc7fa03fcad968114' THEN
    RAISE EXCEPTION 'the lifecycle guard: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 5. AN EMPTY DIAMOND CASH TABLE CAN BE EDITED
-- ---------------------------------------------------------------------------
-- Name, stakes, buy-ins and seats; a NULL argument keeps what the table has.
-- Empty means waiting, nobody seated and no Diamond held for a seat, read
-- under the row lock that a new seat's foreign key has to wait for. The
-- result is held to the open door's rules, to the creation guard's (which
-- runs on INSERT only: the name hygiene, the big blind above the small one,
-- the seat law) and re-proved by fn_poker_diamond_plain_cash_table as written.
CREATE FUNCTION public.fn_poker_diamond_edit_cash_table(p_table_id uuid, p_name text DEFAULT NULL::text, p_small_blind integer DEFAULT NULL::integer, p_big_blind integer DEFAULT NULL::integer, p_min_buy_in integer DEFAULT NULL::integer, p_max_buy_in integer DEFAULT NULL::integer, p_max_players integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_t public.tables%ROWTYPE; v_after public.tables%ROWTYPE; v_row public.tables%ROWTYPE;
  v_name text; v_cap integer; v_audit uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE='28000';
  END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE='42501';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';
  END IF;
  SELECT t.* INTO v_t FROM public.tables t
    JOIN public.clubs c ON c.id=t.club_id
   WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL AND t.tournament_id IS NULL
   FOR UPDATE OF t;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_table_not_found' USING ERRCODE='P0002';
  END IF;
  IF lower(COALESCE(v_t.status,'')) IN ('closed','completed','cancelled','finished','deleted')
     OR COALESCE(v_t.is_deleted,false) THEN
    RAISE EXCEPTION 'diamond_table_is_closed' USING ERRCODE='55000';
  END IF;
  IF lower(COALESCE(v_t.status,'')) <> 'waiting' OR COALESCE(v_t.current_players,0) <> 0
     OR EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id=p_table_id AND s.left_at IS NULL)
     OR EXISTS (SELECT 1 FROM public.poker_diamond_custody c
                 WHERE c.purpose='cash_seat' AND c.target_id=p_table_id AND c.state<>'released') THEN
    RAISE EXCEPTION 'diamond_table_must_be_empty_to_edit' USING ERRCODE='55000';
  END IF;

  v_after := v_t;
  IF p_name IS NOT NULL THEN
    v_name := replace(replace(btrim(p_name), '<', ''), '>', '');
    IF length(v_name) = 0 THEN
      RAISE EXCEPTION 'diamond_table_requires_a_name' USING ERRCODE='22023';
    END IF;
    v_after.name := left(v_name, 60);
  END IF;
  v_after.small_blind := COALESCE(p_small_blind, v_t.small_blind);
  v_after.big_blind := COALESCE(p_big_blind, v_t.big_blind);
  v_after.min_buy_in := COALESCE(p_min_buy_in, v_t.min_buy_in);
  v_after.max_buy_in := COALESCE(p_max_buy_in, v_t.max_buy_in);
  v_after.max_players := COALESCE(p_max_players, v_t.max_players);

  -- Whole positive Diamonds, the open door's order (small <= big <= min <= max)
  -- and the creation guard's strict blinds.
  IF v_after.small_blind IS NULL OR v_after.big_blind IS NULL
     OR v_after.min_buy_in IS NULL OR v_after.max_buy_in IS NULL
     OR v_after.small_blind <= 0 OR v_after.big_blind <= 0
     OR v_after.min_buy_in <= 0 OR v_after.max_buy_in <= 0
     OR v_after.small_blind <> trunc(v_after.small_blind) OR v_after.big_blind <> trunc(v_after.big_blind)
     OR v_after.min_buy_in <> trunc(v_after.min_buy_in) OR v_after.max_buy_in <> trunc(v_after.max_buy_in)
     OR v_after.small_blind >= v_after.big_blind
     OR v_after.min_buy_in > v_after.max_buy_in
     OR v_after.big_blind > v_after.min_buy_in
     OR v_after.max_buy_in > 2147483647
  THEN
    RAISE EXCEPTION 'diamond_table_requires_whole_positive_stakes' USING ERRCODE='22023';
  END IF;
  -- The open door's seat count inside the creation guard's seat law for the
  -- table's game, and never fewer seats than the table waits for to deal.
  v_cap := CASE lower(COALESCE(v_t.game_variant,'nlh'))
             WHEN 'plo6' THEN 6 WHEN 'plo5' THEN 7 WHEN 'plo4' THEN 8
             WHEN 'plo8' THEN 8 WHEN 'flo8' THEN 8 ELSE 9 END;
  IF v_after.max_players IS NULL OR v_after.max_players < 2 OR v_after.max_players > v_cap
     OR v_after.max_players < COALESCE(v_t.auto_start_players, 2) THEN
    RAISE EXCEPTION 'diamond_table_requires_a_real_seat_count' USING ERRCODE='22023';
  END IF;
  IF NOT public.fn_poker_diamond_plain_cash_table(v_after) THEN
    RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
  END IF;

  UPDATE public.tables
     SET name=v_after.name, small_blind=v_after.small_blind, big_blind=v_after.big_blind,
         min_buy_in=v_after.min_buy_in, max_buy_in=v_after.max_buy_in, max_players=v_after.max_players
   WHERE id=p_table_id
  RETURNING * INTO v_row;
  -- The row as written must still be one the engine will admit.
  IF NOT public.fn_poker_diamond_plain_cash_table(v_row) THEN
    RAISE EXCEPTION 'diamond_table_would_not_be_admitted' USING ERRCODE='23514';
  END IF;
  v_audit := public.fn_poker_diamond_staff_audit('diamond.table_edit', 'diamond_table', p_table_id,
    to_jsonb(v_t), to_jsonb(v_row), jsonb_build_object('door', 'fn_poker_diamond_edit_cash_table'));
  RETURN jsonb_build_object('ok', true, 'table_id', p_table_id, 'audit_id', v_audit,
    'name', v_row.name, 'small_blind', v_row.small_blind, 'big_blind', v_row.big_blind,
    'min_buy_in', v_row.min_buy_in, 'max_buy_in', v_row.max_buy_in, 'max_players', v_row.max_players);
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_edit_cash_table(uuid, text, integer, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_edit_cash_table(uuid, text, integer, integer, integer, integer, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. A DIAMOND CASH TABLE CAN BE CLOSED WHEN NO SEAT HOLDS CUSTODY
-- ---------------------------------------------------------------------------
-- A seat that holds custody holds a player's Diamonds: it leaves through the
-- engine's cash-out, never by closing the table under it. The close itself is
-- the chip close's write (status closed, no players), and every trigger the
-- chip close meets still runs.
CREATE FUNCTION public.fn_poker_diamond_close_cash_table(p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_t public.tables%ROWTYPE; v_row public.tables%ROWTYPE; v_audit uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE='28000';
  END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE='42501';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';
  END IF;
  SELECT t.* INTO v_t FROM public.tables t
    JOIN public.clubs c ON c.id=t.club_id
   WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL AND t.tournament_id IS NULL
   FOR UPDATE OF t;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_table_not_found' USING ERRCODE='P0002';
  END IF;
  IF lower(COALESCE(v_t.status,'')) IN ('closed','completed','cancelled','finished','deleted')
     OR COALESCE(v_t.is_deleted,false) THEN
    RAISE EXCEPTION 'diamond_table_is_closed' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.poker_diamond_custody c
              WHERE c.purpose='cash_seat' AND c.target_id=p_table_id AND c.state<>'released') THEN
    RAISE EXCEPTION 'diamond_table_seat_holds_custody' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id=p_table_id AND s.left_at IS NULL) THEN
    RAISE EXCEPTION 'diamond_table_has_a_seated_player' USING ERRCODE='55000';
  END IF;
  UPDATE public.tables SET status='closed', current_players=0
   WHERE id=p_table_id
  RETURNING * INTO v_row;
  v_audit := public.fn_poker_diamond_staff_audit('diamond.table_close', 'diamond_table', p_table_id,
    to_jsonb(v_t), to_jsonb(v_row), jsonb_build_object('door', 'fn_poker_diamond_close_cash_table'));
  RETURN jsonb_build_object('ok', true, 'table_id', p_table_id, 'status', v_row.status, 'audit_id', v_audit);
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_close_cash_table(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_close_cash_table(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. A PLAYER CAN BE REMOVED FROM A DIAMOND EVENT
-- ---------------------------------------------------------------------------
-- Through the estate's one withdrawal authority,
-- fn_ca_unregister_tournament_player_exact, whose Diamond branch sends the
-- entry home from its own custody row (a seat-first chair included) and
-- answers with its receipt; its refusals (not registered, started, a drawn
-- Spin) are its own and come back unchanged. The locks are taken in that
-- authority's own order before the state is read, so the row before is the
-- row it acts on. A request id makes a retry replay the first receipt, and a
-- replay files no second row.
CREATE FUNCTION public.fn_poker_diamond_remove_tournament_player(p_tournament_id uuid, p_user_id uuid, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_request uuid := COALESCE(p_request_id, gen_random_uuid());
  v_t public.tournaments%ROWTYPE; v_reg public.tournament_players%ROWTYPE;
  v_result jsonb; v_audit uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE='28000';
  END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_tournament_staff_only' USING ERRCODE='42501';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';
  END IF;
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'tournament and player ids are required' USING ERRCODE='22004';
  END IF;
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  SELECT t.* INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND OR NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_tournament_not_found' USING ERRCODE='P0002';
  END IF;
  SELECT tp.* INTO v_reg FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   FOR UPDATE;
  v_result := public.fn_ca_unregister_tournament_player_exact(
    p_tournament_id, p_user_id, NULL, 'Platform staff removal refund', v_request);
  IF COALESCE((v_result->>'ok')::boolean, false)
     AND NOT COALESCE((v_result->>'replayed')::boolean, false) THEN
    v_audit := public.fn_poker_diamond_staff_audit('diamond.tournament_remove_player', 'diamond_tournament', p_tournament_id,
      to_jsonb(v_t), (SELECT to_jsonb(t) FROM public.tournaments t WHERE t.id=p_tournament_id),
      jsonb_build_object('door', 'fn_poker_diamond_remove_tournament_player', 'user_id', p_user_id,
        'registration', CASE WHEN v_reg.id IS NULL THEN NULL ELSE to_jsonb(v_reg) END,
        'request_id', v_request, 'refunded_diamonds', v_result->'refunded_diamonds',
        'custody_id', v_result->'custody_id'));
    v_result := v_result || jsonb_build_object('audit_id', v_audit);
  END IF;
  RETURN v_result;
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_remove_tournament_player(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_remove_tournament_player(uuid, uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. STAFF CAN CANCEL A DIAMOND EVENT
-- ---------------------------------------------------------------------------
-- Onto the existing Diamond cancellation, fn_poker_diamond_tournament_cancel:
-- every entry goes home from its own custody row, seats, tables and roster
-- close, and the immutable receipt names the operator. Its refusals (a started
-- event, awards committed, caches that disagree with custody) are its own. It
-- takes the global settlement lane and then the event, so this door takes them
-- first in the same order. The managed lifecycle guard is opened for this one
-- event in this transaction (4b) and closed again after. A stored receipt is
-- the answer: the authority replays it, nothing moves and no second row is
-- filed.
CREATE FUNCTION public.fn_poker_diamond_cancel_tournament(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_t public.tournaments%ROWTYPE; v_receipt jsonb; v_replay boolean; v_audit uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE='28000';
  END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_tournament_staff_only' USING ERRCODE='42501';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';
  END IF;
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'Tournament id is required' USING ERRCODE='22004';
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_global();
  SELECT t.* INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND OR NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_tournament_not_found' USING ERRCODE='P0002';
  END IF;
  v_replay := EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts h WHERE h.tournament_id=p_tournament_id);
  PERFORM set_config('app.poker_diamond_staff_cancel', p_tournament_id::text, true);
  PERFORM set_config('app.managed_game_lifecycle', 'on', true);
  v_receipt := public.fn_poker_diamond_tournament_cancel(p_tournament_id, v_actor);
  PERFORM set_config('app.managed_game_lifecycle', '', true);
  PERFORM set_config('app.poker_diamond_staff_cancel', '', true);
  IF NOT v_replay THEN
    v_audit := public.fn_poker_diamond_staff_audit('diamond.tournament_cancel', 'diamond_tournament', p_tournament_id,
      to_jsonb(v_t), (SELECT to_jsonb(t) FROM public.tournaments t WHERE t.id=p_tournament_id),
      jsonb_build_object('door', 'fn_poker_diamond_cancel_tournament',
        'refunded_count', v_receipt->'refunded_count', 'total_refunded', v_receipt->'total_refunded',
        'fees_reversed', v_receipt->'fees_reversed', 'closed_table_count', v_receipt->'closed_table_count',
        'released_seat_count', v_receipt->'released_seat_count'));
  END IF;
  RETURN v_receipt || jsonb_build_object('audit_id', v_audit);
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_cancel_tournament(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_cancel_tournament(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. A DIAMOND SEAT-FIRST BOARD OPENS WITH ITS TABLE
-- ---------------------------------------------------------------------------
-- A seat-first board is sold seat by seat, so it needs its one joinable table
-- the moment it is listed. The event is created by the Diamond creation door
-- under its own rules, unchanged, and in the same transaction the board gets
-- its table as the chip seat-first creator (fn_create_seat_first_game_atomic)
-- opens one: the event's name and game, its first level's blinds, no buy-in,
-- every seat, waiting. A Spin's door (fn_poker_diamond_create_spin) already
-- opens a Spin's table; a heads-up sit-and-go had none, so it could be listed
-- and never sat. Anything that is not a Spin or a two-seat sit-and-go is
-- refused before anything is written. A board leaves two audit rows, one per
-- door: the creation door's for the event and this door's for its table. A
-- Diamond Spin is still refused by the creation door until a reserve source is
-- authorized.
CREATE FUNCTION public.fn_poker_diamond_create_seat_first_board(p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_type text; v_result jsonb; v_id uuid; v_t public.tournaments%ROWTYPE;
  v_table uuid; v_first jsonb; v_sb numeric; v_bb numeric; v_audit uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE='28000';
  END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_tournament_staff_only' USING ERRCODE='42501';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';
  END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_configuration' USING ERRCODE='22023';
  END IF;
  v_type := lower(COALESCE(p_config->>'type', 'mtt'));
  IF NOT (v_type = 'spin' OR (v_type = 'sng' AND COALESCE(p_config->>'maxPlayers', '') = '2')) THEN
    RAISE EXCEPTION 'diamond_board_requires_a_spin_or_a_heads_up_sit_and_go' USING ERRCODE='22023';
  END IF;

  -- The event, through the Diamond creation door and every rule it holds.
  v_result := public.fn_poker_diamond_create_tournament(p_config);
  v_id := NULLIF(v_result->>'tournamentId', '')::uuid;
  SELECT t.* INTO v_t FROM public.tournaments t WHERE t.id=v_id FOR UPDATE;
  IF NOT FOUND OR NOT public.fn_poker_diamond_tournament(v_id)
     OR NOT public.fn_ca_tournament_recorded_seat_first(v_id, false) THEN
    RAISE EXCEPTION 'diamond_board_is_not_seat_first' USING ERRCODE='23514';
  END IF;

  -- Its table: a Spin's comes from its own door; any other board's is opened
  -- here, as the chip seat-first creator opens one.
  v_table := NULLIF(v_result->>'table_id', '')::uuid;
  IF v_table IS NULL THEN
    v_first := (v_t.blind_structure)::jsonb -> 0;
    v_sb := COALESCE(NULLIF(v_first->>'smallBlind', '')::numeric,
                     NULLIF(v_first->>'small_blind', '')::numeric,
                     NULLIF(v_first->>'sb', '')::numeric);
    v_bb := COALESCE(NULLIF(v_first->>'bigBlind', '')::numeric,
                     NULLIF(v_first->>'big_blind', '')::numeric,
                     NULLIF(v_first->>'bb', '')::numeric);
    IF v_sb IS NULL OR v_sb <= 0 OR v_bb IS NULL OR v_bb < v_sb THEN
      RAISE EXCEPTION 'diamond_board_requires_first_level_blinds' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.tables (
      club_id, tournament_id, name, game_type, game_variant, stakes,
      small_blind, big_blind, min_buy_in, max_buy_in,
      max_players, current_players, status, created_by)
    VALUES (
      v_t.club_id, v_id, v_t.name, 'tournament', lower(v_t.game_type), v_sb::text || '/' || v_bb::text,
      v_sb, v_bb, 0, 0,
      v_t.max_players, 0, 'waiting', v_actor)
    RETURNING id INTO v_table;
  END IF;
  IF (SELECT count(*) FROM public.tables tb
       WHERE tb.tournament_id=v_id AND COALESCE(tb.is_deleted,false)=false
         AND tb.status IN ('waiting','running')) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.tables tb
                     WHERE tb.id=v_table AND tb.tournament_id=v_id AND tb.club_id=v_t.club_id
                       AND tb.max_players=v_t.max_players AND tb.status='waiting') THEN
    RAISE EXCEPTION 'diamond_board_requires_exactly_one_joinable_table' USING ERRCODE='23514';
  END IF;

  v_audit := public.fn_poker_diamond_staff_audit('diamond.board_open', 'diamond_table', v_table, NULL,
    (SELECT to_jsonb(tb) FROM public.tables tb WHERE tb.id=v_table),
    jsonb_build_object('door', 'fn_poker_diamond_create_seat_first_board', 'tournament_id', v_id,
                       'format', public.fn_ca_tournament_recorded_format(v_id)));
  RETURN v_result || jsonb_build_object('table_id', v_table, 'board_audit_id', v_audit);
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_create_seat_first_board(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_create_seat_first_board(jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 10. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE r record; v_bad text; v_txt text;
BEGIN
  -- the four table doors file their row, and the open door names its operator
  FOR r IN SELECT * FROM (VALUES
      ('public.fn_poker_diamond_open_cash_table(text,integer,integer,integer,integer,integer,text)', 'diamond.table_open'),
      ('public.fn_poker_diamond_set_table_straddle(uuid,boolean,boolean)', 'diamond.table_straddle'),
      ('public.fn_poker_diamond_set_table_run_it_twice(uuid,boolean)', 'diamond.table_run_it_twice'),
      ('public.fn_poker_diamond_set_table_bomb_pot(uuid,boolean,integer,smallint)', 'diamond.table_bomb_pot')) AS x(sig, action)
  LOOP
    v_txt := pg_get_functiondef(r.sig::regprocedure);
    IF position('public.fn_poker_diamond_staff_audit(''' || r.action || '''' IN v_txt) = 0
       OR position('fn_is_platform_admin()' IN v_txt) = 0 THEN
      RAISE EXCEPTION '% does not file its audit row as this migration states', r.sig;
    END IF;
  END LOOP;
  IF position(E'cap_enabled,\n    created_by' IN pg_get_functiondef('public.fn_poker_diamond_open_cash_table(text,integer,integer,integer,integer,integer,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the open door does not write its operator to created_by';
  END IF;
  -- the creation door wraps both of its answers and nothing else moved
  v_txt := pg_get_functiondef('public.fn_poker_diamond_create_tournament(jsonb)'::regprocedure);
  IF (length(v_txt) - length(replace(v_txt, 'RETURN public.fn_poker_diamond_audit_tournament_created(', '')))
       / length('RETURN public.fn_poker_diamond_audit_tournament_created(') <> 2
     OR position('diamond_tournament_staff_only' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the creation door does not file its audit row on both of its answers';
  END IF;
  -- the lifecycle guard still refuses everyone else, and opens for one named event only
  v_txt := (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
             WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'fn_guard_managed_game_lifecycle');
  IF position('This tournament cannot be cancelled after a player has registered' IN v_txt) = 0
     OR position('Tournament lifecycle changes must use fn_close_managed_game' IN v_txt) = 0
     OR position('IS DISTINCT FROM NEW.id::text THEN' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the lifecycle guard is not as this migration states';
  END IF;
  -- Phase 2 stands: the club-role gate is the text it was
  IF md5(pg_get_functiondef('public.fn_can_create_games(uuid,uuid)'::regprocedure)) <> 'a79e8264252e7f05bc2103a6ee8718f1' THEN
    RAISE EXCEPTION 'fn_can_create_games moved; this migration must not widen it';
  END IF;
  -- grants: the staff doors are signed-in doors, the audit helpers are owner-only
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname IN ('fn_poker_diamond_open_cash_table','fn_poker_diamond_set_table_straddle',
                              'fn_poker_diamond_set_table_run_it_twice','fn_poker_diamond_set_table_bomb_pot',
                              'fn_poker_diamond_create_tournament','fn_poker_diamond_edit_cash_table',
                              'fn_poker_diamond_close_cash_table','fn_poker_diamond_remove_tournament_player',
                              'fn_poker_diamond_cancel_tournament','fn_poker_diamond_create_seat_first_board',
                              'fn_poker_diamond_staff_audit','fn_poker_diamond_audit_tournament_created')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable without an account', r.proname;
    END IF;
    IF r.proname IN ('fn_poker_diamond_staff_audit','fn_poker_diamond_audit_tournament_created') THEN
      IF has_function_privilege('authenticated', r.oid, 'EXECUTE') OR has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
        RAISE EXCEPTION '% is reachable from outside the doors; it is owner-only', r.proname;
      END IF;
    ELSIF NOT has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is not reachable by a signed-in operator', r.proname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('fn_poker_diamond_edit_cash_table','fn_poker_diamond_close_cash_table',
                         'fn_poker_diamond_remove_tournament_player','fn_poker_diamond_cancel_tournament',
                         'fn_poker_diamond_create_seat_first_board')
       AND p.prosecdef
       AND position('fn_is_platform_admin()' IN pg_get_functiondef(p.oid)) > 0
       AND position('fn_caller_session_is_live()' IN pg_get_functiondef(p.oid)) > 0
       AND position('fn_poker_diamond_staff_audit(' IN pg_get_functiondef(p.oid)) > 0) <> 5 THEN
    RAISE EXCEPTION 'the five new doors do not each ask for staff, a live session and an audit row';
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
  RAISE NOTICE 'staff run a Diamond game on the record: five doors that existed now file their audit row, five staff doors opened, one guard opened for one named event, nothing opened to players';
END $m$;
