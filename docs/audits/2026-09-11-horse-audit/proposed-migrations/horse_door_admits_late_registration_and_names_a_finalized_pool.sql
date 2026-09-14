-- ═══════════════════════════════════════════════════════════════════════════
--  THE HORSE DOOR IS THE HUMAN DOOR (lane D audit, 2026-09-11) - NOT APPLIED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- CLAUDE.md 10.5: a horse enters a tournament through the same door a human
-- does. Read from pg_proc on 2026-09-11, the two doors differ in three ways
-- that deny a horse an entry a human gets:
--
--   1. LATE REGISTRATION. fn_register_for_tournament_before_atomic_capacity
--      admits a RUNNING event while fn_tournament_late_registration_open() is
--      true, and seats the entrant through fn_seat_late_registrant (the
--      "LATE SEAT 2026-08-23" block); its lifecycle gate retries a seat
--      shortage once through fn_ensure_late_registration_capacity and emits a
--      manager wake. fn_register_horse_for_tournament_before_maintenance_gate
--      refuses every status outside ANNOUNCED/REGISTERING with
--      registration_closed. So the Free Buy's "ONE HOUR FOR LATE REG" and
--      every MTT's late_reg_levels exist for people only. Measured in the
--      engine log 12:27-13:27 UTC: HorseOverlayGuard asked for 9..24 horses
--      into "Morning Free Buy (NLH)" (RUNNING, late registration open) on
--      every 2-minute pass and every one was refused registration_closed -
--      "Horse registration: 0 seated, skipped - registration_closed x24".
--
--   2. A FINALIZED POOL. The human maintenance gate reads prize_pool_finalized
--      and answers registration_closed (a reason, no exception, no writes).
--      The horse door does not read it; the insert meets the trigger that
--      RAISES "registration is closed because tournament ... prize pool is
--      finalized" - after the wallet debit path and the locks. Measured: 235
--      such exceptions per top-up attempt on "Breakfast Turbo" (f370585d).
--
--   3. THE CACHED COUNT UNDER RUNNING. The human core expects the roster
--      trigger to have refreshed current_players only while ANNOUNCED /
--      REGISTERING (v_expected_cached_players); the horse core asserts
--      v_players_before + 1 unconditionally, which is wrong under RUNNING.
--
-- What this migration does: rewrites the horse core so its status test, its
-- finalized-pool refusal, its cached-count expectation and its late seat are
-- the human core's, line for line, and adds a horse lifecycle gate with the
-- same one-retry capacity repair and the same wake. Nothing else in the
-- function changes: the not_a_horse check, the ticket-first admission in the
-- terminal gate, the roster-cache divergence check, the entry split, the
-- wallet debit and its ledger declarations, the rake record and the pool
-- increments are byte-identical to what runs today.
--
-- NOT DONE HERE, on purpose: the human door's seat_first_variant refusal (an
-- MTT registration into a Spin / heads-up). The horse core is called by
-- fn_seat_horse_in_seat_first_game with the two-argument signature, so
-- mirroring that guard needs an internal flag on every horse signature; that
-- is a separate change. The engine never registers a horse into a seat-first
-- game (startsOnBoughtSeats / isSeatFirstFormat), so nothing depends on it.
--
-- Production DDL policy (CLAUDE.md section 2): one transaction, outside the
-- :50-:03 break window, applied once. Reserve the version with
-- `node scripts/new-migration.mjs "horse door admits late registration"`.
-- Probe it (11.5) inside ONE DO block that ends by RAISE EXCEPTION.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament_before_maintenance_gate(
  p_tournament_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
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
  v_led_cat text; v_led_cp text; v_led_ent text; v_led_tid text;
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

  IF v_is_bounty THEN
    v_head := v_split.bounty;
  END IF;

  IF v_split.charge > 0 THEN
    v_led_cat := current_setting('app.ledger_category', true);
    v_led_cp  := current_setting('app.ledger_counterparty', true);
    v_led_ent := current_setting('app.ledger_counterparty_entity', true);
    v_led_tid := current_setting('app.ledger_tournament', true);
    PERFORM set_config('app.ledger_category', 'tournament_buyin', true);
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);
    PERFORM set_config('app.ledger_tournament', p_tournament_id::text, true);
    v_ok := public.atomic_deduct_wallet_and_log(
      p_user_id, v_split.charge, 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
    PERFORM set_config('app.ledger_category', COALESCE(v_led_cat, ''), true);
    PERFORM set_config('app.ledger_counterparty', COALESCE(v_led_cp, ''), true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(v_led_ent, ''), true);
    PERFORM set_config('app.ledger_tournament', COALESCE(v_led_tid, ''), true);
    IF NOT COALESCE(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance');
    END IF;
    PERFORM public.log_wallet_transaction(
      p_user_id, 'PLAYER', v_split.charge, 'debit', 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
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

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
    'cost', v_split.charge, 'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty, 'rake', v_split.rake,
    'late_registration', v_late_open,
    'seat', v_seat);
END;
$$;

-- The horse lifecycle gate: the human's fn_register_for_tournament_before_
-- atomic_lifecycle_gate, for the horse core. One capacity repair, one retry,
-- one wake - identical.
CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament_before_atomic_lifecycle_gate(
  p_tournament_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  BEGIN
    v_result := public.fn_register_horse_for_tournament_before_maintenance_gate(
      p_tournament_id, p_user_id);
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM NOT LIKE 'Late registration could not seat the player (%)%' THEN
      RAISE;
    END IF;
    PERFORM public.fn_ensure_late_registration_capacity(p_tournament_id, 1);
    v_result := public.fn_register_horse_for_tournament_before_maintenance_gate(
      p_tournament_id, p_user_id);
  END;

  IF COALESCE((v_result->>'ok')::boolean, false)
     AND COALESCE((v_result->>'late_registration')::boolean, false) THEN
    PERFORM public.fn_emit_tournament_manager_wake(p_tournament_id, 'late_registration');
  END IF;
  RETURN v_result;
END;
$$;

-- The terminal gate's last line now goes through the lifecycle gate. Every
-- other line of it (locks, freeze, not_a_horse, ticket-first admission, the
-- hinted-ticket refusal) is unchanged from pg_proc as read on 2026-09-11.
CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament_before_terminal_gate(
  p_tournament_id uuid,
  p_user_id uuid,
  p_allow_wallet_charge boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_is_horse boolean;
  v_ticket_lookup jsonb;
  v_ticket_id uuid;
  v_ticket_registration_count integer:=0;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_allow_wallet_charge IS NULL THEN
    RAISE EXCEPTION 'tournament, horse and wallet authority are required'
      USING ERRCODE='22004';
  END IF;

  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;

  SELECT is_horse INTO v_is_horse
    FROM public.profiles WHERE id=p_user_id;
  IF NOT COALESCE(v_is_horse,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_a_horse');
  END IF;

  SELECT count(*),min(e.source_ticket_id::text)::uuid
    INTO v_ticket_registration_count,v_ticket_id
    FROM public.tournament_refund_entitlements e
    JOIN public.tournament_players tp ON tp.id=e.registration_id
   WHERE e.tournament_id=p_tournament_id
     AND e.user_id=p_user_id
     AND e.entitlement_kind='tournament_ticket'
     AND e.source_ticket_id IS NOT NULL
     AND tp.tournament_id=e.tournament_id
     AND tp.user_id=e.user_id
     AND tp.status::text IN ('registered','playing');
  IF v_ticket_registration_count>1 THEN
    RAISE EXCEPTION
      'horse ticket admission has multiple active immutable entitlements'
      USING ERRCODE='P0404';
  END IF;
  IF v_ticket_registration_count=1 AND v_ticket_id IS NOT NULL THEN
    RETURN public.fn_ca_register_for_tournament_with_ticket_for(
      p_tournament_id,v_ticket_id,p_user_id);
  END IF;

  v_ticket_lookup:=public.fn_ca_find_tournament_entry_ticket_for(
    p_tournament_id,p_user_id);
  IF COALESCE((v_ticket_lookup->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_ticket_lookup;
  END IF;
  v_ticket_id:=NULLIF(v_ticket_lookup->>'ticket_id','')::uuid;
  IF v_ticket_id IS NOT NULL THEN
    RETURN public.fn_ca_register_for_tournament_with_ticket_for(
      p_tournament_id,v_ticket_id,p_user_id);
  END IF;

  IF p_allow_wallet_charge IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','hinted_tournament_ticket_no_longer_available');
  END IF;
  RETURN public.fn_register_horse_for_tournament_before_atomic_lifecycle_gate(
    p_tournament_id,p_user_id);
END;
$$;

COMMIT;
