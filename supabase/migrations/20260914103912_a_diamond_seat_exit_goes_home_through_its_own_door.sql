-- ============================================================================
-- A DIAMOND SEAT EXIT GOES HOME THROUGH ITS OWN DOOR
-- ============================================================================
--
-- Phase 8 of the Diamond Arena programme, found by the Phase 8 recheck of
-- 2026-09-14 and closed here. The lobby's unregistration door already routed
-- a Diamond entry to fn_poker_diamond_tournament_unregister. Five other
-- callers of the chip unregistration authority did not: the seat exit a
-- heads-up or sit-and-go player uses (fn_leave_seat_and_refund, both
-- overloads), the one-argument lobby door, the administrator's removal and
-- the launch's release of a registrant it could not seat. For a Diamond
-- event the chip authority either refused ("cannot leave divergent
-- tournament state", because a Diamond event writes no rake_records) or,
-- with no fee, deleted the roster row for a refund of nothing and left the
-- player's Diamonds in custody to be paid to the winners.
--
-- Three things change, each in place and each proved:
--
--   1. The chip unregistration authority itself sends a Diamond entry home
--      through its own door, before it touches a chip rail. Every caller,
--      present and future, is covered by that one line; a caller that named
--      no request id is given one exactly as the authority mints its own.
--      A seat exit that names a table the player does not sit at answers
--      not_seated, as the chip authority does, unless the request id has
--      already been settled (a replay is answered by its receipt).
--   2. The seat-first purchase receipt passes the asset and the Diamond
--      wallet after the charge through to the client, as the lobby receipt
--      does, so the balance on screen moves.
--   3. The Diamond door answers a replayed request id with the whole receipt
--      it gave the first time, rebuilt from the refund ledger row - the
--      client performs one exact replay after a lost response and parses it
--      as a receipt - and it keeps the chip authority's clock: a scheduled
--      event closes at its start time; a seat-first product (spin,
--      heads-up sit-and-go) closes when it actually starts; a launch
--      releasing an unseatable registrant is past the clock by design and
--      is held to the seat-first proofs; a persisted hand closes everything.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)), project kuklfnapbkmacvwxktbh:
--   fn_ca_unregister_tournament_player_exact(uuid, uuid, uuid, text, uuid)  46c455cf3f8195704da7182dc888fb30
--   fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid, integer)  14d555291b857c15912d4028828f3d5b
--   fn_poker_diamond_tournament_unregister(uuid, uuid, uuid)  84fc1ea36ee4338b646af2b4675aa70b
--
-- The two chip functions are edited by asserted substitution (pinned md5,
-- clause occurs exactly once, EXECUTE replace(), reverse substitution
-- reproduces the pinned text). The Diamond door is a Diamond function and is
-- redefined in full with the same signature, its md5 pinned first and the
-- redefinition declared to the guard watch. tournaments_enabled stays false;
-- this migration expects it closed. Applied once to kuklfnapbkmacvwxktbh.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. THE CHIP UNREGISTRATION AUTHORITY SENDS A DIAMOND ENTRY HOME
-- ---------------------------------------------------------------------------
DO $m8$
DECLARE
  v_oid oid := 'public.fn_ca_unregister_tournament_player_exact(uuid, uuid, uuid, text, uuid)'::regprocedure;
  v_def text; v_old text; v_new text; v_n integer;
BEGIN
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '46c455cf3f8195704da7182dc888fb30' THEN
    RAISE EXCEPTION 'fn_ca_unregister_tournament_player_exact is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);\n'
        || E'  SELECT * INTO v_t FROM public.tournaments t\n'
        || E'   WHERE t.id=p_tournament_id FOR UPDATE;';
  v_new := E'  -- DIAMOND PHASE 8: a Diamond entry never rode the chip rails. Every\n'
        || E'  -- caller of this authority (the lobby, the seat, the administrator, the\n'
        || E'  -- launch) sends it home through its own door before a chip rail is\n'
        || E'  -- touched. A caller that named no request id is given one exactly as\n'
        || E'  -- this authority mints its own. A seat exit naming a table the player\n'
        || E'  -- does not sit at answers not_seated unless its request id is already\n'
        || E'  -- settled, in which case the door replays that receipt.\n'
        || E'  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN\n'
        || E'    IF p_expected_table_id IS NOT NULL\n'
        || E'       AND NOT EXISTS (SELECT 1 FROM public.table_seats s\n'
        || E'                        WHERE s.table_id=p_expected_table_id AND s.user_id=p_user_id AND s.left_at IS NULL)\n'
        || E'       AND NOT (p_request_id IS NOT NULL AND EXISTS (\n'
        || E'                  SELECT 1 FROM public.poker_diamond_tournament_ledger l\n'
        || E'                   WHERE l.tournament_id=p_tournament_id AND l.user_id=p_user_id AND l.kind=''refund''\n'
        || E'                     AND l.request->>''request_id''=p_request_id::text)) THEN\n'
        || E'      RETURN jsonb_build_object(''ok'',false,''reason'',''not_seated'');\n'
        || E'    END IF;\n'
        || E'    RETURN public.fn_poker_diamond_tournament_unregister(\n'
        || E'      p_tournament_id, p_user_id, COALESCE(p_request_id, gen_random_uuid()));\n'
        || E'  END IF;\n'
        || v_old;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_ca_unregister_tournament_player_exact: the lane clause occurs % times, expected 1', v_n;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '46c455cf3f8195704da7182dc888fb30' THEN
    RAISE EXCEPTION 'fn_ca_unregister_tournament_player_exact: the reverse substitution does not reproduce the pinned text';
  END IF;
END
$m8$;

-- ---------------------------------------------------------------------------
-- 2. THE SEAT-FIRST RECEIPT NAMES ITS ASSET
--    fn_take_seat_and_buy_in and its terminal gate return the inner receipt
--    unchanged; the maintenance gate is the only builder on the path.
-- ---------------------------------------------------------------------------
DO $m8$
DECLARE
  v_oid oid := 'public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid, integer)'::regprocedure;
  v_def text; v_old text; v_new text; v_n integer;
BEGIN
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '14d555291b857c15912d4028828f3d5b' THEN
    RAISE EXCEPTION 'fn_take_seat_and_buy_in_before_maintenance_announcement_gate is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'    ''cost'', COALESCE((v_reg->>''cost'')::numeric, 0));';
  v_new := E'    ''cost'', COALESCE((v_reg->>''cost'')::numeric, 0))\n'
        || E'    -- DIAMOND PHASE 8: a Diamond seat purchase names its asset and the\n'
        || E'    -- wallet after the charge, as the lobby receipt does, so the client can\n'
        || E'    -- move the balance it shows. Absent on the already_registered answer,\n'
        || E'    -- which carries no charge.\n'
        || E'    || CASE WHEN v_reg ? ''asset''\n'
        || E'         THEN jsonb_build_object(''asset'', v_reg->''asset'', ''diamonds_after'', v_reg->''diamonds_after'')\n'
        || E'         ELSE ''{}''::jsonb END;';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the seat-first receipt clause occurs % times, expected 1', v_n;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '14d555291b857c15912d4028828f3d5b' THEN
    RAISE EXCEPTION 'the seat-first receipt: the reverse substitution does not reproduce the pinned text';
  END IF;
END
$m8$;

-- ---------------------------------------------------------------------------
-- 3. THE DIAMOND DOOR REPLAYS ITS RECEIPT AND KEEPS THE CHIP CLOCK
-- ---------------------------------------------------------------------------
DO $m8$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_poker_diamond_tournament_unregister(uuid, uuid, uuid)'::regprocedure)) INTO v_md5;
  IF v_md5 <> '84fc1ea36ee4338b646af2b4675aa70b' THEN
    RAISE EXCEPTION 'fn_poker_diamond_tournament_unregister is not the pinned text (md5 %)', v_md5;
  END IF;
END
$m8$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_unregister(p_tournament_id uuid, p_user_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE; v_reg public.tournament_players%ROWTYPE;
  v_refund jsonb; v_players_before integer; v_rows integer;
  v_prior public.poker_diamond_tournament_ledger%ROWTYPE; v_prior_reg uuid;
  v_authority text := 'scheduled_clock';
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'tournament, player and request ids are required' USING ERRCODE='22004';
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;

  -- A withdrawal that already happened answers with what it did: the same
  -- receipt the first answer carried, rebuilt from the refund ledger row
  -- (its registration id from the entry row of the same custody), so the
  -- client's one exact replay after a lost response is a receipt. The chip
  -- authority replays its stored receipt the same way, past the clock too.
  SELECT l.* INTO v_prior FROM public.poker_diamond_tournament_ledger l
   WHERE l.tournament_id=p_tournament_id AND l.user_id=p_user_id AND l.kind='refund'
     AND l.request->>'request_id'=p_request_id::text
   ORDER BY l.id LIMIT 1;
  IF FOUND THEN
    SELECT e.registration_id INTO v_prior_reg FROM public.poker_diamond_tournament_ledger e
     WHERE e.custody_id=v_prior.custody_id AND e.kind='entry'
     ORDER BY e.id LIMIT 1;
    RETURN jsonb_build_object('ok',true,'idempotent',true,'replayed',true,'fully_settled',true,'remaining',0,
      'request_id',p_request_id,
      'refunded_diamonds',v_prior.amount,'refund_prize',v_prior.prize_part,
      'refund_bounty',v_prior.bounty_part,'refund_fee',v_prior.fee_part,
      'registration_id',v_prior_reg,'custody_id',v_prior.custody_id,'obligation_id',v_prior.obligation_id,
      'asset','diamonds','diamonds_after',(SELECT p.diamonds FROM public.profiles p WHERE p.id=p_user_id));
  END IF;

  -- The start authority is the chip authority's. A scheduled event closes at
  -- its clock. A spin or a heads-up sit-and-go is seat-first: start_time is
  -- only its fill-window deadline, and it closes when it actually starts. A
  -- launch releasing a registrant it could not seat names its incomplete
  -- receipt through app.ca_launch_release_launch_id; it is past the clock by
  -- design and is held to the seat-first proofs instead. A persisted hand
  -- closes every product.
  IF v_t.satellite_target_id IS NULL
     AND upper(COALESCE(v_t.tournament_type::text,''))<>'SATELLITE'
     AND (lower(COALESCE(v_t.variant::text,''))='spin'
       OR upper(COALESCE(v_t.tournament_type::text,''))='SPIN') THEN
    v_authority := 'spin_actual_start';
  ELSIF v_t.satellite_target_id IS NULL
     AND upper(COALESCE(v_t.tournament_type::text,''))='SNG'
     AND lower(COALESCE(v_t.variant::text,''))<>'spin'
     AND COALESCE(v_t.max_players,0)=2 THEN
    v_authority := 'heads_up_sng_actual_start';
  END IF;
  IF v_authority='scheduled_clock' AND EXISTS (
       SELECT 1 FROM public.tournament_launch_receipts r
        WHERE r.tournament_id=p_tournament_id
          AND r.completed_at IS NULL
          AND r.launch_id::text=NULLIF(current_setting('app.ca_launch_release_launch_id',true),'')) THEN
    v_authority := 'launch_release';
  END IF;
  IF upper(COALESCE(v_t.status,'')) NOT IN ('ANNOUNCED','REGISTERING') OR v_t.started_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;
  IF EXISTS (SELECT 1 FROM public.hand_history hh WHERE hh.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tables ht JOIN public.hand_history hh ON hh.table_id=ht.id
                 WHERE ht.tournament_id=p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;
  IF v_authority='scheduled_clock' THEN
    IF v_t.start_time IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','registration_schedule_unset');
    END IF;
    IF clock_timestamp()>=v_t.start_time THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.tournament_launch_receipts r
                 WHERE r.tournament_id=p_tournament_id AND r.completed_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;

  SELECT * INTO v_reg FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id FOR UPDATE;
  IF v_reg.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','not_registered'); END IF;
  IF v_reg.status::text NOT IN ('registered','playing') THEN
    RETURN jsonb_build_object('ok',false,'reason','not_registered');
  END IF;
  SELECT count(*)::integer INTO v_players_before FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.status::text IN ('registered','playing');

  -- Money first: the release is the part that can refuse.
  v_refund := public.fn_poker_diamond_tournament_refund(
    p_tournament_id, p_user_id, 'unregister', 'fn_unregister_from_tournament', p_request_id);

  -- The same roster effects the chip authority produces, in the same order.
  UPDATE public.table_seats s
     SET left_at=transaction_timestamp(),status='left',leave_pending=false,
         is_sitting_out=false,is_away=false,sit_out_at=NULL,scheduled_leave_hands=NULL
   WHERE s.user_id=p_user_id AND s.left_at IS NULL
     AND EXISTS(SELECT 1 FROM public.tables tb WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id);
  UPDATE public.tables tb
     SET current_players=(SELECT count(*) FROM public.table_seats s WHERE s.table_id=tb.id AND s.left_at IS NULL),
         updated_at=now()
   WHERE tb.tournament_id=p_tournament_id;
  DELETE FROM public.tournament_players tp WHERE tp.id=v_reg.id;
  UPDATE public.tournaments
     SET current_players=v_players_before-1,
         prize_pool=round(COALESCE(prize_pool,0)-(v_refund->>'refund_prize')::numeric,2),
         bounty_pool=round(COALESCE(bounty_pool,0)-(v_refund->>'refund_bounty')::numeric,2),
         total_rake=round(COALESCE(total_rake,0)-(v_refund->>'refund_fee')::numeric,2),
         updated_at=now()
   WHERE id=p_tournament_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN RAISE EXCEPTION 'tournament vanished during unregistration' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('ok',true,'fully_settled',true,'remaining',0,'request_id',p_request_id,
    'refunded_diamonds',(v_refund->>'paid')::numeric,'refund_prize',(v_refund->>'refund_prize')::numeric,
    'refund_bounty',(v_refund->>'refund_bounty')::numeric,'refund_fee',(v_refund->>'refund_fee')::numeric,
    'registration_id',v_reg.id,'custody_id',v_refund->>'custody_id','obligation_id',v_refund->>'obligation_id',
    'asset','diamonds','diamonds_after',(SELECT p.diamonds FROM public.profiles p WHERE p.id=p_user_id));
END $function$;

REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_unregister(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

SELECT public.fn_ca_declare_guard_redefinition(
  'fn_poker_diamond_tournament_unregister',
  'migration a_diamond_seat_exit_goes_home_through_its_own_door');

-- ---------------------------------------------------------------------------
-- 4. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m8$
DECLARE
  v_txt text; v_idem text; v_key text; v_bad text; r record;
BEGIN
  -- (a) the authority routes, and every caller of it still reaches it
  v_txt := pg_get_functiondef('public.fn_ca_unregister_tournament_player_exact(uuid, uuid, uuid, text, uuid)'::regprocedure);
  IF position('public.fn_poker_diamond_tournament_unregister(' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the chip unregistration authority does not send a Diamond entry home';
  END IF;
  IF position(E'COALESCE(p_request_id, gen_random_uuid())' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the chip unregistration authority does not mint a request id for the Diamond door';
  END IF;
  FOR r IN SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, pg_get_functiondef(p.oid) AS def FROM pg_proc p
            WHERE p.pronamespace='public'::regnamespace
              AND p.proname IN ('fn_leave_seat_and_refund','fn_unregister_from_tournament',
                                'fn_admin_remove_tournament_player','fn_ca_release_unseatable_registrant_at_launch')
  LOOP
    IF position('public.fn_ca_unregister_tournament_player_exact(' IN r.def) = 0 THEN
      RAISE EXCEPTION '%(%) no longer reaches the unregistration authority', r.proname, r.args;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
       AND p.proname IN ('fn_leave_seat_and_refund','fn_unregister_from_tournament')) <> 4 THEN
    RAISE EXCEPTION 'the seat and lobby exit doors are not the four overloads this migration covers';
  END IF;

  -- (b) the replayed Diamond receipt names every key the client requires
  v_txt := pg_get_functiondef('public.fn_poker_diamond_tournament_unregister(uuid, uuid, uuid)'::regprocedure);
  v_idem := substring(v_txt FROM position('''idempotent'',true' IN v_txt) FOR 800);
  IF v_idem IS NULL OR length(v_idem) < 50 THEN
    RAISE EXCEPTION 'the Diamond unregister has no replay branch';
  END IF;
  v_idem := substring(v_idem FROM 1 FOR position('END IF;' IN v_idem));
  FOREACH v_key IN ARRAY ARRAY['''asset''','''request_id''','''registration_id''','''refunded_diamonds''','''diamonds_after'''] LOOP
    IF position(v_key IN v_idem) = 0 THEN
      RAISE EXCEPTION 'the replayed Diamond unregister receipt lacks %', v_key;
    END IF;
  END LOOP;
  -- and it keeps the chip clock
  FOREACH v_key IN ARRAY ARRAY['clock_timestamp()>=v_t.start_time','app.ca_launch_release_launch_id',
                               'heads_up_sng_actual_start','public.hand_history hh','registration_schedule_unset'] LOOP
    IF position(v_key IN v_txt) = 0 THEN
      RAISE EXCEPTION 'the Diamond unregister does not keep the chip clock (%)', v_key;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.fn_poker_diamond_tournament_unregister(uuid, uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_poker_diamond_tournament_unregister(uuid, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the Diamond unregister door is a browser door';
  END IF;

  -- (c) the seat-first receipt passes the Diamond fields through
  v_txt := pg_get_functiondef('public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid, integer)'::regprocedure);
  IF position('''diamonds_after'', v_reg->''diamonds_after''' IN v_txt) = 0 OR position('''asset'', v_reg->''asset''' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the seat-first receipt does not pass asset and diamonds_after through';
  END IF;

  -- (d) the tournament switch is still off
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open the tournament door';
  END IF;

  -- (e) every watched guard is on its baseline
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
  RAISE NOTICE 'a Diamond seat exit goes home through its own door: one authority routes, the receipt replays, the clock is kept, nothing opened';
END
$m8$;
