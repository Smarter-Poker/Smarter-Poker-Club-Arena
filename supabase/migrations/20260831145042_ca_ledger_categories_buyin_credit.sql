-- Applied to production via Supabase MCP on 2026-08-31 (zero-drift directive).
-- This file is the byte-exact mirror of the applied migration.
-- ZERO-DRIFT PART 4c: category plumbing on buy-in and the shared credit path.
-- Bodies unchanged except the transaction-local set_config declarations.

CREATE OR REPLACE FUNCTION public.atomic_table_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean DEFAULT false, p_club_id uuid DEFAULT NULL::uuid, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_no_rathole boolean;
  v_is_template boolean;
  v_vip_only boolean;
  v_is_vip boolean;
  v_staff boolean;
  v_last_stack numeric;
  v_rathole_floor numeric;
  v_max_players integer;
  v_seats_taken integer;
  v_holds integer := 0;
  v_new_balance NUMERIC;
  v_club_id UUID;
  v_union_id UUID;
  v_ban_id UUID;
  v_min_buy_in NUMERIC;
  v_max_buy_in NUMERIC;
  v_active_tables INT;
  v_seat_club UUID;
  v_max_tables CONSTANT INT := 6;
BEGIN
    -- THE ONLY IDEMPOTENCY GUARD IN THIS FUNCTION. Do not add a second one.
    IF p_idempotency_key IS NOT NULL THEN
        INSERT INTO public.transaction_idempotency_keys (key, user_id, action, amount)
        VALUES (p_idempotency_key, p_user_id, 'atomic_table_buyin', p_amount) ON CONFLICT (key) DO NOTHING;
        IF NOT FOUND THEN
            RETURN;
        END IF;
    END IF;
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> p_user_id)) THEN
    RAISE EXCEPTION 'Cannot buy in for another user';
  END IF;

  /* ZERO-DRIFT (2026-08-31): declare the ledger context so the wallet debit
     journals as a buy-in against the table, not an anonymous adjustment. */
  PERFORM set_config('app.ledger_category', 'buyin', true);
  PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(p_table_id::text, ''), true);

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));

  SELECT t.club_id, c.union_id, t.min_buy_in, t.max_buy_in, COALESCE(t.max_players, 0),
         COALESCE(t.no_rathole, false), COALESCE(t.is_vip_only, false), COALESCE(t.is_template, false)
    INTO v_club_id, v_union_id, v_min_buy_in, v_max_buy_in, v_max_players,
         v_no_rathole, v_vip_only, v_is_template
    FROM tables t LEFT JOIN clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id LIMIT 1;

  IF v_is_template THEN
    RAISE EXCEPTION 'IS_TEMPLATE: this is a saved table template, not a live game';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid buy-in amount';
  END IF;
  IF v_min_buy_in IS NOT NULL AND v_min_buy_in > 0 AND p_amount < v_min_buy_in THEN
    RAISE EXCEPTION 'Buy-in below table minimum (min %)', v_min_buy_in;
  END IF;
  IF v_max_buy_in IS NOT NULL AND v_max_buy_in > 0 AND p_amount > v_max_buy_in THEN
    RAISE EXCEPTION 'Buy-in above table maximum (max %)', v_max_buy_in;
  END IF;

  IF v_club_id IS NOT NULL THEN
    SELECT id INTO v_ban_id FROM blacklists
     WHERE user_id = p_user_id
       AND (expires_at IS NULL OR expires_at > now())
       AND (club_id = v_club_id OR (v_union_id IS NOT NULL AND union_id = v_union_id))
     LIMIT 1;
    IF v_ban_id IS NOT NULL THEN
      RAISE EXCEPTION 'Banned from this club';
    END IF;
  END IF;

  IF v_vip_only THEN
    SELECT COALESCE(p.is_vip, false)
           AND (p.vip_expires_at IS NULL OR p.vip_expires_at > now())
      INTO v_is_vip
      FROM profiles p WHERE p.id = p_user_id LIMIT 1;

    IF NOT COALESCE(v_is_vip, false) AND v_club_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM club_members cm
         WHERE cm.club_id = v_club_id AND cm.user_id = p_user_id
           AND cm.role IN ('owner', 'co_owner', 'admin', 'manager', 'agent')
      ) OR EXISTS (
        SELECT 1 FROM clubs c WHERE c.id = v_club_id AND c.owner_id = p_user_id
      ) INTO v_staff;
    END IF;

    IF NOT COALESCE(v_is_vip, false) AND NOT COALESCE(v_staff, false) THEN
      RAISE EXCEPTION 'VIP_ONLY: this table is open to VIP members only'
        USING HINT = 'VIP membership is required to take a seat at this table.';
    END IF;
  END IF;

  DECLARE v_nit jsonb;
  BEGIN
    v_nit := public.fn_nit_check(p_table_id, p_user_id, NULL);
    IF (v_nit->>'ok')::boolean = false AND v_nit->>'reason' = 'career_vpip' THEN
      RAISE EXCEPTION 'NIT_GAME: this table needs a career VPIP of at least %, and yours is % over % hands',
        v_nit->>'required', v_nit->>'vpip', v_nit->>'hands'
        USING HINT = 'The host has set a minimum voluntarily-put-in-pot rate for this game.';
    END IF;
  END;

  IF EXISTS (SELECT 1 FROM table_seats
              WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL) THEN
    RAISE EXCEPTION 'Player already seated at this table';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:' || p_table_id::text, 0));

  IF v_max_players > 0 AND p_seat_number > v_max_players THEN
    RAISE EXCEPTION 'TABLE_SIZE: seat % does not exist at this table (% max)',
      p_seat_number, v_max_players;
  END IF;

  IF v_max_players > 0 THEN
    SELECT COUNT(*) INTO v_seats_taken
      FROM table_seats
     WHERE table_id = p_table_id AND left_at IS NULL;
    IF v_seats_taken >= v_max_players THEN
      RAISE EXCEPTION 'TABLE_SIZE: table is full (% of % seats taken)',
        v_seats_taken, v_max_players;
    END IF;

    SELECT COUNT(*) INTO v_holds
      FROM public.table_waitlist w
     WHERE w.table_id = p_table_id
       AND w.status = 'notified'
       AND w.user_id <> p_user_id
       AND COALESCE(w.hold_expires_at, w.notified_at + interval '60 seconds') > now();
    IF v_seats_taken + v_holds >= v_max_players THEN
      RAISE EXCEPTION 'SEAT_RESERVED: the open seat is held for the next player on the waiting list'
        USING HINT = 'Join the waitlist to get the next seat in order.';
    END IF;
  END IF;

  IF v_no_rathole THEN
    SELECT ts.stack INTO v_last_stack
      FROM table_seats ts
     WHERE ts.table_id = p_table_id
       AND ts.user_id = p_user_id
       AND ts.left_at IS NOT NULL
     ORDER BY ts.left_at DESC
     LIMIT 1;

    IF v_last_stack IS NOT NULL AND v_last_stack > 0 THEN
      v_rathole_floor := v_last_stack;
      IF v_max_buy_in IS NOT NULL AND v_max_buy_in > 0 AND v_rathole_floor > v_max_buy_in THEN
        v_rathole_floor := v_max_buy_in;
      END IF;
      IF p_amount < v_rathole_floor THEN
        RAISE EXCEPTION
          'NO_RATHOLE: this table requires you to return with the % you left with', v_rathole_floor
          USING HINT = 'The host has switched ratholing off for this table.';
      END IF;
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_active_tables
    FROM table_seats ts JOIN tables t ON t.id = ts.table_id
   WHERE ts.user_id = p_user_id AND ts.left_at IS NULL
     AND t.tournament_id IS NULL AND t.status NOT IN ('closed','deleted');
  IF v_active_tables >= v_max_tables THEN
    RAISE EXCEPTION 'TABLE_CAP_REACHED: already seated at % cash tables (max %)', v_active_tables, v_max_tables;
  END IF;

  v_seat_club := public.fn_seat_club_for_user(p_user_id, p_table_id, p_club_id);
  IF v_seat_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this player at this table'
      USING HINT = 'The player must hold a membership in a club that belongs to this game''s union.';
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_seat_club);

  UPDATE club_members
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_seat_club AND chip_balance >= p_amount
   RETURNING chip_balance INTO v_new_balance;

  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient club chips for buy-in (club %)', v_seat_club;
  END IF;

  DELETE FROM table_seats
   WHERE table_id = p_table_id AND seat_number = p_seat_number AND left_at IS NOT NULL;

  INSERT INTO table_seats (table_id, seat_number, user_id, stack, status, auto_rebuy, club_id)
       VALUES (p_table_id, p_seat_number, p_user_id, p_amount, 'active', p_auto_rebuy, v_seat_club);

  UPDATE public.table_waitlist
     SET status = 'seated'
   WHERE table_id = p_table_id
     AND user_id = p_user_id
     AND status IN ('waiting', 'notified');

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'buyin',
            'Cash game buy-in (club wallet)', p_table_id, v_new_balance);

  UPDATE tables
     SET current_players = (SELECT COUNT(*) FROM table_seats
                             WHERE table_id = p_table_id AND left_at IS NULL)
   WHERE id = p_table_id;
END;
$function$;

-- Shared credit path: pass the caller's category through to the ledger writer
-- (covers atomic_seat_cashout_locked and every other caller).
CREATE OR REPLACE FUNCTION public.atomic_credit_wallet_and_log(p_user_id uuid, p_amount numeric, p_category text DEFAULT 'credit'::text, p_description text DEFAULT ''::text, p_table_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_related_entity_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_inserted integer;
  v_new_balance numeric;
  v_has_club boolean;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO wallet_credit_idempotency (key, user_id, amount)
    VALUES (p_idempotency_key, p_user_id, p_amount)
    ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN RETURN true; END IF;
  END IF;

  /* ZERO-DRIFT (2026-08-31): tell the club_members ledger writer what this
     credit IS. 'cashout' maps to the table_cashout flow off the felt. */
  PERFORM set_config('app.ledger_category',
    CASE WHEN p_category IN ('cashout') THEN 'table_cashout'
         WHEN p_category IN ('buyin','rake','commission','transfer','rakeback',
                             'settlement','tournament_buyin','tournament_prize',
                             'bounty','refund','addon','rebuy','promo')
              THEN p_category
         ELSE 'player_funding' END, true);
  IF p_table_id IS NOT NULL THEN
    PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_table_id::text, true);
  END IF;

  IF p_table_id IS NOT NULL THEN
    SELECT ts.club_id INTO v_club_id
      FROM table_seats ts
     WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id
     ORDER BY ts.joined_at DESC LIMIT 1;
  END IF;
  IF v_club_id IS NULL THEN
    v_club_id := public.fn_player_home_club(p_user_id, NULL);
  END IF;

  IF v_club_id IS NOT NULL THEN
    PERFORM public.fn_ensure_club_wallet(p_user_id, v_club_id);
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance,0) + p_amount, updated_at = now()
     WHERE user_id = p_user_id AND club_id = v_club_id
     RETURNING chip_balance INTO v_new_balance;
  ELSE
    SELECT EXISTS (SELECT 1 FROM club_members m WHERE m.user_id = p_user_id) INTO v_has_club;
    IF v_has_club THEN
      RAISE EXCEPTION 'No club wallet resolves for Club Arena credit to player %', p_user_id;
    END IF;
    UPDATE wallets SET balance = COALESCE(balance,0) + p_amount, updated_at = now()
     WHERE user_id = p_user_id AND wallet_type = 'PLAYER'
     RETURNING balance INTO v_new_balance;
    IF NOT FOUND THEN
      INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
      VALUES (p_user_id, 'PLAYER', p_amount, 0)
      ON CONFLICT (user_id, wallet_type) DO UPDATE
        SET balance = wallets.balance + p_amount, updated_at = now()
      RETURNING balance INTO v_new_balance;
    END IF;
  END IF;

  IF p_category = 'cashout' THEN
    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category,
                                     description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'credit', p_amount, 'cashout',
            COALESCE(NULLIF(p_description, ''), 'Cash-out to club wallet'),
            p_table_id, v_new_balance);
  END IF;

  IF v_club_id IS NOT NULL THEN
    INSERT INTO chip_transactions (club_id, to_user_id, amount, transaction_type,
                                   notes, table_id, metadata)
    VALUES (v_club_id, p_user_id, p_amount, p_category,
            COALESCE(NULLIF(p_description, ''), 'Wallet credit'), p_table_id,
            CASE WHEN p_category = 'cashout'
                 THEN jsonb_build_object('mirrored_to_wallet', true)
                 ELSE '{}'::jsonb END);
  END IF;

  RETURN true;
END; $function$;