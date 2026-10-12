-- ============================================================================
-- EVERY DIAMOND STAFF DOOR NEEDS A LIVE SESSION
-- ============================================================================
--
-- Diamond Phase 11, line 7: "Test old bookmarks, expired/revoked sessions,
-- stale storage, service workers and mobile rotation." A revoked session is
-- the one a player or a staff member signed out of elsewhere (or that was
-- signed out for them): its access token still verifies until it expires,
-- because PostgREST checks the signature and never the session row. Only a
-- door that asks public.fn_caller_session_is_live() can tell.
--
-- The Diamond Staff Desk (Phase 10) is seventeen doors. Five of them already
-- refuse a dead session by name - fn_poker_diamond_close_cash_table,
-- fn_poker_diamond_edit_cash_table, fn_poker_diamond_cancel_tournament,
-- fn_poker_diamond_remove_tournament_player and
-- fn_poker_diamond_create_seat_first_board raise
-- 'diamond_staff_session_required' (28000) right after the staff check - and
-- so do the player money doors (atomic_table_buyin, send_wallet_diamond_
-- transfer, the cash-out and buy-in receipts). The other ten writers asked
-- only fn_is_platform_admin(), which reads profiles.role for auth.uid() and
-- never the session. Read on production 2026-09-30: a staff session revoked on
-- another device could still open a Diamond cash table, change its straddle,
-- run-it-twice or bomb-pot settings, propose, approve, reject or SETTLE a
-- Diamond correction (settling moves Diamonds through the register), and
-- review or close incidents, for as long as its access token lived.
--
-- This gives each of the ten the same check at the same place (directly
-- after the staff check), in the door's own refusal style, so its client
-- already has words for it:
--   the four table doors raise 'diamond_staff_session_required' (28000), as
--     their five siblings do;
--   the four adjustment doors answer {ok: false, refused_reason:
--     'diamond_staff_session_required'}, as they answer platform_staff_only;
--   the two incident doors answer {success: false, error:
--     'authentication_required'}, the code they already give a missing
--     account and the desk already reads as "Sign In Again To Review Diamond
--     Incidents".
-- Nothing else in any body changes: each door is pinned to its live md5 and
-- redefined in full from that exact text plus the one check. No new object,
-- no grant changes (authenticated and service_role keep EXECUTE, anon and
-- PUBLIC have none), no switch opens. None of the ten is on the guard
-- watchlist; nothing inside the database calls any of them.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_poker_diamond_open_cash_table         2138b087d05ff2d955f094e386b79bc1
--   fn_poker_diamond_set_table_straddle      1c1fc8287aa28a9d5e32e26e0e65c902
--   fn_poker_diamond_set_table_run_it_twice  28245a7edbc2b9679075d1976553c817
--   fn_poker_diamond_set_table_bomb_pot      f2aab78a92d0728c7303f00394089a25
--   fn_ca_diamond_adjustment_propose         b91c395cd31fa5eeeca43a3b841a6659
--   fn_ca_diamond_adjustment_approve         611f14b9610294426c7809414c52a216
--   fn_ca_diamond_adjustment_reject          56ff1a2e519d61965b10b9c6521106ba
--   fn_ca_diamond_adjustment_settle          50db88d01f931d157268d6adc033ac72
--   fn_ca_diamond_incident_review            fbf3786814730bcb30353a6fe31731d9
--   fn_ca_diamond_incident_resolve_family    8345bdab05012dc989014a8455fecd26
--
-- @live-proof: position('fn_caller_session_is_live()' in pg_get_functiondef('public.fn_poker_diamond_open_cash_table(text,integer,integer,integer,integer,integer,text)'::regprocedure)) > 0
-- @live-proof: position('fn_caller_session_is_live()' in pg_get_functiondef('public.fn_poker_diamond_set_table_straddle(uuid,boolean,boolean)'::regprocedure)) > 0
-- @live-proof: position('fn_caller_session_is_live()' in pg_get_functiondef('public.fn_poker_diamond_set_table_run_it_twice(uuid,boolean)'::regprocedure)) > 0
-- @live-proof: position('fn_caller_session_is_live()' in pg_get_functiondef('public.fn_poker_diamond_set_table_bomb_pot(uuid,boolean,integer,smallint)'::regprocedure)) > 0
-- @live-proof: position('fn_caller_session_is_live()' in pg_get_functiondef('public.fn_ca_diamond_adjustment_propose(text,uuid,numeric,text)'::regprocedure)) > 0
-- @live-proof: position('fn_caller_session_is_live()' in pg_get_functiondef('public.fn_ca_diamond_adjustment_approve(uuid,text)'::regprocedure)) > 0
-- @live-proof: position('fn_caller_session_is_live()' in pg_get_functiondef('public.fn_ca_diamond_adjustment_reject(uuid,text)'::regprocedure)) > 0
-- @live-proof: position('fn_caller_session_is_live()' in pg_get_functiondef('public.fn_ca_diamond_adjustment_settle(uuid)'::regprocedure)) > 0
-- @live-proof: position('fn_caller_session_is_live()' in pg_get_functiondef('public.fn_ca_diamond_incident_review(bigint,text,text)'::regprocedure)) > 0
-- @live-proof: position('fn_caller_session_is_live()' in pg_get_functiondef('public.fn_ca_diamond_incident_resolve_family(text,text,timestamp with time zone,text)'::regprocedure)) > 0
-- ============================================================================

DO $m$
DECLARE r record; v_md5 text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'a Diamond switch is already open; this migration expects both closed';
  END IF;
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_poker_diamond_open_cash_table(text,integer,integer,integer,integer,integer,text)', '2138b087d05ff2d955f094e386b79bc1'),
    ('public.fn_poker_diamond_set_table_straddle(uuid,boolean,boolean)', '1c1fc8287aa28a9d5e32e26e0e65c902'),
    ('public.fn_poker_diamond_set_table_run_it_twice(uuid,boolean)', '28245a7edbc2b9679075d1976553c817'),
    ('public.fn_poker_diamond_set_table_bomb_pot(uuid,boolean,integer,smallint)', 'f2aab78a92d0728c7303f00394089a25'),
    ('public.fn_ca_diamond_adjustment_propose(text,uuid,numeric,text)', 'b91c395cd31fa5eeeca43a3b841a6659'),
    ('public.fn_ca_diamond_adjustment_approve(uuid,text)', '611f14b9610294426c7809414c52a216'),
    ('public.fn_ca_diamond_adjustment_reject(uuid,text)', '56ff1a2e519d61965b10b9c6521106ba'),
    ('public.fn_ca_diamond_adjustment_settle(uuid)', '50db88d01f931d157268d6adc033ac72'),
    ('public.fn_ca_diamond_incident_review(bigint,text,text)', 'fbf3786814730bcb30353a6fe31731d9'),
    ('public.fn_ca_diamond_incident_resolve_family(text,text,timestamp with time zone,text)', '8345bdab05012dc989014a8455fecd26')
  ) AS t(sig, pin)
  LOOP
    v_md5 := md5(pg_get_functiondef(r.sig::regprocedure));
    IF v_md5 <> r.pin THEN
      RAISE EXCEPTION '% is not the pinned text (md5 %, pinned %)', r.sig, v_md5, r.pin;
    END IF;
  END LOOP;
END $m$;

-- ---------------------------------------------------------------------------
-- 1. THE FOUR TABLE DOORS: RAISE, AS THEIR FIVE SIBLINGS DO
-- ---------------------------------------------------------------------------

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
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE = '28000';
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
$function$;

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
 IF NOT public.fn_caller_session_is_live() THEN
  RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';
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
END $function$;

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
 IF NOT public.fn_caller_session_is_live() THEN
  RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';
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
END $function$;

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
 IF NOT public.fn_caller_session_is_live() THEN
  RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';
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
END $function$;

-- ---------------------------------------------------------------------------
-- 2. THE FOUR ADJUSTMENT DOORS: A NAMED REFUSAL, AS THEY ANSWER EVERY OTHER
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_adjustment_propose(p_target_kind text, p_target_id uuid, p_amount numeric, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_uid   uuid := auth.uid();
  v_kind  text := lower(btrim(COALESCE(p_target_kind, '')));
  v_label text;
BEGIN
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'platform_staff_only');
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'diamond_staff_session_required');
  END IF;
  IF v_kind NOT IN ('diamond_wallet', 'diamond_house') THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_a_diamond_target', 'target_kind', v_kind);
  END IF;
  IF v_kind = 'diamond_wallet'
     AND (p_target_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_target_id)) THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'player_not_found', 'target_id', p_target_id);
  END IF;
  IF v_kind = 'diamond_house' AND p_target_id IS NOT NULL AND p_target_id <> c_house THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'the_house_target_is_the_house_sentinel_or_null',
      'target_id', p_target_id);
  END IF;
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text) INTO v_label
    FROM public.profiles p WHERE p.id = v_uid;
  RETURN public.fn_ca_propose_manual_adjustment(
           p_reason, p_amount, v_kind,
           CASE WHEN v_kind = 'diamond_house' THEN c_house ELSE p_target_id END,
           NULL, v_uid, v_label, 'diamonds');
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_adjustment_approve(p_adjustment_id uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_asset text;
  v_label text;
BEGIN
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'platform_staff_only');
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'diamond_staff_session_required');
  END IF;
  SELECT a.asset INTO v_asset FROM public.ca_manual_adjustments a WHERE a.id = p_adjustment_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_found', 'adjustment_id', p_adjustment_id);
  END IF;
  IF v_asset IS DISTINCT FROM 'diamonds' THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_a_diamond_adjustment',
      'adjustment_id', p_adjustment_id, 'asset', v_asset);
  END IF;
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text) INTO v_label
    FROM public.profiles p WHERE p.id = v_uid;
  RETURN public.fn_ca_approve_manual_adjustment(p_adjustment_id, v_uid, v_label, p_note);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_adjustment_reject(p_adjustment_id uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_asset text;
  v_label text;
BEGIN
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'platform_staff_only');
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'diamond_staff_session_required');
  END IF;
  SELECT a.asset INTO v_asset FROM public.ca_manual_adjustments a WHERE a.id = p_adjustment_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_found', 'adjustment_id', p_adjustment_id);
  END IF;
  IF v_asset IS DISTINCT FROM 'diamonds' THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_a_diamond_adjustment',
      'adjustment_id', p_adjustment_id, 'asset', v_asset);
  END IF;
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text) INTO v_label
    FROM public.profiles p WHERE p.id = v_uid;
  RETURN public.fn_ca_reject_manual_adjustment(p_adjustment_id, p_note, v_uid, v_label);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_adjustment_settle(p_adjustment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_house   constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_uid     uuid := auth.uid();
  v_label   text;
  v_adj     public.ca_manual_adjustments%ROWTYPE;
  v_src     public.ca_diamond_correction_source%ROWTYPE;
  v_prior   public.ca_diamond_adjustment_receipts%ROWTYPE;
  v_n       numeric;
  v_credit  boolean;
  v_player  boolean;
  v_reason  text;
  v_plan    text[];
  v_step    text;
  v_holder  text;
  v_key     text;
  v_leg     jsonb;
  v_legs    jsonb := '[]'::jsonb;
  v_moved   numeric := 0;
  v_refusal jsonb;
  v_receipt jsonb;
BEGIN
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'platform_staff_only');
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'diamond_staff_session_required');
  END IF;

  SELECT * INTO v_adj FROM public.ca_manual_adjustments WHERE id = p_adjustment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_found', 'adjustment_id', p_adjustment_id);
  END IF;
  IF v_adj.asset IS DISTINCT FROM 'diamonds' OR v_adj.target_kind NOT IN ('diamond_wallet', 'diamond_house') THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_a_diamond_adjustment',
      'adjustment_id', p_adjustment_id, 'asset', v_adj.asset, 'target_kind', v_adj.target_kind);
  END IF;

  -- EXACTLY ONCE. The row is locked, so a second caller waits here and then
  -- reads what the first committed: a replay moves nothing and answers what
  -- the settlement answered.
  IF v_adj.status = 'settled' THEN
    SELECT * INTO v_prior FROM public.ca_diamond_adjustment_receipts WHERE adjustment_id = v_adj.id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'refused_reason', 'settled_without_a_receipt',
        'adjustment_id', p_adjustment_id);
    END IF;
    RETURN v_prior.receipt || jsonb_build_object('replayed', true);
  END IF;
  IF v_adj.status <> 'approved' THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_approved',
      'adjustment_id', p_adjustment_id, 'status', v_adj.status);
  END IF;

  -- WHAT PAYS IS DAN'S (decision 2). No row: nothing moves.
  SELECT * INTO v_src FROM public.ca_diamond_correction_source WHERE id = 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'diamond_correction_source_not_authorized',
      'adjustment_id', p_adjustment_id);
  END IF;

  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text) INTO v_label
    FROM public.profiles p WHERE p.id = v_uid;
  v_n      := abs(v_adj.amount);
  v_credit := v_adj.amount > 0;
  v_player := v_adj.target_kind = 'diamond_wallet';
  -- Each step is <mint|burn>:<player|house>, in the order the Mint runs them.
  -- A house row has no counterparty but the register, whatever pays.
  v_plan := CASE
    WHEN v_player AND v_src.source = 'diamond_house' AND v_credit THEN ARRAY['burn:house', 'mint:player']
    WHEN v_player AND v_src.source = 'diamond_house' THEN ARRAY['burn:player', 'mint:house']
    WHEN v_player AND v_credit THEN ARRAY['mint:player']
    WHEN v_player THEN ARRAY['burn:player']
    WHEN v_credit THEN ARRAY['mint:house']
    ELSE ARRAY['burn:house']
  END;
  v_reason := format('Diamond adjustment %s (proposed by %s, approved by %s): %s',
                     v_adj.id, COALESCE(v_adj.actor_label, v_adj.actor::text),
                     COALESCE(v_adj.approver_label, v_adj.approver::text), v_adj.reason);

  BEGIN
    FOREACH v_step IN ARRAY v_plan LOOP
      v_holder := split_part(v_step, ':', 2);
      v_key    := 'diamond-adjustment:' || v_adj.id::text || ':' || v_step;
      IF split_part(v_step, ':', 1) = 'mint' THEN
        v_leg := public.fn_ca_mint('diamonds', v_holder,
                   CASE WHEN v_holder = 'house' THEN c_house ELSE v_adj.target_id END,
                   v_n, v_reason, v_key, 'admin');
      ELSE
        v_leg := public.fn_ca_burn('diamonds', v_holder,
                   CASE WHEN v_holder = 'house' THEN c_house ELSE v_adj.target_id END,
                   v_n, v_reason, v_key, 'admin');
      END IF;
      IF COALESCE((v_leg ->> 'ok')::boolean, false) IS NOT TRUE THEN
        v_refusal := jsonb_build_object('ok', false,
          'refused_reason', COALESCE(v_leg ->> 'reason', 'the_mint_refused'),
          'adjustment_id', p_adjustment_id, 'status', 'approved', 'source', v_src.source,
          'leg', v_step, 'mint_answer', v_leg);
        RAISE EXCEPTION 'a Diamond adjustment leg was refused' USING ERRCODE = 'P0961';
      END IF;
      IF COALESCE((v_leg ->> 'replayed')::boolean, false) THEN
        RAISE EXCEPTION 'Diamond adjustment %: the Mint had already answered op id %; refusing to record a settlement this door did not make',
          v_adj.id, v_key;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger m
                      WHERE m.op_id = v_key AND m.asset = 'diamonds' AND m.amount = v_n
                        AND m.action = split_part(v_step, ':', 1) AND m.holder_type = v_holder) THEN
        RAISE EXCEPTION 'Diamond adjustment %: the register does not carry leg %', v_adj.id, v_step;
      END IF;
      v_moved := v_moved + CASE WHEN split_part(v_step, ':', 1) = 'mint' THEN v_n ELSE -v_n END;
      v_legs  := v_legs || jsonb_build_array(v_leg);
    END LOOP;

    v_receipt := jsonb_build_object(
      'ok', true, 'replayed', false, 'adjustment_id', v_adj.id, 'status', 'settled',
      'asset', 'diamonds', 'target_kind', v_adj.target_kind, 'target_id', v_adj.target_id,
      'amount', v_adj.amount, 'direction', CASE WHEN v_credit THEN 'credit' ELSE 'debit' END,
      'source', v_src.source, 'supply_moved', v_moved, 'legs', v_legs, 'reason', v_adj.reason,
      'proposed_by', v_adj.actor, 'proposed_by_label', v_adj.actor_label,
      'approved_by', v_adj.approver, 'approved_by_label', v_adj.approver_label,
      'approved_at', v_adj.approved_at,
      'settled_by', v_uid, 'settled_by_label', v_label, 'settled_at', now());
    INSERT INTO public.ca_diamond_adjustment_receipts
      (adjustment_id, target_kind, target_id, amount, source, settled_by, settled_by_label, receipt)
    VALUES
      (v_adj.id, v_adj.target_kind, v_adj.target_id, v_adj.amount, v_src.source, v_uid, v_label, v_receipt);
    UPDATE public.ca_manual_adjustments SET status = 'settled'
     WHERE id = v_adj.id AND status = 'approved';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Diamond adjustment %: the approved row could not be marked settled', v_adj.id;
    END IF;
  EXCEPTION WHEN SQLSTATE 'P0961' THEN
    IF v_refusal IS NULL THEN
      RAISE;
    END IF;
    RETURN v_refusal;
  END;
  RETURN v_receipt;
END $function$;

-- ---------------------------------------------------------------------------
-- 3. THE TWO INCIDENT DOORS: THE CODE THEY ALREADY GIVE A MISSING ACCOUNT
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_incident_review(p_incident_id bigint, p_action text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_row public.ca_diamond_incidents;
  v_label text;
  v_event bigint;
  v_previous jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('acknowledge', 'comment', 'resolve', 'reopen') THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown_action');
  END IF;
  IF length(v_note) > 2000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'note_too_long');
  END IF;
  IF p_action = 'comment' AND v_note IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'note_required');
  END IF;
  IF p_action IN ('resolve', 'reopen') AND COALESCE(length(v_note), 0) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'reason_required');
  END IF;

  SELECT * INTO v_row FROM public.ca_diamond_incidents WHERE id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'incident_not_found');
  END IF;
  v_label := public.fn_ca_diamond_incident_actor_label(v_uid);

  IF p_action = 'acknowledge' THEN
    IF v_row.resolved_at IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_resolved',
                                'incident', public.fn_ca_diamond_incident_json(v_row));
    END IF;
    IF v_row.acknowledged_at IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_acknowledged',
                                'incident', public.fn_ca_diamond_incident_json(v_row));
    END IF;
    PERFORM set_config('ca.diamond_incident_review', 'person', true);
    UPDATE public.ca_diamond_incidents
       SET acknowledged_at = now(), acknowledged_by = v_uid
     WHERE id = p_incident_id
    RETURNING * INTO v_row;
    PERFORM set_config('ca.diamond_incident_review', '', true);
  ELSIF p_action = 'resolve' THEN
    IF v_row.resolved_at IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_resolved',
                                'incident', public.fn_ca_diamond_incident_json(v_row));
    END IF;
    PERFORM set_config('ca.diamond_incident_review', 'person', true);
    UPDATE public.ca_diamond_incidents
       SET resolved_at = now(), resolved_by = v_uid, resolution = v_note
     WHERE id = p_incident_id
    RETURNING * INTO v_row;
    PERFORM set_config('ca.diamond_incident_review', '', true);
  ELSIF p_action = 'reopen' THEN
    IF v_row.resolved_at IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'not_resolved',
                                'incident', public.fn_ca_diamond_incident_json(v_row));
    END IF;
    v_previous := jsonb_build_object(
      'resolved_at', v_row.resolved_at, 'resolved_by', v_row.resolved_by,
      'resolution', v_row.resolution,
      'closed_by', public.fn_ca_diamond_incident_json(v_row) -> 'closed_by',
      'acknowledged_at', v_row.acknowledged_at, 'acknowledged_by', v_row.acknowledged_by);
    PERFORM set_config('ca.diamond_incident_review', 'person', true);
    UPDATE public.ca_diamond_incidents
       SET resolved_at = NULL, resolved_by = NULL, resolution = NULL,
           acknowledged_at = NULL, acknowledged_by = NULL,
           reopened_at = now(), reopened_by = v_uid
     WHERE id = p_incident_id
    RETURNING * INTO v_row;
    PERFORM set_config('ca.diamond_incident_review', '', true);
  END IF;

  INSERT INTO public.ca_diamond_incident_events (incident_id, kind, actor, actor_label, detail)
  VALUES (p_incident_id,
          CASE p_action WHEN 'acknowledge' THEN 'acknowledged' WHEN 'comment' THEN 'comment'
                        WHEN 'resolve' THEN 'resolved' ELSE 'reopened' END,
          v_uid, v_label,
          jsonb_build_object('note', v_note, 'rule', v_row.rule, 'severity', v_row.severity)
            || CASE WHEN v_previous IS NULL THEN '{}'::jsonb
                    ELSE jsonb_build_object('previous', v_previous) END)
  RETURNING id INTO v_event;

  RETURN jsonb_build_object('success', true, 'action', p_action, 'event_id', v_event,
                            'incident', public.fn_ca_diamond_incident_json(v_row));
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_incident_resolve_family(p_family text, p_severity text, p_filed_before timestamp with time zone, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_family text := NULLIF(btrim(COALESCE(p_family, '')), '');
  v_note text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_before timestamptz := LEAST(COALESCE(p_filed_before, now()), now());
  v_act uuid := gen_random_uuid();
  v_label text;
  v_held integer;
  v_resolved integer;
  v_by_rule jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF v_family IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'family_required');
  END IF;
  IF p_severity IS NOT NULL AND p_severity NOT IN ('info', 'warning', 'critical') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_severity');
  END IF;
  IF length(v_note) > 2000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'note_too_long');
  END IF;
  IF COALESCE(length(v_note), 0) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'reason_required');
  END IF;
  v_label := public.fn_ca_diamond_incident_actor_label(v_uid);

  SELECT count(*) INTO v_held
    FROM public.ca_diamond_incidents i
   WHERE (i.rule = v_family OR (strpos(v_family, ':') = 0 AND split_part(i.rule, ':', 1) = v_family))
     AND (p_severity IS NULL OR i.severity = p_severity)
     AND i.resolved_at IS NULL AND i.occurred_at <= v_before
     AND i.reopened_by IS NOT NULL;

  PERFORM set_config('ca.diamond_incident_review', 'person', true);
  WITH closed AS (
    UPDATE public.ca_diamond_incidents i
       SET resolved_at = now(), resolved_by = v_uid, resolution = v_note
     WHERE (i.rule = v_family OR (strpos(v_family, ':') = 0 AND split_part(i.rule, ':', 1) = v_family))
       AND (p_severity IS NULL OR i.severity = p_severity)
       AND i.resolved_at IS NULL AND i.occurred_at <= v_before
       AND i.reopened_by IS NULL
    RETURNING i.id, i.rule, i.severity
  ), logged AS (
    INSERT INTO public.ca_diamond_incident_events (incident_id, kind, actor, actor_label, detail)
    SELECT c.id, 'resolved', v_uid, v_label,
           jsonb_build_object('note', v_note, 'rule', c.rule, 'severity', c.severity, 'act', v_act,
                              'family', v_family, 'severity_filter', p_severity,
                              'filed_before', v_before)
      FROM closed c
    RETURNING incident_id
  )
  SELECT (SELECT count(*) FROM logged),
         COALESCE((SELECT jsonb_object_agg(g.rule, g.n)
                     FROM (SELECT c.rule, count(*) AS n FROM closed c GROUP BY c.rule) g), '{}'::jsonb)
    INTO v_resolved, v_by_rule;
  PERFORM set_config('ca.diamond_incident_review', '', true);

  IF v_resolved = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'nothing_to_resolve', 'skipped_reopened', v_held);
  END IF;
  RETURN jsonb_build_object('success', true, 'act_id', v_act, 'family', v_family,
    'severity', p_severity, 'filed_before', v_before, 'resolved', v_resolved,
    'skipped_reopened', v_held, 'by_rule', v_by_rule);
END $function$;

-- ---------------------------------------------------------------------------
-- 4. EVERY EDIT LANDED, AND THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE r record; v_txt text; v_bad text; v_staff int; v_live int;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_poker_diamond_open_cash_table(text,integer,integer,integer,integer,integer,text)', 'diamond_staff_session_required'),
    ('public.fn_poker_diamond_set_table_straddle(uuid,boolean,boolean)', 'diamond_staff_session_required'),
    ('public.fn_poker_diamond_set_table_run_it_twice(uuid,boolean)', 'diamond_staff_session_required'),
    ('public.fn_poker_diamond_set_table_bomb_pot(uuid,boolean,integer,smallint)', 'diamond_staff_session_required'),
    ('public.fn_ca_diamond_adjustment_propose(text,uuid,numeric,text)', 'diamond_staff_session_required'),
    ('public.fn_ca_diamond_adjustment_approve(uuid,text)', 'diamond_staff_session_required'),
    ('public.fn_ca_diamond_adjustment_reject(uuid,text)', 'diamond_staff_session_required'),
    ('public.fn_ca_diamond_adjustment_settle(uuid)', 'diamond_staff_session_required'),
    ('public.fn_ca_diamond_incident_review(bigint,text,text)', 'authentication_required'),
    ('public.fn_ca_diamond_incident_resolve_family(text,text,timestamp with time zone,text)', 'authentication_required')
  ) AS t(sig, refusal)
  LOOP
    v_txt := pg_get_functiondef(r.sig::regprocedure);
    IF (length(v_txt) - length(replace(v_txt, 'fn_caller_session_is_live()', ''))) / length('fn_caller_session_is_live()') <> 1 THEN
      RAISE EXCEPTION '% does not ask for a live session exactly once', r.sig;
    END IF;
    v_staff := position('NOT public.fn_is_platform_admin()' IN v_txt);
    v_live := position('NOT public.fn_caller_session_is_live()' IN v_txt);
    IF v_staff = 0 OR v_live < v_staff THEN
      RAISE EXCEPTION '% does not ask for the session right after the staff check', r.sig;
    END IF;
    IF position(r.refusal IN substr(v_txt, v_live, 200)) = 0 THEN
      RAISE EXCEPTION '% does not refuse a dead session as %', r.sig, r.refusal;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = r.sig::regprocedure) THEN
      RAISE EXCEPTION '% is no longer SECURITY DEFINER', r.sig;
    END IF;
    IF has_function_privilege('anon', r.sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable without an account', r.sig;
    END IF;
    IF NOT has_function_privilege('authenticated', r.sig::regprocedure, 'EXECUTE')
       OR NOT has_function_privilege('service_role', r.sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '% lost the grants the Staff Desk calls it with', r.sig;
    END IF;
  END LOOP;
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
  RAISE NOTICE 'every Diamond staff door needs a live session: ten doors ask, each in its own words; nothing else changed';
END $m$;
