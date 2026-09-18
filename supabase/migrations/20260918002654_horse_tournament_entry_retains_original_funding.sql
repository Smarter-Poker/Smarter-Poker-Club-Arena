-- Live entry evidence showed the separate original horse registration owner
-- bypassed the human registration producer installed by20260917233447.
-- Both recurring MTT and seat-first horse callers reach this same chip debit
-- owner. Retain its actual entitlement/wallet/registration IDs prospectively.
-- Preserve all entry, ticket, lease, capacity and financial policy; no backfill.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
DO $precondition$
BEGIN
 IF md5(pg_get_functiondef('public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)'::regprocedure)) IS DISTINCT FROM '5c0d7ef4dd486dd0ee843f26911fa413'
 OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)'::regprocedure) IS DISTINCT FROM 'postgres'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' THEN
  RAISE EXCEPTION 'Original horse tournament funding owner changed';
 END IF;
 IF to_regclass('public.tournament_participant_funding_receipts') IS NULL
 OR to_regprocedure('public.fn_ca_record_tournament_participant_funding(uuid,text,text,numeric,text,uuid,uuid,jsonb)') IS NULL
 OR  md5(pg_get_functiondef('public.fn_ca_capture_tournament_charge_entitlement()'::regprocedure)) IS DISTINCT FROM '9ec1394628e0c6291963d5f76801a3d1' OR
 md5(pg_get_functiondef('public.fn_ca_record_tournament_participant_funding(uuid,text,text,numeric,text,uuid,uuid,jsonb)'::regprocedure)) IS DISTINCT FROM '6cfd4af7307ce31460fd62c5b3f38bef' OR
 md5(pg_get_functiondef('public.log_wallet_transaction(uuid,text,numeric,text,text,text,uuid,uuid,uuid)'::regprocedure)) IS DISTINCT FROM '8316c567cd3517cc391c11f7b7059c4b' THEN
  RAISE EXCEPTION 'Original tournament provenance33447 prerequisite is missing';
 END IF;
END $precondition$;
CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_original_entitlement uuid; v_original_wallet uuid;
  v_t record; v_username text;
  v_split record;
  v_is_bounty boolean; v_head numeric := 0;
  v_player_id uuid;
  v_is_horse boolean;
  v_ok boolean;
  v_late_open boolean := false;
  v_start_chips integer := 0;
  v_players_before integer;
  v_expected_cached_players integer;
  v_rows integer;
  v_seat jsonb := NULL;
  v_seat_reason text;
  v_led_cat text; v_led_cp text; v_led_ent text; v_led_tid text; -- CHIP STANDARD 1.2 2026-09-02
BEGIN
  SELECT is_horse INTO v_is_horse FROM public.profiles WHERE id = p_user_id;
  IF NOT COALESCE(v_is_horse, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_horse');
  END IF;

  SELECT id, status, buy_in_amount, buy_in_fee, max_players, current_players,
         club_id, name, is_bounty, is_pko, is_mystery_bounty,
         bounty_amount, start_time, early_bird_enabled, early_bird_chips,
         prize_pool_finalized
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;

  -- THE HUMAN DOOR'S STATUS TEST (2026-09-11). A finalized pool takes no
  -- entrant and says so as a reason; a RUNNING event admits an entrant while
  -- its late registration is open, exactly as fn_register_for_tournament does.
  IF COALESCE(v_t.prize_pool_finalized, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;
  IF v_t.status = 'RUNNING' THEN
    v_late_open := public.fn_tournament_late_registration_open(p_tournament_id);
  END IF;
  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') AND NOT v_late_open THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;

  SELECT count(*)::integer INTO v_players_before
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  IF v_t.current_players IS DISTINCT FROM v_players_before THEN
    RAISE EXCEPTION
      'Tournament roster cache diverged before horse registration (cached %, actual %)',
      v_t.current_players,v_players_before
      USING ERRCODE='P0404';
  END IF;
  /* ONE DEFINITION OF FULL (2026-09-06). This read `current_players >=
     max_players`, and on a seat-first event that column is overwritten with
     the live SEATED count - so an emptied seat read as a vacancy and this
     function walked back through the door, up to 32 paid entries into a
     two-handed sit-and-go. fn_enforce_tournament_capacity is the authority
     and would now refuse the insert outright; asking here keeps the refusal a
     reason rather than an exception, and rolls back nothing. */
  IF public.fn_tournament_entry_cap_reached(p_tournament_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_full');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players
              WHERE tournament_id = p_tournament_id AND user_id = p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  IF COALESCE(v_t.early_bird_enabled, false)
     AND now() < v_t.start_time
     AND COALESCE(v_t.early_bird_chips, 0) > 0 THEN
    v_start_chips := v_t.early_bird_chips;
  END IF;

  SELECT COALESCE(NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_username FROM public.profiles WHERE id = p_user_id;

  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);

  IF v_is_bounty AND v_split.prize < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'misconfigured_bounty');
  END IF;

  -- MYSTERY BOUNTY 2026-08-25: no roll here either. A horse and a human must
  -- enter the same event on the same terms; when the two register functions
  -- disagreed about how a bounty head was set, they were two tournaments.
  IF v_is_bounty THEN
    v_head := v_split.bounty;
  END IF;

  IF v_split.charge > 0 THEN
    -- CHIP STANDARD 1.2 (2026-09-02): THE HORSE DOOR DECLARES EXACTLY AS THE HUMAN
    -- DOOR (R11 - horses and humans are identical on every path). The wallet write
    -- below is journaled by trg_club_members_audit_chip_movement; undeclared it landed
    -- as adjustment player_wallet -> table_stack with no tournament. set_config, not
    -- fn_ca_declare_ledger, for the same reason as fn_register_for_tournament: a
    -- vocabulary miss must never refuse a buy-in. Restored right after the write.
    v_led_cat := current_setting('app.ledger_category', true);
    v_led_cp  := current_setting('app.ledger_counterparty', true);
    v_led_ent := current_setting('app.ledger_counterparty_entity', true);
    v_led_tid := current_setting('app.ledger_tournament', true);
    PERFORM set_config('app.ledger_category', 'tournament_buyin', true);
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);
    PERFORM set_config('app.ledger_tournament', p_tournament_id::text, true);
    PERFORM set_config('app.pnl_tournament_entitlement','',true);
    v_ok := public.atomic_deduct_wallet_and_log(
      p_user_id, v_split.charge, 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
    v_original_entitlement:=NULLIF(current_setting('app.pnl_tournament_entitlement',true),'')::uuid;
    PERFORM set_config('app.ledger_category', COALESCE(v_led_cat, ''), true);
    PERFORM set_config('app.ledger_counterparty', COALESCE(v_led_cp, ''), true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(v_led_ent, ''), true);
    PERFORM set_config('app.ledger_tournament', COALESCE(v_led_tid, ''), true);
    IF NOT COALESCE(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance');
    END IF;
    PERFORM set_config('app.pnl_tournament_wallet_tx','',true);
    PERFORM public.log_wallet_transaction(
      p_user_id, 'PLAYER', v_split.charge, 'debit', 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
    v_original_wallet:=NULLIF(current_setting('app.pnl_tournament_wallet_tx',true),'')::uuid;
  END IF;

  BEGIN
    IF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status, current_bounty,
         mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, p_user_id, COALESCE(v_username,'Player'), v_start_chips,
              'registered', v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;
    ELSE
      INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status)
      VALUES (p_tournament_id, p_user_id, COALESCE(v_username,'Player'), v_start_chips, 'registered')
      RETURNING id INTO v_player_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION
      'Horse tournament registration identity changed after its atomic debit; retry the complete transaction'
      USING ERRCODE = '40001';
  END;

  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players, bbj_contribution,
       is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_split.rake, v_split.charge, 1, 0, true, p_tournament_id,
            'fn_register_horse_for_tournament',
            jsonb_build_object('kind','tournament_entry_fee','user_id',p_user_id,
                               'registration_id',v_player_id));
  END IF;

  -- The roster trigger refreshes the cached count while ANNOUNCED/REGISTERING
  -- and leaves RUNNING to the transaction that seats the late entrant - the
  -- same expectation the human core holds.
  v_expected_cached_players := CASE
    WHEN v_t.status IN ('ANNOUNCED','REGISTERING') THEN v_players_before + 1
    ELSE v_players_before
  END;
  UPDATE public.tournaments
     SET current_players = v_players_before + 1,
         prize_pool  = COALESCE(prize_pool, 0)  + v_split.prize,
         bounty_pool = COALESCE(bounty_pool, 0) + v_split.bounty,
         total_rake  = COALESCE(total_rake, 0)  + v_split.rake
   WHERE id = p_tournament_id
     AND current_players IS NOT DISTINCT FROM v_expected_cached_players;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION
      'Tournament roster cache changed during horse registration'
      USING ERRCODE='40001';
  END IF;

  -- LATE SEAT, as the human core does it: an entrant who cannot be seated is
  -- not charged - the 55000 abort rolls the debit, the roster row, the rake
  -- record and the pool increments back together.
  IF v_late_open THEN
    v_seat := public.fn_seat_late_registrant(p_tournament_id, p_user_id);
    v_seat_reason := v_seat->>'reason';
    IF NOT COALESCE((v_seat->>'ok')::boolean, false)
       AND COALESCE(v_seat_reason, '') <> 'already_seated_or_missing' THEN
      RAISE EXCEPTION
        'Late registration could not seat the player (%) - no charge has been made',
        COALESCE(v_seat_reason, 'unknown')
        USING ERRCODE = '55000';
    END IF;
  END IF;

  -- This original owner charged chips; the public Diamond refusal and ticket
  -- owner remain unchanged. Bind only this transaction's actual debit IDs.
  PERFORM public.fn_ca_record_tournament_participant_funding(v_player_id,'entry',NULL,
    v_split.charge,'chips',v_original_entitlement,v_original_wallet,NULL);

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
    'cost', v_split.charge, 'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty, 'rake', v_split.rake,
    'late_registration', v_late_open,
    'seat', v_seat);
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid) TO postgres;
COMMIT;
