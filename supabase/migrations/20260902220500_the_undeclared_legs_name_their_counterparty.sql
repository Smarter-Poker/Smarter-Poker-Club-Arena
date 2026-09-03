-- ═══════════════════════════════════════════════════════════════════════════════
--  THE UNDECLARED LEGS NAME THEIR COUNTERPARTY
--  Chip Accounting Roadmap Phase 1.2 + 1.3 (docs/CHIP-ACCOUNTING-ROADMAP.md)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- DECLARATION ONLY. No balance write moves, no amount changes, no new refusal.
-- Every function below is the live body (pg_get_functiondef, 2026-09-02 ~21:40
-- UTC) with lines ADDED around one balance write; the one replaced line is in
-- fn_spin_settle_game and is noted there. The rebuilt bodies were diffed against
-- the live prosrc before apply: only the additions differ.
--
-- The auto-ledger (fn_club_members_ledger_writer on club_members.chip_balance,
-- fn_ca_autoledger on clubs / bbj_pools / spin_bonus_pools / union_wallets)
-- journals every balance write. When the writer has not declared
-- app.ledger_category / app.ledger_counterparty (or called fn_ca_declare_ledger)
-- the row lands as `adjustment` and/or with `settlement_suspense` on the other
-- side. Measured 2026-09-02 (lane1-chip-paths.md C/D): suspense net +185,526.56
-- per 24h, and these were the legs:
--
--   1. Registration debit (fn_register_for_tournament -> atomic_deduct_wallet_and_log)
--      19,538 rows / 407,412.00 a day as `adjustment player_wallet -> table_stack`,
--      no tournament_id. Now: `tournament_buyin player_wallet -> prize_liability`
--      (entity = tournament), tournament_id stamped. The rebuy / re-entry / add-on
--      core (process_tournament_rebuy_before_one_minute_addon) writes club_members
--      itself and is declared the same way with its own v_cat ('rebuy' / 'addon').
--      Declared in the CALLERS, never inside atomic_deduct_wallet_and_log, which
--      many non-tournament writers share.
--
--      One wallet write is one ledger row: the whole charge (prize + bounty + fee)
--      is booked against the tournament that holds all three until completion.
--      `fee_liability` is NOT a word in chip_ledger_from_type_check / to_type_check
--      and there is no second write to hang a fee leg on without changing how the
--      money moves; the per-bucket split is the escrow shadow's job (Lane B).
--
--   2. fn_spin_settle_game: category `spin_prize` was declared, the counterparty
--      was not -> 3,303 rows / 185,189.00 a day `spin_reserve -> settlement_suspense`
--      (only when the entry had been booked at seat time, which is the normal case;
--      an entry booked in the same call inherited prize_liability by accident).
--      Now: `spin_prize spin_reserve -> prize_liability` (entity = the spin
--      tournament), through fn_ca_declare_ledger (service_role-only function).
--
--   3. BBJ promo sweeps (fn_sweep_bbj_promo, fn_sweep_bbj_promo_all): the 25% promo
--      slice left bbj_pools as `adjustment bbj_pool -> settlement_suspense` (505/day)
--      and arrived as `adjustment settlement_suspense -> union_wallet | promo_wallet`
--      (251 + 254/day). Now: ONE row `promo bbj_pool -> union_wallet` (entity =
--      union) or `-> promo_wallet` (entity = club); the credit-side autoledger is
--      skipped for that write so the move is not journaled twice, and the skip is
--      cleared right after the credit.
--
--   4. Horse treasury-to-felt funding (fn_horse_fund_from_treasury,
--      fn_horse_seat_from_treasury): READ, NOT CHANGED. Since 2026-08-31 both write
--      an explicit `horse_funding club_treasury -> table_stack` row with both
--      entities and autoskip the clubs trigger; 1,100 / 1,100 rows in the last 24h
--      carry the category and both entities. Nothing to declare. Whether the felt
--      may be funded from a treasury without a wallet leg at all is chip standard
--      C4, a decision for Dan, not a ledger declaration.
--
-- Player-facing paths (registration, rebuy) declare with set_config so that a
-- vocabulary miss can never refuse a buy-in: the writer trigger falls back to
-- `adjustment` on its own. service_role-only paths use fn_ca_declare_ledger, the
-- primitive from 20260901011443, which validates against the live CHECK text.
-- Every setting is transaction-local; the player-facing paths save and restore
-- all four so nothing later in the same transaction inherits them.
--
-- Grants are untouched: CREATE OR REPLACE keeps each function's ACL.

BEGIN;

-- ── 1a. fn_register_for_tournament ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_register_for_tournament(p_tournament_id uuid, p_seat_first_internal boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_t record; v_username text;
  v_split record;
  v_is_bounty boolean; v_head numeric := 0;
  v_player_id uuid;
  v_late_open boolean := false; v_ok boolean;
  v_start_chips integer := 0;
  v_seat jsonb := NULL;                                  -- LATE SEAT 2026-08-23
  v_seat_reason text;                                    -- SEAT FIX 2026-08-27
  v_led_cat text; v_led_cp text; v_led_ent text; v_led_tid text; -- CHIP STANDARD 1.2 2026-09-02
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_register_for_tournament requires an authenticated caller' USING ERRCODE = '28000';
  END IF;
  SELECT id, status, buy_in_amount, buy_in_fee, max_players, current_players,
         late_reg_levels, late_reg_mins, current_level, started_at, club_id, name, prize_pool_finalized,
         is_bounty, is_pko, is_mystery_bounty, bounty_amount,
         start_time, authorized_to_register, is_vip_only, early_bird_enabled, early_bird_chips,
         variant
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;

  -- SEAT-FIRST GUARD 2026-08-27, REBUILT 2026-08-28. A seat-first event is
  -- bought by taking a seat; registering into one debits the player for a
  -- seat that is never allocated. But the seat path ITSELF registers the
  -- player through this function, so the guard admits that caller via
  -- p_seat_first_internal - the original guard refused it too and no human
  -- could buy a Spin or Heads-Up seat at all. And the predicate is now the
  -- CANONICAL seat-first test (variant 'spin' OR max_players <= 2), matching
  -- fn_take_seat_and_buy_in and fn_sync_seat_first_player_count: the original
  -- blocked ALL sngs, which left 6-max and 9-max SNGs with no entry path in
  -- either door.
  IF NOT p_seat_first_internal
     AND (COALESCE(v_t.variant, '') = 'spin' OR COALESCE(v_t.max_players, 0) <= 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_first_variant',
      'detail', 'This format is entered by taking a seat, not by registering. '
                || 'Call fn_take_seat_and_buy_in for the seat you want.',
      'variant', v_t.variant);
  END IF;

  IF v_t.status = 'RUNNING' THEN
    IF COALESCE(v_t.late_reg_levels, 0) > 0 THEN
      v_late_open := COALESCE(v_t.current_level, 0) < v_t.late_reg_levels AND NOT COALESCE(v_t.prize_pool_finalized, false);
    ELSIF COALESCE(v_t.late_reg_mins, 0) > 0 AND v_t.started_at IS NOT NULL THEN
      v_late_open := now() < v_t.started_at + make_interval(mins => v_t.late_reg_mins) AND NOT COALESCE(v_t.prize_pool_finalized, false);
    END IF;
  END IF;
  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') AND NOT v_late_open THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;
  IF v_t.max_players IS NOT NULL AND COALESCE(v_t.current_players, 0) >= v_t.max_players THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_full');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id = p_tournament_id AND user_id = v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  -- PARITY GATE 1 (2026-08-22): owner-approved registration list.
  IF COALESCE(v_t.authorized_to_register, false) THEN
    IF NOT EXISTS (SELECT 1 FROM public.tournament_registration_approvals a
                    WHERE a.tournament_id = p_tournament_id AND a.user_id = v_uid)
       AND NOT public.is_club_admin(v_t.club_id, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized_to_register');
    END IF;
  END IF;

  -- PARITY GATE 2 (2026-08-22): VIP-only events.
  IF COALESCE(v_t.is_vip_only, false) THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles pr
                    WHERE pr.id = v_uid AND COALESCE(pr.is_vip, false)
                      AND (pr.vip_expires_at IS NULL OR pr.vip_expires_at > now()))
       AND NOT EXISTS (SELECT 1 FROM public.club_members m
                        WHERE m.club_id = v_t.club_id AND m.user_id = v_uid
                          AND m.role IN ('owner', 'co_owner', 'admin', 'agent')) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'vip_only');
    END IF;
  END IF;

  -- PARITY 3 (2026-08-22): early bird bonus chips for pre-start registration.
  IF COALESCE(v_t.early_bird_enabled, false)
     AND now() < v_t.start_time
     AND COALESCE(v_t.early_bird_chips, 0) > 0 THEN
    v_start_chips := v_t.early_bird_chips;
  END IF;

  SELECT COALESCE(NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_username FROM public.profiles WHERE id = v_uid;

  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);

  IF v_is_bounty AND v_split.prize < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'misconfigured_bounty',
      'detail', format('bounty %s + rake %s exceeds buy-in %s',
                       v_split.bounty, v_split.rake, v_split.charge));
  END IF;

  -- MYSTERY BOUNTY 2026-08-25: every bounty format puts the flat bounty on
  -- the head; the mystery value is drawn from a funded inventory at the
  -- knockout, not from a seeded PRNG at the till.
  IF v_is_bounty THEN
    v_head := v_split.bounty;
  END IF;

  IF v_split.charge > 0 THEN
    -- CHIP STANDARD 1.2 (2026-09-02): THE REGISTRATION DEBIT NAMES ITS COUNTERPARTY.
    -- trg_club_members_audit_chip_movement journals the wallet write below; with no
    -- declaration it landed as adjustment player_wallet -> table_stack with no
    -- tournament_id (19,538 rows / 407,412.00 a day). Declared with set_config, not
    -- fn_ca_declare_ledger, so a vocabulary miss can never refuse a buy-in (the
    -- writer falls back to adjustment on its own). The whole charge (prize + bounty
    -- + fee) is ONE wallet write and so ONE row, booked against the tournament
    -- (prize_liability) that holds all three until it completes. The four settings
    -- are restored right after so nothing later in this transaction inherits them.
    v_led_cat := current_setting('app.ledger_category', true);
    v_led_cp  := current_setting('app.ledger_counterparty', true);
    v_led_ent := current_setting('app.ledger_counterparty_entity', true);
    v_led_tid := current_setting('app.ledger_tournament', true);
    PERFORM set_config('app.ledger_category', 'tournament_buyin', true);
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);
    PERFORM set_config('app.ledger_tournament', p_tournament_id::text, true);
    v_ok := public.atomic_deduct_wallet_and_log(
      v_uid, v_split.charge, 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament') ||
        CASE WHEN v_is_bounty
             THEN ' (' || v_split.prize || ' prize + ' || v_split.bounty || ' bounty + ' || v_split.rake || ' fee)'
             WHEN v_split.rake > 0
             THEN ' (' || v_split.prize || ' + ' || v_split.rake || ' fee)'
             ELSE '' END,
      NULL, NULL, p_tournament_id);
    PERFORM set_config('app.ledger_category', COALESCE(v_led_cat, ''), true);
    PERFORM set_config('app.ledger_counterparty', COALESCE(v_led_cp, ''), true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(v_led_ent, ''), true);
    PERFORM set_config('app.ledger_tournament', COALESCE(v_led_tid, ''), true);
    IF NOT COALESCE(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance');
    END IF;
    PERFORM public.log_wallet_transaction(
      v_uid, 'PLAYER', v_split.charge, 'debit', 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
  END IF;

  BEGIN
    IF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status, current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered', v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;
    ELSE
      INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered')
      RETURNING id INTO v_player_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    IF v_split.charge > 0 THEN
      PERFORM public.credit_player_wallet(v_uid, v_split.charge,
        'tourn_reg_race:' || p_tournament_id::text || ':' || v_uid::text);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END;

  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players, bbj_contribution,
       is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_split.rake, v_split.charge, 1, 0, true, p_tournament_id,
            'fn_register_for_tournament',
            jsonb_build_object('kind','tournament_entry_fee','user_id',v_uid,'registration_id',v_player_id));
  END IF;

  UPDATE public.tournaments
     SET current_players = COALESCE(current_players, 0) + 1,
         prize_pool  = COALESCE(prize_pool, 0)  + v_split.prize,
         bounty_pool = COALESCE(bounty_pool, 0) + v_split.bounty,
         total_rake  = COALESCE(total_rake, 0)  + v_split.rake
   WHERE id = p_tournament_id;

  -- LATE SEAT 2026-08-23
  IF v_late_open THEN
    v_seat := public.fn_seat_late_registrant(p_tournament_id, v_uid);

    -- SEAT FIX 2026-08-27: a late registrant who cannot be seated must not be
    -- charged; abort so debit, roster row, rake record and pool increments
    -- roll back together. 'already_seated_or_missing' is NOT a failure.
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
    'bounty_head', CASE WHEN v_head > 0 THEN v_head END,
    'early_bird_chips', CASE WHEN v_start_chips > 0 THEN v_start_chips END,
    'late_registration', v_late_open,                    -- LATE SEAT 2026-08-23
    'seat', v_seat);                                     -- LATE SEAT 2026-08-23
END;
$function$

;

-- ── 1b. process_tournament_rebuy_before_one_minute_addon (the rebuy core) ───────
CREATE OR REPLACE FUNCTION public.process_tournament_rebuy_before_one_minute_addon(p_tournament_id uuid, p_user_id uuid, p_rebuy_type text, p_cost numeric, p_chips numeric, p_current_level integer, p_client_token text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t record; v_p record; v_balance numeric; v_ratio numeric;
  v_is_bounty boolean; v_bounty_head numeric;
  v_base numeric; v_fee numeric; v_total numeric;
  v_add integer; v_new_chips integer; v_seat record;
  v_key text; v_inserted integer; v_cap integer; v_level integer; v_cat text;
  v_club uuid; v_legacy_ratio numeric; v_legacy_total numeric;
  v_stack_after numeric; v_expected numeric; v_fee_ratio numeric;
  v_led_cat text; v_led_cp text; v_led_ent text; v_led_tid text; -- CHIP STANDARD 1.2 2026-09-02
BEGIN
  IF NOT (COALESCE(auth.role(), 'service_role') = 'service_role')
     AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'process_tournament_rebuy: caller may only transact for themselves'
      USING ERRCODE = '42501';
  END IF;
  IF p_rebuy_type NOT IN ('rebuy','reentry','addon') THEN
    RAISE EXCEPTION 'Invalid rebuy type: %', p_rebuy_type;
  END IF;

  SELECT id, name, club_id, status, buy_in_amount, buy_in_fee, starting_chips,
         is_rebuy, is_reentry, add_on_available, addon_period_triggered,
         rebuy_cost, rebuy_chips, rebuy_levels, late_reg_levels, max_rebuys,
         max_reentries, addon_cost, addon_chips, addon_levels, current_level, prize_pool,
         is_bounty, is_pko, is_mystery_bounty, bounty_amount
    INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;
  IF v_t.status NOT IN ('RUNNING','REGISTERING','ANNOUNCED') THEN
    RAISE EXCEPTION 'Tournament is not accepting chip purchases (status %)', v_t.status;
  END IF;

  SELECT id, chips, status, prize, rebuys, add_on, table_id, club_id INTO v_p
    FROM tournament_players
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not registered in this tournament'; END IF;
  IF v_p.status = 'eliminated' AND COALESCE(v_p.prize, 0) > 0 THEN
    RAISE EXCEPTION 'Finishing Place Already Paid - A Rebuy Cannot Resurrect A Settled Result';
  END IF;
  v_club := COALESCE(v_p.club_id, public.fn_player_home_club(p_user_id, NULL));
  IF v_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this tournament purchase';
  END IF;

  v_level := COALESCE(v_t.current_level, COALESCE(p_current_level, 0));
  v_cat   := CASE WHEN p_rebuy_type = 'addon' THEN 'addon' ELSE 'rebuy' END;

  -- Only an ADD-ON demands a live seat (a mid-play purchase by definition).
  -- A rebuy without a seat is now the normal race-recovery shape: the chips
  -- land on the player row and the seating sweep places them.
  IF p_rebuy_type = 'addon' THEN
    PERFORM 1 FROM table_seats s
      JOIN tables tb ON tb.id = s.table_id
     WHERE s.user_id = p_user_id AND s.left_at IS NULL
       AND tb.tournament_id = p_tournament_id
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No Live Seat For This % - Refusing To Charge For Chips That Would Be Overwritten By The Seat Sync', p_rebuy_type;
    END IF;
  END IF;

  IF p_rebuy_type = 'addon' THEN
    v_key := 'tourney:' || p_tournament_id || ':addon:' || p_user_id;
  ELSIF p_client_token IS NOT NULL AND length(btrim(p_client_token)) > 0 THEN
    v_key := 'tourney:' || p_tournament_id || ':' || p_rebuy_type || ':'
             || p_user_id || ':tok:' || btrim(p_client_token);
  ELSE
    v_key := 'tourney:' || p_tournament_id || ':' || p_rebuy_type || ':'
             || p_user_id || ':#' || COALESCE(v_p.rebuys, 0);
  END IF;

  IF p_rebuy_type <> 'addon' AND p_client_token IS NULL AND EXISTS (
      SELECT 1 FROM wallet_transactions w
       WHERE w.user_id = p_user_id AND w.related_entity_id = p_tournament_id
         AND w.category = v_cat
         AND w.created_at > now() - interval '1500 milliseconds') THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true,
                              'reason', 'double_submit_collapsed',
                              'new_stack', v_p.chips, 'rebuy_type', p_rebuy_type);
  END IF;

  INSERT INTO wallet_credit_idempotency (key, user_id, amount)
  VALUES (v_key, p_user_id, COALESCE(p_cost, 0)) ON CONFLICT (key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true,
                              'new_stack', v_p.chips, 'rebuy_type', p_rebuy_type);
  END IF;

  IF p_rebuy_type = 'addon' THEN
    IF NOT COALESCE(v_t.add_on_available,false) THEN
      RAISE EXCEPTION 'Add-ons are not offered in this tournament'; END IF;
    IF COALESCE(v_p.add_on,false) THEN RAISE EXCEPTION 'Add-on already taken'; END IF;
    v_cap := COALESCE(NULLIF(v_t.late_reg_levels,0), NULLIF(v_t.rebuy_levels,0), 0)
             + COALESCE(v_t.addon_levels,1);
    IF v_cap > 0 AND v_level >= v_cap THEN
      RAISE EXCEPTION 'Add-on period has closed (level % of %)', v_level, v_cap; END IF;
    v_base := COALESCE(NULLIF(v_t.addon_cost,0), v_t.buy_in_amount, 0);
    v_add  := COALESCE(NULLIF(v_t.addon_chips,0), v_t.starting_chips, 0)::integer;
  ELSE
    IF p_rebuy_type='rebuy' AND NOT COALESCE(v_t.is_rebuy,false) THEN
      RAISE EXCEPTION 'Rebuys are not offered in this tournament'; END IF;
    IF p_rebuy_type='reentry' AND NOT COALESCE(v_t.is_reentry,false) THEN
      RAISE EXCEPTION 'Re-entries are not offered in this tournament'; END IF;
    v_cap := COALESCE(NULLIF(v_t.rebuy_levels,0), NULLIF(v_t.late_reg_levels,0), 0);
    IF v_cap > 0 AND COALESCE(v_t.add_on_available,false) THEN
      v_cap := v_cap + COALESCE(NULLIF(v_t.addon_levels,0),1); END IF;
    IF v_cap > 0 AND v_level >= v_cap THEN
      RAISE EXCEPTION 'Rebuy period has closed (level % of %)', v_level, v_cap; END IF;
    IF p_rebuy_type='rebuy' AND v_t.max_rebuys IS NOT NULL
       AND COALESCE(v_p.rebuys,0) >= v_t.max_rebuys THEN
      RAISE EXCEPTION 'Rebuy limit reached (% of %)', v_p.rebuys, v_t.max_rebuys; END IF;
    IF p_rebuy_type='reentry' AND v_t.max_reentries IS NOT NULL
       AND COALESCE(v_p.rebuys,0) >= v_t.max_reentries THEN
      RAISE EXCEPTION 'Re-entry limit reached (% of %)', v_p.rebuys, v_t.max_reentries; END IF;
    IF p_rebuy_type='rebuy' AND COALESCE(v_p.chips,0) > COALESCE(v_t.starting_chips,0) THEN
      RAISE EXCEPTION 'Stack too high for a rebuy'; END IF;
    v_base := COALESCE(NULLIF(v_t.rebuy_cost,0), v_t.buy_in_amount, 0);
    v_add  := COALESCE(NULLIF(v_t.rebuy_chips,0), v_t.starting_chips, 0)::integer;
  END IF;

  v_legacy_ratio := CASE WHEN COALESCE(v_t.buy_in_amount,0) > 0 AND COALESCE(v_t.buy_in_fee,0) > 0
                         THEN v_t.buy_in_fee / v_t.buy_in_amount ELSE 0.1 END;
  v_fee_ratio := CASE WHEN COALESCE(v_t.buy_in_amount,0) + COALESCE(v_t.buy_in_fee,0) > 0
                           AND COALESCE(v_t.buy_in_fee,0) > 0
                      THEN v_t.buy_in_fee / (v_t.buy_in_amount + v_t.buy_in_fee)
                      ELSE 0.1 END;
  v_ratio := CASE WHEN p_rebuy_type = 'addon' THEN 0 ELSE v_fee_ratio END;

  v_total := round(v_base::numeric);
  v_fee := CASE WHEN v_ratio > 0 AND v_total > 0
                THEN LEAST(trunc(v_total * v_ratio * 100 + 0.000001) / 100,
                           trunc(v_total * 0.1 * 100 + 0.000001) / 100)
                ELSE 0 END;
  v_base := round(v_total - v_fee, 2);
  v_is_bounty := COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
                 OR COALESCE(v_t.is_mystery_bounty,false);
  IF v_is_bounty AND p_rebuy_type <> 'addon' THEN
    v_bounty_head := LEAST(GREATEST(0, round(COALESCE(v_t.bounty_amount,0))), v_base);
    v_base := v_base - v_bounty_head;
  ELSE
    v_bounty_head := 0;
  END IF;

  IF p_cost IS NOT NULL AND abs(p_cost - v_total) > 0.01 THEN
    v_legacy_total := v_total + round(v_total * v_legacy_ratio, 2);
    IF abs(p_cost - v_legacy_total) > 0.01 THEN
      RAISE EXCEPTION 'Price mismatch: client quoted %, server computed % (base % + fee %)',
        p_cost, v_total, v_base, v_fee;
    END IF;
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_club);
  SELECT chip_balance INTO v_balance FROM club_members
   WHERE user_id = p_user_id AND club_id = v_club FOR UPDATE;
  IF v_balance IS NULL OR v_balance < v_total THEN
    RAISE EXCEPTION 'Insufficient club chips: need % (incl. % fee), have %',
      v_total, v_fee, COALESCE(v_balance,0);
  END IF;
  -- CHIP STANDARD 1.2 (2026-09-02): the rebuy / re-entry / add-on debit names its
  -- counterparty (v_cat is 'rebuy' or 'addon', both ledger words) and stamps the
  -- tournament. set_config, not fn_ca_declare_ledger, so a vocabulary miss can never
  -- refuse the purchase. Restored right after the write.
  v_led_cat := current_setting('app.ledger_category', true);
  v_led_cp  := current_setting('app.ledger_counterparty', true);
  v_led_ent := current_setting('app.ledger_counterparty_entity', true);
  v_led_tid := current_setting('app.ledger_tournament', true);
  PERFORM set_config('app.ledger_category', v_cat, true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);
  PERFORM set_config('app.ledger_tournament', p_tournament_id::text, true);
  UPDATE club_members SET chip_balance = chip_balance - v_total, updated_at = now()
   WHERE user_id = p_user_id AND club_id = v_club;
  PERFORM set_config('app.ledger_category', COALESCE(v_led_cat, ''), true);
  PERFORM set_config('app.ledger_counterparty', COALESCE(v_led_cp, ''), true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(v_led_ent, ''), true);
  PERFORM set_config('app.ledger_tournament', COALESCE(v_led_tid, ''), true);

  IF p_rebuy_type='reentry' THEN
    UPDATE tournament_players SET chips=v_add, status='playing', eliminated_at=NULL,
           position=NULL, rebuys=COALESCE(rebuys,0)+1
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id RETURNING chips INTO v_new_chips;
  ELSIF p_rebuy_type='addon' THEN
    UPDATE tournament_players SET chips=COALESCE(chips,0)+v_add, add_on=true
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id RETURNING chips INTO v_new_chips;
  ELSE
    -- 2026-08-30: a rebuy also clears an elimination stamp the bust sweep may
    -- have raced onto the row (guarded above: never with a paid prize).
    UPDATE tournament_players SET chips=COALESCE(chips,0)+v_add, status='playing',
           eliminated_at=NULL, position=NULL,
           rebuys=COALESCE(rebuys,0)+1
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id RETURNING chips INTO v_new_chips;
  END IF;

  IF v_bounty_head > 0 THEN
    UPDATE tournament_players
       SET current_bounty = CASE WHEN p_rebuy_type = 'reentry' THEN v_bounty_head
                                 ELSE COALESCE(current_bounty, 0) + v_bounty_head END
     WHERE tournament_id = p_tournament_id AND user_id = p_user_id;
  END IF;

  SELECT s.id, s.stack INTO v_seat
    FROM table_seats s JOIN tables tb ON tb.id=s.table_id
   WHERE s.user_id=p_user_id AND s.left_at IS NULL AND tb.tournament_id=p_tournament_id
   ORDER BY (tb.status IS DISTINCT FROM 'closed') DESC, s.joined_at DESC NULLS LAST, s.id DESC
   LIMIT 1;
  IF FOUND THEN
    UPDATE table_seats
       SET stack = CASE WHEN p_rebuy_type='reentry' THEN v_add ELSE COALESCE(stack,0)+v_add END
     WHERE id=v_seat.id
    RETURNING stack INTO v_stack_after;

    v_expected := CASE WHEN p_rebuy_type='reentry' THEN v_add
                       ELSE COALESCE(v_seat.stack,0) + v_add END;
    IF v_stack_after IS NULL OR v_stack_after <> v_expected THEN
      RAISE EXCEPTION
        'Chip Grant Did Not Land: % Expected Stack % (% + %), Seat % Holds % - Aborting So No Charge Is Made',
        p_rebuy_type, v_expected, COALESCE(v_seat.stack,0), v_add, v_seat.id, v_stack_after;
    END IF;

    UPDATE tournament_players
       SET chips=(SELECT stack FROM table_seats WHERE id=v_seat.id)::integer
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id RETURNING chips INTO v_new_chips;
  ELSIF p_rebuy_type = 'addon' THEN
    RAISE EXCEPTION 'Seat Disappeared During % - Aborting So No Charge Is Made', p_rebuy_type;
  END IF;
  -- 'rebuy'/'reentry' with no seat: the chips stand on the player row and
  -- ensureLateRegSeated seats them at the table that most needs a player.

  UPDATE tournaments
     SET prize_pool  = COALESCE(prize_pool, 0) + v_base,
         bounty_pool = COALESCE(bounty_pool, 0) + v_bounty_head
   WHERE id = p_tournament_id;

  IF v_fee > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO rake_records (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
      bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL,NULL,v_t.club_id,v_fee,v_fee,1,0,true,p_tournament_id,'process_tournament_rebuy',
      jsonb_build_object('kind','tournament_'||p_rebuy_type||'_fee','user_id',p_user_id,
                         'entry_club_id', v_club));
    UPDATE tournaments SET total_rake=COALESCE(total_rake,0)+v_fee WHERE id=p_tournament_id;
  END IF;

  INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description,
    related_entity_id, balance_after)
  VALUES (p_user_id,'PLAYER','debit',v_total,v_cat,
    'Tournament '||p_rebuy_type||': '||COALESCE(v_t.name,'tournament')
      ||' ('||v_base||' + '||v_fee||' fee) [club wallet]',
    p_tournament_id, v_balance-v_total);

  RETURN jsonb_build_object('success', true, 'new_stack', v_new_chips,
    'rebuy_type', p_rebuy_type, 'chips_added', v_add, 'cost', v_total, 'fee', v_fee,
    'seated', FOUND, 'bounty_head_funded', v_bounty_head);
END;
$function$

;

-- ── 2. fn_spin_settle_game ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_spin_settle_game(p_tournament_id uuid, p_club_id uuid, p_buy_in numeric, p_seats integer, p_multiplier numeric, p_rake_rate numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_collected numeric; v_rake numeric; v_reserve_in numeric;
  v_prize numeric; v_bal numeric; v_available numeric;
  v_shortfall numeric := 0; v_drawn numeric;
  v_owner uuid; v_kind text; v_seed numeric; v_wallet text;
  v_floor numeric; v_instalment numeric := 0;
  v_seed_returned numeric := 0; v_wallet_after numeric := NULL;
  v_booked_mult numeric; v_booked_drawn numeric;
  v_entry_booked boolean;
  v_rake_booked boolean;
BEGIN
  IF COALESCE(p_buy_in,0) <= 0 OR COALESCE(p_seats,0) <= 0 OR COALESCE(p_multiplier,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_inputs');
  END IF;

  v_owner := public.fn_spin_reserve_pool(p_club_id);

  SELECT balance INTO v_bal
    FROM public.spin_bonus_pools WHERE club_id = v_owner FOR UPDATE;

  -- THE PRIZE IS WHAT THIS FUNCTION OWNS. A contribution row on its own means
  -- the entry was booked when the last seat was paid and the prize still is
  -- not; only a jackpot_draw row means settled.
  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
             WHERE tournament_id = p_tournament_id AND kind = 'jackpot_draw') THEN
    SELECT l.multiplier, -l.amount INTO v_booked_mult, v_booked_drawn
      FROM public.spin_reserve_ledger l
     WHERE l.tournament_id = p_tournament_id AND l.kind = 'jackpot_draw'
     ORDER BY l.created_at ASC LIMIT 1;
    RETURN jsonb_build_object('ok', true, 'reason', 'already_settled',
      'multiplier', v_booked_mult, 'pool_covered', v_booked_drawn);
  END IF;

  v_collected  := round(p_buy_in * p_seats, 2);
  v_rake       := round(v_collected * COALESCE(p_rake_rate, 0.08), 2);
  v_reserve_in := round(v_collected - v_rake, 2);
  v_prize      := round(p_buy_in * p_multiplier, 2);

  v_entry_booked := EXISTS (SELECT 1 FROM public.spin_reserve_ledger
                             WHERE tournament_id = p_tournament_id AND kind = 'contribution');
  v_rake_booked  := EXISTS (SELECT 1 FROM public.rake_records
                             WHERE tournament_id = p_tournament_id
                               AND source IN ('fn_spin_book_entry','fn_spin_settle_game'));

  IF NOT v_entry_booked THEN
    -- ZERO-DRIFT phase 2: reserve intake = spin_entry vs the tournament.
    PERFORM set_config('app.ledger_category', 'spin_entry', true);
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);

    UPDATE public.spin_bonus_pools
       SET balance = balance + v_reserve_in,
           total_deposited = total_deposited + v_reserve_in,
           spin_count = spin_count + 1,
           highest_stake = GREATEST(highest_stake, p_buy_in),
           updated_at = now()
     WHERE club_id = v_owner RETURNING balance INTO v_available;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'spin pool row missing for owner % settling tournament %',
        v_owner, p_tournament_id;
    END IF;

    INSERT INTO public.spin_reserve_ledger
      (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
    VALUES (v_owner, p_tournament_id, 'contribution', v_reserve_in, v_available,
            p_multiplier, p_buy_in, p_seats, v_rake,
            CASE WHEN v_owner = p_club_id THEN 'buy-ins less fixed rake'
                 ELSE format('buy-ins less fixed rake (club %s)', p_club_id) END);
  ELSE
    -- Already funded at entry. Read where the pool actually stands.
    SELECT balance INTO v_available
      FROM public.spin_bonus_pools WHERE club_id = v_owner;
    IF v_available IS NULL THEN
      RAISE EXCEPTION 'spin pool row missing for owner % settling tournament %',
        v_owner, p_tournament_id;
    END IF;
  END IF;

  IF v_prize > v_available THEN
    v_shortfall := round(v_prize - v_available, 2);
    v_drawn := v_available;
  ELSE
    v_drawn := v_prize;
  END IF;

  -- ZERO-DRIFT phase 2: the draw funds the tournament's prize pool.
  -- CHIP STANDARD 1.3 (2026-09-02): ... and names the tournament it funds. With only
  -- the category set, this leg landed spin_reserve -> settlement_suspense (3,303 rows
  -- / 185,189.00 a day, R9). service_role-only, so the primitive is used.
  PERFORM public.fn_ca_declare_ledger('spin_prize', 'prize_liability', p_tournament_id);

  UPDATE public.spin_bonus_pools
     SET balance = balance - v_drawn,
         total_drawn = total_drawn + v_drawn,
         bonus_count = bonus_count + CASE WHEN p_multiplier >= 10 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE club_id = v_owner RETURNING balance INTO v_bal;

  INSERT INTO public.spin_reserve_ledger
    (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
  VALUES (v_owner, p_tournament_id, 'jackpot_draw', -v_drawn, v_bal,
          p_multiplier, p_buy_in, p_seats, v_rake,
          CASE WHEN v_shortfall > 0
               THEN format('prize pool (pool covered %s of %s)', v_drawn, v_prize)
               ELSE 'prize pool' END);

  IF v_shortfall > 0 THEN
    INSERT INTO public.spin_reserve_ledger
      (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, note)
    VALUES (v_owner, p_tournament_id, 'adjustment', 0, v_bal,
            p_multiplier, p_buy_in, p_seats,
            format('SHORTFALL %s covered by operator - pool was too thin for a %sx. Seed it.',
                   v_shortfall, p_multiplier));
  END IF;

  IF v_rake > 0 AND p_club_id IS NOT NULL AND NOT v_rake_booked THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, p_club_id, v_rake, v_collected, p_seats, 0, true,
            p_tournament_id, 'fn_spin_settle_game',
            jsonb_build_object('kind','spin_rake','multiplier',p_multiplier,
                               'buy_in',p_buy_in,'rake_rate',p_rake_rate,
                               'shortfall',v_shortfall,'reserve_owner',v_owner));
  END IF;

  -- THE REPAYMENT PLAN - one instalment per settle, at most.
  SELECT seeded_amount, seed_source_wallet, owner_kind, required_seed_at_activation
    INTO v_seed, v_wallet, v_kind, v_floor
    FROM public.spin_bonus_pools WHERE club_id = v_owner;

  v_instalment := public.fn_spin_seed_instalment(v_bal, COALESCE(v_seed,0), COALESCE(v_floor,0));

  IF v_instalment > 0 AND v_wallet IS NOT NULL THEN
    PERFORM set_config('app.ledger_category', 'treasury_transfer', true);
    PERFORM set_config('app.ledger_counterparty',
      CASE WHEN v_kind = 'union' THEN 'union_wallet' ELSE 'club_treasury' END, true);
    PERFORM set_config('app.ledger_counterparty_entity', v_owner::text, true);
    PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);

    v_wallet_after := public.fn_spin_move_owner_wallet(v_owner, v_kind, v_wallet, v_instalment);

    IF v_wallet_after IS NOT NULL THEN
      UPDATE public.spin_bonus_pools
         SET balance              = balance - v_instalment,
             seeded_amount        = seeded_amount - v_instalment,
             seed_returned_amount = seed_returned_amount + v_instalment,
             seed_returned_at     = now(),
             required_seed_at_activation =
               CASE WHEN seeded_amount - v_instalment <= 0 THEN 0
                    ELSE required_seed_at_activation END,
             updated_at           = now()
       WHERE club_id = v_owner RETURNING balance INTO v_bal;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'spin pool row vanished for owner % after repaying % to %',
          v_owner, v_instalment, v_wallet;
      END IF;

      v_seed_returned := v_instalment;

      INSERT INTO public.spin_reserve_ledger
        (club_id, tournament_id, kind, amount, balance_after, note)
      VALUES (v_owner, p_tournament_id, 'seed_return', -v_instalment, v_bal,
              format('seed instalment to %s %s - 50%% of %s above a floor of %s; %s still owed',
                     v_kind, v_wallet, round(v_bal + v_instalment - v_floor, 2), v_floor,
                     GREATEST(COALESCE(v_seed,0) - v_instalment, 0)));
    END IF;

    PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
    PERFORM set_config('app.ledger_autoskip_clubs', '', true);
  END IF;

  RETURN jsonb_build_object('ok', true, 'collected', v_collected,
    'house_rake', v_rake, 'reserve_in', v_reserve_in, 'prize_pool', v_prize,
    'pool_covered', v_drawn, 'operator_shortfall', v_shortfall,
    'balance', v_bal, 'seed_returned', v_seed_returned,
    'entry_booked_at_seat', v_entry_booked,
    'seed_outstanding', GREATEST(COALESCE(v_seed,0) - v_seed_returned, 0),
    'owner_id', v_owner, 'source_wallet_after', v_wallet_after);
END;
$function$

;

-- ── 3a. fn_sweep_bbj_promo ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_sweep_bbj_promo(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_promo numeric; v_pool_id uuid; v_union_id uuid; v_dest text; v_after numeric;
BEGIN
  SELECT c.union_id INTO v_union_id FROM clubs c WHERE c.id = p_club_id;

  SELECT bp.id, COALESCE(bp.promo_balance, 0) INTO v_pool_id, v_promo
    FROM bbj_pools bp
   WHERE bp.status = 'active'
     AND ((v_union_id IS NOT NULL AND bp.union_id = v_union_id)
       OR (v_union_id IS NULL AND bp.club_id = p_club_id))
   ORDER BY (bp.union_id IS NOT NULL) DESC
   LIMIT 1
   FOR UPDATE;

  IF v_pool_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no bbj pool for club');
  END IF;
  IF v_promo <= 0 THEN
    RETURN jsonb_build_object('success', true, 'swept', 0, 'note', 'nothing to sweep');
  END IF;

  -- CHIP STANDARD 1.3 (2026-09-02): THE SWEEP JOURNALS BOTH SIDES IN ONE ROW.
  -- The pool debit below is journaled by the bbj_pools autoledger as
  -- promo bbj_pool -> union_wallet (the union's promo_wallet) or -> promo_wallet
  -- (the club's promo_balance). The credit side is autoskipped so the same move is
  -- not journaled a second time through settlement_suspense (R9); the skip is
  -- cleared right after the credit. A failure branch that puts the balance back is
  -- journaled by the same declaration, in reverse.
  PERFORM public.fn_ca_declare_ledger('promo',
    CASE WHEN v_union_id IS NOT NULL THEN 'union_wallet' ELSE 'promo_wallet' END,
    COALESCE(v_union_id, p_club_id), NULL, NULL, ARRAY['union_wallets', 'clubs']);
  UPDATE bbj_pools SET promo_balance = 0, updated_at = NOW() WHERE id = v_pool_id;

  IF v_union_id IS NOT NULL THEN
    INSERT INTO union_wallets (union_id, promo_wallet)
    VALUES (v_union_id, v_promo)
    ON CONFLICT (union_id) DO UPDATE
      SET promo_wallet = COALESCE(union_wallets.promo_wallet, 0) + EXCLUDED.promo_wallet
    RETURNING promo_wallet INTO v_after;
    PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
    PERFORM set_config('app.ledger_autoskip_clubs', '', true);

    IF v_after IS NULL THEN
      UPDATE bbj_pools SET promo_balance = v_promo WHERE id = v_pool_id;
      RETURN jsonb_build_object('success', false, 'error', 'union wallet credit failed');
    END IF;

    UPDATE unions
       SET promo_funded_from_bbj = COALESCE(promo_funded_from_bbj, 0) + v_promo,
           updated_at = NOW()
     WHERE id = v_union_id;

    INSERT INTO union_wallet_transactions
      (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes)
    VALUES
      (v_union_id, p_club_id, 'promo_wallet', 'credit', v_promo, v_after,
       'bbj_promo_sweep', 'BBJ promo slice swept from pool (single-club sweep)');

    v_dest := 'union';
  ELSE
    UPDATE clubs
       SET promo_balance = COALESCE(promo_balance, 0) + v_promo, updated_at = NOW()
     WHERE id = p_club_id
    RETURNING promo_balance INTO v_after;
    PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
    PERFORM set_config('app.ledger_autoskip_clubs', '', true);
    v_dest := 'club';

    INSERT INTO chip_transactions (
      id, club_id, from_user_id, to_user_id, amount,
      transaction_type, notes, balance_after, created_at
    ) VALUES (
      gen_random_uuid(), p_club_id, NULL, NULL, v_promo,
      'bbj_promo_sweep',
      'BBJ promo slice swept to club promo wallet (club has no union)',
      v_after, NOW()
    );
  END IF;

  RETURN jsonb_build_object('success', true, 'swept', v_promo,
                            'destination', v_dest, 'balance_after', v_after);
END $function$

;

-- ── 3b. fn_sweep_bbj_promo_all ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_sweep_bbj_promo_all()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  r record; v_promo numeric; v_union_id uuid; v_after numeric;
  v_swept numeric := 0; v_pools int := 0; v_to_union int := 0; v_to_club int := 0; v_err int := 0;
BEGIN
  FOR r IN SELECT id, club_id, union_id FROM bbj_pools
            WHERE COALESCE(promo_balance,0) > 0 ORDER BY id
  LOOP
    BEGIN
      SELECT COALESCE(promo_balance,0) INTO v_promo FROM bbj_pools WHERE id=r.id FOR UPDATE;
      IF v_promo <= 0 THEN CONTINUE; END IF;

      v_union_id := r.union_id;
      IF v_union_id IS NULL AND r.club_id IS NOT NULL THEN
        SELECT union_id INTO v_union_id FROM clubs WHERE id = r.club_id;
      END IF;

      -- CHIP STANDARD 1.3 (2026-09-02): one declared row per sweep, both sides named
      -- (see fn_sweep_bbj_promo). Inside the per-pool sub-transaction: an exception
      -- reverts the settings along with the writes.
      PERFORM public.fn_ca_declare_ledger('promo',
        CASE WHEN v_union_id IS NOT NULL THEN 'union_wallet' ELSE 'promo_wallet' END,
        COALESCE(v_union_id, r.club_id), NULL, NULL, ARRAY['union_wallets', 'clubs']);
      UPDATE bbj_pools SET promo_balance = 0, updated_at = NOW() WHERE id = r.id;

      IF v_union_id IS NOT NULL THEN
        INSERT INTO union_wallets (union_id, promo_wallet) VALUES (v_union_id, v_promo)
        ON CONFLICT (union_id) DO UPDATE
          SET promo_wallet = COALESCE(union_wallets.promo_wallet,0) + EXCLUDED.promo_wallet
        RETURNING promo_wallet INTO v_after;
        PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
        PERFORM set_config('app.ledger_autoskip_clubs', '', true);

        IF v_after IS NULL THEN
          UPDATE bbj_pools SET promo_balance = v_promo WHERE id = r.id;
          v_err := v_err + 1; CONTINUE;
        END IF;

        UPDATE unions SET promo_funded_from_bbj = COALESCE(promo_funded_from_bbj,0) + v_promo,
                          updated_at = NOW()
         WHERE id = v_union_id;

        INSERT INTO union_wallet_transactions
          (id, union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes, created_at)
        VALUES (gen_random_uuid(), v_union_id, 'promo_wallet', 'credit', v_promo, v_after,
                'bbj_promo_sweep', r.club_id,
                'BBJ promo slice (25% of contribution) swept from pool', NOW());
        v_to_union := v_to_union + 1;

      ELSIF r.club_id IS NOT NULL THEN
        UPDATE clubs SET promo_balance = COALESCE(promo_balance,0) + v_promo, updated_at = NOW()
         WHERE id = r.club_id RETURNING promo_balance INTO v_after;
        PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
        PERFORM set_config('app.ledger_autoskip_clubs', '', true);
        IF v_after IS NULL THEN
          UPDATE bbj_pools SET promo_balance = v_promo WHERE id = r.id;
          v_err := v_err + 1; CONTINUE;
        END IF;
        INSERT INTO chip_transactions (id, club_id, from_user_id, to_user_id, amount,
                                       transaction_type, notes, balance_after, created_at)
        VALUES (gen_random_uuid(), r.club_id, NULL, NULL, v_promo, 'bbj_promo_sweep',
                'BBJ promo slice swept to club promo wallet (club has no union)', v_after, NOW());
        v_to_club := v_to_club + 1;
      ELSE
        UPDATE bbj_pools SET promo_balance = v_promo WHERE id = r.id;
        v_err := v_err + 1; CONTINUE;
      END IF;

      v_swept := v_swept + v_promo; v_pools := v_pools + 1;
    EXCEPTION WHEN OTHERS THEN v_err := v_err + 1;
    END;
  END LOOP;
  PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
  PERFORM set_config('app.ledger_autoskip_clubs', '', true);

  RETURN jsonb_build_object('success', true, 'pools_swept', v_pools, 'total_swept', v_swept,
                            'to_union', v_to_union, 'to_club', v_to_club, 'errors', v_err);
END;
$function$

;

-- ── Post-apply assertions ───────────────────────────────────────────────────────
-- Each declaration is in the live body, no function grew a refusal, and the
-- grants are exactly what they were (authenticated on registration only).
DO $assert$
DECLARE
  v_src text;
  v_raises int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_register_for_tournament' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%set_config(''app.ledger_category'', ''tournament_buyin'', true)%'
     OR v_src NOT LIKE '%set_config(''app.ledger_counterparty'', ''prize_liability'', true)%'
     OR v_src NOT LIKE '%set_config(''app.ledger_tournament'', p_tournament_id::text, true)%' THEN
    RAISE EXCEPTION 'fn_register_for_tournament does not declare tournament_buyin -> prize_liability';
  END IF;
  v_raises := (length(v_src) - length(replace(v_src, 'RAISE EXCEPTION', ''))) / length('RAISE EXCEPTION');
  IF v_raises <> 2 THEN
    RAISE EXCEPTION 'fn_register_for_tournament RAISE EXCEPTION count changed: %', v_raises;
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'process_tournament_rebuy_before_one_minute_addon' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%set_config(''app.ledger_category'', v_cat, true)%'
     OR v_src NOT LIKE '%set_config(''app.ledger_counterparty'', ''prize_liability'', true)%' THEN
    RAISE EXCEPTION 'rebuy core does not declare v_cat -> prize_liability';
  END IF;
  v_raises := (length(v_src) - length(replace(v_src, 'RAISE EXCEPTION', ''))) / length('RAISE EXCEPTION');
  IF v_raises <> 21 THEN
    RAISE EXCEPTION 'rebuy core RAISE EXCEPTION count changed: %', v_raises;
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_spin_settle_game' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%fn_ca_declare_ledger(''spin_prize'', ''prize_liability'', p_tournament_id)%' THEN
    RAISE EXCEPTION 'fn_spin_settle_game does not declare spin_prize -> prize_liability';
  END IF;
  v_raises := (length(v_src) - length(replace(v_src, 'RAISE EXCEPTION', ''))) / length('RAISE EXCEPTION');
  IF v_raises <> 3 THEN
    RAISE EXCEPTION 'fn_spin_settle_game RAISE EXCEPTION count changed: %', v_raises;
  END IF;

  FOR v_src IN SELECT prosrc FROM pg_proc
                WHERE proname IN ('fn_sweep_bbj_promo', 'fn_sweep_bbj_promo_all')
                  AND pronamespace = 'public'::regnamespace LOOP
    IF v_src NOT LIKE '%fn_ca_declare_ledger(''promo'',%'
       OR v_src NOT LIKE '%ARRAY[''union_wallets'', ''clubs'']%' THEN
      RAISE EXCEPTION 'a BBJ promo sweep does not declare promo bbj_pool -> union_wallet | promo_wallet';
    END IF;
    IF v_src LIKE '%RAISE EXCEPTION%' THEN
      RAISE EXCEPTION 'a BBJ promo sweep grew a refusal';
    END IF;
  END LOOP;

  -- The vocabulary the declarations rely on is live (the primitive would refuse otherwise).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.chip_ledger'::regclass AND conname = 'chip_ledger_category_check'
                    AND pg_get_constraintdef(oid) LIKE '%''tournament_buyin''%'
                    AND pg_get_constraintdef(oid) LIKE '%''spin_prize''%'
                    AND pg_get_constraintdef(oid) LIKE '%''promo''%'
                    AND pg_get_constraintdef(oid) LIKE '%''rebuy''%'
                    AND pg_get_constraintdef(oid) LIKE '%''addon''%') THEN
    RAISE EXCEPTION 'chip_ledger_category_check lacks a word this migration declares';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.chip_ledger'::regclass AND conname = 'chip_ledger_to_type_check'
                    AND pg_get_constraintdef(oid) LIKE '%''prize_liability''%'
                    AND pg_get_constraintdef(oid) LIKE '%''union_wallet''%'
                    AND pg_get_constraintdef(oid) LIKE '%''promo_wallet''%') THEN
    RAISE EXCEPTION 'chip_ledger_to_type_check lacks a counterparty this migration declares';
  END IF;

  -- Grants exactly as before.
  IF NOT has_function_privilege('authenticated', 'public.fn_register_for_tournament(uuid, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_sweep_bbj_promo(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_sweep_bbj_promo_all()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.process_tournament_rebuy_before_one_minute_addon(uuid, uuid, text, numeric, numeric, integer, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_register_for_tournament(uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a grant moved; this migration must not change who may call';
  END IF;
END $assert$;

COMMIT;
