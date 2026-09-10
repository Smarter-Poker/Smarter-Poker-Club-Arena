-- Auth and external platform state are synthetic; registration and money writers below are installed SQL.
CREATE TABLE public.profiles(id uuid PRIMARY KEY, username text, display_name text,
 is_vip boolean DEFAULT false, vip_expires_at timestamptz, is_horse boolean DEFAULT false);
CREATE TABLE public.clubs(id uuid PRIMARY KEY, union_id uuid);
CREATE TABLE public.unions(id uuid PRIMARY KEY);
CREATE TABLE public.union_clubs(club_id uuid, union_id uuid);
CREATE TABLE public.wallets(user_id uuid, wallet_type text, balance numeric, updated_at timestamptz);
CREATE TABLE public.tournament_launch_receipts(tournament_id uuid PRIMARY KEY, launch_id uuid,
 lease_generation uuid, completed_at timestamptz);
CREATE FUNCTION public.fn_caller_session_is_live() RETURNS boolean LANGUAGE sql STABLE
 AS $$ SELECT auth.uid() IS NOT NULL $$;
CREATE FUNCTION public.fn_entry_purchases_frozen() RETURNS boolean LANGUAGE sql STABLE
 AS $$ SELECT COALESCE(NULLIF(current_setting('test.frozen',true),'')::boolean,false) $$;
CREATE FUNCTION public.fn_tournament_late_registration_open(uuid) RETURNS boolean LANGUAGE plpgsql
 AS $$ BEGIN RAISE EXCEPTION 'late-entry seating is outside this fixture'; END $$;
INSERT INTO public.ca_financial_epochs(id,is_current) VALUES(1,true);
CREATE TABLE public.entry_purchase_idempotency_receipts (key_domain text NOT NULL,idempotency_key text NOT NULL,request jsonb NOT NULL,response jsonb,claimed_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,completed_at timestamp with time zone,CONSTRAINT entry_purchase_idempotency_receipts_domain_nonempty CHECK ((length(btrim(key_domain)) > 0)),CONSTRAINT entry_purchase_idempotency_receipts_key_nonempty CHECK ((length(btrim(idempotency_key)) > 0)),CONSTRAINT entry_purchase_idempotency_receipts_pkey PRIMARY KEY (key_domain, idempotency_key));

-- Installed Body MD5: 67004d0697386ae3ced5411c0360eb34
CREATE OR REPLACE FUNCTION public.atomic_deduct_wallet_and_log(p_user_id uuid, p_amount numeric, p_category text DEFAULT 'debit'::text, p_description text DEFAULT ''::text, p_table_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_related_entity_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_balance numeric;
  v_club_id uuid;
  v_context_club uuid;
  v_declared_club uuid;
  v_declared_text text;
  v_has_club boolean;
BEGIN
  IF p_user_id IS NULL
     OR p_amount IS NULL
     OR p_amount::text IN ('NaN','Infinity','-Infinity')
     OR p_amount <= 0
     OR p_amount <> round(p_amount,2) THEN
    RAISE EXCEPTION 'wallet debit requires a positive two-decimal amount'
      USING ERRCODE='22023';
  END IF;

  v_declared_text:=NULLIF(current_setting('app.ledger_club_id',true),'');
  IF v_declared_text IS NOT NULL THEN
    BEGIN
      v_declared_club:=v_declared_text::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'wallet debit declared club is not a UUID'
        USING ERRCODE='22023';
    END;
    v_club_id:=v_declared_club;
  END IF;

  IF p_table_id IS NOT NULL THEN
    SELECT t.club_id INTO v_context_club
      FROM public.tables t
     WHERE t.id=p_table_id;
    IF v_context_club IS NULL THEN
      RAISE EXCEPTION 'wallet debit table % has no club context',p_table_id
        USING ERRCODE='P0002';
    END IF;
    IF v_club_id IS NOT NULL AND v_club_id<>v_context_club THEN
      RAISE EXCEPTION 'wallet debit declared club does not own table %',p_table_id
        USING ERRCODE='22023';
    END IF;
    v_club_id:=v_context_club;
  END IF;

  IF p_related_entity_id IS NOT NULL
     AND lower(COALESCE(p_category,'')) IN
       ('tournament_buyin','tournament_rebuy','rebuy','reentry','addon') THEN
    SELECT t.club_id INTO v_context_club
      FROM public.tournaments t
     WHERE t.id=p_related_entity_id;
    IF v_context_club IS NULL THEN
      RAISE EXCEPTION 'wallet debit tournament % has no club context',
        p_related_entity_id USING ERRCODE='P0002';
    END IF;
    IF v_club_id IS NOT NULL AND v_club_id<>v_context_club THEN
      RAISE EXCEPTION 'wallet debit declared club does not own tournament %',
        p_related_entity_id USING ERRCODE='22023';
    END IF;
    v_club_id:=v_context_club;
  END IF;

  IF v_club_id IS NULL THEN
    v_club_id:=public.fn_player_home_club(p_user_id,NULL);
  END IF;

  IF v_club_id IS NOT NULL THEN
    IF public.fn_ensure_club_wallet(p_user_id,v_club_id) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'player % has no active wallet at club %',p_user_id,v_club_id
        USING ERRCODE='42501';
    END IF;
    SELECT cm.chip_balance INTO v_balance
      FROM public.club_members cm
     WHERE cm.user_id=p_user_id AND cm.club_id=v_club_id
       AND cm.status IN ('active','approved')
     FOR UPDATE;
    IF v_balance IS NULL OR v_balance<p_amount THEN
      RETURN false;
    END IF;
    UPDATE public.club_members cm
       SET chip_balance=cm.chip_balance-p_amount,updated_at=now()
     WHERE cm.user_id=p_user_id AND cm.club_id=v_club_id
       AND cm.status IN ('active','approved')
       AND cm.chip_balance>=p_amount;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    INSERT INTO public.chip_transactions(
      club_id,from_user_id,amount,transaction_type,notes
    ) VALUES (
      v_club_id,p_user_id,p_amount,p_category,
      COALESCE(NULLIF(p_description,''),'Wallet debit')
    );
    RETURN true;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.club_members cm WHERE cm.user_id=p_user_id
  ) INTO v_has_club;
  IF v_has_club THEN
    RAISE EXCEPTION 'No active club wallet resolves for Club Arena debit from player %',
      p_user_id USING ERRCODE='42501';
  END IF;

  UPDATE public.wallets w
     SET balance=w.balance-p_amount,updated_at=now()
   WHERE w.user_id=p_user_id AND w.wallet_type='PLAYER'
     AND w.balance>=p_amount;
  RETURN FOUND;
END;
$function$
;
-- Installed Body MD5: 24e6b8e732c77b831c16d321b1d6fa61
CREATE OR REPLACE FUNCTION public.fn_ca_lock_tournament_seat_acquisition(p_tournament_id uuid, p_table_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid:=p_tournament_id;
  v_table_tournament_id uuid;
  v_status text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM pg_advisory_xact_lock_shared(530090,1);

  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;

  IF p_user_id IS NOT NULL THEN
    PERFORM public.fn_lock_daily_mission_user(p_user_id);
  END IF;

  IF p_table_id IS NOT NULL THEN
    SELECT tb.tournament_id INTO v_table_tournament_id
      FROM public.tables tb
     WHERE tb.id=p_table_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok',false,'reason','table_not_found');
    END IF;
    IF v_table_tournament_id IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','not_a_tournament_table');
    END IF;
    IF v_tournament_id IS NOT NULL
       AND v_tournament_id IS DISTINCT FROM v_table_tournament_id THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','table_tournament_mismatch');
    END IF;
    v_tournament_id:=v_table_tournament_id;
  END IF;

  IF v_tournament_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_or_table_required');
  END IF;

  -- Launch completion already owns receipt -> tournament. Re-entering these
  -- locks from every seat root makes the historical aa_ launch-proof trigger
  -- a no-op lock acquisition rather than a late inversion.
  PERFORM r.tournament_id
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id=v_tournament_id
   ORDER BY r.tournament_id
   FOR UPDATE;

  SELECT upper(COALESCE(t.status::text,'')) INTO v_status
    FROM public.tournaments t
   WHERE t.id=v_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF v_status NOT IN ('ANNOUNCED','REGISTERING','RUNNING') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_seatable','status',v_status);
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'tournament_id',v_tournament_id,
    'table_id',p_table_id,'status',v_status);
END;
$function$
;
-- Installed Body MD5: 797c1eac824f1cff55279c53f4094bce
CREATE OR REPLACE FUNCTION public.fn_register_for_tournament_before_atomic_capacity_20260907(p_tournament_id uuid, p_seat_first_internal boolean DEFAULT false)
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
  v_players_before integer;
  v_expected_cached_players integer;
  v_rows integer;
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
  -- CANONICAL seat-first test (variant 'spin' OR a positive max_players <= 2), matching
  -- fn_take_seat_and_buy_in and fn_sync_seat_first_player_count: the original
  -- blocked ALL sngs, which left 6-max and 9-max SNGs with no entry path in
  -- either door.
  IF NOT p_seat_first_internal
     AND (lower(COALESCE(v_t.variant, '')) = 'spin'
       OR (v_t.max_players IS NOT NULL
         AND v_t.max_players > 0 AND v_t.max_players <= 2)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_first_variant',
      'detail', 'This format is entered by taking a seat, not by registering. '
                || 'Call fn_take_seat_and_buy_in for the seat you want.',
      'variant', v_t.variant);
  END IF;

  IF v_t.status = 'RUNNING' THEN
    v_late_open:=public.fn_tournament_late_registration_open(p_tournament_id);
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
      'Tournament roster cache diverged before registration (cached %, actual %)',
      v_t.current_players,v_players_before
      USING ERRCODE='P0404';
  END IF;
  IF v_t.max_players IS NOT NULL AND v_t.max_players > 0
     AND v_players_before >= v_t.max_players THEN
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
    RAISE EXCEPTION
      'Tournament registration identity changed after its atomic debit; retry the complete transaction'
      USING ERRCODE = '40001';
  END;

  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players, bbj_contribution,
       is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_split.rake, v_split.charge, 1, 0, true, p_tournament_id,
            'fn_register_for_tournament',
            jsonb_build_object('kind','tournament_entry_fee','user_id',v_uid,'registration_id',v_player_id));
  END IF;

  -- The roster trigger already writes the exact count while an event is
  -- ANNOUNCED/REGISTERING, but deliberately leaves RUNNING counts to the
  -- transaction that also seats the late entrant. Incrementing the cached
  -- value here therefore double-counted every pre-start entry. Require the
  -- exact state produced by that trigger (or the unchanged RUNNING state),
  -- then publish one roster-derived value together with the funded pools.
  v_expected_cached_players:=CASE
    WHEN v_t.status IN ('ANNOUNCED','REGISTERING') THEN v_players_before+1
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
      'Tournament roster cache changed during registration'
      USING ERRCODE='40001';
  END IF;

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
-- Installed Body MD5: 4aaaba86492ea2bd9e4e89ff5210f68c
CREATE OR REPLACE FUNCTION public.fn_register_for_tournament_before_maintenance_announcement_gate(p_tournament_id uuid, p_seat_first_internal boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record;
BEGIN
  SELECT t.status,COALESCE(t.prize_pool_finalized,false) AS finalized
    INTO v_t
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF v_t.finalized THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_closed');
  END IF;
  IF v_t.status='RUNNING' THEN
    IF NOT public.fn_tournament_late_registration_open(p_tournament_id) THEN
      RETURN jsonb_build_object('ok',false,'reason','registration_closed');
    END IF;
  ELSIF v_t.status NOT IN ('ANNOUNCED','REGISTERING') THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_closed');
  END IF;
  RETURN public.fn_register_for_tournament_before_atomic_lifecycle_gate(
    p_tournament_id,COALESCE(p_seat_first_internal,false));
END;
$function$
;
-- Installed Body MD5: 0cdd7a818340195567415a63baece39b
CREATE OR REPLACE FUNCTION public.fn_register_for_tournament_before_terminal_seat_gate(p_tournament_id uuid, p_seat_first_internal boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;
  RETURN public.fn_register_for_tournament_before_maintenance_announcement_gate(
    p_tournament_id, p_seat_first_internal
  );
END;
$function$
;
-- Installed Body MD5: c80d08529c03284adc51c6cb03764a55
CREATE OR REPLACE FUNCTION public.fn_register_for_tournament_request(p_tournament_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_request jsonb;
  v_claim jsonb;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'A live authenticated session is required' USING ERRCODE = '28000';
  END IF;
  IF p_tournament_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'Tournament and request identity are required' USING ERRCODE = '22004';
  END IF;
  v_request := jsonb_build_object(
    'tournament_id', p_tournament_id, 'user_id', v_uid, 'funding_kind', 'club_wallet'
  );
  v_claim := public.fn_claim_entry_purchase_receipt(
    'tournament_registration_v1', p_request_id::text, v_request
  );
  IF v_claim->'claimed' = 'false'::jsonb THEN
    RETURN v_claim->'response';
  END IF;

  -- All funding, roster, fee and pool writes remain in the existing core.
  -- Its maintenance gate applies to a new purchase, never to a committed replay.
  v_result := public.fn_register_for_tournament(p_tournament_id, false);
  IF v_result->'ok' = 'false'::jsonb THEN
    PERFORM public.fn_release_entry_purchase_claim(
      'tournament_registration_v1', p_request_id::text, v_request
    );
    RETURN v_result || jsonb_build_object('request_id', p_request_id);
  END IF;
  IF v_result->'ok' IS DISTINCT FROM 'true'::jsonb
     OR NULLIF(v_result->>'registration_id', '') IS NULL THEN
    RAISE EXCEPTION 'Registration did not return a confirmed entry receipt'
      USING ERRCODE = '55000';
  END IF;
  -- Cast verifies the core receipt before any financial write may commit.
  PERFORM (v_result->>'registration_id')::uuid;
  v_result := v_result || jsonb_build_object(
    'request_id', p_request_id, 'tournament_id', p_tournament_id, 'user_id', v_uid
  );
  RETURN public.fn_record_entry_purchase_receipt(
    'tournament_registration_v1', p_request_id::text, v_request, v_result
  );
END;
$function$
;
-- Installed Body MD5: 233acf6219e11af17d2c44b4b4460bc0
CREATE OR REPLACE FUNCTION public.fn_register_for_tournament(p_tournament_id uuid, p_seat_first_internal boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_gate jsonb;
BEGIN
  IF public.fn_caller_session_is_live() IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE='28000';
  END IF;
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,auth.uid());
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  RETURN public.fn_register_for_tournament_before_terminal_seat_gate(
    p_tournament_id,p_seat_first_internal);
END;
$function$
;
-- Installed Body MD5: 14d25f13e1ceca68cf4da1e231cc342b
CREATE OR REPLACE FUNCTION public.log_wallet_transaction(p_user_id uuid, p_wallet_type text, p_amount numeric, p_type text, p_category text, p_description text, p_table_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_related_entity_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_bal NUMERIC; v_club uuid;
BEGIN
  /* ZERO-DRIFT (2026-08-31): club members' live balance is
     club_members.chip_balance; public.wallets has been frozen since
     2026-08-21, so reading it stamped a stale balance_after on every row. */
  IF p_wallet_type = 'PLAYER' THEN
    v_club := public.fn_player_home_club(p_user_id, NULL);
    IF v_club IS NOT NULL THEN
      SELECT chip_balance INTO v_bal FROM club_members
       WHERE user_id = p_user_id AND club_id = v_club;
    END IF;
  END IF;
  IF v_bal IS NULL THEN
    SELECT balance INTO v_bal FROM wallets WHERE user_id = p_user_id AND wallet_type = p_wallet_type;
  END IF;
  INSERT INTO wallet_transactions (user_id, wallet_type, amount, type, category, description, table_id, hand_id, related_entity_id, balance_after, created_at)
  VALUES (p_user_id, p_wallet_type, p_amount, p_type, p_category, p_description, p_table_id, p_hand_id, p_related_entity_id, COALESCE(v_bal, 0), NOW());
END;
$function$
;
-- Installed Body MD5: 5ef42a66919bb5b84676a250ed0cf176
CREATE OR REPLACE FUNCTION public.fn_claim_entry_purchase_receipt(p_key_domain text, p_idempotency_key text, p_request jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('claimed', true);
  END IF;

  INSERT INTO public.entry_purchase_idempotency_receipts
    (key_domain, idempotency_key, request)
  VALUES (p_key_domain, p_idempotency_key, p_request)
  ON CONFLICT (key_domain, idempotency_key) DO NOTHING
  RETURNING request, response INTO v_request, v_response;
  IF FOUND THEN
    RETURN jsonb_build_object('claimed', true);
  END IF;

  /* The unique-index wait above cannot observe an uncommitted placeholder.
     A committed placeholder without a response means some code violated the
     same-transaction contract, so it is corruption-not permission to rerun
     a money core. */
  SELECT r.request, r.response
    INTO STRICT v_request, v_response
    FROM public.entry_purchase_idempotency_receipts r
   WHERE r.key_domain = p_key_domain
     AND r.idempotency_key = p_idempotency_key;
  IF v_request IS DISTINCT FROM p_request THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_KEY_REUSED: % key is already bound to a different entry purchase',
      p_key_domain
      USING ERRCODE = '22023';
  END IF;
  IF v_response IS NULL THEN
    RAISE EXCEPTION
      'INCOMPLETE_IDEMPOTENCY_RECEIPT: % key was committed without its response',
      p_key_domain
      USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object('claimed', false, 'response', v_response);
END;
$function$
;
-- Installed Body MD5: 9a9fb5c1f8a4a88bbeed01710af6c4c2
CREATE OR REPLACE FUNCTION public.fn_ensure_club_wallet(p_user_id uuid, p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.user_id = p_user_id AND cm.club_id = p_club_id
       AND cm.status IN ('active', 'approved')
  );
$function$
;
-- Installed Body MD5: 23b5a637e3c5bdbda3ac3c5441063910
CREATE OR REPLACE FUNCTION public.fn_lock_daily_mission_user(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'A Daily Missions player is required';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('daily-missions-user:' || p_user_id::text, 0)
  );

  PERFORM 1
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Missions profile not found for player %', p_user_id;
  END IF;
END;
$function$
;
-- Installed Body MD5: 2d052a4815d033295d98772989224800
CREATE OR REPLACE FUNCTION public.fn_player_home_club(p_user_id uuid, p_club_hint uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_club uuid;
BEGIN
  IF p_user_id IS NULL THEN RETURN NULL; END IF;
  IF p_club_hint IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.user_id = p_user_id AND cm.club_id = p_club_hint
       AND cm.status IN ('active','approved')
  ) THEN RETURN p_club_hint; END IF;
  SELECT cm.club_id INTO v_club
    FROM public.club_members cm
   WHERE cm.user_id = p_user_id AND cm.status IN ('active','approved')
   ORDER BY cm.joined_at ASC NULLS LAST, cm.club_id
   LIMIT 1;
  RETURN v_club;
END;
$function$
;
-- Installed Body MD5: a3f605ec417d2977dc684ffc0656a982
CREATE OR REPLACE FUNCTION public.fn_record_entry_purchase_receipt(p_key_domain text, p_idempotency_key text, p_request jsonb, p_response jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RETURN p_response;
  END IF;
  IF p_request IS NULL OR p_response IS NULL THEN
    RAISE EXCEPTION 'entry purchase receipts require a non-null request and response'
      USING ERRCODE = '22004';
  END IF;

  SELECT r.request, r.response
    INTO STRICT v_request, v_response
    FROM public.entry_purchase_idempotency_receipts r
   WHERE r.key_domain = p_key_domain
     AND r.idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF v_request IS DISTINCT FROM p_request THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_KEY_REUSED: % key completed concurrently for a different entry purchase',
      p_key_domain
      USING ERRCODE = '22023';
  END IF;
  IF v_response IS NOT NULL THEN
    RETURN v_response;
  END IF;

  UPDATE public.entry_purchase_idempotency_receipts r
     SET response = p_response,
         completed_at = transaction_timestamp()
   WHERE r.key_domain = p_key_domain
     AND r.idempotency_key = p_idempotency_key
     AND r.request IS NOT DISTINCT FROM p_request
     AND r.response IS NULL
  RETURNING r.response INTO STRICT v_response;
  RETURN v_response;
END;
$function$
;
-- Installed Body MD5: 3ff08e4dd812c8b0cc8a823fd78a95e4
CREATE OR REPLACE FUNCTION public.fn_register_for_tournament_before_atomic_lifecycle_gate(p_tournament_id uuid, p_seat_first_internal boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  BEGIN
    v_result := public.fn_register_for_tournament_before_atomic_capacity_20260907(
      p_tournament_id,p_seat_first_internal);
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM NOT LIKE 'Late registration could not seat the player (%)%' THEN
      RAISE;
    END IF;
    PERFORM public.fn_ensure_late_registration_capacity(p_tournament_id,1);
    v_result := public.fn_register_for_tournament_before_atomic_capacity_20260907(
      p_tournament_id,p_seat_first_internal);
  END;

  IF COALESCE((v_result->>'ok')::boolean,false)
     AND COALESCE((v_result->>'late_registration')::boolean,false) THEN
    PERFORM public.fn_emit_tournament_manager_wake(p_tournament_id,'late_registration');
  END IF;
  RETURN v_result;
END;
$function$
;
-- Installed Body MD5: 121d57c389c5f74809e833154ef28f12
CREATE OR REPLACE FUNCTION public.fn_release_entry_purchase_claim(p_key_domain text, p_idempotency_key text, p_request jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RETURN;
  END IF;
  DELETE FROM public.entry_purchase_idempotency_receipts r
   WHERE r.key_domain = p_key_domain
     AND r.idempotency_key = p_idempotency_key
     AND r.request IS NOT DISTINCT FROM p_request
     AND r.response IS NULL;
END;
$function$
;
-- Installed Body MD5: f9f8a8946bc474c4dad9941869f69399
CREATE OR REPLACE FUNCTION public.fn_ca_chip_ledger_enrich()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prev text;
BEGIN
  NEW.amount := round(NEW.amount, 2);
  NEW.created_at := COALESCE(NEW.created_at, now());

  NEW.epoch_id      := COALESCE(NEW.epoch_id, public.fn_ca_current_epoch());
  NEW.actor_service := COALESCE(NEW.actor_service,
                                current_setting('application_name', true));
  NEW.db_role       := COALESCE(NEW.db_role, current_user);
  NEW.correlation_id := COALESCE(NEW.correlation_id,
      NULLIF(current_setting('app.ledger_correlation', true), '')::uuid);
  NEW.settlement_id  := COALESCE(NEW.settlement_id,
      NULLIF(current_setting('app.ledger_settlement', true), ''));
  IF NEW.idempotency_key IS NULL THEN
    NEW.idempotency_key := NULLIF(current_setting('app.ledger_idempotency_key', true), '');
    IF NEW.idempotency_key IS NOT NULL THEN
      -- consume-once: the next row in this transaction must not inherit it
      PERFORM set_config('app.ledger_idempotency_key', '', true);
    END IF;
  END IF;

  /* PHASE 6.4 (2026-09-05): EVERY LEG NAMES ITS HAND OR ITS EVENT. The doors
     that know the hand say so on app.ledger_hand_id (the rake door and the
     BBJ drop, since today) or on a 'bbj:<hand>' settlement; the rake
     settlement is not read for it because it carries a random key when the
     hand is unknown, and a guessed hand is worse than none; a spin's reserve legs
     carry the spin on their prize_liability side. Read them here, once, so
     the hand and the event are columns a per-hand audit can index on rather
     than strings it has to parse. 231,211 legs a day; 29,617 named a hand
     and 50,359 an event before this. */
  IF NEW.hand_id IS NULL THEN
    NEW.hand_id := NULLIF(current_setting('app.ledger_hand_id', true), '')::uuid;
    IF NEW.hand_id IS NULL AND NEW.settlement_id ~ '^bbj:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      NEW.hand_id := split_part(NEW.settlement_id, ':', 2)::uuid;
    END IF;
  END IF;
  IF NEW.tournament_id IS NULL THEN
    NEW.tournament_id := NULLIF(current_setting('app.ledger_tournament_id', true), '')::uuid;
    /* PHASE 6 GATE (2026-09-05): a prize_liability side IS the event, on every
       category, not only the two spin ones. This is what the 6.4 measurement
       missed: 777 tournament rake settlements in three hours (the fee leaving
       an event to a union rake wallet or a club treasury) and every tournament
       add-on named nothing. Read against the rows first: all 777 from_entity_id
       values are real tournaments. The FROM side wins when both sides are
       prize_liability (a satellite seat's pool transfer, which already stamps
       the satellite itself). */
    IF NEW.tournament_id IS NULL THEN
      IF NEW.from_type = 'prize_liability' THEN NEW.tournament_id := NEW.from_entity_id;
      ELSIF NEW.to_type = 'prize_liability' THEN NEW.tournament_id := NEW.to_entity_id;
      END IF;
    END IF;
  END IF;
  /* PHASE 6 GATE: and a table_stack side IS the table. Every cash buy-in,
     add-on and cash-out carries the table on its felt side (231, 53 and 222
     of each measured in the same window, every one a real table row) and
     none of them carried table_id. A cash buy-in is not a hand; the table is
     the name it has. */
  IF NEW.table_id IS NULL THEN
    IF NEW.to_type = 'table_stack' THEN NEW.table_id := NEW.to_entity_id;
    ELSIF NEW.from_type = 'table_stack' THEN NEW.table_id := NEW.from_entity_id;
    END IF;
  END IF;

  -- Tamper evidence: monotone sequence + per-row content checksum. NOT chained
  -- through the previous row's hash at insert time - that would put a global
  -- serialization point (and deadlock surface) inside every money transaction,
  -- which the availability policy forbids. prev_hash is best-effort forensics.
  NEW.chain_seq := nextval('public.chip_ledger_chain_seq');
  SELECT row_hash INTO v_prev
    FROM public.chip_ledger
   WHERE chain_seq = NEW.chain_seq - 1;
  NEW.prev_hash := v_prev;
  NEW.row_hash := encode(extensions.digest(
      'v1'
      || '|' || NEW.chain_seq::text
      || '|' || COALESCE(NEW.epoch_id::text,'')
      || '|' || NEW.amount::text
      || '|' || NEW.from_type || ':' || COALESCE(NEW.from_entity_id::text,'')
      || '|' || NEW.to_type   || ':' || COALESCE(NEW.to_entity_id::text,'')
      || '|' || NEW.category
      || '|' || COALESCE(NEW.idempotency_key,'')
      || '|' || COALESCE(NEW.correlation_id::text,'')
      || '|' || NEW.created_at::text,
      'sha256'), 'hex');
  RETURN NEW;
END $function$
;
-- Installed Body MD5: e773958f21214ee1aa4dd622234477a6
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_wallet_tx()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cat text := lower(COALESCE(NEW.category,''));
  v_amt numeric := round(COALESCE(NEW.amount,0),2);
  v_bounty numeric;
  v_split record;
  v_ent_count bigint;
  v_ent_amount numeric;
  v_wallet_count bigint;
  v_wallet_amount numeric;
  v_exact_token uuid := NULLIF(
    current_setting('app.ca_exact_refund_token',true),'')::uuid;
  v_authorization public.tournament_refund_authorizations%ROWTYPE;
  v_rows integer;
  v_credit_ledger_id uuid;
BEGIN
  IF NEW.related_entity_id IS NULL OR v_amt = 0 THEN RETURN NULL; END IF;
  IF NEW.type = 'debit' AND v_cat IN ('tournament_buyin','rebuy','addon') THEN
    SELECT * INTO v_split FROM public.fn_ca_tournament_charge_split(
      NEW.related_entity_id,v_cat,v_amt);
    SELECT count(*),round(COALESCE(sum(e.gross),0),2)
      INTO v_ent_count,v_ent_amount
      FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=NEW.related_entity_id AND e.user_id=NEW.user_id
       AND e.entitlement_kind='wallet_charge'
       AND e.charge_category=v_cat;
    SELECT count(*),round(COALESCE(sum(w.amount),0),2)
      INTO v_wallet_count,v_wallet_amount
      FROM public.wallet_transactions w
     WHERE w.related_entity_id=NEW.related_entity_id AND w.user_id=NEW.user_id
       AND w.type='debit' AND lower(w.category)=v_cat;
    IF v_ent_count IS DISTINCT FROM v_wallet_count
       OR v_ent_amount IS DISTINCT FROM v_wallet_amount THEN
      RAISE EXCEPTION
        'tournament wallet debit has no exact immutable charge entitlement'
        USING ERRCODE = 'P0404';
    END IF;
    v_bounty := v_split.refund_bounty;
    PERFORM public.fn_ca_escrow_apply(
      NEW.related_entity_id,v_cat,p_gross_in => v_amt,p_bounty_in => v_bounty);
  ELSIF NEW.type = 'credit' AND v_cat = 'prize' THEN
    PERFORM public.fn_ca_escrow_apply(
      NEW.related_entity_id,'prize',p_prize_out => v_amt);
  ELSIF NEW.type = 'debit' AND v_cat IN ('prize','prize_reversal') THEN
    PERFORM public.fn_ca_escrow_apply(
      NEW.related_entity_id,'prize reversal',p_prize_out => -v_amt);
  ELSIF NEW.type = 'credit' AND v_cat = 'bounty' THEN
    PERFORM public.fn_ca_escrow_apply(
      NEW.related_entity_id,'bounty',p_bounty_out => v_amt);
  ELSIF NEW.type = 'credit' AND v_cat IN ('refund','tournament_refund') THEN
    IF v_exact_token IS NULL THEN
      RAISE EXCEPTION
        'tournament refund credits require the one-use exact refund authority'
        USING ERRCODE = '42501';
    ELSE
      SELECT * INTO v_authorization
        FROM public.tournament_refund_authorizations a
       WHERE a.token = v_exact_token FOR UPDATE;
      IF v_authorization.token IS NULL
         OR v_authorization.tournament_id IS DISTINCT FROM NEW.related_entity_id
         OR v_authorization.user_id IS DISTINCT FROM NEW.user_id
         OR v_authorization.amount_paid_now IS DISTINCT FROM v_amt
         OR v_authorization.description IS DISTINCT FROM NEW.description
         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_refund_entitlements e
            WHERE e.id=v_authorization.entitlement_id
              AND e.tournament_id=NEW.related_entity_id
              AND e.user_id=NEW.user_id
              AND e.refund_wallet_club_id=
                    v_authorization.source_wallet_club_id
              AND e.gross=v_authorization.amount_paid_now
              AND e.refund_prize=v_authorization.refund_prize
              AND e.refund_bounty=v_authorization.refund_bounty
              AND e.refund_fee=v_authorization.refund_fee)
         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_obligations o
            WHERE o.id = v_authorization.obligation_id
              AND o.tournament_id = NEW.related_entity_id
              AND o.kind = 'refund' AND o.place IS NULL
              AND o.user_id = NEW.user_id
              AND o.amount_paid IS NOT DISTINCT FROM
                    v_authorization.amount_paid_before)
         OR NOT EXISTS (
           SELECT 1 FROM public.wallet_credit_idempotency k
            WHERE k.key = v_authorization.idempotency_key
              AND k.user_id = NEW.user_id AND k.amount = v_amt) THEN
        RAISE EXCEPTION 'wallet refund has no exact authorized component tranche'
          USING ERRCODE = 'P0404';
      END IF;
      DELETE FROM public.tournament_refund_authorizations a
       WHERE a.token = v_exact_token;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'exact refund authorization was not consumed once'
          USING ERRCODE = '40001';
      END IF;
      SELECT count(*),min(l.id::text)::uuid
        INTO v_rows,v_credit_ledger_id
        FROM public.chip_ledger l
       WHERE l.idempotency_key = v_authorization.idempotency_key
         AND l.tournament_id = NEW.related_entity_id
         AND l.club_id = v_authorization.source_wallet_club_id
         AND l.category = 'refund'
         AND l.from_type = 'prize_liability'
         AND l.from_entity_id = NEW.related_entity_id
         AND l.to_type = 'player_wallet'
         AND l.to_entity_id = NEW.user_id
         AND l.amount = v_amt;
      IF v_rows <> 1 OR v_credit_ledger_id IS NULL THEN
        RAISE EXCEPTION
          'wallet refund has no single exact source-club journal credit'
          USING ERRCODE = 'P0404';
      END IF;
      INSERT INTO public.tournament_refund_tranches(
        wallet_transaction_id,idempotency_key,tournament_id,obligation_id,user_id,
        source_wallet_club_id,entitlement_id,credit_ledger_id,
        amount_paid_before,amount_paid_now,refund_prize,refund_bounty,refund_fee,
        source,description,created_at)
      VALUES(
        NEW.id,v_authorization.idempotency_key,NEW.related_entity_id,
        v_authorization.obligation_id,NEW.user_id,
        v_authorization.source_wallet_club_id,
        v_authorization.entitlement_id,v_credit_ledger_id,
        v_authorization.amount_paid_before,v_amt,
        v_authorization.refund_prize,v_authorization.refund_bounty,
        v_authorization.refund_fee,v_authorization.source,
        NEW.description,transaction_timestamp());
      PERFORM public.fn_ca_escrow_apply_exact_refund(
        NEW.related_entity_id,'authorized exact refund',
        v_authorization.refund_prize,v_authorization.refund_bounty,
        v_authorization.refund_fee);
    END IF;
  END IF;
  RETURN NULL;
END;
$function$
;
-- Installed Body MD5: a790f58ade80215ee422416fc1690dd8
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_charge_split(p_tournament_id uuid, p_charge_category text, p_gross numeric)
 RETURNS TABLE(refund_prize numeric, refund_bounty numeric, refund_fee numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t record;
  v_entry record;
  v_kind text := lower(btrim(COALESCE(p_charge_category,'')));
  v_gross numeric := round(COALESCE(p_gross,0),2);
  v_is_bounty boolean;
  v_ratio numeric;
  v_fee numeric;
  v_bounty numeric;
BEGIN
  IF p_tournament_id IS NULL OR p_gross IS NULL
     OR p_gross::text IN ('NaN','Infinity','-Infinity')
     OR p_gross IS DISTINCT FROM v_gross OR v_gross <= 0
     OR v_kind NOT IN ('tournament_buyin','rebuy','addon') THEN
    RAISE EXCEPTION 'tournament charge split received an invalid contract'
      USING ERRCODE = '22003';
  END IF;
  SELECT t.buy_in_amount,t.buy_in_fee,t.bounty_amount,
         t.is_bounty,t.is_pko,t.is_mystery_bounty
    INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament charge split has no tournament %',p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  v_is_bounty := COALESCE(v_t.is_bounty,false)
              OR COALESCE(v_t.is_pko,false)
              OR COALESCE(v_t.is_mystery_bounty,false);
  IF v_kind='tournament_buyin' THEN
    SELECT * INTO v_entry FROM public.fn_tournament_entry_split(
      v_t.buy_in_amount,v_t.buy_in_fee,v_t.bounty_amount,v_is_bounty);
    IF v_entry.charge IS DISTINCT FROM v_gross THEN
      RAISE EXCEPTION
        'tournament buy-in ledger amount % does not match its funded split %',
        v_gross,v_entry.charge USING ERRCODE = '23514';
    END IF;
    refund_prize := v_entry.prize;
    refund_bounty := v_entry.bounty;
    refund_fee := v_entry.rake;
  ELSIF v_kind='addon' THEN
    IF v_gross IS DISTINCT FROM round(v_gross) THEN
      RAISE EXCEPTION 'add-on charge must be a positive whole chip amount'
        USING ERRCODE = '23514';
    END IF;
    refund_prize := v_gross;
    refund_bounty := 0;
    refund_fee := 0;
  ELSE
    IF v_gross IS DISTINCT FROM round(v_gross) THEN
      RAISE EXCEPTION 'rebuy charge must be a positive whole chip amount'
        USING ERRCODE = '23514';
    END IF;
    v_ratio := CASE
      WHEN COALESCE(v_t.buy_in_amount,0)+COALESCE(v_t.buy_in_fee,0)>0
           AND COALESCE(v_t.buy_in_fee,0)>0
        THEN v_t.buy_in_fee/(v_t.buy_in_amount+v_t.buy_in_fee)
      ELSE 0.1 END;
    v_fee := LEAST(
      trunc(v_gross*v_ratio*100+0.000001)/100,
      trunc(v_gross*0.1*100+0.000001)/100);
    v_bounty := CASE WHEN v_is_bounty THEN LEAST(
      GREATEST(0,round(COALESCE(v_t.bounty_amount,0),2)),v_gross-v_fee)
      ELSE 0 END;
    refund_fee := v_fee;
    refund_bounty := v_bounty;
    refund_prize := round(v_gross-v_fee-v_bounty,2);
  END IF;
  IF refund_prize IS NULL OR refund_bounty IS NULL OR refund_fee IS NULL
     OR refund_prize::text IN ('NaN','Infinity','-Infinity')
     OR refund_bounty::text IN ('NaN','Infinity','-Infinity')
     OR refund_fee::text IN ('NaN','Infinity','-Infinity')
     OR refund_prize < 0 OR refund_bounty < 0 OR refund_fee < 0
     OR v_gross IS DISTINCT FROM
          round(refund_prize+refund_bounty+refund_fee,2) THEN
    RAISE EXCEPTION 'tournament charge split produced invalid component rails'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEXT;
END;
$function$
;
-- Installed Body MD5: 6d6cfda08515d6bdd4f3ed4fabe7b36d
CREATE OR REPLACE FUNCTION public.fn_club_members_ledger_writer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d     numeric;
  actor uuid;
  cat   text;
  tid   uuid;
  st    text;
  msg   text;
  cp    text;
  cpid  uuid;
BEGIN
  /* THE AUTOSKIP CONTRACT IS ONE CONTRACT (2026-09-09). Every other journal
     writer on this platform stands down when the caller sets
     app.ledger_autoskip_<table>, because the caller is writing the leg itself
     with the period, the key and the metadata that only it knows. This writer
     never learned that clause. So a settlement that suppressed the clubs
     trigger and wrote its own named leg still got an anonymous twin from this
     side, and the movement reached the journal twice: on 2026-09-09 round 2
     moved 20,377.49 of commission and recorded 40,754.98 of legs. Standing
     down here is what makes one movement, one leg true for the busiest
     balance column on the platform. */
  IF current_setting('app.ledger_autoskip_club_members', true) = '1' THEN
    RETURN NEW;
  END IF;

  d := COALESCE(NEW.chip_balance, 0) - COALESCE(OLD.chip_balance, 0);

  IF d = 0 THEN
    RETURN NEW;
  END IF;

  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');

  BEGIN
    tid := NULLIF(current_setting('app.ledger_tournament', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    tid := NULL;
  END;

  /* THE COUNTERPARTY IS DECLARED, NEVER INFERRED (2026-08-31). */
  cp := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN
    cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    cpid := NULL;
  END;

  BEGIN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, tournament_id, description)
    VALUES (
      actor,
      CASE WHEN d > 0 THEN cp              ELSE 'player_wallet' END,
      CASE WHEN d > 0 THEN cpid            ELSE NEW.user_id     END,
      CASE WHEN d > 0 THEN 'player_wallet' ELSE cp              END,
      CASE WHEN d > 0 THEN NEW.user_id     ELSE cpid            END,
      abs(d), cat, NEW.club_id, tid,
      'auto-audited club_members.chip_balance delta ' || d::text);

  EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

  RETURN NEW;
END;
$function$
;
-- Installed Body MD5: 90e2944fd1af031edd2cc4c791fa5a5b
CREATE OR REPLACE FUNCTION public.fn_ca_capture_tournament_charge_entitlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_split record;
BEGIN
  IF NEW.tournament_id IS NULL
     OR NEW.from_type IS DISTINCT FROM 'player_wallet'
     OR NEW.to_type IS DISTINCT FROM 'prize_liability'
     OR NEW.to_entity_id IS DISTINCT FROM NEW.tournament_id
     OR lower(COALESCE(NEW.category,'')) NOT IN (
          'tournament_buyin','rebuy','addon') THEN
    RETURN NULL;
  END IF;
  IF NEW.from_entity_id IS NULL OR NEW.club_id IS NULL THEN
    RAISE EXCEPTION 'tournament charge ledger omitted player or source club'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT * INTO v_split FROM public.fn_ca_tournament_charge_split(
    NEW.tournament_id,NEW.category,NEW.amount);
  INSERT INTO public.tournament_refund_entitlements(
    tournament_id,user_id,entitlement_kind,charge_category,
    refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
    source_ledger_id,registration_id,source_satellite_id,source_award_place,
    escrow_bucket,evidence_kind,created_at)
  VALUES(
    NEW.tournament_id,NEW.from_entity_id,'wallet_charge',lower(NEW.category),
    NEW.club_id,round(NEW.amount,2),v_split.refund_prize,
    v_split.refund_bounty,v_split.refund_fee,NEW.id,NULL,NULL,NULL,
    'wallet_gross','atomic_wallet_charge',transaction_timestamp());
  RETURN NULL;
END;
$function$
;
-- Installed Body MD5: a653aec1cdebd0a3964d31b9ea02eb53
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_entry_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tclub uuid;
BEGIN
  -- Maintenance escape for deliberate service operations.
  IF current_setting('app.ca_entry_gate_skip', true) = '1' THEN
    RETURN NEW;
  END IF;
  SELECT t.club_id INTO v_tclub FROM public.tournaments t WHERE t.id = NEW.tournament_id;
  IF v_tclub IS NULL THEN
    RETURN NEW; -- clubless tournament: nothing to scope against
  END IF;
  IF NOT public.fn_ca_entry_scope_ok(NEW.user_id, v_tclub) THEN
    RAISE EXCEPTION 'tournament entry refused: player % has no club membership in the scope of tournament % (club/union %). Join a club in this union first.',
      NEW.user_id, NEW.tournament_id, v_tclub
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $function$
;
-- Installed Body MD5: 002d409f182d90f7e802ca2723d8ec18
CREATE OR REPLACE FUNCTION public.fn_enforce_tournament_capacity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_max int;
  v_have int;
  v_name text;
  v_status text;
  v_variant text;
  v_seat_first boolean;
BEGIN
  /* UNDER THE ROW LOCK (2026-09-06). This read the tournament without one, so
     two entries arriving together could both see room and both be admitted.
     Parent before child - the order every registration door already uses. */
  SELECT max_players, name, status, COALESCE(variant, '')
    INTO v_max, v_name, v_status, v_variant
    FROM public.tournaments WHERE id = NEW.tournament_id
    FOR NO KEY UPDATE;

  -- No declared capacity means no capacity to exceed (open MTTs).
  IF v_max IS NULL OR v_max <= 0 THEN
    RETURN NEW;
  END IF;

  /* 'sng' JOINS 'spin' (2026-09-06). fn_sync_seat_first_player_count has
     always counted ('spin','sng') OR max <= 2 as seat-first; this said
     'spin' OR max <= 2. All 35 overfilled events were sng, and they qualified
     only on the <= 2 half - a six-max sng was outside the rule entirely. */
  v_seat_first := (v_variant IN ('spin', 'sng') OR v_max <= 2);

  -- A seat-first board sells its seats once. After it stops being joinable it
  -- admits nobody, however many of its entrants have since busted.
  IF v_seat_first
     AND upper(COALESCE(v_status, '')) NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RAISE EXCEPTION
      'tournament_full: % is % and takes no further entrants',
      COALESCE(v_name, NEW.tournament_id::text), lower(v_status)
      USING ERRCODE = '23514';
  END IF;

  IF v_seat_first THEN
    /* AN ENTRY, NOT A SURVIVOR (2026-09-06). This branch used to exclude
       eliminated, winner, left, withdrawn, cancelled, refunded and busted -
       the right rule for a seat and the wrong one for an entry. On a
       two-handed board it meant a bust-out put a sold seat back on sale, and
       35 events took between 3 and 32 paid entries because of it. The board
       sold its seats; what became of the players who bought them is not a
       vacancy. */
    SELECT count(*) INTO v_have
      FROM public.tournament_players
     WHERE tournament_id = NEW.tournament_id;
  ELSE
    -- Multi-table events are unchanged: a busted entrant does not hold a seat
    -- against the next one on a board that is still filling.
    SELECT count(*) INTO v_have
      FROM public.tournament_players
     WHERE tournament_id = NEW.tournament_id
       AND COALESCE(status, 'registered') NOT IN
           ('eliminated', 'winner', 'left', 'withdrawn', 'cancelled', 'refunded', 'busted');
  END IF;

  IF v_have >= v_max THEN
    RAISE EXCEPTION
      'tournament_full: % already has % of % entrants', COALESCE(v_name, NEW.tournament_id::text), v_have, v_max
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$
;
-- Installed Body MD5: 0be1afe552ac9f2f6bdaefb616b57928
CREATE OR REPLACE FUNCTION public.fn_serialize_entry_statement()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* This is a backstop for a direct/unwrapped INSERT. A canonical RPC already
     owns the shared lock before touching any rows. An unexpected outer caller
     may already own unrelated rows, so waiting behind a queued maintenance
     writer here could form a soft deadlock. Fail the whole statement
     immediately and transactionally instead; the caller may retry from its
     outer boundary. */
  IF NOT pg_try_advisory_xact_lock_shared(530090, 1) THEN
    RAISE EXCEPTION
      'ENTRY_BOUNDARY_BUSY: maintenance announcement owns the entry boundary'
      USING ERRCODE = '40001';
  END IF;
  RETURN NULL;
END;
$function$
;
-- Installed Body MD5: a80d14951fce3b3a7ac32ae2897c8b69
CREATE OR REPLACE FUNCTION public.fn_stamp_entry_club()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.club_id IS NULL AND NEW.user_id IS NOT NULL AND NEW.tournament_id IS NOT NULL THEN
    NEW.club_id := public.fn_tournament_club_for_user(NEW.user_id, NEW.tournament_id, NULL);
  END IF;
  RETURN NEW;
END $function$
;
-- Installed Body MD5: 658d42f0c063778870e085341f08a050
CREATE OR REPLACE FUNCTION public.trg_lock_tournament_player_launch_proof()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ids uuid[];
  v_proof_open boolean;
  v_must_lock_live_seat_invariant boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.tournament_id IS NOT DISTINCT FROM OLD.tournament_id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.chips IS NOT DISTINCT FROM OLD.chips
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.seat_number IS NOT DISTINCT FROM OLD.seat_number THEN
    RETURN NEW;
  END IF;

  v_ids := CASE
    WHEN TG_OP = 'INSERT' THEN ARRAY[NEW.tournament_id]
    WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.tournament_id]
    ELSE ARRAY[OLD.tournament_id, NEW.tournament_id]
  END;

  /* A completed launch no longer needs every chip/link maintenance write to
     take its proof locks.  It DOES still need every mutation that can remove
     the active roster supporting a concurrent live-seat acquisition to share
     the same receipt -> tournament lock.  Without this distinction, a seat
     INSERT could prove an active roster while a concurrent DELETE or
     active-to-inactive UPDATE skipped the parent lock; each transaction could
     then commit the half of an impossible state it observed before the other.
     Identity changes and inactive/unknown status transitions stay on the
     conservative side.  Only same-active status/link/chip traffic may use the
     completed-launch fast path below. */
  v_must_lock_live_seat_invariant :=
    TG_OP = 'DELETE'
    OR (
      TG_OP = 'UPDATE'
      AND (
        NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
        OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NOT (
          OLD.status IN ('registered', 'playing')
          AND NEW.status IN ('registered', 'playing')
        )
      )
    );

  IF TG_OP <> 'INSERT' AND NOT v_must_lock_live_seat_invariant THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.tournaments t
        LEFT JOIN public.tournament_launch_receipts r
          ON r.tournament_id = t.id
       WHERE t.id = ANY(v_ids)
         AND (upper(t.status::text) = 'REGISTERING' OR r.completed_at IS NULL)
         AND (upper(t.status::text) = 'REGISTERING' OR r.tournament_id IS NOT NULL)
    ) INTO v_proof_open;
    IF NOT v_proof_open THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;

  PERFORM *
    FROM public.fn_lock_tournament_launch_proof_parents(v_ids);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$
;
-- Installed Body MD5: 18a3e548dd4820047e9e45203f35f3e3
CREATE OR REPLACE FUNCTION public.trg_refuse_finalized_tournament_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_finalized boolean;
BEGIN
  SELECT COALESCE(t.prize_pool_finalized, false)
    INTO v_finalized
    FROM public.tournaments t
   WHERE t.id = NEW.tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', NEW.tournament_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_finalized THEN
    RAISE EXCEPTION 'registration is closed because tournament % prize pool is finalized',
      NEW.tournament_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$
;
-- Installed Body MD5: 73344fa74743d9e6a4085d85a9a5261a
CREATE OR REPLACE FUNCTION public.fn_ca_entry_scope_ok(p_user_id uuid, p_tournament_club uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_union boolean; v_club_union uuid;
BEGIN
  IF p_user_id IS NULL OR p_tournament_club IS NULL THEN
    RETURN false;
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.unions u WHERE u.id = p_tournament_club) INTO v_is_union;
  IF v_is_union THEN
    -- Union-scoped tournament: member of any club in that union.
    RETURN EXISTS (
      SELECT 1 FROM public.club_members cm JOIN public.clubs c ON c.id = cm.club_id
       WHERE cm.user_id = p_user_id
         AND (c.union_id = p_tournament_club
              OR EXISTS (SELECT 1 FROM public.union_clubs uc
                          WHERE uc.club_id = c.id AND uc.union_id = p_tournament_club)));
  END IF;
  SELECT c.union_id INTO v_club_union FROM public.clubs c WHERE c.id = p_tournament_club;
  IF v_club_union IS NOT NULL THEN
    -- Club in a union: member of the club itself or any sibling club in the union.
    RETURN EXISTS (
      SELECT 1 FROM public.club_members cm JOIN public.clubs c ON c.id = cm.club_id
       WHERE cm.user_id = p_user_id
         AND (c.id = p_tournament_club
              OR c.union_id = v_club_union
              OR EXISTS (SELECT 1 FROM public.union_clubs uc
                          WHERE uc.club_id = c.id AND uc.union_id = v_club_union)));
  END IF;
  -- Standalone club: members only.
  RETURN EXISTS (SELECT 1 FROM public.club_members cm
                  WHERE cm.user_id = p_user_id AND cm.club_id = p_tournament_club);
END $function$
;
-- Installed Body MD5: a0a32c47d6ec20b05796b6b5a1f451af
CREATE OR REPLACE FUNCTION public.fn_lock_tournament_launch_proof_parents(p_tournament_ids uuid[])
 RETURNS TABLE(tournament_id uuid, parent_status text, launch_id uuid, launch_lease_generation uuid, launch_completed_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT requested.id ORDER BY requested.id)
    INTO v_ids
    FROM unnest(p_tournament_ids) AS requested(id)
   WHERE requested.id IS NOT NULL;

  IF v_ids IS NULL THEN
    RETURN;
  END IF;

  /* Do not invert these two blocks.  Launch completion already owns receipt
     -> parent, and every child must join that order. */
  /* A few legacy RPCs entered with the tournament parent already locked.
     Waiting for a receipt owned by completion would make a cycle: completion
     waits for their parent while they wait for its receipt.  Fail that outer
     transaction as retryable instead of waiting; a clean retry enters this
     helper before touching another launch-proof row. */
  BEGIN
    PERFORM 1
      FROM public.tournament_launch_receipts r
     WHERE r.tournament_id = ANY(v_ids)
     ORDER BY r.tournament_id
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION
      'TOURNAMENT_TRANSITION_BUSY: launch proof receipt is changing'
      USING ERRCODE = '40001';
  END;

  PERFORM 1
    FROM public.tournaments t
   WHERE t.id = ANY(v_ids)
   ORDER BY t.id
   FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM unnest(v_ids) AS requested(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.tournaments t WHERE t.id = requested.id
     )
  ) THEN
    RAISE EXCEPTION 'tournament launch proof child names a missing parent'
      USING ERRCODE = '23503';
  END IF;

  RETURN QUERY
    SELECT t.id,
           t.status::text,
           r.launch_id,
           r.lease_generation,
           r.completed_at
      FROM public.tournaments t
      LEFT JOIN public.tournament_launch_receipts r
        ON r.tournament_id = t.id
     WHERE t.id = ANY(v_ids)
     ORDER BY t.id;
END;
$function$
;
-- Installed Body MD5: 2b581783af79bb0f21d18a8e3e6af7d3
CREATE OR REPLACE FUNCTION public.fn_tournament_club_for_user(p_user_id uuid, p_tournament_id uuid, p_preferred_club uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid; v_t_club uuid; v_club uuid;
  v_is_horse boolean := false; v_n int; v_idx int;
BEGIN
  SELECT t.union_id, t.club_id INTO v_union, v_t_club
    FROM tournaments t WHERE t.id = p_tournament_id;

  IF v_union IS NULL THEN
    RETURN v_t_club;                       -- standalone club tournament
  END IF;

  IF p_preferred_club IS NOT NULL
     AND EXISTS (SELECT 1 FROM club_members m
                  JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
                 WHERE m.user_id = p_user_id AND m.club_id = p_preferred_club
                   AND m.status IN ('active','approved'))
  THEN
    RETURN p_preferred_club;
  END IF;

  SELECT COALESCE(p.is_horse, false) INTO v_is_horse FROM profiles p WHERE p.id = p_user_id;

  IF v_is_horse THEN
    -- Same stable home club a horse uses for cash play, so a horse's tournament
    -- and cash activity always belong to the same club.
    SELECT count(*) INTO v_n
      FROM club_members m
      JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
     WHERE m.user_id = p_user_id AND m.status IN ('active','approved');
    IF v_n > 1 THEN
      v_idx := (abs(hashtextextended(p_user_id::text, 0)) % v_n)::int;
      SELECT m.club_id INTO v_club
        FROM club_members m
        JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
       WHERE m.user_id = p_user_id AND m.status IN ('active','approved')
       ORDER BY m.club_id OFFSET v_idx LIMIT 1;
      IF v_club IS NOT NULL THEN RETURN v_club; END IF;
    END IF;
  END IF;

  SELECT m.club_id INTO v_club
    FROM club_members m
    JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
   WHERE m.user_id = p_user_id AND m.status IN ('active','approved')
   ORDER BY m.joined_at ASC NULLS LAST, m.club_id
   LIMIT 1;

  RETURN v_club;
END $function$
;
CREATE TRIGGER aa_serialize_tournament_player_insert BEFORE INSERT ON public.tournament_players FOR EACH STATEMENT EXECUTE FUNCTION fn_serialize_entry_statement();
CREATE TRIGGER aa_tournament_player_launch_proof_lock BEFORE INSERT OR DELETE OR UPDATE ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION trg_lock_tournament_player_launch_proof();
CREATE TRIGGER trg_ca_tournament_entry_gate BEFORE INSERT ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_ca_tournament_entry_gate();
CREATE TRIGGER trg_enforce_tournament_capacity BEFORE INSERT ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_enforce_tournament_capacity();
CREATE TRIGGER trg_tournament_players_stamp_club BEFORE INSERT OR UPDATE ON public.tournament_players FOR EACH ROW WHEN ((new.club_id IS NULL)) EXECUTE FUNCTION fn_stamp_entry_club();
CREATE TRIGGER zzzz_refuse_finalized_tournament_entry BEFORE INSERT ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION trg_refuse_finalized_tournament_entry();
CREATE TRIGGER aa_ca_capture_tournament_charge_entitlement AFTER INSERT ON public.chip_ledger FOR EACH ROW WHEN (((new.tournament_id IS NOT NULL) AND (new.from_type = 'player_wallet'::text) AND (new.to_type = 'prize_liability'::text))) EXECUTE FUNCTION fn_ca_capture_tournament_charge_entitlement();
