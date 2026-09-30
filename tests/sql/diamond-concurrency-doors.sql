-- ============================================================================
-- THE DIAMOND MONEY DOORS THE CONCURRENCY CASES RUN, CAPTURED
-- ============================================================================
--
-- Phase 11, line 2 of the Diamond Arena programme. The concurrency, duplicate
-- delivery and crash-recovery cases in run-diamond-concurrency.py drive the
-- Diamond wallet transfer, the store purchase, the cash buy-in, top-up and
-- cash-out, the tournament registration, rebuy and payout doors from real
-- concurrent sessions. A race proves something only against the doors
-- production runs, so every function those cases execute is the exact text
-- pg_get_functiondef() returns on production, and every one carries the md5 of
-- that text on the line above it. The block at the foot of this file reads each
-- one back out of the catalogue it was just loaded into and refuses to finish
-- if a single one disagrees. Nothing here is authored and nothing here may be
-- edited by hand.
--
-- NEVER weaken, stub, disable or compare-against-NULL one of these pins to
-- make a fixture build. The pin is the only thing standing between an
-- in-place edit and a silently different money function.
--
-- WHERE THE BYTES CAME FROM. Transported from production by a read-only
-- pg_get_functiondef(). This file holds only what the historical base and the
-- two Diamond tournament captures do not already hold byte-identical to
-- production: the doors the cases call, everything they call, and the trigger
-- functions production fires on the rows they write, measured by running the
-- cases with track_functions on and comparing every executed function's md5
-- with production's. The manifest beside this file records each door's
-- identity, md5, length, owner and live grants.
--
-- REFRESH. Read every pin below against production (md5(pg_get_functiondef),
-- read-only); re-transport a door that moved, rewriting its block, its line in
-- the proof list at the foot and its manifest entry in one step.
--
-- Load order does not matter: check_function_bodies is off, exactly as
-- pg_dump and the estate's other captured overlays load functions.
-- ============================================================================
SET check_function_bodies = off;
SET search_path = public, extensions, pg_catalog;

-- @@DOOR add_diamonds_to_balance(p_user_id uuid, p_amount integer, p_type text, p_description text, p_reference_id text, p_counterparty_id uuid)
-- @@PIN md5=5d356b15727558df9c498dbb05a745d0 len=9612 owner=postgres
CREATE OR REPLACE FUNCTION public.add_diamonds_to_balance(p_user_id uuid, p_amount integer, p_type text DEFAULT 'bonus'::text, p_description text DEFAULT NULL::text, p_reference_id text DEFAULT NULL::text, p_counterparty_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_old_balance bigint;
  v_new_balance bigint;
  v_txn_id uuid;
  v_multiplier numeric(4,2) := 1.00;
  v_raw_amount integer := COALESCE(p_amount, 0);
  v_actual_amount bigint;
  v_exact_type boolean;
  v_type_key text := COALESCE(p_type, 'unknown');
  v_issuance_class text;
  v_counterparty text;
  v_settled bigint := 0;
  v_settled_ids uuid[] := '{}';
  v_debt record;
  v_take bigint;
  v_settle_ref text;
BEGIN
  v_exact_type := p_type IN (
    'trivia_entry', 'trivia_run', 'trivia_daily_bonus', 'trivia_prize_wheel',
    'pvp_stake', 'pvp_win', 'pvp_refund', 'pvp_tie_refund',
    'tournament_entry', 'tournament_entry_refund',
    'tournament_cancel_refund', 'tournament_prize',
    'daily_mission_milestone', 'arena_withdraw'
  );

  IF p_reference_id IS NULL AND v_exact_type THEN
    RETURN jsonb_build_object('success', false, 'error', 'reference_id_required', 'reference_required', true);
  END IF;

  IF p_reference_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.diamond_transactions WHERE user_id = p_user_id AND reference_id = p_reference_id
  ) THEN
    SELECT balance_after INTO v_new_balance FROM public.diamond_transactions
     WHERE user_id = p_user_id AND reference_id = p_reference_id LIMIT 1;
    RETURN jsonb_build_object('success', false, 'error', 'duplicate_reference', 'duplicate', true, 'new_balance', v_new_balance);
  END IF;

  -- DR4 (DIAMOND-RULINGS 17): a positive credit without a reference is refused once the rule
  -- is flipped in ca_diamond_rule_modes. Until then it is journaled and filed below.
  IF COALESCE(p_amount, 0) > 0 AND p_reference_id IS NULL
     AND public.fn_ca_diamond_rule_mode('DR4:credit_without_reference') = 'refuse' THEN
    RETURN jsonb_build_object('success', false, 'error', 'reference_id_required',
                              'reference_required', true, 'refused_by', 'DR4:credit_without_reference');
  END IF;

  SELECT COALESCE(diamonds, 0), COALESCE(diamond_multiplier, 1.00)
    INTO v_old_balance, v_multiplier
    FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'profile_not_found');
  END IF;

  IF v_raw_amount > 0 AND NOT v_exact_type
     AND p_type NOT IN ('purchase', 'deduction', 'adjustment', 'refund', 'transfer',
                        'diamond_gift_received', 'diamond_gift_sent', 'diamond_gift_refund',
                        'diamond_received', 'live_gift_received', 'live_gift_sent',
                        'vip_daily', 'vip_stipend')
     AND v_multiplier > 1.00 THEN
    v_actual_amount := round(v_raw_amount * v_multiplier);
  ELSE
    v_actual_amount := v_raw_amount;
    v_multiplier := 1.00;
  END IF;

  IF v_actual_amount < -2147483648 OR v_actual_amount > 2147483647 THEN
    RETURN jsonb_build_object('success', false, 'error', 'diamond_amount_out_of_range', 'new_balance', v_old_balance);
  END IF;

  v_new_balance := v_old_balance + v_actual_amount;
  IF v_new_balance < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_diamonds', 'new_balance', v_old_balance);
  END IF;
  IF v_new_balance > 2147483647 THEN
    RETURN jsonb_build_object('success', false, 'error', 'diamond_balance_limit', 'new_balance', v_old_balance);
  END IF;

  IF v_type_key = 'arena_withdraw' THEN
    v_issuance_class := 'arena'; v_counterparty := 'arena_custody:' || p_reference_id;
  ELSIF v_type_key = 'purchase' THEN
    v_issuance_class := 'purchased'; v_counterparty := 'purchase_clearing';
  ELSIF v_type_key = 'refund' OR right(v_type_key, 7) = '_refund' THEN
    v_issuance_class := 'refund'; v_counterparty := 'revenue:' || v_type_key;
  ELSIF v_type_key IN ('transfer', 'diamond_gift_received', 'live_gift_received', 'diamond_received') THEN
    -- NAME THE OTHER SIDE. ab_ca_diamond_transfer_names_its_counterparty refuses
    -- a transfer that cannot, because the register skips a transfer on the row's own
    -- word that a matching leg exists somewhere.
    v_issuance_class := 'transferred';
    v_counterparty := 'player:' || COALESCE(p_counterparty_id::text, 'unknown');
  ELSIF v_type_key = 'adjustment' THEN
    v_issuance_class := 'admin'; v_counterparty := 'adjustment';
  ELSIF v_type_key IN ('union_grant', 'signup_bonus') THEN
    v_issuance_class := 'promotional'; v_counterparty := 'promo_budget:' || v_type_key;
  ELSIF v_actual_amount < 0 THEN
    v_issuance_class := 'spend'; v_counterparty := 'revenue:' || v_type_key;
  ELSE
    v_issuance_class := 'earned'; v_counterparty := 'promo_budget:' || v_type_key;
  END IF;

  -- Kill switch (standard 3.4 layer 6, review D11): a human-opened diamond_issuance freeze refuses
  -- promotional and earned credits. Purchases, refunds, transfers and adjustments are not issuance.
  IF v_actual_amount > 0 AND v_issuance_class IN ('earned', 'promotional')
     AND EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'diamond_issuance' AND f.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'diamond_issuance_frozen', 'new_balance', v_old_balance);
  END IF;

  -- DIAMOND-RULINGS 2: a chargeback the balance could not cover is a receivable, never a
  -- negative balance, and the next positive credit of any class settles open receivables
  -- oldest first before the player sees the rest. A debt larger than the credit is split:
  -- the paid part becomes its own settled row, the residual stays open.
  IF v_actual_amount > 0 THEN
    FOR v_debt IN
      SELECT d.id, d.amount FROM public.diamond_debts d
       WHERE d.user_id = p_user_id AND d.settled_at IS NULL
       ORDER BY d.created_at, d.id
       FOR UPDATE
    LOOP
      EXIT WHEN v_settled >= v_actual_amount;
      v_take := LEAST(v_debt.amount, v_actual_amount - v_settled);
      IF v_take >= v_debt.amount THEN
        UPDATE public.diamond_debts SET settled_at = now(), settled_by = 'add_diamonds_to_balance'
         WHERE id = v_debt.id;
      ELSE
        UPDATE public.diamond_debts SET amount = amount - v_take WHERE id = v_debt.id;
        INSERT INTO public.diamond_debts (user_id, purchase_id, amount, reason, created_at, settled_at, settled_by)
        SELECT d.user_id, d.purchase_id, v_take,
               d.reason || ' (partial settlement of ' || d.id::text || ')',
               d.created_at, now(), 'add_diamonds_to_balance'
          FROM public.diamond_debts d WHERE d.id = v_debt.id;
      END IF;
      v_settled := v_settled + v_take;
      v_settled_ids := v_settled_ids || v_debt.id;
    END LOOP;
  END IF;

  UPDATE public.profiles
     SET diamonds = v_new_balance - v_settled, diamond_balance = v_new_balance - v_settled, updated_at = now()
   WHERE id = p_user_id;

  INSERT INTO public.diamond_transactions (
    user_id, amount, transaction_type, type, description, balance_after, reference_id, metadata,
    counterparty, issuance_class
  ) VALUES (
    p_user_id, v_actual_amount, p_type, p_type,
    CASE WHEN v_actual_amount <> v_raw_amount
         THEN COALESCE(p_description, '') || format(' [%sx boost]', v_multiplier)
         ELSE p_description END,
    v_new_balance, p_reference_id,
    jsonb_build_object('reference_id', p_reference_id, 'raw_amount', v_raw_amount,
                       'multiplier', v_multiplier, 'exact_value', v_exact_type),
    v_counterparty, v_issuance_class
  ) RETURNING id INTO v_txn_id;

  IF v_settled > 0 THEN
    -- The settlement is its own journal row (class spend, counterparty the receivable), so the
    -- register retires what the reversed purchase had issued and the player's statement shows
    -- both the credit and what it paid off.
    v_settle_ref := 'debt-settlement:' || v_txn_id::text;
    INSERT INTO public.diamond_transactions (
      user_id, amount, transaction_type, type, description, balance_after, reference_id, metadata,
      counterparty, issuance_class
    ) VALUES (
      p_user_id, -v_settled, 'debt_settlement', 'debt_settlement',
      'Settled ' || v_settled::text || ' diamonds owed after a reversed purchase',
      v_new_balance - v_settled, v_settle_ref,
      jsonb_build_object('reference_id', v_settle_ref, 'credit_transaction_id', v_txn_id,
                         'settled_debt_ids', to_jsonb(v_settled_ids), 'raw_amount', -v_settled,
                         'multiplier', 1.00, 'exact_value', true),
      'receivable:diamond_debts', 'spend'
    );
  END IF;

  -- DIAMOND-RULINGS 1: a debit through this door consumes purchased lots first (FIFO).
  IF v_actual_amount < 0 THEN
    PERFORM public.fn_ca_consume_purchase_lots(p_user_id, -v_actual_amount);
  END IF;

  IF COALESCE(p_amount, 0) > 0 AND p_reference_id IS NULL THEN
    BEGIN
      PERFORM public.fn_ca_diamond_incident('DR4:credit_without_reference', 'warning', p_user_id, p_amount,
        'add_diamonds_to_balance', jsonb_build_object('type', p_type, 'description', p_description));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object('success', true, 'old_balance', v_old_balance,
                            'new_balance', v_new_balance - v_settled,
                            'amount', v_actual_amount, 'multiplier', v_multiplier, 'transaction_id', v_txn_id,
                            'debt_settled', v_settled);
END;
$function$;
ALTER FUNCTION public.add_diamonds_to_balance(p_user_id uuid, p_amount integer, p_type text, p_description text, p_reference_id text, p_counterparty_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.add_diamonds_to_balance(p_user_id uuid, p_amount integer, p_type text, p_description text, p_reference_id text, p_counterparty_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_diamonds_to_balance(p_user_id uuid, p_amount integer, p_type text, p_description text, p_reference_id text, p_counterparty_id uuid) TO service_role;
-- @@END add_diamonds_to_balance(p_user_id uuid, p_amount integer, p_type text, p_description text, p_reference_id text, p_counterparty_id uuid)

-- @@DOOR atomic_seat_cashout_locked(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_leave_mode text)
-- @@PIN md5=e1b0b9702e75378ecac634c3a879502e len=7059 owner=postgres
CREATE OR REPLACE FUNCTION public.atomic_seat_cashout_locked(p_user_id uuid, p_table_id uuid, p_seat_number integer DEFAULT NULL::integer, p_leave_mode text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_seat      record;
  v_stack     numeric;
  v_key       text;
  v_credited  boolean := false;
  v_seat_rows integer;
  v_tournament uuid;
  v_engine    boolean;
  v_mode      text;
  v_admin_forced boolean;
  v_enforce   boolean;
  v_chk       jsonb;
  v_receipt   jsonb;
BEGIN
  IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
            WHERE t.id=p_table_id AND c.asset='diamonds') THEN
    RETURN public.fn_poker_diamond_cashout(p_user_id,p_table_id,p_seat_number);
  END IF;
  v_engine := coalesce(public.fn_caller_is_engine(),false);
  -- H6: the mode is one of two words or nothing. 'vpip_evicted' (Dan
  -- 2026-09-05) is a system exit for the clock (a forced one) that closes
  -- the session with its own reason, so the two-hour bar is written.
  v_mode := CASE WHEN p_leave_mode IN ('voluntary', 'forced') THEN p_leave_mode
                 WHEN p_leave_mode = 'vpip_evicted' THEN 'forced' ELSE NULL END;
  -- H2: a club admin's kick, marked by fn_admin_kick_player in THIS transaction
  -- only, after is_club_admin() passed. A browser cannot set a GUC through
  -- PostgREST; one request is one function call in one transaction.
  v_admin_forced := (v_mode = 'forced')
                    AND COALESCE(current_setting('app.cash_exit_authority', true), '') = 'club_admin';

  IF NOT v_engine AND NOT v_admin_forced
     AND (auth.uid() IS NULL OR ( auth.uid() <> p_user_id)) THEN
    RAISE EXCEPTION 'Cannot cash out for another user';
  END IF;

  -- H1: the same lock atomic_table_buyin holds while it reads the floor, taken
  -- BEFORE the seat row so the two functions lock in one order.
  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));

  /* THE GAME BEFORE THE SEAT (20260906). A seat change on a seat-first game
     (spin, SNG, heads-up) fires trg_seat_change_syncs_seat_first_count, which
     writes tournaments.current_players - a lock on the game's row taken AFTER
     the seat row. The engine finishing that same game does the reverse: its
     UPDATE tournaments ... status holds the game row and its trigger
     fn_clear_seats_on_game_end then locks every seat. 131 deadlocks a day,
     every one this pair, every one at the end of a spin or heads-up. Parent
     before child: take the game row first, in the mode the trigger's UPDATE
     needs, so a cashout racing a finish waits for it instead of dying.
     Cash tables have no game row and skip this. */
  SELECT t.tournament_id INTO v_tournament FROM tables t WHERE t.id = p_table_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHOUT_TABLE_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF v_tournament IS NOT NULL THEN
    PERFORM 1 FROM tournaments WHERE id = v_tournament FOR NO KEY UPDATE;
  END IF;

  IF p_seat_number IS NOT NULL THEN
    SELECT id, stack, joined_at, seat_number, occupancy_id INTO v_seat
      FROM table_seats
     WHERE table_id = p_table_id AND user_id = p_user_id
       AND seat_number = p_seat_number AND left_at IS NULL
     FOR UPDATE;
  ELSE
    SELECT id, stack, joined_at, seat_number, occupancy_id INTO v_seat
      FROM table_seats
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
     ORDER BY joined_at DESC
     LIMIT 1
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'stack', 0, 'reason', 'no_active_seat');
  END IF;

  -- Cash amounts must be valid BEFORE the credit, idempotency record and
  -- seat exit. A receipt rejected after commit cannot roll those writes back.
  -- Tournament stacks are play chips and still return zero below.
  IF v_tournament IS NULL AND (
    v_seat.stack IS NULL OR
    v_seat.stack::text IN ('NaN', 'Infinity', '-Infinity') OR
    v_seat.stack < 0 OR v_seat.stack <> trunc(v_seat.stack, 2)
  ) THEN
    RAISE EXCEPTION 'CASHOUT_INVALID_STACK' USING ERRCODE = '22003';
  END IF;
  v_stack := v_seat.stack;

  /* CHIP CONTINUITY (OPORD 1.3 s6.4 / I5). A browser caller is always checked
     unless it is a club admin's kick (H2); the engine is checked when it says
     the exit is the player's own choice. Raised BEFORE any credit. */
  v_enforce := v_tournament IS NULL
               AND ((NOT v_engine AND NOT v_admin_forced) OR (v_engine AND v_mode = 'voluntary'));
  IF v_enforce THEN
    v_chk := public.fn_cash_leave_check(p_user_id, p_table_id);
    IF NOT COALESCE((v_chk->>'allowed')::boolean, true) THEN
      RAISE EXCEPTION 'LEAVE_LOCKED:%', COALESCE(v_chk->>'stay_remaining_ms', '0')
        USING HINT = 'Leave available when the stay clock reaches zero';
    END IF;
  END IF;

  -- The database renews this identity on every new occupancy, even when
  -- a physical row or seniority timestamp is reused.
  v_key := 'cashout:occupancy:' || v_seat.occupancy_id::text;

  /* ZERO-DRIFT (2026-09-01): a tournament-table stack is play chips. */
  IF v_tournament IS NOT NULL THEN
    v_stack := 0;
    v_credited := false;
  ELSIF v_stack > 0 THEN
    PERFORM public.atomic_credit_wallet_and_log(
      p_user_id, v_stack, 'cashout', 'Cash-out from table',
      p_table_id, NULL, NULL, v_key
    );
    v_credited := true;
  END IF;

  UPDATE table_seats
     SET left_at = NOW(), leave_pending = false
   WHERE table_id = p_table_id AND user_id = p_user_id
     AND seat_number = v_seat.seat_number AND left_at IS NULL;
  GET DIAGNOSTICS v_seat_rows = ROW_COUNT;

  IF v_seat_rows = 0 THEN
    RAISE EXCEPTION
      'Cash-out could not vacate the locked seat (table %, player %, seat %)',
      p_table_id, p_user_id, v_seat.seat_number;
  END IF;

  IF v_tournament IS NULL THEN
    PERFORM public.fn_cash_session_close(
      p_user_id, p_table_id, v_stack,
      CASE WHEN v_mode = 'voluntary' THEN 'voluntary'
           WHEN p_leave_mode = 'vpip_evicted' THEN 'vpip_evicted'
           WHEN v_admin_forced THEN 'kicked'
           ELSE 'system' END);
  END IF;

  UPDATE tables
     SET current_players = (
       SELECT count(*) FROM table_seats
        WHERE table_id = p_table_id AND left_at IS NULL)
   WHERE id = p_table_id;

  v_receipt := jsonb_build_object(
    'ok', true, 'stack', v_stack, 'credited', v_credited,
    'seat_number', v_seat.seat_number, 'idempotency_key', v_key,
    'tournament_table', v_tournament IS NOT NULL,
    'occupancy_id',v_seat.occupancy_id,'user_id',p_user_id,'table_id',p_table_id);
  -- Every ingress, including an older engine during adoption, records the
  -- original outcome in the transaction that moves the money and exits the seat.
  INSERT INTO public.seat_cashout_receipts
    (occupancy_id,user_id,table_id,seat_id,seat_number,receipt)
  VALUES(v_seat.occupancy_id,p_user_id,p_table_id,v_seat.id,v_seat.seat_number,v_receipt);
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.atomic_seat_cashout_locked(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_leave_mode text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.atomic_seat_cashout_locked(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_leave_mode text) FROM PUBLIC, anon, authenticated, service_role;
-- @@END atomic_seat_cashout_locked(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_leave_mode text)

-- @@DOOR atomic_table_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean, p_club_id uuid, p_idempotency_key uuid)
-- @@PIN md5=2f8b47a714db3f297aff3f7a2e814c44 len=2782 owner=postgres
CREATE OR REPLACE FUNCTION public.atomic_table_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean DEFAULT false, p_club_id uuid DEFAULT NULL::uuid, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_request jsonb;
  v_replay jsonb;
BEGIN
  IF p_amount IS NULL
     OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'Chips Move In Hundredths At Most' USING ERRCODE = '22003';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'Cannot buy in for another user' USING ERRCODE = '42501';
  END IF;

  v_request := jsonb_build_object(
    'door', 'atomic_table_buyin',
    'user_id', p_user_id,
    'table_id', p_table_id,
    'seat_number', p_seat_number,
    'amount', p_amount,
    'auto_rebuy', p_auto_rebuy,
    'club_id', p_club_id
  );
  v_replay := public.fn_claim_entry_purchase_receipt(
    'cash_transaction', p_idempotency_key::text, v_request
  );
  IF NOT COALESCE((v_replay->>'claimed')::boolean, false) THEN
    RETURN;
  END IF;
  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.transaction_idempotency_keys k
     WHERE k.key = p_idempotency_key
  ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: this historical cash key does not prove its table and seat'
      USING ERRCODE = '55000';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: scheduled maintenance has closed cash buy-ins; no chips moved'
      USING ERRCODE = '55006', HINT = 'Retry after the maintenance break has ended.';
  END IF;
  PERFORM public.fn_assert_cash_chip_purchase_table(p_table_id);
  IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
            WHERE t.id=p_table_id AND c.asset='diamonds') THEN
    PERFORM public.fn_poker_diamond_buyin(p_user_id,p_table_id,p_seat_number,
      p_amount,p_auto_rebuy,p_club_id,p_idempotency_key);
  ELSE
    PERFORM public.atomic_table_buyin_before_maintenance_announcement_gate(
    p_user_id, p_table_id, p_seat_number, p_amount, p_auto_rebuy,
    p_club_id, p_idempotency_key
  );
  END IF;
  PERFORM public.fn_record_entry_purchase_receipt(
    'cash_transaction',
    p_idempotency_key::text,
    v_request,
    jsonb_build_object('completed', true)
  );
END;
$function$;
ALTER FUNCTION public.atomic_table_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean, p_club_id uuid, p_idempotency_key uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.atomic_table_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean, p_club_id uuid, p_idempotency_key uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.atomic_table_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean, p_club_id uuid, p_idempotency_key uuid) TO authenticated, service_role;
-- @@END atomic_table_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean, p_club_id uuid, p_idempotency_key uuid)

-- @@DOOR deduct_diamonds(p_user_id uuid, p_amount integer, p_description text, p_transaction_type text, p_source text, p_metadata jsonb, p_reference_id text, p_cooldown_seconds integer)
-- @@PIN md5=bfd93c5a09301f87e8afca6da0240061 len=7096 owner=postgres
CREATE OR REPLACE FUNCTION public.deduct_diamonds(p_user_id uuid, p_amount integer, p_description text DEFAULT ''::text, p_transaction_type text DEFAULT 'game_cost'::text, p_source text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_reference_id text DEFAULT NULL::text, p_cooldown_seconds integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_current integer;
    v_new_balance integer;
    v_effective_type text;
    v_issuance_class text;
    v_counterparty text;
    v_existing_amount numeric;
    v_existing_type text;
    v_existing_counterparty text;
    v_existing_issuance_class text;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Amount must be a positive integer');
    END IF;
    IF COALESCE(auth.role(), '') <> 'service_role'
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Cannot deduct diamonds for another user');
    END IF;

    v_effective_type := COALESCE(p_source, p_transaction_type);

    -- Derive the destination before the replay check so the same reference
    -- cannot be moved to another recipient or revenue account.
    -- A DEBIT THAT NAMES WHERE THE MONEY WENT IS A TRANSFER. This used to be
    -- decided by the source list below alone, so every new transfer path had to
    -- remember to add itself to it - and on 2026-09-11 the Diamond Wheel did not,
    -- so its spin price was journaled a spend, the register retired 100 diamonds
    -- that were sitting in the host owner's balance, and the hourly detector read
    -- 100 of unexplained supply. The classification follows the money now.
    IF COALESCE(p_metadata->>'recipient_id', '') <> ''
       OR COALESCE(p_source, '') IN ('wallet_transfer', 'wallet_diamond_transfer', 'stream_gift')
       OR COALESCE(p_transaction_type, '') IN ('diamond_gift_sent', 'live_gift_sent') THEN
        v_issuance_class := 'transferred';
        v_counterparty := 'player:' || COALESCE(p_metadata->>'recipient_id', 'unknown');
    ELSE
        v_issuance_class := 'spend';
        v_counterparty := 'revenue:' || COALESCE(p_source, p_transaction_type, 'unknown');
    END IF;

    -- The profile lock serializes the first attempt and every concurrent
    -- replay. A second request cannot pass an early lookup, wait for the first
    -- debit to commit, and then fall through to a duplicate insert error.
    SELECT COALESCE(diamonds, 0)
      INTO v_current
      FROM public.profiles
     WHERE id = p_user_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'User not found');
    END IF;

    IF p_reference_id IS NOT NULL THEN
        SELECT dt.amount,
               COALESCE(dt.transaction_type, dt.type),
               dt.counterparty,
               dt.issuance_class
          INTO v_existing_amount,
               v_existing_type,
               v_existing_counterparty,
               v_existing_issuance_class
          FROM public.diamond_transactions AS dt
         WHERE dt.reference_id = p_reference_id
           AND dt.user_id = p_user_id
         LIMIT 1;

        IF FOUND THEN
            IF v_existing_amount IS DISTINCT FROM -p_amount
               OR v_existing_type IS DISTINCT FROM v_effective_type
               OR v_existing_counterparty IS DISTINCT FROM v_counterparty
               OR v_existing_issuance_class IS DISTINCT FROM v_issuance_class THEN
                RETURN jsonb_build_object(
                    'success', false,
                    'error', 'idempotency_conflict',
                    'balance', v_current,
                    'reference_id', p_reference_id
                );
            END IF;

            RETURN jsonb_build_object(
                'success', true,
                'balance', v_current,
                'charged', (-v_existing_amount)::integer,
                'transaction_type', v_existing_type,
                'reference_id', p_reference_id,
                'counterparty', v_existing_counterparty,
                'issuance_class', v_existing_issuance_class,
                'idempotent', true
            );
        END IF;
    END IF;

    IF v_current < p_amount THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Insufficient diamonds',
            'balance', v_current
        );
    END IF;

    IF p_cooldown_seconds > 0 THEN
        IF EXISTS (
            SELECT 1
              FROM public.diamond_transactions
             WHERE user_id = p_user_id
               AND transaction_type = v_effective_type
               AND created_at >= now() - make_interval(secs => p_cooldown_seconds)
        ) THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', 'Please wait before sending again',
                'cooldown_active', true
            );
        END IF;
    END IF;

    UPDATE public.profiles
       SET diamonds = diamonds - p_amount,
           diamond_balance = diamonds - p_amount,
           updated_at = now()
     WHERE id = p_user_id
     RETURNING diamonds INTO v_new_balance;

    -- DIAMOND-RULINGS 1: purchased lots are consumed FIFO before promotional balance at every
    -- sink, so a refund or chargeback knows what is left of what was paid for.
    -- A claimed free-spin entry is freshly minted for this one transfer. It
    -- must not consume purchased lots the player already owned. The exception
    -- requires the actual ticket trigger and its exact canonical Mint receipt.
    IF NOT COALESCE((pg_trigger_depth()>0 AND p_amount=100 AND p_source='diamond_game'
      AND p_transaction_type='daily_bonus_spin'
      AND p_reference_id='daily-bonus-spin:'||(p_metadata->>'ticket_id')||':custody'
      AND EXISTS(SELECT 1 FROM public.diamond_bonus_spin_tickets t JOIN public.ca_mint_ledger m
        ON m.op_id='daily-bonus-spin:'||t.id
        WHERE t.id::text=p_metadata->>'ticket_id' AND t.user_id=p_user_id AND t.funded_at IS NULL
          AND m.action='mint' AND m.asset='diamonds' AND m.holder_type='player'
          AND m.holder_id=p_user_id AND m.amount=100)),false) THEN
      PERFORM public.fn_ca_consume_purchase_lots(p_user_id, p_amount);
    END IF;

    INSERT INTO public.diamond_transactions
        (user_id, amount, transaction_type, type, description, balance_after, metadata,
         reference_id, created_at, counterparty, issuance_class)
    VALUES
        (p_user_id, -p_amount, v_effective_type, v_effective_type, p_description,
         v_new_balance, p_metadata, p_reference_id, now(), v_counterparty, v_issuance_class);

    RETURN jsonb_build_object(
        'success', true,
        'balance', v_new_balance,
        'charged', p_amount,
        'transaction_type', v_effective_type,
        'reference_id', p_reference_id,
        'counterparty', v_counterparty,
        'issuance_class', v_issuance_class,
        'idempotent', false
    );
END;
$function$;
ALTER FUNCTION public.deduct_diamonds(p_user_id uuid, p_amount integer, p_description text, p_transaction_type text, p_source text, p_metadata jsonb, p_reference_id text, p_cooldown_seconds integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.deduct_diamonds(p_user_id uuid, p_amount integer, p_description text, p_transaction_type text, p_source text, p_metadata jsonb, p_reference_id text, p_cooldown_seconds integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deduct_diamonds(p_user_id uuid, p_amount integer, p_description text, p_transaction_type text, p_source text, p_metadata jsonb, p_reference_id text, p_cooldown_seconds integer) TO service_role;
-- @@END deduct_diamonds(p_user_id uuid, p_amount integer, p_description text, p_transaction_type text, p_source text, p_metadata jsonb, p_reference_id text, p_cooldown_seconds integer)

-- @@DOOR fn_a_closed_account_cannot_rewrite_itself()
-- @@PIN md5=9552ec6c29dc58e1e34221c542ce4bc9 len=377 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_a_closed_account_cannot_rewrite_itself()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NOT DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'ACCOUNT_CLOSED: this account was closed and cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_a_closed_account_cannot_rewrite_itself() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_a_closed_account_cannot_rewrite_itself() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_a_closed_account_cannot_rewrite_itself() TO service_role;
-- @@END fn_a_closed_account_cannot_rewrite_itself()

-- @@DOOR fn_accounting_mixed_cutover_spin_proof_valid(p_rake_record_id uuid)
-- @@PIN md5=f660a8b47bf88a86f2e236a4794ed4e6 len=1091 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_accounting_mixed_cutover_spin_proof_valid(p_rake_record_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
AS $function$
 SELECT EXISTS(
  SELECT 1 FROM public.accounting_mixed_cutover_spin_fee_proofs p
   JOIN public.accounting_tournament_fee_batches b USING(rake_record_id)
   JOIN public.rake_records r ON r.id=b.rake_record_id
   JOIN public.accounting_tournament_fee_cutover c ON c.singleton
  WHERE p.rake_record_id=p_rake_record_id AND p.tournament_id=r.tournament_id
   AND b.status='legacy_unverified' AND b.source_manifest IS NULL
   AND p.original_batch=to_jsonb(b) AND p.cutover_at=c.starts_at
   AND r.created_at>=c.starts_at AND b.source_fingerprint=public.fn_accounting_tournament_fee_fingerprint(r)
   AND r.source='fn_spin_book_entry' AND r.metadata->>'kind'='spin_rake'
   AND p.canonical_sources=(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.player_id)
    FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=p_rake_record_id)
 );
$function$;
ALTER FUNCTION public.fn_accounting_mixed_cutover_spin_proof_valid(p_rake_record_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_mixed_cutover_spin_proof_valid(p_rake_record_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_accounting_mixed_cutover_spin_proof_valid(p_rake_record_id uuid)

-- @@DOOR fn_accounting_tournament_bank_proof(p_tournament_id uuid, p_recognized_at timestamp with time zone, p_bank_club_id uuid, p_union_id uuid, p_net_fee numeric, p_union_wallet_transaction_id uuid, p_bank_journal_id uuid)
-- @@PIN md5=e56aa8c8280c59e2f0406ea6c504dc4e len=2599 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_bank_proof(p_tournament_id uuid, p_recognized_at timestamp with time zone, p_bank_club_id uuid, p_union_id uuid, p_net_fee numeric, p_union_wallet_transaction_id uuid, p_bank_journal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$DECLARE bank record;BEGIN
 IF (p_bank_club_id IS NULL AND p_net_fee>0) OR p_recognized_at IS NULL OR NOT isfinite(p_recognized_at)
  OR p_net_fee IS NULL OR p_net_fee<0 OR p_net_fee<>round(p_net_fee,2) OR p_net_fee::text IN('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'tournament_fee_bank_proof_invalid' USING ERRCODE='23514'; END IF;
 IF p_net_fee=0 THEN
  IF p_union_wallet_transaction_id IS NOT NULL OR p_bank_journal_id IS NOT NULL THEN
   RAISE EXCEPTION 'zero_tournament_fee_has_no_bank_credit' USING ERRCODE='23514'; END IF;
 ELSIF p_union_id IS NOT NULL THEN
  SELECT * INTO bank FROM public.union_wallet_transactions WHERE id=p_union_wallet_transaction_id;
  IF p_bank_journal_id IS NOT NULL OR bank.id IS NULL OR bank.union_id IS DISTINCT FROM p_union_id
   OR bank.club_id IS DISTINCT FROM p_bank_club_id OR bank.wallet IS DISTINCT FROM 'rake_wallet'
   OR bank.direction IS DISTINCT FROM 'credit' OR bank.tx_type IS DISTINCT FROM 'rake' OR bank.amount IS DISTINCT FROM p_net_fee
   OR bank.created_at IS DISTINCT FROM p_recognized_at
   OR position('[tournament '||p_tournament_id::text||']' IN COALESCE(bank.notes,''))=0 THEN
   RAISE EXCEPTION 'tournament_fee_union_bank_receipt_mismatch' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO bank FROM public.chip_ledger WHERE id=p_bank_journal_id;
  IF p_union_wallet_transaction_id IS NOT NULL OR bank.id IS NULL OR bank.from_type IS DISTINCT FROM 'prize_liability'
   OR bank.from_entity_id IS DISTINCT FROM p_tournament_id OR bank.to_type IS DISTINCT FROM 'chip_retirement'
   OR bank.to_entity_id IS NOT NULL OR bank.club_id IS DISTINCT FROM p_bank_club_id OR bank.category IS DISTINCT FROM 'burn'
   OR bank.amount IS DISTINCT FROM p_net_fee OR bank.created_at IS DISTINCT FROM p_recognized_at THEN
   RAISE EXCEPTION 'tournament_fee_club_bank_receipt_mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN jsonb_build_object('bank_amount',p_net_fee,'banked_at',p_recognized_at,'bank_club_id',p_bank_club_id,'bank_union_id',p_union_id,
  'bank_receipt_kind',CASE WHEN p_net_fee=0 THEN 'none' WHEN p_union_id IS NULL THEN 'chip_ledger' ELSE 'union_wallet_transaction' END,
  'bank_receipt_id',COALESCE(p_union_wallet_transaction_id,p_bank_journal_id));
END$function$;
ALTER FUNCTION public.fn_accounting_tournament_bank_proof(p_tournament_id uuid, p_recognized_at timestamp with time zone, p_bank_club_id uuid, p_union_id uuid, p_net_fee numeric, p_union_wallet_transaction_id uuid, p_bank_journal_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_bank_proof(p_tournament_id uuid, p_recognized_at timestamp with time zone, p_bank_club_id uuid, p_union_id uuid, p_net_fee numeric, p_union_wallet_transaction_id uuid, p_bank_journal_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_accounting_tournament_bank_proof(p_tournament_id uuid, p_recognized_at timestamp with time zone, p_bank_club_id uuid, p_union_id uuid, p_net_fee numeric, p_union_wallet_transaction_id uuid, p_bank_journal_id uuid)

-- @@DOOR fn_accounting_tournament_fee_fingerprint(p_row rake_records)
-- @@PIN md5=dd55cceba87b1578472171e1c80ba1fb len=676 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_fee_fingerprint(p_row rake_records)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 -- Versioned economic fields are stable across unrelated schema additions.
 -- Tuple terminal markers are not economic source edits.
 SELECT md5(jsonb_object_agg(field,to_jsonb(p_row)->field ORDER BY field)::text)
 FROM unnest(ARRAY['id','hand_id','table_id','club_id','rake_amount','bbj_contribution','pot_size','num_players',
  'created_at','player_contributions','global_hand_id','is_tournament','tournament_id','source','metadata',
  'rake_method','returned_uncalled']::text[])field
$function$;
ALTER FUNCTION public.fn_accounting_tournament_fee_fingerprint(p_row rake_records) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_fingerprint(p_row rake_records) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_accounting_tournament_fee_fingerprint(p_row rake_records)

-- @@DOOR fn_accounting_tournament_fee_net_plan(p_tournament_id uuid)
-- @@PIN md5=9b1147a5b373e2a01e3374b8dd2cc2fa len=7967 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_fee_net_plan(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE refund_row record;raw_total numeric;positive_total numeric;refunded_total numeric:=0;expected numeric;raw_reference_sum numeric;
 positive_ids uuid[];negative_ids uuid[];processed uuid[]:='{}';refunded uuid[]:='{}';refs uuid[];direct_positive uuid[];
 pending uuid[];new_refunds uuid[];nested uuid[];covered uuid[];ref uuid;covered_ref uuid;
 refund_map jsonb:='{}';progress boolean;actual_union uuid;scope_count int;active_ids uuid[];refunded_ids uuid[];fingerprint text;
BEGIN
 IF p_tournament_id IS NULL THEN RAISE EXCEPTION 'tournament_required' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament
   AND (r.rake_amount IS NULL OR r.rake_amount<>round(r.rake_amount,2) OR r.rake_amount::text IN('NaN','Infinity','-Infinity') OR r.hand_id IS NOT NULL)) THEN
  RAISE EXCEPTION 'tournament_fee_source_invalid' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(array_agg(id ORDER BY id) FILTER(WHERE rake_amount>0),'{}'),
  COALESCE(array_agg(id ORDER BY id) FILTER(WHERE rake_amount<0),'{}'),COALESCE(sum(rake_amount),0),COALESCE(sum(rake_amount) FILTER(WHERE rake_amount>0),0)
 INTO positive_ids,negative_ids,raw_total,positive_total FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament;
 IF raw_total<0 THEN RAISE EXCEPTION 'tournament_fee_net_negative' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
   WHERE r.id=ANY(positive_ids) AND ((b.status IS DISTINCT FROM 'captured' AND NOT public.fn_accounting_mixed_cutover_spin_proof_valid(b.rake_record_id)) OR b.tournament_id IS DISTINCT FROM p_tournament_id
    OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
    OR b.rake_amount IS DISTINCT FROM r.rake_amount
    OR b.rake_amount IS DISTINCT FROM (SELECT sum(s.rake_credit) FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=r.id))) THEN
  RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=p_tournament_id AND NOT(s.rake_record_id=ANY(positive_ids))) THEN
  RAISE EXCEPTION 'tournament_fee_source_scope_changed' USING ERRCODE='23514'; END IF;
 SELECT count(DISTINCT COALESCE(union_id::text,'private')),(array_agg(union_id))[1] INTO scope_count,actual_union
  FROM public.accounting_tournament_fee_sources WHERE tournament_id=p_tournament_id;
 IF scope_count>1 THEN RAISE EXCEPTION 'tournament_fee_game_scope_changed' USING ERRCODE='23514'; END IF;
 pending:=negative_ids;
 WHILE cardinality(pending)>0 LOOP
  progress:=false;
  FOR refund_row IN SELECT * FROM public.rake_records WHERE id=ANY(pending) ORDER BY created_at,id LOOP
   IF refund_row.source NOT IN('fn_unregister_from_tournament','atomic_cancel_tournament') THEN
    RAISE EXCEPTION 'tournament_fee_refund_source_unsupported' USING ERRCODE='55000'; END IF;
   IF refund_row.metadata ? 'original_rake_record_ids' AND jsonb_typeof(refund_row.metadata->'original_rake_record_ids')='array' THEN
    SELECT array_agg(value::uuid ORDER BY value) INTO refs FROM jsonb_array_elements_text(refund_row.metadata->'original_rake_record_ids');
   ELSIF refund_row.metadata ? 'original_rake_record_id' THEN refs:=ARRAY[(refund_row.metadata->>'original_rake_record_id')::uuid];
   ELSE RAISE EXCEPTION 'tournament_fee_refund_source_ids_missing' USING ERRCODE='23514'; END IF;
   IF refs IS NULL OR cardinality(refs)=0 OR cardinality(refs)<>(SELECT count(DISTINCT x) FROM unnest(refs)x)
    OR refund_row.id=ANY(refs) OR EXISTS(SELECT 1 FROM unnest(refs)x WHERE NOT(x=ANY(positive_ids||negative_ids))) THEN
    RAISE EXCEPTION 'tournament_fee_refund_source_ids_invalid' USING ERRCODE='23514'; END IF;
   SELECT COALESCE(array_agg(id) FILTER(WHERE rake_amount>0),'{}'),COALESCE(array_agg(id) FILTER(WHERE rake_amount<0),'{}'),sum(rake_amount)
    INTO direct_positive,nested,raw_reference_sum FROM public.rake_records WHERE id=ANY(refs);
   IF NOT(nested<@processed) THEN CONTINUE; END IF;
   covered:='{}';
   FOREACH ref IN ARRAY nested LOOP
    FOR covered_ref IN SELECT value::uuid FROM jsonb_array_elements_text(refund_map->ref::text) LOOP
     covered:=array_append(covered,covered_ref);
    END LOOP;
   END LOOP;
   IF NOT(covered<@direct_positive) THEN RAISE EXCEPTION 'tournament_fee_refund_dependency_incomplete' USING ERRCODE='23514'; END IF;
   IF EXISTS(SELECT 1 FROM unnest(direct_positive)x WHERE x=ANY(refunded) AND NOT(x=ANY(covered))) THEN
    RAISE EXCEPTION 'tournament_fee_refund_duplicates_prior_refund' USING ERRCODE='23514'; END IF;
   SELECT COALESCE(array_agg(x ORDER BY x),'{}') INTO new_refunds FROM unnest(direct_positive)x WHERE NOT(x=ANY(refunded));
   SELECT COALESCE(sum(rake_amount),0) INTO expected FROM public.rake_records WHERE id=ANY(new_refunds);
   IF expected<=0 OR expected IS DISTINCT FROM -refund_row.rake_amount OR raw_reference_sum IS DISTINCT FROM expected
    OR EXISTS(SELECT 1 FROM public.rake_records q WHERE q.id=ANY(refs) AND (q.club_id IS DISTINCT FROM refund_row.club_id
      OR (q.metadata->>'user_id' IS DISTINCT FROM refund_row.metadata->>'user_id')
      OR q.created_at>refund_row.created_at)) THEN
    RAISE EXCEPTION 'tournament_fee_refund_not_exact_full_sources' USING ERRCODE='23514'; END IF;
   -- A player refund needs its immutable unregistration or cancellation witness.
   -- Spin unwind uses the cancellation's exact reversal-id list and zero net.
   IF refund_row.source='fn_unregister_from_tournament' THEN
    IF NOT EXISTS(SELECT 1 FROM public.tournament_unregistration_receipts u WHERE u.tournament_id=p_tournament_id
      AND refund_row.id=ANY(u.fee_reversal_ids) AND refs<@u.fee_source_rake_record_ids
      AND u.user_id::text=refund_row.metadata->>'user_id') THEN
     RAISE EXCEPTION 'tournament_fee_refund_receipt_missing' USING ERRCODE='23514'; END IF;
   ELSE
    IF NOT EXISTS(SELECT 1 FROM public.tournament_cancellation_receipts c WHERE c.tournament_id=p_tournament_id
      AND refund_row.id=ANY(c.fee_reversal_ids) AND c.total_rake_after=0 AND c.fees_reversed=c.total_rake_before) THEN
     RAISE EXCEPTION 'tournament_fee_cancellation_receipt_missing' USING ERRCODE='23514'; END IF;
   END IF;
   refunded:=refunded||new_refunds;refunded_total:=refunded_total+expected;
   refund_map:=refund_map||jsonb_build_object(refund_row.id::text,to_jsonb(direct_positive));
   processed:=array_append(processed,refund_row.id);pending:=array_remove(pending,refund_row.id);progress:=true;
  END LOOP;
  IF NOT progress THEN RAISE EXCEPTION 'tournament_fee_refund_dependency_cycle' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF positive_total-refunded_total IS DISTINCT FROM raw_total THEN
  RAISE EXCEPTION 'tournament_fee_net_not_conserved' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(array_agg(id ORDER BY id) FILTER(WHERE NOT(rake_record_id=ANY(refunded))),'{}'),
  COALESCE(array_agg(id ORDER BY id) FILTER(WHERE rake_record_id=ANY(refunded)),'{}')
 INTO active_ids,refunded_ids FROM public.accounting_tournament_fee_sources WHERE tournament_id=p_tournament_id;
 SELECT md5(COALESCE(string_agg(public.fn_accounting_tournament_fee_fingerprint(r),':' ORDER BY r.id),'')) INTO fingerprint
  FROM public.rake_records r WHERE tournament_id=p_tournament_id AND is_tournament;
 RETURN jsonb_build_object('accounting_version',2,'status','proven','tournament_id',p_tournament_id,
  'source_fingerprint',fingerprint,'union_id',actual_union,'gross_fee',positive_total,'refunded_fee',refunded_total,
  'net_fee',raw_total,'active_source_ids',active_ids,'refunded_source_ids',refunded_ids,'payable',false);
END $function$;
ALTER FUNCTION public.fn_accounting_tournament_fee_net_plan(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_net_plan(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_accounting_tournament_fee_net_plan(p_tournament_id uuid)

-- @@DOOR fn_accounting_tournament_fee_owner_basis_is_append_only()
-- @@PIN md5=6122f7f6c814c1be411e67c1b916917d len=286 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_fee_owner_basis_is_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 RAISE EXCEPTION 'owner-authorized tournament fee basis is append-only' USING ERRCODE='P0404';
END $function$;
ALTER FUNCTION public.fn_accounting_tournament_fee_owner_basis_is_append_only() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_owner_basis_is_append_only() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_accounting_tournament_fee_owner_basis_is_append_only()

-- @@DOOR fn_accounting_tournament_fee_receipt_immutable()
-- @@PIN md5=bdc4ee4b75e3471cd33a5ed4b250ec0f len=287 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$BEGIN
 RAISE EXCEPTION 'accounting_tournament_fee_receipt_is_immutable' USING ERRCODE='55000';
END$function$;
ALTER FUNCTION public.fn_accounting_tournament_fee_receipt_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_receipt_immutable() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_accounting_tournament_fee_receipt_immutable()

-- @@DOOR fn_accounting_tournament_terminal_fee_receipt(p_tournament_id uuid)
-- @@PIN md5=b73bac5809d0e042837fcc32bacc0769 len=2910 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$DECLARE r record;proof jsonb;fp text;credits numeric;n int;BEGIN
 SELECT * INTO r FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=p_tournament_id;
 IF NOT FOUND THEN RETURN public.fn_ca_tournament_fee_custody_receipt(p_tournament_id); END IF;
 SELECT md5(COALESCE(string_agg(public.fn_accounting_tournament_fee_fingerprint(q),':' ORDER BY q.id),'')) INTO fp
  FROM public.rake_records q WHERE q.tournament_id=p_tournament_id AND q.is_tournament;
 IF r.source_fingerprint IS DISTINCT FROM fp THEN RAISE EXCEPTION 'recognized_tournament_fee_sources_changed' USING ERRCODE='23514'; END IF;
 proof:=public.fn_accounting_tournament_bank_proof(r.tournament_id,r.recognized_at,r.bank_club_id,r.union_id,r.net_rake,r.union_wallet_transaction_id,r.bank_journal_id);
 SELECT COALESCE(sum(x.rake_credit),0),count(*) INTO credits,n FROM public.accounting_tournament_recognized_sources x WHERE x.tournament_id=p_tournament_id;
 IF (r.status='banked_accrual_deferred' AND (n<>0 OR r.plan->>'payable' IS DISTINCT FROM 'false' OR NULLIF(r.plan->>'reason','') IS NULL))
  OR (r.status<>'banked_accrual_deferred' AND (credits IS DISTINCT FROM r.net_rake
    OR n<>(SELECT count(*) FROM public.accounting_tournament_fee_sources f WHERE f.tournament_id=p_tournament_id)
    OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f LEFT JOIN public.accounting_tournament_recognized_sources x ON x.source_id=f.id
      WHERE f.tournament_id=p_tournament_id AND (x.source_id IS NULL OR x.tournament_id IS DISTINCT FROM p_tournament_id
        OR x.recognized_at IS DISTINCT FROM r.recognized_at OR x.rake_credit IS DISTINCT FROM CASE WHEN x.disposition='earned' THEN f.rake_credit ELSE 0 END))
    OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f
      JOIN public.accounting_tournament_recognized_sources x ON x.source_id=f.id AND x.disposition='earned'
      CROSS JOIN LATERAL jsonb_array_elements(f.contract->'tiers')tier
      WHERE f.tournament_id=p_tournament_id AND (tier->>'amount')::numeric>0 AND NOT EXISTS(
       SELECT 1 FROM public.agent_commissions c WHERE c.source_type='tournament_fee_accrual' AND c.source_id=f.id
        AND c.user_id::text=tier->>'user_id' AND c.club_id=f.club_id AND c.created_at=r.recognized_at
        AND c.amount=(tier->>'amount')::numeric AND c.commission_rate=(tier->>'rate')::numeric)))) THEN
  RAISE EXCEPTION 'tournament_fee_recognition_source_receipt_incomplete' USING ERRCODE='23514'; END IF;
 RETURN proof||jsonb_build_object('accounting_version',2,'tournament_id',p_tournament_id,'status',r.status,
  'source_fingerprint',fp,'reason',r.plan->>'reason','payable',r.status='recognized','recognized_source_count',n);
END$function$;
ALTER FUNCTION public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_accounting_tournament_terminal_fee_receipt(p_tournament_id uuid)

-- @@DOOR fn_bounty_obligation_has_complete_marker(p_obligation_id uuid)
-- @@PIN md5=d51a53c3ad6d45edb5e431c43641dc57 len=5704 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_bounty_obligation_has_complete_marker(p_obligation_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- DIAMOND PHASE 9: the expected split is taken at the event's unit
  -- (fn_ca_tournament_unit_cents: a cent for a chip event, so every
  -- expression below is what it was; a whole Diamond for a Diamond event).
  -- A mystery chest splits into unit-floored equal shares with the remainder
  -- to the first claimant by user id; a regular or PKO head splits into
  -- unit-floored equal shares with the remainder to the last claimant, and a
  -- PKO cash half is the unit-floored half of the share.
  SELECT COALESCE((
    SELECT CASE WHEN o.mode='mystery_chest' THEN
      EXISTS (
        SELECT 1 FROM public.tournament_bounty_awards a
         WHERE a.bounty_obligation_id=o.id AND a.status='completed'
           AND (SELECT COALESCE(sum(r.amount_cents),0)
                  FROM public.tournament_bounty_award_recipients r
                 WHERE r.award_id=a.id AND r.paid_at IS NOT NULL)=a.amount_cents
           AND NOT EXISTS (
             SELECT 1
               FROM (
                 SELECT claimant_id,ordinal,claimant_count,
                        CASE WHEN u.unit = 1 THEN
                          floor(a.amount_cents / claimant_count)
                            + CASE WHEN ordinal <= mod(a.amount_cents,claimant_count)
                                   THEN 1 ELSE 0 END
                        ELSE
                          public.fn_ca_unit_floor_cents(floor(a.amount_cents / claimant_count)::bigint, u.unit)
                            + CASE WHEN ordinal = 1
                                   THEN a.amount_cents
                                        - public.fn_ca_unit_floor_cents(floor(a.amount_cents / claimant_count)::bigint, u.unit) * claimant_count
                                   ELSE 0 END
                        END AS expected_cents
                   FROM (
                     SELECT (c->>'user_id')::uuid AS claimant_id,
                            row_number() OVER (ORDER BY c->>'user_id') AS ordinal,
                            count(*) OVER () AS claimant_count
                       FROM jsonb_array_elements(o.claimants) c
                   ) ordered_claimants
                   CROSS JOIN (SELECT public.fn_ca_tournament_unit_cents(o.tournament_id) AS unit) u
               ) expected
              WHERE NOT EXISTS (
                SELECT 1 FROM public.tournament_bounty_award_recipients r
                 WHERE r.award_id=a.id AND r.user_id=expected.claimant_id
                   AND r.amount_cents=expected.expected_cents
                   AND r.paid_at IS NOT NULL
              )
           )
           AND NOT EXISTS (
             SELECT 1 FROM public.tournament_bounty_award_recipients r
              WHERE r.award_id=a.id
                AND (r.paid_at IS NULL OR NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements(o.claimants) c
                   WHERE (c->>'user_id')::uuid=r.user_id
                ))
           )
      )
    ELSE
      NOT EXISTS (
        SELECT 1
          FROM (
            SELECT claimant_id, ordinal, claimant_count, u.unit,
                   CASE WHEN ordinal < claimant_count
                        THEN public.fn_ca_unit_floor_cents(floor(head_cents / claimant_count)::bigint, u.unit)
                        ELSE head_cents
                             - public.fn_ca_unit_floor_cents(floor(head_cents / claimant_count)::bigint, u.unit) * (claimant_count - 1)
                   END AS expected_cents
              FROM (
                SELECT (c->>'user_id')::uuid AS claimant_id,
                       row_number() OVER (ORDER BY c->>'user_id') AS ordinal,
                       count(*) OVER () AS claimant_count,
                       round(o.head_amount * 100)::bigint AS head_cents
                  FROM jsonb_array_elements(o.claimants) c
              ) ordered_claimants
              CROSS JOIN (SELECT public.fn_ca_tournament_unit_cents(o.tournament_id) AS unit) u
          ) expected
         WHERE expected.expected_cents > 0
           AND NOT EXISTS (
           SELECT 1 FROM public.tournament_bounties b
            WHERE b.bounty_obligation_id=o.id
              AND b.collector_player_id=expected.claimant_id
              AND round(b.bounty_amount * 100)::bigint=expected.expected_cents
              AND round(COALESCE(b.added_to_collector_bounty,0) * 100)::bigint=
                    CASE WHEN o.mode='pko'
                         THEN expected.expected_cents
                              - public.fn_ca_unit_floor_cents(floor(expected.expected_cents/2.0)::bigint, expected.unit)
                         ELSE 0 END
              AND round((b.bounty_amount-COALESCE(b.added_to_collector_bounty,0))*100)::bigint=
                    CASE WHEN o.mode='pko'
                         THEN public.fn_ca_unit_floor_cents(floor(expected.expected_cents/2.0)::bigint, expected.unit)
                         ELSE expected.expected_cents END
         )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.tournament_bounties b
         WHERE b.bounty_obligation_id=o.id
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(o.claimants) c
              WHERE (c->>'user_id')::uuid=b.collector_player_id
           )
      )
      AND round(COALESCE((
        SELECT sum(b.bounty_amount) FROM public.tournament_bounties b
         WHERE b.bounty_obligation_id=o.id
      ),0),2)=round(o.head_amount,2)
    END
      FROM public.tournament_bounty_obligations o
     WHERE o.id=p_obligation_id
  ),false);
$function$;
ALTER FUNCTION public.fn_bounty_obligation_has_complete_marker(p_obligation_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_bounty_obligation_has_complete_marker(p_obligation_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_bounty_obligation_has_complete_marker(p_obligation_id uuid) TO service_role;
-- @@END fn_bounty_obligation_has_complete_marker(p_obligation_id uuid)

-- @@DOOR fn_ca_arena_diamonds()
-- @@PIN md5=86863a1208455e92803777829bc9a668 len=370 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_arena_diamonds()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT (SELECT COALESCE(sum(balance),0)::numeric FROM public.poker_diamond_custody)
   +(SELECT COALESCE(sum(pending_diamonds),0)::numeric FROM public.diamond_spin_days WHERE status='open');
$function$;
ALTER FUNCTION public.fn_ca_arena_diamonds() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_arena_diamonds() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_arena_diamonds() TO service_role;
-- @@END fn_ca_arena_diamonds()

-- @@DOOR fn_ca_assert_satellite_cohort_standings(p_tournament_id uuid)
-- @@PIN md5=12b83a02a4057025e153f07bad9d8919 len=2255 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_assert_satellite_cohort_standings(p_tournament_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE h public.tournament_satellite_settlements%ROWTYPE; n integer;
BEGIN
 SELECT * INTO STRICT h FROM public.tournament_satellite_settlements WHERE tournament_id=p_tournament_id;
 n:=cardinality(h.qualifier_ids);
 IF h.receipt_version<>3 OR h.winner_id IS NOT NULL OR n IS NULL OR n<1
    OR n>h.ticket_award_count OR h.qualifier_ids IS DISTINCT FROM
       (SELECT array_agg(DISTINCT u ORDER BY u) FROM unnest(h.qualifier_ids) u)
    OR (SELECT to_jsonb(t)->>'format_contract' FROM public.tournaments t WHERE id=p_tournament_id)
       IS DISTINCT FROM 'mtt-v2'
    OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament_id)<>h.field_size
    OR EXISTS(SELECT 1 FROM unnest(h.qualifier_ids) u WHERE NOT EXISTS(
       SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
        AND tp.user_id=u AND tp.status='winner' AND tp.position IS NULL
        AND tp.elimination_sequence IS NULL AND tp.eliminated_at IS NULL AND tp.chips>0))
    OR EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
      AND NOT(tp.user_id=ANY(h.qualifier_ids))
      AND (tp.status IS DISTINCT FROM 'eliminated' OR tp.elimination_sequence IS NULL
           OR tp.position IS NULL OR tp.position<=n OR tp.position>h.field_size))
    OR (SELECT count(DISTINCT position) FROM public.tournament_players WHERE tournament_id=p_tournament_id)<>h.field_size-n
    OR (SELECT count(DISTINCT elimination_sequence) FROM public.tournament_players WHERE tournament_id=p_tournament_id)<>h.field_size-n
    OR EXISTS(SELECT 1 FROM (SELECT position,n+row_number() OVER(ORDER BY COALESCE(public.fn_ca_tournament_bust_at(tournament_id, user_id), eliminated_at) DESC NULLS LAST, elimination_sequence DESC) expected
        FROM public.tournament_players WHERE tournament_id=p_tournament_id AND status='eliminated') r
       WHERE r.position<>r.expected) THEN
  RAISE EXCEPTION 'satellite cohort has no exact unranked survivors and causal eliminated standings' USING ERRCODE='P0404';
 END IF;
END $function$;
ALTER FUNCTION public.fn_ca_assert_satellite_cohort_standings(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_assert_satellite_cohort_standings(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_assert_satellite_cohort_standings(p_tournament_id uuid)

-- @@DOOR fn_ca_assert_tournament_chip_grant(p_tournament_id uuid, p_user_id uuid, p_seat_id uuid, p_new_stack numeric, p_source text)
-- @@PIN md5=c49fa16f6be47ed9ca2e72b2f2b9da07 len=1493 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_assert_tournament_chip_grant(p_tournament_id uuid, p_user_id uuid, p_seat_id uuid, p_new_stack numeric, p_source text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_felt numeric;
  v_own numeric;
  v_supply numeric;
  v_after numeric;
BEGIN
  IF p_tournament_id IS NULL OR p_new_stack IS NULL THEN
    RAISE EXCEPTION 'tournament chip grant assertion needs a tournament and a stack'
      USING ERRCODE='22023';
  END IF;
  IF p_new_stack::text IN ('NaN','Infinity','-Infinity') OR p_new_stack<0 THEN
    RAISE EXCEPTION 'TOURNAMENT_CHIP_GRANT_INVALID: % proposed stack %',
      COALESCE(p_source,'grant'),p_new_stack
      USING ERRCODE='22023';
  END IF;

  v_supply:=public.fn_ca_tournament_chip_supply(p_tournament_id);
  v_felt:=public.fn_ca_tournament_felt_total(p_tournament_id);
  SELECT COALESCE(ts.stack,0) INTO v_own
    FROM public.table_seats ts
   WHERE ts.id=p_seat_id AND ts.left_at IS NULL;
  v_after:=v_felt-COALESCE(v_own,0)+p_new_stack;

  IF v_after>v_felt AND v_after>v_supply THEN
    RAISE EXCEPTION
      'TOURNAMENT_CHIP_GRANT_WOULD_MINT: % for player % would leave % chips on the felt in tournament % against % ever bought in (felt now %, this seat holds %) - Aborting So No Charge Is Made',
      COALESCE(p_source,'grant'),p_user_id,v_after,p_tournament_id,v_supply,
      v_felt,COALESCE(v_own,0)
      USING ERRCODE='55000';
  END IF;
END;
$function$;
ALTER FUNCTION public.fn_ca_assert_tournament_chip_grant(p_tournament_id uuid, p_user_id uuid, p_seat_id uuid, p_new_stack numeric, p_source text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_assert_tournament_chip_grant(p_tournament_id uuid, p_user_id uuid, p_seat_id uuid, p_new_stack numeric, p_source text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_assert_tournament_chip_grant(p_tournament_id uuid, p_user_id uuid, p_seat_id uuid, p_new_stack numeric, p_source text) TO service_role;
-- @@END fn_ca_assert_tournament_chip_grant(p_tournament_id uuid, p_user_id uuid, p_seat_id uuid, p_new_stack numeric, p_source text)

-- @@DOOR fn_ca_autoledger()
-- @@PIN md5=53f9d85b88cc86b807f7ea5b80d7bd4e len=4337 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_autoledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  spec text; col text; acct text;
  o jsonb; nn jsonb;
  d numeric; oldv numeric; newv numeric;
  cat text; cp text; cpid uuid;
  v_club uuid; v_union uuid; v_entity uuid; v_guc_club uuid;
  actor uuid;
  v_st text; v_msg text;
BEGIN
  IF current_setting('app.ledger_autoskip_' || TG_TABLE_NAME, true) = '1' THEN
    RETURN NEW;
  END IF;

  o  := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  nn := to_jsonb(NEW);

  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');
  cp  := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN
    cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN cpid := NULL;
  END;
  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  /* THE JOURNAL LEG NAMES THE CLUB THE MONEY LANDED IN (2026-09-20).
     union_wallets and unions are the only autoledgered tables with no
     club_id column - `nn ? 'club_id'` is key EXISTENCE, so a table
     that has the column takes the arm above even when it is NULL. Before
     today every leg journalled from those two was written club-less, and
     fn_chip_drift_since_baseline filters movements on club_id IS NOT
     NULL while counting the balance they explain, so correctly paid
     union-hosted prizes were reported as member drift.
     A payer that knows the club declares it on
     app.ledger_autoledger_club_id, transaction-scoped, and clears it
     beside the autoskips. It is deliberately NOT app.ledger_club_id:
     that name is taken and decides which club a WALLET credit is paid
     into (atomic_credit_wallet_and_log, atomic_deduct_wallet_and_log,
     log_wallet_transaction), so borrowing it would let a rakeback
     close's club leak onto a union leg and would move real money when
     cleared. Read through an exception guard exactly as cpid is above:
     a malformed value must never abort a chip movement. */
  BEGIN
    v_guc_club := NULLIF(current_setting('app.ledger_autoledger_club_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN v_guc_club := NULL;
  END;
  v_club := CASE
    WHEN TG_TABLE_NAME = 'clubs' THEN (nn->>'id')::uuid
    WHEN nn ? 'club_id' THEN NULLIF(nn->>'club_id','')::uuid
    ELSE v_guc_club END;
  v_union := CASE
    WHEN TG_TABLE_NAME = 'unions' THEN (nn->>'id')::uuid
    WHEN nn ? 'union_id' THEN NULLIF(nn->>'union_id','')::uuid
    ELSE NULL END;
  v_entity := CASE
    WHEN TG_TABLE_NAME = 'agents' THEN NULLIF(nn->>'user_id','')::uuid
    WHEN TG_TABLE_NAME = 'club_members' THEN NULLIF(nn->>'user_id','')::uuid
    ELSE COALESCE(NULLIF(nn->>'id','')::uuid, v_club, v_union) END;

  FOR i IN 0 .. TG_NARGS - 1 LOOP
    spec := TG_ARGV[i];
    col  := split_part(spec, '=', 1);
    acct := split_part(spec, '=', 2);
    oldv := COALESCE(NULLIF(o->>col,'')::numeric, 0);
    newv := COALESCE(NULLIF(nn->>col,'')::numeric, 0);
    d := round(newv - oldv, 2);
    CONTINUE WHEN d = 0;

    BEGIN
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, union_id, description,
         pre_from_balance, post_from_balance, pre_to_balance, post_to_balance)
      VALUES (actor,
        CASE WHEN d > 0 THEN cp   ELSE acct END,
        CASE WHEN d > 0 THEN cpid ELSE v_entity END,
        CASE WHEN d > 0 THEN NULL ELSE TG_TABLE_NAME || '.' || col END,
        CASE WHEN d > 0 THEN acct ELSE cp END,
        CASE WHEN d > 0 THEN v_entity ELSE cpid END,
        CASE WHEN d > 0 THEN TG_TABLE_NAME || '.' || col ELSE NULL END,
        abs(d), cat, v_club, v_union,
        'auto-ledgered ' || TG_TABLE_NAME || '.' || col || ' delta ' || d::text,
        CASE WHEN d < 0 THEN oldv END, CASE WHEN d < 0 THEN newv END,
        CASE WHEN d > 0 THEN oldv END, CASE WHEN d > 0 THEN newv END);
    EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;
  END LOOP;

  RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_ca_autoledger() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_autoledger() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_autoledger() TO service_role;
-- @@END fn_ca_autoledger()

-- @@DOOR fn_ca_capture_tournament_obligation_event()
-- @@PIN md5=d6e1f4f7b4a93df535d3b4d4bce925bf len=2323 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_capture_tournament_obligation_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_b jsonb;v_a jsonb;v_r jsonb;v_t jsonb;v_p jsonb;v_entries uuid[];v_credit uuid;v_refunds uuid[];
 v_key text;
BEGIN
 IF TG_OP<>'INSERT' THEN v_b:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN v_a:=to_jsonb(NEW); END IF;
 IF v_b IS NOT DISTINCT FROM v_a THEN RETURN NULL; END IF;
 v_r:=COALESCE(v_a,v_b);
 SELECT to_jsonb(t) INTO v_t FROM public.tournaments t WHERE id=(v_r->>'tournament_id')::uuid;
 SELECT to_jsonb(p) INTO v_p FROM public.tournament_players p
 WHERE tournament_id=(v_r->>'tournament_id')::uuid AND user_id=(v_r->>'user_id')::uuid;
 SELECT COALESCE(array_agg(id ORDER BY observed_at,id),'{}'::uuid[]) INTO v_entries
 FROM public.tournament_participant_funding_receipts WHERE registration_id=(v_p->>'id')::uuid;
 -- The existing cumulative owner names the exact original payment, never a time-window match.
 v_key:=NULLIF(current_setting('app.pnl_tournament_obligation_credit_key',true),'');
 IF TG_OP='UPDATE' AND NEW.amount_paid>OLD.amount_paid
    AND v_key='tourney:'||NEW.tournament_id::text||':obl:'||NEW.id::text||':'||(round(OLD.amount_paid*100))::bigint::text THEN
   SELECT id INTO v_credit FROM public.tournament_accounting_credit_receipts
   WHERE idempotency_key=v_key AND tournament_id=NEW.tournament_id
     AND user_id=NEW.user_id AND amount=NEW.amount_paid-OLD.amount_paid;
 END IF;
 SELECT COALESCE(array_agg(wallet_transaction_id ORDER BY wallet_transaction_id),'{}'::uuid[]) INTO v_refunds
 FROM public.tournament_refund_tranches WHERE obligation_id=(v_r->>'id')::uuid;
 INSERT INTO public.tournament_obligation_events(
 obligation_id,asset,tournament_id,user_id,operation,before_row,after_row,tournament_snapshot,
 registration_snapshot,entry_receipt_ids,credit_receipt_id,refund_tranche_ids)
 VALUES((v_r->>'id')::uuid,
 CASE WHEN v_t IS NULL THEN 'unknown' WHEN public.fn_ca_tournament_unit_cents((v_r->>'tournament_id')::uuid)=100 THEN 'diamonds' ELSE 'chips' END,
 (v_r->>'tournament_id')::uuid,(v_r->>'user_id')::uuid,TG_OP,
 v_b,v_a,COALESCE(v_t,jsonb_build_object('id',v_r->>'tournament_id','scope_unavailable',true)),v_p,v_entries,v_credit,v_refunds);
 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_ca_capture_tournament_obligation_event() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_capture_tournament_obligation_event() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_capture_tournament_obligation_event()

-- @@DOOR fn_ca_cash_buyin_receipt(p_idempotency_key uuid, p_table_id uuid)
-- @@PIN md5=82e0c070a873103964f597a1968745c7 len=1606 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_cash_buyin_receipt(p_idempotency_key uuid, p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'auth'
 SET statement_timeout TO '5s'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_request jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in to check your buy-in' USING ERRCODE = '42501';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: sign in again to check your buy-in'
      USING ERRCODE = '28000';
  END IF;

  SELECT r.request INTO v_request
    FROM public.entry_purchase_idempotency_receipts r
   WHERE r.key_domain = 'cash_transaction'
     AND r.idempotency_key = p_idempotency_key::text
     AND r.request->>'door' = 'atomic_table_buyin'
     AND r.request->>'user_id' = v_user_id::text
     AND r.request->>'table_id' = p_table_id::text
     AND r.response = jsonb_build_object('completed', true)
     AND r.completed_at IS NOT NULL;

  -- An in-flight transaction is invisible here. Never call absence a refusal,
  -- and never infer the purchase from a current seat or current wallet balance.
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unconfirmed'); END IF;
  RETURN jsonb_build_object('status', 'confirmed', 'request', jsonb_build_object(
    'door', 'atomic_table_buyin', 'user_id', v_user_id, 'table_id', p_table_id,
    'seat_number', v_request->'seat_number', 'amount', v_request->'amount',
    'auto_rebuy', v_request->'auto_rebuy', 'club_id', v_request->'club_id'
  ));
END;
$function$;
ALTER FUNCTION public.fn_ca_cash_buyin_receipt(p_idempotency_key uuid, p_table_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_cash_buyin_receipt(p_idempotency_key uuid, p_table_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_cash_buyin_receipt(p_idempotency_key uuid, p_table_id uuid) TO authenticated;
-- @@END fn_ca_cash_buyin_receipt(p_idempotency_key uuid, p_table_id uuid)

-- @@DOOR fn_ca_consume_purchase_lots(p_user_id uuid, p_amount bigint)
-- @@PIN md5=d8674a23766c140fa3e85834d540a4ac len=1292 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_consume_purchase_lots(p_user_id uuid, p_amount bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_left bigint := COALESCE(p_amount, 0); v_lot record; v_take bigint; v_consumed bigint := 0;
BEGIN
  IF v_left <= 0 THEN RETURN 0; END IF;
  BEGIN
    FOR v_lot IN
      SELECT l.id, (l.issued - l.consumed - l.refunded - l.arena_reserved) AS avail
        FROM public.diamond_purchase_lots l
       WHERE l.user_id = p_user_id AND l.frozen_at IS NULL
         AND (l.issued - l.consumed - l.refunded - l.arena_reserved) > 0
       ORDER BY l.created_at, l.id
       FOR UPDATE
    LOOP
      EXIT WHEN v_left <= 0;
      v_take := LEAST(v_lot.avail, v_left);
      UPDATE public.diamond_purchase_lots SET consumed = consumed + v_take WHERE id = v_lot.id;
      v_left := v_left - v_take;
      v_consumed := v_consumed + v_take;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      PERFORM public.fn_ca_diamond_incident('DR9:purchase_lot_write_failed', 'critical', p_user_id, p_amount,
        'fn_ca_consume_purchase_lots', jsonb_build_object('sqlstate', SQLSTATE, 'message', SQLERRM));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN v_consumed;
END $function$;
ALTER FUNCTION public.fn_ca_consume_purchase_lots(p_user_id uuid, p_amount bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_consume_purchase_lots(p_user_id uuid, p_amount bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_consume_purchase_lots(p_user_id uuid, p_amount bigint) TO service_role;
-- @@END fn_ca_consume_purchase_lots(p_user_id uuid, p_amount bigint)

-- @@DOOR fn_ca_diamond_engine_of(p_type text, p_transaction_type text, p_source text, p_description text, p_reference_id text)
-- @@PIN md5=44a39c35cc96801b5aa22a6ac930ee17 len=4049 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_engine_of(p_type text, p_transaction_type text, p_source text, p_description text, p_reference_id text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT CASE
        WHEN COALESCE(p_transaction_type,p_type)='referral_qualified' THEN 'qualified_referrals'
        WHEN starts_with(p_reference_id, 'ca_daily_bonus:')   THEN 'club_arena_daily'
        WHEN starts_with(p_reference_id, 'wheel:')            THEN 'wheel'
        WHEN starts_with(p_reference_id, 'trivia_tourn_')     THEN 'trivia_tournaments'
        WHEN starts_with(p_reference_id, 'trivia_session_')   THEN 'trivia'
        WHEN starts_with(p_reference_id, 'trivia_wheel_')     THEN 'trivia'
        WHEN starts_with(p_reference_id, 'challenge_claim')   THEN 'daily_challenges'
        WHEN starts_with(p_reference_id, 'daily_mission_milestones:') THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'daily-missions-historical-multiplier:') THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'daily_mission_')    THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'streak_milestone_') THEN 'share_streak'
        WHEN starts_with(p_reference_id, 'streak_')           THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'signup:')           THEN 'signup'
        WHEN starts_with(p_reference_id, 'easter_egg_')       THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'video_favorite_')   THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'vip_stipend_')      THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'hotd_')             THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'progress_')         THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'customization-cert-fund') THEN 'cert_fixture'
        WHEN p_source = 'complete_daily_challenge' THEN 'memory_game'
        WHEN p_source = 'handle_new_user'          THEN 'signup'
        WHEN p_source = 'union'                    THEN 'union_grant'
        WHEN p_source = 'the_mint'                 THEN 'mint'
        WHEN COALESCE(p_transaction_type, p_type) IN ('wheel_prize', 'wheel_spin') THEN 'wheel'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'referral_bonus', 'referral_bonus_reversal', 'referral_qualified',
                'referral_referee', 'referral_vip_conversion',
                'referral_milestone', 'referral_reward')                    THEN 'referrals'
        WHEN COALESCE(p_transaction_type, p_type) = 'signup_bonus'         THEN 'signup'
        WHEN COALESCE(p_transaction_type, p_type) = 'union_grant'          THEN 'union_grant'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'pvp_refund', 'pvp_win', 'pvp_tie_refund', 'trivia_run',
                'trivia_daily_bonus', 'daily_trivia', 'trivia_reward',
                'trivia_prize_wheel', 'endless_reward', 'survival_reward',
                'mixed_reward', 'time_attack_reward', 'trivia_double_win')  THEN 'trivia'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'tournament_prize', 'tournament_entry_refund',
                'tournament_cancel_refund')                                THEN 'trivia_tournaments'
        WHEN COALESCE(p_transaction_type, p_type) IN ('daily_challenge_claim') THEN 'daily_challenges'
        WHEN COALESCE(p_transaction_type, p_type) IN ('daily_mission_milestone', 'daily_mission_reward') THEN 'daily_missions'
        WHEN COALESCE(p_transaction_type, p_type) = 'streak_reward'        THEN 'share_streak'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'daily_login', 'easter_egg', 'training_reward',
                'video_favorite', 'vip_stipend')                           THEN 'catalog_v2'
        WHEN COALESCE(p_transaction_type, p_type) IN ('credit', 'earn', 'bonus') THEN 'legacy_credit'
        WHEN p_description LIKE 'Diamond Rewards v2:%'                      THEN 'catalog_v2'
        ELSE 'other'
    END;
$function$;
ALTER FUNCTION public.fn_ca_diamond_engine_of(p_type text, p_transaction_type text, p_source text, p_description text, p_reference_id text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_engine_of(p_type text, p_transaction_type text, p_source text, p_description text, p_reference_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_engine_of(p_type text, p_transaction_type text, p_source text, p_description text, p_reference_id text) TO service_role;
-- @@END fn_ca_diamond_engine_of(p_type text, p_transaction_type text, p_source text, p_description text, p_reference_id text)

-- @@DOOR fn_ca_diamond_journal_origin(p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric)
-- @@PIN md5=373b32a1f7b88bd38277e808a5700256 len=4190 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_journal_origin(p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_kind  text := lower(COALESCE(NULLIF(btrim(p_transaction_type), ''), NULLIF(btrim(p_type), ''), ''));
  v_class text := lower(COALESCE(NULLIF(btrim(p_issuance_class), ''), ''));
  v_src   text := lower(COALESCE(NULLIF(btrim(p_source), ''), ''));
BEGIN
  IF p_amount IS NULL OR p_amount = 0 THEN RETURN NULL; END IF;
  -- The Mint's own doors register their own rows.
  IF v_src = 'the_mint' THEN RETURN NULL; END IF;
  -- SO DOES THE SEED DOOR. fn_ca_diamond_born_with_balance writes the
  -- 'seed:<id>' register row for the signup grant and then the journal row.
  -- Registering it here as well counts one movement twice (2026-09-05: 18
  -- duplicate pairs, 9,000 diamonds). Named writer, not a class: every OTHER
  -- promotional credit still registers here.
  IF v_kind = 'signup_bonus' OR v_src = 'handle_new_user' THEN RETURN NULL; END IF;
  -- ADDED 20260930055147. A JOURNAL ROW THAT ONLY WRITES DOWN SUPPLY THE
  -- REGISTER ALREADY COUNTED. The pre-2026-09-01 born-with-balance door moved
  -- profiles.diamonds and the register together and skipped the journal, so
  -- 220,985 diamonds sat in wallets that the journal could not explain while
  -- the register could. The backfill that writes those journal rows must not
  -- register them a second time: fn_ca_mint_supply('diamonds') already equals
  -- what players hold, and following these rows would break that identity by
  -- the exact amount of the backfill. Named source, not a class, for the same
  -- reason as the seed door above: every other admin credit still registers.
  IF v_src = 'journal_backfill' THEN RETURN NULL; END IF;
  -- Player to player: supply moves, none is created or retired.
  IF public.fn_ca_diamond_journal_is_transfer(p_type, p_transaction_type, p_source, p_issuance_class) THEN
    RETURN NULL;
  END IF;
  -- THE ARENA DOORS MOVE MONEY, THEY DO NOT ISSUE IT. A deposit takes diamonds out of
  -- profiles.diamonds and puts them in the platform club's member wallet; a withdrawal is the
  -- mirror. The player still owns them and the supply is unchanged, so the register must not
  -- follow either leg - the same treatment, for the same reason, as a player-to-player transfer
  -- above. Classified as 'spend' (deposit) and 'arena' (withdrawal), the register would have
  -- burned the float on the way in and minted it on the way out (2026-09-08).
  IF v_kind IN ('arena_deposit', 'arena_withdraw') THEN RETURN NULL; END IF;
  -- The deletion door writes its own register row.
  IF v_class = 'deletion' THEN RETURN NULL; END IF;
  -- A test fixture row is not supply the Mint issued.
  IF v_kind LIKE 'test%' THEN RETURN NULL; END IF;

  IF p_amount > 0 THEN
    IF v_class = 'purchased' OR v_kind IN ('purchase', 'stripe_purchase', 'diamond_purchase') THEN
      RETURN 'purchase';
    ELSIF v_class = 'refund' OR v_kind LIKE '%refund%' OR v_kind = 'diamond_refund' THEN
      RETURN 'refund';
    ELSIF v_class = 'promotional' OR v_kind IN ('union_grant', 'bonus', 'promo',
                                                 'promo_purchased', 'easter_egg', 'vip_daily',
                                                 'vip_stipend', 'vip_monthly') THEN
      RETURN 'promotion';
    ELSIF v_class = 'admin' OR v_kind IN ('adjustment', 'reconciliation', 'admin', 'admin_grant') THEN
      RETURN 'adjustment';
    -- 'arcade%' only. The 'arena' CLASS now belongs to the arena doors, which are handled
    -- as transfers above; leaving it here would have made a withdrawal mint.
    ELSIF v_kind LIKE 'arcade%' THEN
      RETURN 'arena';
    ELSE
      RETURN 'reward';
    END IF;
  ELSE
    IF v_kind IN ('chip_mint', 'chip_purchase', 'mint_chips', 'diamonds_to_chips') OR v_class = 'bridge' THEN
      RETURN 'bridge';
    ELSIF v_class = 'admin' OR v_kind IN ('adjustment', 'reconciliation', 'admin', 'chargeback', 'clawback') THEN
      RETURN 'adjustment';
    ELSE
      RETURN 'spend';
    END IF;
  END IF;
END;
$function$;
ALTER FUNCTION public.fn_ca_diamond_journal_origin(p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_journal_origin(p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_journal_origin(p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric) TO service_role;
-- @@END fn_ca_diamond_journal_origin(p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric)

-- @@DOOR fn_ca_diamond_register_vs_supply()
-- @@PIN md5=4831173c57fc3d4e2bc0fa5eea346ee2 len=878 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_register_vs_supply()
 RETURNS TABLE(register_net numeric, meter_total numeric, player_diamonds numeric, house_diamonds numeric, difference numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH r AS (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) AS net
               FROM public.ca_mint_ledger WHERE asset = 'diamonds'),
       p AS (SELECT COALESCE(SUM(COALESCE(diamonds, 0)), 0)::numeric AS held FROM public.profiles),
       h AS (SELECT COALESCE(SUM(COALESCE(balance, 0)), 0)::numeric AS held FROM public.ca_diamond_house)
  SELECT round(r.net, 2), round(p.held + h.held + public.fn_ca_arena_diamonds(), 2), round(p.held, 2), round(h.held, 2),
         round(p.held + h.held + public.fn_ca_arena_diamonds() - r.net, 2)
    FROM r, p, h;
$function$;
ALTER FUNCTION public.fn_ca_diamond_register_vs_supply() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_register_vs_supply() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_register_vs_supply() TO service_role;
-- @@END fn_ca_diamond_register_vs_supply()

-- @@DOOR fn_ca_diamond_transfer_names_its_counterparty()
-- @@PIN md5=ffd2026beded5edfde9726d4fde77cbf len=1487 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_transfer_names_its_counterparty()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_cp text := btrim(COALESCE(NEW.counterparty, ''));
BEGIN
  IF COALESCE(NEW.amount, 0) = 0 THEN
    RETURN NEW;
  END IF;
  -- COALESCE, not NOT: an unreadable answer must not be read as "refuse". The
  -- register follows anything this says no to, so nothing goes unrecorded either way.
  IF COALESCE(public.fn_ca_diamond_journal_is_transfer(NEW.type, NEW.transaction_type,
                                                       NEW.source, NEW.issuance_class), false) = false THEN
    RETURN NEW;   -- the register will follow this row; nothing to prove here
  END IF;
  IF v_cp ~* '^player:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = substring(v_cp from 8)::uuid) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a diamond transfer must name the player on the other side: % of % diamonds for % carries counterparty %',
    COALESCE(NEW.transaction_type, NEW.type, 'transfer'), NEW.amount, NEW.user_id,
    COALESCE(NULLIF(v_cp, ''), '(none)')
    USING ERRCODE = 'P0408',
          HINT = 'The Mint register skips a transfer because supply only moves - which is only true if another leg moved it back. Name the counterparty: add_diamonds_to_balance p_counterparty_id, or recipient_id in the deduct_diamonds metadata.';
END
$function$;
ALTER FUNCTION public.fn_ca_diamond_transfer_names_its_counterparty() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_transfer_names_its_counterparty() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_transfer_names_its_counterparty() TO authenticated, service_role;
-- @@END fn_ca_diamond_transfer_names_its_counterparty()

-- @@DOOR fn_ca_fee_cutover_stranded_by(p_starts_at timestamp with time zone)
-- @@PIN md5=aa8ef4fe6a1d23888ae955bdce26ab01 len=1052 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_fee_cutover_stranded_by(p_starts_at timestamp with time zone)
 RETURNS TABLE(stranded_tournaments integer, stranded_fees integer, oldest_fee_at timestamp with time zone, oldest_tournament uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH live AS (
    SELECT rr.id, rr.tournament_id, rr.created_at
      FROM public.rake_records rr
      JOIN public.tournaments t ON t.id = rr.tournament_id
      LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id = rr.id
     WHERE rr.is_tournament
       AND rr.rake_amount > 0
       AND upper(COALESCE(t.status::text, '')) IN ('RUNNING', 'BREAK', 'REGISTERING', 'COMPLETING')
       AND rr.created_at < p_starts_at
       AND b.status IS DISTINCT FROM 'captured'
  )
  SELECT COALESCE(count(DISTINCT tournament_id), 0)::int,
         COALESCE(count(*), 0)::int,
         min(created_at),
         (SELECT l.tournament_id FROM live l ORDER BY l.created_at, l.id LIMIT 1)
    FROM live;
$function$;
ALTER FUNCTION public.fn_ca_fee_cutover_stranded_by(p_starts_at timestamp with time zone) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_fee_cutover_stranded_by(p_starts_at timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_fee_cutover_stranded_by(p_starts_at timestamp with time zone) TO service_role;
-- @@END fn_ca_fee_cutover_stranded_by(p_starts_at timestamp with time zone)

-- @@DOOR fn_ca_guard_fee_cutover_is_drained()
-- @@PIN md5=00d1c66499077ca5947eb57bf62d1060 len=975 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_guard_fee_cutover_is_drained()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v record;
BEGIN
  IF NEW.starts_at IS NULL OR NOT isfinite(NEW.starts_at) THEN
    RAISE EXCEPTION 'the accounting fee cutover needs a finite instant' USING ERRCODE = '22007';
  END IF;
  SELECT * INTO v FROM public.fn_ca_fee_cutover_stranded_by(NEW.starts_at);
  IF COALESCE(v.stranded_tournaments, 0) > 0 THEN
    RAISE EXCEPTION
      'fee cutover % would strand % live tournament(s) holding % unwitnessed fee(s); oldest is tournament % charged %. Drain or reconcile them first.',
      NEW.starts_at, v.stranded_tournaments, v.stranded_fees, v.oldest_tournament, v.oldest_fee_at
      USING ERRCODE = '55000',
            HINT = 'A cutover promises every fee after it can be witnessed. It cannot make that promise about fees already charged.';
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.fn_ca_guard_fee_cutover_is_drained() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_guard_fee_cutover_is_drained() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_guard_fee_cutover_is_drained() TO service_role;
-- @@END fn_ca_guard_fee_cutover_is_drained()

-- @@DOOR fn_ca_guard_original_paid_stack_receipt()
-- @@PIN md5=06bbbafae6950b54fdb00297830a30a4 len=948 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_guard_original_paid_stack_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 IF TG_OP='DELETE' OR TG_OP='TRUNCATE' THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_CUSTODY_IMMUTABLE' USING ERRCODE='55000';
 ELSIF TG_OP='INSERT' THEN
  IF NEW.state IS DISTINCT FROM 'reserved' OR NEW.transaction_id IS DISTINCT FROM pg_current_xact_id() THEN
   RAISE EXCEPTION 'ORIGINAL_PAID_CUSTODY_RESERVATION_REQUIRED' USING ERRCODE='55000';
  END IF;
 ELSIF OLD.state IS DISTINCT FROM 'reserved' OR NEW.state IS DISTINCT FROM 'seated'
 OR OLD.transaction_id IS DISTINCT FROM pg_current_xact_id()
 OR (to_jsonb(NEW)-ARRAY['state','assignment','completed_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','assignment','completed_at']) THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_CUSTODY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_ca_guard_original_paid_stack_receipt() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_guard_original_paid_stack_receipt() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_guard_original_paid_stack_receipt()

-- @@DOOR fn_ca_guard_seat_creation()
-- @@PIN md5=b3e14f411d43b01e84fd614c87f8bf6a len=3234 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_guard_seat_creation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_path text;
  v_creating boolean;
  v_tournament_id uuid;
  v_variant text;
  v_max_players integer;
  v_starting_chips numeric;
BEGIN
  v_creating := (TG_OP = 'INSERT' AND NEW.left_at IS NULL)
             OR (TG_OP = 'UPDATE' AND OLD.left_at IS NOT NULL AND NEW.left_at IS NULL);
  IF NOT v_creating THEN
    RETURN NEW;
  END IF;

  SELECT tb.tournament_id, t.variant, t.max_players, t.starting_chips
    INTO v_tournament_id, v_variant, v_max_players, v_starting_chips
    FROM public.tables tb
    LEFT JOIN public.tournaments t ON t.id = tb.tournament_id
   WHERE tb.id = NEW.table_id;

  IF v_tournament_id IS NOT NULL THEN
    IF NEW.stack IS NULL
       OR NEW.stack::text IN ('NaN','Infinity','-Infinity')
       OR NEW.stack <= 0 THEN
      RAISE EXCEPTION
        'TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK: tournament %, table %, seat %, stack %',
        v_tournament_id, NEW.table_id, NEW.seat_number, NEW.stack
        USING ERRCODE = 'check_violation',
              HINT = 'Create or revive the seat with its paid positive stack in the same database transaction.';
    END IF;

    IF public.fn_ca_tournament_recorded_seat_first(v_tournament_id, false) THEN
      IF v_starting_chips IS NULL
         OR v_starting_chips::text IN ('NaN','Infinity','-Infinity')
         OR v_starting_chips <= 0 THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STARTING_CHIPS_INVALID: tournament %, starting_chips %',
          v_tournament_id, v_starting_chips
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.stack IS DISTINCT FROM v_starting_chips THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS: tournament %, table %, seat %, stack %, expected %',
          v_tournament_id, NEW.table_id, NEW.seat_number, NEW.stack, v_starting_chips
          USING ERRCODE = 'check_violation',
                HINT = 'The paid seat transaction is the only starting-stack authority; no later top-up exists.';
      END IF;
    END IF;
  END IF;

  -- Cash seats with no funded stack preserve their existing reservation path.
  IF COALESCE(NEW.stack,0) <= 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_caller_is_engine() THEN
    RETURN NEW;
  END IF;

  v_path := current_setting('app.money_path', true);
  IF v_path IN ('atomic_table_buyin', 'fn_take_seat_and_buy_in',
                'fn_seat_horse_in_seat_first_game', 'fn_seat_late_registrant',
                'fn_assign_tournament_player_seat_atomic',
                'fn_horse_seat_from_treasury') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'SEAT_NOT_FUNDED: chips may only reach a seat through the engine or a declared money path (path=%, jwt_role=%, app=%, table=%, seat=%, stack=%)',
    COALESCE(NULLIF(v_path, ''), 'none'),
    COALESCE(auth.role(), 'none'),
    COALESCE(NULLIF(current_setting('application_name', true), ''), 'none'),
    NEW.table_id, NEW.seat_number, NEW.stack
    USING ERRCODE = 'check_violation',
          HINT = 'The caller must debit a wallet or treasury and declare app.money_path, or be the engine.';
END;
$function$;
ALTER FUNCTION public.fn_ca_guard_seat_creation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_guard_seat_creation() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_guard_seat_creation()

-- @@DOOR fn_ca_legacy_fee_custody_cohort(p_tournament_id uuid)
-- @@PIN md5=1a0321e70d38708ff96db5fd6ebe0067 len=2170 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_legacy_fee_custody_cohort(p_tournament_id uuid)
 RETURNS TABLE(amount numeric, source_fingerprint text, source_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 SELECT o.amount,o.source_fingerprint,jsonb_array_length(o.original_fees)
   FROM public.accounting_tournament_fee_custody_obligations o
  WHERE o.tournament_id=p_tournament_id
 UNION ALL
 SELECT a.fee,a.fp,a.n FROM public.tournaments t
  JOIN LATERAL (SELECT sum(r.rake_amount) AS fee,
     md5(COALESCE(string_agg(public.fn_accounting_tournament_fee_fingerprint(r),':' ORDER BY r.id),'')) AS fp,
     count(*)::int AS n,
     bool_and(r.created_at<k.starts_at) AS all_pre,
     bool_and(r.terminal_closed_at IS NULL) AS none_closed,
     bool_or(EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b WHERE b.rake_record_id=r.id)) AS any_batched
    FROM public.rake_records r CROSS JOIN public.accounting_tournament_fee_cutover k
   WHERE r.tournament_id=t.id AND r.is_tournament AND k.singleton) a ON true
  WHERE t.id=p_tournament_id
    AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_obligations o WHERE o.tournament_id=t.id)
    AND a.n>0 AND a.fee>0 AND a.fee=round(a.fee,2)
    AND a.all_pre AND a.none_closed AND NOT a.any_batched
    AND t.satellite_target_id IS NULL AND t.satellite_target IS NULL
    AND lower(COALESCE(t.variant,''))<>'satellite'
    AND NOT public.fn_poker_diamond_tournament(t.id)
    AND NOT EXISTS(SELECT 1 FROM public.tournament_rake_settlements x WHERE x.tournament_id=t.id)
    AND NOT EXISTS(SELECT 1 FROM public.tournament_terminal_settlements x WHERE x.tournament_id=t.id)
    AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions x WHERE x.tournament_id=t.id)
    AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_recognized_sources x WHERE x.tournament_id=t.id)
    AND EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=t.id AND e.enforced
               AND e.fee_out=0 AND e.refund_fee=0 AND e.fee_balance=a.fee
               AND e.closed_at IS NULL AND e.terminal_closed_at IS NULL)
$function$;
ALTER FUNCTION public.fn_ca_legacy_fee_custody_cohort(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_custody_cohort(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_legacy_fee_custody_cohort(p_tournament_id uuid)

-- @@DOOR fn_ca_legacy_fee_custody_is_append_only()
-- @@PIN md5=4bc1c11e22a8ee54c63c36782b642831 len=283 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_legacy_fee_custody_is_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN RAISE EXCEPTION 'original fee custody obligations are append-only' USING ERRCODE='55000'; END $function$;
ALTER FUNCTION public.fn_ca_legacy_fee_custody_is_append_only() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_custody_is_append_only() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_legacy_fee_custody_is_append_only()

-- @@DOOR fn_ca_legacy_fee_custody_requires_terminal()
-- @@PIN md5=3f9a6541f8016270ba4faae97765e620 len=722 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_legacy_fee_custody_requires_terminal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tournament_terminal_settlements h
  WHERE h.tournament_id=NEW.tournament_id AND h.accounting_state='fee_custody_unresolved'
   AND h.receipt_version=3 AND h.rake_amount=NEW.amount AND h.rake_settled_at IS NULL
   AND h.rake_attributed_at IS NULL AND h.escrow_closed_at IS NULL)
 THEN RAISE EXCEPTION 'fee custody cannot commit without its exact player terminal receipt' USING ERRCODE='P0404'; END IF;
 PERFORM public.fn_ca_tournament_terminal_receipt(NEW.tournament_id,NULL);
 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_ca_legacy_fee_custody_requires_terminal() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_custody_requires_terminal() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_legacy_fee_custody_requires_terminal()

-- @@DOOR fn_ca_legacy_fee_resolution_requires_recognition()
-- @@PIN md5=5cacfa2b62b7ecbea69725a8486ae635 len=1424 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_legacy_fee_resolution_requires_recognition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE receipt jsonb;h public.tournament_terminal_settlements%ROWTYPE;
BEGIN
 receipt:=public.fn_accounting_tournament_terminal_fee_receipt(NEW.tournament_id);
 SELECT * INTO h FROM public.tournament_terminal_settlements WHERE tournament_id=NEW.tournament_id;
 IF receipt->>'status' IS DISTINCT FROM 'recognized'
  OR receipt->>'source_fingerprint' IS DISTINCT FROM NEW.source_fingerprint
  OR (receipt->>'bank_amount')::numeric IS DISTINCT FROM NEW.amount
  OR (receipt->>'banked_at')::timestamptz IS DISTINCT FROM NEW.resolved_at
  OR NOT EXISTS(SELECT 1 FROM public.tournament_rake_settlements s WHERE s.tournament_id=NEW.tournament_id
   AND s.amount=NEW.amount AND s.settled_at=NEW.resolved_at AND s.attributed_at=NEW.resolved_at
   AND s.attributed_users>0 AND s.attribution_error IS NULL AND s.terminal_closed_at=h.completed_at)
  OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=NEW.tournament_id
   AND e.prize_balance=0 AND e.bounty_balance=0 AND e.fee_balance=0)
 THEN RAISE EXCEPTION 'fee continuation cannot commit without exact original attribution and bank proof' USING ERRCODE='P0404'; END IF;
 PERFORM public.fn_ca_tournament_terminal_receipt(NEW.tournament_id,NULL);
 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_ca_legacy_fee_resolution_requires_recognition() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_resolution_requires_recognition() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_legacy_fee_resolution_requires_recognition()

-- @@DOOR fn_ca_legacy_fee_resolution_write_is_exact(p_table text, p_operation text, p_old jsonb, p_new jsonb)
-- @@PIN md5=0a123d50d4bd6d9364fdceb81c5cce8a len=6795 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_legacy_fee_resolution_write_is_exact(p_table text, p_operation text, p_old jsonb, p_new jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE t uuid:=NULLIF(p_new->>'tournament_id','')::uuid;r public.accounting_tournament_fee_custody_resolutions%ROWTYPE;
 o public.accounting_tournament_fee_custody_obligations%ROWTYPE;h public.tournament_terminal_settlements%ROWTYPE;
BEGIN
 -- The installed Union wallet autoledger identifies its source by the typed
 -- original prize liability and deliberately leaves tournament_id NULL.
 IF t IS NULL AND p_table='chip_ledger' AND p_operation='INSERT'
  AND p_new->>'from_type'='prize_liability'
  AND (public.fn_ca_sep8_spin_original_fee_proof(NULLIF(p_new->>'from_entity_id','')::uuid) IS NOT NULL
   OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_owner_bases ob
    WHERE ob.tournament_id=NULLIF(p_new->>'from_entity_id','')::uuid AND ob.transaction_id=txid_current())) THEN
  t:=NULLIF(p_new->>'from_entity_id','')::uuid;
 END IF;
 IF p_operation='DELETE' OR t IS NULL THEN RETURN false; END IF;
 SELECT * INTO r FROM public.accounting_tournament_fee_custody_resolutions WHERE tournament_id=t AND transaction_id=txid_current();
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO o FROM public.accounting_tournament_fee_custody_obligations WHERE id=r.obligation_id AND tournament_id=t;
 SELECT * INTO h FROM public.tournament_terminal_settlements WHERE tournament_id=t AND accounting_state='fee_custody_unresolved' AND receipt_version=3;
 IF o.id IS NULL OR h.tournament_id IS NULL OR r.amount IS DISTINCT FROM o.amount
  OR r.source_fingerprint IS DISTINCT FROM o.source_fingerprint
  OR r.original_plan IS DISTINCT FROM public.fn_accounting_tournament_fee_net_plan(t)
 THEN RETURN false; END IF;
 IF p_table='tournament_rake_settlements' THEN
  IF p_operation='INSERT' THEN
   RETURN (p_new->>'amount')::numeric=0 AND p_new->>'destination'='pending'
    AND p_new->>'settled_at' IS NULL AND p_new->>'attributed_at' IS NULL
    AND p_new->>'terminal_closed_at' IS NULL;
  END IF;
  RETURN p_operation='UPDATE' AND p_old->>'terminal_closed_at' IS NULL
   AND (p_old-ARRAY['amount','union_id','destination','settled_at','attributed_at','attributed_users','attribution_error'])
    IS NOT DISTINCT FROM (p_new-ARRAY['amount','union_id','destination','settled_at','attributed_at','attributed_users','attribution_error'])
   AND p_old->>'destination'='pending' AND (p_old->>'amount')::numeric=0
   AND (p_new->>'amount')::numeric=r.amount
   AND (p_new->>'settled_at')::timestamptz=r.resolved_at
   AND (p_new->>'attributed_at')::timestamptz=r.resolved_at
   AND (p_new->>'attributed_users')::integer>0
   AND p_new->>'attribution_error' IS NULL
   AND EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions q WHERE q.tournament_id=t
    AND q.status='recognized' AND q.net_rake=r.amount AND q.recognized_at=r.resolved_at
    AND q.source_fingerprint=r.source_fingerprint);
 ELSIF p_table='chip_ledger' THEN
  IF p_operation='INSERT' AND r.original_plan->>'union_id' IS NOT NULL
   AND (public.fn_ca_sep8_spin_original_fee_proof(t) IS NOT NULL
    OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_owner_bases ob WHERE ob.tournament_id=t
     AND ob.transaction_id=txid_current() AND ob.union_id=(r.original_plan->>'union_id')::uuid)) THEN
   RETURN p_new->>'from_type'='prize_liability' AND p_new->>'from_entity_id'=t::text
    AND (p_new->>'tournament_id' IS NULL OR p_new->>'tournament_id'=t::text)
    AND p_new->>'to_type'='union_wallet' AND p_new->>'to_label'='union_wallets.rake_wallet'
    AND p_new->>'union_id'=r.original_plan->>'union_id' AND p_new->>'category'='rake'
    AND (p_new->>'amount')::numeric=r.amount
    AND p_new->>'description'='auto-ledgered union_wallets.rake_wallet delta '||round(r.amount,2)::text
    AND p_new->>'from_label' IS NULL
    AND (p_new->>'club_id' IS NULL OR p_new->>'club_id'=(SELECT x.club_id::text FROM public.tournaments x WHERE x.id=t))
    AND p_new->>'table_id' IS NULL AND p_new->>'hand_id' IS NULL
    AND p_new->>'idempotency_key' IS NULL AND p_new->>'metadata' IS NULL
    AND p_new->>'pre_from_balance' IS NULL AND p_new->>'post_from_balance' IS NULL
    AND p_new->>'status'='posted' AND (p_new->>'created_at')::timestamptz=r.resolved_at
    AND (p_new->>'performed_by')::uuid=COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid)
    AND (p_new->>'pre_to_balance')::numeric>=0
    AND (p_new->>'post_to_balance')::numeric-(p_new->>'pre_to_balance')::numeric=r.amount
    AND EXISTS(SELECT 1 FROM public.union_wallets w WHERE w.id=(p_new->>'to_entity_id')::uuid
     AND w.union_id=(r.original_plan->>'union_id')::uuid
     AND w.rake_wallet=(p_new->>'post_to_balance')::numeric)
    AND EXISTS(SELECT 1 FROM public.tournament_rake_settlements s WHERE s.tournament_id=t
     AND s.destination='pending' AND s.amount=0 AND s.settled_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.from_type='prize_liability'
     AND l.from_entity_id=t AND l.to_type='union_wallet'
     AND (l.union_id=(r.original_plan->>'union_id')::uuid OR l.to_entity_id=(p_new->>'to_entity_id')::uuid));
  END IF;
  RETURN p_operation='INSERT' AND p_new->>'from_type'='prize_liability'
   AND p_new->>'from_entity_id'=t::text AND p_new->>'to_type'='chip_retirement'
   AND p_new->>'to_entity_id' IS NULL AND p_new->>'category'='burn'
   AND (p_new->>'amount')::numeric=r.amount AND r.original_plan->>'union_id' IS NULL
   AND p_new->>'description'='Standalone tournament fee retired (fn_settle_tournament_rake)';
 ELSIF p_table='tournament_escrow' THEN
  RETURN p_operation='UPDATE' AND (p_old->>'terminal_closed_at')::timestamptz=h.completed_at
   AND (p_old-ARRAY['fee_out','fee_balance','updated_at']) IS NOT DISTINCT FROM
       (p_new-ARRAY['fee_out','fee_balance','updated_at'])
   AND (p_old->>'prize_balance')::numeric=0 AND (p_old->>'bounty_balance')::numeric=0
   AND EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions q WHERE q.tournament_id=t
    AND q.status='recognized' AND q.net_rake=r.amount AND q.recognized_at=r.resolved_at
    AND q.source_fingerprint=r.source_fingerprint)
   AND (((p_old->>'fee_out')::numeric=(o.escrow_snapshot->>'fee_out')::numeric
      AND (p_new->>'fee_out')::numeric=(p_old->>'fee_out')::numeric+r.amount
      AND (p_old->>'fee_balance')::numeric=r.amount AND (p_new->>'fee_balance')::numeric=r.amount)
    OR ((p_old->>'fee_out')::numeric=(o.escrow_snapshot->>'fee_out')::numeric+r.amount
      AND (p_new->>'fee_out')::numeric=(p_old->>'fee_out')::numeric
      AND (p_old->>'fee_balance')::numeric=r.amount AND (p_new->>'fee_balance')::numeric=0));
 END IF;
 RETURN false;
END $function$;
ALTER FUNCTION public.fn_ca_legacy_fee_resolution_write_is_exact(p_table text, p_operation text, p_old jsonb, p_new jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_resolution_write_is_exact(p_table text, p_operation text, p_old jsonb, p_new jsonb) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_legacy_fee_resolution_write_is_exact(p_table text, p_operation text, p_old jsonb, p_new jsonb)

-- @@DOOR fn_ca_lock_tournament_seat_acquisition(p_tournament_id uuid, p_table_id uuid, p_user_id uuid)
-- @@PIN md5=367488e3f6ef4714b6c2bca3e8068065 len=3027 owner=postgres
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
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id, p_table_id);
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  PERFORM public.fn_ca_lock_mtt_admission_contract();

  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;

  -- DIAMOND PHASE 11: every seat's player takes the table-cap lock before the
  -- Daily Missions lock, which locks the player's profile row. Every cash seat
  -- door, chip and Diamond, takes table_cap first; for a Diamond player the
  -- profile row is the wallet, and one player's chip entry, Diamond entry and
  -- Diamond cash seat meet on these two locks, so the order is one for every
  -- event whatever its asset. The roster trigger's own table_cap is re-entrant.
  IF p_user_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));
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
$function$;
ALTER FUNCTION public.fn_ca_lock_tournament_seat_acquisition(p_tournament_id uuid, p_table_id uuid, p_user_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_lock_tournament_seat_acquisition(p_tournament_id uuid, p_table_id uuid, p_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_lock_tournament_seat_acquisition(p_tournament_id uuid, p_table_id uuid, p_user_id uuid)

-- @@DOOR fn_ca_mint(p_asset text, p_destination text, p_target_id uuid, p_amount numeric, p_reason text, p_op_id text, p_class text)
-- @@PIN md5=da9429ce6483c47c7d536582433a1edd len=11391 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_mint(p_asset text, p_destination text, p_target_id uuid, p_amount numeric, p_reason text, p_op_id text, p_class text DEFAULT 'admin'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_actor uuid := auth.uid();
  v_admin boolean := false;
  v_asset text := lower(btrim(COALESCE(p_asset, '')));
  v_dest  text := lower(btrim(COALESCE(p_destination, '')));
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_class text := lower(btrim(COALESCE(p_class, 'admin')));
  v_holder uuid;
  v_prior jsonb; v_before numeric; v_after numeric; v_label text;
  v_supply numeric; v_chip_id uuid; v_dia_id uuid; v_actorlb text; v_result jsonb;
  v_pol public.ca_mint_policy%ROWTYPE;
  v_cap numeric; v_roll numeric; v_24h numeric;
BEGIN
  -- The trigger door (2026-09-08, DIAMOND-RULINGS 17 / roadmap 1.3): handle_new_user and the
  -- other seeders fire inside a trigger owned by the database itself, where auth.role() is
  -- NULL. The database's own code may mint; a browser never reaches this branch because a
  -- SECURITY DEFINER trigger runs as the owner and a client session is never at depth > 0.
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT (pg_trigger_depth() > 0
              AND current_user IN ('postgres', 'supabase_admin', 'supabase_auth_admin')) THEN
    SELECT EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.id = v_actor AND p.role IN ('admin', 'god')) INTO v_admin;
    IF NOT v_admin THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'the_mint_is_admin_only');
    END IF;
  END IF;

  IF v_asset NOT IN ('chips', 'diamonds') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'asset_must_be_chips_or_diamonds');
  END IF;
  IF v_asset = 'chips' AND v_dest NOT IN ('club', 'union') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chips_are_issued_to_a_club_or_union_wallet_only');
  END IF;
  IF v_asset = 'diamonds' AND v_dest NOT IN ('player', 'house') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamonds_are_issued_to_a_player_or_to_the_house_only');
  END IF;
  -- The foundation's issuance_class list (diamond_transactions_issuance_class_chk).
  -- Recorded on the diamond journal row; carried but unused for chips, which have
  -- their own ledger.
  IF v_class NOT IN ('purchased', 'promotional', 'earned', 'transferred', 'seeded',
                     'refund', 'spend', 'bridge', 'deletion', 'admin', 'arena',
                     'house', 'unknown') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_issuance_class', 'class', v_class);
  END IF;
  IF v_asset = 'diamonds' AND v_dest = 'house' THEN
    IF p_target_id IS NOT NULL AND p_target_id <> c_house THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'the_house_target_is_the_house_sentinel_or_null');
    END IF;
  ELSIF p_target_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_required');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive_to_two_decimals');
  END IF;
  IF v_asset = 'diamonds' AND p_amount <> round(p_amount, 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamonds_are_whole_numbers');
  END IF;
  -- Kill switch (standard 3.4 layer 6, review D11): a human-opened diamond_issuance freeze
  -- refuses diamond minting until it is cleared. Burns and chips are untouched.
  IF v_asset = 'diamonds' AND EXISTS (SELECT 1 FROM public.ca_payout_freeze f
                                        WHERE f.scope = 'diamond_issuance' AND f.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_issuance_frozen');
  END IF;
  -- THE POLICY (ca_mint_policy): a per-operation cap and a rolling 24-hour
  -- ceiling, both refused here with a reason the operator can read, and
  -- refused again at commit by the constraint trigger for chips whatever the
  -- door. 24h issuance is read from the register with the advisory lock held
  -- below, so two operators cannot both fit under the ceiling at once.
  SELECT * INTO v_pol FROM public.ca_mint_policy WHERE id = 1;
  v_cap  := CASE WHEN v_asset = 'chips' THEN v_pol.per_operation_cap_chips ELSE v_pol.per_operation_cap_diamonds END;
  v_roll := CASE WHEN v_asset = 'chips' THEN v_pol.rolling_24h_cap_chips ELSE v_pol.rolling_24h_cap_diamonds END;
  IF p_amount > v_cap THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_over_the_single_mint_cap',
                              'cap', v_cap, 'requested', p_amount);
  END IF;
  IF length(v_reason) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'issuance_needs_a_real_reason');
  END IF;
  IF COALESCE(btrim(p_op_id), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'idempotency_key_required');
  END IF;

  SELECT result INTO v_prior FROM public.ca_op_claims
   WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';
  IF FOUND AND v_prior IS NOT NULL THEN
    RETURN v_prior || jsonb_build_object('replayed', true);
  ELSIF FOUND THEN
    DELETE FROM public.ca_op_claims WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';
  END IF;
  INSERT INTO public.ca_op_claims (op_id, fn_name, claimed_by)
  VALUES (p_op_id, 'fn_ca_mint', v_actor);

  PERFORM pg_advisory_xact_lock(hashtext('ca_mint_ledger:' || v_asset));

  v_24h := public.fn_ca_mint_issued_24h(v_asset) + p_amount;
  IF v_24h > v_roll THEN
    RETURN public.fn_ca_release_claim('fn_ca_mint', p_op_id,
             jsonb_build_object('ok', false, 'reason', 'over_the_rolling_24h_issuance_ceiling',
                              'ceiling', v_roll, 'issued_24h', v_24h - p_amount, 'requested', p_amount));
  END IF;

  IF v_asset = 'diamonds' THEN
    IF v_dest = 'house' THEN
      INSERT INTO public.ca_diamond_house (id, balance)
      VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
      SELECT COALESCE(balance, 0) INTO v_before
        FROM public.ca_diamond_house WHERE id = 1 FOR UPDATE;
      UPDATE public.ca_diamond_house
         SET balance = COALESCE(balance, 0) + p_amount, updated_at = now()
       WHERE id = 1 RETURNING balance INTO v_after;
      v_label  := 'the house';
      v_holder := c_house;
      -- No diamond_transactions row: that journal is keyed by a user (two FKs to
      -- auth.users and profiles) and the house is not one. ca_mint_ledger is the
      -- record of a house-side issuance.
    ELSE
      SELECT COALESCE(diamonds, 0), COALESCE(NULLIF(btrim(username), ''), full_name, id::text)
        INTO v_before, v_label FROM public.profiles WHERE id = p_target_id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN public.fn_ca_release_claim('fn_ca_mint', p_op_id,
                 jsonb_build_object('ok', false, 'reason', 'player_not_found'));
      END IF;
      UPDATE public.profiles SET diamonds = COALESCE(diamonds, 0) + p_amount
       WHERE id = p_target_id RETURNING diamonds INTO v_after;
      -- The op id is the journal reference (DR4: a credit carries its reference), so the earn
      -- ledger files a promotional mint under its engine by prefix (signup: -> signup).
      INSERT INTO public.diamond_transactions
        (user_id, type, transaction_type, amount, balance_after, description, source,
         metadata, counterparty, issuance_class, reference_id)
      VALUES (p_target_id, 'earn', 'mint', p_amount, v_after,
              'The Mint: ' || v_reason, 'the_mint',
              jsonb_build_object('minted_by', v_actor, 'op_id', p_op_id),
              'issuance', v_class, p_op_id)
      RETURNING id INTO v_dia_id;
      v_holder := p_target_id;
    END IF;
  ELSE
    -- The leg is declared WITH A KEY and found by that key: never by shape.
    PERFORM public.fn_ca_declare_ledger('mint', 'issuance_reserve', NULL, NULL, 'mint:' || p_op_id, NULL);
    IF v_dest = 'club' THEN
      SELECT COALESCE(chip_treasury, 0), name INTO v_before, v_label
        FROM public.clubs WHERE id = p_target_id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN public.fn_ca_release_claim('fn_ca_mint', p_op_id,
                 jsonb_build_object('ok', false, 'reason', 'club_not_found'));
      END IF;
      UPDATE public.clubs SET chip_treasury = COALESCE(chip_treasury, 0) + p_amount
       WHERE id = p_target_id RETURNING chip_treasury INTO v_after;
      INSERT INTO public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
      VALUES (p_target_id, v_actor, NULL, p_amount, 'treasury_mint',
              'The Mint: ' || v_reason, v_after);
    ELSE
      SELECT name INTO v_label FROM public.unions WHERE id = p_target_id;
      IF v_label IS NULL THEN
        RETURN public.fn_ca_release_claim('fn_ca_mint', p_op_id,
                 jsonb_build_object('ok', false, 'reason', 'union_not_found'));
      END IF;
      INSERT INTO public.union_wallets (union_id, created_at, updated_at)
      VALUES (p_target_id, now(), now()) ON CONFLICT (union_id) DO NOTHING;
      SELECT COALESCE(chip_balance, 0) INTO v_before
        FROM public.union_wallets WHERE union_id = p_target_id FOR UPDATE;
      UPDATE public.union_wallets
         SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = now()
       WHERE union_id = p_target_id RETURNING chip_balance INTO v_after;
    END IF;
    SELECT id INTO v_chip_id FROM public.chip_ledger WHERE idempotency_key = 'mint:' || p_op_id;
    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
    PERFORM set_config('app.ledger_idempotency_key', '', true);
    IF v_chip_id IS NULL THEN
      RAISE EXCEPTION 'fn_ca_mint: the balance moved but no journal leg was written for key mint:% - refusing to register an issuance the journal does not carry', p_op_id;
    END IF;
    v_holder := p_target_id;
  END IF;

  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) + p_amount
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = v_asset;
  SELECT COALESCE(NULLIF(btrim(username), ''), full_name, id::text)
    INTO v_actorlb FROM public.profiles WHERE id = v_actor;

  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason,
     performed_by, performed_by_label, chip_ledger_id, diamond_tx_id)
  VALUES
    (p_op_id, 'mint', v_asset, v_dest, v_holder, v_label, p_amount,
     v_before, v_after, v_supply, v_reason, v_actor, v_actorlb, v_chip_id, v_dia_id);

  v_result := jsonb_build_object(
    'ok', true, 'replayed', false, 'action', 'mint',
    'asset', v_asset, 'destination', v_dest, 'issuance_class', v_class,
    'target_id', v_holder, 'target_label', v_label, 'amount', p_amount,
    'balance_before', v_before, 'balance_after', v_after, 'supply_after', v_supply,
    'ledger_id', v_chip_id, 'issued_24h_after', v_24h, 'rolling_24h_cap', v_roll,
    'minted_by', v_actor, 'reason', v_reason, 'op_id', p_op_id);

  UPDATE public.ca_op_claims SET result = v_result, finalized_at = now()
   WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';

  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.fn_ca_mint(p_asset text, p_destination text, p_target_id uuid, p_amount numeric, p_reason text, p_op_id text, p_class text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_mint(p_asset text, p_destination text, p_target_id uuid, p_amount numeric, p_reason text, p_op_id text, p_class text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint(p_asset text, p_destination text, p_target_id uuid, p_amount numeric, p_reason text, p_op_id text, p_class text) TO service_role;
-- @@END fn_ca_mint(p_asset text, p_destination text, p_target_id uuid, p_amount numeric, p_reason text, p_op_id text, p_class text)

-- @@DOOR fn_ca_original_paid_stack_must_complete()
-- @@PIN md5=8e221724e453fe284280f1f72dedaa7d len=748 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_original_paid_stack_must_complete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tournament_paid_stack_custody_receipts r
 WHERE r.id=NEW.id AND r.state='seated' AND r.assignment->>'ok'='true'
 AND r.assignment->>'tournament_id'=r.tournament_id::text
 AND r.assignment->>'user_id'=r.user_id::text
 AND r.assignment->>'table_id'=r.destination_table_id::text
 AND (r.assignment->>'seat_number')::integer=r.destination_seat_number
 AND (r.assignment->>'stack')::numeric=r.grant_chips) THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_CUSTODY_INCOMPLETE' USING ERRCODE='55000';
 END IF;
 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_ca_original_paid_stack_must_complete() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_original_paid_stack_must_complete() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_original_paid_stack_must_complete()

-- @@DOOR fn_ca_process_tournament_chip_purchase_money_v1(p_tournament_id uuid, p_user_id uuid, p_rebuy_type text, p_cost numeric, p_chips numeric, p_current_level integer, p_client_token text)
-- @@PIN md5=9ff346ac60f760311d884c6d63d9001d len=14926 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_process_tournament_chip_purchase_money_v1(p_tournament_id uuid, p_user_id uuid, p_rebuy_type text, p_cost numeric, p_chips numeric, p_current_level integer, p_client_token text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_original_entitlement uuid; v_original_wallet uuid;
  v_t record;
  v_p record;
  v_unit integer := public.fn_ca_tournament_unit_cents(p_tournament_id);  -- DIAMOND PHASE 8
  v_dia jsonb;                                                              -- DIAMOND PHASE 8
  v_balance numeric;
  v_ratio numeric;
  v_is_bounty boolean;
  v_bounty_head numeric;
  v_base numeric;
  v_fee numeric;
  v_total numeric;
  v_add integer;
  v_new_chips integer;
  v_seat record;
  v_key text;
  v_inserted integer;
  v_cat text;
  v_club uuid;
  v_stack_after numeric;
  v_expected numeric;
  v_fee_ratio numeric;
  v_was_seated boolean:=false;
  v_rows integer;
  v_led_cat text;
  v_led_cp text;
  v_led_ent text;
  v_led_tid text;
BEGIN
  IF NOT (COALESCE(auth.role(),'service_role')='service_role')
     AND (auth.uid() IS NULL OR auth.uid()<>p_user_id) THEN
    RAISE EXCEPTION
      'process_tournament_rebuy: caller may only transact for themselves'
      USING ERRCODE='42501';
  END IF;
  IF p_rebuy_type NOT IN ('rebuy','reentry','addon') THEN
    RAISE EXCEPTION 'Invalid rebuy type: %',p_rebuy_type
      USING ERRCODE='22023';
  END IF;
  IF p_client_token IS NULL OR length(btrim(p_client_token))=0
     OR length(btrim(p_client_token))>128 THEN
    RAISE EXCEPTION 'exact tournament chip-purchase token is required'
      USING ERRCODE='22023';
  END IF;

  SELECT id,name,club_id,status,buy_in_amount,buy_in_fee,starting_chips,
         is_rebuy,is_reentry,add_on_available,addon_period_triggered,
         rebuy_cost,rebuy_chips,rebuy_levels,late_reg_levels,max_rebuys,
         max_reentries,addon_cost,addon_chips,addon_levels,current_level,
         prize_pool,is_bounty,is_pko,is_mystery_bounty,bounty_amount
    INTO v_t
    FROM public.tournaments
   WHERE id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
  END IF;
  IF v_t.status NOT IN ('RUNNING','REGISTERING','ANNOUNCED') THEN
    RAISE EXCEPTION 'Tournament is not accepting chip purchases (status %)',v_t.status;
  END IF;

  SELECT id,chips,status,prize,rebuys,add_on,table_id,club_id
    INTO v_p
    FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not registered in this tournament';
  END IF;
  IF v_p.status='eliminated' AND COALESCE(v_p.prize,0)>0 THEN
    RAISE EXCEPTION
      'Finishing Place Already Paid - A Rebuy Cannot Resurrect A Settled Result';
  END IF;
  v_club:=v_p.club_id;
  IF v_club IS NULL THEN
    RAISE EXCEPTION
      'Tournament entry funding club is missing; refusing a substituted wallet'
      USING ERRCODE='P0404';
  END IF;

  v_cat:=CASE WHEN p_rebuy_type='addon' THEN 'addon' ELSE 'rebuy' END;
  v_key:=CASE WHEN p_rebuy_type='addon'
    THEN 'tourney:'||p_tournament_id::text||':addon:'||p_user_id::text
    ELSE 'tourney:'||p_tournament_id::text||':'||p_rebuy_type||':'||
         p_user_id::text||':tok:'||btrim(p_client_token)
  END;

  IF p_rebuy_type='addon' THEN
    PERFORM 1
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE s.user_id=p_user_id AND s.left_at IS NULL
       AND tb.tournament_id=p_tournament_id
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'No Live Seat For This % - Aborting So No Charge Is Made',p_rebuy_type;
    END IF;
    IF NOT COALESCE(v_t.add_on_available,false) THEN
      RAISE EXCEPTION 'Add-ons are not offered in this tournament';
    END IF;
    IF COALESCE(v_p.add_on,false) THEN
      RAISE EXCEPTION 'Add-on already taken';
    END IF;
    v_base:=COALESCE(NULLIF(v_t.addon_cost,0),v_t.buy_in_amount,0);
    v_add:=COALESCE(NULLIF(v_t.addon_chips,0),v_t.starting_chips,0)::integer;
  ELSE
    IF p_rebuy_type='rebuy' AND NOT COALESCE(v_t.is_rebuy,false) THEN
      RAISE EXCEPTION 'Rebuys are not offered in this tournament';
    END IF;
    IF p_rebuy_type='reentry' AND NOT COALESCE(v_t.is_reentry,false) THEN
      RAISE EXCEPTION 'Re-entries are not offered in this tournament';
    END IF;
    IF p_rebuy_type='rebuy' AND v_t.max_rebuys IS NOT NULL
       AND COALESCE(v_p.rebuys,0)>=v_t.max_rebuys THEN
      RAISE EXCEPTION 'Rebuy limit reached (% of %)',v_p.rebuys,v_t.max_rebuys;
    END IF;
    IF p_rebuy_type='reentry' AND v_t.max_reentries IS NOT NULL
       AND COALESCE(v_p.rebuys,0)>=v_t.max_reentries THEN
      RAISE EXCEPTION
        'Re-entry limit reached (% of %)',v_p.rebuys,v_t.max_reentries;
    END IF;
    IF p_rebuy_type='rebuy'
       AND COALESCE(v_p.chips,0)>COALESCE(v_t.starting_chips,0) THEN
      RAISE EXCEPTION 'Stack too high for a rebuy';
    END IF;
    /* CONSERVATION (a) 2026-09-11. A re-entry REPLACES the seat stack below
       (stack = v_add) while the roster gains rebuys + 1, so the conservation
       check's expected side gains rebuy_chips at the same moment. Taken while
       the entry still holds chips, that destroys them AND inflates expected.
       A re-entry follows a bust, so the live population for this is zero; it
       is refused rather than left to silently unbalance the event. */
    IF p_rebuy_type='reentry' AND COALESCE(v_p.chips,0)>0 THEN
      RAISE EXCEPTION
        'A Re-Entry Starts A New Stack And This Entry Still Holds % Chips - Aborting So No Charge Is Made',
        v_p.chips
        USING ERRCODE='55000';
    END IF;
    v_base:=COALESCE(NULLIF(v_t.rebuy_cost,0),v_t.buy_in_amount,0);
    v_add:=COALESCE(NULLIF(v_t.rebuy_chips,0),v_t.starting_chips,0)::integer;
  END IF;

  v_fee_ratio:=public.fn_ca_tournament_fee_ratio(
    v_t.buy_in_amount,v_t.buy_in_fee);
  v_ratio:=CASE WHEN p_rebuy_type='addon' THEN 0 ELSE v_fee_ratio END;
  v_total:=round(v_base::numeric);
  v_fee:=CASE WHEN v_ratio>0 AND v_total>0
    THEN public.fn_ca_recovery_fee_cents(
           round(v_total*100)::bigint,v_ratio,
           public.fn_ca_tournament_unit_cents(p_tournament_id))::numeric/100    ELSE 0
  END;
  v_base:=round(v_total-v_fee,2);
  v_is_bounty:=COALESCE(v_t.is_bounty,false)
    OR COALESCE(v_t.is_pko,false)
    OR COALESCE(v_t.is_mystery_bounty,false);
  IF v_is_bounty AND p_rebuy_type<>'addon' THEN
    v_bounty_head:=public.fn_ca_unit_floor_cents(
      round(LEAST(GREATEST(0,round(COALESCE(v_t.bounty_amount,0),2)),
                  v_base)*100)::bigint,
      public.fn_ca_tournament_unit_cents(p_tournament_id))::numeric/100;
    v_base:=v_base-v_bounty_head;
  ELSE
    v_bounty_head:=0;
  END IF;
  IF p_cost IS NOT NULL AND abs(p_cost-v_total)>0.01 THEN
    RAISE EXCEPTION
      'Price mismatch: client quoted %, server computed %',p_cost,v_total
      USING ERRCODE='22023';
  END IF;
  IF v_add<=0 OR v_total<0 OR v_fee<0 OR v_base<0 OR v_bounty_head<0
     OR round(v_base+v_bounty_head+v_fee,2)<>round(v_total,2) THEN
    RAISE EXCEPTION 'Tournament chip-purchase quote does not conserve'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
  VALUES(v_key,p_user_id,v_total)
  ON CONFLICT(key) DO NOTHING;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  IF v_inserted=0 THEN
    RETURN jsonb_build_object(
      'success',true,'idempotent',true,'new_stack',v_p.chips,
      'rebuy_type',p_rebuy_type);
  END IF;

  IF v_unit = 100 THEN
    -- DIAMOND PHASE 8: the purchase reserves settled Diamonds into the entry's
    -- custody row. The chip-wallet debit below is the chip estate's.
    v_dia := public.fn_poker_diamond_tournament_charge(
      p_user_id, p_tournament_id, p_rebuy_type, v_total, v_base, v_bounty_head, v_fee, v_p.id, v_key);
    v_balance := 0;
  ELSE
  PERFORM public.fn_ensure_club_wallet(p_user_id,v_club);
  SELECT chip_balance INTO v_balance
    FROM public.club_members
   WHERE user_id=p_user_id AND club_id=v_club
   FOR UPDATE;
  IF v_balance IS NULL OR v_balance<v_total THEN
    RAISE EXCEPTION 'Insufficient club chips: need %, have %',
      v_total,COALESCE(v_balance,0);
  END IF;

  v_led_cat:=current_setting('app.ledger_category',true);
  v_led_cp:=current_setting('app.ledger_counterparty',true);
  v_led_ent:=current_setting('app.ledger_counterparty_entity',true);
  v_led_tid:=current_setting('app.ledger_tournament',true);
  PERFORM set_config('app.ledger_category',v_cat,true);
  PERFORM set_config('app.ledger_counterparty','prize_liability',true);
  PERFORM set_config(
    'app.ledger_counterparty_entity',p_tournament_id::text,true);
  PERFORM set_config('app.ledger_tournament',p_tournament_id::text,true);
  PERFORM set_config('app.pnl_tournament_entitlement','',true);
  UPDATE public.club_members
     SET chip_balance=chip_balance-v_total,updated_at=now()
   WHERE user_id=p_user_id AND club_id=v_club;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  v_original_entitlement:=NULLIF(current_setting('app.pnl_tournament_entitlement',true),'')::uuid;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'Exact tournament funding wallet changed during debit'
      USING ERRCODE='40001';
  END IF;
  END IF; -- DIAMOND PHASE 8: end of the chip-wallet branch
  PERFORM set_config('app.ledger_category',COALESCE(v_led_cat,''),true);
  PERFORM set_config('app.ledger_counterparty',COALESCE(v_led_cp,''),true);
  PERFORM set_config(
    'app.ledger_counterparty_entity',COALESCE(v_led_ent,''),true);
  PERFORM set_config('app.ledger_tournament',COALESCE(v_led_tid,''),true);

  IF p_rebuy_type='reentry' THEN
    UPDATE public.tournament_players
       SET chips=v_add,status='playing',eliminated_at=NULL,position=NULL,
           rebuys=COALESCE(rebuys,0)+1
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  ELSIF p_rebuy_type='addon' THEN
    UPDATE public.tournament_players
       SET chips=COALESCE(chips,0)+v_add,add_on=true
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  ELSE
    UPDATE public.tournament_players
       SET chips=COALESCE(chips,0)+v_add,status='playing',
           eliminated_at=NULL,position=NULL,
           rebuys=COALESCE(rebuys,0)+1
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  END IF;
  IF v_new_chips IS NULL THEN
    RAISE EXCEPTION 'Locked tournament roster changed during chip grant'
      USING ERRCODE='40001';
  END IF;

  IF v_bounty_head>0 THEN
    UPDATE public.tournament_players
       SET current_bounty=CASE WHEN p_rebuy_type='reentry'
         THEN v_bounty_head
         ELSE COALESCE(current_bounty,0)+v_bounty_head END
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id;
  END IF;

  SELECT s.id,s.stack INTO v_seat
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE s.user_id=p_user_id AND s.left_at IS NULL
     AND tb.tournament_id=p_tournament_id
   ORDER BY (tb.status IS DISTINCT FROM 'closed') DESC,
            s.joined_at DESC NULLS LAST,s.id DESC
   LIMIT 1;
  IF FOUND THEN
    v_was_seated:=true;
    v_expected:=CASE WHEN p_rebuy_type='reentry'
      THEN v_add ELSE COALESCE(v_seat.stack,0)+v_add END;
    /* CONSERVATION (b) 2026-09-11. The roster above has already booked this
       purchase, so the supply this is measured against already contains the
       chips being bought. The felt must land inside it. An event that is
       already over its cap keeps playing; it may not get further over.
       See ca_drift_incidents 8b8fe26c and this migration's header. */
    PERFORM public.fn_ca_assert_tournament_chip_grant(
      p_tournament_id,p_user_id,v_seat.id,v_expected,
      'tournament '||p_rebuy_type);
    UPDATE public.table_seats
       SET stack=CASE WHEN p_rebuy_type='reentry'
         THEN v_add ELSE COALESCE(stack,0)+v_add END
     WHERE id=v_seat.id
     RETURNING stack INTO v_stack_after;
    IF v_stack_after IS NULL OR v_stack_after<>v_expected THEN
      RAISE EXCEPTION
        'Chip Grant Did Not Land: % Expected Stack %, Seat % Holds % - Aborting So No Charge Is Made',
        p_rebuy_type,v_expected,v_seat.id,v_stack_after;
    END IF;
    UPDATE public.tournament_players
       SET chips=(SELECT stack FROM public.table_seats WHERE id=v_seat.id)::integer
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  ELSIF p_rebuy_type='addon' THEN
    RAISE EXCEPTION
      'Seat Disappeared During % - Aborting So No Charge Is Made',p_rebuy_type;
  END IF;

  UPDATE public.tournaments
     SET prize_pool=COALESCE(prize_pool,0)+v_base,
         bounty_pool=COALESCE(bounty_pool,0)+v_bounty_head
   WHERE id=p_tournament_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'Tournament vanished during chip-purchase pool booking'
      USING ERRCODE='40001';
  END IF;

  IF v_fee>0 AND v_t.club_id IS NOT NULL AND v_unit = 100 THEN
    -- DIAMOND PHASE 8: the fee stays in custody until the event settles.
    UPDATE public.tournaments
       SET total_rake=COALESCE(total_rake,0)+v_fee
     WHERE id=p_tournament_id;
  ELSIF v_fee>0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records(
      hand_id,table_id,club_id,rake_amount,pot_size,num_players,
      bbj_contribution,is_tournament,tournament_id,source,metadata)
    VALUES(
      NULL,NULL,v_t.club_id,v_fee,v_fee,1,0,true,p_tournament_id,
      'process_tournament_rebuy',jsonb_build_object(
        'kind','tournament_'||p_rebuy_type||'_fee','user_id',p_user_id,
        'entry_club_id',v_club));
    UPDATE public.tournaments
       SET total_rake=COALESCE(total_rake,0)+v_fee
     WHERE id=p_tournament_id;
  END IF;

  IF v_unit = 1 THEN -- DIAMOND PHASE 8: wallet_transactions is the chip receipt
  INSERT INTO public.wallet_transactions(
    user_id,wallet_type,type,amount,category,description,
    related_entity_id,balance_after)
  VALUES(
    p_user_id,'PLAYER','debit',v_total,v_cat,
    'Tournament '||p_rebuy_type||': '||COALESCE(v_t.name,'tournament')||
      ' ('||v_base||' prize + '||v_bounty_head||' bounty + '||v_fee||
      ' fee) [club wallet]',
    p_tournament_id,v_balance-v_total) RETURNING id INTO v_original_wallet;
  END IF; -- DIAMOND PHASE 8

  PERFORM public.fn_ca_record_tournament_participant_funding(v_p.id,p_rebuy_type,v_key,
    v_total,CASE WHEN v_unit=100 THEN 'diamonds' ELSE 'chips' END,
    v_original_entitlement,v_original_wallet,v_dia);

  RETURN jsonb_build_object(
    'success',true,'new_stack',v_new_chips,'rebuy_type',p_rebuy_type,
    'chips_added',v_add,'cost',v_total,'fee',v_fee,'seated',v_was_seated,
    'bounty_head_funded',v_bounty_head);
END;
$function$;
ALTER FUNCTION public.fn_ca_process_tournament_chip_purchase_money_v1(p_tournament_id uuid, p_user_id uuid, p_rebuy_type text, p_cost numeric, p_chips numeric, p_current_level integer, p_client_token text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_process_tournament_chip_purchase_money_v1(p_tournament_id uuid, p_user_id uuid, p_rebuy_type text, p_cost numeric, p_chips numeric, p_current_level integer, p_client_token text) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_process_tournament_chip_purchase_money_v1(p_tournament_id uuid, p_user_id uuid, p_rebuy_type text, p_cost numeric, p_chips numeric, p_current_level integer, p_client_token text)

-- @@DOOR fn_ca_release_claim(p_fn text, p_op_id text, p_refusal jsonb)
-- @@PIN md5=e73b9eb40be251ea88e8be7ee8cf1985 len=560 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_release_claim(p_fn text, p_op_id text, p_refusal jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Only ever an UNFINALIZED claim. A finalized row carries the result the
  -- door already returned once and every later call replays it; deleting one
  -- would turn a replay back into a second live operation.
  DELETE FROM public.ca_op_claims
   WHERE op_id = p_op_id AND fn_name = p_fn AND finalized_at IS NULL;
  RETURN p_refusal;
END
$function$;
ALTER FUNCTION public.fn_ca_release_claim(p_fn text, p_op_id text, p_refusal jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_release_claim(p_fn text, p_op_id text, p_refusal jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_release_claim(p_fn text, p_op_id text, p_refusal jsonb) TO service_role;
-- @@END fn_ca_release_claim(p_fn text, p_op_id text, p_refusal jsonb)

-- @@DOOR fn_ca_sep8_spin_original_fee_proof(p_tournament_id uuid)
-- @@PIN md5=3224402eb784a60fbbc129135df632fb len=8482 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE c record;r public.rake_records%ROWTYPE;t public.tournaments%ROWTYPE;
 v public.managed_game_contract_versions%ROWTYPE;tp record;e record;l record;s record;
 item record;n integer;gross numeric:=0;earliest timestamptz;rows jsonb:='[]';versions jsonb:='[]';
 reserve jsonb;game_union uuid;reserve_account uuid;
BEGIN
 IF p_tournament_id NOT IN (
 '199a71a9-f364-4e90-a3ba-3cdcfb7755bc'::uuid,'808ef798-0942-4ce0-9ae1-eeefaaf4b0a9',
 'b60c7add-6b38-4549-b091-601f64d118a0','e3f4e2ab-8397-43e8-8643-6cec3fff3a63',
 'f3f050f1-569e-4fb6-859f-86b6092e682e') THEN RETURN NULL; END IF;
 SELECT * INTO c FROM public.fn_ca_legacy_fee_custody_cohort(p_tournament_id);
 SELECT count(*) INTO n FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament;
 SELECT * INTO r FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament;
 SELECT * INTO t FROM public.tournaments WHERE id=p_tournament_id;
 IF n<>1 OR c.source_count IS DISTINCT FROM 1 OR r.source IS DISTINCT FROM 'fn_spin_book_entry'
  OR r.rake_amount IS DISTINCT FROM c.amount OR md5(public.fn_accounting_tournament_fee_fingerprint(r)) IS DISTINCT FROM c.source_fingerprint
  OR r.created_at>='2026-09-17T18:24:02.831517Z'::timestamptz OR r.hand_id IS NOT NULL
  OR r.metadata->>'kind' IS DISTINCT FROM 'spin_rake' OR jsonb_typeof(r.player_contributions) IS DISTINCT FROM 'object'
  OR t.is_private IS DISTINCT FROM false OR t.variant IS DISTINCT FROM 'spin' OR t.tournament_type IS DISTINCT FROM 'SPIN'
  OR public.fn_poker_diamond_tournament(p_tournament_id)
 THEN RAISE EXCEPTION 'named Spin original aggregate identity missing' USING ERRCODE='P0404'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(r.player_contributions))<>3
  OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament_id)<>3
  OR (SELECT count(DISTINCT value::numeric) FROM jsonb_each_text(r.player_contributions))<>1
 THEN RAISE EXCEPTION 'named Spin requires exactly three equal original paid contributors' USING ERRCODE='P0404'; END IF;
 FOR item IN SELECT key::uuid player_id,value::numeric weight FROM jsonb_each_text(r.player_contributions) ORDER BY key LOOP
  SELECT * INTO tp FROM public.tournament_players WHERE tournament_id=p_tournament_id AND user_id=item.player_id;
  SELECT count(*) INTO n FROM public.tournament_refund_entitlements x WHERE x.tournament_id=p_tournament_id
   AND x.user_id=item.player_id AND x.entitlement_kind='wallet_charge' AND x.charge_category='tournament_buyin'
   AND x.created_at=tp.registered_at AND x.gross=item.weight;
  IF n<>1 THEN RAISE EXCEPTION 'named Spin original paid entry ambiguous' USING ERRCODE='P0404'; END IF;
  SELECT * INTO e FROM public.tournament_refund_entitlements x WHERE x.tournament_id=p_tournament_id
   AND x.user_id=item.player_id AND x.entitlement_kind='wallet_charge' AND x.charge_category='tournament_buyin'
   AND x.created_at=tp.registered_at AND x.gross=item.weight;
  SELECT * INTO l FROM public.chip_ledger WHERE id=e.source_ledger_id;
  IF l.id IS NULL OR tp.club_id IS DISTINCT FROM e.refund_wallet_club_id OR l.created_at IS DISTINCT FROM e.created_at
   OR e.created_at>r.created_at OR l.amount IS DISTINCT FROM e.gross OR l.club_id IS DISTINCT FROM e.refund_wallet_club_id
   OR l.from_type IS DISTINCT FROM 'player_wallet' OR l.from_entity_id IS DISTINCT FROM item.player_id
   OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM p_tournament_id
   OR l.category IS DISTINCT FROM 'tournament_buyin' OR item.weight<=0
  THEN RAISE EXCEPTION 'named Spin original debit evidence disagrees' USING ERRCODE='P0404'; END IF;
  earliest:=least(earliest,e.created_at);gross:=gross+item.weight;
  rows:=rows||jsonb_build_array(jsonb_build_object('registration_id',tp.id,'player_id',item.player_id,
   'club_id',tp.club_id,'registered_at',tp.registered_at,'entitlement',to_jsonb(e)-'terminal_closed_at','ledger',to_jsonb(l)));
 END LOOP;
 SELECT count(*) INTO n FROM public.spin_reserve_ledger WHERE tournament_id=p_tournament_id AND kind='contribution';
 SELECT * INTO s FROM public.spin_reserve_ledger WHERE tournament_id=p_tournament_id AND kind='contribution';
 IF n<>1 OR s.seats IS DISTINCT FROM 3 OR s.house_rake IS DISTINCT FROM r.rake_amount
  OR s.amount IS DISTINCT FROM gross-r.rake_amount OR s.buy_in IS DISTINCT FROM gross/3
 THEN RAISE EXCEPTION 'named Spin original reserve contribution disagrees' USING ERRCODE='P0404'; END IF;
 reserve:=jsonb_build_object('contribution',to_jsonb(s)-'terminal_closed_at');
 SELECT count(*) INTO n FROM public.chip_ledger x WHERE x.tournament_id=p_tournament_id AND x.category='spin_entry';
 SELECT * INTO l FROM public.chip_ledger x WHERE x.tournament_id=p_tournament_id AND x.category='spin_entry';
 IF n<>1 OR l.amount IS DISTINCT FROM s.amount OR l.created_at IS DISTINCT FROM s.created_at
  OR l.club_id IS DISTINCT FROM s.club_id OR l.from_type IS DISTINCT FROM 'prize_liability'
  OR l.from_entity_id IS DISTINCT FROM p_tournament_id OR l.to_type IS DISTINCT FROM 'spin_reserve' OR l.to_entity_id IS NULL
 THEN RAISE EXCEPTION 'named Spin reserve contribution debit disagrees' USING ERRCODE='P0404'; END IF;
 reserve_account:=l.to_entity_id;reserve:=reserve||jsonb_build_object('contribution_ledger',to_jsonb(l));
 SELECT count(*) INTO n FROM public.spin_reserve_ledger WHERE tournament_id=p_tournament_id AND kind='jackpot_draw';
 SELECT * INTO s FROM public.spin_reserve_ledger WHERE tournament_id=p_tournament_id AND kind='jackpot_draw';
 IF n<>1 OR s.seats IS DISTINCT FROM 3 OR s.house_rake IS DISTINCT FROM r.rake_amount
  OR s.amount IS DISTINCT FROM -t.prize_pool OR s.buy_in IS DISTINCT FROM gross/3 OR s.amount>=0
 THEN RAISE EXCEPTION 'named Spin original prize draw disagrees' USING ERRCODE='P0404'; END IF;
 reserve:=reserve||jsonb_build_object('draw',to_jsonb(s)-'terminal_closed_at');
 SELECT count(*) INTO n FROM public.chip_ledger x WHERE x.tournament_id=p_tournament_id AND x.category='spin_prize';
 SELECT * INTO l FROM public.chip_ledger x WHERE x.tournament_id=p_tournament_id AND x.category='spin_prize';
 IF n<>1 OR l.amount IS DISTINCT FROM -s.amount OR l.created_at IS DISTINCT FROM s.created_at
  OR l.club_id IS DISTINCT FROM s.club_id OR l.from_type IS DISTINCT FROM 'spin_reserve'
  OR l.from_entity_id IS DISTINCT FROM reserve_account OR l.to_type IS DISTINCT FROM 'prize_liability'
  OR l.to_entity_id IS DISTINCT FROM p_tournament_id
 THEN RAISE EXCEPTION 'named Spin original prize draw credit disagrees' USING ERRCODE='P0404'; END IF;
 reserve:=reserve||jsonb_build_object('draw_ledger',to_jsonb(l));
 SELECT * INTO v FROM public.managed_game_contract_versions WHERE game_id=p_tournament_id AND game_kind='tournament' AND version=1;
 IF NOT FOUND OR v.published_at>earliest OR v.club_id IS DISTINCT FROM r.club_id
  OR v.club_id IS DISTINCT FROM t.club_id OR v.union_id IS DISTINCT FROM t.union_id
 THEN RAISE EXCEPTION 'named Spin original created scope missing' USING ERRCODE='P0404'; END IF;
 game_union:=v.union_id;
 FOR v IN SELECT * FROM public.managed_game_contract_versions WHERE game_id=p_tournament_id AND game_kind='tournament'
  AND published_at<=r.created_at ORDER BY version,id LOOP
  IF v.club_id IS DISTINCT FROM t.club_id OR v.union_id IS DISTINCT FROM game_union
   OR v.contract->>'id' IS DISTINCT FROM p_tournament_id::text OR v.contract->>'club_id' IS DISTINCT FROM v.club_id::text
   OR NULLIF(v.contract->>'union_id','')::uuid IS DISTINCT FROM game_union OR v.contract->'is_private' IS DISTINCT FROM 'false'::jsonb
   OR v.contract->>'variant' IS DISTINCT FROM 'spin' OR v.contract->>'tournament_type' IS DISTINCT FROM 'SPIN'
   OR (v.contract->>'buy_in_amount')::numeric IS DISTINCT FROM gross/3 OR (v.contract->>'max_players')::integer IS DISTINCT FROM 3
   OR v.contract_hash IS DISTINCT FROM public.fn_managed_game_contract_hash(v.contract)
  THEN RAISE EXCEPTION 'named Spin immutable economic scope disagrees' USING ERRCODE='P0404'; END IF;
  versions:=versions||jsonb_build_array(to_jsonb(v));
 END LOOP;
 RETURN jsonb_build_object('tournament_id',p_tournament_id,'raw_source_count',1,'recognized_contributors',3,
  'source_fingerprint',c.source_fingerprint,'fee',c.amount,'gross',gross,'contributors',rows,'reserve',reserve,'scope_versions',versions);
END $function$;
ALTER FUNCTION public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_sep8_spin_original_fee_proof(p_tournament_id uuid)

-- @@DOOR fn_ca_tournament_accounting_evidence_immutable()
-- @@PIN md5=9bcc5b1f5fc9b9c036b617c36473d290 len=287 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_accounting_evidence_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN RAISE EXCEPTION 'Original tournament accounting evidence is immutable' USING ERRCODE='55000'; END
$function$;
ALTER FUNCTION public.fn_ca_tournament_accounting_evidence_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_accounting_evidence_immutable() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_tournament_accounting_evidence_immutable()

-- @@DOOR fn_ca_tournament_bust_at(p_tournament_id uuid, p_user_id uuid)
-- @@PIN md5=e15bc842a96da68626db64b2b5dcbd9e len=1565 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_bust_at(p_tournament_id uuid, p_user_id uuid)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(a.committed_at,
                  (SELECT min(g.created_at)
                     FROM public.tournament_knockout_candidates g
                    WHERE g.tournament_id = c.tournament_id
                      AND g.table_id = c.table_id
                      AND g.hand_number = c.hand_number
                      AND g.hand_id = c.hand_id))
         + (SELECT count(*)
              FROM public.tournament_knockout_candidates s
             WHERE s.tournament_id = c.tournament_id
               AND s.table_id = c.table_id
               AND s.hand_number = c.hand_number
               AND s.hand_id = c.hand_id
               AND (s.stack_before, s.eliminated_user_id)
                   < (c.stack_before, c.eliminated_user_id))::integer
           * interval '1 microsecond'
    FROM (SELECT k.tournament_id, k.table_id, k.hand_number,
                 k.hand_id, k.stack_before, k.eliminated_user_id
            FROM public.tournament_knockout_candidates k
           WHERE k.tournament_id = p_tournament_id
             AND k.eliminated_user_id = p_user_id
             AND k.state = 'eliminated'
           ORDER BY k.hand_number DESC, k.id DESC
           LIMIT 1) c
    LEFT JOIN public.hand_atomic_commits a
      ON a.table_id = c.table_id
     AND a.hand_number = c.hand_number
     AND a.hand_id = c.hand_id
$function$;
ALTER FUNCTION public.fn_ca_tournament_bust_at(p_tournament_id uuid, p_user_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_bust_at(p_tournament_id uuid, p_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_bust_at(p_tournament_id uuid, p_user_id uuid) TO service_role;
-- @@END fn_ca_tournament_bust_at(p_tournament_id uuid, p_user_id uuid)

-- @@DOOR fn_ca_tournament_chip_supply(p_tournament_id uuid)
-- @@PIN md5=c29dfa4a0ebef95fddeb8a0982ef07e1 len=916 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_chip_supply(p_tournament_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(r.entrants,0)*COALESCE(t.starting_chips,0)
       + COALESCE(r.rebuys,0)
         *COALESCE(NULLIF(t.rebuy_chips,0),t.starting_chips,0)
       + COALESCE(r.addons,0)
         *COALESCE(NULLIF(t.addon_chips,0),t.starting_chips,0)
       + COALESCE(a.chips,0)
    FROM public.tournaments t
    LEFT JOIN LATERAL (
      SELECT count(*) AS entrants,
             COALESCE(sum(GREATEST(COALESCE(tp.rebuys,0),0)),0) AS rebuys,
             count(*) FILTER (WHERE tp.add_on) AS addons
        FROM public.tournament_players tp
       WHERE tp.tournament_id=t.id
    ) r ON true
    LEFT JOIN public.tournament_felt_supply_acknowledgements a
           ON a.tournament_id = t.id
   WHERE t.id=p_tournament_id;
$function$;
ALTER FUNCTION public.fn_ca_tournament_chip_supply(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_chip_supply(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_chip_supply(p_tournament_id uuid) TO service_role;
-- @@END fn_ca_tournament_chip_supply(p_tournament_id uuid)

-- @@DOOR fn_ca_tournament_fee_custody_receipt(p_tournament_id uuid)
-- @@PIN md5=5bde7ab09e8fe7da8dd11cc9e581e504 len=4554 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_fee_custody_receipt(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE o public.accounting_tournament_fee_custody_obligations%ROWTYPE;
 e public.tournament_escrow%ROWTYPE;c record;fp text;net numeric;n integer;fees jsonb;resolution jsonb;resolved boolean:=false;funding jsonb;scope jsonb;
BEGIN
 SELECT * INTO o FROM public.accounting_tournament_fee_custody_obligations WHERE tournament_id=p_tournament_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO c FROM public.fn_ca_legacy_fee_custody_cohort(p_tournament_id);
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions x WHERE x.tournament_id=p_tournament_id) THEN
  IF NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions x WHERE x.tournament_id=p_tournament_id AND x.status='recognized') THEN
   RAISE EXCEPTION 'fee custody resolution has no canonical recognition' USING ERRCODE='P0404'; END IF;
  resolution:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  IF NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions x
   WHERE x.tournament_id=p_tournament_id AND x.obligation_id=o.id AND x.amount=o.amount
    AND x.source_fingerprint=o.source_fingerprint AND (resolution->>'bank_amount')::numeric=x.amount
    AND (resolution->>'banked_at')::timestamptz=x.resolved_at AND resolution->>'status'='recognized') THEN
   RAISE EXCEPTION 'fee custody resolution has no exact original bank proof' USING ERRCODE='P0404'; END IF;
  resolved:=true;
 END IF;
 SELECT md5(COALESCE(string_agg(public.fn_accounting_tournament_fee_fingerprint(r),':' ORDER BY r.id),'')),
  COALESCE(sum(r.rake_amount),0),count(*),jsonb_agg(to_jsonb(r)-'terminal_closed_at' ORDER BY r.id)
 INTO fp,net,n,fees FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
 SELECT * INTO e FROM public.tournament_escrow WHERE tournament_id=p_tournament_id;
 SELECT COALESCE(jsonb_agg(to_jsonb(x)-'terminal_closed_at' ORDER BY x.id),'[]'::jsonb) INTO funding
  FROM public.tournament_refund_entitlements x WHERE x.tournament_id=p_tournament_id;
 SELECT jsonb_build_object('club_id',t.club_id,'union_id',t.union_id,'is_private',t.is_private,'tournament_type',t.tournament_type)||CASE WHEN public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id) IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('spin_original',public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id)) END
  INTO scope FROM public.tournaments t WHERE t.id=p_tournament_id;
 IF c.amount IS NULL OR o.amount IS DISTINCT FROM c.amount OR net IS DISTINCT FROM c.amount
  OR fp IS DISTINCT FROM c.source_fingerprint OR fp IS DISTINCT FROM o.source_fingerprint
  OR n IS DISTINCT FROM c.source_count OR fees IS DISTINCT FROM o.original_fees
  OR funding IS DISTINCT FROM o.original_funding OR scope IS DISTINCT FROM o.original_scope
  OR e.tournament_id IS NULL OR e.prize_balance IS DISTINCT FROM 0::numeric
  OR e.bounty_balance IS DISTINCT FROM 0::numeric OR e.fee_balance IS DISTINCT FROM (CASE WHEN resolved THEN 0::numeric ELSE o.amount END)
  OR e.closed_at IS NOT NULL
  OR (to_jsonb(e)-ARRAY['terminal_closed_at','updated_at','fee_out','fee_balance']) IS DISTINCT FROM
     (o.escrow_snapshot-ARRAY['terminal_closed_at','updated_at','fee_out','fee_balance'])
  OR e.fee_out IS DISTINCT FROM ((o.escrow_snapshot->>'fee_out')::numeric+CASE WHEN resolved THEN o.amount ELSE 0 END)
  OR (NOT resolved AND (EXISTS(SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id=p_tournament_id)
   OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=p_tournament_id)
   OR EXISTS(SELECT 1 FROM public.accounting_tournament_recognized_sources WHERE tournament_id=p_tournament_id)))
 THEN RAISE EXCEPTION 'legacy fee custody no longer matches original conserved source' USING ERRCODE='P0404'; END IF;
 RETURN jsonb_build_object('accounting_version',3,'tournament_id',p_tournament_id,
  'status','fee_custody_unresolved','player_result','final','payable',false,'accounting_complete',resolved,
  'resolution',resolution,'current_held_amount',CASE WHEN resolved THEN 0 ELSE o.amount END,
  'obligation_id',o.id,'source_fingerprint',o.source_fingerprint,'source_count',n,
  'held_amount',o.amount,'held_at',o.held_at,'reason',o.reason,'custody_store','tournament_escrow',
  'recognized_source_count',0,'bank_amount',0,'banked_at',NULL,'bank_receipt_id',NULL);
END $function$;
ALTER FUNCTION public.fn_ca_tournament_fee_custody_receipt(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_fee_custody_receipt(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_tournament_fee_custody_receipt(p_tournament_id uuid)

-- @@DOOR fn_ca_tournament_felt_may_not_exceed_supply()
-- @@PIN md5=81fda5e596905c96a07bebfcff7f32b3 len=5148 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_was numeric;
  v_now numeric;
  v_delta numeric;
  v_felt numeric;
  v_supply numeric;
BEGIN
  -- What this row contributes to the felt. A vacated seat contributes nothing,
  -- whatever its stack still says - that stale figure is the whole defect.
  v_now := CASE WHEN NEW.left_at IS NULL THEN COALESCE(NEW.stack,0) ELSE 0 END;
  v_was := CASE WHEN TG_OP = 'INSERT' THEN 0
                WHEN OLD.left_at IS NULL THEN COALESCE(OLD.stack,0)
                ELSE 0 END;
  v_delta := v_now - v_was;

  -- Only growth is judged. A seat exit, a losing bet and a no-op never refuse:
  -- a guard that can refuse a seat exit strands a player mid-hand.
  IF v_delta <= 0 THEN
    RETURN NULL;
  END IF;

  SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb WHERE tb.id = NEW.table_id;
  IF v_tournament_id IS NULL THEN
    RETURN NULL;                      -- a cash seat; supply is not the meter
  END IF;

  -- DEFERRED, so this is the committed end state of the whole transaction:
  -- every seat of a settled hand, or the vacate and the re-seat of a move.
  v_felt   := public.fn_ca_tournament_felt_total(v_tournament_id);
  v_supply := public.fn_ca_tournament_chip_supply(v_tournament_id);

  -- Tolerate history, refuse growth: only the write that CARRIES the felt over
  -- the line is refused. An event already over stays playable.
  IF v_felt > v_supply AND (v_felt - v_delta) <= v_supply
     AND NOT EXISTS (
       SELECT 1 FROM public.union_pnl_inventory_events own
       WHERE own.transaction_id=pg_current_xact_id() AND own.source_name='table_seats'
         AND own.row_id=NEW.id AND own.operation=TG_OP
         AND own.after_row=public.fn_union_pnl_inventory_project('table_seats',to_jsonb(NEW))
         AND own.before_row=CASE WHEN TG_OP='UPDATE'
           THEN public.fn_union_pnl_inventory_project('table_seats',to_jsonb(OLD)) ELSE NULL END
         AND (SELECT count(*)>=2 AND bool_and((
                  e.operation='UPDATE'
                  AND e.before_row->>'table_id'=NEW.table_id::text
                  AND e.after_row->>'table_id'=NEW.table_id::text
                  AND e.before_row->>'user_id'=e.after_row->>'user_id'
                  AND e.before_row->>'occupancy_id'=e.after_row->>'occupancy_id'
                  AND e.before_row->>'joined_at'=e.after_row->>'joined_at') IS TRUE)
                AND sum(CASE WHEN e.after_row->>'left_at' IS NULL
                             THEN COALESCE((e.after_row->>'stack')::numeric,0) ELSE 0 END
                      - CASE WHEN e.before_row->>'left_at' IS NULL
                             THEN COALESCE((e.before_row->>'stack')::numeric,0) ELSE 0 END)=0
              FROM public.union_pnl_inventory_events e
              WHERE e.transaction_id=pg_current_xact_id() AND e.source_name='table_seats'
                AND (e.before_row->>'table_id'=NEW.table_id::text
                  OR e.after_row->>'table_id'=NEW.table_id::text)) IS TRUE
         AND NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_events scope
           WHERE scope.transaction_id=pg_current_xact_id() AND scope.source_name='tables'
             AND scope.row_id=NEW.table_id
             AND scope.before_row->'tournament_id' IS DISTINCT FROM scope.after_row->'tournament_id')
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_paid_stack_custody_receipts r
       JOIN public.table_seats s ON s.id=NEW.id
       WHERE r.transaction_id=pg_current_xact_id() AND r.state='seated'
         AND r.tournament_id=v_tournament_id AND r.user_id=NEW.user_id
         AND r.destination_table_id=NEW.table_id AND r.destination_seat_number=NEW.seat_number
         AND r.assignment->>'seat_id'=NEW.id::text
         AND r.assignment->>'occupancy_id'=NEW.occupancy_id::text
         AND s.user_id=NEW.user_id AND s.table_id=NEW.table_id AND s.seat_number=NEW.seat_number
         AND s.occupancy_id=NEW.occupancy_id AND s.left_at IS NULL AND s.stack=r.grant_chips
         AND v_was=0 AND v_now=r.grant_chips AND v_delta=r.grant_chips
         AND r.live_chips_before+r.grant_chips=v_felt
         AND (r.expected->>'acknowledged_supply')::numeric=v_supply
         AND r.expected->'supply_acknowledgement' IS NOT DISTINCT FROM
           (SELECT to_jsonb(a) FROM public.tournament_felt_supply_acknowledgements a WHERE a.tournament_id=v_tournament_id)
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_FELT_WOULD_EXCEED_SUPPLY: seat % (table %, seat %) adds % chips, '
      'leaving % on the felt of tournament % against % ever bought in',
      NEW.id, NEW.table_id, NEW.seat_number, v_delta, v_felt,
      v_tournament_id, v_supply
      USING ERRCODE = '55000',
            HINT = 'A vacated seat''s stack is a stale snapshot, not chips. '
                   'Fund a seat from the felt the player is leaving, or record '
                   'the creation in tournament_felt_supply_acknowledgements.';
  END IF;

  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply() TO authenticated, service_role;
-- @@END fn_ca_tournament_felt_may_not_exceed_supply()

-- @@DOOR fn_ca_tournament_felt_total(p_tournament_id uuid)
-- @@PIN md5=a2698ca8bafd2a3b76c7ac156d654276 len=378 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_felt_total(p_tournament_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(sum(ts.stack),0)
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id=ts.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND ts.left_at IS NULL;
$function$;
ALTER FUNCTION public.fn_ca_tournament_felt_total(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_felt_total(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_felt_total(p_tournament_id uuid) TO service_role;
-- @@END fn_ca_tournament_felt_total(p_tournament_id uuid)

-- @@DOOR fn_ca_verify_terminal_final_deal_batch(p_tournament_id uuid, p_require_terminal boolean)
-- @@PIN md5=bd50e5dfb791252dd1c5731fa6254d00 len=14773 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_verify_terminal_final_deal_batch(p_tournament_id uuid, p_require_terminal boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 v_t public.tournaments%ROWTYPE;
 v_b public.tournament_final_table_deal_batches%ROWTYPE;
 v_e public.tournament_escrow%ROWTYPE;
 v_ob public.tournament_obligations%ROWTYPE;
 v_input jsonb; v_tail jsonb; v_ladder jsonb; v_expected jsonb;
 v_field integer; v_ladder_count integer; v_max_place integer;
 v_place_total numeric; v_deal_cents bigint; v_chips numeric;
 v_bubble numeric:=0; v_bubble_user uuid;
 v_line record; v_amount numeric; v_paid numeric; v_count integer;
 v_not_pool text[]:=ARRAY['satellite_seat','bounty','mystery_bounty',
  'bounty_residual','own_bounty','mystery_bounty_residual'];
BEGIN
 SELECT * INTO STRICT v_t FROM public.tournaments WHERE id=p_tournament_id;
 SELECT * INTO STRICT v_b FROM public.tournament_final_table_deal_batches
  WHERE tournament_id=p_tournament_id;
 IF v_b.contract_version<>2 OR v_b.settled_at IS NULL
  OR v_b.source IS DISTINCT FROM 'engine.fn_settle_tournament_final_table_deal'
  OR v_t.prize_pool_finalized IS DISTINCT FROM true
  OR v_t.prize_pool IS NULL OR v_t.prize_pool<=0
  OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
  OR v_t.prize_pool<>round(v_t.prize_pool,2)
  OR v_t.prize_pool<COALESCE(v_t.guaranteed_prize,0)
  OR lower(COALESCE(v_t.variant,''))='satellite'
  OR upper(COALESCE(v_t.tournament_type,''))='SATELLITE'
  OR v_t.satellite_target_id IS NOT NULL OR v_t.satellite_target IS NOT NULL
 THEN RAISE EXCEPTION 'canonical final deal is not a settled funded cash batch'; END IF;
 SELECT count(*) INTO v_field FROM public.tournament_players WHERE tournament_id=p_tournament_id;
 IF v_field<>v_b.field_count OR v_b.live_count>v_field
  OR v_b.live_count>v_t.table_size OR v_b.live_count<2
  OR (SELECT count(DISTINCT position) FROM public.tournament_players
   WHERE tournament_id=p_tournament_id)<>v_field
  OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament_id
   AND status='winner' AND position=1 AND user_id=v_b.chip_leader
   AND eliminated_at IS NULL AND elimination_sequence IS NULL)<>1
  OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id
   AND (position IS NULL OR position<1 OR position>v_field
    OR status NOT IN ('winner','eliminated')
    OR (position>1 AND (status<>'eliminated' OR eliminated_at IS NULL
     OR elimination_sequence IS NULL OR elimination_sequence<=0))
    OR (status='winner' AND position<>1)))
  OR (SELECT count(DISTINCT elimination_sequence) FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND status='eliminated')<>v_field-1
  OR EXISTS(SELECT 1 FROM (SELECT position,
   row_number() OVER(ORDER BY COALESCE(public.fn_ca_tournament_bust_at(tournament_id, user_id), eliminated_at) DESC NULLS LAST, elimination_sequence DESC,id)+1 expected
   FROM public.tournament_players WHERE tournament_id=p_tournament_id
    AND status='eliminated') q WHERE position<>expected)
 THEN RAISE EXCEPTION 'canonical final deal durable standings differ'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id',tp.user_id,'club_id',tp.club_id,
  'chips',tp.chips,'registered_at',extract(epoch FROM tp.registered_at))
  ORDER BY tp.chips DESC,tp.registered_at ASC NULLS LAST,tp.user_id),'[]'::jsonb),
  sum(tp.chips)
 INTO v_input,v_chips FROM public.tournament_players tp
 WHERE tp.tournament_id=p_tournament_id AND tp.position<=v_b.live_count;
 IF v_input IS DISTINCT FROM v_b.live_input_snapshot
  OR md5(v_input::text) IS DISTINCT FROM v_b.live_input_fingerprint
  OR jsonb_array_length(v_input)<>v_b.live_count OR v_chips IS NULL OR v_chips<=0
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_input) x
   WHERE x->>'chips' IS NULL OR (x->>'chips')::numeric<0
    OR x->>'chips' IN ('NaN','Infinity','-Infinity'))
  OR (v_input->0->>'user_id')::uuid IS DISTINCT FROM v_b.chip_leader
  OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=v_b.deal_table_id
    AND tournament_id=p_tournament_id)
 THEN RAISE EXCEPTION 'canonical final deal immutable input differs'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',tp.id,'user_id',tp.user_id,
  'club_id',tp.club_id,'position',tp.position,'eliminated_at',extract(epoch FROM tp.eliminated_at),
  'elimination_sequence',tp.elimination_sequence) ORDER BY tp.position),'[]'::jsonb)
 INTO v_tail FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
  AND tp.position>v_b.live_count;
 IF md5(v_tail::text) IS DISTINCT FROM v_b.prior_standings_fingerprint
 THEN RAISE EXCEPTION 'canonical final deal prior standings differ'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('place',a.place,'amount',a.amount)
  ORDER BY a.place),'[]'::jsonb),count(*),max(a.place),
  COALESCE(sum(a.amount) FILTER(WHERE a.place>v_b.live_count),0)
 INTO v_ladder,v_ladder_count,v_max_place,v_place_total
 FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
 IF v_ladder_count=0 OR v_ladder_count<>v_b.structure_place_count
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_ladder) x
    WHERE (x->>'amount')::numeric<0
     OR (x->>'amount')::numeric<>round((x->>'amount')::numeric,2))
 THEN RAISE EXCEPTION 'canonical final deal structure differs'; END IF;
 IF v_t.bubble_protection AND v_max_place+1<=v_field AND v_max_place+1>v_b.live_count THEN
  v_bubble:=v_t.buy_in_amount;
  IF v_bubble IS NULL OR v_bubble<=0 OR v_bubble::text IN ('NaN','Infinity','-Infinity')
   OR v_bubble<>round(v_bubble,2) THEN RAISE EXCEPTION 'canonical final deal Bubble amount invalid'; END IF;
  SELECT user_id INTO STRICT v_bubble_user FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND position=v_max_place+1 AND status='eliminated';
 END IF;
 v_deal_cents:=round((v_t.prize_pool-v_place_total-v_bubble)*100)::bigint;
 IF v_deal_cents<=0 THEN RAISE EXCEPTION 'canonical final deal residual invalid'; END IF;
 WITH live AS (
  SELECT (x->>'user_id')::uuid user_id,(x->>'club_id')::uuid club_id,ord::integer place,
   floor((x->>'chips')::numeric*v_deal_cents/v_chips)::bigint cents
  FROM jsonb_array_elements(v_input) WITH ORDINALITY z(x,ord)
 ), all_lines AS (
  SELECT 'final_table_deal' kind,place,user_id,club_id,
   cents+CASE WHEN place=1 THEN v_deal_cents-(SELECT sum(cents) FROM live) ELSE 0 END cents
   FROM live
  UNION ALL
  SELECT 'place',(x->>'place')::integer,tp.user_id,tp.club_id,
   round((x->>'amount')::numeric*100)::bigint
  FROM jsonb_array_elements(v_ladder) x JOIN public.tournament_players tp
   ON tp.tournament_id=p_tournament_id AND tp.position=(x->>'place')::integer
  WHERE (x->>'place')::integer>v_b.live_count AND (x->>'amount')::numeric>0
 )
 SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',kind,'place',place,
  'user_id',user_id,'club_id',club_id,'cents',cents) ORDER BY place),'[]'::jsonb)
 INTO v_expected FROM all_lines;
 IF v_b.plan IS DISTINCT FROM v_expected OR v_b.plan_fingerprint IS DISTINCT FROM md5(v_expected::text)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_expected) x WHERE (x->>'cents')::bigint<=0)
  OR v_b.place_amount IS DISTINCT FROM v_place_total
  OR v_b.deal_amount IS DISTINCT FROM v_deal_cents::numeric/100
  OR v_b.amount_owed IS DISTINCT FROM v_t.prize_pool-v_bubble
  OR v_b.deal_line_count<>v_b.live_count
  OR v_b.place_line_count<>jsonb_array_length(v_expected)-v_b.live_count
  OR v_b.escrow_prize_after IS DISTINCT FROM 0::numeric
  OR v_b.escrow_prize_before IS DISTINCT FROM v_b.amount_moved
  OR v_b.amount_moved<0 OR v_b.amount_moved>v_t.prize_pool
 THEN RAISE EXCEPTION 'canonical final deal plan or escrow proof differs'; END IF;
 FOR v_line IN SELECT (x->>'kind') kind,(x->>'place')::integer place,
  (x->>'user_id')::uuid user_id,(x->>'cents')::numeric/100 amount
  FROM jsonb_array_elements(v_expected) x
 LOOP
  SELECT * INTO STRICT v_ob FROM public.tournament_obligations o WHERE
   o.tournament_id=p_tournament_id AND o.kind=v_line.kind
   AND (CASE WHEN v_line.kind='place' THEN o.place=v_line.place
    ELSE o.place IS NULL AND o.user_id=v_line.user_id END);
  IF v_ob.user_id IS DISTINCT FROM v_line.user_id OR v_ob.amount_owed IS DISTINCT FROM v_line.amount
   OR v_ob.amount_paid IS DISTINCT FROM v_line.amount OR v_ob.settled_at IS NULL
   OR (v_line.kind='final_table_deal' AND (v_ob.source IS DISTINCT FROM 'final_table_deal'
    OR v_ob.adjustment_id IS NOT NULL))
  THEN RAISE EXCEPTION 'canonical final deal obligation differs at place %',v_line.place; END IF;
  SELECT COALESCE(sum(p.amount),0),count(*) INTO v_paid,v_count FROM public.tournament_payouts p
   WHERE p.tournament_id=p_tournament_id AND p.user_id=v_line.user_id
    AND (CASE WHEN v_line.kind='place' THEN p.position=v_line.place
      AND NOT(COALESCE(p.source,'')=ANY(v_not_pool)) AND p.source<>'final_table_deal'
     ELSE p.position IS NULL AND p.source='final_table_deal' END);
  IF v_paid IS DISTINCT FROM v_line.amount OR v_count<1
   OR (v_line.kind='final_table_deal' AND v_count<>1)
  THEN RAISE EXCEPTION 'canonical final deal payout differs at place %',v_line.place; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.tournament_obligations o
  WHERE o.tournament_id=p_tournament_id AND o.kind IN ('place','final_table_deal')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_expected) x
    WHERE o.kind=x->>'kind' AND o.user_id=(x->>'user_id')::uuid
     AND (CASE WHEN o.kind='place' THEN o.place=(x->>'place')::integer ELSE o.place IS NULL END)))
 THEN RAISE EXCEPTION 'canonical final deal has uncontracted debt'; END IF;
 SELECT count(*) INTO v_count FROM public.tournament_obligations
  WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
 IF v_bubble>0 THEN
  SELECT * INTO STRICT v_ob FROM public.tournament_obligations
   WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
  IF v_count<>1 OR v_ob.place IS NOT NULL OR v_ob.user_id IS DISTINCT FROM v_bubble_user
   OR v_ob.amount_owed IS DISTINCT FROM v_bubble OR v_ob.amount_paid IS DISTINCT FROM v_bubble
   OR v_ob.settled_at IS NULL OR v_ob.source IS NULL
   OR v_ob.source NOT IN ('engine.eliminatePlayer','engine.atomicPlaceSettlement',
    'engine.fn_settle_tournament_places','engine.fn_settle_tournament_bubble_protection')
   OR v_b.bubble_contract_required IS DISTINCT FROM true
   OR v_b.bubble_obligation_id IS DISTINCT FROM v_ob.id
   OR v_b.bubble_user_id IS DISTINCT FROM v_bubble_user
   OR v_b.bubble_source IS DISTINCT FROM v_ob.source
   OR v_b.bubble_amount_owed IS DISTINCT FROM v_bubble
   OR v_b.bubble_amount_paid_before<0 OR v_b.bubble_amount_paid_before>v_bubble
   OR (SELECT COALESCE(sum(amount),0) FROM public.tournament_payouts
    WHERE tournament_id=p_tournament_id AND source='bubble_protection') IS DISTINCT FROM v_bubble
  THEN RAISE EXCEPTION 'canonical final deal Bubble proof differs'; END IF;
 ELSIF v_count<>0 OR v_b.bubble_contract_required IS DISTINCT FROM false
  OR v_b.bubble_obligation_id IS NOT NULL OR v_b.bubble_user_id IS NOT NULL
  OR v_b.bubble_source IS NOT NULL OR v_b.bubble_amount_owed<>0 OR v_b.bubble_amount_paid_before<>0
 THEN RAISE EXCEPTION 'canonical final deal has uncontracted Bubble'; END IF;
 IF EXISTS(SELECT 1 FROM public.tournament_payouts p WHERE p.tournament_id=p_tournament_id
  AND NOT(COALESCE(p.source,'')=ANY(v_not_pool)) AND
   (p.amount IS NULL OR p.amount<=0 OR p.amount::text IN ('NaN','Infinity','-Infinity')
    OR p.amount<>round(p.amount,2) OR p.idempotency_key IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency k WHERE
     k.key=p.idempotency_key AND k.user_id=p.user_id AND k.amount=p.amount)
    OR NOT(
     (p.source='bubble_protection' AND p.position IS NULL AND p.user_id=v_bubble_user AND v_bubble>0)
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_expected) x WHERE p.user_id=(x->>'user_id')::uuid
      AND CASE WHEN x->>'kind'='place' THEN p.position=(x->>'place')::integer
        AND p.source<>'final_table_deal' AND p.source<>'bubble_protection'
       ELSE p.position IS NULL AND p.source='final_table_deal' END))))
  OR (SELECT COALESCE(sum(p.amount),0) FROM public.tournament_payouts p
   WHERE p.tournament_id=p_tournament_id AND NOT(COALESCE(p.source,'')=ANY(v_not_pool)))
    IS DISTINCT FROM v_t.prize_pool
  OR EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
   AND tp.prize IS DISTINCT FROM COALESCE((SELECT sum(p.amount) FROM public.tournament_payouts p
    WHERE p.tournament_id=p_tournament_id AND p.user_id=tp.user_id
     AND NOT(COALESCE(p.source,'')=ANY(v_not_pool))),0))
 THEN RAISE EXCEPTION 'canonical final deal wallet proof or cache differs'; END IF;
 -- Every obligation-scoped wallet credit must retain its exact payout witness.
 -- This also rejects an extra spent key hidden behind otherwise-correct totals.
 IF EXISTS(SELECT 1 FROM public.tournament_obligations o
  JOIN public.wallet_credit_idempotency k
   ON k.key LIKE 'tourney:'||p_tournament_id::text||':obl:'||o.id::text||':%'
  WHERE o.tournament_id=p_tournament_id AND o.kind IN ('place','final_table_deal','bubble_protection')
   AND NOT EXISTS(SELECT 1 FROM public.tournament_payouts p
    WHERE p.tournament_id=p_tournament_id AND p.idempotency_key=k.key
     AND p.user_id=k.user_id AND p.user_id=o.user_id AND p.amount=k.amount
     AND CASE WHEN o.kind='place' THEN p.position=o.place
       AND NOT(COALESCE(p.source,'')=ANY(v_not_pool))
       AND p.source NOT IN ('final_table_deal','bubble_protection')
      ELSE p.position IS NULL AND p.source=o.kind END))
 THEN RAISE EXCEPTION 'canonical final deal has an orphaned wallet credit'; END IF;
 SELECT * INTO STRICT v_e FROM public.tournament_escrow WHERE tournament_id=p_tournament_id;
 IF v_e.enforced IS DISTINCT FROM true OR v_e.prize_balance IS DISTINCT FROM 0::numeric
  OR (p_require_terminal AND (v_e.bounty_balance IS DISTINCT FROM 0::numeric
   OR v_e.fee_balance IS DISTINCT FROM 0::numeric OR v_e.closed_at IS NULL
   OR NOT EXISTS(SELECT 1 FROM public.tournament_finish_receipts f
    WHERE f.tournament_id=p_tournament_id AND f.finish_kind='final_table_deal'
     AND f.winner_user_id=v_b.chip_leader)
   OR EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
    WHERE t.tournament_id=p_tournament_id AND (s.left_at IS NULL OR s.status IS DISTINCT FROM 'left'))))
 THEN RAISE EXCEPTION 'canonical final deal has open custody, seats or missing finish claim'; END IF;
 RETURN jsonb_build_object('ok',true,'contract_version',2,'plan_fingerprint',v_b.plan_fingerprint,
  'place_amount',v_place_total,'deal_amount',v_deal_cents::numeric/100,'bubble_amount',v_bubble,
  'chip_leader',v_b.chip_leader);
END;
$function$;
ALTER FUNCTION public.fn_ca_verify_terminal_final_deal_batch(p_tournament_id uuid, p_require_terminal boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_verify_terminal_final_deal_batch(p_tournament_id uuid, p_require_terminal boolean) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_verify_terminal_final_deal_batch(p_tournament_id uuid, p_require_terminal boolean)

-- @@DOOR fn_cancel_cash_seat_moves_on_table_close()
-- @@PIN md5=15c4186eb80013ea8907e73f80f4a096 len=887 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_cancel_cash_seat_moves_on_table_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF (NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed')
     OR (NEW.seat_admission_key = 'closed' AND OLD.seat_admission_key IS DISTINCT FROM 'closed') THEN
    -- the moves that name this table, and the swap partners of those moves
    UPDATE public.cash_seat_moves m
       SET state = 'cancelled', note = 'table_closed'
     WHERE m.state = 'pending'
       AND (m.from_table_id = NEW.id OR m.to_table_id = NEW.id
            OR EXISTS (SELECT 1 FROM public.cash_seat_moves p
                        WHERE p.id = m.swap_move_id AND p.state = 'pending'
                          AND (p.from_table_id = NEW.id OR p.to_table_id = NEW.id)));
  END IF;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.fn_cancel_cash_seat_moves_on_table_close() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_cancel_cash_seat_moves_on_table_close() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_cancel_cash_seat_moves_on_table_close() TO service_role;
-- @@END fn_cancel_cash_seat_moves_on_table_close()

-- @@DOOR fn_capability_available(p_capability_id text)
-- @@PIN md5=43d415cfb6fbb9c289e98b12b5de925c len=399 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_capability_available(p_capability_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    (SELECT c.readiness IN ('deployed','production_verified')
       FROM public.platform_capabilities c
      WHERE c.capability_id = p_capability_id),
    false);
$function$;
ALTER FUNCTION public.fn_capability_available(p_capability_id text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_capability_available(p_capability_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_capability_available(p_capability_id text) TO authenticated, service_role;
-- @@END fn_capability_available(p_capability_id text)

-- @@DOOR fn_capture_owner_notification_destination()
-- @@PIN md5=765a320465a49f71c26c4b747d61f1fd len=848 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_capture_owner_notification_destination()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF public.fn_is_owner_operational_notification(NEW.user_id,NEW.type,NEW.title,NEW.data) THEN
    INSERT INTO public.operational_notification_destinations(notification_id,recipient_user_id,original_notification)
      VALUES(NEW.id,NEW.user_id,to_jsonb(NEW));
    PERFORM public.fn_try_record_owner_notification(NEW.id);
    -- Preserve the original row byte-for-byte, including _push. The DB mirror
    -- predicate below and gateway destination branch suppress personal sends.
    -- This also lets the existing administrative reader recover the same exact
    -- original if the first recorder attempt failed.
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_capture_owner_notification_destination() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_capture_owner_notification_destination() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_capture_owner_notification_destination()

-- @@DOOR fn_cash_cluster_epoch_follows_its_game()
-- @@PIN md5=4cc0609b0014eb7f3930e8f03f6c6049 len=2758 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_cash_cluster_epoch_follows_its_game()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.cash_cluster_epoch (cluster_id, epoch, mode, started_by, started_at)
    VALUES (NEW.id, NEW.cluster_epoch, NEW.cluster_mode, 'genesis', NEW.created_at)
    ON CONFLICT (cluster_id, epoch) DO NOTHING;
    IF FOUND THEN
      -- SPECIFICATION EVENT cluster_epoch_started (2026-09-26): the genesis epoch.
      INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
      VALUES (NEW.id, 'cluster_epoch_started', jsonb_build_object(
        'cluster_id', NEW.id, 'cluster_epoch', NEW.cluster_epoch, 'previous_epoch', NULL,
        'mode', NEW.cluster_mode, 'started_by', 'genesis', 'at', clock_timestamp()),
        NEW.cluster_epoch, CASE WHEN current_setting('ca.request_id', true) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN current_setting('ca.request_id', true)::uuid END);
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.cluster_epoch IS DISTINCT FROM OLD.cluster_epoch THEN
    IF NEW.cluster_epoch < OLD.cluster_epoch THEN
      RAISE EXCEPTION 'CLUSTER_EPOCH_GOES_FORWARD: cluster % cannot move from epoch % back to %',
        NEW.id, OLD.cluster_epoch, NEW.cluster_epoch
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.cash_cluster_epoch
       SET ended_at = clock_timestamp()
     WHERE cluster_id = NEW.id AND ended_at IS NULL;
    INSERT INTO public.cash_cluster_epoch (cluster_id, epoch, mode, started_by)
    VALUES (NEW.id, NEW.cluster_epoch, NEW.cluster_mode,
            coalesce(nullif(current_setting('ca.epoch_reason', true), ''), 'unstated'));
    -- SPECIFICATION EVENT cluster_epoch_started (2026-09-26).
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
    VALUES (NEW.id, 'cluster_epoch_started', jsonb_build_object(
      'cluster_id', NEW.id, 'cluster_epoch', NEW.cluster_epoch, 'previous_epoch', OLD.cluster_epoch,
      'mode', NEW.cluster_mode,
      'started_by', coalesce(nullif(current_setting('ca.epoch_reason', true), ''), 'unstated'),
      'at', clock_timestamp()),
      NEW.cluster_epoch, CASE WHEN current_setting('ca.request_id', true) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN current_setting('ca.request_id', true)::uuid END);
    RETURN NULL;
  END IF;

  IF NEW.cluster_mode IS DISTINCT FROM OLD.cluster_mode THEN
    UPDATE public.cash_cluster_epoch
       SET mode = NEW.cluster_mode
     WHERE cluster_id = NEW.id AND ended_at IS NULL;
  END IF;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.fn_cash_cluster_epoch_follows_its_game() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_cash_cluster_epoch_follows_its_game() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_epoch_follows_its_game() TO service_role;
-- @@END fn_cash_cluster_epoch_follows_its_game()

-- @@DOOR fn_cash_game_roster_track()
-- @@PIN md5=1ce40780d8a8b510b88549de225a9b25 len=3219 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_cash_game_roster_track()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_game uuid;
  v_move uuid;
BEGIN
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  SELECT cluster_id INTO v_game FROM public.tables WHERE id = NEW.table_id;
  IF v_game IS NULL THEN RETURN NEW; END IF;

  BEGIN
    IF NEW.left_at IS NULL THEN
      -- A live chair in the game. On the roster once, at the time of the
      -- first chair; a second chair (a move, mid-transaction) changes nothing.
      INSERT INTO public.cash_game_roster (game_id, user_id, joined_at)
      VALUES (v_game, NEW.user_id, coalesce(NEW.joined_at, now()))
      ON CONFLICT (game_id, user_id) WHERE left_at IS NULL DO NOTHING;
    ELSIF TG_OP = 'UPDATE' AND OLD.left_at IS NULL THEN
      -- The chair emptied. A move declares itself (app.cash_seat_move) and is
      -- not a leave; a player with another live chair in the game is still in
      -- the game. ANYTHING ELSE IS A LEAVE, whatever was planned for them.
      --
      -- A LEAVE CANCELS THE MOVE (2026-09-09). This used to wait while a move
      -- was pending, so the destination chair stayed reserved for a player who
      -- had gone, a swap partner was held for a side that would never come,
      -- and a rejoin inside that window kept the old roster row - the old list
      -- position and the old seat change. Dan: a player who leaves and joins
      -- the same game again goes to the BOTTOM of the list.
      IF current_setting('app.cash_seat_move', true) IS DISTINCT FROM 'on'
         AND NOT EXISTS (SELECT 1 FROM public.table_seats ts
                           JOIN public.tables t ON t.id = ts.table_id
                          WHERE ts.user_id = NEW.user_id AND ts.left_at IS NULL AND ts.id <> NEW.id
                            AND t.cluster_id = v_game AND t.lifecycle <> 'closed') THEN
        -- One pending move per player (cash_seat_moves_one_pending_per_player),
        -- so a scalar RETURNING is the whole set.
        v_move := NULL;
        UPDATE public.cash_seat_moves m
           SET state = 'cancelled', note = 'player_left_game'
         WHERE m.player_id = NEW.user_id AND m.game_id = v_game AND m.state = 'pending'
        RETURNING m.id INTO v_move;
        -- A swap partner is released at once: the held side is dealt back in
        -- at its next boundary and the tick puts its request back on the list.
        IF v_move IS NOT NULL THEN
          UPDATE public.cash_seat_moves p
             SET state = 'cancelled', note = 'swap_partner_gone'
           WHERE p.swap_move_id = v_move AND p.state = 'pending';
        END IF;
        UPDATE public.cash_game_roster SET left_at = now()
         WHERE game_id = v_game AND user_id = NEW.user_id AND left_at IS NULL;
        UPDATE public.cash_seat_change_requests
           SET status = 'cancelled', resolved_at = now(), note = 'left_game'
         WHERE game_id = v_game AND user_id = NEW.user_id AND status = 'requested';
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_cash_game_roster_track: % (seat %, user %)', SQLERRM, NEW.id, NEW.user_id;
  END;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_cash_game_roster_track() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_cash_game_roster_track() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_roster_track() TO service_role;
-- @@END fn_cash_game_roster_track()

-- @@DOOR fn_cash_provenance_immutable()
-- @@PIN md5=77e5fcec76b8682e7648573fd60e0a71 len=254 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_cash_provenance_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN RAISE EXCEPTION 'Original cash provenance is immutable' USING ERRCODE='55000'; END $function$;
ALTER FUNCTION public.fn_cash_provenance_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_cash_provenance_immutable() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_cash_provenance_immutable()

-- @@DOOR fn_cash_record_original_funding(p_kind text, p_key text, p_user uuid, p_table uuid, p_ledger uuid, p_wallet uuid, p_club uuid, p_amount numeric, p_after numeric, p_pending uuid)
-- @@PIN md5=7ee6659572a38ef014952b4559f6167a len=2196 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_cash_record_original_funding(p_kind text, p_key text, p_user uuid, p_table uuid, p_ledger uuid, p_wallet uuid, p_club uuid, p_amount numeric, p_after numeric, p_pending uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s public.table_seats%ROWTYPE; l public.chip_ledger%ROWTYPE;
 c public.clubs%ROWTYPE; v_id uuid;
BEGIN
 SELECT * INTO STRICT l FROM public.chip_ledger WHERE id=p_ledger;
 SELECT * INTO STRICT s FROM public.table_seats WHERE table_id=p_table AND user_id=p_user AND left_at IS NULL FOR SHARE;
 SELECT * INTO STRICT c FROM public.clubs WHERE id=p_club;
 IF s.occupancy_id IS NULL OR s.joined_at IS NULL
  OR c.asset IS DISTINCT FROM 'chips' OR l.club_id IS DISTINCT FROM p_club
  OR l.amount IS DISTINCT FROM p_amount OR l.to_type IS DISTINCT FROM 'table_stack'
  OR l.to_entity_id IS DISTINCT FROM p_table OR l.category IS DISTINCT FROM p_kind
  OR l.from_type IS DISTINCT FROM (CASE WHEN p_kind='horse_funding' THEN 'club_treasury' ELSE 'player_wallet' END)
  OR l.from_entity_id IS DISTINCT FROM (CASE WHEN p_kind='horse_funding' THEN p_club ELSE p_user END)
 THEN RAISE EXCEPTION 'Original cash funding debit identity mismatch' USING ERRCODE='23514'; END IF;
 IF p_kind<>'horse_funding' AND NOT EXISTS(SELECT 1 FROM public.wallet_transactions w
  WHERE w.id=p_wallet AND w.user_id=p_user AND w.table_id=p_table AND w.type='debit'
    AND w.category=p_kind AND w.amount=p_amount AND w.balance_after=p_after) THEN
  RAISE EXCEPTION 'Original cash funding wallet journal mismatch' USING ERRCODE='23514';
 END IF;
 INSERT INTO public.cash_participant_funding_receipts(operation_kind,operation_key,user_id,table_id,
  seat_id,occupancy_id,seat_joined_at,source_ledger_id,wallet_transaction_id,account_type,
  account_entity_id,funding_club_id,funding_union_id,asset,amount,balance_before,balance_after,pending_addon_id)
 VALUES(p_kind,p_key,p_user,p_table,s.id,s.occupancy_id,s.joined_at,l.id,p_wallet,l.from_type,
  l.from_entity_id,p_club,c.union_id,c.asset,p_amount,p_after+p_amount,p_after,p_pending) RETURNING id INTO v_id;
 RETURN v_id;
END $function$;
ALTER FUNCTION public.fn_cash_record_original_funding(p_kind text, p_key text, p_user uuid, p_table uuid, p_ledger uuid, p_wallet uuid, p_club uuid, p_amount numeric, p_after numeric, p_pending uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_cash_record_original_funding(p_kind text, p_key text, p_user uuid, p_table uuid, p_ledger uuid, p_wallet uuid, p_club uuid, p_amount numeric, p_after numeric, p_pending uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_cash_record_original_funding(p_kind text, p_key text, p_user uuid, p_table uuid, p_ledger uuid, p_wallet uuid, p_club uuid, p_amount numeric, p_after numeric, p_pending uuid)

-- @@DOOR fn_cashout_seat_occupancy(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_occupancy_id uuid, p_leave_mode text)
-- @@PIN md5=2e60c4b66468b51061018a9058e9a395 len=4271 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_cashout_seat_occupancy(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_occupancy_id uuid, p_leave_mode text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_tournament uuid;
  v_seat record;
  v_previous public.seat_cashout_receipts%ROWTYPE;
  v_result jsonb;
  v_effective_mode text;
  v_previous_authority text;
BEGIN
  IF p_user_id IS NULL OR p_table_id IS NULL OR p_seat_number IS NULL
     OR p_occupancy_id IS NULL THEN
    RAISE EXCEPTION 'CASHOUT_OCCUPANCY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  -- The engine owns the live-hand boundary. Knowing an occupancy UUID or
  -- owning the seat cannot authorize a direct browser cashout mid-hand.
  IF NOT coalesce(public.fn_caller_is_engine(),false) THEN
    RAISE EXCEPTION 'Engine authority required' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text,0));
  SELECT * INTO v_previous FROM public.seat_cashout_receipts
   WHERE occupancy_id = p_occupancy_id;
  IF FOUND THEN
    IF v_previous.user_id <> p_user_id OR v_previous.table_id <> p_table_id
       OR v_previous.seat_number <> p_seat_number THEN
      RAISE EXCEPTION 'CASHOUT_OCCUPANCY_SCOPE_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RETURN v_previous.receipt;
  END IF;

  SELECT tournament_id INTO v_tournament FROM public.tables WHERE id=p_table_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHOUT_TABLE_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF v_tournament IS NOT NULL THEN
    PERFORM 1 FROM public.tournaments WHERE id=v_tournament FOR NO KEY UPDATE;
  END IF;
  -- Diamond hands lock table -> wallet -> seat. Retain that order for exits.
  IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
            WHERE t.id=p_table_id AND c.asset='diamonds') THEN
    PERFORM 1 FROM public.tables WHERE id=p_table_id FOR UPDATE;
    PERFORM 1 FROM public.profiles WHERE id=p_user_id FOR UPDATE;
  END IF;
  SELECT id,seat_number,occupancy_id INTO v_seat FROM public.table_seats
   WHERE occupancy_id=p_occupancy_id AND table_id=p_table_id AND user_id=p_user_id
     AND seat_number=p_seat_number AND left_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHOUT_STALE_OCCUPANCY' USING ERRCODE = '22023';
  END IF;

  -- This lock and the canonical function's locks are in the same transaction.
  -- A concurrent seat replacement cannot cross the identity check.
  v_effective_mode := p_leave_mode;
  -- A forced request survives restart and cannot leak onto a later occupancy.
  IF p_leave_mode IS DISTINCT FROM 'vpip_evicted' AND EXISTS (SELECT 1 FROM public.seat_departure_requests
    WHERE occupancy_id=p_occupancy_id AND user_id=p_user_id AND table_id=p_table_id
      AND seat_number=p_seat_number AND leave_mode='forced') THEN
    v_effective_mode := 'forced';
  END IF;
  -- Classification is derived from retained, occupancy-bound authority.
  -- Never inherit another operation's transaction-local admin marker.
  v_previous_authority := current_setting('app.cash_exit_authority',true);
  PERFORM set_config('app.cash_exit_authority',
    CASE WHEN v_effective_mode='forced' AND EXISTS(
      SELECT 1 FROM public.seat_admin_departure_authorizations
       WHERE occupancy_id=p_occupancy_id AND user_id=p_user_id
         AND table_id=p_table_id AND seat_number=p_seat_number)
    THEN 'club_admin' ELSE '' END,true);
  v_result := public.atomic_seat_cashout_locked(
    p_user_id,p_table_id,p_seat_number,v_effective_mode);
  PERFORM set_config('app.cash_exit_authority',coalesce(v_previous_authority,''),true);
  IF v_result->>'ok' IS DISTINCT FROM 'true'
     OR v_result->>'reason' IS NOT NULL
     OR (v_result->>'seat_number')::integer IS DISTINCT FROM p_seat_number
     OR v_result->>'idempotency_key' IS DISTINCT FROM 'cashout:occupancy:'||p_occupancy_id::text THEN
    RAISE EXCEPTION 'CASHOUT_UNCONFIRMED_OUTCOME' USING ERRCODE = '22023';
  END IF;
  -- The canonical transaction writes this receipt for every ingress.
  -- The wrapper owns request identity and replay, never a second receipt write.
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.fn_cashout_seat_occupancy(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_occupancy_id uuid, p_leave_mode text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_cashout_seat_occupancy(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_occupancy_id uuid, p_leave_mode text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_cashout_seat_occupancy(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_occupancy_id uuid, p_leave_mode text) TO service_role;
-- @@END fn_cashout_seat_occupancy(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_occupancy_id uuid, p_leave_mode text)

-- @@DOOR fn_clear_seats_on_game_end()
-- @@PIN md5=9660c076fa2d1739a01ed360933f3c26 len=675 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_clear_seats_on_game_end()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_table uuid;
BEGIN
  IF NEW.status IN ('COMPLETED', 'CANCELLED')
     AND COALESCE(OLD.status, '') IS DISTINCT FROM NEW.status THEN
    FOR v_table IN
      SELECT id FROM public.tables WHERE tournament_id = NEW.id
    LOOP
      -- Never reopen a table whose game is over: the recycler builds the next
      -- spin its own fresh table. What must not survive is the seat rows.
      PERFORM public.fn_clear_table_seats(v_table, false);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_clear_seats_on_game_end() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_clear_seats_on_game_end() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_clear_seats_on_game_end() TO service_role;
-- @@END fn_clear_seats_on_game_end()

-- @@DOOR fn_clear_sitout_on_turnover()
-- @@PIN md5=0047b57eef2386cece21471486e8579c len=637 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_clear_sitout_on_turnover()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  -- A different occupant never inherits the prior player's away state.
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR (NEW.left_at IS NOT NULL AND OLD.left_at IS NULL) THEN
    NEW.is_sitting_out := false;
    NEW.sit_out_at := NULL;
  ELSIF NEW.left_at IS NULL AND OLD.left_at IS NOT NULL
        AND NEW.is_sitting_out IS NOT DISTINCT FROM OLD.is_sitting_out THEN
    NEW.is_sitting_out := false;
    NEW.sit_out_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_clear_sitout_on_turnover() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_clear_sitout_on_turnover() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_clear_sitout_on_turnover() TO service_role;
-- @@END fn_clear_sitout_on_turnover()

-- @@DOOR fn_concurrent_game_load(p_user_id uuid, p_exclude_seat_id uuid, p_exclude_table_id uuid, p_exclude_tournament_id uuid)
-- @@PIN md5=3c3cefbad667a51bd13caf5e1beaaf8b len=2844 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_concurrent_game_load(p_user_id uuid, p_exclude_seat_id uuid DEFAULT NULL::uuid, p_exclude_table_id uuid DEFAULT NULL::uuid, p_exclude_tournament_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT (
    -- (1) A LIVE SEAT IS A GAME. A seat at a closed table is history.
    -- A FINISHED GAME IS NOT A GAME (2026-09-10): a seat at a table whose
    -- tournament is COMPLETING, COMPLETED or CANCELLED is history too. Seats
    -- are vacated after settlement, so during settlement the winner of a
    -- satellite still "sat" at it, and that seat was counted against the
    -- target entry he had just won.
    (
      SELECT count(*)
        FROM public.table_seats ts
        JOIN public.tables t ON t.id = ts.table_id
       WHERE ts.user_id = p_user_id
         AND ts.left_at IS NULL
         AND t.status <> 'closed'
         AND NOT EXISTS (
           SELECT 1
             FROM public.tournaments tr1
            WHERE tr1.id = t.tournament_id
              AND tr1.status IN ('COMPLETING', 'COMPLETED', 'CANCELLED')
         )
         AND (p_exclude_seat_id IS NULL OR ts.id IS DISTINCT FROM p_exclude_seat_id)
         AND (p_exclude_table_id IS NULL OR ts.table_id IS DISTINCT FROM p_exclude_table_id)
    )
    +
    -- (2) A BOOKING IS A GAME FROM ONE HOUR BEFORE ITS TOURNAMENT STARTS
    -- UNTIL THE TOURNAMENT STARTS (2026-09-06). RUNNING is absent
    -- deliberately: its entrants hold seats, counted by clause (1). A booking
    -- for an event further out than an hour is a plan, not a game - counting
    -- it from registration held 217 horses off the cash floor for events up
    -- to 68 hours away. A NULL start_time is a seat-first game that starts
    -- when it fills, so it always counts.
    (
      SELECT count(*)
        FROM public.tournament_players tp
        JOIN public.tournaments tr ON tr.id = tp.tournament_id
       WHERE tp.user_id = p_user_id
         AND tp.status IN ('registered', 'playing')
         AND tr.status IN ('ANNOUNCED', 'REGISTERING')
         AND (tr.start_time IS NULL OR tr.start_time <= now() + interval '60 minutes')
         AND (p_exclude_tournament_id IS NULL
              OR tp.tournament_id IS DISTINCT FROM p_exclude_tournament_id)
         -- NEVER BOTH. A seat-first game sells the chair before it starts, so
         -- a booking and a seat can describe the same game for a few minutes.
         AND NOT EXISTS (
           SELECT 1
             FROM public.table_seats ts2
             JOIN public.tables t2 ON t2.id = ts2.table_id
            WHERE ts2.user_id = p_user_id
              AND ts2.left_at IS NULL
              AND t2.status <> 'closed'
              AND t2.tournament_id = tp.tournament_id
         )
    )
  )::int;
$function$;
ALTER FUNCTION public.fn_concurrent_game_load(p_user_id uuid, p_exclude_seat_id uuid, p_exclude_table_id uuid, p_exclude_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_concurrent_game_load(p_user_id uuid, p_exclude_seat_id uuid, p_exclude_table_id uuid, p_exclude_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_concurrent_game_load(p_user_id uuid, p_exclude_seat_id uuid, p_exclude_table_id uuid, p_exclude_tournament_id uuid) TO service_role;
-- @@END fn_concurrent_game_load(p_user_id uuid, p_exclude_seat_id uuid, p_exclude_table_id uuid, p_exclude_tournament_id uuid)

-- @@DOOR fn_diamond_bonus_spin_settled()
-- @@PIN md5=a9940a3b366ae705bd9178756c2f0b24 len=434 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_diamond_bonus_spin_settled()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF EXISTS(SELECT 1 FROM public.diamond_bonus_spin_tickets WHERE id=NEW.id AND funded_at IS NOT NULL AND redeemed_spin_id IS NULL) THEN
  RAISE EXCEPTION 'Mint Funding And Bonus Spin Redemption Must Commit Together';
 END IF;
 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_diamond_bonus_spin_settled() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_diamond_bonus_spin_settled() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_bonus_spin_settled() TO service_role;
-- @@END fn_diamond_bonus_spin_settled()

-- @@DOOR fn_diamond_bonus_spin_ticket_guard()
-- @@PIN md5=6771d97906576f09e64b58bd86e53d9e len=4468 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_diamond_bonus_spin_ticket_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE h record; m jsonb; c public.ca_daily_bonus_claims; s public.wheel_spins;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Bonus Spin Tickets Are Permanent Receipts'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO c FROM public.ca_daily_bonus_claims WHERE id=NEW.claim_id;
  IF c.id IS NULL OR c.user_id IS DISTINCT FROM NEW.user_id OR c.bonus_date IS DISTINCT FROM NEW.bonus_date
     OR c.slot<>7 OR c.granted->>'kind' IS DISTINCT FROM 'free_spin'
     OR c.granted->>'ticket_id' IS DISTINCT FROM NEW.id::text
     OR c.granted->>'funded_by' IS DISTINCT FROM 'mint'
     OR (c.granted->>'entry_diamonds')::integer IS DISTINCT FROM 100
     OR (c.granted->>'quantity')::integer IS DISTINCT FROM 1
     OR (c.result->>'streak')::integer IS DISTINCT FROM NEW.streak
     OR NEW.funded_at IS NOT NULL OR NEW.redeemed_at IS NOT NULL THEN
    RAISE EXCEPTION 'A Bonus Spin Requires Its Claimed Daily Reward';
  END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.user_id,NEW.claim_id,NEW.bonus_date,NEW.streak,NEW.entry_diamonds,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.claim_id,OLD.bonus_date,OLD.streak,OLD.entry_diamonds,OLD.created_at)
    OR OLD.redeemed_spin_id IS NOT NULL THEN
  RAISE EXCEPTION 'A Bonus Spin Receipt Cannot Be Rewritten';
 END IF;
 IF auth.uid() IS DISTINCT FROM OLD.user_id THEN RAISE EXCEPTION 'That Bonus Spin Belongs To Another Player' USING ERRCODE='42501'; END IF;
 IF OLD.funded_at IS NULL THEN
  IF NEW.funded_at IS NULL OR NEW.redeemed_spin_id IS NOT NULL THEN RAISE EXCEPTION 'Invalid Bonus Spin Funding Transition'; END IF;
  SELECT * INTO h FROM public.fn_wheel_host(NEW.club_id);
  IF h.host_id IS DISTINCT FROM NEW.host_id OR h.host_kind IS DISTINCT FROM NEW.host_kind
     OR public.fn_diamond_game_owner(h.host_id,h.host_kind) IS DISTINCT FROM NEW.owner_id
     OR NOT EXISTS(SELECT 1 FROM public.club_members WHERE club_id=NEW.club_id AND user_id=NEW.user_id AND COALESCE(status,'active') IN('active','approved'))
     OR NOT EXISTS(SELECT 1 FROM public.wheel_seed_commits WHERE id=NEW.commit_id AND user_id=NEW.user_id AND consumed_by IS NULL AND expires_at>=now()) THEN
    RAISE EXCEPTION 'Bonus Spin Funding Does Not Match Its Member And Host';
  END IF;
  NEW.mint_op_id := 'daily-bonus-spin:'||NEW.id::text;
  NEW.funded_at := transaction_timestamp();
  m := public.fn_ca_mint('diamonds','player',NEW.user_id,100,
        'Daily Bonus 100 Diamond Spin Entry For Claimed Ticket '||NEW.id::text,NEW.mint_op_id,'promotional');
  IF NOT COALESCE((m->>'ok')::boolean,false) OR (m->>'amount')::numeric IS DISTINCT FROM 100
     OR m->>'target_id' IS DISTINCT FROM NEW.user_id::text THEN
   RAISE EXCEPTION 'Daily Bonus Spin Funding Is Unavailable: %',COALESCE(m->>'reason','mint_refused') USING ERRCODE='PDS01';
  END IF;
 m:=public.deduct_diamonds(NEW.user_id,100,'Claimed Daily Bonus Spin Entry','daily_bonus_spin','diamond_game',
    jsonb_build_object('recipient_id',NEW.owner_id,'ticket_id',NEW.id),NEW.mint_op_id||':custody',0);
  IF COALESCE((m->>'success')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'Daily Spin Entry Transfer Failed'; END IF;
  PERFORM public.fn_diamond_spin_book(NEW.owner_id,NEW.club_id,NEW.host_id,NEW.host_kind,NEW.user_id,'mint_entry',100,
    NEW.mint_op_id||':intake','Mint Funded Claimed Daily Bonus Spin');
 ELSE
  IF (NEW.club_id,NEW.host_id,NEW.host_kind,NEW.owner_id,NEW.commit_id,NEW.client_seed,NEW.mint_op_id,NEW.funded_at)
     IS DISTINCT FROM (OLD.club_id,OLD.host_id,OLD.host_kind,OLD.owner_id,OLD.commit_id,OLD.client_seed,OLD.mint_op_id,OLD.funded_at)
     OR NEW.redeemed_spin_id IS NULL THEN RAISE EXCEPTION 'Bonus Spin Funding Cannot Be Changed'; END IF;
  SELECT * INTO s FROM public.wheel_spins WHERE id=NEW.redeemed_spin_id;
  IF s.id IS NULL OR s.bonus_ticket_id IS DISTINCT FROM NEW.id OR s.user_id IS DISTINCT FROM NEW.user_id
     OR s.club_id IS DISTINCT FROM NEW.club_id OR s.host_id IS DISTINCT FROM NEW.host_id
     OR s.commit_id IS DISTINCT FROM NEW.commit_id OR s.client_seed IS DISTINCT FROM NEW.client_seed
     OR s.is_welcome OR s.spin_price_diamonds<>100 OR s.diamond_accrual<>100 THEN
    RAISE EXCEPTION 'Bonus Spin Redemption Does Not Match Its Funded Entry';
  END IF;
  NEW.redeemed_at := transaction_timestamp();
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_diamond_bonus_spin_ticket_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_diamond_bonus_spin_ticket_guard() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_bonus_spin_ticket_guard() TO service_role;
-- @@END fn_diamond_bonus_spin_ticket_guard()

-- @@DOOR fn_diamond_game_owner(p_host uuid, p_kind text)
-- @@PIN md5=5c456eac1cbb3ea5e34362fc672fdf61 len=358 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_diamond_game_owner(p_host uuid, p_kind text)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN p_kind = 'union' THEN (SELECT u.owner_id FROM public.unions u WHERE u.id = p_host)
              ELSE (SELECT c.owner_id FROM public.clubs c WHERE c.id = p_host) END;
$function$;
ALTER FUNCTION public.fn_diamond_game_owner(p_host uuid, p_kind text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_diamond_game_owner(p_host uuid, p_kind text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_owner(p_host uuid, p_kind text) TO service_role;
-- @@END fn_diamond_game_owner(p_host uuid, p_kind text)

-- @@DOOR fn_diamond_game_reserved_cover_guard()
-- @@PIN md5=c7a4c4fa4763924d7f76d9f70656014e len=970 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_diamond_game_reserved_cover_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE host uuid; cover numeric; old_cover numeric; held numeric;
BEGIN
 IF TG_TABLE_NAME='clubs' THEN
  host:=NEW.id; cover:=GREATEST(COALESCE(NEW.promo_balance,0),0)+GREATEST(COALESCE(NEW.chip_treasury,0),0);
  old_cover:=GREATEST(COALESCE(OLD.promo_balance,0),0)+GREATEST(COALESCE(OLD.chip_treasury,0),0);
 ELSE
  host:=NEW.union_id; cover:=GREATEST(COALESCE(NEW.promo_wallet,0),0)+GREATEST(COALESCE(NEW.chip_balance,0),0);
  old_cover:=GREATEST(COALESCE(OLD.promo_wallet,0),0)+GREATEST(COALESCE(OLD.chip_balance,0),0);
 END IF;
 IF cover>=old_cover THEN RETURN NEW; END IF;
 SELECT COALESCE(sum(reserved_chips),0) INTO held FROM public.diamond_game_pools WHERE host_id=host;
 IF cover<held THEN RAISE EXCEPTION 'These Chips Are Reserved For Open Game Rounds'; END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_diamond_game_reserved_cover_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_diamond_game_reserved_cover_guard() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_reserved_cover_guard() TO service_role;
-- @@END fn_diamond_game_reserved_cover_guard()

-- @@DOOR fn_diamond_spin_book(p_owner uuid, p_club uuid, p_host uuid, p_kind text, p_player uuid, p_movement text, p_amount integer, p_operation text, p_description text, p_day date)
-- @@PIN md5=38656616c6d45879f62632734ea452e0 len=4941 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_diamond_spin_book(p_owner uuid, p_club uuid, p_host uuid, p_kind text, p_player uuid, p_movement text, p_amount integer, p_operation text, p_description text, p_day date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d date;prior public.diamond_spin_movements;bucket public.diamond_spin_days;
 balance_now numeric;liability numeric;incoming numeric;h record;move_id uuid;v_supply numeric;
BEGIN
 IF p_owner IS NULL OR p_player IS NULL OR p_amount IS NULL OR p_amount=0 OR p_operation IS NULL THEN
  RAISE EXCEPTION 'Invalid Diamond Spin Movement'; END IF;
 SELECT COALESCE(diamonds,0) INTO balance_now FROM public.profiles WHERE id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'The Diamond Spin Owner Wallet Is Missing'; END IF;
 SELECT * INTO prior FROM public.diamond_spin_movements WHERE operation_id=p_operation;
 IF prior.id IS NOT NULL THEN
  IF (prior.owner_id,prior.club_id,prior.host_id,prior.host_kind,prior.player_id,prior.kind,prior.amount,prior.description)
     IS DISTINCT FROM (p_owner,p_club,p_host,p_kind,p_player,p_movement,p_amount,p_description)
     OR (p_day IS NOT NULL AND p_day IS DISTINCT FROM prior.day) THEN
   RAISE EXCEPTION 'That Diamond Spin Movement Does Not Match Its Receipt'; END IF;
  RETURN jsonb_build_object('success',true,'idempotent',true,'movement_id',prior.id,'day',prior.day);
 END IF;
 SELECT * INTO h FROM public.fn_wheel_host(p_club);
 IF h.host_id IS DISTINCT FROM p_host OR h.host_kind IS DISTINCT FROM p_kind
  OR public.fn_diamond_game_owner(p_host,p_kind) IS DISTINCT FROM p_owner THEN
  RAISE EXCEPTION 'Diamond Spin Custody Does Not Match The Current Host Owner'; END IF;
 d:=COALESCE(p_day,(clock_timestamp() AT TIME ZONE 'America/Chicago')::date);
 IF d>(clock_timestamp() AT TIME ZONE 'America/Chicago')::date THEN RAISE EXCEPTION 'Future Diamond Spin Booking Is Invalid'; END IF;
 INSERT INTO public.diamond_spin_days(owner_id,day) VALUES(p_owner,d) ON CONFLICT DO NOTHING;
 SELECT * INTO bucket FROM public.diamond_spin_days WHERE owner_id=p_owner AND day=d FOR UPDATE;
 IF bucket.status<>'open' THEN RAISE EXCEPTION 'That Diamond Spin Day Is Already Settled'; END IF;
 SELECT COALESCE(sum(GREATEST(-pending_diamonds,0)),0),COALESCE(sum(GREATEST(pending_diamonds,0)),0)
  INTO liability,incoming FROM public.diamond_spin_days WHERE owner_id=p_owner AND day<>d AND status='open';
 IF balance_now<liability+GREATEST(-(bucket.pending_diamonds+p_amount),0) THEN
  RAISE EXCEPTION 'The Owner Must Fund This Diamond Spin Prize'; END IF;
 IF balance_now+incoming+GREATEST(bucket.pending_diamonds+p_amount,0)>2147483647 THEN
  RAISE EXCEPTION 'The Diamond Spin Wallet Has Reached Its Settlement Capacity'; END IF;
 INSERT INTO public.diamond_spin_movements(operation_id,owner_id,day,club_id,host_id,host_kind,player_id,kind,amount,description)
 VALUES(p_operation,p_owner,d,p_club,p_host,p_kind,p_player,p_movement,p_amount,p_description) RETURNING id INTO move_id;
 UPDATE public.diamond_spin_days SET pending_diamonds=pending_diamonds+p_amount,movement_count=movement_count+1,
 entry_diamonds=entry_diamonds+CASE WHEN p_movement='entry' THEN p_amount ELSE 0 END,
 bonus_diamonds=bonus_diamonds+CASE WHEN p_movement='bonus' THEN p_amount ELSE 0 END,
 mint_entry_diamonds=mint_entry_diamonds+CASE WHEN p_movement='mint_entry' THEN p_amount ELSE 0 END,
 diamond_prizes=diamond_prizes-CASE WHEN p_movement='diamond_prize' THEN p_amount ELSE 0 END,
 throwables=throwables-CASE WHEN p_movement='throwable' THEN p_amount ELSE 0 END,
 time_banks=time_banks-CASE WHEN p_movement='time_bank' THEN p_amount ELSE 0 END,
 rabbit_hunts=rabbit_hunts-CASE WHEN p_movement='rabbit_hunt' THEN p_amount ELSE 0 END,
 other_expenses=other_expenses-CASE WHEN p_movement='other_expense' THEN p_amount ELSE 0 END
 WHERE owner_id=p_owner AND day=d;
 IF p_movement IN('throwable','time_bank','rabbit_hunt','other_expense') THEN
  -- Actual consumption retires custody diamonds in the same canonical Mint
  -- register used by the existing inventory debit, without an owner wallet spam leg.
  SELECT public.fn_ca_mint_supply('diamonds')+p_amount INTO v_supply;
  INSERT INTO public.ca_mint_ledger(op_id,action,asset,holder_type,holder_id,holder_label,amount,
   balance_before,balance_after,supply_after,reason,performed_by,performed_by_label)
  VALUES('diamond-spin-custody:'||move_id,'burn','diamonds','player',p_owner,
   COALESCE((SELECT username FROM public.profiles WHERE id=p_owner),p_owner::text),-p_amount,
   bucket.pending_diamonds,bucket.pending_diamonds+p_amount,v_supply,'Diamond Spin Inventory: '||p_description,
   auth.uid(),COALESCE((SELECT username FROM public.profiles WHERE id=auth.uid()),auth.uid()::text));
 END IF;
 RETURN jsonb_build_object('success',true,'movement_id',move_id,'day',d,'pending_diamonds',bucket.pending_diamonds+p_amount);
END $function$;
ALTER FUNCTION public.fn_diamond_spin_book(p_owner uuid, p_club uuid, p_host uuid, p_kind text, p_player uuid, p_movement text, p_amount integer, p_operation text, p_description text, p_day date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_diamond_spin_book(p_owner uuid, p_club uuid, p_host uuid, p_kind text, p_player uuid, p_movement text, p_amount integer, p_operation text, p_description text, p_day date) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_diamond_spin_book(p_owner uuid, p_club uuid, p_host uuid, p_kind text, p_player uuid, p_movement text, p_amount integer, p_operation text, p_description text, p_day date)

-- @@DOOR fn_diamond_spin_immutable()
-- @@PIN md5=b09270d05e3717a6cef16c4c58a94275 len=817 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_diamond_spin_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF TG_OP='DELETE' OR TG_TABLE_NAME='diamond_spin_movements' THEN
  RAISE EXCEPTION 'Diamond Spin Statements And Movements Are Permanent';
 END IF;
 IF OLD.status='settled' THEN
  RAISE EXCEPTION 'Diamond Spin Statements And Movements Are Permanent';
 END IF;
 IF (NEW.owner_id,NEW.day,NEW.created_at) IS DISTINCT FROM (OLD.owner_id,OLD.day,OLD.created_at) THEN
  RAISE EXCEPTION 'Diamond Spin Custody Identity Cannot Change';
 END IF;
 IF (OLD.status='open' AND NEW.status NOT IN('open','settling')) OR (OLD.status='settling' AND NEW.status<>'settled') THEN
  RAISE EXCEPTION 'Invalid Diamond Spin Settlement Transition';
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_diamond_spin_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_diamond_spin_immutable() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_diamond_spin_immutable()

-- @@DOOR fn_diamond_spin_profit_burn(p_net bigint, p_bps integer)
-- @@PIN md5=948e5f01e70562ecb4d47d64c20bbedd len=278 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_diamond_spin_profit_burn(p_net bigint, p_bps integer)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
 SELECT CASE WHEN p_net>0 AND p_bps>0 THEN (p_net*p_bps)/10000 ELSE 0 END
$function$;
ALTER FUNCTION public.fn_diamond_spin_profit_burn(p_net bigint, p_bps integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_diamond_spin_profit_burn(p_net bigint, p_bps integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spin_profit_burn(p_net bigint, p_bps integer) TO authenticated, service_role;
-- @@END fn_diamond_spin_profit_burn(p_net bigint, p_bps integer)

-- @@DOOR fn_diamond_spin_profit_burn_bps()
-- @@PIN md5=6ab8a99820e64de356f9d303927752ca len=194 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_diamond_spin_profit_burn_bps()
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$ SELECT 2000 $function$;
ALTER FUNCTION public.fn_diamond_spin_profit_burn_bps() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_diamond_spin_profit_burn_bps() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spin_profit_burn_bps() TO authenticated, service_role;
-- @@END fn_diamond_spin_profit_burn_bps()

-- @@DOOR fn_diamond_spin_settlement_receipt()
-- @@PIN md5=903adaa2b5861b5927223429fd300a14 len=2508 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_diamond_spin_settlement_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d public.diamond_spin_days;burn_rows integer;
BEGIN
 SELECT * INTO d FROM public.diamond_spin_days WHERE owner_id=NEW.owner_id AND day=NEW.day;
 IF d.status='settling' THEN RAISE EXCEPTION 'Diamond Spin Settlement Is Incomplete'; END IF;
 IF d.status='settled' THEN
  IF d.profit_burn_bps<>public.fn_diamond_spin_profit_burn_bps()
   OR d.profit_burn<>public.fn_diamond_spin_profit_burn(d.settled_net,d.profit_burn_bps)
   OR d.credited_net<>d.settled_net-d.profit_burn THEN
   RAISE EXCEPTION 'Diamond Spin Settlement Burn Is Not The Current Rate'; END IF;
  IF d.credited_net<>0 AND NOT EXISTS(SELECT 1 FROM public.diamond_transactions t
   WHERE t.id=d.wallet_transaction_id AND t.user_id=d.owner_id AND t.amount=d.credited_net
    AND t.reference_id='diamond-spin-day:'||d.owner_id||':'||d.day AND t.issuance_class='transferred') THEN
   RAISE EXCEPTION 'Diamond Spin Settlement Has No Matching Wallet Receipt'; END IF;
  IF d.credited_net=0 AND d.wallet_transaction_id IS NOT NULL THEN
   RAISE EXCEPTION 'Diamond Spin Settlement Has A Wallet Receipt For Nothing'; END IF;
  SELECT count(*) INTO burn_rows FROM public.ca_mint_ledger m
   WHERE m.op_id='diamond-spin-burn:'||d.owner_id||':'||d.day AND m.action='burn' AND m.asset='diamonds'
    AND m.holder_type='player' AND m.holder_id=d.owner_id AND m.amount=d.profit_burn;
  IF (d.profit_burn>0 AND burn_rows<>1) OR (d.profit_burn=0 AND EXISTS(SELECT 1 FROM public.ca_mint_ledger m WHERE m.op_id='diamond-spin-burn:'||d.owner_id||':'||d.day)) THEN
   RAISE EXCEPTION 'Diamond Spin Settlement Has No Matching Profit Burn'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.notifications n WHERE n.id=d.notification_id AND n.user_id=d.owner_id
   AND n.type='diamond_spin_settlement' AND n.data->>'day'=d.day::text
   AND (n.data->>'net_diamonds')::bigint=d.settled_net
   AND (n.data->>'profit_burn')::bigint=d.profit_burn
   AND (n.data->>'credited_net')::bigint=d.credited_net
   AND n.data->>'_push' IS NOT NULL) THEN
   RAISE EXCEPTION 'Diamond Spin Settlement Has No Matching Notification'; END IF;
  IF EXISTS(SELECT 1 FROM public.push_outbox p WHERE p.related_entity_id=d.notification_id OR p.accounting_notification_id=d.notification_id) THEN
   RAISE EXCEPTION 'Diamond Spin Settlement Must Not Push To The Phone'; END IF;
 END IF;
 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_diamond_spin_settlement_receipt() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_diamond_spin_settlement_receipt() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_diamond_spin_settlement_receipt()

-- @@DOOR fn_diamond_spin_wallet_reserve()
-- @@PIN md5=f13ec6ac7915261efc4170ac3f16a655 len=994 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_diamond_spin_wallet_reserve()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE owed numeric;incoming numeric;
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM public.diamond_spin_days WHERE owner_id=OLD.id AND status='open') THEN
   RAISE EXCEPTION 'Settle Diamond Spins Before Removing This Wallet' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
 END IF;
 SELECT COALESCE(sum(GREATEST(-pending_diamonds,0)),0),COALESCE(sum(GREATEST(pending_diamonds,0)),0)
  INTO owed,incoming FROM public.diamond_spin_days WHERE owner_id=NEW.id AND status='open';
 IF COALESCE(NEW.diamonds,0)<owed THEN
  RAISE EXCEPTION 'These Diamonds Back Unsettled Diamond Spin Prizes' USING ERRCODE='23514';
 END IF;
 IF COALESCE(NEW.diamonds,0)+incoming>2147483647 THEN
  RAISE EXCEPTION 'This Wallet Must Leave Room For Its Diamond Spin Settlement' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_diamond_spin_wallet_reserve() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_diamond_spin_wallet_reserve() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_diamond_spin_wallet_reserve()

-- @@DOOR fn_enforce_four_table_limit()
-- @@PIN md5=817fb0550497afd5347b936a3cbb5bb9 len=2352 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_enforce_four_table_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_live       int;
  v_is_closed  boolean;
  v_tournament uuid;
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- A MOVE WITHIN ONE GAME IS NOT A FIFTH GAME (2026-09-05). Only the cluster
  -- executor sets this, for the one transaction in which a player changes
  -- chairs inside a game they are already in. It replaces the 041000 rule
  -- ("holds another live seat in this cluster"), which also let a player buy
  -- a second seat into a game they were already sitting in.
  IF current_setting('app.cash_seat_move', true) = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT (t.status = 'closed'), t.tournament_id
    INTO v_is_closed, v_tournament
    FROM public.tables t
   WHERE t.id = NEW.table_id;
  IF COALESCE(v_is_closed, false) THEN
    RETURN NEW;
  END IF;

  /* THE ENTRY WAS ALREADY APPROVED AT THE DOOR (2026-09-09). An active
     entrant taking a chair in their own event is that entry being honoured,
     whether it is their first chair or their fifth move. The cap on entering
     lives in fn_enforce_booking_game_cap, which is the gate that can still
     say no while saying no is free. */
  IF v_tournament IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = v_tournament
          AND p.user_id = NEW.user_id
          AND p.status IN ('registered', 'playing')
     ) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || NEW.user_id::text, 0));

  v_live := public.fn_concurrent_game_load(NEW.user_id, NEW.id, NEW.table_id, v_tournament);

  IF v_live >= 4 THEN
    RAISE EXCEPTION
      'FOUR TABLE LIMIT: user % is already committed to % games and may not take another',
      NEW.user_id, v_live
      USING ERRCODE = '23514',
            HINT = 'Leave a table or unregister before joining another. A game is a live seat or a booking for a tournament that has not started. This limit applies to players and horses alike. A chair in an event you are already entered in is the entry being honoured and is never refused here.';
  END IF;

  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_enforce_four_table_limit() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_enforce_four_table_limit() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_enforce_four_table_limit() TO service_role;
-- @@END fn_enforce_four_table_limit()

-- @@DOOR fn_enforce_tournament_capacity()
-- @@PIN md5=c89a358115c8cd06ff93cfffc2aab84f len=2967 owner=postgres
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
  PERFORM public.fn_ca_tournament_is_unlimited(NEW.tournament_id);
  /* UNDER THE ROW LOCK (2026-09-06). This read the tournament without one, so
     two entries arriving together could both see room and both be admitted.
     Parent before child - the order every registration door already uses. */
  SELECT max_players, name, status, COALESCE(variant, '')
    INTO v_max, v_name, v_status, v_variant
    FROM public.tournaments WHERE id = NEW.tournament_id
    FOR NO KEY UPDATE;

  -- No declared capacity means no capacity to exceed (open MTTs).
  IF public.fn_ca_tournament_is_unlimited(NEW.tournament_id)
     OR v_max IS NULL OR v_max <= 0 THEN
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
$function$;
ALTER FUNCTION public.fn_enforce_tournament_capacity() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_enforce_tournament_capacity() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_enforce_tournament_capacity() TO service_role;
-- @@END fn_enforce_tournament_capacity()

-- @@DOOR fn_get_seat_cashout_receipt(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_occupancy_id uuid)
-- @@PIN md5=49d452fa253d5ac059a199284f4ce806 len=1058 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_get_seat_cashout_receipt(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_occupancy_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '5s'
AS $function$
DECLARE v_previous public.seat_cashout_receipts%ROWTYPE;
BEGIN
  IF NOT coalesce(public.fn_caller_is_engine(),false) THEN
    RAISE EXCEPTION 'Engine authority required' USING ERRCODE='42501';
  END IF;
  IF p_user_id IS NULL OR p_table_id IS NULL OR p_seat_number IS NULL OR p_occupancy_id IS NULL THEN
    RAISE EXCEPTION 'CASHOUT_OCCUPANCY_REQUIRED' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_previous FROM public.seat_cashout_receipts WHERE occupancy_id=p_occupancy_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_previous.user_id <> p_user_id OR v_previous.table_id <> p_table_id
     OR v_previous.seat_number <> p_seat_number THEN
    RAISE EXCEPTION 'CASHOUT_OCCUPANCY_SCOPE_MISMATCH' USING ERRCODE='22023';
  END IF;
  RETURN v_previous.receipt;
END;
$function$;
ALTER FUNCTION public.fn_get_seat_cashout_receipt(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_occupancy_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_get_seat_cashout_receipt(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_occupancy_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_get_seat_cashout_receipt(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_occupancy_id uuid) TO service_role;
-- @@END fn_get_seat_cashout_receipt(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_occupancy_id uuid)

-- @@DOOR fn_guard_horse_profile_authority()
-- @@PIN md5=515acecbbd2af70b7d3384c83c468fad len=1320 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_guard_horse_profile_authority()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- SET ROLE survives nested SECURITY DEFINER calls; current_user does not.
  -- Retain the originating browser role when an older RPC loses/clears its
  -- JWT context. The shared helper alone falls back to the definer's owner.
  IF coalesce(current_setting('role', true), 'none') NOT IN ('anon', 'authenticated')
     AND public.fn_is_service_context() IS TRUE THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Preserve normal owner signup, including the nullable legacy defaults.
    IF coalesce(NEW.is_horse, false) IS NOT FALSE
       OR coalesce(NEW.horse_profile, '{}'::jsonb) IS DISTINCT FROM '{}'::jsonb
       OR coalesce(NEW.horse_status, 'available') IS DISTINCT FROM 'available' THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'Horse profile authority is server only';
    END IF;
  ELSIF NEW.is_horse IS DISTINCT FROM OLD.is_horse
     OR NEW.horse_profile IS DISTINCT FROM OLD.horse_profile
     OR NEW.horse_status IS DISTINCT FROM OLD.horse_status THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Horse profile authority is server only';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_guard_horse_profile_authority() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_guard_horse_profile_authority() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_guard_horse_profile_authority() TO service_role;
-- @@END fn_guard_horse_profile_authority()

-- @@DOOR fn_guard_managed_game_lifecycle()
-- @@PIN md5=b90cc1cb27839211a82715c4741410c1 len=4263 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_guard_managed_game_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_engine boolean := COALESCE(auth.role(), '') = 'service_role';
  v_managed_command boolean :=
    COALESCE(current_setting('app.managed_game_lifecycle', true), '') = 'on';
  v_protected_tournament_keys text[] := ARRAY[
    'name', 'start_time', 'max_players', 'buy_in_amount', 'buy_in_fee',
    'guaranteed_prize', 'late_reg_mins', 'starting_chips', 'blind_structure',
    'payout_structure', 'game_type', 'variant', 'tournament_type', 'is_rebuy',
    'rebuy_cost', 'rebuy_chips', 'rebuy_levels', 'add_on_available',
    'addon_cost', 'addon_chips', 'is_bounty', 'bounty_amount', 'is_pko',
    'is_mystery_bounty', 'mystery_bounty_min', 'mystery_bounty_max',
    'description', 'short_description', 'min_players', 'late_reg_levels',
    'is_reentry', 'max_rebuys', 'max_reentries', 'addon_levels',
    'addon_break_minutes', 'is_private', 'is_vip_only', 'ban_chat',
    'all_in_or_fold', 'label_as_new', 'hide_club_name', 'is_pinned',
    'action_time_seconds', 'table_size', 'accelerated_mtt', 'big_blind_ante',
    'authorized_to_register', 'early_bird_enabled', 'early_bird_chips',
    'bubble_protection', 'final_table_deal_enabled', 'restart_every_minutes',
    'synchronized_breaks', 'is_multi_day', 'total_days', 'is_xmtt',
    'union_id', 'satellite_target_id', 'satellite_seats', 'spin_type',
    'mystery_bounty_profile', 'mystery_bounty_activation',
    'mystery_bounty_activation_value', 'mystery_bounty_pool_percent',
    'mystery_bounty_top_percent', 'settings'
  ];
  v_key text;
  v_new_document jsonb;
  v_old_document jsonb;
BEGIN
  IF TG_TABLE_NAME = 'tables' THEN
    IF lower(COALESCE(NEW.status, '')) IN ('closed', 'deleted')
       AND lower(COALESCE(OLD.status, '')) NOT IN ('closed', 'deleted')
       AND EXISTS (
         SELECT 1
         FROM public.table_seats ts
         WHERE ts.table_id = NEW.id
           AND ts.left_at IS NULL
       ) THEN
      RAISE EXCEPTION 'This table cannot be closed while players are seated'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT v_is_engine
       AND NOT v_managed_command
       AND (
         lower(COALESCE(NEW.status, '')) = 'deleted'
         AND lower(COALESCE(OLD.status, '')) <> 'deleted'
         OR COALESCE(NEW.is_deleted, false) AND NOT COALESCE(OLD.is_deleted, false)
       ) THEN
      RAISE EXCEPTION 'Table lifecycle changes must use fn_close_managed_game'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'tournaments'
     AND EXISTS (
       SELECT 1
       FROM public.tournament_players tp
       WHERE tp.tournament_id = NEW.id
     ) THEN
    IF NOT v_is_engine
       AND upper(COALESCE(NEW.status, '')) IN ('CANCELLED', 'CANCELED')
       AND upper(COALESCE(OLD.status, '')) NOT IN ('CANCELLED', 'CANCELED')
       -- DIAMOND PHASE 10: platform staff cancel a Diamond event through
       -- fn_poker_diamond_cancel_tournament, which names that one event here,
       -- in its own transaction, around the Diamond cancellation authority
       -- that first returns every entry from its own custody row.
       AND COALESCE(current_setting('app.poker_diamond_staff_cancel', true), '') IS DISTINCT FROM NEW.id::text THEN
      RAISE EXCEPTION 'This tournament cannot be cancelled after a player has registered'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT v_is_engine THEN
      v_new_document := to_jsonb(NEW);
      v_old_document := to_jsonb(OLD);
      FOREACH v_key IN ARRAY v_protected_tournament_keys LOOP
        IF (v_new_document -> v_key) IS DISTINCT FROM (v_old_document -> v_key) THEN
          RAISE EXCEPTION 'This tournament cannot be modified after a player has registered'
            USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF NOT v_is_engine
     AND NOT v_managed_command
     AND upper(COALESCE(NEW.status, '')) IN ('CANCELLED', 'CANCELED')
     AND upper(COALESCE(OLD.status, '')) NOT IN ('CANCELLED', 'CANCELED') THEN
    RAISE EXCEPTION 'Tournament lifecycle changes must use fn_close_managed_game'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_guard_managed_game_lifecycle() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_guard_managed_game_lifecycle() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_guard_managed_game_lifecycle() TO service_role;
-- @@END fn_guard_managed_game_lifecycle()

-- @@DOOR fn_guard_profile_privileged_columns()
-- @@PIN md5=d40c547c47f3d0516dc24f22ab53da7e len=3480 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_guard_profile_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_changed text;
  v_stack text;
BEGIN
  IF public.fn_is_service_context() THEN RETURN NEW; END IF;

  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  IF v_stack ~ 'function (public[.])?deduct_diamonds[(]'
     OR v_stack ~ 'function (public[.])?fn_union_send_to_member[(]'
     OR v_stack ~ 'function (public[.])?claim_daily_challenge[(]'
     OR v_stack ~ 'function (public[.])?claim_daily_challenges[(]'
     OR v_stack ~ 'function (public[.])?fn_ca_daily_bonus_claim[(]'
     OR v_stack ~ 'function (public[.])?fn_ca_daily_bonus_boost_extra[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_spin[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_free_spin[(]'
     OR v_stack ~ 'function (public[.])?fn_plinko_drop[(]'
     OR v_stack ~ 'function (public[.])?fn_crash_start[(]'
     OR v_stack ~ 'function (public[.])?fn_diamond_game_take_bet[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_spin_core[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_spin_v2[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_diamond_cards_pick[(]'
     OR v_stack ~ 'function (public[.])?fn_diamond_bonus_share_to_feed[(]'
     OR v_stack ~ 'function (public[.])?fn_ca_mint[(]'
     OR v_stack ~ 'function (public[.])?fn_ca_burn[(]'
     OR v_stack ~ 'function (public[.])?send_stream_gift[(]'
     OR v_stack ~ 'function (public[.])?fn_arena_deposit[(]'
     OR v_stack ~ 'function (public[.])?fn_arena_withdraw[(]'
     -- DIAMOND PHASE 8: a tournament entry is custody; its charge and refund
     -- move the wallet from client doors.
     OR v_stack ~ 'function (public[.])?fn_poker_diamond_tournament_charge[(]'
     OR v_stack ~ 'function (public[.])?fn_poker_diamond_tournament_refund[(]'
     -- RULING 4 (amended 2026-09-08): the player-to-player wallet transfer. It runs under the
     -- sender's JWT, journals both legs and writes both wallets itself, and it is the one
     -- authenticated door for a transfer; unnamed here it answered 42501 to every player.
     OR v_stack ~ 'function (public[.])?send_wallet_diamond_transfer[(]'
     -- DIAMOND PHASE 11: a player's Diamond cash buy-in. atomic_table_buyin runs under the
     -- player's JWT and reaches the wallet only through fn_poker_diamond_buyin, whose one
     -- wallet write is fn_poker_diamond_reserve's journaled deposit; unnamed here, every
     -- client buy-in answered 42501 at that write.
     OR v_stack ~ 'function (public[.])?fn_poker_diamond_buyin[(]'
  THEN
    RETURN NEW;
  END IF;

  IF NEW.diamonds IS DISTINCT FROM OLD.diamonds THEN v_changed := 'diamonds';
  ELSIF NEW.diamond_balance IS DISTINCT FROM OLD.diamond_balance THEN v_changed := 'diamond_balance';
  ELSIF NEW.diamond_multiplier IS DISTINCT FROM OLD.diamond_multiplier THEN v_changed := 'diamond_multiplier';
  ELSIF NEW.is_vip IS DISTINCT FROM OLD.is_vip THEN v_changed := 'is_vip';
  ELSIF NEW.vip_tier IS DISTINCT FROM OLD.vip_tier THEN v_changed := 'vip_tier';
  ELSIF NEW.vip_expires_at IS DISTINCT FROM OLD.vip_expires_at THEN v_changed := 'vip_expires_at';
  END IF;

  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION
      'profiles.% is server-managed and cannot be modified by role %',
      v_changed, current_user
      USING ERRCODE = '42501',
            HINT = 'Use a server-authoritative, ledgered money RPC.';
  END IF;

  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_guard_profile_privileged_columns() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_guard_profile_privileged_columns() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_guard_profile_privileged_columns() TO service_role;
-- @@END fn_guard_profile_privileged_columns()

-- @@DOOR fn_is_owner_operational_notification(p_user uuid, p_type text, p_title text, p_data jsonb)
-- @@PIN md5=8c2c62359d92dcbd3b3621a762b981ca len=922 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_is_owner_operational_notification(p_user uuid, p_type text, p_title text, p_data jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT COALESCE(p_user='47965354-0e56-43ef-931c-ddaab82af765'::uuid AND (
    p_type IN ('financial_incident','financial_incident_resolved','financial_attestation',
      'engine_break_failed','engine_break_recovered','guarantee_bank_short',
      'guarantee_bank_recovered','estate_digest')
    OR (p_type='system' AND (
      p_title IN ('Push Health Alert','Notifications May Not Be Reaching This Device')
      OR p_title ~ '^Horse Fleet (Alert|Recovered): '
      OR (jsonb_typeof(p_data)='object' AND p_data->>'component'='club-arena-engine'
        AND jsonb_typeof(p_data->'alertname')='string' AND NULLIF(p_data->>'alertname','') IS NOT NULL)
    ))
  ),false);
$function$;
ALTER FUNCTION public.fn_is_owner_operational_notification(p_user uuid, p_type text, p_title text, p_data jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_is_owner_operational_notification(p_user uuid, p_type text, p_title text, p_data jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_is_owner_operational_notification(p_user uuid, p_type text, p_title text, p_data jsonb) TO anon, authenticated, service_role;
-- @@END fn_is_owner_operational_notification(p_user uuid, p_type text, p_title text, p_data jsonb)

-- @@DOOR fn_kill_pot_configuration_refusal(p_kill_mode text, p_variant text, p_game_type text, p_tournament_id uuid, p_bomb_pot_enabled boolean, p_big_blind numeric, p_club_id uuid)
-- @@PIN md5=c5f1d7f6361676b0ed0780e8ca9394a2 len=1801 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_kill_pot_configuration_refusal(p_kill_mode text, p_variant text, p_game_type text, p_tournament_id uuid, p_bomb_pot_enabled boolean, p_big_blind numeric, p_club_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_diamond boolean := p_club_id IS NOT DISTINCT FROM '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid;
  v_minor numeric;
BEGIN
  IF p_kill_mode IS NULL OR p_kill_mode NOT IN ('off','half','full') THEN
    RETURN 'Kill Mode Must Be Off, Half Or Full';
  END IF;
  IF p_kill_mode = 'off' THEN
    RETURN NULL;
  END IF;
  IF p_tournament_id IS NOT NULL OR lower(coalesce(p_game_type, '')) = 'tournament' THEN
    RETURN 'Kill Pots Are Only Available At Cash Tables';
  END IF;
  IF lower(coalesce(p_variant, '')) NOT IN ('flh','flo8') THEN
    RETURN 'Kill Pots Need Fixed Limit Hold''em Or Fixed Limit Omaha Hi-Lo';
  END IF;
  IF coalesce(p_bomb_pot_enabled, false) THEN
    RETURN 'Kill Pots Cannot Be Combined With Bomb Pots';
  END IF;
  -- kill-v1 exactness: the base big blind in minor units (cents, or whole
  -- Diamonds) times the multiplier must be an integer. Full is 2/1, half 3/2.
  v_minor := p_big_blind * CASE WHEN v_diamond THEN 1 ELSE 100 END;
  IF v_minor IS NULL OR v_minor <= 0 OR v_minor <> trunc(v_minor) THEN
    RETURN CASE WHEN v_diamond THEN 'Kill Pots Need A Big Blind Of Whole Diamonds'
                ELSE 'Kill Pots Need A Big Blind Of Whole Cents' END;
  END IF;
  IF p_kill_mode = 'half' AND mod(v_minor, 2) <> 0 THEN
    RETURN CASE WHEN v_diamond THEN 'Half Kill Needs An Even Number Of Diamonds As The Big Blind'
                ELSE 'Half Kill Needs A Big Blind That Is An Even Number Of Cents' END;
  END IF;
  RETURN NULL;
END
$function$;
ALTER FUNCTION public.fn_kill_pot_configuration_refusal(p_kill_mode text, p_variant text, p_game_type text, p_tournament_id uuid, p_bomb_pot_enabled boolean, p_big_blind numeric, p_club_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_kill_pot_configuration_refusal(p_kill_mode text, p_variant text, p_game_type text, p_tournament_id uuid, p_bomb_pot_enabled boolean, p_big_blind numeric, p_club_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_kill_pot_configuration_refusal(p_kill_mode text, p_variant text, p_game_type text, p_tournament_id uuid, p_bomb_pot_enabled boolean, p_big_blind numeric, p_club_id uuid) TO authenticated, service_role;
-- @@END fn_kill_pot_configuration_refusal(p_kill_mode text, p_variant text, p_game_type text, p_tournament_id uuid, p_bomb_pot_enabled boolean, p_big_blind numeric, p_club_id uuid)

-- @@DOOR fn_lightning_anchor_is_live_eligible(p_seat_id uuid, p_cluster_id uuid, p_player_id uuid)
-- @@PIN md5=a121611dd69437875e82a06832715981 len=795 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_lightning_anchor_is_live_eligible(p_seat_id uuid, p_cluster_id uuid, p_player_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.table_seats ts
      JOIN public.tables tb ON tb.id = ts.table_id
     WHERE ts.id = p_seat_id
       AND tb.cluster_id = p_cluster_id AND coalesce(tb.is_deleted, false) = false
       AND coalesce(tb.lifecycle, '') <> 'closed'
       AND ts.left_at IS NULL
       AND ts.user_id IS NOT NULL
       AND (p_player_id IS NULL OR ts.user_id = p_player_id)
       AND coalesce(ts.is_sitting_out, false) = false
       AND coalesce(ts.leave_pending, false) = false
       AND coalesce(ts.stack, 0) > 0);
$function$;
ALTER FUNCTION public.fn_lightning_anchor_is_live_eligible(p_seat_id uuid, p_cluster_id uuid, p_player_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_anchor_is_live_eligible(p_seat_id uuid, p_cluster_id uuid, p_player_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_anchor_is_live_eligible(p_seat_id uuid, p_cluster_id uuid, p_player_id uuid) TO service_role;
-- @@END fn_lightning_anchor_is_live_eligible(p_seat_id uuid, p_cluster_id uuid, p_player_id uuid)

-- @@DOOR fn_lightning_hand_is_immutable()
-- @@PIN md5=fd227015ee402f9d680dd1f45776a2bb len=4851 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_lightning_hand_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LIGHTNING_HAND_IS_NOT_DELETABLE: hand % was formed at % and is a fact; a hand that can be deleted is a participant set that can be substituted by deleting and re-forming it',
      OLD.hand_id, OLD.formed_at USING ERRCODE = 'check_violation';
  END IF;

  -- THE LATCH IS NOT A THING A HAND CAN BE BORN WITH (2026-09-26). This
  -- trigger used to fire on UPDATE and DELETE only, so "the latch may only be
  -- set over a set that is really there" was a rule about UPDATE: a hand
  -- INSERTed already locked at player_count 6 over no participant rows was
  -- accepted, could never be given a participant, and could be dealt. The
  -- latch goes on in barrier step 10's UPDATE, over rows that exist, or not at
  -- all. The versions are NOT NULL and CHECKed by the table, so they need
  -- nothing here on the way in.
  IF TG_OP = 'INSERT' THEN
    IF NEW.participants_locked_at IS NOT NULL OR NEW.player_count IS NOT NULL THEN
      RAISE EXCEPTION 'LIGHTNING_HAND_IS_BORN_UNLOCKED: hand % was inserted already carrying the latch (participants_locked_at %, player_count %), which is barrier step 10 performed before the participants it counts exist; a hand born locked can never be given the set it claims',
        NEW.hand_id, NEW.participants_locked_at, NEW.player_count USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.hand_id IS DISTINCT FROM OLD.hand_id
     OR NEW.cluster_id IS DISTINCT FROM OLD.cluster_id
     OR NEW.cluster_epoch IS DISTINCT FROM OLD.cluster_epoch
     OR NEW.lightning_instance_id IS DISTINCT FROM OLD.lightning_instance_id
     OR NEW.formed_at IS DISTINCT FROM OLD.formed_at THEN
    RAISE EXCEPTION 'LIGHTNING_HAND_IS_IMMUTABLE: hand % may not have its identity, Cluster, epoch, instance or formation time rewritten',
      OLD.hand_id USING ERRCODE = 'check_violation';
  END IF;

  -- THE VERSIONS THE HAND WAS FORMED UNDER ARE PART OF WHAT IT IS
  -- (2026-09-26). Specification 2137-2143; stamped at step 7 in the INSERT
  -- that creates the hand, so they are frozen from birth rather than from the
  -- latch - there is no moment at which rewriting one is formation.
  IF NEW.rules_version IS DISTINCT FROM OLD.rules_version
     OR NEW.matcher_version IS DISTINCT FROM OLD.matcher_version
     OR NEW.blind_algorithm_version IS DISTINCT FROM OLD.blind_algorithm_version
     OR NEW.lightning_version IS DISTINCT FROM OLD.lightning_version
     OR NEW.rake_version IS DISTINCT FROM OLD.rake_version
     -- and the request it was formed for (2026-09-26)
     OR NEW.request_id IS DISTINCT FROM OLD.request_id THEN
    RAISE EXCEPTION 'LIGHTNING_HAND_IS_IMMUTABLE: hand % was formed under rules %, matcher %, blind algorithm %, lightning % and rake %, and the versions it was formed under may not be rewritten',
      OLD.hand_id, OLD.rules_version, OLD.matcher_version, OLD.blind_algorithm_version,
      OLD.lightning_version, OLD.rake_version USING ERRCODE = 'check_violation';
  END IF;

  -- THE LATCH IS ONE-WAY. Clearing it would unlock every rule in
  -- fn_lightning_hand_player_is_immutable in a single UPDATE, which is the one
  -- bypass that would make all four of them decorative.
  IF OLD.participants_locked_at IS NOT NULL
     AND NEW.participants_locked_at IS DISTINCT FROM OLD.participants_locked_at THEN
    RAISE EXCEPTION 'LIGHTNING_HAND_IS_IMMUTABLE: hand % locked its participant set at % and the latch may not be cleared or moved',
      OLD.hand_id, OLD.participants_locked_at USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.participants_locked_at IS NOT NULL
     AND NEW.player_count IS DISTINCT FROM OLD.player_count THEN
    RAISE EXCEPTION 'LIGHTNING_HAND_IS_IMMUTABLE: hand % locked % participants and that count may not be rewritten',
      OLD.hand_id, OLD.player_count USING ERRCODE = 'check_violation';
  END IF;

  -- THE LATCH MAY ONLY BE SET OVER A SET THAT IS REALLY THERE. Without this a
  -- caller could lock a hand at a player_count that does not match the rows,
  -- and every later reader would believe a set of two was a set of six.
  IF OLD.participants_locked_at IS NULL AND NEW.participants_locked_at IS NOT NULL THEN
    IF NEW.player_count IS DISTINCT FROM
       (SELECT count(*)::smallint FROM public.lightning_hand_player hp WHERE hp.hand_id = NEW.hand_id) THEN
      RAISE EXCEPTION 'LIGHTNING_HAND_IS_IMMUTABLE: hand % was locked at player_count % over % participant row(s)',
        NEW.hand_id, NEW.player_count,
        (SELECT count(*) FROM public.lightning_hand_player hp WHERE hp.hand_id = NEW.hand_id)
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;
ALTER FUNCTION public.fn_lightning_hand_is_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_hand_is_immutable() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_hand_is_immutable() TO service_role;
-- @@END fn_lightning_hand_is_immutable()

-- @@DOOR fn_lightning_hand_player_is_immutable()
-- @@PIN md5=0566b91631683ff6c7448a75baf59ee7 len=4236 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_lightning_hand_player_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_hand   uuid;
  v_locked timestamp with time zone;
BEGIN
  -- OLD is unassigned in a BEFORE INSERT trigger and reading it raises, so the
  -- hand is taken from the right record before anything else happens.
  IF TG_OP = 'DELETE' THEN v_hand := OLD.hand_id; ELSE v_hand := NEW.hand_id; END IF;

  -- THE HAND A ROW LEAVES IS ASKED TOO (2026-09-26). Judged by NEW alone, an
  -- UPDATE moving a participant OUT of a locked hand into an unlocked one was
  -- an edit to an unlocked hand, and passed. A row whose OLD hand is latched
  -- keeps its hand_id, whatever hand it is being moved to.
  IF TG_OP = 'UPDATE' AND NEW.hand_id IS DISTINCT FROM OLD.hand_id
     AND EXISTS (SELECT 1 FROM public.lightning_hand oh
                  WHERE oh.hand_id = OLD.hand_id AND oh.participants_locked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'LIGHTNING_HAND_PLAYER_IS_IMMUTABLE: player % of locked hand % may not be moved to hand %; the participant set of a locked hand is fixed',
      OLD.player_id, OLD.hand_id, NEW.hand_id USING ERRCODE = 'check_violation';
  END IF;

  SELECT h.participants_locked_at INTO v_locked
    FROM public.lightning_hand h WHERE h.hand_id = v_hand;

  -- An unlocked hand is a hand the barrier is still assembling. Everything
  -- below is about what happens AFTER the barrier, which is exactly what the
  -- latch records.
  IF v_locked IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'LIGHTNING_NO_ADDITIONAL_PLAYER_INSERTION: hand % locked its participant set at %, and player % arrived for seat % afterwards',
      v_hand, v_locked, NEW.player_id, NEW.seat USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LIGHTNING_NO_PARTICIPANT_SUBSTITUTION: hand % locked its participant set at %, and removing player % from seat % would substitute the set the hand was formed with',
      v_hand, v_locked, OLD.player_id, OLD.seat USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.player_id IS DISTINCT FROM OLD.player_id
     OR NEW.pool_slot_id IS DISTINCT FROM OLD.pool_slot_id THEN
    RAISE EXCEPTION 'LIGHTNING_NO_PARTICIPANT_SUBSTITUTION: hand % seat % was formed for player % in slot % and may not become player % in slot %',
      v_hand, OLD.seat, OLD.player_id, OLD.pool_slot_id, NEW.player_id, NEW.pool_slot_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.seat IS DISTINCT FROM OLD.seat THEN
    RAISE EXCEPTION 'LIGHTNING_NO_SILENT_SEAT_SWAP: hand % seated player % at seat % and may not move them to seat %',
      v_hand, OLD.player_id, OLD.seat, NEW.seat USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.position IS DISTINCT FROM OLD.position
     OR NEW.blind_role IS DISTINCT FROM OLD.blind_role THEN
    RAISE EXCEPTION 'LIGHTNING_NO_BLIND_REASSIGNMENT: hand % gave player % position %/blind role % at formation and may not reassign them to %/%',
      v_hand, OLD.player_id, OLD.position, OLD.blind_role, NEW.position, NEW.blind_role
      USING ERRCODE = 'check_violation';
  END IF;

  -- stack_before is the snapshot the blinds are posted against, and hand_id,
  -- cluster_id and cluster_epoch are the bindings barrier steps 7, 8 and 9
  -- made. Rewriting any of them after the fact is a different hand wearing
  -- this one's primary key.
  IF NEW.hand_id IS DISTINCT FROM OLD.hand_id
     OR NEW.cluster_id IS DISTINCT FROM OLD.cluster_id
     OR NEW.cluster_epoch IS DISTINCT FROM OLD.cluster_epoch
     OR NEW.stack_before IS DISTINCT FROM OLD.stack_before THEN
    RAISE EXCEPTION 'LIGHTNING_HAND_PLAYER_IS_IMMUTABLE: hand % player % may not have its hand, Cluster, epoch or stack_before rewritten after the formation barrier',
      v_hand, OLD.player_id USING ERRCODE = 'check_violation';
  END IF;

  -- Everything not named above stays writable, and the two that matter are
  -- fold_type and stack_after: they are the hand being PLAYED, which is the
  -- reason it was formed. A barrier that froze them would freeze the game.
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.fn_lightning_hand_player_is_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_hand_player_is_immutable() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_hand_player_is_immutable() TO service_role;
-- @@END fn_lightning_hand_player_is_immutable()

-- @@DOOR fn_lightning_instance_is_disciplined()
-- @@PIN md5=bcb27a1044e4e71846d0a9aa2805ae30 len=7149 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_lightning_instance_is_disciplined()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'forming' THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_IS_BORN_FORMING: instance for Cluster % was inserted in state % rather than forming, so the formation barrier it is supposed to pass through has already been skipped',
        NEW.cluster_id, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.hand_id IS NOT NULL THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_IS_BORN_EMPTY: instance for Cluster % was inserted already carrying hand %, which is barrier step 8 performed before steps 1 to 7',
        NEW.cluster_id, NEW.hand_id USING ERRCODE = 'check_violation';
    END IF;

    SELECT id, cluster_mode, lightning_enabled, cluster_epoch
      INTO g FROM public.cash_games WHERE id = NEW.cluster_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_HAS_NO_CLUSTER: instance names Cluster % which does not exist',
        NEW.cluster_id USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- coalesce on lightning_enabled because the column is a nullable-shaped
    -- added boolean in the general case and `NOT x` over NULL is NULL, which
    -- an IF takes as false and which would admit exactly the Cluster this
    -- refuses.
    IF g.cluster_mode IS DISTINCT FROM 'lightning'
       OR coalesce(g.lightning_enabled, false) = false THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_CLUSTER_IS_NOT_LIGHTNING: Cluster % is in cluster_mode % with lightning_enabled %, and a hand formed for it would be dealt at tables that are still dealing cash',
        NEW.cluster_id, g.cluster_mode, coalesce(g.lightning_enabled, false)
        USING ERRCODE = 'check_violation';
    END IF;

    -- BARRIER STEP 9. The foreign key into cash_cluster_epoch proves the epoch
    -- EXISTED. It does not prove it is the epoch the Cluster is in now, and a
    -- conversion, a revert or a re-conversion moves that number under a
    -- matcher that read it a moment ago.
    IF NEW.cluster_epoch IS DISTINCT FROM g.cluster_epoch THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_EPOCH_IS_NOT_CURRENT: instance for Cluster % bound epoch % while the Cluster is at epoch %',
        NEW.cluster_id, NEW.cluster_epoch, g.cluster_epoch USING ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e
                    WHERE e.cluster_id = NEW.cluster_id AND e.epoch = NEW.cluster_epoch
                      AND e.ended_at IS NULL) THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_EPOCH_IS_NOT_CURRENT: epoch % of Cluster % has ended, or was never opened, so nothing may be formed inside it',
        NEW.cluster_epoch, NEW.cluster_id USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.cluster_id IS DISTINCT FROM OLD.cluster_id
     OR NEW.cluster_epoch IS DISTINCT FROM OLD.cluster_epoch
     OR NEW.target_size IS DISTINCT FROM OLD.target_size
     OR NEW.max_size IS DISTINCT FROM OLD.max_size
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'LIGHTNING_INSTANCE_IS_IMMUTABLE: instance % may not have its Cluster, epoch, target size, max size or creation time rewritten',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;

  -- hand_id IS WRITE-ONCE. Re-pointing an instance at a second hand is
  -- participant substitution performed one level up, where none of the
  -- lightning_hand_player rules can see it.
  IF OLD.hand_id IS NOT NULL AND NEW.hand_id IS DISTINCT FROM OLD.hand_id THEN
    RAISE EXCEPTION 'LIGHTNING_NO_PARTICIPANT_SUBSTITUTION: instance % is bound to hand % and may not be re-pointed at %',
      OLD.id, OLD.hand_id, NEW.hand_id USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT ((OLD.state = 'forming'  AND NEW.state IN ('reserved', 'abandoned'))
         OR (OLD.state = 'reserved' AND NEW.state IN ('dealing', 'abandoned'))
         OR (OLD.state = 'dealing'  AND NEW.state IN ('settling', 'abandoned'))
         OR (OLD.state = 'settling' AND NEW.state IN ('complete', 'abandoned'))) THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_STATE_IS_NOT_REVERSIBLE: instance % may not go from % to %',
        OLD.id, OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.state IN ('reserved', 'dealing', 'settling', 'complete') AND NEW.hand_id IS NULL THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_HAS_NO_HAND: instance % reached % with no hand bound, so barrier step 8 never happened',
        OLD.id, NEW.state USING ERRCODE = 'check_violation';
    END IF;

    -- BARRIER STEP 13'S PRECONDITION, stated where nothing can route around
    -- it: a hand is released into gameplay only once its participant set is
    -- locked. The shuffle and the deal are the engine's and are not in this
    -- database at all.
    IF NEW.state = 'dealing'
       AND NOT EXISTS (SELECT 1 FROM public.lightning_hand h
                        WHERE h.hand_id = NEW.hand_id AND h.participants_locked_at IS NOT NULL) THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_HAS_AN_UNLOCKED_HAND: instance % tried to begin dealing hand % whose participant set is not locked',
        OLD.id, NEW.hand_id USING ERRCODE = 'check_violation';
    END IF;

    -- A LOCKED HAND IS NOT ENOUGH (2026-09-26). The branch above asks only
    -- whether the latch is set, and a latch is a claim: a hand born locked at
    -- player_count 6 over no rows passed it and was dealt empty. A hand is
    -- released into gameplay only when its count, its participant rows and its
    -- instance's committed reservations are the same number. begin_dealing
    -- checks this too, and this is where it is true of every other road.
    IF NEW.state = 'dealing'
       AND EXISTS (SELECT 1 FROM public.lightning_hand h
                    WHERE h.hand_id = NEW.hand_id
                      AND (h.player_count IS NULL
                           OR h.player_count IS DISTINCT FROM
                              (SELECT count(*)::smallint FROM public.lightning_hand_player hp WHERE hp.hand_id = h.hand_id)
                           OR h.player_count IS DISTINCT FROM
                              (SELECT count(*)::smallint FROM public.lightning_reservation r
                                WHERE r.lightning_instance_id = NEW.id AND r.state = 'committed'))) THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_HAND_SET_DOES_NOT_AGREE: instance % tried to begin dealing hand % locked at player_count % over % participant row(s) and % committed reservation(s)',
        OLD.id, NEW.hand_id,
        (SELECT h.player_count FROM public.lightning_hand h WHERE h.hand_id = NEW.hand_id),
        (SELECT count(*) FROM public.lightning_hand_player hp WHERE hp.hand_id = NEW.hand_id),
        (SELECT count(*) FROM public.lightning_reservation r
          WHERE r.lightning_instance_id = NEW.id AND r.state = 'committed')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;
ALTER FUNCTION public.fn_lightning_instance_is_disciplined() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_instance_is_disciplined() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_instance_is_disciplined() TO service_role;
-- @@END fn_lightning_instance_is_disciplined()

-- @@DOOR fn_lightning_instance_releases_its_reservations()
-- @@PIN md5=5f870992841c2734f24109f4f9f799a9 len=2397 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_lightning_instance_releases_its_reservations()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_players uuid[];
BEGIN
  -- WHY THIS IS A TRIGGER AND NOT A LINE IN fn_lightning_instance_abandon.
  -- lightning_reservation_one_active_per_player makes a committed reservation
  -- a standing bar on that player being matched again. The bar has to come off
  -- on EVERY road into a terminal state - abandon, the reaper, and the
  -- settlement phase that has not been written yet - and a road that forgets
  -- would take a player out of the pool permanently with no row saying why.
  WITH released AS (
    UPDATE public.lightning_reservation r
       SET state = 'released',
           resolved_at = clock_timestamp(),
           reason = coalesce(r.reason, 'instance_' || NEW.state)
     WHERE r.lightning_instance_id = NEW.id
       AND r.state IN ('pending', 'committed')
    RETURNING r.player_id)
  SELECT coalesce(array_agg(released.player_id ORDER BY released.player_id), ARRAY[]::uuid[])
    INTO v_players FROM released;

  -- SPECIFICATION EVENTS (2026-09-26): how the instance ended, and who it
  -- gave back, in one row each.
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
  VALUES (NEW.cluster_id,
          CASE WHEN NEW.state = 'complete' THEN 'instance_completed' ELSE 'instance_destroyed' END,
          jsonb_build_object(
            'cluster_id', NEW.cluster_id, 'cluster_epoch', NEW.cluster_epoch,
            'instance_id', NEW.id, 'hand_id', NEW.hand_id,
            'from_state', OLD.state, 'to_state', NEW.state, 'reason', NEW.abandon_reason,
            'hand_voided', NEW.state = 'abandoned' AND OLD.state IN ('dealing', 'settling'),
            'players', to_jsonb(v_players), 'at', clock_timestamp()),
          NEW.cluster_epoch);
  IF cardinality(v_players) > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
    VALUES (NEW.cluster_id, 'pool_player_released', jsonb_build_object(
      'cluster_id', NEW.cluster_id, 'cluster_epoch', NEW.cluster_epoch,
      'instance_id', NEW.id, 'hand_id', NEW.hand_id, 'players', to_jsonb(v_players),
      'reason', coalesce(NEW.abandon_reason, 'instance_' || NEW.state), 'at', clock_timestamp()),
      NEW.cluster_epoch);
  END IF;
  RETURN NULL;
END
$function$;
ALTER FUNCTION public.fn_lightning_instance_releases_its_reservations() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_instance_releases_its_reservations() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_instance_releases_its_reservations() TO service_role;
-- @@END fn_lightning_instance_releases_its_reservations()

-- @@DOOR fn_lightning_player_in_hand(p_player_id uuid, p_cluster_id uuid)
-- @@PIN md5=36e38991a83968c97a8d69f5e7ee0549 len=529 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_lightning_player_in_hand(p_player_id uuid, p_cluster_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.lightning_reservation r
      JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
     WHERE r.cluster_id = p_cluster_id
       AND r.player_id = p_player_id
       AND r.state = 'committed'
       AND i.state IN ('forming', 'reserved', 'dealing', 'settling'));
$function$;
ALTER FUNCTION public.fn_lightning_player_in_hand(p_player_id uuid, p_cluster_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_player_in_hand(p_player_id uuid, p_cluster_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_player_in_hand(p_player_id uuid, p_cluster_id uuid) TO service_role;
-- @@END fn_lightning_player_in_hand(p_player_id uuid, p_cluster_id uuid)

-- @@DOOR fn_lightning_pool_enter(p_seat_id uuid, p_now timestamp with time zone)
-- @@PIN md5=5a4547a38c09b1823a8f0d6e1d4ef13d len=2837 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_lightning_pool_enter(p_seat_id uuid, p_now timestamp with time zone DEFAULT clock_timestamp())
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s     record;
  g     record;
  v_ps  uuid;
  v_cps uuid;
  v_now timestamptz := LEAST(coalesce(p_now, clock_timestamp()), clock_timestamp());
BEGIN
  SELECT ts.id, ts.user_id, ts.table_id, ts.stack, tb.cluster_id
    INTO s
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE ts.id = p_seat_id;
  IF NOT FOUND OR s.cluster_id IS NULL OR s.user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT cg.id, cg.cluster_mode, cg.lightning_enabled, cg.cluster_epoch
    INTO g FROM public.cash_games cg WHERE cg.id = s.cluster_id;
  IF NOT FOUND OR g.cluster_mode IS DISTINCT FROM 'lightning'
     OR coalesce(g.lightning_enabled, false) = false THEN
    RETURN NULL;
  END IF;

  IF NOT public.fn_lightning_anchor_is_live_eligible(s.id, g.id, s.user_id) THEN
    RETURN NULL;
  END IF;

  SELECT ps.id INTO v_ps
    FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = g.id AND ps.player_id = s.user_id AND ps.exited_at IS NULL;
  IF v_ps IS NOT NULL THEN
    PERFORM public.fn_lightning_pool_slot_open(v_ps, v_now);
    RETURN v_ps;
  END IF;

  SELECT cps.id INTO v_cps
    FROM public.cash_player_session cps
   WHERE cps.player_id = s.user_id AND cps.closed_at IS NULL
     AND (cps.cluster_id = g.id
          OR cps.scope_id IN (SELECT t.id FROM public.tables t WHERE t.cluster_id = g.id)
          OR cps.table_id IN (SELECT t.id FROM public.tables t WHERE t.cluster_id = g.id))
   ORDER BY coalesce(cps.cluster_id = g.id, false) DESC, cps.opened_at DESC, cps.id
   LIMIT 1;
  IF v_cps IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    INSERT INTO public.lightning_pool_session
      (cluster_id, cluster_epoch, player_id, cash_player_session_id, state, entered_at,
       starting_stack, anchor_seat_id)
    VALUES (g.id, g.cluster_epoch, s.user_id, v_cps, 'active', v_now, s.stack, s.id)
    RETURNING id INTO v_ps;
  EXCEPTION WHEN unique_violation THEN
    SELECT ps.id INTO v_ps
      FROM public.lightning_pool_session ps
     WHERE ps.cluster_id = g.id AND ps.player_id = s.user_id AND ps.exited_at IS NULL;
    RETURN v_ps;
  END;

  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload, cluster_epoch)
  VALUES (g.id, s.table_id, 'pool_player_joined', jsonb_build_object(
    'cluster_id', g.id, 'cluster_epoch', g.cluster_epoch, 'player_id', s.user_id,
    'pool_session_id', v_ps, 'anchor_seat_id', s.id, 'starting_stack', s.stack,
    'cash_player_session_id', v_cps, 'via', 'fn_lightning_pool_enter', 'at', v_now), g.cluster_epoch);

  PERFORM public.fn_lightning_pool_slot_open(v_ps, v_now);
  RETURN v_ps;
END
$function$;
ALTER FUNCTION public.fn_lightning_pool_enter(p_seat_id uuid, p_now timestamp with time zone) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_pool_enter(p_seat_id uuid, p_now timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pool_enter(p_seat_id uuid, p_now timestamp with time zone) TO service_role;
-- @@END fn_lightning_pool_enter(p_seat_id uuid, p_now timestamp with time zone)

-- @@DOOR fn_lightning_pool_slot_holds_its_history()
-- @@PIN md5=f4a88b83619bb67f2d7ca2ccc18e46df len=1292 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_lightning_pool_slot_holds_its_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- THE HOLE THIS CLOSES IS A CASCADE, AND IT IS IN THE SCHEMA ALREADY.
  -- lightning_reservation_belongs_to_its_slot is ON DELETE CASCADE, so
  -- deleting a pool slot silently erases every reservation ever taken against
  -- it - including committed ones, which are the record of who was in a hand.
  -- lightning_hand_player's own foreign key is RESTRICT, so the hand side is
  -- already safe and the reservation side was not.
  IF EXISTS (SELECT 1 FROM public.lightning_reservation r WHERE r.pool_slot_id = OLD.id) THEN
    RAISE EXCEPTION 'LIGHTNING_POOL_SLOT_HOLDS_A_RESERVATION: pool slot % of player % has reservations recorded against it, and deleting it would cascade them away; close the slot instead',
      OLD.id, OLD.player_id USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.lightning_hand_player hp WHERE hp.pool_slot_id = OLD.id) THEN
    RAISE EXCEPTION 'LIGHTNING_POOL_SLOT_HOLDS_A_RESERVATION: pool slot % of player % sat in a formed hand and may not be deleted',
      OLD.id, OLD.player_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$function$;
ALTER FUNCTION public.fn_lightning_pool_slot_holds_its_history() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_pool_slot_holds_its_history() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pool_slot_holds_its_history() TO service_role;
-- @@END fn_lightning_pool_slot_holds_its_history()

-- @@DOOR fn_lightning_pool_slot_idle_since_starts_at_open()
-- @@PIN md5=2612b685586f262126202063e25d02cb len=444 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_lightning_pool_slot_idle_since_starts_at_open()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- A column default cannot name another column, so the default is here: a
  -- slot is idle from the moment it opens unless its writer says later.
  NEW.idle_since := GREATEST(coalesce(NEW.idle_since, NEW.opened_at), NEW.opened_at);
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.fn_lightning_pool_slot_idle_since_starts_at_open() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_pool_slot_idle_since_starts_at_open() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pool_slot_idle_since_starts_at_open() TO service_role;
-- @@END fn_lightning_pool_slot_idle_since_starts_at_open()

-- @@DOOR fn_lightning_pool_slot_open(p_pool_session_id uuid, p_now timestamp with time zone)
-- @@PIN md5=115bd4194acc7d337e13d6eb6e699a9a len=4338 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_lightning_pool_slot_open(p_pool_session_id uuid, p_now timestamp with time zone DEFAULT clock_timestamp())
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  ps      record;
  v_slot  uuid;
  v_closed integer := 0;
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'opened', false, 'reason', 'platform_frozen');
  END IF;

  SELECT s.id, s.cluster_id, s.cluster_epoch, s.player_id, s.state, s.exited_at
    INTO ps FROM public.lightning_pool_session s WHERE s.id = p_pool_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'opened', false, 'reason', 'no_such_pool_session');
  END IF;
  IF ps.exited_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'opened', false, 'reason', 'pool_session_has_exited');
  END IF;

  -- IDEMPOTENT ON PURPOSE. This is called from a sync pass that may run twice
  -- in the same second, from two workers, during a deploy. An existing open
  -- slot is the right answer, not a unique violation.
  -- A SESSION FROM A DEAD EPOCH OPENS NOTHING (2026-09-26). The sync pass only
  -- offers sessions at the Cluster's current epoch, but this is callable on its
  -- own, and a slot at a dead epoch is one the barrier can never use and the
  -- one-open-per-player index will not let the player replace.
  IF ps.cluster_epoch IS DISTINCT FROM
     (SELECT g.cluster_epoch FROM public.cash_games g WHERE g.id = ps.cluster_id) THEN
    RETURN jsonb_build_object('ok', false, 'opened', false,
                              'reason', 'pool_session_epoch_is_not_current',
                              'pool_session_epoch', ps.cluster_epoch);
  END IF;

  -- IDEMPOTENT ON THE POOL SESSION (2026-09-26), not on the player. The read
  -- used to be keyed on (Cluster, player, open), so a player who left and came
  -- back - a new pool session - was answered already_open with the slot of the
  -- session that had exited, and one who survived an epoch bump with a slot
  -- at the dead epoch.
  SELECT sl.id INTO v_slot FROM public.lightning_pool_slot sl
   WHERE sl.cluster_id = ps.cluster_id AND sl.player_id = ps.player_id
     AND sl.closed_at IS NULL
     AND sl.pool_session_id = ps.id AND sl.cluster_epoch = ps.cluster_epoch;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'opened', false, 'reason', 'already_open',
                              'pool_slot_id', v_slot);
  END IF;

  -- ANY OTHER OPEN SLOT OF THIS PLAYER IN THIS CLUSTER IS STALE, and is closed
  -- here, in this call, rather than left for a sync pass: it is bound to a
  -- session that has gone or an epoch that has ended, and while it stays open
  -- lightning_pool_slot_one_open_per_player refuses the slot this player
  -- actually needs. A hand in flight that sat in it is untouched - the hand
  -- names the slot by id, and the player's committed reservation still bars a
  -- second hand until that one ends.
  UPDATE public.lightning_pool_slot sl
     SET closed_at = GREATEST(p_now, sl.opened_at),
         close_reason = CASE WHEN sl.cluster_epoch IS DISTINCT FROM ps.cluster_epoch
                             THEN 'epoch_advanced' ELSE 'superseded_by_pool_session' END,
         updated_at = p_now
   WHERE sl.cluster_id = ps.cluster_id AND sl.player_id = ps.player_id
     AND sl.closed_at IS NULL;
  GET DIAGNOSTICS v_closed = ROW_COUNT;

  -- slot 1, ALWAYS, and the header says why: lightning_pool_slot.slot ranges
  -- 1..24 because the pool was designed for a player to hold several
  -- concurrent seats, and specification 725 forbids a player holding more than
  -- one active reservation in a session. The column keeps its range so that
  -- the day the specification changes, only an index moves.
  INSERT INTO public.lightning_pool_slot
    (pool_session_id, cluster_id, cluster_epoch, player_id, slot, opened_at, updated_at)
  VALUES (ps.id, ps.cluster_id, ps.cluster_epoch, ps.player_id, 1, p_now, p_now)
  RETURNING id INTO v_slot;

  RETURN jsonb_build_object('ok', true, 'opened', true, 'pool_slot_id', v_slot,
                            'player_id', ps.player_id, 'cluster_id', ps.cluster_id,
                            'cluster_epoch', ps.cluster_epoch,
                            'stale_slots_closed', v_closed);
END
$function$;
ALTER FUNCTION public.fn_lightning_pool_slot_open(p_pool_session_id uuid, p_now timestamp with time zone) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_pool_slot_open(p_pool_session_id uuid, p_now timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pool_slot_open(p_pool_session_id uuid, p_now timestamp with time zone) TO service_role;
-- @@END fn_lightning_pool_slot_open(p_pool_session_id uuid, p_now timestamp with time zone)

-- @@DOOR fn_lightning_refuses_truncate()
-- @@PIN md5=28d568ccc181e2e5389ed52d9855b16f len=818 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_lightning_refuses_truncate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- A STATEMENT-LEVEL BEFORE TRUNCATE trigger, because row triggers do not
  -- fire on TRUNCATE and every immutability rule in Phase 9 is a row trigger.
  -- It fires for every role, the owner included, and for a TRUNCATE that
  -- arrives by CASCADE. History is closed, not deleted.
  RAISE EXCEPTION 'LIGHTNING_HISTORY_IS_NOT_TRUNCATABLE: TRUNCATE of %.% was refused; row triggers do not fire on TRUNCATE, so it would erase in one statement every hand, participant, instance, reservation, slot, pool session or blind ledger row the row triggers exist to keep',
    TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END
$function$;
ALTER FUNCTION public.fn_lightning_refuses_truncate() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_refuses_truncate() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_refuses_truncate() TO service_role;
-- @@END fn_lightning_refuses_truncate()

-- @@DOOR fn_lightning_reservation_end_marks_the_slot_idle()
-- @@PIN md5=c583f2b677bcb99fa292346ee9543d5d len=1031 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_lightning_reservation_end_marks_the_slot_idle()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- ONLY A HAND THAT WAS DEALT sends a player to the back of the queue: an
  -- instance with started_at (begin_dealing stamped it) that completed, was
  -- abandoned mid-hand, or - Phase 8 - released a fast fold. A formation
  -- abandoned before it was dealt, and a pending claim the reaper expired,
  -- dealt the player nothing, so they keep their P4 place. Forward only.
  IF NOT EXISTS (SELECT 1 FROM public.lightning_instance i
                  WHERE i.id = NEW.lightning_instance_id AND i.started_at IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  UPDATE public.lightning_pool_slot sl
     SET idle_since = GREATEST(sl.idle_since, coalesce(NEW.resolved_at, clock_timestamp()))
   WHERE sl.id = NEW.pool_slot_id
     AND sl.closed_at IS NULL
     AND sl.idle_since < coalesce(NEW.resolved_at, clock_timestamp());
  RETURN NULL;
END
$function$;
ALTER FUNCTION public.fn_lightning_reservation_end_marks_the_slot_idle() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_reservation_end_marks_the_slot_idle() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_reservation_end_marks_the_slot_idle() TO service_role;
-- @@END fn_lightning_reservation_end_marks_the_slot_idle()

-- @@DOOR fn_lightning_reservation_is_disciplined()
-- @@PIN md5=cdea144431df670a2ea87fd0d5ae35ee len=2854 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_lightning_reservation_is_disciplined()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_epoch integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'LIGHTNING_RESERVATION_IS_BORN_PENDING: reservation for player % was inserted in state %, so it was never a claim anybody could lose a race for',
        NEW.player_id, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.lightning_pool_slot sl
                    WHERE sl.id = NEW.pool_slot_id AND sl.closed_at IS NULL) THEN
      RAISE EXCEPTION 'LIGHTNING_RESERVATION_SLOT_IS_CLOSED: player % was reserved against pool slot % which is closed, so they have already left the pool',
        NEW.player_id, NEW.pool_slot_id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.lightning_instance_id IS NOT NULL THEN
      SELECT i.cluster_epoch INTO v_epoch FROM public.lightning_instance i WHERE i.id = NEW.lightning_instance_id;
      IF v_epoch IS DISTINCT FROM NEW.cluster_epoch THEN
        RAISE EXCEPTION 'LIGHTNING_RESERVATION_CROSSES_AN_EPOCH: reservation at epoch % names instance % which runs at epoch %',
          NEW.cluster_epoch, NEW.lightning_instance_id, v_epoch USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.player_id IS DISTINCT FROM OLD.player_id
     OR NEW.cluster_id IS DISTINCT FROM OLD.cluster_id
     OR NEW.cluster_epoch IS DISTINCT FROM OLD.cluster_epoch
     OR NEW.pool_slot_id IS DISTINCT FROM OLD.pool_slot_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'LIGHTNING_RESERVATION_IS_IMMUTABLE: reservation % may not have its identity, player, Cluster, epoch, slot or creation time rewritten',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.lightning_instance_id IS NOT NULL
     AND NEW.lightning_instance_id IS DISTINCT FROM OLD.lightning_instance_id THEN
    RAISE EXCEPTION 'LIGHTNING_RESERVATION_IS_IMMUTABLE: reservation % is bound to instance % and may not be moved to %',
      OLD.id, OLD.lightning_instance_id, NEW.lightning_instance_id USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT ((OLD.state = 'pending'   AND NEW.state IN ('committed', 'released', 'expired'))
         OR (OLD.state = 'committed' AND NEW.state = 'released')) THEN
      RAISE EXCEPTION 'LIGHTNING_RESERVATION_STATE_IS_NOT_REVERSIBLE: reservation % may not go from % to %; a released or expired claim that can become pending again is a claim two matchers can both hold',
        OLD.id, OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;
ALTER FUNCTION public.fn_lightning_reservation_is_disciplined() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_reservation_is_disciplined() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_reservation_is_disciplined() TO service_role;
-- @@END fn_lightning_reservation_is_disciplined()

-- @@DOOR fn_log_seat_stack_exit()
-- @@PIN md5=9ef7dad056ad5b5e745200ca83170c04 len=1854 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_log_seat_stack_exit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_stack numeric;
  v_kind  text;
BEGIN
  IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
            WHERE t.id=OLD.table_id AND c.asset='diamonds') THEN
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- A departed seat being tidied up is not an exit: its stack left when
    -- left_at was stamped, and that is already recorded below.
    IF OLD.left_at IS NOT NULL THEN RETURN OLD; END IF;
    v_stack := COALESCE(OLD.stack, 0);
    v_kind  := 'deleted';
  ELSE
    IF OLD.left_at IS NOT NULL OR NEW.left_at IS NULL THEN RETURN NEW; END IF;
    v_stack := COALESCE(OLD.stack, 0);
    v_kind  := 'left';
  END IF;

  IF v_stack <= 0 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- CASH ONLY. A tournament stack is play money inside the event -- it credits
  -- no wallet when the seat ends, so it cannot be lost in the sense this table
  -- exists to detect. Filtering HERE rather than in the report keeps ~2,000
  -- meaningless rows an hour out of the audit trail entirely.
  IF EXISTS (SELECT 1 FROM public.tables t
              WHERE t.id = OLD.table_id AND t.tournament_id IS NOT NULL) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  INSERT INTO public.ca_seat_stack_exits
    (seat_id, table_id, user_id, club_id, seat_number, stack, exit_kind, db_role, app_name)
  VALUES (OLD.id, OLD.table_id, OLD.user_id, OLD.club_id, OLD.seat_number,
          v_stack, v_kind, current_user,
          NULLIF(current_setting('application_name', true), ''));

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;
ALTER FUNCTION public.fn_log_seat_stack_exit() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_log_seat_stack_exit() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_log_seat_stack_exit() TO service_role;
-- @@END fn_log_seat_stack_exit()

-- @@DOOR fn_mirror_notification_to_push_outbox()
-- @@PIN md5=37d724277900f53d00db14fb3c5cd04d len=8865 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_mirror_notification_to_push_outbox()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE notice public.notifications%ROWTYPE; receipt record; existing public.push_outbox%ROWTYPE;
 v_tag text;v_pending int;state text:='pending';reason text;
 c_max_pending CONSTANT int:=20;c_max_age CONSTANT interval:=interval '30 minutes';
BEGIN
 -- Delivery rows are inserted AFTER their notification. Wait until the whole
 -- transaction is ready to commit before granting the canonical exception.
 IF TG_NAME<>'trg_accounting_push_after_delivery' AND NEW.type='accounting_invoice' THEN RETURN NEW; END IF;
 SELECT * INTO notice FROM public.notifications WHERE id=NEW.id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT d.invoice_id,d.recipient_id,d.delivery_mode,m.conversation_id,m.message_type,m.media_metadata,
  i.invoice_number,i.net_amount,i.invoice_type INTO receipt
 FROM public.accounting_invoice_deliveries d JOIN public.settlement_invoices i ON i.id=d.invoice_id
 JOIN public.social_messages m ON m.id=d.message_id WHERE d.notification_id=notice.id;
 IF FOUND THEN
  -- A real receipt foreign key, exact recipient and issued document are
  -- required. Arbitrary accounting-looking JSON cannot bypass normal caps.
  IF receipt.recipient_id IS DISTINCT FROM notice.user_id
   OR notice.data->>'invoice_id' IS DISTINCT FROM receipt.invoice_id::text
   OR notice.data->>'invoice_number' IS DISTINCT FROM receipt.invoice_number
   OR notice.data->'amount' IS DISTINCT FROM to_jsonb(receipt.net_amount)
   OR receipt.message_type IS DISTINCT FROM 'invoice'
   OR receipt.media_metadata->>'invoice_id' IS DISTINCT FROM receipt.invoice_id::text
   OR COALESCE(notice.data->>'conversation_id',notice.data->>'conversationId') IS DISTINCT FROM receipt.conversation_id::text
   OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.conversation_id=receipt.conversation_id AND p.user_id=notice.user_id)
  THEN RAISE EXCEPTION 'accounting_push_receipt_provenance_invalid' USING ERRCODE='23514'; END IF;
  IF receipt.delivery_mode='weekly_detail' OR notice.type='accounting_invoice_detail' THEN
   state:='skipped';reason:='accounting_archived_detail';
  ELSIF notice.type IS DISTINCT FROM 'accounting_invoice' THEN
   RAISE EXCEPTION 'accounting_push_notification_type_invalid' USING ERRCODE='23514';
  ELSIF notice.data->>'_push' IS NOT NULL THEN
   state:='skipped';reason:='accounting_source_suppressed:'||(notice.data->>'_push');
  ELSIF notice.created_at<now()-c_max_age THEN
   state:='skipped';reason:='accounting_historical_notification';
  ELSIF notice.user_id='47965354-0e56-43ef-931c-ddaab82af765'::uuid THEN
   -- Same owner-operational recipient fn_is_owner_operational_notification()
   -- hard-codes (kept as a literal here, not a shared call, because that
   -- classifier also gates on p_type and would return false for
   -- 'accounting_invoice' -- this is not a second source of truth for WHO
   -- the owner is, only a second reference to the same fixed id). This is
   -- his issuer-side owner/union-owner copy of a receipt whose real payee is
   -- someone else; it must NOT be added to fn_is_owner_operational_
   -- notification's type list, or the capture trigger fires once per
   -- receipt (hundreds per settlement) instead of once per hour, and the
   -- non-accounting mirror predicate below would wrongly suppress it too.
   state:='skipped';reason:='owner_accounting_routed_to_production_alerts';
  END IF;
  SELECT * INTO existing FROM public.push_outbox WHERE accounting_notification_id=notice.id;
  IF FOUND THEN
   IF existing.recipient_user_id IS DISTINCT FROM notice.user_id OR existing.related_entity_id IS DISTINCT FROM notice.id
    OR existing.event IS DISTINCT FROM 'accounting_invoice' THEN RAISE EXCEPTION 'accounting_push_receipt_collision' USING ERRCODE='23514'; END IF;
   IF receipt.invoice_type IN('cashier_cashout','accounting_correction','credit_limit_change') AND ROW(existing.title,existing.body,existing.url,existing.tag) IS DISTINCT FROM
     ROW(left(notice.title,120),left(COALESCE(notice.message,notice.title),500),
       COALESCE(NULLIF(btrim(notice.link),''),NULLIF(btrim(notice.action_url),''),'/hub'),
       'accounting_invoice:'||receipt.conversation_id::text)
   THEN RAISE EXCEPTION 'cashier_push_content_mismatch' USING ERRCODE='23514';END IF;
   RETURN NEW;
  END IF;
  -- No exception swallowing here. The invoice, message, notification, linked
  -- transfer and durable outbox receipt commit together or all roll back.
  -- Normal dispatcher preference, quiet-hour, device and consent gates remain.
  INSERT INTO public.push_outbox(recipient_user_id,title,body,url,event,tag,status,failure_reason,related_entity_id,accounting_notification_id)
  VALUES(notice.user_id,left(notice.title,120),left(COALESCE(notice.message,notice.title),500),
   COALESCE(NULLIF(btrim(notice.link),''),NULLIF(btrim(notice.action_url),''),'/hub'),
   'accounting_invoice','accounting_invoice:'||receipt.conversation_id::text,state,reason,notice.id,notice.id);
  IF reason='owner_accounting_routed_to_production_alerts' THEN
   -- Informational only, coalesced to one row per UTC hour. Must never be
   -- able to roll back the invoice/message/notification/outbox insert above.
   BEGIN
    PERFORM public.fn_record_operational_alert('owner-accounting-notifications',
     'owner-accounting:'||to_char(date_trunc('hour',now() AT TIME ZONE 'UTC'),'YYYY-MM-DD"T"HH24'),
     'Accounting Documents Issued (Owner Copy)','info','info',
     jsonb_build_object('first_notification_id',notice.id,'invoice_number',receipt.invoice_number,
      'invoice_type',receipt.invoice_type,'amount',receipt.net_amount,
      'conversation_id',receipt.conversation_id,
      'hour',to_char(date_trunc('hour',now() AT TIME ZONE 'UTC'),'YYYY-MM-DD"T"HH24')));
   EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'owner_accounting_alert_record_failed for notification %: %',notice.id,SQLERRM;
   END;
  END IF;
  IF receipt.invoice_type IN('cashier_cashout','accounting_correction','credit_limit_change') AND NOT EXISTS(SELECT 1 FROM public.push_outbox o
    WHERE o.accounting_notification_id=notice.id AND o.related_entity_id=notice.id
      AND o.recipient_user_id=notice.user_id AND o.event='accounting_invoice'
      AND o.status=state AND o.failure_reason IS NOT DISTINCT FROM reason
      AND o.title=left(notice.title,120) AND o.body=left(COALESCE(notice.message,notice.title),500)
      AND o.url=COALESCE(NULLIF(btrim(notice.link),''),NULLIF(btrim(notice.action_url),''),'/hub')
      AND o.tag='accounting_invoice:'||receipt.conversation_id::text)
  THEN RAISE EXCEPTION 'cashier_push_receipt_missing' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;

 -- A reserved accounting label with no actual delivery link is invalid,
 -- including a caller that forces this constraint before the link is written.
 -- Fail the transaction rather than silently dropping its accounting push.
 IF notice.type='accounting_invoice' THEN
  RAISE EXCEPTION 'accounting_push_delivery_link_missing' USING ERRCODE='23514';
 END IF;
 IF notice.type='accounting_invoice_detail' THEN RETURN NEW; END IF;
 -- Existing non-accounting notification policy stays intact.
 IF notice.data IS NOT NULL AND notice.data->>'_push' IS NOT NULL THEN RETURN NEW; END IF;
 IF notice.user_id IS NULL OR notice.title IS NULL OR btrim(notice.title)='' THEN RETURN NEW; END IF;
 IF notice.created_at IS NOT NULL AND notice.created_at<now()-c_max_age THEN RETURN NEW; END IF;
 IF notice.type IN('waitlist_seat_open','waitlist_offer_expired','seat_available','waitlist_ready','table_ready') THEN
  v_tag:='seat_offer:'||COALESCE(NULLIF(btrim(COALESCE(notice.data->>'table_id','')),''),notice.id::text);
 ELSIF notice.type IN('system','daily_challenge','venue_alert','bonus','vip','live','poker_news','diamond','achievement') THEN
  v_tag:=notice.type||':'||notice.user_id::text;
 ELSE
  v_tag:=notice.type||':'||COALESCE(NULLIF(btrim(COALESCE(notice.data->>'conversationId','')),''),NULLIF(btrim(COALESCE(notice.data->>'conversation_id','')),''),notice.actor_id::text,notice.id::text);
 END IF;
 BEGIN
  SELECT count(*) INTO v_pending FROM public.push_outbox WHERE recipient_user_id=notice.user_id AND status IN('pending','processing');
  IF v_pending>=c_max_pending THEN RETURN NEW; END IF;
  INSERT INTO public.push_outbox(recipient_user_id,title,body,url,event,tag,status,related_entity_id)
   VALUES(notice.user_id,left(notice.title,120),left(COALESCE(notice.message,notice.title),500),COALESCE(NULLIF(btrim(notice.link),''),NULLIF(btrim(notice.action_url),''),'/hub'),notice.type,v_tag,'pending',notice.id);
 EXCEPTION WHEN OTHERS THEN RAISE WARNING 'mirror_notification_to_push_outbox failed for notification %: %',notice.id,SQLERRM;
 END;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_mirror_notification_to_push_outbox() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_mirror_notification_to_push_outbox() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_mirror_notification_to_push_outbox() TO service_role;
-- @@END fn_mirror_notification_to_push_outbox()

-- @@DOOR fn_multi_day_stage_rows_are_rpc_owned()
-- @@PIN md5=18f1e1bdbb5eee5cf28b3b3729db3caf len=2803 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_multi_day_stage_rows_are_rpc_owned()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament uuid;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'MULTI_DAY_STAGE_RECORD_IS_PERMANENT: % on % refused', TG_OP, TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  v_tournament := NEW.tournament_id;
  IF current_setting('app.multi_day_stage_writer', true) IS DISTINCT FROM v_tournament::text THEN
    RAISE EXCEPTION 'MULTI_DAY_STAGE_WRITER_REQUIRED: % on % belongs to the stage RPCs', TG_OP, TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'tournament_stages' THEN
    IF (NEW.tournament_id, NEW.stage_no, NEW.kind, NEW.day_no, NEW.end_after_level)
       IS DISTINCT FROM (OLD.tournament_id, OLD.stage_no, OLD.kind, OLD.day_no, OLD.end_after_level)
       OR NEW.schedule_generation < OLD.schedule_generation THEN
      RAISE EXCEPTION 'MULTI_DAY_STAGE_STRUCTURE_IS_SEALED' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'tournament_qualification_entitlements' THEN
    IF OLD.state = 'active' AND NEW.state = 'consumed'
       AND (NEW.id, NEW.tournament_id, NEW.user_id, NEW.source_stage_no, NEW.source_registration_id,
            NEW.source_bag_row_id, NEW.stack, NEW.bounty_head, NEW.target_stage_no, NEW.created_at)
           IS NOT DISTINCT FROM
           (OLD.id, OLD.tournament_id, OLD.user_id, OLD.source_stage_no, OLD.source_registration_id,
            OLD.source_bag_row_id, OLD.stack, OLD.bounty_head, OLD.target_stage_no, OLD.created_at) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'MULTI_DAY_ENTITLEMENT_IS_CONSUMED_ONCE' USING ERRCODE = '55000';
  ELSIF TG_TABLE_NAME = 'tournament_stage_resume_receipts' THEN
    IF (NEW.tournament_id, NEW.stage_no, NEW.resume_id, NEW.schedule_generation, NEW.first_level, NEW.claimed_at)
       IS DISTINCT FROM
       (OLD.tournament_id, OLD.stage_no, OLD.resume_id, OLD.schedule_generation, OLD.first_level, OLD.claimed_at)
       OR OLD.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'MULTI_DAY_RESUME_RECEIPT_IS_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    -- Exactly one of: completion, or a successor lease adopting it.
    IF (NEW.completed_at IS NOT NULL AND NEW.lease_generation = OLD.lease_generation)
       OR (NEW.completed_at IS NULL AND NEW.lease_generation IS DISTINCT FROM OLD.lease_generation) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'MULTI_DAY_RESUME_RECEIPT_IS_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  RAISE EXCEPTION 'MULTI_DAY_STAGE_RECEIPT_IS_APPEND_ONLY: UPDATE on % refused', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$function$;
ALTER FUNCTION public.fn_multi_day_stage_rows_are_rpc_owned() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_multi_day_stage_rows_are_rpc_owned() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_multi_day_stage_rows_are_rpc_owned()

-- @@DOOR fn_multi_day_stage_rows_never_truncate()
-- @@PIN md5=ae146ca1b46595284d356662c12693f3 len=322 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_multi_day_stage_rows_never_truncate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'MULTI_DAY_STAGE_RECORD_IS_PERMANENT: TRUNCATE on % refused', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$function$;
ALTER FUNCTION public.fn_multi_day_stage_rows_never_truncate() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_multi_day_stage_rows_never_truncate() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_multi_day_stage_rows_never_truncate()

-- @@DOOR fn_only_close_account_closes_an_account()
-- @@PIN md5=f8696524b52366d303d2f45f20d69e8e len=385 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_only_close_account_closes_an_account()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NOT DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'ACCOUNT_CLOSE_REQUIRED: an account is closed only through Close Account'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_only_close_account_closes_an_account() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_only_close_account_closes_an_account() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_only_close_account_closes_an_account() TO service_role;
-- @@END fn_only_close_account_closes_an_account()

-- @@DOOR fn_player_needs_a_started_game()
-- @@PIN md5=b007e153e4bd41fb664255668c408831 len=1426 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_player_needs_a_started_game()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz;
  v_status  text;
  v_found   boolean := false;
BEGIN
  -- The WHEN clause already asks this; asked again so the refusal survives a
  -- trigger that is ever re-armed without one.
  IF NEW.status IS NULL OR NEW.status NOT IN ('eliminated', 'winner') THEN
    RETURN NULL;
  END IF;

  SELECT t.started_at, upper(COALESCE(t.status, '')), true
    INTO v_started, v_status, v_found
    FROM public.tournaments t
   WHERE t.id = NEW.tournament_id;

  -- A parent removed later in the same transaction owes nothing.
  IF NOT COALESCE(v_found, false) THEN
    RETURN NULL;
  END IF;

  -- A terminal tournament records everyone out on purpose: cancellation
  -- refunds through exactly this write, and completion settles through it.
  IF v_status IN ('CANCELLED', 'CANCELED', 'COMPLETED', 'COMPLETING') THEN
    RETURN NULL;
  END IF;

  IF v_started IS NULL THEN
    RAISE EXCEPTION
      'tournament % never started: registration % cannot be recorded as %',
      NEW.tournament_id, NEW.id, NEW.status
      USING ERRCODE = 'P0404',
            HINT = 'A game that has not started cannot put a player out. Finish the launch, or cancel the tournament, before recording a result.';
  END IF;

  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.fn_player_needs_a_started_game() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_player_needs_a_started_game() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_player_needs_a_started_game() TO service_role;
-- @@END fn_player_needs_a_started_game()

-- @@DOOR fn_poker_diamond_audit_tournament_created(p_result jsonb)
-- @@PIN md5=d18fe890c687f84edb61980a7d612e2d len=768 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_audit_tournament_created(p_result jsonb)
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
ALTER FUNCTION public.fn_poker_diamond_audit_tournament_created(p_result jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_audit_tournament_created(p_result jsonb) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_poker_diamond_audit_tournament_created(p_result jsonb)

-- @@DOOR fn_poker_diamond_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean, p_club_id uuid, p_idempotency_key uuid)
-- @@PIN md5=2f76148f74df8766a958cdd403582e24 len=5801 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean, p_club_id uuid, p_idempotency_key uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 v_t public.tables%ROWTYPE;
 v_seat_id uuid:=gen_random_uuid();
 v_custody jsonb;
 v_taken integer;
 v_holds integer;
BEGIN
 IF p_idempotency_key IS NULL OR p_user_id IS NULL OR p_table_id IS NULL
    OR p_seat_number IS NULL OR p_seat_number<1 OR p_auto_rebuy IS DISTINCT FROM false
    OR p_amount IS NULL OR p_amount NOT BETWEEN 1 AND 2147483647
    OR p_amount<>trunc(p_amount) THEN
   RAISE EXCEPTION 'invalid_diamond_cash_purchase' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:'||p_user_id,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:'||p_table_id,0));
 SELECT t.* INTO v_t FROM public.tables t
   JOIN public.clubs c ON c.id=t.club_id
   JOIN public.ca_arena_settings a ON a.id=1 AND a.club_id=c.id
 WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
   AND c.union_id IS NULL AND t.union_id IS NULL AND a.cash_games_enabled
 FOR UPDATE OF t;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'diamond_cash_not_open' USING ERRCODE='55000';
 END IF;
 IF NOT public.fn_poker_diamond_plain_cash_table(v_t) THEN
   RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
 END IF;
 -- Match the shared engine load boundary before reserving any Diamonds.
 IF EXISTS(SELECT 1 FROM (VALUES(v_t.small_blind),(v_t.big_blind),
      (v_t.min_buy_in),(v_t.max_buy_in)) AS amount(value)
      WHERE value IS NULL OR value NOT BETWEEN 1 AND 2147483647
        OR value<>trunc(value))
    OR COALESCE(v_t.ante,0) NOT BETWEEN 0 AND 9007199254740991
    OR COALESCE(v_t.ante,0)<>trunc(COALESCE(v_t.ante,0)) THEN
   RAISE EXCEPTION 'diamond_cash_requires_whole_amounts' USING ERRCODE='23514';
 END IF;
 IF coalesce(v_t.bomb_pot_enabled,false) THEN
   IF coalesce(lower(v_t.bomb_pot_variant),'') NOT IN ('','nlh') THEN
     RAISE EXCEPTION 'diamond_bomb_pot_requires_the_table_game' USING ERRCODE='23514';
   END IF;
   IF NOT EXISTS(SELECT 1 FROM (SELECT CASE
          WHEN coalesce(v_t.bomb_pot_ante_fixed,0)>0 THEN v_t.bomb_pot_ante_fixed
          ELSE v_t.big_blind*coalesce(v_t.bomb_pot_ante_multiplier,2) END AS a) x
        WHERE x.a IS NOT NULL AND x.a BETWEEN 1 AND 2147483647 AND x.a=trunc(x.a)) THEN
     RAISE EXCEPTION 'diamond_bomb_pot_requires_a_whole_ante' USING ERRCODE='23514';
   END IF;
 END IF;
 IF p_club_id IS NOT NULL AND p_club_id<>v_t.club_id THEN
   RAISE EXCEPTION 'diamond_purchase_arena_mismatch' USING ERRCODE='22023';
 END IF;
 IF v_t.max_players IS NULL OR p_seat_number>v_t.max_players THEN
   RAISE EXCEPTION 'TABLE_SIZE: invalid Diamond seat' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM public.blacklists WHERE user_id=p_user_id
     AND club_id=v_t.club_id AND (expires_at IS NULL OR expires_at>now())) THEN
   RAISE EXCEPTION 'Banned from this club' USING ERRCODE='42501';
 END IF;
 IF coalesce(v_t.is_vip_only,false) AND NOT EXISTS(
    SELECT 1 FROM public.profiles p WHERE p.id=p_user_id AND p.is_vip IS TRUE
      AND (p.vip_expires_at IS NULL OR p.vip_expires_at>now())) THEN
   RAISE EXCEPTION 'VIP_ONLY: this table requires VIP membership' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=p_table_id AND left_at IS NULL
           AND (user_id=p_user_id OR seat_number=p_seat_number)) THEN
   RAISE EXCEPTION 'Diamond seat or player is already seated' USING ERRCODE='23505';
 END IF;
 SELECT count(*) INTO v_taken FROM public.table_seats
   WHERE table_id=p_table_id AND left_at IS NULL;
 SELECT count(*) INTO v_holds FROM public.table_waitlist
   WHERE table_id=p_table_id AND status='notified' AND user_id<>p_user_id
     AND coalesce(hold_expires_at,notified_at+interval '60 seconds')>now();
 IF v_taken>=v_t.max_players OR v_taken+v_holds>=v_t.max_players THEN
   RAISE EXCEPTION 'SEAT_RESERVED: table capacity is taken or held' USING ERRCODE='55000';
 END IF;
 IF (SELECT count(*) FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     WHERE s.user_id=p_user_id AND s.left_at IS NULL AND t.tournament_id IS NULL
       AND t.status NOT IN ('closed','deleted'))>=4 THEN
   RAISE EXCEPTION 'TABLE_CAP_REACHED: already seated at four cash tables' USING ERRCODE='55000';
 END IF;

 v_custody:=public.fn_poker_diamond_reserve(p_user_id,'cash_seat',p_table_id,
   'seat:'||v_seat_id,p_amount,p_idempotency_key);
 PERFORM set_config('app.money_path','atomic_table_buyin',true);
 DELETE FROM public.table_seats WHERE table_id=p_table_id
   AND seat_number=p_seat_number AND left_at IS NOT NULL;
 INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,auto_rebuy,club_id)
   VALUES(v_seat_id,p_table_id,p_seat_number,p_user_id,p_amount,'active',false,v_t.club_id);
 -- The after-insert binder sees the final occupancy stamped by the shared trigger.
 IF NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
     JOIN public.table_seats s ON s.id=c.seat_id AND s.joined_at=c.seat_joined_at
       AND s.occupancy_id=c.occupancy_id
     WHERE c.id=(v_custody->>'custody_id')::uuid AND c.state='active'
       AND s.id=v_seat_id AND s.left_at IS NULL AND s.stack=c.balance) THEN
   RAISE EXCEPTION 'diamond_seat_custody_binding_failed' USING ERRCODE='23514';
 END IF;
 UPDATE public.table_waitlist SET status='seated'
   WHERE table_id=p_table_id AND user_id=p_user_id AND status IN ('waiting','notified');
 UPDATE public.tables SET current_players=(
   SELECT count(*) FROM public.table_seats WHERE table_id=p_table_id AND left_at IS NULL)
   WHERE id=p_table_id;
END $function$;
ALTER FUNCTION public.fn_poker_diamond_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean, p_club_id uuid, p_idempotency_key uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean, p_club_id uuid, p_idempotency_key uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_poker_diamond_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean, p_club_id uuid, p_idempotency_key uuid)

-- @@DOOR fn_poker_diamond_cash_variant(p_variant text)
-- @@PIN md5=929c207a922004eb0e764011a2fe386c len=745 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_cash_variant(p_variant text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  /* NULL-SAFE ON PURPOSE. `NULL IN (...)` is NULL, not false, so without the
     first clause an unset `game_variant` made the whole plain-cash rule return
     NULL rather than false: a row that is neither admitted nor refused. Every
     caller today happens to treat unknown as refusal, which is exactly the
     kind of accident that holds until one of them writes `IF fn(...) = false`.
     An unset game is not a game. */
  SELECT p_variant IS NOT NULL
     AND p_variant IN ('nlh','plo4','plo5','plo6','plo8','pineapple','short_deck','flh','flo8');
$function$;
ALTER FUNCTION public.fn_poker_diamond_cash_variant(p_variant text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_cash_variant(p_variant text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_cash_variant(p_variant text) TO authenticated, service_role;
-- @@END fn_poker_diamond_cash_variant(p_variant text)

-- @@DOOR fn_poker_diamond_cashout(p_user_id uuid, p_table_id uuid, p_seat_number integer)
-- @@PIN md5=86a1c1ed0233ef041695241509514c32 len=2976 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_cashout(p_user_id uuid, p_table_id uuid, p_seat_number integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 v_s public.table_seats%ROWTYPE;
 v_c public.poker_diamond_custody%ROWTYPE;
 v_release jsonb;
 v_receipt jsonb;
 v_key text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN
   RAISE EXCEPTION 'Diamond cash-out is engine only' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:'||p_user_id,0));
 PERFORM 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
   WHERE t.id=p_table_id AND c.asset='diamonds' AND t.tournament_id IS NULL FOR UPDATE OF t;
 IF NOT FOUND THEN RAISE EXCEPTION 'diamond_cash_table_required' USING ERRCODE='23514'; END IF;
 PERFORM id FROM public.profiles WHERE id=p_user_id FOR UPDATE;
 SELECT * INTO v_s FROM public.table_seats
   WHERE user_id=p_user_id AND table_id=p_table_id AND left_at IS NULL
     AND (p_seat_number IS NULL OR seat_number=p_seat_number)
   ORDER BY joined_at DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'stack',0,'reason','no_active_seat'); END IF;
 SELECT * INTO v_c FROM public.poker_diamond_custody
   WHERE user_id=p_user_id AND target_id=p_table_id AND purpose='cash_seat'
     AND seat_id=v_s.id AND seat_joined_at=v_s.joined_at AND occupancy_id=v_s.occupancy_id
     AND state='active' FOR UPDATE;
 IF NOT FOUND OR v_c.balance IS DISTINCT FROM v_s.stack THEN
   RAISE EXCEPTION 'diamond_cashout_custody_mismatch' USING ERRCODE='23514';
 END IF;
 v_key:='cashout:occupancy:'||v_s.occupancy_id;
 UPDATE public.table_seats SET left_at=now(),leave_pending=false,status='left'
   WHERE id=v_s.id AND joined_at=v_s.joined_at AND occupancy_id=v_s.occupancy_id AND left_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'diamond_cashout_seat_not_vacated' USING ERRCODE='23514'; END IF;
 v_release:=public.fn_poker_diamond_release(v_c.id,md5(v_key)::uuid);
 IF (v_release->>'success')::boolean IS DISTINCT FROM true
    OR (v_release->>'amount')::bigint IS DISTINCT FROM v_c.balance
    OR (v_release->>'custody_balance')::bigint IS DISTINCT FROM 0 THEN
   RAISE EXCEPTION 'diamond_cashout_release_not_verified' USING ERRCODE='23514';
 END IF;
 UPDATE public.tables SET current_players=(
   SELECT count(*) FROM public.table_seats WHERE table_id=p_table_id AND left_at IS NULL)
   WHERE id=p_table_id;
 v_receipt:=jsonb_build_object('ok',true,'asset','diamonds','stack',v_c.balance,
   'credited',v_c.balance>0,'seat_number',v_s.seat_number,'idempotency_key',v_key,
   'tournament_table',false,'occupancy_id',v_s.occupancy_id,
   'user_id',p_user_id,'table_id',p_table_id,'custody_receipt',v_release);
 INSERT INTO public.seat_cashout_receipts(occupancy_id,user_id,table_id,seat_id,seat_number,receipt)
   VALUES(v_s.occupancy_id,p_user_id,p_table_id,v_s.id,v_s.seat_number,v_receipt);
 RETURN v_receipt;
END $function$;
ALTER FUNCTION public.fn_poker_diamond_cashout(p_user_id uuid, p_table_id uuid, p_seat_number integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_cashout(p_user_id uuid, p_table_id uuid, p_seat_number integer) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_poker_diamond_cashout(p_user_id uuid, p_table_id uuid, p_seat_number integer)

-- @@DOOR fn_poker_diamond_cashout_receipt(p_table_id uuid, p_occupancy_id uuid)
-- @@PIN md5=85993bfb0f425ebcd16416ec89b9a9cf len=1285 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_cashout_receipt(p_table_id uuid, p_occupancy_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '5s'
AS $function$
DECLARE v_uid uuid:=auth.uid(); v_r public.seat_cashout_receipts%ROWTYPE;
BEGIN
 IF v_uid IS NULL OR NOT public.fn_caller_session_is_live() THEN
   RAISE EXCEPTION 'Authentication Required' USING ERRCODE='28000';
 END IF;
 IF p_table_id IS NULL OR p_occupancy_id IS NULL THEN
   RAISE EXCEPTION 'CASHOUT_OCCUPANCY_REQUIRED' USING ERRCODE='22023';
 END IF;
 SELECT * INTO v_r FROM public.seat_cashout_receipts
   WHERE occupancy_id=p_occupancy_id AND user_id=v_uid;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF v_r.table_id IS DISTINCT FROM p_table_id
    OR v_r.receipt->>'asset' IS DISTINCT FROM 'diamonds'
    OR NOT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
      WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform AND c.union_id IS NULL) THEN
   RAISE EXCEPTION 'CASHOUT_OCCUPANCY_SCOPE_MISMATCH' USING ERRCODE='22023';
 END IF;
 RETURN jsonb_build_object('asset','diamonds','table_id',p_table_id,
   'occupancy_id',p_occupancy_id,'amount',(v_r.receipt->>'stack')::bigint);
END $function$;
ALTER FUNCTION public.fn_poker_diamond_cashout_receipt(p_table_id uuid, p_occupancy_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_cashout_receipt(p_table_id uuid, p_occupancy_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_cashout_receipt(p_table_id uuid, p_occupancy_id uuid) TO authenticated;
-- @@END fn_poker_diamond_cashout_receipt(p_table_id uuid, p_occupancy_id uuid)

-- @@DOOR fn_poker_diamond_create_tournament(p_config jsonb)
-- @@PIN md5=05e4ae642e1a3949da8bb34bc62f7f3d len=17433 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_create_tournament(p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_arena uuid; v_id uuid;
  v_total bigint; v_fee bigint; v_buy_in bigint; v_ratio numeric;
  v_max integer; v_min integer; v_type text; v_variant text; v_game text;
  v_start timestamptz; v_payouts jsonb; v_blinds jsonb; v_pct numeric; v_chips integer;
  v_rebuy boolean; v_reentry boolean; v_addon boolean; v_rebuy_cost bigint; v_addon_cost bigint;
  v_rebuy_num numeric; v_addon_num numeric; v_name text;
  v_is_bounty boolean; v_bounty_num numeric; v_bounty bigint;
  v_mystery boolean; v_mb_activation text; v_mb_profile text; v_mb_value numeric; v_mb_top numeric;
  v_mb_pool numeric; v_mb_regular numeric; v_mb_min_mult numeric; v_mb_max_mult numeric;
  v_unlimited boolean;
  v_satellite boolean; v_target_text text; v_target_id uuid; v_target public.tournaments%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='28000'; END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_tournament_staff_only' USING ERRCODE='42501';
  END IF;
  -- DIAMOND PHASE 11: a signed-out staff token moves nothing here either.
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';
  END IF;
  SELECT c.id INTO v_arena FROM public.clubs c
   WHERE c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL LIMIT 1;
  IF v_arena IS NULL THEN RAISE EXCEPTION 'diamond_arena_not_found' USING ERRCODE='P0002'; END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config)<>'object' THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_configuration' USING ERRCODE='22023';
  END IF;
  -- DIAMOND PHASE 9, STEP 0 (the_chip_legs_refuse_a_diamond_row): the estate's builder
  -- (TournamentService.buildRpcConfig) sends these money keys, and this door reads
  -- guarantee, rebuy, reentry, addOn and addonCost instead. A value in one of them
  -- would be dropped and the event created without it, so it is refused by name.
  -- The builder's own default (0, false or null) means what the door does without
  -- the key, and is admitted.
  IF EXISTS (SELECT 1 FROM jsonb_each(p_config) k
              WHERE k.key IN ('guaranteedPrize','isRebuy','isReentry','addOnAvailable','addOnCost','addOnFromStart')
                AND k.value NOT IN ('0'::jsonb, 'false'::jsonb, 'null'::jsonb)) THEN
    RAISE EXCEPTION 'diamond_tournament_money_key_not_read: %', (
      SELECT string_agg(k.key, ', ' ORDER BY k.key) FROM jsonb_each(p_config) k
       WHERE k.key IN ('guaranteedPrize','isRebuy','isReentry','addOnAvailable','addOnCost','addOnFromStart')
         AND k.value NOT IN ('0'::jsonb, 'false'::jsonb, 'null'::jsonb))
      USING ERRCODE = '22023';
  END IF;

  v_type := lower(COALESCE(p_config->>'type','mtt'));
  -- DIAMOND PHASE 9: A SPIN IS ADMITTED BY ITS OWN BRANCH, under the chip
  -- seat-first configuration door's rules (fn_poker_diamond_create_spin:
  -- three seats, no fee, a multiplier that is drawn and never configured, a
  -- multiplier table held to the draw authority's rules and to whole Diamonds
  -- at its buy-in). A Spin's configuration on any other format is refused.
  IF v_type = 'spin' THEN
    -- DIAMOND PHASE 10: the answer files its audit row on the way out.
    RETURN public.fn_poker_diamond_audit_tournament_created(public.fn_poker_diamond_create_spin(p_config, v_arena));
  END IF;
  IF p_config ?| ARRAY['spinTiers','spinMultiplier','spinLockedTiers','spin_multiplier','spin_locked_tiers'] THEN
    RAISE EXCEPTION 'diamond_tournament_spin_requires_a_spin_format' USING ERRCODE='22023';
  END IF;
  IF v_type NOT IN ('mtt','sng','bounty','progressive_bounty','mystery_bounty','satellite') THEN
    -- spin is admitted above, by fn_poker_diamond_create_spin.
    RAISE EXCEPTION 'diamond_tournament_format_not_open' USING ERRCODE='55000';
  END IF;
  IF COALESCE((p_config->>'guarantee')::numeric,0)<>0
     OR COALESCE((p_config->>'freeBuy')::boolean,false) THEN
    RAISE EXCEPTION 'diamond_tournament_format_not_open' USING ERRCODE='55000';
  END IF;
  -- A satellite is a format, not a flag: its target rides on a 'satellite'
  -- event and on nothing else, and a satellite has exactly one target.
  v_satellite := v_type = 'satellite';
  v_target_text := NULLIF(btrim(COALESCE(p_config->>'satelliteTargetId','')),'');
  IF v_target_text IS NOT NULL AND NOT v_satellite THEN
    RAISE EXCEPTION 'diamond_tournament_target_requires_a_satellite_format' USING ERRCODE='22023';
  END IF;
  IF v_satellite THEN
    IF v_target_text IS NULL
       OR v_target_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'diamond_satellite_requires_a_target' USING ERRCODE='22023';
    END IF;
    v_target_id := v_target_text::uuid;
    -- ASSETS NEVER CROSS: a Diamond satellite seats a Diamond target only.
    IF NOT public.fn_poker_diamond_tournament(v_target_id) THEN
      RAISE EXCEPTION 'diamond_satellite_target_must_be_a_diamond_tournament' USING ERRCODE='22023';
    END IF;
    IF NOT public.fn_ca_diamond_satellite_target_accepts_new_feeder(v_target_id) THEN
      RAISE EXCEPTION 'diamond_satellite_target_cannot_take_a_satellite' USING ERRCODE='22023';
    END IF;
    SELECT * INTO v_target FROM public.tournaments t WHERE t.id=v_target_id;
    IF upper(COALESCE(v_target.status,'')) NOT IN ('ANNOUNCED','REGISTERING')
       OR COALESCE(v_target.prize_pool_finalized,false) THEN
      RAISE EXCEPTION 'diamond_satellite_target_is_not_open' USING ERRCODE='55000';
    END IF;
    -- A seat count promised in advance is a guarantee: reserved to the owner.
    IF COALESCE(NULLIF(p_config->>'satelliteSeats','')::numeric,0)<>0 THEN
      RAISE EXCEPTION 'diamond_satellite_seat_guarantee_not_open' USING ERRCODE='55000';
    END IF;
    -- The chip scheduled satellite is a freezeout; so is this one.
    IF COALESCE((p_config->>'rebuy')::boolean,false) OR COALESCE((p_config->>'reentry')::boolean,false)
       OR COALESCE((p_config->>'addOn')::boolean,false) THEN
      RAISE EXCEPTION 'diamond_satellite_is_a_freezeout' USING ERRCODE='22023';
    END IF;
  END IF;
  -- A knockout bounty is a format, not a flag: the flat bounty rides on a
  -- 'bounty', 'progressive_bounty' or 'mystery_bounty' event and on nothing else.
  v_is_bounty := v_type IN ('bounty','progressive_bounty','mystery_bounty');
  v_mystery := v_type = 'mystery_bounty';
  v_bounty_num := COALESCE((p_config->>'bountyAmount')::numeric,0);
  IF NOT v_is_bounty AND (v_bounty_num<>0 OR COALESCE((p_config->>'isBounty')::boolean,false)) THEN
    RAISE EXCEPTION 'diamond_tournament_bounty_requires_a_bounty_format' USING ERRCODE='22023';
  END IF;
  IF NOT v_mystery AND (p_config ? 'mysteryBountyMin' OR p_config ? 'mysteryBountyMax' OR p_config ? 'mysteryBounty') THEN
    RAISE EXCEPTION 'diamond_tournament_mystery_requires_a_mystery_format' USING ERRCODE='22023';
  END IF;
  v_game := upper(btrim(COALESCE(p_config->>'gameVariant','NLH')));
  IF v_game NOT IN ('NLH','PLO4','PLO5','PLO6','PLO8','SHORT_DECK','FLH','FLO8') THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_supported_game' USING ERRCODE='22023';
  END IF;

  v_total := COALESCE((p_config->>'buyIn')::numeric,0);
  IF (p_config->>'buyIn')::numeric IS DISTINCT FROM v_total::numeric OR v_total<1 OR v_total>2147483647 THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_positive_buy_in' USING ERRCODE='22023';
  END IF;
  v_unlimited:=public.fn_ca_new_tournament_is_unlimited(jsonb_build_object('tournament_type',
    CASE WHEN v_type='sng' THEN 'SNG' WHEN v_satellite THEN 'SATELLITE' ELSE 'MTT' END));
  v_max := CASE WHEN v_unlimited THEN NULL ELSE COALESCE((p_config->>'maxPlayers')::int,0) END;
  IF NOT v_unlimited AND (v_max<2 OR v_max>10000) THEN RAISE EXCEPTION 'diamond_tournament_requires_a_real_field' USING ERRCODE='22023'; END IF;
  v_min := GREATEST(COALESCE((p_config->>'minPlayers')::int,3),CASE WHEN v_unlimited THEN 3 ELSE 2 END);
  IF NOT v_unlimited AND v_min>v_max THEN v_min := v_max; END IF;
  -- The fee rule the recovery fee already states, at this entry's own unit.
  v_ratio := CASE WHEN NOT v_unlimited AND v_max<=2 THEN 0.05 ELSE 0.10 END;
  v_fee := public.fn_ca_unit_floor_cents(round(v_total*100*v_ratio)::bigint, 100)/100;
  v_buy_in := v_total - v_fee;
  IF v_buy_in<1 THEN RAISE EXCEPTION 'diamond_tournament_buy_in_below_one_diamond' USING ERRCODE='22023'; END IF;
  -- The chip door's bounty rule at the Diamond unit: a whole bounty of at
  -- least one Diamond, no larger than the buy-in after the fee (the prize
  -- part is what remains; it may be zero, as the chip split allows).
  IF v_is_bounty THEN
    IF v_bounty_num<>trunc(v_bounty_num) OR v_bounty_num<1 OR v_bounty_num>v_buy_in THEN
      RAISE EXCEPTION 'diamond_tournament_requires_a_whole_bounty_within_the_buy_in' USING ERRCODE='22023';
    END IF;
    v_bounty := v_bounty_num;
  ELSE
    v_bounty := 0;
  END IF;
  -- The mystery rules are the chip configuration door's rules
  -- (fn_apply_mystery_bounty_config), stamped here because that door consults
  -- a club owner the arena does not have. The lobby's advertised range is the
  -- chip door's multipliers on the flat bounty, in whole Diamonds.
  IF v_mystery THEN
    v_mb_activation := COALESCE(p_config->'mysteryBounty'->>'activation', 'at_the_money');
    IF v_mb_activation NOT IN ('at_the_money','percent_field','player_count') THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_bad_activation_mode' USING ERRCODE='22023';
    END IF;
    v_mb_profile := COALESCE(p_config->'mysteryBounty'->>'profile', 'classic');
    IF v_mb_profile NOT IN ('balanced','classic','jackpot') THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_bad_profile' USING ERRCODE='22023';
    END IF;
    v_mb_value := (p_config->'mysteryBounty'->>'activationValue')::numeric;
    IF v_mb_activation = 'percent_field' AND (COALESCE(v_mb_value,0) <= 0 OR v_mb_value > 100) THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_activation_percent_out_of_range' USING ERRCODE='22023';
    END IF;
    IF v_mb_activation = 'player_count' AND COALESCE(v_mb_value,0) < 2 THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_activation_count_too_small' USING ERRCODE='22023';
    END IF;
    v_mb_top := COALESCE((p_config->'mysteryBounty'->>'topPercent')::numeric, 20);
    IF v_mb_top <= 0 OR v_mb_top > 100 THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_top_percent_out_of_range' USING ERRCODE='22023';
    END IF;
    v_mb_pool := COALESCE((p_config->'mysteryBounty'->>'poolPercent')::numeric, 50);
    v_mb_regular := COALESCE((p_config->'mysteryBounty'->>'regularPoolPercent')::numeric, 100 - v_mb_pool);
    IF v_mb_pool < 0 OR v_mb_regular < 0 OR v_mb_pool + v_mb_regular <= 0 THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_pool_split_invalid' USING ERRCODE='22023';
    END IF;
    v_mb_min_mult := COALESCE(NULLIF(p_config->>'mysteryBountyMin','')::numeric, 0.5);
    v_mb_max_mult := COALESCE(NULLIF(p_config->>'mysteryBountyMax','')::numeric, 13);
    IF v_mb_min_mult <= 0 OR v_mb_max_mult < v_mb_min_mult THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_range_invalid' USING ERRCODE='22023';
    END IF;
  END IF;

  v_chips := COALESCE((p_config->>'startingStack')::int, 10000);
  IF v_chips<1 THEN RAISE EXCEPTION 'diamond_tournament_requires_a_starting_stack' USING ERRCODE='22023'; END IF;
  v_blinds := COALESCE(p_config->'blindStructure','[]'::jsonb);
  v_payouts := COALESCE(p_config->'payoutStructure','[]'::jsonb);
  IF jsonb_typeof(v_blinds)<>'array' OR jsonb_array_length(v_blinds)=0 THEN
    RAISE EXCEPTION 'blind_structure_required' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(v_payouts)<>'array' OR jsonb_array_length(v_payouts)=0 THEN
    RAISE EXCEPTION 'payout_structure_required' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(sum((e->>'percentage')::numeric),0) INTO v_pct FROM jsonb_array_elements(v_payouts) e;
  IF abs(v_pct-100)>1 THEN RAISE EXCEPTION 'payouts_must_total_100' USING ERRCODE='22023'; END IF;
  IF NOT v_unlimited AND jsonb_array_length(v_payouts)>v_max THEN RAISE EXCEPTION 'more_paid_places_than_players' USING ERRCODE='22023'; END IF;
  v_start := COALESCE((p_config->>'startTime')::timestamptz, now()+interval '1 minute');
  -- A satellite plays before its target, as the chip scheduled satellite does.
  IF v_satellite AND (v_target.start_time IS NULL OR v_start >= v_target.start_time) THEN
    RAISE EXCEPTION 'diamond_satellite_must_start_before_its_target' USING ERRCODE='22023';
  END IF;
  v_rebuy := COALESCE((p_config->>'rebuy')::boolean,false);
  v_reentry := COALESCE((p_config->>'reentry')::boolean,v_rebuy);
  v_addon := COALESCE((p_config->>'addOn')::boolean,false);
  v_rebuy_num := COALESCE((p_config->>'rebuyCost')::numeric, v_total);
  v_addon_num := COALESCE((p_config->>'addonCost')::numeric, v_total);
  IF (v_rebuy OR v_reentry) AND (v_rebuy_num <> trunc(v_rebuy_num) OR v_rebuy_num < 1 OR v_rebuy_num > 2147483647) THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_rebuy_cost' USING ERRCODE='22023';
  END IF;
  IF v_addon AND (v_addon_num <> trunc(v_addon_num) OR v_addon_num < 1 OR v_addon_num > 2147483647) THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_addon_cost' USING ERRCODE='22023';
  END IF;
  v_rebuy_cost := v_rebuy_num; v_addon_cost := v_addon_num;
  v_name := COALESCE(NULLIF(btrim(p_config->>'name'),''),'Diamond Tournament');
  v_variant := CASE v_type WHEN 'sng' THEN 'sng' WHEN 'bounty' THEN 'bounty'
                           WHEN 'progressive_bounty' THEN 'progressive_bounty'
                           WHEN 'mystery_bounty' THEN 'mystery_bounty'
                           WHEN 'satellite' THEN 'satellite' ELSE 'freezeout' END;

  INSERT INTO public.tournaments (
    club_id, union_id, name, game_type, variant, tournament_type,
    buy_in_amount, buy_in_fee, guaranteed_prize, starting_chips, max_players, table_size, min_players,
    current_players, status, blind_structure, payout_structure, start_time,
    late_reg_levels, late_reg_mins, is_bounty, is_pko, is_mystery_bounty, bounty_amount,
    mystery_bounty_min, mystery_bounty_max,
    mystery_bounty_activation, mystery_bounty_activation_value, mystery_bounty_profile,
    mystery_bounty_top_percent, mystery_bounty_pool_percent, mystery_bounty_regular_pool_percent,
    is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, max_rebuys, max_reentries,
    add_on_available, addon_cost, addon_chips, addon_levels,
    payout_percent, free_buy, is_private, action_time_seconds,
    satellite_target_id, satellite_seats)
  VALUES (
    v_arena, NULL, v_name, v_game, v_variant,
    CASE WHEN v_type='sng' THEN 'SNG' WHEN v_satellite THEN 'SATELLITE' ELSE 'MTT' END,
    v_buy_in, v_fee, 0, v_chips, v_max, CASE WHEN v_unlimited THEN LEAST(9,GREATEST(2,COALESCE((p_config->>'tableSize')::int,9))) ELSE LEAST(9,GREATEST(2,v_max)) END, v_min,
    0, 'REGISTERING', v_blinds::text, v_payouts::text, v_start,
    CASE WHEN v_satellite THEN 0 ELSE COALESCE((p_config->>'lateRegLevels')::int, CASE WHEN v_type='sng' THEN 0 ELSE 8 END) END,
    CASE WHEN v_satellite THEN 0 ELSE 8 END,
    v_is_bounty, v_type='progressive_bounty', v_mystery, v_bounty,
    CASE WHEN v_mystery THEN trunc(v_bounty * v_mb_min_mult) ELSE 0 END,
    CASE WHEN v_mystery THEN trunc(v_bounty * v_mb_max_mult) ELSE 0 END,
    CASE WHEN v_mystery THEN v_mb_activation ELSE 'at_the_money' END, CASE WHEN v_mystery THEN v_mb_value END,
    CASE WHEN v_mystery THEN v_mb_profile ELSE 'classic' END,
    CASE WHEN v_mystery THEN v_mb_top ELSE 20 END, CASE WHEN v_mystery THEN v_mb_pool ELSE 50 END,
    CASE WHEN v_mystery THEN v_mb_regular ELSE 50 END,
    v_rebuy, v_reentry, CASE WHEN v_rebuy OR v_reentry THEN v_rebuy_cost ELSE 0 END,
    CASE WHEN v_rebuy OR v_reentry THEN v_chips ELSE 0 END, CASE WHEN v_rebuy OR v_reentry THEN 6 ELSE 4 END,
    CASE WHEN v_rebuy THEN COALESCE((p_config->>'maxRebuys')::int,2) ELSE 0 END,
    CASE WHEN v_reentry THEN COALESCE((p_config->>'maxReentries')::int,1) ELSE 0 END,
    v_addon, CASE WHEN v_addon THEN v_addon_cost ELSE 0 END, CASE WHEN v_addon THEN v_chips ELSE 0 END, 1,
    CASE WHEN (p_config->>'payoutPercent')::int IN (10,15,20) THEN (p_config->>'payoutPercent')::smallint ELSE 10 END,
    false, false, 15,
    CASE WHEN v_satellite THEN v_target_id END, CASE WHEN v_satellite THEN 0 END)
  RETURNING id INTO v_id;

  -- The row this door wrote must be one the money path will price: whole
  -- Diamonds everywhere, and the unit rule must recognise it.
  IF public.fn_ca_tournament_unit_cents(v_id) <> 100 OR NOT public.fn_poker_diamond_tournament(v_id) THEN
    RAISE EXCEPTION 'diamond_tournament_would_not_be_recognised' USING ERRCODE='23514';
  END IF;
  -- DIAMOND PHASE 10: the answer files its audit row on the way out.
  RETURN public.fn_poker_diamond_audit_tournament_created(jsonb_build_object('success',true,'tournamentId',v_id,'id',v_id,'buy_in_amount',v_buy_in,'buy_in_fee',v_fee,
    'total',v_total,'bounty_amount',v_bounty,'is_mystery_bounty',v_mystery,'asset','diamonds',
    'satellite_target_id',v_target_id,'satellite_ticket',
    CASE WHEN v_satellite THEN v_target.buy_in_amount + COALESCE(v_target.buy_in_fee,0) END));
END $function$;
ALTER FUNCTION public.fn_poker_diamond_create_tournament(p_config jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_create_tournament(p_config jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_create_tournament(p_config jsonb) TO authenticated, service_role;
-- @@END fn_poker_diamond_create_tournament(p_config jsonb)

-- @@DOOR fn_poker_diamond_open_cash_table(p_name text, p_small_blind integer, p_big_blind integer, p_min_buy_in integer, p_max_buy_in integer, p_max_players integer, p_game_variant text)
-- @@PIN md5=116919d8ea2a3bd49d92e72837e0d3b4 len=3836 owner=postgres
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
ALTER FUNCTION public.fn_poker_diamond_open_cash_table(p_name text, p_small_blind integer, p_big_blind integer, p_min_buy_in integer, p_max_buy_in integer, p_max_players integer, p_game_variant text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_open_cash_table(p_name text, p_small_blind integer, p_big_blind integer, p_min_buy_in integer, p_max_buy_in integer, p_max_players integer, p_game_variant text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_open_cash_table(p_name text, p_small_blind integer, p_big_blind integer, p_min_buy_in integer, p_max_buy_in integer, p_max_players integer, p_game_variant text) TO authenticated, service_role;
-- @@END fn_poker_diamond_open_cash_table(p_name text, p_small_blind integer, p_big_blind integer, p_min_buy_in integer, p_max_buy_in integer, p_max_players integer, p_game_variant text)

-- @@DOOR fn_poker_diamond_plain_cash_table(p_t tables)
-- @@PIN md5=94fb4dd7359850d388262de813c0caf1 len=880 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_plain_cash_table(p_t tables)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT NOT (
    NOT public.fn_poker_diamond_cash_variant(p_t.game_variant)
    OR p_t.tournament_id IS NOT NULL
    OR p_t.cluster_id IS NOT NULL
    OR coalesce(p_t.is_template,false)
    OR p_t.status NOT IN ('waiting','running','playing','active')
    OR p_t.rake_percent IS DISTINCT FROM 0 OR p_t.rake_cap_bb IS DISTINCT FROM 0
    OR p_t.bbj_percent IS DISTINCT FROM 0
    OR coalesce(p_t.insurance_enabled,false)
    OR p_t.run_it_twice IS NULL OR p_t.allow_run_it_twice IS NULL
    OR coalesce(p_t.seven_deuce_enabled,false) OR coalesce(p_t.nit_game,false)
    OR coalesce(p_t.all_in_or_fold,false) OR coalesce(p_t.pineapple_holdem,false)
    OR coalesce(p_t.cap_enabled,false)
  );
$function$;
ALTER FUNCTION public.fn_poker_diamond_plain_cash_table(p_t tables) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_plain_cash_table(p_t tables) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_plain_cash_table(p_t tables) TO authenticated, service_role;
-- @@END fn_poker_diamond_plain_cash_table(p_t tables)

-- @@DOOR fn_poker_diamond_staff_audit(p_action text, p_target_type text, p_target_id uuid, p_before jsonb, p_after jsonb, p_details jsonb)
-- @@PIN md5=14bcef64645d1ca77f5243ca4bd1b428 len=1626 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_staff_audit(p_action text, p_target_type text, p_target_id uuid, p_before jsonb, p_after jsonb, p_details jsonb DEFAULT '{}'::jsonb)
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
ALTER FUNCTION public.fn_poker_diamond_staff_audit(p_action text, p_target_type text, p_target_id uuid, p_before jsonb, p_after jsonb, p_details jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_staff_audit(p_action text, p_target_type text, p_target_id uuid, p_before jsonb, p_after jsonb, p_details jsonb) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_poker_diamond_staff_audit(p_action text, p_target_type text, p_target_id uuid, p_before jsonb, p_after jsonb, p_details jsonb)

-- @@DOOR fn_poker_diamond_top_up(p_user_id uuid, p_table_id uuid, p_amount numeric, p_expected_stack numeric, p_request_id uuid)
-- @@PIN md5=f7659bddc424e9e4b6785228ee0eec6a len=7985 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_top_up(p_user_id uuid, p_table_id uuid, p_amount numeric, p_expected_stack numeric, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 v_t public.tables%ROWTYPE;
 v_seat public.table_seats%ROWTYPE;
 v_c public.poker_diamond_custody%ROWTYPE;
 v_prev public.poker_diamond_movements%ROWTYPE;
 v_request jsonb; v_receipt jsonb;
 v_wallet bigint; v_locked bigint; v_days integer;
 v_left bigint; v_take bigint; v_lot record; v_journal uuid;
BEGIN
 IF p_user_id IS NULL OR p_table_id IS NULL OR p_request_id IS NULL
    OR p_amount IS NULL OR p_amount NOT BETWEEN 1 AND 2147483647 OR p_amount<>trunc(p_amount)
    OR p_expected_stack IS NULL OR p_expected_stack NOT BETWEEN 0 AND 2147483647
    OR p_expected_stack<>trunc(p_expected_stack) THEN
  RAISE EXCEPTION 'invalid_diamond_top_up' USING ERRCODE='22023';
 END IF;
 v_request:=jsonb_build_object('user_id',p_user_id,'table_id',p_table_id,
  'amount',p_amount,'expected_stack',p_expected_stack,'action','top_up');
 PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:'||p_table_id,0));
 -- The table row before the wallet. The hand settler, the buy-in and the cash-out
 -- all take this table and then the wallet; a top-up that took the wallet first
 -- deadlocked against the settlement of the hand it followed (Diamond Phase 11
 -- line 5, measured). Locked bare, so every refusal and replay below answers as
 -- it did: only the order in which the locks are taken changes.
 PERFORM 1 FROM public.tables WHERE id=p_table_id FOR UPDATE;
 -- Then the wallet, before its custody and lots, as the reserve and the settler take it.
 SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=p_user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found'; END IF;
 SELECT * INTO v_prev FROM public.poker_diamond_movements WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_prev.request IS DISTINCT FROM v_request THEN
   RAISE EXCEPTION 'idempotency_payload_mismatch';
  END IF;
  RETURN v_prev.receipt;
 END IF;
 SELECT t.* INTO v_t FROM public.tables t
   JOIN public.clubs c ON c.id=t.club_id
   JOIN public.ca_arena_settings a ON a.id=1 AND a.club_id=c.id
 WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
   AND c.union_id IS NULL AND t.union_id IS NULL AND a.cash_games_enabled
 FOR UPDATE OF t;
 IF NOT FOUND THEN RAISE EXCEPTION 'diamond_cash_not_open' USING ERRCODE='55000'; END IF;
 IF NOT public.fn_poker_diamond_plain_cash_table(v_t) THEN
  RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM (VALUES(v_t.small_blind),(v_t.big_blind),
      (v_t.min_buy_in),(v_t.max_buy_in)) AS amount(value)
      WHERE value IS NULL OR value NOT BETWEEN 1 AND 2147483647 OR value<>trunc(value))
    OR COALESCE(v_t.ante,0) NOT BETWEEN 0 AND 9007199254740991
    OR COALESCE(v_t.ante,0)<>trunc(COALESCE(v_t.ante,0)) THEN
  RAISE EXCEPTION 'diamond_cash_requires_whole_amounts' USING ERRCODE='23514';
 END IF;
 SELECT * INTO v_seat FROM public.table_seats
  WHERE table_id=p_table_id AND user_id=p_user_id AND left_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'diamond_top_up_requires_a_live_seat' USING ERRCODE='55000';
 END IF;
 IF v_seat.stack IS DISTINCT FROM p_expected_stack THEN
  RAISE EXCEPTION 'diamond_top_up_stale_seat' USING ERRCODE='55000';
 END IF;
 IF v_seat.stack+p_amount>v_t.max_buy_in THEN
  RAISE EXCEPTION 'diamond_top_up_exceeds_max_buy_in' USING ERRCODE='23514';
 END IF;
 SELECT * INTO v_c FROM public.poker_diamond_custody
  WHERE occupancy_id=v_seat.occupancy_id AND seat_id=v_seat.id
    AND seat_joined_at=v_seat.joined_at AND user_id=p_user_id
    AND target_id=p_table_id AND arena_id=v_t.club_id
    AND purpose='cash_seat' AND state='active' FOR UPDATE;
 IF NOT FOUND OR v_c.balance IS DISTINCT FROM v_seat.stack::bigint THEN
  RAISE EXCEPTION 'diamond_top_up_custody_mismatch' USING ERRCODE='23514';
 END IF;
 SELECT settlement_window_days INTO v_days FROM public.ca_arena_settings
  WHERE id=1 AND club_id=v_t.club_id;
 IF v_days IS NULL THEN RAISE EXCEPTION 'diamond_arena_policy_missing'; END IF;
 IF EXISTS(SELECT 1 FROM public.diamond_debts
   WHERE user_id=p_user_id AND settled_at IS NULL AND amount>0) THEN
  RAISE EXCEPTION 'diamond_debt_requires_settlement';
 END IF;
 PERFORM id FROM public.diamond_purchase_lots WHERE user_id=p_user_id ORDER BY created_at,id FOR UPDATE;
 SELECT COALESCE(sum(GREATEST(issued-consumed-refunded-arena_reserved,0)),0) INTO v_locked
  FROM public.diamond_purchase_lots WHERE user_id=p_user_id
   AND (frozen_at IS NOT NULL OR created_at>now()-make_interval(days=>v_days));
 IF v_wallet IS NULL OR v_wallet-v_locked<p_amount THEN
  RAISE EXCEPTION 'insufficient_settled_diamonds';
 END IF;
 v_left:=p_amount;
 FOR v_lot IN SELECT id,GREATEST(issued-consumed-refunded-arena_reserved,0) available
  FROM public.diamond_purchase_lots WHERE user_id=p_user_id AND frozen_at IS NULL
   AND created_at<=now()-make_interval(days=>v_days) ORDER BY created_at,id LOOP
  EXIT WHEN v_left=0;
  v_take:=LEAST(v_left,v_lot.available);
  IF v_take>0 THEN
   UPDATE public.diamond_purchase_lots SET arena_reserved=arena_reserved+v_take WHERE id=v_lot.id;
   -- (custody_id,lot_id) is the primary key and the hand settler consumes a lot
   -- by that key. A second row for the same pair would let one loss be taken
   -- twice, so a lot this custody already holds has its held amount raised.
   UPDATE public.poker_diamond_lot_reservations SET amount=amount+v_take
     WHERE custody_id=v_c.id AND lot_id=v_lot.id AND released_at IS NULL;
   IF NOT FOUND THEN
    BEGIN
     INSERT INTO public.poker_diamond_lot_reservations(custody_id,lot_id,amount)
      VALUES(v_c.id,v_lot.id,v_take);
    EXCEPTION WHEN unique_violation THEN
     RAISE EXCEPTION 'diamond_top_up_lot_already_released' USING ERRCODE='23514';
    END;
   END IF;
   v_left:=v_left-v_take;
  END IF;
 END LOOP;
 -- Journal before the balance, so the existing DR6 audit sees its evidence in
 -- this same atomic transaction.
 INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after,
  reference_id,description,source,issuance_class,counterparty,metadata)
 VALUES(p_user_id,'arena_deposit','arena_deposit',-p_amount::integer,v_wallet-p_amount,
  'poker-topup:'||p_request_id,'Added diamonds to a Poker Arena seat','poker_arena','arena',
  'arena_custody:'||v_c.id,jsonb_build_object('custody_id',v_c.id,'request_id',p_request_id,
   'purpose','cash_seat','target_id',p_table_id,'seat_id',v_seat.id,
   'purchased_reserved',p_amount-v_left)) RETURNING id INTO v_journal;
 UPDATE public.profiles SET diamonds=diamonds-p_amount::integer,updated_at=now() WHERE id=p_user_id;
 UPDATE public.poker_diamond_custody SET balance=balance+p_amount WHERE id=v_c.id;
 UPDATE public.table_seats SET stack=stack+p_amount
  WHERE id=v_seat.id AND joined_at=v_seat.joined_at AND occupancy_id=v_seat.occupancy_id
    AND left_at IS NULL;
 IF NOT EXISTS(SELECT 1 FROM public.table_seats s
    JOIN public.poker_diamond_custody c ON c.id=v_c.id AND c.seat_id=s.id
   WHERE s.id=v_seat.id AND s.left_at IS NULL
     AND s.stack=v_seat.stack+p_amount AND c.balance=v_c.balance+p_amount) THEN
  RAISE EXCEPTION 'diamond_top_up_seat_write_failed' USING ERRCODE='23514';
 END IF;
 v_receipt:=jsonb_build_object('success',true,'custody_id',v_c.id,'request_id',p_request_id,
  'amount',p_amount,'stack',v_seat.stack+p_amount,'custody_balance',v_c.balance+p_amount,
  'available_balance',v_wallet-p_amount,'journal_id',v_journal);
 INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,
  source_account,destination_account,wallet_journal_id,request,receipt)
 VALUES(p_request_id,v_c.id,p_user_id,'reserve',p_amount,'player:'||p_user_id,
  'arena_custody:'||v_c.id,v_journal,v_request,v_receipt);
 RETURN v_receipt;
END $function$;
ALTER FUNCTION public.fn_poker_diamond_top_up(p_user_id uuid, p_table_id uuid, p_amount numeric, p_expected_stack numeric, p_request_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_top_up(p_user_id uuid, p_table_id uuid, p_amount numeric, p_expected_stack numeric, p_request_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_top_up(p_user_id uuid, p_table_id uuid, p_amount numeric, p_expected_stack numeric, p_request_id uuid) TO service_role;
-- @@END fn_poker_diamond_top_up(p_user_id uuid, p_table_id uuid, p_amount numeric, p_expected_stack numeric, p_request_id uuid)

-- @@DOOR fn_poker_guard_arena_structure()
-- @@PIN md5=d3ecf93c4ac0aced79031b4ce00df59b len=3790 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_guard_arena_structure()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_asset text;
BEGIN
  IF TG_TABLE_NAME='clubs' THEN
    IF TG_OP='UPDATE' AND (NEW.asset,NEW.is_platform) IS DISTINCT FROM (OLD.asset,OLD.is_platform) THEN
      RAISE EXCEPTION 'Arena Asset Is Immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.asset='diamonds' AND auth.uid() IS NOT NULL AND coalesce(auth.jwt()->>'role','') <> 'service_role'
       AND NOT coalesce(public.fn_is_platform_admin(),false) THEN
      RAISE EXCEPTION 'Diamond Arena Requires Platform Operations' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  SELECT asset INTO v_asset FROM public.clubs WHERE id=NEW.club_id;
  IF TG_TABLE_NAME='club_members' AND TG_OP='UPDATE' AND NEW.club_id IS DISTINCT FROM OLD.club_id
     AND EXISTS (SELECT 1 FROM public.clubs WHERE id=OLD.club_id AND asset='diamonds') THEN
    RAISE EXCEPTION 'Diamond Participation Cannot Become A Chip Membership' USING ERRCODE='23514';
  END IF;
  -- Branch before resolving fields: membership rows do not have union_id.
  IF TG_TABLE_NAME IN ('tables','tournaments') THEN
    IF TG_OP='UPDATE' AND NEW.club_id IS DISTINCT FROM OLD.club_id
       AND (EXISTS (SELECT 1 FROM public.clubs WHERE id=OLD.club_id AND asset IS DISTINCT FROM v_asset)
         OR (OLD.club_id IS NULL AND OLD.union_id IS NOT NULL AND v_asset='diamonds')) THEN
      RAISE EXCEPTION 'Game Asset Is Immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF v_asset='diamonds' THEN
    IF TG_TABLE_NAME='club_members' THEN
      IF TG_OP='INSERT' OR NEW.role IS DISTINCT FROM 'player' OR NEW.status IS DISTINCT FROM 'automatic'
         OR NEW.agent_id IS NOT NULL OR NEW.parent_agent_id IS NOT NULL
         OR coalesce(NEW.chip_balance,0)<>0 OR coalesce(NEW.credit_limit,0)<>0
         OR coalesce(NEW.credit_used,0)<>0 OR coalesce(NEW.promo_balance,0)<>0
         OR coalesce(NEW.held_chips,0)<>0 THEN
        RAISE EXCEPTION 'Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy' USING ERRCODE='23514';
      END IF;
    ELSIF TG_TABLE_NAME='union_clubs' THEN
      RAISE EXCEPTION 'Diamond Arena Cannot Join A Union' USING ERRCODE='23514';
    ELSIF auth.uid() IS NOT NULL AND coalesce(auth.jwt()->>'role','') <> 'service_role'
       AND NOT coalesce(public.fn_is_platform_admin(),false)
       -- DIAMOND PHASE 8: a player's entry, add-on and withdrawal move the
       -- play-state counters through the estate's doors; the structure is
       -- still platform operations only.
       AND NOT (TG_OP='UPDATE' AND TG_TABLE_NAME IN ('tournaments','tables')
                -- DIAMOND PHASE 11: a stored generated column is NULL in NEW before
                -- the row is written, and follows the base columns compared here; it
                -- is left out, or a player's buy-in reads as a structural change.
                AND (to_jsonb(NEW) - public.fn_poker_diamond_play_state_columns(TG_TABLE_NAME)
                       - ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a
                                WHERE a.attrelid = TG_RELID AND a.attgenerated <> '' AND NOT a.attisdropped))
                  = (to_jsonb(OLD) - public.fn_poker_diamond_play_state_columns(TG_TABLE_NAME)
                       - ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a
                                WHERE a.attrelid = TG_RELID AND a.attgenerated <> '' AND NOT a.attisdropped))) THEN
      RAISE EXCEPTION 'Diamond Games Require Platform Operations' USING ERRCODE='42501';
    ELSIF NEW.union_id IS NOT NULL THEN
      RAISE EXCEPTION 'Diamond Games Cannot Belong To A Union' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_poker_guard_arena_structure() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_guard_arena_structure() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_guard_arena_structure() TO service_role;
-- @@END fn_poker_guard_arena_structure()

-- @@DOOR fn_poker_reject_diamond_chip_money()
-- @@PIN md5=7c61e72bf8bc26c15490b31bed7bc912 len=1446 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_reject_diamond_chip_money()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row jsonb := to_jsonb(NEW);
BEGIN
  /* DIAMOND PHASE 9, STEP 0 (2026-09-29). Ruling 16: no unions, agents,
     commissions, chip wallets or chip ledgers in the Diamond Arena. A row of
     a chip money table that belongs to the arena - by its club, by the table
     it was played at, or by the event it was paid into - is refused by name,
     as poker_arena_no_hierarchy refuses an agent row. */
  IF EXISTS (SELECT 1 FROM public.clubs c
              WHERE c.id = (v_row->>'club_id')::uuid AND c.asset = 'diamonds')
     OR EXISTS (SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id = t.club_id
                 WHERE t.id = (v_row->>'table_id')::uuid AND c.asset = 'diamonds')
     OR EXISTS (SELECT 1 FROM public.tournaments e JOIN public.clubs c ON c.id = e.club_id
                 WHERE e.id IN ((v_row->>'tournament_id')::uuid,
                                (v_row->>'source_tournament_id')::uuid,
                                (v_row->>'source_satellite_id')::uuid)
                   AND c.asset = 'diamonds') THEN
    RAISE EXCEPTION 'Diamond Arena Has No Chip Money' USING ERRCODE = '23514',
      DETAIL = format('public.%I refuses a row that belongs to the Diamond Arena.', TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_poker_reject_diamond_chip_money() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_reject_diamond_chip_money() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_reject_diamond_chip_money() TO service_role;
-- @@END fn_poker_reject_diamond_chip_money()

-- @@DOOR fn_publish_profile_account_change()
-- @@PIN md5=84dcc945b3e6d19254a5b901d365eca6 len=1698 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_publish_profile_account_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_domains text[] := ARRAY[]::text[];
BEGIN
  IF ROW(OLD.username, OLD.display_name, OLD.alias, OLD.first_name, OLD.last_name,
         OLD.full_name, OLD.display_name_preference, OLD.use_real_name,
         OLD.bio, OLD.player_tags, OLD.login_streak, OLD.vip_tier)
    IS DISTINCT FROM
     ROW(NEW.username, NEW.display_name, NEW.alias, NEW.first_name, NEW.last_name,
         NEW.full_name, NEW.display_name_preference, NEW.use_real_name,
         NEW.bio, NEW.player_tags, NEW.login_streak, NEW.vip_tier)
  THEN v_domains := array_append(v_domains, 'metadata'); END IF;
  IF ROW(OLD.settings->'theme', OLD.settings->'achievementNotifications',
         OLD.settings->'settlementAlerts') IS DISTINCT FROM
     ROW(NEW.settings->'theme', NEW.settings->'achievementNotifications',
         NEW.settings->'settlementAlerts')
  THEN v_domains := array_append(v_domains, 'settings'); END IF;
  IF OLD.diamonds IS DISTINCT FROM NEW.diamonds
  THEN v_domains := array_append(v_domains, 'diamonds'); END IF;

  IF cardinality(v_domains) = 0 THEN RETURN NEW; END IF;
  BEGIN
    PERFORM realtime.send(jsonb_build_object('user_id', NEW.id, 'domains', v_domains),
      'account_changed', 'profile-account:' || NEW.id::text, true);
  EXCEPTION WHEN OTHERS THEN
    -- Source persistence must never depend on notification availability.
    -- Initial, rejoin and visibility reads recover the authoritative value.
    RAISE WARNING 'Account change signal delivery failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_publish_profile_account_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_publish_profile_account_change() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_publish_profile_account_change() TO service_role;
-- @@END fn_publish_profile_account_change()

-- @@DOOR fn_publish_profile_appearance_change()
-- @@PIN md5=64cc449327fe6d17bc0ba9c51144196a len=1028 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_publish_profile_appearance_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_table_id uuid;
  v_signal jsonb := jsonb_build_object('user_id', NEW.id);
BEGIN
  -- The source edit is authoritative. An unavailable signal transport must
  -- not roll back a profile or a surrounding transaction. Rejoin/visibility
  -- reads recover the persisted appearance without any background repair job.
  BEGIN
    PERFORM realtime.send(v_signal, 'appearance_changed',
      'profile-appearance:' || NEW.id::text, true);
    FOR v_table_id IN
      SELECT DISTINCT s.table_id FROM public.table_seats s
      WHERE s.user_id = NEW.id AND s.left_at IS NULL
    LOOP
      PERFORM realtime.send(v_signal, 'appearance_changed',
        'table-appearance:' || v_table_id::text, true);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Appearance signal delivery failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_publish_profile_appearance_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_publish_profile_appearance_change() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_publish_profile_appearance_change() TO service_role;
-- @@END fn_publish_profile_appearance_change()

-- @@DOOR fn_raise_server_financial_alert(p_severity text, p_source text, p_message text, p_context jsonb, p_dedupe_key text, p_entity_id text)
-- @@PIN md5=264d32bcba8f6430ea68b7ca9738fbc8 len=2060 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_raise_server_financial_alert(p_severity text, p_source text, p_message text, p_context jsonb DEFAULT '{}'::jsonb, p_dedupe_key text DEFAULT NULL::text, p_entity_id text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id     uuid;
  v_sev    text;
  v_source text;
  v_key    text;
  v_entity text;
  v_recent integer;
BEGIN
  v_sev := lower(coalesce(p_severity, 'info'));
  IF v_sev NOT IN ('critical', 'warning', 'info') THEN
    v_sev := 'info';
  END IF;

  v_source := left(coalesce(nullif(p_source, ''), 'unknown'), 200);
  v_entity := left(nullif(btrim(coalesce(p_entity_id, '')), ''), 200);
  v_key    := left(nullif(btrim(coalesce(p_dedupe_key, '')), ''), 200);
  IF v_key IS NULL THEN
    v_key := v_entity;
  END IF;

  /* ONE OPEN ALERT PER THING THAT IS WRONG. Not per pass over it. */
  IF v_key IS NOT NULL THEN
    SELECT fa.id INTO v_id
      FROM public.financial_alerts fa
     WHERE fa.source = v_source
       AND fa.resolved IS NOT TRUE
       AND fa.context ->> 'dedupe_key' = v_key
     ORDER BY fa.created_at DESC
     LIMIT 1;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  SELECT count(*) INTO v_recent
    FROM public.financial_alerts
   WHERE created_at > now() - interval '1 minute'
     AND source = v_source
     AND context ->> 'channel' = 'server_rpc';

  IF v_recent >= 60 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.financial_alerts (severity, source, message, context, resolved)
  VALUES (
    v_sev,
    v_source,
    left(coalesce(nullif(p_message, ''), '(no message)'), 4000),
    coalesce(p_context, '{}'::jsonb)
      || jsonb_build_object('channel', 'server_rpc')
      || CASE WHEN v_key IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object('dedupe_key', v_key) END
      || CASE WHEN v_entity IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object('entity_id', v_entity) END,
    false
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;
ALTER FUNCTION public.fn_raise_server_financial_alert(p_severity text, p_source text, p_message text, p_context jsonb, p_dedupe_key text, p_entity_id text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_raise_server_financial_alert(p_severity text, p_source text, p_message text, p_context jsonb, p_dedupe_key text, p_entity_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_raise_server_financial_alert(p_severity text, p_source text, p_message text, p_context jsonb, p_dedupe_key text, p_entity_id text) TO service_role;
-- @@END fn_raise_server_financial_alert(p_severity text, p_source text, p_message text, p_context jsonb, p_dedupe_key text, p_entity_id text)

-- @@DOOR fn_record_operational_alert(p_source text, p_event_key text, p_alertname text, p_status text, p_severity text, p_payload jsonb)
-- @@PIN md5=36601e205494e8768f5a1dce09f4a186 len=650 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_record_operational_alert(p_source text, p_event_key text, p_alertname text, p_status text, p_severity text, p_payload jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_id bigint;
BEGIN
  INSERT INTO public.operational_alert_events(source,event_key,alertname,status,severity,payload)
  VALUES(p_source,p_event_key,p_alertname,p_status,p_severity,p_payload)
  ON CONFLICT (source,event_key) DO UPDATE
  SET last_received_at=clock_timestamp(), delivery_count=operational_alert_events.delivery_count+1
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;
ALTER FUNCTION public.fn_record_operational_alert(p_source text, p_event_key text, p_alertname text, p_status text, p_severity text, p_payload jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_record_operational_alert(p_source text, p_event_key text, p_alertname text, p_status text, p_severity text, p_payload jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_record_operational_alert(p_source text, p_event_key text, p_alertname text, p_status text, p_severity text, p_payload jsonb) TO service_role;
-- @@END fn_record_operational_alert(p_source text, p_event_key text, p_alertname text, p_status text, p_severity text, p_payload jsonb)

-- @@DOOR fn_refuse_new_entries_while_frozen()
-- @@PIN md5=7d7bd629403539eb069ac20afc62b547 len=4852 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_refuse_new_entries_while_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_is_cash boolean;
BEGIN
  /* Classify non-admissions before asking for the boundary. Departures,
     ordinary seat updates, tournament table balancing, earned satellite
     seats, and non-RUNNING status changes can arrive inside transactions that
     already own their own rows. They are not new entry and must never acquire
     this lock late. */
  IF TG_TABLE_NAME = 'table_seats' THEN
    IF TG_OP = 'UPDATE'
       AND NOT (
         (OLD.left_at IS NOT NULL AND NEW.left_at IS NULL)
         OR OLD.user_id IS DISTINCT FROM NEW.user_id
       ) THEN
      RETURN NEW;
    END IF;

    SELECT (t.tournament_id IS NULL) INTO v_is_cash
      FROM public.tables t
     WHERE t.id = NEW.table_id;
    /* Tournament seating is movement inside an already-admitted field. This
       includes INSERT and reuse of a vacated destination row (UPDATE that
       clears left_at or changes user_id). Freezing the latter after its source
       seat was vacated strands a player between tables. New tournament entry
       remains guarded at tournament_players and in its canonical outer RPC. */
    IF NOT COALESCE(v_is_cash, true) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'tournaments' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status <> 'RUNNING' THEN
      RETURN NEW;
    END IF;
    /* This is not a new launch: fn_begin_tournament_launch_atomic already
       admitted it before the maintenance boundary. Only the private completion
       RPC can set this exact transaction-local marker, and the immutable
       incomplete receipt proves which launch it is completing. */
    IF OLD.status = 'REGISTERING'
       AND EXISTS (
         SELECT 1
           FROM public.tournament_launch_receipts r
          WHERE r.tournament_id = NEW.id
            AND r.completed_at IS NULL
            AND current_setting('app.atomic_tournament_launch', true)
                = NEW.id::text || ':' || r.launch_id::text
       ) THEN
      RETURN NEW;
    END IF;
    /* A BAGGED EVENT RESUMES ONLY THROUGH ITS STAGE RESUME RECEIPT
       (multi-day, 20260924043224). The private resume completion RPC sets
       this exact transaction-local marker, the incomplete receipt proves
       which resume it completes, and its begin already took the
       maintenance barrier. Every other write into RUNNING still raises. */
    IF OLD.status = 'BAGGED'
       AND EXISTS (
         SELECT 1
           FROM public.tournament_stage_resume_receipts r
          WHERE r.tournament_id = NEW.id
            AND r.completed_at IS NULL
            AND current_setting('app.atomic_stage_resume', true)
                = NEW.id::text || ':' || r.resume_id::text
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'TOURNAMENT_LAUNCH_RECEIPT_REQUIRED: REGISTERING to RUNNING belongs to the atomic launch completion RPC'
      USING ERRCODE = '55000';
  ELSIF TG_TABLE_NAME = 'tournament_players' THEN
    /* Every roster insertion must serialize on its tournament parent before
       launch completion proves the field. Canonical registration functions
       already take this lock before their first child mutation, so this is
       re-entrant there; it closes the direct-owner/legacy path that could
       otherwise commit a new registered row between completion's roster read
       and its RUNNING write. */
    PERFORM 1
      FROM public.tournaments t
     WHERE t.id = NEW.tournament_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tournament % does not exist', NEW.tournament_id
        USING ERRCODE = '23503';
    END IF;

    IF COALESCE(NEW.is_satellite_qualifier, false)
       AND NEW.source_satellite_id IS NOT NULL
       AND current_setting('app.atomic_satellite_settlement', true)
           = NEW.source_satellite_id::text THEN
      RETURN NEW;
    END IF;
  END IF;

  /* Canonical RPCs own this already, so try-lock is re-entrant. A direct or
     previously unknown outer caller fails without waiting while it may hold
     other rows; this is the deadlock-safe backstop, not the normal path. */
  IF NOT pg_try_advisory_xact_lock_shared(530090, 1) THEN
    RAISE EXCEPTION
      'ENTRY_BOUNDARY_BUSY: maintenance announcement owns the entry boundary'
      USING ERRCODE = '40001';
  END IF;

  IF public.fn_freeze_bypass_active() THEN
    RETURN NEW;
  END IF;

  IF NOT public.fn_entry_purchases_frozen() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'PLATFORM_FROZEN: scheduled maintenance has closed new entries. % on % was refused without moving chips.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = '55006',
          HINT = 'Retry after the maintenance break has ended.';
END;
$function$;
ALTER FUNCTION public.fn_refuse_new_entries_while_frozen() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_refuse_new_entries_while_frozen() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_refuse_new_entries_while_frozen() TO service_role;
-- @@END fn_refuse_new_entries_while_frozen()

-- @@DOOR fn_register_for_tournament(p_tournament_id uuid, p_seat_first_internal boolean)
-- @@PIN md5=0f3b104a1bf9431d70053c656fedc081 len=792 owner=postgres
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
$function$;
ALTER FUNCTION public.fn_register_for_tournament(p_tournament_id uuid, p_seat_first_internal boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_register_for_tournament(p_tournament_id uuid, p_seat_first_internal boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_register_for_tournament(p_tournament_id uuid, p_seat_first_internal boolean) TO service_role;
-- @@END fn_register_for_tournament(p_tournament_id uuid, p_seat_first_internal boolean)

-- @@DOOR fn_register_for_tournament_request(p_tournament_id uuid, p_request_id uuid)
-- @@PIN md5=9d174770c0de981532c2d35d58743397 len=2114 owner=postgres
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
$function$;
ALTER FUNCTION public.fn_register_for_tournament_request(p_tournament_id uuid, p_request_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_register_for_tournament_request(p_tournament_id uuid, p_request_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_register_for_tournament_request(p_tournament_id uuid, p_request_id uuid) TO authenticated;
-- @@END fn_register_for_tournament_request(p_tournament_id uuid, p_request_id uuid)

-- @@DOOR fn_reject_horse_name_on_human()
-- @@PIN md5=ff58f7bb658731e107393cd94bd594c7 len=1746 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_reject_horse_name_on_human()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF COALESCE(NEW.is_horse, false) = false THEN
    IF NEW.display_name IS NOT NULL
       AND btrim(NEW.display_name) <> ''
       AND EXISTS (
         SELECT 1
           FROM public.profiles h
          WHERE COALESCE(h.is_horse, false)
            AND h.display_name IS NOT NULL
            AND h.id IS DISTINCT FROM NEW.id
            AND lower(btrim(h.display_name)) = lower(btrim(NEW.display_name))
       )
    THEN
      -- Drop the borrowed name instead of failing the whole write: this fires on
      -- ordinary profile saves, and a hard error would block a player editing
      -- something unrelated. The name is the only thing rejected.
      NEW.display_name := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- The same rule from the other side. A horse may not be written carrying a
  -- name a person is using, because that produces the state of 2026-08-23 with
  -- the two rows written in the opposite order. This side raises: see the
  -- header for why a null name cannot be the answer for a horse.
  IF coalesce(btrim(NEW.display_name), '') <> ''
     AND EXISTS (
       SELECT 1
         FROM public.profiles u
        WHERE NOT COALESCE(u.is_horse, false)
          AND u.id IS DISTINCT FROM NEW.id
          AND lower(btrim(u.display_name)) = lower(btrim(NEW.display_name))
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'a horse may not be given the name of a person on this platform',
      HINT    = 'choose another name for the horse; the person keeps theirs';
  END IF;
  RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_reject_horse_name_on_human() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_reject_horse_name_on_human() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_reject_horse_name_on_human() TO service_role;
-- @@END fn_reject_horse_name_on_human()

-- @@DOOR fn_release_seats_on_tournament_finish()
-- @@PIN md5=7e9ab84b48a96dda6029414f889ab39f len=669 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_release_seats_on_tournament_finish()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only on the TRANSITION into a finished state. Firing on every update of an
  -- already-finished row would rewrite left_at timestamps that are correct.
  IF NEW.status IN ('COMPLETED','CANCELLED')
     AND (OLD.status IS DISTINCT FROM NEW.status) THEN

    UPDATE table_seats ts
       SET left_at = COALESCE(NEW.ended_at, now())
      FROM tables t
     WHERE ts.table_id = t.id
       AND t.tournament_id = NEW.id
       AND ts.left_at IS NULL;

  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_release_seats_on_tournament_finish() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_release_seats_on_tournament_finish() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_release_seats_on_tournament_finish() TO service_role;
-- @@END fn_release_seats_on_tournament_finish()

-- @@DOOR fn_require_live_seat_parent()
-- @@PIN md5=799eb3f8788b5ee10e98da69cf52c12e len=1849 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_require_live_seat_parent()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE parent_key text;
BEGIN
 IF NEW.left_at IS NOT NULL THEN
  NEW.active_parent_key := NULL;
  RETURN NEW;
 END IF;
 SELECT t.seat_admission_key INTO parent_key FROM public.tables t WHERE t.id=NEW.table_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Active seat requires an existing parent table' USING ERRCODE='23514'; END IF;
 IF parent_key IS NULL THEN
  -- Only a pre-migration empty parent needs this initialization. Ordinary
  -- admissions do not update/lock the parent ahead of the native FK check.
  UPDATE public.tables t SET seat_admission_key = CASE
    WHEN lower(coalesce(t.status,'')) IN ('closed','completed','cancelled','finished')
      OR t.lifecycle='closed' OR coalesce(t.is_deleted,false) OR coalesce(t.is_template,false) THEN 'closed'
    WHEN t.tournament_id IS NOT NULL THEN 'tournament:'||t.tournament_id::text
    ELSE 'cash' END
  WHERE t.id=NEW.table_id AND t.seat_admission_key IS NULL;
  SELECT t.seat_admission_key INTO parent_key FROM public.tables t WHERE t.id=NEW.table_id;
 END IF;
 IF parent_key IS NULL OR parent_key='closed' THEN
  RAISE EXCEPTION 'CLOSED_TABLE_REJECTS_ACTIVE_SEAT' USING ERRCODE='23514';
 END IF;

 IF TG_OP='INSERT' OR OLD.left_at IS NOT NULL
   OR OLD.table_id IS DISTINCT FROM NEW.table_id OR OLD.user_id IS DISTINCT FROM NEW.user_id THEN
  IF (current_setting('app.money_path',true) IN ('atomic_table_buyin','fn_horse_seat_from_treasury')
      OR current_setting('app.cash_seat_move',true)='on') AND parent_key<>'cash' THEN
   RAISE EXCEPTION 'CASH_PURCHASE_ONLY: cash admission cannot create tournament chips' USING ERRCODE='55000';
  END IF;
 END IF;
 NEW.active_parent_key := parent_key;
 RETURN NEW;
END
$function$;
ALTER FUNCTION public.fn_require_live_seat_parent() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_require_live_seat_parent() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_require_live_seat_parent()

-- @@DOOR fn_satellite_target_contract_is_immutable()
-- @@PIN md5=68f353273fb27d0eee5021481192e902 len=1845 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_satellite_target_contract_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(OLD.entry_contract_locked,false)
     AND NEW.entry_contract_locked IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'tournament % funded-entry contract marker cannot be cleared',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF (NEW.buy_in_amount,NEW.buy_in_fee,NEW.bounty_amount,
      NEW.rebuy_cost,NEW.addon_cost,
      NEW.is_bounty,NEW.is_pko,NEW.is_mystery_bounty,NEW.is_premium_spin,
      NEW.variant,NEW.tournament_type,NEW.club_id)
       IS NOT DISTINCT FROM
     (OLD.buy_in_amount,OLD.buy_in_fee,OLD.bounty_amount,
      OLD.rebuy_cost,OLD.addon_cost,
      OLD.is_bounty,OLD.is_pko,OLD.is_mystery_bounty,OLD.is_premium_spin,
      OLD.variant,OLD.tournament_type,OLD.club_id) THEN
    RETURN NEW;
  END IF;
  IF COALESCE(OLD.entry_contract_locked,false) THEN
    RAISE EXCEPTION
      'tournament % economic contract is immutable after its first funded entry',
      OLD.id USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.chip_ledger l
     WHERE l.tournament_id = OLD.id
       AND l.from_type = 'player_wallet'
       AND l.to_type = 'prize_liability'
       AND l.to_entity_id = OLD.id
       AND lower(l.category) IN ('tournament_buyin','rebuy','addon')
  ) OR EXISTS (
    SELECT 1
      FROM public.tournament_satellite_settlements h
      JOIN public.tournament_satellite_awards a
        ON a.tournament_id = h.tournament_id
       AND a.delivery_kind IN ('seat','ticket')
     WHERE h.target_id = OLD.id
  ) THEN
    RAISE EXCEPTION
      'tournament % economic contract is immutable after its first funded entry',
      OLD.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_satellite_target_contract_is_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_satellite_target_contract_is_immutable() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_satellite_target_contract_is_immutable()

-- @@DOOR fn_satellite_target_player_provenance_is_immutable()
-- @@PIN md5=68f98d4ec2cb186aae11787f1666cffc len=5401 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_satellite_target_player_provenance_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_ids uuid[] := ARRAY[]::uuid[];
  v_source_id uuid;
  v_status text;
  v_acquisition_key bigint:=hashtextextended(
    'ca:tournament-terminal-settlement:v1',0);
  v_target_key bigint;
  v_owns_acquisition_root boolean:=false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.is_satellite_qualifier IS DISTINCT FROM OLD.is_satellite_qualifier
       OR NEW.source_satellite_id IS DISTINCT FROM OLD.source_satellite_id) THEN
    RAISE EXCEPTION 'tournament player ownership and entry provenance are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.source_satellite_id IS NOT NULL THEN
    v_source_ids := array_append(v_source_ids,OLD.source_satellite_id);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.source_satellite_id IS NOT NULL THEN
    v_source_ids := array_append(v_source_ids,NEW.source_satellite_id);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT a.tournament_id INTO v_source_id
      FROM public.tournament_satellite_awards a
     WHERE a.registration_id = OLD.id;
    IF v_source_id IS NOT NULL THEN
      v_source_ids := array_append(v_source_ids,v_source_id);
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT a.tournament_id INTO v_source_id
      FROM public.tournament_satellite_awards a
     WHERE a.registration_id = NEW.id;
    IF v_source_id IS NOT NULL THEN
      v_source_ids := array_append(v_source_ids,v_source_id);
    END IF;
  END IF;
  -- Ticket admission and an exact pre-start ticket return are the only
  -- lifecycle edges that may respectively add or remove provenance after the
  -- source satellite has closed. Both are authorities of the TARGET event,
  -- the row's own tournament, and hold its lane: T(target) exclusively for
  -- the rolling admission and unregistration doors, G exclusively for the
  -- terminal satellite delivery and ticket-return authorities. Either
  -- exclusive hold is the proof (2026-09-10); a shared hold of either key is
  -- not, and no canonical writer holds T(source) in place of T(target).
  -- Holding G shared, an admission still waits for the source satellite's
  -- terminal settlement, so the committed-receipt read below stays stable.
  -- The unregistration wrapper additionally exposes its exact operation while
  -- the owner-only core is active; a raw DELETE therefore cannot masquerade as
  -- a ticket return merely by reaching this trigger.
  IF TG_OP IN ('INSERT','DELETE') THEN
    v_target_key:=hashtextextended(
      'ca:tournament-terminal-settlement:v1:'||(CASE WHEN TG_OP='INSERT'
        THEN NEW.tournament_id ELSE OLD.tournament_id END)::text,0);
    SELECT EXISTS(
      SELECT 1 FROM pg_catalog.pg_locks l
       WHERE l.pid=pg_backend_pid()
         AND l.locktype='advisory'
         AND l.database=(
           SELECT d.oid FROM pg_catalog.pg_database d
            WHERE d.datname=current_database())
         AND ((l.classid=(((v_acquisition_key>>32)&4294967295)::oid)
               AND l.objid=((v_acquisition_key&4294967295)::oid))
           OR (l.classid=(((v_target_key>>32)&4294967295)::oid)
               AND l.objid=((v_target_key&4294967295)::oid)))
         AND l.objsubid=1
         AND l.mode='ExclusiveLock'
         AND l.granted)
      INTO v_owns_acquisition_root;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.tournament_id IS NOT NULL THEN
    -- The rolling satellite authority owns target before source. Take both
    -- roots in that same order so a direct provenance insert cannot invert
    -- the pair across its specialized and generic guards.
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = NEW.tournament_id FOR SHARE;
    IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal target tournament cannot gain satellite provenance'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    FOREACH v_source_id IN ARRAY v_source_ids LOOP
      IF v_source_id IS DISTINCT FROM NEW.tournament_id THEN
        SELECT upper(COALESCE(t.status::text,'')) INTO v_status
          FROM public.tournaments t
         WHERE t.id = v_source_id FOR SHARE;
        IF v_status IN ('COMPLETED','CANCELLED','CANCELED')
           AND NOT COALESCE(v_owns_acquisition_root,false) THEN
          RAISE EXCEPTION 'completed satellite target provenance is immutable'
            USING ERRCODE = '55000';
        END IF;
      END IF;
    END LOOP;
  END IF;
  IF NOT (
       (TG_OP='INSERT' AND COALESCE(v_owns_acquisition_root,false))
       OR (TG_OP='DELETE'
           AND COALESCE(v_owns_acquisition_root,false)
           AND COALESCE(current_setting(
                 'app.tournament_seat_exit_operation',true),'')='unregister')
     )
     AND EXISTS (
    SELECT 1 FROM unnest(v_source_ids) source(id)
     WHERE public.fn_ca_has_committed_tournament_receipt(source.id)
  ) THEN
    RAISE EXCEPTION 'completed satellite target provenance is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_satellite_target_player_provenance_is_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_satellite_target_player_provenance_is_immutable() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_satellite_target_player_provenance_is_immutable()

-- @@DOOR fn_seat_change_syncs_seat_first_count()
-- @@PIN md5=3d222458b40d5aec09f8f1e88bf60d53 len=948 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_seat_change_syncs_seat_first_count()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_table_id uuid;
  v_tid uuid;
BEGIN
  v_table_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.table_id ELSE NEW.table_id END;
  IF v_table_id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT tournament_id INTO v_tid
    FROM public.tables
   WHERE id = v_table_id;
  IF v_tid IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.tournaments t
     WHERE t.id = v_tid
       AND public.fn_ca_tournament_recorded_seat_first(t.id, true)
  ) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  PERFORM public.fn_sync_seat_first_player_count(v_tid);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;
ALTER FUNCTION public.fn_seat_change_syncs_seat_first_count() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_seat_change_syncs_seat_first_count() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_seat_change_syncs_seat_first_count()

-- @@DOOR fn_seat_club_for_user(p_user_id uuid, p_table_id uuid, p_preferred_club uuid)
-- @@PIN md5=821ddcdf4478a6cc6355499fd15e2b32 len=1507 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_seat_club_for_user(p_user_id uuid, p_table_id uuid, p_preferred_club uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_union uuid; v_table_club uuid;
BEGIN
  SELECT t.union_id, t.club_id INTO v_union, v_table_club
    FROM public.tables t WHERE t.id = p_table_id;
  -- A DIAMOND TOURNAMENT CHAIR SITS IN THE ARENA (2026-09-29). A Diamond
  -- chair's money is custody held by the arena, and the deferred seat guard
  -- (zzz_diamond_seat_keeps_custody: P0812 and its cash arm) matches that
  -- custody to the chair's club at COMMIT. Diamond membership is automatic
  -- and has no club_members row, so the lookups below never find the arena:
  -- they answered a chip club or none, and every Diamond chair was refused.
  -- A table whose club plays in Diamonds seats every player in that club.
  IF EXISTS (SELECT 1 FROM public.clubs c
              WHERE c.id = v_table_club AND c.asset = 'diamonds') THEN
    RETURN v_table_club;
  END IF;
  IF v_union IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.club_members cm
       WHERE cm.user_id = p_user_id AND cm.club_id = v_table_club
         AND cm.status IN ('active','approved')
    ) THEN RETURN v_table_club; END IF;
    RETURN public.fn_player_home_club(p_user_id, p_preferred_club);
  END IF;
  RETURN public.fn_seat_club_for_user_membership_unchecked(
    p_user_id, p_table_id, p_preferred_club
  );
END;
$function$;
ALTER FUNCTION public.fn_seat_club_for_user(p_user_id uuid, p_table_id uuid, p_preferred_club uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_seat_club_for_user(p_user_id uuid, p_table_id uuid, p_preferred_club uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_seat_club_for_user(p_user_id uuid, p_table_id uuid, p_preferred_club uuid) TO authenticated, service_role;
-- @@END fn_seat_club_for_user(p_user_id uuid, p_table_id uuid, p_preferred_club uuid)

-- @@DOOR fn_seed_all_throwables_shop_item()
-- @@PIN md5=5de69e125c0bf0ce14e8bd6693adc90c len=830 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_seed_all_throwables_shop_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.club_shop_items (
    club_id,
    name,
    description,
    price,
    category,
    image_url,
    is_active,
    item_type,
    grant_spec,
    stackable,
    per_user_limit,
    sort_order
  ) VALUES (
    NEW.id,
    'All Throwables Pack (10)',
    'Ten Uses Across All 49 Table Throwables, Including Boxing Gloves, Water Guns, Eggs, Tomatoes, Snowballs, And More.',
    1500,
    'Throwables',
    '/hub/club-arena/images/marketplace/throwables/all-throwables-access-v1.png',
    true,
    'throwable',
    jsonb_build_object('type', 'throwable', 'qty', 10),
    true,
    NULL,
    30
  );
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.fn_seed_all_throwables_shop_item() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_seed_all_throwables_shop_item() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_seed_all_throwables_shop_item() TO service_role;
-- @@END fn_seed_all_throwables_shop_item()

-- @@DOOR fn_stamp_active_seat_game_scope()
-- @@PIN md5=d271007d2e1b1f4daa83bfc295d47c1e len=1316 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_stamp_active_seat_game_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    NEW.active_game_scope := NULL;
  ELSE
    SELECT t.seat_game_scope INTO NEW.active_game_scope FROM public.tables t WHERE t.id=NEW.table_id;
    IF NOT FOUND OR NEW.user_id IS NULL THEN
      RAISE EXCEPTION 'Active seat requires an existing table and player' USING ERRCODE='23514';
    END IF;
    IF NEW.active_game_scope IS NULL THEN
      -- A pre-migration empty table has no cached scope. Initialize only that
      -- parent, inside this admission transaction. Existing occupied tables
      -- never take this UPDATE path. Concurrent initialization is idempotent.
      UPDATE public.tables t SET seat_game_scope = CASE WHEN t.cluster_id IS NULL
        THEN 'table:'||t.id::text ELSE 'cluster:'||t.cluster_id::text END
      WHERE t.id=NEW.table_id AND t.seat_game_scope IS NULL;
      SELECT t.seat_game_scope INTO NEW.active_game_scope FROM public.tables t WHERE t.id=NEW.table_id;
      IF NEW.active_game_scope IS NULL THEN
        RAISE EXCEPTION 'Active seat parent scope initialization failed' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.fn_stamp_active_seat_game_scope() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_stamp_active_seat_game_scope() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_stamp_active_seat_game_scope()

-- @@DOOR fn_stamp_seat_club()
-- @@PIN md5=467104f7e791b76328ce5e20b42ba81b len=920 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_stamp_seat_club()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- A SEAT KEEPS THE CLUB IT WAS SEATED UNDER (2026-09-10). Nothing that the
  -- stamp is derived from changed, and the seat already carries a club, so
  -- there is nothing to derive. This was 6.0 ms of club_members lookups on
  -- every stack write; see the migration header.
  IF TG_OP = 'UPDATE'
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
     AND NEW.club_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS NOT NULL AND NEW.table_id IS NOT NULL THEN
    NEW.club_id := COALESCE(
      public.fn_seat_club_for_user(NEW.user_id, NEW.table_id, NEW.club_id),
      NEW.club_id
    );
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.fn_stamp_seat_club() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_stamp_seat_club() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_stamp_seat_club() TO service_role;
-- @@END fn_stamp_seat_club()

-- @@DOOR fn_stamp_seat_occupancy()
-- @@PIN md5=4d2645a24bd3b88d7ffc51097b37d640 len=664 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_stamp_seat_occupancy()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.occupancy_id := gen_random_uuid();
  ELSIF OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.table_id IS DISTINCT FROM NEW.table_id
     OR OLD.seat_number IS DISTINCT FROM NEW.seat_number
     OR (OLD.left_at IS NOT NULL AND NEW.left_at IS NULL) THEN
    NEW.occupancy_id := gen_random_uuid();
  ELSIF NEW.occupancy_id IS DISTINCT FROM OLD.occupancy_id THEN
    RAISE EXCEPTION 'SEAT_OCCUPANCY_IMMUTABLE' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_stamp_seat_occupancy() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_stamp_seat_occupancy() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_stamp_seat_occupancy()

-- @@DOOR fn_stamp_table_game_scope()
-- @@PIN md5=30cd14f9ff42850835c1f0bb624a0873 len=319 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_stamp_table_game_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.seat_game_scope := CASE WHEN NEW.cluster_id IS NULL
    THEN 'table:'||NEW.id::text ELSE 'cluster:'||NEW.cluster_id::text END;
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.fn_stamp_table_game_scope() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_stamp_table_game_scope() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_stamp_table_game_scope()

-- @@DOOR fn_stamp_table_seat_admission()
-- @@PIN md5=9c5d3aee9f48697db3ea08807df46527 len=525 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_stamp_table_seat_admission()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 NEW.seat_admission_key := CASE
   WHEN lower(coalesce(NEW.status,'')) IN ('closed','completed','cancelled','finished')
     OR NEW.lifecycle='closed' OR coalesce(NEW.is_deleted,false) OR coalesce(NEW.is_template,false) THEN 'closed'
   WHEN NEW.tournament_id IS NOT NULL THEN 'tournament:'||NEW.tournament_id::text
   ELSE 'cash' END;
 RETURN NEW;
END
$function$;
ALTER FUNCTION public.fn_stamp_table_seat_admission() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_stamp_table_seat_admission() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_stamp_table_seat_admission()

-- @@DOOR fn_stamp_tournament_elimination_sequence()
-- @@PIN md5=1da72fa956566502be6d6c8d46ba6d2a len=1768 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_stamp_tournament_elimination_sequence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status::text = 'eliminated' THEN
      NEW.elimination_sequence := nextval(
        'public.tournament_player_elimination_sequence'::regclass);
    ELSE
      NEW.elimination_sequence := NULL;
    END IF;
  ELSIF OLD.status::text IS DISTINCT FROM 'eliminated'
        AND NEW.status::text = 'eliminated' THEN
    NEW.elimination_sequence := nextval(
      'public.tournament_player_elimination_sequence'::regclass);
  ELSIF OLD.status::text = 'eliminated'
        AND NEW.status::text IS DISTINCT FROM 'eliminated' THEN
    NEW.elimination_sequence := NULL;
  ELSIF OLD.status::text = 'eliminated'
        AND NEW.status::text = 'eliminated'
        AND OLD.elimination_sequence IS NULL
        AND NEW.elimination_sequence IS NOT NULL THEN
    -- 2026-09-20. A row that was already 'eliminated' when this trigger was
    -- introduced can never transition INTO 'eliminated' again, so it could
    -- never acquire the stamp this trigger exists to give it, and every
    -- repair was refused below as database-owned. Permit exactly that one
    -- acquisition: NULL -> a value, on a row that is already eliminated.
    -- Changing a stamp that EXISTS is still refused, so a sequence is still
    -- write-once; tournament_players_one_elimination_sequence keeps it
    -- unique within the event and the CHECK keeps it positive.
    NULL;
  ELSIF NEW.elimination_sequence IS DISTINCT FROM OLD.elimination_sequence THEN
    RAISE EXCEPTION 'elimination_sequence is database-owned'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_stamp_tournament_elimination_sequence() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_stamp_tournament_elimination_sequence() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_stamp_tournament_elimination_sequence()

-- @@DOOR fn_sync_tournament_current_players()
-- @@PIN md5=3fd8f2c2f0866754467266a6bc5b6d80 len=2394 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_sync_tournament_current_players()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tid uuid;
  v_count integer;
BEGIN
  v_tid := COALESCE(NEW.tournament_id, OLD.tournament_id);
  IF v_tid IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT count(*) INTO v_count
  FROM public.tournament_players
  WHERE tournament_id = v_tid
    AND status IN ('registered', 'playing');

  UPDATE public.tournaments
     SET current_players = v_count
   WHERE id = v_tid
     AND status IN ('ANNOUNCED', 'REGISTERING')
     AND current_players IS DISTINCT FROM v_count;

  /* A RUNNING FIELD IS COUNTED BY THE BUST THAT SHRINKS IT (2026-09-22).
     The statement above is pre-start only, on purpose, and nothing else
     counted a RUNNING field: a bust left the count one too high until a
     minutely job (reconcile-tournament-denormals) rewrote it, and the
     registration door refuses a late entrant while the count and the roster
     disagree. A player moving into or out of the field is recounted here, in
     the transaction that moves them.

     Only a MEMBERSHIP change on UPDATE. An admission (INSERT) or a removal
     (DELETE) into a RUNNING field is counted by the door that performs it:
     the registration, horse and satellite-seat doors publish the new count
     themselves and require this trigger to leave a RUNNING count alone.

     Seat-first formats are skipped with the predicate their own owner uses
     (fn_sync_seat_first_player_count, live seats on the primary table), so
     the two writers partition the column and never write the same event.

     The tournaments row is already locked FOR UPDATE by this transaction:
     every membership change takes it first, in
     aa_tournament_player_launch_proof_lock. */
  IF TG_OP = 'UPDATE'
     AND NEW.tournament_id IS NOT DISTINCT FROM OLD.tournament_id
     AND (COALESCE(OLD.status, '') IN ('registered', 'playing'))
         IS DISTINCT FROM (COALESCE(NEW.status, '') IN ('registered', 'playing')) THEN
    UPDATE public.tournaments t
       SET current_players = v_count
     WHERE t.id = v_tid
       AND t.status = 'RUNNING'
       AND t.current_players IS DISTINCT FROM v_count
       AND NOT public.fn_ca_tournament_recorded_seat_first(t.id, true);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;
ALTER FUNCTION public.fn_sync_tournament_current_players() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_sync_tournament_current_players() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_sync_tournament_current_players() TO service_role;
-- @@END fn_sync_tournament_current_players()

-- @@DOOR fn_table_seats_lightning_anchor_guard()
-- @@PIN md5=fe1678bae7a7973b2a9bcaf6ade83156 len=2572 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_table_seats_lightning_anchor_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ps     uuid;
  v_player uuid;
  v_cluster uuid;
  v_hand   uuid;
BEGIN
  -- A SEAT THAT ANCHORS AN OPEN POOL SESSION IS NOT DELETED (BEFORE DELETE,
  -- file D). There is no foreign key to hold the anchor, by design; this is
  -- what holds it. The buy-in's DELETE of a departed occupant's row is untouched:
  -- a departure exits the session at the commit that records it, so by the
  -- time anyone deletes that row it anchors nothing open.
  IF TG_OP = 'DELETE' THEN
    SELECT ps.id, ps.player_id, ps.cluster_id INTO v_ps, v_player, v_cluster
      FROM public.lightning_pool_session ps
     WHERE ps.anchor_seat_id = OLD.id AND ps.exited_at IS NULL;
    IF v_ps IS NULL THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'LIGHTNING_ANCHOR_SEAT_IS_IN_THE_POOL: seat % anchors open pool session % of player % in Cluster %; a seat can be deleted once the pool session it anchors has exited',
      OLD.id, v_ps, v_player, v_cluster USING ERRCODE = 'PLT01';
  END IF;

  SELECT ps.id, ps.player_id, ps.cluster_id INTO v_ps, v_player, v_cluster
    FROM public.lightning_pool_session ps
   WHERE ps.anchor_seat_id = OLD.id AND ps.exited_at IS NULL;
  IF v_ps IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT public.fn_lightning_player_in_hand(v_player, v_cluster) THEN
    RETURN NEW;
  END IF;

  SELECT i.hand_id INTO v_hand
    FROM public.lightning_reservation r
    JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
   WHERE r.cluster_id = v_cluster AND r.player_id = v_player AND r.state = 'committed'
     AND i.state IN ('forming', 'reserved', 'dealing', 'settling')
   ORDER BY i.created_at DESC, i.id
   LIMIT 1;

  -- THE ONE WRITER ALLOWED THROUGH is the settlement of THAT hand, which names
  -- it in ca.lightning_settlement_hand for its own transaction. Any other
  -- value, or none, is refused.
  IF v_hand IS NOT NULL
     AND nullif(current_setting('ca.lightning_settlement_hand', true), '') IS NOT DISTINCT FROM v_hand::text THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'LIGHTNING_HAND_IN_PROGRESS: seat % anchors pool session % of player % in Cluster %, who is in Lightning hand %; the anchor stack, departure and occupant change only by that hand''s settlement (stack % -> %, left_at % -> %)',
    OLD.id, v_ps, v_player, v_cluster, v_hand, OLD.stack, NEW.stack, OLD.left_at, NEW.left_at
    USING ERRCODE = 'PLT01';
END
$function$;
ALTER FUNCTION public.fn_table_seats_lightning_anchor_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_table_seats_lightning_anchor_guard() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_table_seats_lightning_anchor_guard() TO service_role;
-- @@END fn_table_seats_lightning_anchor_guard()

-- @@DOOR fn_table_seats_lightning_pool_follows_seat()
-- @@PIN md5=d1e10013c5a044a6dd82e9a99755e4f4 len=2664 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_table_seats_lightning_pool_follows_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  ps      record;
  v_other uuid;
  v_now   timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'UPDATE'
     AND ((OLD.left_at IS NULL AND NEW.left_at IS NOT NULL)
          OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    FOR ps IN
      UPDATE public.lightning_pool_session s
         SET exited_at    = GREATEST(v_now, s.entered_at),
             exit_reason  = CASE WHEN NEW.user_id IS DISTINCT FROM OLD.user_id
                                 THEN 'anchor_seat_turned_over' ELSE 'anchor_seat_left' END,
             state        = 'closed',
             ending_stack = OLD.stack,
             updated_at   = v_now
       WHERE s.anchor_seat_id = OLD.id AND s.exited_at IS NULL
      RETURNING s.id, s.cluster_id, s.cluster_epoch, s.player_id, s.exit_reason, s.ending_stack
    LOOP
      UPDATE public.lightning_pool_slot sl
         SET closed_at = GREATEST(v_now, sl.opened_at),
             close_reason = 'pool_session_exited',
             updated_at = v_now
       WHERE sl.pool_session_id = ps.id AND sl.closed_at IS NULL;

      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload, cluster_epoch)
      VALUES (ps.cluster_id, OLD.table_id, 'pool_player_left', jsonb_build_object(
        'cluster_id', ps.cluster_id, 'cluster_epoch', ps.cluster_epoch, 'player_id', ps.player_id,
        'pool_session_id', ps.id, 'anchor_seat_id', OLD.id, 'reason', ps.exit_reason,
        'ending_stack', ps.ending_stack, 'at', v_now), ps.cluster_epoch);

      SELECT ts.id INTO v_other
        FROM public.table_seats ts
        JOIN public.tables tb ON tb.id = ts.table_id
       WHERE tb.cluster_id = ps.cluster_id AND ts.user_id = ps.player_id AND ts.id <> OLD.id
         AND public.fn_lightning_anchor_is_live_eligible(ts.id, ps.cluster_id, ps.player_id)
       ORDER BY ts.joined_at, ts.id
       LIMIT 1;
      IF v_other IS NOT NULL THEN
        PERFORM public.fn_lightning_pool_enter(v_other, v_now);
      END IF;
    END LOOP;
  END IF;

  IF NEW.left_at IS NULL AND NEW.user_id IS NOT NULL
     AND coalesce(NEW.stack, 0) > 0
     AND coalesce(NEW.is_sitting_out, false) = false
     AND coalesce(NEW.leave_pending, false) = false
     AND EXISTS (SELECT 1 FROM public.tables tb
                   JOIN public.cash_games g ON g.id = tb.cluster_id
                  WHERE tb.id = NEW.table_id AND g.cluster_mode = 'lightning') THEN
    PERFORM public.fn_lightning_pool_enter(NEW.id, v_now);
  END IF;
  RETURN NULL;
END
$function$;
ALTER FUNCTION public.fn_table_seats_lightning_pool_follows_seat() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_table_seats_lightning_pool_follows_seat() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_table_seats_lightning_pool_follows_seat() TO service_role;
-- @@END fn_table_seats_lightning_pool_follows_seat()

-- @@DOOR fn_tables_kill_pot_guard()
-- @@PIN md5=837823de88843f8045bf37a120417585 len=1437 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_tables_kill_pot_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_refusal text;
BEGIN
  -- The WHEN clause already skips 'off'; this keeps the function honest if it
  -- is ever attached without one. A mode outside the vocabulary is left to
  -- tables_kill_mode_check, which refuses it (23514) after this trigger.
  IF NEW.kill_mode IS NULL OR NEW.kill_mode NOT IN ('half','full') THEN
    RETURN NEW;
  END IF;

  -- Readiness gates SETTING the kill configuration, not every later write to
  -- a row that already carries one.
  IF (TG_OP = 'INSERT'
      OR NEW.kill_mode IS DISTINCT FROM OLD.kill_mode
      OR NEW.kill_threshold_bb IS DISTINCT FROM OLD.kill_threshold_bb)
     AND NOT public.fn_capability_available('cash.fixed_limit.kill_pots') THEN
    RAISE EXCEPTION 'Kill Pots Are Not Available Yet'
      USING ERRCODE = '22023',
            DETAIL = 'capability cash.fixed_limit.kill_pots is not deployed';
  END IF;

  v_refusal := public.fn_kill_pot_configuration_refusal(
    NEW.kill_mode, NEW.game_variant, NEW.game_type, NEW.tournament_id,
    NEW.bomb_pot_enabled, NEW.big_blind, NEW.club_id);
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION '%', v_refusal
      USING ERRCODE = '22023',
            DETAIL = format('table %s kill_mode %s', NEW.id, NEW.kill_mode);
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.fn_tables_kill_pot_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_tables_kill_pot_guard() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_tables_kill_pot_guard() TO service_role;
-- @@END fn_tables_kill_pot_guard()

-- @@DOOR fn_tables_stakes_follows_its_own_blinds()
-- @@PIN md5=fb440f8eb09cdddfe941f5d3fbeef7f0 len=648 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_tables_stakes_follows_its_own_blinds()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Cash tables label themselves through fn_cash_stakes_label and are not
  -- this trigger's business. Excluded here as well as in the WHEN clause so
  -- the body is safe if the trigger is ever recreated without one.
  IF NEW.tournament_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.small_blind IS NOT NULL AND NEW.big_blind IS NOT NULL THEN
    NEW.stakes := trim_scale(NEW.small_blind)::text||'/'||trim_scale(NEW.big_blind)::text;
  END IF;

  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_tables_stakes_follows_its_own_blinds() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_tables_stakes_follows_its_own_blinds() TO PUBLIC, anon, authenticated, service_role;
-- @@END fn_tables_stakes_follows_its_own_blinds()

-- @@DOOR fn_terminal_tournament_escrow_is_immutable()
-- @@PIN md5=f0c5a1b136edd9689816fda589d03434 len=2453 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_escrow_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
  v_new_status text;
BEGIN
  IF TG_OP<>'DELETE' AND public.fn_ca_legacy_fee_resolution_write_is_exact(TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,to_jsonb(NEW)) THEN RETURN NEW; END IF;
  IF TG_OP <> 'INSERT' THEN v_old_tournament_id := OLD.tournament_id; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_tournament_id := NEW.tournament_id; END IF;
  IF TG_OP = 'UPDATE'
     AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION 'tournament escrow ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION 'new tournament escrow cannot supply a terminal marker'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal tournament escrow evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_old_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'tournament escrow terminal marker transition is not canonical'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND v_new_tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_new_status
      FROM public.tournaments t
     WHERE t.id = v_new_tournament_id FOR SHARE;
    IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal tournament escrow evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF public.fn_ca_has_committed_tournament_receipt(v_old_tournament_id)
     OR public.fn_ca_has_committed_tournament_receipt(v_new_tournament_id) THEN
    RAISE EXCEPTION 'terminal tournament escrow evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_terminal_tournament_escrow_is_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_terminal_tournament_escrow_is_immutable() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_terminal_tournament_escrow_is_immutable()

-- @@DOOR fn_terminal_tournament_evidence_is_immutable()
-- @@PIN md5=5eb12239ece45d08eb32dbaa9e3028dd len=3807 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_evidence_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_status text;
  v_receipted boolean := false;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
BEGIN
  IF TG_OP<>'DELETE' AND public.fn_ca_legacy_fee_resolution_write_is_exact(TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,to_jsonb(NEW)) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    v_tournament_id := NULLIF(to_jsonb(NEW)->>'tournament_id','')::uuid;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NULLIF(to_jsonb(NEW)->>'tournament_id','')::uuid IS DISTINCT FROM
       NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid THEN
      RAISE EXCEPTION '% rows cannot move between tournaments',TG_TABLE_NAME
        USING ERRCODE = '55000';
    END IF;
    v_tournament_id := NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid;
  ELSE
    v_tournament_id := NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid;
  END IF;

  IF v_tournament_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' AND to_jsonb(OLD) ? 'terminal_closed_at' THEN
    v_old_marker := NULLIF(to_jsonb(OLD)->>'terminal_closed_at','')::timestamptz;
  END IF;
  IF TG_OP <> 'DELETE' AND to_jsonb(NEW) ? 'terminal_closed_at' THEN
    v_new_marker := NULLIF(to_jsonb(NEW)->>'terminal_closed_at','')::timestamptz;
  END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION '% rows cannot supply a terminal marker',TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal tournament % has immutable % evidence',
      v_tournament_id,TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION '% terminal marker transition is not canonical',TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  -- A journal row is durable testimony from the instant it names a
  -- tournament. Refuse its UPDATE/DELETE without taking a child-to-parent
  -- lock; a row trigger already owns the child tuple at this point. INSERT is
  -- the only operation that takes the root lock, which preserves the
  -- parent-to-child order used by both terminal authorities.
  IF TG_TABLE_NAME = 'chip_ledger' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'tournament chip ledger evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_tournament_id
     FOR SHARE;
  ELSE
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_tournament_id;
  END IF;
  SELECT EXISTS (
           SELECT 1 FROM public.tournament_terminal_settlements h
            WHERE h.tournament_id = v_tournament_id)
      OR EXISTS (
           SELECT 1 FROM public.tournament_satellite_settlements h
            WHERE h.tournament_id = v_tournament_id)
      OR EXISTS (
           SELECT 1 FROM public.tournament_cancellation_receipts h
            WHERE h.tournament_id = v_tournament_id)
    INTO v_receipted;
  IF v_status IN ('COMPLETED','CANCELLED','CANCELED')
     AND (TG_OP = 'INSERT' OR v_receipted) THEN
    RAISE EXCEPTION
      'terminal tournament % has immutable % evidence',
      v_tournament_id,TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_terminal_tournament_evidence_is_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_terminal_tournament_evidence_is_immutable() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_terminal_tournament_evidence_is_immutable()

-- @@DOOR fn_terminal_tournament_seat_is_immutable()
-- @@PIN md5=10a5d9082f7770127359f9eca7068ed6 len=3985 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_seat_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_status text;
  v_marker timestamptz;
  v_receipted boolean := false;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT tb.tournament_id INTO v_old_tournament_id
      FROM public.tables tb WHERE tb.id = OLD.table_id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id THEN
    -- Same table on both sides: one lookup answers for both (2026-09-10).
    v_new_tournament_id := v_old_tournament_id;
  ELSIF TG_OP <> 'DELETE' THEN
    SELECT tb.tournament_id INTO v_new_tournament_id
      FROM public.tables tb WHERE tb.id = NEW.table_id;
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;

  -- A CASH SEAT WITH NO TERMINAL MARKER HAS NOTHING TO BE IMMUTABLE ABOUT
  -- (2026-09-10). With no tournament on either side and no marker on either
  -- side, every check below passes and the row is returned; return it here
  -- instead of after a status lookup and three receipt scans on a NULL id.
  IF v_old_tournament_id IS NULL AND v_new_tournament_id IS NULL
     AND v_old_marker IS NULL AND v_new_marker IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION 'seat % cannot move between tournament owners',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION 'new tournament seat % cannot supply a terminal marker',NEW.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal tournament seat % is immutable',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_old_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'seat % terminal marker transition is not canonical',OLD.id
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' AND v_new_tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_new_tournament_id
     FOR SHARE;
    SELECT tb.terminal_closed_at INTO v_marker
      FROM public.tables tb
     WHERE tb.id = NEW.table_id
       AND tb.tournament_id = v_new_tournament_id
     FOR SHARE;
  ELSE
    SELECT upper(COALESCE(t.status::text,'')),tb.terminal_closed_at
      INTO v_status,v_marker
      FROM public.tables tb
      LEFT JOIN public.tournaments t ON t.id = tb.tournament_id
     WHERE tb.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.table_id ELSE NEW.table_id END;
  END IF;
  SELECT EXISTS (
           SELECT 1 FROM public.tournament_terminal_settlements h
            WHERE h.tournament_id = COALESCE(v_new_tournament_id,v_old_tournament_id))
      OR EXISTS (
           SELECT 1 FROM public.tournament_satellite_settlements h
            WHERE h.tournament_id = COALESCE(v_new_tournament_id,v_old_tournament_id))
      OR EXISTS (
           SELECT 1 FROM public.tournament_cancellation_receipts h
            WHERE h.tournament_id = COALESCE(v_new_tournament_id,v_old_tournament_id))
    INTO v_receipted;
  IF v_status IN ('COMPLETED','CANCELLED','CANCELED')
     AND (TG_OP = 'INSERT' OR v_receipted) THEN
    RAISE EXCEPTION 'terminal tournament seat % is immutable',
      CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_terminal_tournament_seat_is_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_terminal_tournament_seat_is_immutable() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_terminal_tournament_seat_is_immutable()

-- @@DOOR fn_tournament_elimination_has_a_place()
-- @@PIN md5=8995e4364a00e5bae077701c1185bf8b len=1615 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_tournament_elimination_has_a_place()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status text;
  v_position integer;
  v_tournament text;
BEGIN
  /* THE KNOCKOUT DOOR OWNS EVERY BUST A HAND TOOK (2026-09-10). An eliminated
     row is a finishing place: fn_complete_tournament_entry_reprice reads a row
     without one as an unfinished reprice and refuses the event for ever, and
     the engine's elimination sweep will not run until that proof passes.

     A DEFERRED CHECK READS THE ROW AT COMMIT, NOT THE STATEMENT. NEW is the
     tuple the firing statement produced, so a settlement that writes the status
     first and the place second would be refused on a row that is about to be
     correct - which is what happened to five satellites between 07:24 and
     07:52. Re-read; if the row is gone, there is nothing to judge. */
  SELECT tp.status, tp.position INTO v_status, v_position
    FROM public.tournament_players tp
   WHERE tp.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF v_status = 'eliminated' AND v_position IS NULL THEN
    SELECT t.status INTO v_tournament FROM public.tournaments t WHERE t.id = NEW.tournament_id;
    IF v_tournament IN ('RUNNING', 'COMPLETING', 'COMPLETED') THEN
      RAISE EXCEPTION 'tournament % player % was recorded eliminated with no finishing place; a bust is recorded through the knockout door, which assigns the place',
        NEW.tournament_id, NEW.user_id USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.fn_tournament_elimination_has_a_place() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_tournament_elimination_has_a_place() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_elimination_has_a_place() TO service_role;
-- @@END fn_tournament_elimination_has_a_place()

-- @@DOOR fn_tournament_live_seat_acquisition_requires_authority()
-- @@PIN md5=2039e26a8513bba99c057a28b79f44e5 len=3220 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_tournament_live_seat_acquisition_requires_authority()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_tournament_status text;
  v_key bigint:=hashtextextended(
    'ca:tournament-terminal-settlement:v1',0);
  v_tournament_key bigint;
  v_owns_authority boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL
       OR (OLD.left_at IS NULL
         AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
         AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id
         AND OLD.seat_number IS NOT DISTINCT FROM NEW.seat_number) THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT tb.tournament_id,upper(COALESCE(t.status::text,''))
    INTO v_tournament_id,v_tournament_status
    FROM public.tables tb
    LEFT JOIN public.tournaments t ON t.id=tb.tournament_id
   WHERE tb.id=NEW.table_id;
  IF v_tournament_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Proof of authority (2026-09-10): this backend holds, exclusively, either
  -- T(the seat's tournament) - that tournament's rolling lane - or G - a
  -- terminal authority. A shared hold of either key proves nothing: hand
  -- settlements hold T shared and rolling authorities hold G shared.
  v_tournament_key:=hashtextextended(
    'ca:tournament-terminal-settlement:v1:'||v_tournament_id::text,0);
  SELECT EXISTS(
    SELECT 1 FROM pg_catalog.pg_locks l
     WHERE l.pid=pg_backend_pid()
       AND l.locktype='advisory'
       AND l.database=(
         SELECT d.oid FROM pg_catalog.pg_database d
          WHERE d.datname=current_database())
       AND ((l.classid=(((v_key>>32)&4294967295)::oid)
             AND l.objid=((v_key&4294967295)::oid))
         OR (l.classid=(((v_tournament_key>>32)&4294967295)::oid)
             AND l.objid=((v_tournament_key&4294967295)::oid)))
       AND l.objsubid=1
       AND l.mode='ExclusiveLock'
       AND l.granted)
    INTO v_owns_authority;
  IF NOT COALESCE(v_owns_authority,false) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ACQUISITION_REQUIRES_TERMINAL_AUTHORITY'
      USING ERRCODE='55000',
            HINT='Use a canonical tournament seat purchase, registration, move, or assignment RPC.';
  END IF;
  -- A BAGGED event takes back its bagged players only inside its stage
  -- resume (multi-day, 20260924043224): exact marker, incomplete receipt.
  IF v_tournament_status NOT IN ('ANNOUNCED','REGISTERING','RUNNING')
     AND NOT (v_tournament_status = 'BAGGED'
              AND EXISTS (
                SELECT 1
                  FROM public.tournament_stage_resume_receipts r
                 WHERE r.tournament_id = v_tournament_id
                   AND r.completed_at IS NULL
                   AND current_setting('app.atomic_stage_resume', true)
                       = v_tournament_id::text || ':' || r.resume_id::text)) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ACQUISITION_CLOSED: tournament %, status %',
      v_tournament_id,v_tournament_status
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_tournament_live_seat_acquisition_requires_authority() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_tournament_live_seat_acquisition_requires_authority() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_tournament_live_seat_acquisition_requires_authority()

-- @@DOOR fn_tournament_payout_terms_committed_v1(p_tournament_id uuid)
-- @@PIN md5=918c62cbcc182d43a6a27edeb2c1c107 len=1817 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_tournament_payout_terms_committed_v1(p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.tournaments t
                  WHERE t.id=p_tournament_id AND t.prize_pool_finalized IS TRUE)
     OR EXISTS (SELECT 1 FROM public.tournament_entry_close_receipts r
                 WHERE r.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_place_settlement_batches b
                 WHERE b.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_satellite_settlement_batches b
                 WHERE b.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_final_table_deal_batches b
                 WHERE b.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_terminal_settlements h
                 WHERE h.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts c
                 WHERE c.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id=p_tournament_id
                   AND o.kind IN ('place','bubble_protection','final_table_deal','late_reg_adjustment'))
     OR EXISTS (SELECT 1 FROM public.tournament_payouts p
                 WHERE p.tournament_id=p_tournament_id
                   AND (p.source IN ('structure','reconcile','hu_shortfall','late_reg_adjustment',
                         'clawback','spin_backpay','overlay_backpay','final_table_deal','bubble_protection')
                        OR public.fn_tournament_payout_key_is_place_evidence(
                             p.tournament_id,p.idempotency_key)));
$function$;
ALTER FUNCTION public.fn_tournament_payout_terms_committed_v1(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_tournament_payout_terms_committed_v1(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_tournament_payout_terms_committed_v1(p_tournament_id uuid)

-- @@DOOR fn_tournament_players_bagged_custody_fence()
-- @@PIN md5=7f2c2b24929ac233f1fa250a6f1911df len=1230 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_tournament_players_bagged_custody_fence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournaments uuid[];
  v_bagged uuid;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.chips IS NOT DISTINCT FROM OLD.chips
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.current_bounty IS NOT DISTINCT FROM OLD.current_bounty
     AND NEW.tournament_id IS NOT DISTINCT FROM OLD.tournament_id THEN
    RETURN NEW;
  END IF;
  v_tournaments := CASE TG_OP
    WHEN 'INSERT' THEN ARRAY[NEW.tournament_id]
    WHEN 'DELETE' THEN ARRAY[OLD.tournament_id]
    ELSE ARRAY[OLD.tournament_id, NEW.tournament_id] END;
  SELECT t.id INTO v_bagged
    FROM public.tournaments t
   WHERE t.id = ANY (v_tournaments) AND t.status = 'BAGGED'
     AND current_setting('app.multi_day_stage_custody', true) IS DISTINCT FROM t.id::text
   LIMIT 1;
  IF v_bagged IS NOT NULL THEN
    RAISE EXCEPTION 'TOURNAMENT_BAGGED_CUSTODY: tournament % is bagged; its stacks belong to the bag until the stage resumes', v_bagged
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION public.fn_tournament_players_bagged_custody_fence() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_tournament_players_bagged_custody_fence() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_tournament_players_bagged_custody_fence()

-- @@DOOR fn_tournament_record_conclusion()
-- @@PIN md5=ff1dc28602058962abea8d8dbd3cdb9b len=484 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_tournament_record_conclusion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.accepted_event_operations
     SET concluded_at = now(),
         conclusion = CASE NEW.status WHEN 'COMPLETED' THEN 'completed' ELSE 'cancelled' END
   WHERE event_kind = 'tournament'
     AND event_id = NEW.id
     AND concluded_at IS NULL;
  RETURN NULL;
END
$function$;
ALTER FUNCTION public.fn_tournament_record_conclusion() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_tournament_record_conclusion() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_tournament_record_conclusion()

-- @@DOOR fn_tournament_table_inherits_committed_blinds()
-- @@PIN md5=0386e9eb7f88d7e783c8cec1dbf5f5e8 len=1442 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_tournament_table_inherits_committed_blinds()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_level integer; v_state jsonb;
BEGIN
  IF NEW.tournament_id IS NULL THEN RETURN NEW; END IF;
  SELECT current_level,blind_level_state INTO v_level,v_state
    FROM public.tournaments WHERE id=NEW.tournament_id FOR SHARE;
  IF v_state IS NULL THEN
    -- No committed level to inherit. The display string is still a function of
    -- this row's own blinds, so derive it rather than trusting the caller:
    -- that is what let 'undefined/undefined' and stale levels be stored, and
    -- what left a minutely cron UPDATE as the only thing holding the invariant
    -- for the 167,997 tournaments with no blind_level_state.
    IF NEW.small_blind IS NOT NULL AND NEW.big_blind IS NOT NULL THEN
      NEW.stakes := trim_scale(NEW.small_blind)::text||'/'||trim_scale(NEW.big_blind)::text;
    END IF;
    RETURN NEW;
  END IF;
  IF (v_state->>'index')::integer IS DISTINCT FROM v_level THEN
    RAISE EXCEPTION 'Tournament table cannot inherit an unconfirmed blind level';
  END IF;
  NEW.small_blind:=(v_state->>'small_blind')::numeric;
  NEW.big_blind:=(v_state->>'big_blind')::numeric;
  NEW.ante:=(v_state->>'ante')::numeric;
  NEW.stakes:=trim_scale(NEW.small_blind)::text||'/'||trim_scale(NEW.big_blind)::text;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_tournament_table_inherits_committed_blinds() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_tournament_table_inherits_committed_blinds() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_table_inherits_committed_blinds() TO service_role;
-- @@END fn_tournament_table_inherits_committed_blinds()

-- @@DOOR fn_try_record_owner_notification(p_id uuid)
-- @@PIN md5=bbc44eb76b74576906f55e9ae370a508 len=2834 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_try_record_owner_notification(p_id uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE d public.operational_notification_destinations%ROWTYPE; n jsonb; v_id bigint;
  v_name text; v_status text; v_severity text;
BEGIN
  SELECT * INTO STRICT d FROM public.operational_notification_destinations
    WHERE notification_id=p_id FOR UPDATE;
  n := d.original_notification;
  BEGIN
    IF n->>'id' IS DISTINCT FROM p_id::text OR n->>'user_id' IS DISTINCT FROM d.recipient_user_id::text
      OR NOT public.fn_is_owner_operational_notification(d.recipient_user_id,n->>'type',n->>'title',n->'data') THEN
      RAISE EXCEPTION 'operational destination original identity mismatch';
    END IF;
    v_name := left(COALESCE(NULLIF(n->'data'->>'alertname',''),(n->>'type')||':'||(n->>'title')),240);
    v_status := CASE WHEN n->'data'->>'green'='true' OR (n->>'type') ~ '(_resolved|_recovered)$'
        OR (n->>'type'='system' AND (n->>'title') ~ '^Horse Fleet Recovered: ')
        THEN 'resolved' ELSE 'firing' END;
    v_severity := CASE WHEN n->'data'->>'severity' IN ('critical','warning','info')
        THEN n->'data'->>'severity' ELSE 'warning' END;
    v_id := d.inbox_event_id;
    IF v_id IS NULL THEN
      v_id := public.fn_record_operational_alert('owner-operational-notifications',p_id::text,
        v_name,v_status,v_severity,
        jsonb_build_object('original_notification',n,'captured_at',d.captured_at,
          'target_task_id',d.target_task_id));
    END IF;
    IF v_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.operational_alert_events e
      WHERE e.id=v_id AND e.source='owner-operational-notifications'
        AND e.event_key=p_id::text AND e.payload->>'target_task_id'=d.target_task_id::text
        AND e.alertname=v_name AND e.status=v_status AND e.severity=v_severity
        -- Existing intake preserves an earlier snapshot. Only acknowledgement
        -- state/timestamps may differ; content, identity and all other fields
        -- must match. The complete current original remains in the destination.
        AND ((e.payload->'original_notification')-ARRAY['read','is_read','read_at','updated_at'])
          =(n-ARRAY['read','is_read','read_at','updated_at'])
    ) THEN RAISE EXCEPTION 'operational destination receipt mismatch'; END IF;
    UPDATE public.operational_notification_destinations SET inbox_event_id=v_id,
      last_attempt_at=clock_timestamp(),last_error=NULL WHERE notification_id=p_id;
    RETURN v_id;
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.operational_notification_destinations SET inbox_event_id=NULL,last_attempt_at=clock_timestamp(),
      last_error=SQLSTATE||':'||left(SQLERRM,1000) WHERE notification_id=p_id;
    RETURN NULL;
  END;
END;
$function$;
ALTER FUNCTION public.fn_try_record_owner_notification(p_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_try_record_owner_notification(p_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_try_record_owner_notification(p_id uuid)

-- @@DOOR fn_union_pnl_credit_touch()
-- @@PIN md5=3d52386d79eb9bc88107fb81f3c7da6e len=508 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_union_pnl_credit_touch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 INSERT INTO public.union_pnl_credit_touches(id,transaction_id,frame_observed_at,union_id)
 VALUES(NEW.id,NEW.transaction_id,(SELECT b.observed_at FROM public.union_pnl_transaction_frames b WHERE b.transaction_id=NEW.transaction_id),
  NEW.tournament_snapshot->>'union_id')
 ON CONFLICT (id) DO NOTHING;
 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_union_pnl_credit_touch() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_union_pnl_credit_touch() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_union_pnl_credit_touch()

-- @@DOOR fn_union_pnl_inventory_immutable()
-- @@PIN md5=307d83a1ee3d912bade24c48144aa801 len=256 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN RAISE EXCEPTION 'original_pnl_inventory_is_immutable' USING ERRCODE='55000'; END $function$;
ALTER FUNCTION public.fn_union_pnl_inventory_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_immutable() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_union_pnl_inventory_immutable()

-- @@DOOR fn_union_pnl_inventory_touch()
-- @@PIN md5=656eb1b8a853324b3276bcb1bfb95b23 len=719 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_touch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 INSERT INTO public.union_pnl_inventory_touches(event_id,source_name,row_id,observed_at,transaction_id,frame_observed_at,operation,tournament_id,union_id)
 VALUES(NEW.event_id,NEW.source_name,NEW.row_id,NEW.observed_at,NEW.transaction_id,
  (SELECT b.observed_at FROM public.union_pnl_transaction_frames b WHERE b.transaction_id=NEW.transaction_id),NEW.operation,
  COALESCE(NEW.after_row,NEW.before_row)->>'tournament_id',COALESCE(NEW.after_row,NEW.before_row)->>'union_id')
 ON CONFLICT (event_id) DO NOTHING;
 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_union_pnl_inventory_touch() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_touch() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_union_pnl_inventory_touch()

-- @@DOOR fn_union_pnl_receipt_frame()
-- @@PIN md5=dd4dbe3a58dc48bd67aab9ac818280d2 len=294 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_union_pnl_receipt_frame()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 PERFORM public.fn_union_pnl_original_frame();
 NEW.transaction_id:=pg_current_xact_id();
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_union_pnl_receipt_frame() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_union_pnl_receipt_frame() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_union_pnl_receipt_frame()

-- @@DOOR fn_wheel_host(p_club_id uuid, OUT host_id uuid, OUT host_kind text)
-- @@PIN md5=704c11cdd7da184af55ecb312c2500ac len=538 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_wheel_host(p_club_id uuid, OUT host_id uuid, OUT host_kind text)
 RETURNS record
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(c.union_id, c.id),
         CASE WHEN c.union_id IS NULL THEN 'club' ELSE 'union' END
    FROM public.clubs c WHERE c.id = p_club_id
     -- DIAMOND PHASE 11: the Diamond Arena hosts no club games (players only,
     -- Ruling 16), so no club-commerce door can find it as a host.
     AND c.asset IS DISTINCT FROM 'diamonds';
$function$;
ALTER FUNCTION public.fn_wheel_host(p_club_id uuid, OUT host_id uuid, OUT host_kind text) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_wheel_host(p_club_id uuid, OUT host_id uuid, OUT host_kind text) TO PUBLIC, anon, authenticated, service_role;
-- @@END fn_wheel_host(p_club_id uuid, OUT host_id uuid, OUT host_kind text)

-- @@DOOR generate_referral_code()
-- @@PIN md5=3ac2d5529de95863764ddca919ddfda3 len=1344 owner=postgres
CREATE OR REPLACE FUNCTION public.generate_referral_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    new_code VARCHAR(20);
    attempt integer;
BEGIN
    IF NEW.referral_code IS NOT NULL THEN
        RETURN NEW;
    END IF;
    FOR attempt IN 1..128 LOOP
        -- Compare the same representation that is stored and looked up by clients.
        new_code := UPPER('SP-' || SUBSTRING(MD5(RANDOM()::TEXT), 1, 6));
        IF EXISTS (SELECT 1 FROM public.profiles WHERE referral_code = new_code) THEN
            CONTINUE;
        END IF;
        -- An uncommitted generator owns this candidate. Skip it without waiting
        -- or accumulating a lock-order dependency between multi-row inserts.
        IF NOT pg_catalog.pg_try_advisory_xact_lock(
            pg_catalog.hashtextextended('profiles:referral-code:v1:' || new_code, 0)
        ) THEN
            CONTINUE;
        END IF;
        -- A previous owner may have committed between the first read and our lock.
        IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE referral_code = new_code) THEN
            NEW.referral_code := new_code;
            RETURN NEW;
        END IF;
    END LOOP;
    RAISE EXCEPTION USING ERRCODE = '54000',
        MESSAGE = 'Referral code generation exhausted its collision budget';
END;
$function$;
ALTER FUNCTION public.generate_referral_code() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.generate_referral_code() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_referral_code() TO service_role;
-- @@END generate_referral_code()

-- @@DOOR send_wallet_diamond_transfer(p_recipient_id uuid, p_amount integer, p_message text, p_reference_id text)
-- @@PIN md5=8d5b95d8ad2a74c1ba85339168349606 len=7394 owner=postgres
CREATE OR REPLACE FUNCTION public.send_wallet_diamond_transfer(p_recipient_id uuid, p_amount integer, p_message text DEFAULT NULL::text, p_reference_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sender uuid := auth.uid();
  v_previous public.diamond_wallet_transfers%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_sender_balance integer;
  v_recipient_balance integer;
  v_collateral bigint;
  v_cap jsonb;
  v_debt record;
  v_take integer;
  v_settled integer := 0;
  v_sender_journal uuid;
  v_recipient_journal uuid;
  v_debt_journal uuid;
  v_ref text;
BEGIN
  IF v_sender IS NULL OR NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'authentication_required' USING ERRCODE='42501';
  END IF;
  IF p_recipient_id IS NULL OR p_recipient_id = v_sender
     OR p_amount IS NULL OR p_amount <= 0
     OR p_reference_id IS NULL
     OR p_reference_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{11,127}$'
     OR length(COALESCE(p_message,'')) > 280 THEN
    RAISE EXCEPTION 'invalid_transfer_request' USING ERRCODE='22023';
  END IF;

  -- Shares the authoritative profile locks used by store spending and custody.
  PERFORM 1 FROM public.profiles WHERE id=LEAST(v_sender,p_recipient_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'transfer_profile_not_found'; END IF;
  PERFORM 1 FROM public.profiles WHERE id=GREATEST(v_sender,p_recipient_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'transfer_profile_not_found'; END IF;

  SELECT * INTO v_previous FROM public.diamond_wallet_transfers
    WHERE sender_id=v_sender AND request_id=p_reference_id;
  IF FOUND THEN
    IF v_previous.recipient_id <> p_recipient_id OR v_previous.amount <> p_amount
       OR v_previous.message IS DISTINCT FROM p_message THEN
      RAISE EXCEPTION 'idempotency_payload_mismatch' USING ERRCODE='22023';
    END IF;
    RETURN to_jsonb(v_previous) || jsonb_build_object('success',true);
  END IF;

  -- Rechecked at the writer, even when the UI selected an accepted friend.
  PERFORM 1 FROM public.friendships
    WHERE status='accepted' AND
      ((user_id=v_sender AND friend_id=p_recipient_id) OR
       (user_id=p_recipient_id AND friend_id=v_sender))
    FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'accepted_friend_required' USING ERRCODE='42501'; END IF;

  v_cap := public.fn_check_anti_farming_gift_cap(v_sender,p_recipient_id,p_amount);
  IF (v_cap->>'allowed')::boolean IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('success',false,'code',v_cap->>'code',
      'error',v_cap->>'reason','cap_check',v_cap);
  END IF;
  SELECT diamonds INTO v_sender_balance FROM public.profiles WHERE id=v_sender;
  SELECT diamonds INTO v_recipient_balance FROM public.profiles WHERE id=p_recipient_id;
  -- Preserve the current refundable-purchase restriction. Held purchased units
  -- are already outside available balance, so do not subtract them twice.
  SELECT COALESCE(sum(GREATEST(issued-consumed-refunded-arena_reserved,0)),0)
    INTO v_collateral FROM public.diamond_purchase_lots WHERE user_id=v_sender;
  IF v_sender_balance IS NULL OR v_sender_balance < p_amount
     OR v_sender_balance::bigint-v_collateral < p_amount THEN
    RETURN jsonb_build_object('success',false,'code','insufficient_transferable_diamonds',
      'error','Only Available Diamonds Outside Purchased Refund Collateral Can Be Sent');
  END IF;
  IF v_recipient_balance IS NULL
     OR v_recipient_balance::bigint+p_amount > 2147483647 THEN
    RAISE EXCEPTION 'recipient_balance_limit';
  END IF;

  -- Same debt treatment as the existing authoritative positive-credit path.
  -- Separate transfer journals retain the actual counterparty, not player:unknown.
  FOR v_debt IN SELECT * FROM public.diamond_debts
    WHERE user_id=p_recipient_id AND settled_at IS NULL
    ORDER BY created_at,id FOR UPDATE
  LOOP
    EXIT WHEN v_settled >= p_amount;
    v_take := LEAST(v_debt.amount,p_amount-v_settled);
    IF v_take = v_debt.amount THEN
      UPDATE public.diamond_debts SET settled_at=now(),settled_by='send_wallet_diamond_transfer'
        WHERE id=v_debt.id;
    ELSE
      UPDATE public.diamond_debts SET amount=amount-v_take WHERE id=v_debt.id;
      INSERT INTO public.diamond_debts(user_id,purchase_id,amount,reason,created_at,settled_at,settled_by)
        VALUES(p_recipient_id,v_debt.purchase_id,v_take,
          v_debt.reason || ' (partial settlement of ' || v_debt.id || ')',
          v_debt.created_at,now(),'send_wallet_diamond_transfer');
    END IF;
    v_settled := v_settled+v_take;
  END LOOP;

  v_ref := 'wallet-transfer:' || v_sender || ':' || p_reference_id;
  INSERT INTO public.diamond_transactions(user_id,amount,type,transaction_type,source,
    description,balance_after,reference_id,counterparty,issuance_class,metadata)
  VALUES(v_sender,-p_amount,'diamond_gift_sent','diamond_gift_sent','wallet_diamond_transfer',
    'Diamonds Sent To A Friend',v_sender_balance-p_amount,v_ref || ':sender',
    'player:' || p_recipient_id,'transferred',
    jsonb_build_object('transfer_id',v_id,'recipient_id',p_recipient_id,'message',p_message))
  RETURNING id INTO v_sender_journal;
  INSERT INTO public.diamond_transactions(user_id,amount,type,transaction_type,source,
    description,balance_after,reference_id,counterparty,issuance_class,metadata)
  VALUES(p_recipient_id,p_amount,'diamond_gift_received','diamond_gift_received','wallet_diamond_transfer',
    'Diamonds Received From A Friend',v_recipient_balance+p_amount,v_ref || ':recipient',
    'player:' || v_sender,'transferred',
    jsonb_build_object('transfer_id',v_id,'sender_id',v_sender,'message',p_message))
  RETURNING id INTO v_recipient_journal;
  IF v_settled > 0 THEN
    INSERT INTO public.diamond_transactions(user_id,amount,type,transaction_type,source,
      description,balance_after,reference_id,counterparty,issuance_class,metadata)
    VALUES(p_recipient_id,-v_settled,'debt_settlement','debt_settlement','debt_settlement',
      'Settled Diamonds Owed After A Reversed Purchase',v_recipient_balance+p_amount-v_settled,
      'debt-settlement:' || v_recipient_journal,'receivable:diamond_debts','spend',
      jsonb_build_object('credit_transaction_id',v_recipient_journal,'transfer_id',v_id))
    RETURNING id INTO v_debt_journal;
    PERFORM public.fn_ca_register_diamond_journal_row(v_debt_journal);
    IF NOT EXISTS(SELECT 1 FROM public.ca_mint_ledger
      WHERE diamond_tx_id=v_debt_journal AND action='burn' AND asset='diamonds'
        AND holder_type='player' AND holder_id=p_recipient_id AND amount=v_settled) THEN
      RAISE EXCEPTION 'diamond_debt_retirement_missing';
    END IF;
  END IF;
  UPDATE public.profiles SET diamonds=v_sender_balance-p_amount,
    diamond_balance=v_sender_balance-p_amount,updated_at=now() WHERE id=v_sender;
  UPDATE public.profiles SET diamonds=v_recipient_balance+p_amount-v_settled,
    diamond_balance=v_recipient_balance+p_amount-v_settled,updated_at=now() WHERE id=p_recipient_id;
  INSERT INTO public.diamond_wallet_transfers(id,sender_id,recipient_id,request_id,amount,message,
    sender_journal_id,recipient_journal_id)
  VALUES(v_id,v_sender,p_recipient_id,p_reference_id,p_amount,p_message,
    v_sender_journal,v_recipient_journal)
  RETURNING * INTO v_previous;
  RETURN to_jsonb(v_previous) || jsonb_build_object('success',true);
END;
$function$;
ALTER FUNCTION public.send_wallet_diamond_transfer(p_recipient_id uuid, p_amount integer, p_message text, p_reference_id text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.send_wallet_diamond_transfer(p_recipient_id uuid, p_amount integer, p_message text, p_reference_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.send_wallet_diamond_transfer(p_recipient_id uuid, p_amount integer, p_message text, p_reference_id text) TO authenticated;
-- @@END send_wallet_diamond_transfer(p_recipient_id uuid, p_amount integer, p_message text, p_reference_id text)

-- @@DOOR smarter_private.breakfast_roster(p_tournament uuid)
-- @@PIN md5=4140be66012a9c16b19b61db8fd8d784 len=994 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.breakfast_roster(p_tournament uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id',p.id,'user_id',p.user_id,'club_id',p.club_id,'tournament_id',p.tournament_id,
  'status',p.status,'position',p.position,'chips',p.chips,'chip_count',p.chip_count,
  'prize',p.prize,'table_id',p.table_id,'seat_number',p.seat_number,
  'registered_at',p.registered_at,'eliminated_at',p.eliminated_at,
  'elimination_sequence',p.elimination_sequence,'rebuys',p.rebuys,'add_on',p.add_on,
  'rebuy_prompt_until',p.rebuy_prompt_until,'current_bounty',p.current_bounty,
  'bounty_winnings',p.bounty_winnings,'bounties_collected',p.bounties_collected,
  'source_satellite_id',p.source_satellite_id,'is_satellite_qualifier',p.is_satellite_qualifier
 ) ORDER BY p.id),'[]'::jsonb) FROM public.tournament_players p WHERE p.tournament_id=p_tournament
$function$;
ALTER FUNCTION smarter_private.breakfast_roster(p_tournament uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.breakfast_roster(p_tournament uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.breakfast_roster(p_tournament uuid)

-- @@DOOR smarter_private.breakfast_standings_witness(p_tournament uuid, p_winner uuid)
-- @@PIN md5=93a1e3e0f2677eebffc61ac7667d99e2 len=2282 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.breakfast_standings_witness(p_tournament uuid, p_winner uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE r smarter_private.breakfast_original_witness%ROWTYPE; actual jsonb; original jsonb; target jsonb;
BEGIN
 SELECT * INTO r FROM smarter_private.breakfast_original_witness WHERE tournament_id=p_tournament;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF p_tournament<>'f370585d-40ea-4085-bb8f-c7e8c74f3fb4'
 OR p_winner<>'ae0bc48d-f98c-4b25-a9fa-e3522f986173'
 OR r.expected_hash IS DISTINCT FROM md5(r.expected::text) THEN
  RAISE EXCEPTION 'BREAKFAST_WITNESS_IDENTITY' USING ERRCODE='P0404'; END IF;
 SELECT jsonb_agg(v ORDER BY v->>'id') INTO original FROM jsonb_array_elements(r.expected->'roster') v
 WHERE v->>'user_id' NOT IN('9ee591b7-2360-4ea8-ad3b-942ef829fbda','ae0bc48d-f98c-4b25-a9fa-e3522f986173');
 SELECT jsonb_agg(v ORDER BY v->>'id') INTO actual FROM jsonb_array_elements(smarter_private.breakfast_roster(p_tournament)) v
 WHERE v->>'user_id' NOT IN('9ee591b7-2360-4ea8-ad3b-942ef829fbda','ae0bc48d-f98c-4b25-a9fa-e3522f986173');
 SELECT v INTO target FROM jsonb_array_elements(smarter_private.breakfast_roster(p_tournament)) v
 WHERE v->>'user_id'='9ee591b7-2360-4ea8-ad3b-942ef829fbda';
 IF jsonb_array_length(original)<>32 OR actual IS DISTINCT FROM original
 OR target IS DISTINCT FROM r.target_postimage
 OR NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament
  AND user_id=p_winner AND status='winner' AND position=1 AND chips=430255)
 OR (SELECT count(DISTINCT position) FROM public.tournament_players WHERE tournament_id=p_tournament)<>34
 OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament AND (position IS NULL OR position<1 OR position>34)) THEN
  RAISE EXCEPTION 'BREAKFAST_ORIGINAL_STANDINGS_CHANGED' USING ERRCODE='P0404'; END IF;
 RETURN jsonb_build_object('operation_id',r.operation_id,'expected_hash',r.expected_hash,
  'archive_sha256',r.original_archive_sha256,'original_line',r.original_line,
  'original_place',r.original_place,'original_prize',r.original_prize,
  'original_outcome','failed_request','admitted_at',r.admitted_at);
END $function$;
ALTER FUNCTION smarter_private.breakfast_standings_witness(p_tournament uuid, p_winner uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.breakfast_standings_witness(p_tournament uuid, p_winner uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.breakfast_standings_witness(p_tournament uuid, p_winner uuid)

-- @@DOOR smarter_private.breakfast_witness_immutable()
-- @@PIN md5=4198678f42ca289675b9a40bca17c525 len=254 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.breakfast_witness_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN RAISE EXCEPTION 'BREAKFAST_ORIGINAL_WITNESS_IMMUTABLE' USING ERRCODE='55000'; END
$function$;
ALTER FUNCTION smarter_private.breakfast_witness_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.breakfast_witness_immutable() FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.breakfast_witness_immutable()

-- @@DOOR smarter_private.f06_abort_receipt_immutable()
-- @@PIN md5=811127b67caea34bd7d3e5bc6c41ed94 len=245 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.f06_abort_receipt_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN RAISE EXCEPTION 'F06_ABORT_RECEIPT_IMMUTABLE' USING ERRCODE='55000'; END $function$;
ALTER FUNCTION smarter_private.f06_abort_receipt_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_abort_receipt_immutable() FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.f06_abort_receipt_immutable()

-- @@DOOR smarter_private.f06_assert_movement(p_break uuid)
-- @@PIN md5=ad99e13122447e117d9769d28019cb7f len=5870 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.f06_assert_movement(p_break uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE a smarter_private.f06_movement_admissions; o smarter_private.f06_operations;
 r jsonb; actual jsonb; winner jsonb; movement public.tournament_seat_move_receipts; remaining integer:=0; mixed_generation uuid;
 g uuid:=NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid;
BEGIN
 mixed_generation:=smarter_private.f06_mixed_movement_generation(p_break);
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions WHERE break_id=p_break) THEN RETURN; END IF;
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break;
 SELECT * INTO a FROM smarter_private.f06_movement_admissions WHERE break_id=p_break AND custody_id=o.custody_id;
 IF NOT FOUND OR o.custody_generation IS DISTINCT FROM a.lease_generation OR o.revision IS DISTINCT FROM a.revision
 OR o.lifecycle IS DISTINCT FROM a.lifecycle OR o.source_table_id IS DISTINCT FROM a.table_id
 OR o.tournament_id IS DISTINCT FROM a.tournament_id OR (g IS DISTINCT FROM a.lease_generation AND g IS DISTINCT FROM mixed_generation)
 OR o.state NOT IN ('park_requested','begun','close_confirmed') THEN
 RAISE EXCEPTION 'F06_MOVEMENT_CUSTODY_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM smarter_private.f06_authority(a.tournament_id,COALESCE(mixed_generation,a.lease_generation),false);
 IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=a.table_id AND tournament_id=a.tournament_id AND f06_lifecycle=a.lifecycle)
 OR smarter_private.f06_movement_permits(a.tournament_id,a.table_id,(a.proof#>>'{atomic,hand_number}')::bigint) IS DISTINCT FROM a.proof->'permits'
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=a.table_id AND NOT is_complete)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=a.table_id AND hand_number>(a.proof#>>'{atomic,hand_number}')::bigint)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=a.table_id AND hand_number>(a.proof#>>'{atomic,hand_number}')::bigint)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=a.table_id AND (hand_number>(a.proof#>>'{atomic,hand_number}')::bigint OR committed_at>(a.proof#>>'{atomic,committed_at}')::timestamptz))
 OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits x WHERE hand_id=(a.proof#>>'{atomic,hand_id}')::uuid AND (SELECT jsonb_object_agg(c.key,c.value) FROM jsonb_each(to_jsonb(x)) c WHERE a.proof->'atomic' ? c.key OR c.value<>'null'::jsonb)=a.proof->'atomic')
 OR NOT EXISTS(SELECT 1 FROM public.hand_history x WHERE id=(a.proof#>>'{history,id}')::uuid AND (SELECT jsonb_object_agg(c.key,c.value) FROM jsonb_each(to_jsonb(x)) c WHERE a.proof->'history' ? c.key OR c.value<>'null'::jsonb)=a.proof->'history') THEN
 RAISE EXCEPTION 'F06_MOVEMENT_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(a.proof->'roster') LOOP
 SELECT d.receipt INTO winner FROM smarter_private.f06_attempts d JOIN public.tournament_seat_move_receipts m ON m.request_id=d.request_id
 WHERE d.break_id=p_break AND d.user_id=(r#>>'{seat,user_id}')::uuid AND d.state='winner';
 IF FOUND THEN
 SELECT * INTO movement FROM public.tournament_seat_move_receipts WHERE request_id=(winner->>'request_id')::uuid;
 IF NOT FOUND OR winner-'source_occupancy_id'-'source_lifecycle'-'break_id' IS DISTINCT FROM to_jsonb(movement)
 OR (winner->>'source_table_id')::uuid IS DISTINCT FROM a.table_id OR (winner->>'source_seat_id')::uuid IS DISTINCT FROM (r#>>'{seat,id}')::uuid
 OR (winner->>'source_occupancy_id')::uuid IS DISTINCT FROM (r#>>'{seat,occupancy_id}')::uuid
 OR (winner->>'stack')::numeric IS DISTINCT FROM (r#>>'{seat,stack}')::numeric OR (winner->>'break_id')::uuid IS DISTINCT FROM p_break
 OR (winner->>'source_lifecycle')::bigint IS DISTINCT FROM a.lifecycle THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WINNER_CHANGED' USING ERRCODE='55000'; END IF;
 ELSE
 remaining:=remaining+1;
 SELECT jsonb_build_object('seat',to_jsonb(s),'registration',to_jsonb(p)) INTO actual
 FROM public.table_seats s JOIN public.tournament_players p ON p.tournament_id=a.tournament_id AND p.user_id=s.user_id
 WHERE s.id=(r#>>'{seat,id}')::uuid AND s.table_id=a.table_id AND s.left_at IS NULL;
 IF jsonb_set(actual,'{registration}',(actual->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]) IS DISTINCT FROM jsonb_set(r,'{registration}',(r->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]) THEN RAISE EXCEPTION 'F06_MOVEMENT_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 END IF;
 END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements(a.proof->'eliminated') LOOP
 SELECT jsonb_build_object('seat',to_jsonb(s),'registration',to_jsonb(p),'accepted',r->'accepted') INTO actual
 FROM public.table_seats s JOIN public.tournament_players p ON p.tournament_id=a.tournament_id AND p.user_id=s.user_id
 WHERE s.id=(r#>>'{seat,id}')::uuid AND s.table_id=a.table_id;
 IF jsonb_set(actual,'{registration}',(actual->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]) IS DISTINCT FROM jsonb_set(r,'{registration}',(r->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]) THEN RAISE EXCEPTION 'F06_MOVEMENT_ELIMINATION_CHANGED' USING ERRCODE='55000'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.table_seats WHERE table_id=a.table_id AND left_at IS NULL)<>remaining
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=a.tournament_id AND table_id=a.table_id AND status IN ('playing','registered'))<>remaining THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED' USING ERRCODE='55000'; END IF;
END $function$;
ALTER FUNCTION smarter_private.f06_assert_movement(p_break uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_assert_movement(p_break uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.f06_assert_movement(p_break uuid)

-- @@DOOR smarter_private.f06_authority(t uuid, g uuid, take_lock boolean)
-- @@PIN md5=848b06c8e958ad739e0a60b388430f38 len=1171 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.f06_authority(t uuid, g uuid, take_lock boolean DEFAULT true)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'tournament-manager'
 OR NULLIF(current_setting('app.smarter_tournament_id',true),'')::uuid IS DISTINCT FROM t
 OR NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid IS DISTINCT FROM g OR t IS NULL OR g IS NULL THEN
 RAISE EXCEPTION 'F06_PROTOCOL2_REQUIRED' USING ERRCODE='42501'; END IF;
 IF take_lock THEN
 PERFORM 1 FROM public.engine_tournament_leases WHERE tournament_id=t AND protocol_version=2 AND lease_generation=g
 AND heartbeat_at>=clock_timestamp()-interval '30 seconds' FOR KEY SHARE;
 ELSE
 PERFORM 1 FROM public.engine_tournament_leases WHERE tournament_id=t AND protocol_version=2 AND lease_generation=g
 AND heartbeat_at>=clock_timestamp()-interval '30 seconds';
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'F06_LEASE_FENCED' USING ERRCODE='42501'; END IF;
END $function$;
ALTER FUNCTION smarter_private.f06_authority(t uuid, g uuid, take_lock boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_authority(t uuid, g uuid, take_lock boolean) FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.f06_authority(t uuid, g uuid, take_lock boolean)

-- @@DOOR smarter_private.f06_immutable_identity()
-- @@PIN md5=0fe40a0711ef6d196c6883d3b9e8b86f len=4739 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.f06_immutable_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'F06_HISTORY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_operations' AND (to_jsonb(OLD)->>'state')='withdrawn_before_manifest' THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_hand_permits' AND (to_jsonb(NEW)->>'state')='aborted_unsettled' AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts a WHERE a.receipt_id=(to_jsonb(NEW)->>'evidence_id')::uuid
 AND a.permit_id=(to_jsonb(NEW)->>'permit_id')::uuid AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_generation_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'evidence_id')::uuid AND a.permit_id=(to_jsonb(NEW)->>'permit_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_mixed_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'evidence_id')::uuid AND a.permit_id=(to_jsonb(NEW)->>'permit_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) THEN
 RAISE EXCEPTION 'F06_ABORT_RECEIPT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_operations' AND (to_jsonb(NEW)->>'state')='withdrawn_before_manifest' AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts a WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid
 AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid
 AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_generation_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_mixed_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_no_start_continuations a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid
 AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid
 AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid
 AND a.original_generation=(to_jsonb(NEW)->>'origin_generation')::uuid
 AND a.park=(to_jsonb(OLD))
 AND (to_jsonb(NEW)-'state'-'abort_receipt_id')=(to_jsonb(OLD)-'state'-'abort_receipt_id')) THEN
 RAISE EXCEPTION 'F06_ABORT_RECEIPT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_hand_permits' AND ((to_jsonb(OLD)-'state'-'evidence_id') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'evidence_id') OR to_jsonb(OLD)->>'state'<>'reserved') THEN
 RAISE EXCEPTION 'F06_HAND_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_members' OR
 (TG_TABLE_NAME='f06_attempts' AND ((to_jsonb(OLD)-'state'-'receipt') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'receipt') OR to_jsonb(OLD)->>'state'<>'active')) OR
 (TG_TABLE_NAME='f06_operations' AND ((to_jsonb(OLD)-'state'-'manifest'-'revision'-'custody_id'-'custody_generation'-'cleanup_kind'-'close_receipt'-'abort_receipt_id') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'manifest'-'revision'-'custody_id'-'custody_generation'-'cleanup_kind'-'close_receipt'-'abort_receipt_id') OR (to_jsonb(OLD)->'manifest'<>'null'::jsonb AND to_jsonb(OLD)->'manifest' IS DISTINCT FROM to_jsonb(NEW)->'manifest') OR (to_jsonb(OLD)->'close_receipt'<>'null'::jsonb AND to_jsonb(OLD)->'close_receipt' IS DISTINCT FROM to_jsonb(NEW)->'close_receipt'))) THEN
 RAISE EXCEPTION 'F06_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION smarter_private.f06_immutable_identity() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_immutable_identity() FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.f06_immutable_identity()

-- @@DOOR smarter_private.f06_manager_transfer_immutable()
-- @@PIN md5=d595b68fa3464e5d56b5bc5395b5eb08 len=251 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.f06_manager_transfer_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN RAISE EXCEPTION 'F06_MANAGER_TRANSFER_IMMUTABLE' USING ERRCODE='55000'; END $function$;
ALTER FUNCTION smarter_private.f06_manager_transfer_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_manager_transfer_immutable() FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.f06_manager_transfer_immutable()

-- @@DOOR smarter_private.f06_mixed_current_admission(t uuid, g uuid, transfer uuid)
-- @@PIN md5=432f7c88639918e399e23d670639a246 len=2760 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.f06_mixed_current_admission(t uuid, g uuid, transfer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE
  a smarter_private.f06_manager_custody_admissions;
  tr smarter_private.f06_manager_custody_transfers;
  l public.engine_tournament_leases;
  s text;
BEGIN
  -- Unchanged: the caller must be the tournament-manager actor holding a LIVE
  -- protocol-2 lease for t at generation g (heartbeat within 30s), key-shared.
  PERFORM smarter_private.f06_authority(t,g);

  -- The live lease must still be this tournament's protocol-2 lease at the
  -- named successor generation. Re-read explicitly so the binding is stated.
  SELECT * INTO l FROM public.engine_tournament_leases e WHERE e.tournament_id=t;
  IF NOT FOUND OR l.protocol_version<>2 OR l.lease_generation IS DISTINCT FROM g THEN
    RAISE EXCEPTION 'F06_MIXED_ADMITTED_LEASE_CHANGED'; END IF;

  SELECT * INTO a FROM smarter_private.f06_manager_custody_admissions WHERE transfer_id=transfer FOR SHARE;
  IF NOT FOUND OR a.tournament_id IS DISTINCT FROM t OR a.generation IS DISTINCT FROM g THEN
    RAISE EXCEPTION 'F06_MIXED_ADMITTED_PROCESS_CHANGED'; END IF;

  -- Custody, not process. The admission's stored lease_identity must name a real
  -- protocol-2 lease for THIS tournament at THIS successor generation. Its
  -- instance_id / engine_version / acquired_at are process facts that never
  -- described the custody and cannot survive a restart, so they are not compared.
  IF (a.lease_identity->>'tournament_id')::uuid    IS DISTINCT FROM t
  OR (a.lease_identity->>'lease_generation')::uuid IS DISTINCT FROM g
  OR (a.lease_identity->>'protocol_version')::int  IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'F06_MIXED_ADMITTED_CUSTODY_CHANGED'; END IF;

  -- The custody must still be the admitted custody. The transfer row is
  -- append-only (f06_manager_transfer_immutable) and carries the drained hand
  -- set in local_proof / canonical_proof, which the completion re-proves in full.
  SELECT * INTO tr FROM smarter_private.f06_manager_custody_transfers WHERE transfer_id=transfer;
  IF NOT FOUND OR tr.tournament_id IS DISTINCT FROM t OR tr.successor_generation IS DISTINCT FROM g THEN
    RAISE EXCEPTION 'F06_MIXED_ADMITTED_CUSTODY_CHANGED'; END IF;

  -- A drained event cannot deal while its transfer is open, so it cannot leave
  -- RUNNING by itself. Anything else is an explicit abort/void and must not be
  -- completed as ordinary custody.
  SELECT status INTO s FROM public.tournaments WHERE id=t;
  IF s IS DISTINCT FROM 'RUNNING' THEN
    RAISE EXCEPTION 'F06_MIXED_ADMITTED_EVENT_NOT_RUNNING'; END IF;

  RETURN to_jsonb(a);
END $function$;
ALTER FUNCTION smarter_private.f06_mixed_current_admission(t uuid, g uuid, transfer uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_mixed_current_admission(t uuid, g uuid, transfer uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.f06_mixed_current_admission(t uuid, g uuid, transfer uuid)

-- @@DOOR smarter_private.f06_mixed_movement_generation(p_break uuid)
-- @@PIN md5=2d096f6ee2a9eecd6895713be15cf365 len=4538 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.f06_mixed_movement_generation(p_break uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE o smarter_private.f06_operations; transfer smarter_private.f06_manager_custody_transfers;
 original jsonb; seat jsonb; registration jsonb; actual jsonb; winning jsonb; movement jsonb; g uuid;
 remaining integer:=0;
BEGIN
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT c.* INTO transfer FROM smarter_private.f06_manager_custody_transfers c
 JOIN smarter_private.f06_manager_custody_admissions a USING(transfer_id)
 WHERE c.tournament_id=o.tournament_id AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_completions done WHERE done.transfer_id=c.transfer_id);
 IF NOT FOUND THEN RETURN NULL; END IF;
 g:=NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid;
 PERFORM smarter_private.f06_mixed_current_admission(o.tournament_id,g,transfer.transfer_id);
 SELECT value INTO original FROM jsonb_array_elements(transfer.canonical_proof->'operations') WHERE value->>'break_id'=p_break::text;
 IF original IS NULL OR (original->>'tournament_id',original->>'source_table_id',original->>'lifecycle') IS DISTINCT FROM
 (o.tournament_id::text,o.source_table_id::text,o.lifecycle::text)
 OR original->>'state' NOT IN('park_requested','begun','close_confirmed')
 OR o.state NOT IN('park_requested','begun','close_confirmed')
 OR (original->'manifest'<>'null'::jsonb AND original->'manifest' IS DISTINCT FROM o.manifest)
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=o.source_table_id AND tournament_id=o.tournament_id AND f06_lifecycle=o.lifecycle)
 THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_ORIGINAL_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=o.tournament_id AND state='reserved')
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch d JOIN smarter_private.f06_hand_permits h USING(permit_id) WHERE h.tournament_id=o.tournament_id)
 THEN RAISE EXCEPTION 'F06_MIXED_ORIGINAL_DISPOSITION_REQUIRED'; END IF;
 -- The complete captured source roster remains exact until canonical winning
 -- receipts consume each original occupancy. Destination stacks are not proof.
 FOR seat IN SELECT value FROM jsonb_array_elements(transfer.canonical_proof->'seats')
 WHERE value->>'table_id'=o.source_table_id::text AND value->'left_at'='null'::jsonb LOOP
 SELECT value INTO registration FROM jsonb_array_elements(transfer.canonical_proof->'registrations') WHERE value->>'user_id'=seat->>'user_id';
 IF registration IS NULL OR (seat->>'stack')::numeric<=0 OR registration->>'status'<>'playing'
 OR (registration->>'chips')::numeric IS DISTINCT FROM (seat->>'stack')::numeric THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_ROSTER_UNPROVEN'; END IF;
 SELECT a.receipt,to_jsonb(r) INTO winning,movement FROM smarter_private.f06_attempts a
 JOIN public.tournament_seat_move_receipts r USING(request_id) WHERE a.break_id=p_break AND a.user_id=(seat->>'user_id')::uuid AND a.state='winner';
 IF FOUND THEN
 IF winning-ARRAY['source_occupancy_id','source_lifecycle','break_id'] IS DISTINCT FROM movement
 OR (winning->>'source_seat_id',winning->>'source_occupancy_id',winning->>'source_table_id',winning->>'source_lifecycle',winning->>'break_id') IS DISTINCT FROM
 (seat->>'id',seat->>'occupancy_id',o.source_table_id::text,o.lifecycle::text,p_break::text)
 OR (winning->>'stack')::numeric IS DISTINCT FROM (seat->>'stack')::numeric
 THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_WINNER_CHANGED'; END IF;
 ELSE
 remaining:=remaining+1;
 SELECT to_jsonb(s) INTO actual FROM public.table_seats s WHERE s.id=(seat->>'id')::uuid;
 IF actual IS DISTINCT FROM seat THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_ROSTER_CHANGED'; END IF;
 SELECT to_jsonb(p) INTO actual FROM public.tournament_players p WHERE p.tournament_id=o.tournament_id AND p.user_id=(seat->>'user_id')::uuid;
 IF actual IS DISTINCT FROM registration THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_REGISTRATION_CHANGED'; END IF;
 END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.table_seats WHERE table_id=o.source_table_id AND left_at IS NULL)<>remaining
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=o.tournament_id AND table_id=o.source_table_id AND status IN('playing','registered'))<>remaining
 THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_WHOLE_ROSTER_REQUIRED'; END IF;
 RETURN g;
END $function$;
ALTER FUNCTION smarter_private.f06_mixed_movement_generation(p_break uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_mixed_movement_generation(p_break uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.f06_mixed_movement_generation(p_break uuid)

-- @@DOOR smarter_private.f06_mixed_preparation_guard()
-- @@PIN md5=bcbdb70741099a7806acd90e838cc03f len=552 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.f06_mixed_preparation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
BEGIN
 IF NEW.state='reserved' AND EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_transfers c
 WHERE c.tournament_id=NEW.tournament_id AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_completions done WHERE done.transfer_id=c.transfer_id))
 THEN RAISE EXCEPTION 'F06_MIXED_CUSTODY_ONLY'; END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION smarter_private.f06_mixed_preparation_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_mixed_preparation_guard() FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.f06_mixed_preparation_guard()

-- @@DOOR smarter_private.f06_movement_immutable()
-- @@PIN md5=f7c8db440c9c3599ac70c32dae577c6b len=243 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.f06_movement_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$ BEGIN RAISE EXCEPTION 'F06_MOVEMENT_RECEIPT_IMMUTABLE' USING ERRCODE='55000'; END $function$;
ALTER FUNCTION smarter_private.f06_movement_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_movement_immutable() FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.f06_movement_immutable()

-- @@DOOR smarter_private.f06_movement_permits(p_tournament uuid, p_table uuid, p_boundary bigint)
-- @@PIN md5=f19826cbc5498bb58ed1463806ef7b52 len=3069 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.f06_movement_permits(p_tournament uuid, p_table uuid, p_boundary bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE result jsonb;
BEGIN
 -- Every permit this table ever held must be DECIDED before its players move.
 -- accepted: its exact sealed commit, at or below the boundary -- verified
 -- against hand_atomic_commits while that row exists, and afterwards against
 -- the permit itself, which is immutable and is the ONE witness retention
 -- cannot take (20260925210126; before it, an eight-day-old accepted hand
 -- refused its table's movement for ever). never_started and
 -- aborted_unsettled: decided not to count by a receipt, immutable, fenced
 -- from dispatch and history, and still visibly nothing of the hand on this
 -- table. 'reserved' is undecided and refuses; so does any dispatch.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits h
 LEFT JOIN public.hand_atomic_commits a ON a.hand_id=h.evidence_id AND a.table_id=h.table_id AND a.hand_number=h.hand_number
 WHERE h.table_id=p_table AND (h.tournament_id IS DISTINCT FROM p_tournament
 OR NOT EXISTS(SELECT 1 FROM public.tables t WHERE t.id=p_table AND t.f06_lifecycle=h.lifecycle)
 OR CASE
 WHEN h.state='accepted' THEN
 h.hand_number>p_boundary OR h.evidence_id IS NULL
 OR (a.hand_id IS NOT NULL AND (
 a.post_commit_completed_at IS NULL
 OR NOT isfinite(a.post_commit_completed_at) OR a.post_commit_completed_at<a.committed_at
 OR a.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb
 OR a.post_commit_result->>'hand_id' IS DISTINCT FROM a.hand_id::text
 OR (a.post_commit_result->>'hand_number')::bigint IS DISTINCT FROM a.hand_number))
 -- No commit row matched this permit's own evidence. If some OTHER commit
 -- occupies the coordinate the permit claims, that is an identity conflict
 -- and refuses, exactly as before. An EMPTY coordinate is retention, and the
 -- immutable accepted permit is the surviving proof of the seal.
 OR (a.hand_id IS NULL AND EXISTS(SELECT 1 FROM public.hand_atomic_commits c
 WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number))
 WHEN h.state IN ('never_started','aborted_unsettled') THEN
 h.evidence_id IS NULL
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history x WHERE x.table_id=h.table_id AND x.hand_number=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_private_state p WHERE p.table_id=h.table_id AND p.hand_number=h.hand_number)
 ELSE true END))
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch d JOIN smarter_private.f06_hand_permits h USING(permit_id) WHERE h.table_id=p_table) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_UNRESOLVED_HAND_CUSTODY' USING ERRCODE='55000'; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.hand_number,h.permit_id),'[]'::jsonb) INTO result
 FROM smarter_private.f06_hand_permits h WHERE h.table_id=p_table;
 RETURN result;
END $function$;
ALTER FUNCTION smarter_private.f06_movement_permits(p_tournament uuid, p_table uuid, p_boundary bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_movement_permits(p_tournament uuid, p_table uuid, p_boundary bigint) FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.f06_movement_permits(p_tournament uuid, p_table uuid, p_boundary bigint)

-- @@DOOR smarter_private.f06_movement_transition_guard()
-- @@PIN md5=1534f01f6efcb1aa16f9094dd8614f3a len=543 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.f06_movement_transition_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE b uuid;
BEGIN
 IF TG_TABLE_NAME='f06_operations' THEN
 IF NEW.manifest IS NOT DISTINCT FROM OLD.manifest THEN RETURN NEW; END IF;
 b:=NEW.break_id;
 ELSE
 SELECT break_id INTO b FROM smarter_private.f06_attempts WHERE request_id=NEW.request_id;
 END IF;
 PERFORM smarter_private.f06_assert_movement(b);
 RETURN NEW;
END $function$;
ALTER FUNCTION smarter_private.f06_movement_transition_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_movement_transition_guard() FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.f06_movement_transition_guard()

-- @@DOOR smarter_private.f06_new_lifecycle()
-- @@PIN md5=dca29a92ad46c6adb6e561f639e5a208 len=221 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.f06_new_lifecycle()
 RETURNS bigint
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ SELECT nextval('smarter_private.f06_lifecycle_seq') $function$;
ALTER FUNCTION smarter_private.f06_new_lifecycle() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_new_lifecycle() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION smarter_private.f06_new_lifecycle() TO anon, authenticated, service_role;
-- @@END smarter_private.f06_new_lifecycle()

-- @@DOOR smarter_private.f06_no_start_continuation_immutable()
-- @@PIN md5=2c87da2a00030dcc36ecb62bf51b2a89 len=252 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.f06_no_start_continuation_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN RAISE EXCEPTION 'F06_CONTINUATION_IMMUTABLE' USING ERRCODE='55000'; END $function$;
ALTER FUNCTION smarter_private.f06_no_start_continuation_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_no_start_continuation_immutable() FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.f06_no_start_continuation_immutable()

-- @@DOOR smarter_private.f06_retained_submission_guard()
-- @@PIN md5=8effe23bf967551f427628433dab6191 len=936 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.f06_retained_submission_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE d smarter_private.hand_submission_dispositions;
BEGIN
 IF NEW.state NOT IN ('never_started','aborted_unsettled') THEN RETURN NEW; END IF;
 INSERT INTO smarter_private.hand_submission_dispositions(table_id,hand_number,permit_id,disposition,submission_id)
 VALUES(NEW.table_id,NEW.hand_number,NEW.permit_id,'disposed',NULL) ON CONFLICT(table_id,hand_number) DO NOTHING;
 SELECT * INTO STRICT d FROM smarter_private.hand_submission_dispositions WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number;
 IF d.disposition<>'disposed' OR (d.permit_id IS NOT NULL AND d.permit_id IS DISTINCT FROM NEW.permit_id) THEN
  RAISE EXCEPTION 'F06_RETAINED_HAND_SUBMISSION_REQUIRES_ACCEPTED_DISPOSITION' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION smarter_private.f06_retained_submission_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_retained_submission_guard() FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.f06_retained_submission_guard()

-- @@DOOR smarter_private.f06_source_guard()
-- @@PIN md5=082cf45040f08f8ea533e0c21d7cd4e3 len=8364 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.f06_source_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE src uuid;dst uuid;u uuid;t uuid;oldj jsonb;newj jsonb;bound boolean;moving boolean;
BEGIN
 oldj:=CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 newj:=CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE '{}'::jsonb END;
 src:=(oldj->>'table_id')::uuid;dst:=(newj->>'table_id')::uuid;u:=COALESCE((newj->>'user_id')::uuid,(oldj->>'user_id')::uuid);
 SELECT tournament_id INTO t FROM public.tables WHERE id=COALESCE(src,dst);
 IF t IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 -- Payload-only writes preserve source custody. They need to exclude a
 -- canonical move/begin, not other accepted hands in this tournament. The
 -- outer hand RPC already holds T shared; promoting it to exclusive here
 -- makes ordinary concurrent hands refuse each other even with no F06 move.
 IF TG_OP='UPDATE' AND (
  (TG_TABLE_NAME='table_seats'
   AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
   AND (src,oldj->>'user_id',oldj->>'seat_number') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number'))
  OR (TG_TABLE_NAME='tournament_players'
   AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status'))
 ) THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
   RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
 END IF;
 -- Canonical admission authorities already hold T exclusive. A direct row
 -- writer may try it, but cannot wait while holding a row needed by begin.
 -- Closing the exact already-zero generation cannot move funded custody.
 -- Share G/T with other tables' hands, while still excluding every canonical
 -- begin/move/terminal authority, which owns T or G exclusively. Do not
 -- return here: PARK_REQUESTED still needs the original hand receipt and
 -- BEGUN still needs the original move receipt below.
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='table_seats'
  AND oldj->>'left_at' IS NULL AND newj->>'left_at' IS NOT NULL
  AND newj->>'status'='left'
  AND oldj->'stack'='0'::jsonb AND newj->'stack'='0'::jsonb
  AND oldj->>'user_id' IS NOT NULL
  AND (src,oldj->>'id',oldj->>'user_id',oldj->>'seat_number',oldj->>'joined_at',oldj->>'club_id')
      IS NOT DISTINCT FROM
      (dst,newj->>'id',newj->>'user_id',newj->>'seat_number',newj->>'joined_at',newj->>'club_id') THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
   RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
  END IF;
 ELSE
  PERFORM smarter_private.f06_try_lane(t);
 END IF;
 -- THE EVENT'S OWN TERMINAL SETTLEMENT IS NOT EXCLUDED BY A PARK THAT CAN NEVER
 -- BEGIN (2026-09-28). A park the balancer requested and never began (no
 -- manifest, admission, member, attempt, close, cleanup or abort) keeps
 -- excluding every ordinary writer while its event runs: that is the window
 -- between request and begin this guard exists for. The one writer it must
 -- not exclude is the event's own terminal settlement, which holds the finish
 -- lane and this event's seat-exit authority: the event leaves RUNNING in the
 -- same transaction, so the park can never begin and nothing it protects can
 -- be raced. bfcfaf17 sat decided for ten days behind exactly that.
 bound:=EXISTS(SELECT 1 FROM smarter_private.f06_operations o WHERE o.source_table_id IN(src,dst) AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')
  AND NOT (o.state='park_requested' AND o.tournament_id=t AND o.manifest IS NULL
   AND o.close_receipt IS NULL AND o.cleanup_kind IS NULL AND o.abort_receipt_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions ma WHERE ma.break_id=o.break_id)
   AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id)
   AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id)
   AND current_setting('app.tournament_seat_exit_operation',true)='terminal_finish'
   AND EXISTS(SELECT 1 FROM public.tournament_seat_exit_authorizations x
    WHERE x.tournament_id=t AND x.operation='terminal_finish'
     AND x.token::text=current_setting('app.tournament_seat_exit_token',true))));
 IF NOT bound THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;

 -- A validated elimination is neither a hand dispatch nor a seat move. The
 -- private core authorizes exactly one row image immediately before its CAS;
 -- this BEFORE trigger consumes it, so later writes cannot reuse it. Existing
 -- lane acquisition above still serializes the source/manifest transition.
 IF TG_OP='UPDATE' AND src=dst AND oldj->>'user_id'=newj->>'user_id'
 AND ((TG_TABLE_NAME='tournament_players' AND oldj->>'status'='playing'
       AND newj->>'status'='eliminated' AND oldj->'chips'='0'::jsonb
       AND newj->'chips'='0'::jsonb)
   OR (TG_TABLE_NAME='table_seats' AND oldj->>'left_at' IS NULL
       AND newj->>'left_at' IS NOT NULL AND oldj->'stack'='0'::jsonb
       AND newj->'stack'='0'::jsonb))
 AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o
   WHERE o.source_table_id=src
     AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')
     AND (o.state<>'park_requested' OR o.manifest IS NOT NULL
       OR EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions ma WHERE ma.break_id=o.break_id)
       OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL
       OR to_jsonb(o)->>'abort_receipt_id' IS NOT NULL
       OR EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id)
       OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id))) THEN
   DELETE FROM smarter_private.f06_elimination_dispatch d
   USING public.tournament_knockout_candidates c
   WHERE d.xid=txid_current() AND d.relation_name=TG_TABLE_NAME
     AND d.row_id=(oldj->>'id')::uuid AND d.candidate_id=c.id
     AND d.old_record=oldj AND d.new_record=newj
     AND c.tournament_id=t AND c.table_id=src AND c.eliminated_user_id=u
     AND c.state='pending' AND c.stack_after=0
     AND (TG_TABLE_NAME='tournament_players' AND oldj->>'tournament_id'=t::text
       OR TG_TABLE_NAME='table_seats' AND c.seat_id=(oldj->>'id')::uuid
         AND c.seat_joined_at=(oldj->>'joined_at')::timestamptz);
   IF FOUND THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='table_seats' THEN
 -- Existing accepted final-hand stack updates can drain PARK_REQUESTED. Once
 -- BEGUN, only the one guarded move may vacate/change original custody.
 IF TG_OP='UPDATE' AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
 AND (src,oldj->>'user_id',oldj->>'seat_number') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number') THEN
 RETURN NEW; END IF;
 ELSE
 IF TG_OP='UPDATE' AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status') THEN RETURN NEW; END IF;
 END IF;
 moving:=EXISTS(SELECT 1 FROM smarter_private.f06_dispatch d JOIN smarter_private.f06_attempts a USING(request_id)
 JOIN smarter_private.f06_operations o ON o.break_id=a.break_id WHERE d.xid=txid_current() AND a.user_id=u AND o.source_table_id=src
 AND (TG_TABLE_NAME='table_seats' AND TG_OP='UPDATE' AND src=dst AND newj->>'left_at' IS NOT NULL
 OR TG_TABLE_NAME='tournament_players' AND TG_OP='UPDATE' AND dst=a.destination_table_id AND (newj->>'seat_number')::integer=a.destination_seat_number));
 IF NOT moving AND EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch d JOIN smarter_private.f06_hand_permits h USING(permit_id) JOIN smarter_private.f06_operations o ON o.source_table_id=h.table_id WHERE d.xid=txid_current() AND h.table_id=src AND o.state='park_requested') THEN moving:=true; END IF;
 IF NOT moving THEN RAISE EXCEPTION 'F06_SOURCE_EXCLUDED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION smarter_private.f06_source_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_source_guard() FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.f06_source_guard()

-- @@DOOR smarter_private.f06_table_guard()
-- @@PIN md5=d8775467cf3f807b1992be752638d308 len=1456 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.f06_table_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE blocked boolean; reopening boolean;
BEGIN
 IF TG_OP='INSERT' THEN NEW.f06_lifecycle:=nextval('smarter_private.f06_lifecycle_seq');RETURN NEW; END IF;
 PERFORM smarter_private.f06_try_lane(OLD.tournament_id);
 SELECT EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=OLD.id AND state NOT IN ('acknowledged','withdrawn_before_manifest')) INTO blocked;
 IF TG_OP='DELETE' THEN
 IF blocked THEN RAISE EXCEPTION 'F06_PENDING_CUSTODY' USING ERRCODE='55000'; END IF; RETURN OLD; END IF;
 reopening:=(lower(COALESCE(OLD.status,'')) IN ('closed','completed','cancelled','finished') OR OLD.lifecycle='closed' OR COALESCE(OLD.is_deleted,false))
 AND NOT (lower(COALESCE(NEW.status,'')) IN ('closed','completed','cancelled','finished') OR NEW.lifecycle='closed' OR COALESCE(NEW.is_deleted,false));
 IF NEW.f06_lifecycle IS DISTINCT FROM OLD.f06_lifecycle THEN RAISE EXCEPTION 'F06_LIFECYCLE_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF blocked AND (reopening OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tournament_id IS DISTINCT FROM OLD.tournament_id) THEN
 RAISE EXCEPTION 'F06_PENDING_CUSTODY' USING ERRCODE='55000'; END IF;
 IF reopening THEN NEW.f06_lifecycle:=nextval('smarter_private.f06_lifecycle_seq'); END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION smarter_private.f06_table_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_table_guard() FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.f06_table_guard()

-- @@DOOR smarter_private.f06_try_lane(t uuid)
-- @@PIN md5=78a3a191b9991b0a3a343db39de335aa len=469 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.f06_try_lane(t uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
 IF t IS NOT NULL AND (NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
 OR NOT pg_try_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0))) THEN
 RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001'; END IF;
END $function$;
ALTER FUNCTION smarter_private.f06_try_lane(t uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_try_lane(t uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.f06_try_lane(t uuid)

-- @@DOOR smarter_private.hand_submission_immutable()
-- @@PIN md5=a22d5bdb6d4400dcf911e1bd28e3b354 len=259 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.hand_submission_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN RAISE EXCEPTION 'HAND_SUBMISSION_IMMUTABLE' USING ERRCODE='55000'; END
$function$;
ALTER FUNCTION smarter_private.hand_submission_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.hand_submission_immutable() FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.hand_submission_immutable()

-- @@DOOR smarter_private.spin_archived_first_immutable()
-- @@PIN md5=a7a5d0d41cccfcee42e05b35eaf9f25d len=253 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.spin_archived_first_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN RAISE EXCEPTION 'ARCHIVED_SPIN_ADMISSION_IMMUTABLE' USING ERRCODE='55000'; END $function$;
ALTER FUNCTION smarter_private.spin_archived_first_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.spin_archived_first_immutable() FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.spin_archived_first_immutable()

-- @@DOOR smarter_private.spin_archived_first_manifest()
-- @@PIN md5=8e1e270ca5dadbb043eda951df97ab53 len=39946 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.spin_archived_first_manifest()
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
 SELECT $original${"evidence_kind":"archived_database_projection","source_sha256":"8a0eb326f88354ac1578729c5286615cfb1b7311c30e410c26e7f6ffb08aa3f5","tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","board_observed_at":"2026-09-15 04:32:06.7117+00","history_observed_at":"2026-09-15 04:33:53.557373+00","result_observed_at":"2026-09-15 04:35:19.921753+00","original_board":{"id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","name":"100 Chip Spin PLO4","status":"REGISTERING","club_id":"fade0000-0000-0000-0000-000000000001","variant":"spin","ended_at":null,"union_id":"fade0000-0000-0000-0000-000000000001","created_at":"2026-09-08T14:31:23.973275+00:00","prize_pool":200,"started_at":null,"total_rake":0,"updated_at":"2026-09-08T14:31:23.973275+00:00","max_players":3,"buy_in_amount":100,"spin_reveal_at":"2026-09-08T14:45:15.91+00:00","starting_chips":300,"current_players":1,"spin_multiplier":2,"prize_pool_finalized":true},"original_roster":[{"id":"06377b59-94e6-4663-9fc0-5dba12675b9d","chips":900,"prize":0,"status":"playing","user_id":"aef849b8-2906-4dc0-b108-251710e76d3c","position":null,"table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","chip_count":0,"seat_number":1,"eliminated_at":null,"registered_at":"2026-09-08T14:44:51.55749+00:00","tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","terminal_closed_at":null},{"id":"1350d845-cdf8-41ad-86bf-abf2f2460cab","chips":0,"prize":0,"status":"eliminated","user_id":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","position":3,"table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","chip_count":0,"seat_number":2,"eliminated_at":"2026-09-08T14:50:41.689+00:00","registered_at":"2026-09-08T14:44:51.55749+00:00","tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","terminal_closed_at":null},{"id":"bcab2749-47c7-4617-9d72-9e56de4eb616","chips":0,"prize":0,"status":"eliminated","user_id":"036f0b55-c601-4d09-982a-5294cf4ea15d","position":2,"table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","chip_count":0,"seat_number":3,"eliminated_at":"2026-09-08T14:50:47.159+00:00","registered_at":"2026-09-08T14:45:08.753219+00:00","tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","terminal_closed_at":null}],"original_first_history":{"id":"ff938472-99cc-41fc-9092-9b08c116e8d3","source":"manual","ended_at":"2026-09-08T14:48:55.295+00:00","pot_size":20,"table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","created_at":"2026-09-08T14:48:56.020255+00:00","started_at":"2026-09-08T14:48:50.491+00:00","hand_number":8217978,"rake_amount":0,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533"},"original_last_history":{"id":"865f8f8b-57e9-4d4e-911b-5ea51a25b745","source":"manual","ended_at":"2026-09-08T14:50:26.175+00:00","pot_size":850,"table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","created_at":"2026-09-08T14:50:26.846305+00:00","started_at":"2026-09-08T14:49:44.223+00:00","hand_number":8218417,"rake_amount":0,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533"},"original_result":{"id":"865f8f8b-57e9-4d4e-911b-5ea51a25b745","source":"manual","players":[{"seat":1,"cards":[],"stack":900,"userId":"aef849b8-2906-4dc0-b108-251710e76d3c","username":"ShoveBandito"},{"seat":2,"cards":[],"stack":0,"userId":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","username":"AceSniper"},{"seat":3,"cards":[],"stack":0,"userId":"036f0b55-c601-4d09-982a-5294cf4ea15d","username":"RiverJester"}],"summary":null,"winners":[{"hand":{"name":"Straight","cards":[{"rank":"A","suit":"hearts"},{"rank":"K","suit":"spades"},{"rank":"Q","suit":"hearts"},{"rank":"J","suit":"clubs"},{"rank":"T","suit":"clubs"}],"ranking":5},"amount":850,"userId":"aef849b8-2906-4dc0-b108-251710e76d3c","potIndex":0}]},"original_atomic_commit":null,"captured_preimage":{"tournaments":[{"id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","name":"100 Chip Spin PLO4","is_pko":false,"status":"REGISTERING","club_id":"fade0000-0000-0000-0000-000000000001","is_xmtt":false,"variant":"spin","ban_chat":false,"ended_at":null,"free_buy":false,"is_rebuy":false,"is_turbo":false,"on_break":false,"union_id":"fade0000-0000-0000-0000-000000000001","game_type":"PLO4","is_bounty":false,"is_pinned":false,"spin_type":"standard","addon_cost":0,"buy_in_fee":0,"created_at":"2026-09-08T14:31:23.973275+00:00","day_number":1,"is_private":false,"is_reentry":false,"max_rebuys":0,"prize_pool":200,"rebuy_cost":0,"start_time":"2026-09-08T14:48:48.55749+00:00","started_at":null,"table_size":3,"total_days":1,"total_rake":0,"updated_at":"2026-09-08T14:31:23.973275+00:00","addon_chips":0,"blind_speed":"standard","bounty_pool":0,"description":null,"is_vip_only":false,"max_players":3,"min_players":3,"rebuy_chips":0,"schedule_id":null,"addon_levels":1,"is_multi_day":false,"label_as_new":false,"rebuy_levels":4,"bounty_amount":0,"break_ends_at":null,"buy_in_amount":100,"current_level":2,"flight_number":null,"late_reg_mins":0,"max_reentries":0,"all_in_or_fold":false,"big_blind_ante":false,"hide_club_name":false,"payout_percent":10,"spin_reveal_at":"2026-09-08T14:45:15.91+00:00","starting_chips":300,"accelerated_mtt":false,"blind_structure":"[{\"level\":1,\"smallBlind\":10,\"bigBlind\":20,\"ante\":0,\"duration\":180},{\"level\":2,\"smallBlind\":15,\"bigBlind\":30,\"ante\":0,\"duration\":180},{\"level\":3,\"smallBlind\":20,\"bigBlind\":40,\"ante\":0,\"duration\":180},{\"level\":4,\"smallBlind\":30,\"bigBlind\":60,\"ante\":0,\"duration\":180},{\"level\":5,\"smallBlind\":40,\"bigBlind\":80,\"ante\":0,\"duration\":180},{\"level\":6,\"smallBlind\":50,\"bigBlind\":100,\"ante\":0,\"duration\":180},{\"level\":7,\"smallBlind\":60,\"bigBlind\":120,\"ante\":0,\"duration\":180},{\"level\":8,\"smallBlind\":75,\"bigBlind\":150,\"ante\":0,\"duration\":180},{\"level\":9,\"smallBlind\":90,\"bigBlind\":180,\"ante\":0,\"duration\":180},{\"level\":10,\"smallBlind\":105,\"bigBlind\":210,\"ante\":0,\"duration\":180},{\"level\":11,\"smallBlind\":145,\"bigBlind\":290,\"ante\":0,\"duration\":180},{\"level\":12,\"smallBlind\":205,\"bigBlind\":410,\"ante\":0,\"duration\":180}]","current_players":1,"format_contract":"spin-v1","is_premium_spin":false,"late_reg_levels":0,"satellite_seats":null,"spin_multiplier":2,"tournament_type":"SPIN","add_on_available":false,"addon_from_start":false,"bounty_pool_paid":0,"break_started_at":null,"early_bird_chips":0,"guaranteed_prize":0,"level_started_at":"2026-09-08T14:54:54.19+00:00","payout_structure":"[{\"place\":1,\"percentage\":100}]","satellite_target":null,"allow_rabbit_hunt":true,"blind_level_state":null,"bubble_protection":false,"is_mystery_bounty":false,"payout_unit_cents":1,"restart_source_id":null,"short_description":null,"spin_locked_tiers":[],"early_bird_enabled":false,"mystery_bounty_max":0,"mystery_bounty_min":0,"spin_reveal_lag_ms":6157,"action_time_seconds":15,"addon_break_minutes":1,"payout_math_version":1,"satellite_target_id":null,"synchronized_breaks":false,"addon_period_ends_at":null,"mystery_bounty_stage":"pending","parent_tournament_id":null,"prize_pool_finalized":true,"survivors_advance_to":null,"entry_contract_locked":true,"final_table_triggered":true,"restart_every_minutes":null,"addon_period_triggered":false,"authorized_to_register":false,"mystery_bounty_profile":"classic","addon_period_started_at":null,"final_table_deal_enabled":false,"flight_end_chips_snapshot":null,"mystery_bounty_activation":"at_the_money","mystery_bounty_pool_cents":null,"mystery_bounty_top_percent":20,"mystery_bounty_activated_at":null,"mystery_bounty_pool_percent":50,"mystery_bounty_activation_value":null,"mystery_bounty_activated_players":null,"mystery_bounty_regular_pool_percent":50,"mystery_bounty_activation_generation":0}],"tournament_players":[{"id":"06377b59-94e6-4663-9fc0-5dba12675b9d","chips":900,"prize":0,"add_on":false,"rebuys":0,"status":"playing","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","user_id":"aef849b8-2906-4dc0-b108-251710e76d3c","position":null,"table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","chip_count":0,"seat_number":1,"push_2m_sent":true,"eliminated_at":null,"push_15m_sent":true,"registered_at":"2026-09-08T14:44:51.55749+00:00","tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"rebuy_prompt_until":null,"terminal_closed_at":null,"source_satellite_id":null,"elimination_sequence":null,"mystery_bounty_value":0,"is_satellite_qualifier":false},{"id":"1350d845-cdf8-41ad-86bf-abf2f2460cab","chips":0,"prize":0,"add_on":false,"rebuys":0,"status":"eliminated","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","user_id":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","position":3,"table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","chip_count":0,"seat_number":2,"push_2m_sent":true,"eliminated_at":"2026-09-08T14:50:41.689+00:00","push_15m_sent":true,"registered_at":"2026-09-08T14:44:51.55749+00:00","tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"rebuy_prompt_until":null,"terminal_closed_at":null,"source_satellite_id":null,"elimination_sequence":null,"mystery_bounty_value":0,"is_satellite_qualifier":false},{"id":"bcab2749-47c7-4617-9d72-9e56de4eb616","chips":0,"prize":0,"add_on":false,"rebuys":0,"status":"eliminated","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","user_id":"036f0b55-c601-4d09-982a-5294cf4ea15d","position":2,"table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","chip_count":0,"seat_number":3,"push_2m_sent":true,"eliminated_at":"2026-09-08T14:50:47.159+00:00","push_15m_sent":true,"registered_at":"2026-09-08T14:45:08.753219+00:00","tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"rebuy_prompt_until":null,"terminal_closed_at":null,"source_satellite_id":null,"elimination_sequence":null,"mystery_bounty_value":0,"is_satellite_qualifier":false}],"tables":[{"id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","ante":0,"name":"100 Chip Spin PLO4","role":null,"cap_bb":null,"stakes":"20/40","status":"running","ante_bb":0,"avg_pot":0,"club_id":"fade0000-0000-0000-0000-000000000001","live_at":null,"ban_chat":false,"is_spins":false,"nit_game":false,"settings":{},"union_id":"fade0000-0000-0000-0000-000000000001","auto_muck":true,"big_blind":40,"game_mode":"regular","game_type":"tournament","kill_mode":"off","ko_bounty":false,"lifecycle":null,"max_buyin":null,"min_buyin":null,"opened_at":null,"cluster_id":null,"created_at":"2026-09-08T14:31:24.359315+00:00","created_by":null,"deleted_at":null,"deleted_by":null,"is_deleted":false,"is_private":false,"live_state":null,"main_index":null,"max_buy_in":0,"min_buy_in":0,"no_rathole":false,"sng_buy_in":0,"start_time":null,"updated_at":"2026-09-09T17:25:29.616789+00:00","bbj_percent":100,"cap_enabled":false,"hands_dealt":0,"is_featured":false,"is_template":false,"is_vip_only":false,"max_players":3,"rake_cap_bb":-1,"run_it_mode":"none","small_blind":20,"ante_enabled":false,"auto_restart":false,"double_board":false,"game_variant":"plo4","is_anonymous":false,"label_as_new":false,"rake_percent":-1,"run_it_twice":true,"triple_board":false,"custom_add_on":false,"f06_lifecycle":199835,"max_buy_in_bb":null,"max_straddles":1,"min_buy_in_bb":null,"multi_day_mtt":false,"straddle_type":"utg","tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","all_in_or_fold":false,"allow_straddle":true,"auto_extension":false,"big_blind_ante":false,"gtd_prize_pool":false,"hide_club_name":false,"ip_restriction":false,"maintain_hands":10,"starting_chips":1500,"accelerated_mtt":false,"blind_structure":"standard","current_players":1,"enable_straddle":true,"gps_restriction":true,"max_players_mtt":300,"min_players_mtt":30,"promote_pending":false,"restrict_device":true,"save_start_time":false,"seat_game_scope":"table:6eaddeaf-1511-4265-bb38-37811ae82ad9","bomb_pot_enabled":false,"bomb_pot_variant":null,"break_started_at":null,"calltime_enabled":false,"final_table_deal":false,"payout_structure":"winner_takes_all","pineapple_holdem":false,"sng_player_count":9,"spins_multiplier":null,"straddle_enabled":false,"add_on_multiplier":1,"allow_rabbit_hunt":true,"auto_create_table":false,"auto_muck_enabled":true,"auto_utg_straddle":false,"blinds_up_minutes":10,"bubble_protection":false,"dealing_halted_at":null,"first_button_seat":2,"game_length_hours":12,"insurance_enabled":false,"kill_threshold_bb":10,"short_description":"","show_hand_enabled":true,"sng_custom_buy_in":false,"time_bank_enabled":true,"allow_run_it_twice":true,"auto_start_players":2,"bomb_pot_frequency":0,"career_percent_min":0,"restrict_observers":false,"seat_admission_key":"tournament:2aa4cba1-506f-426b-a1ba-d8e22e018533","seven_deuce_amount":2,"terminal_closed_at":null,"time_bank_max_uses":4,"voluntary_straddle":false,"wait_for_big_blind":true,"action_time_seconds":15,"bomb_pot_ante_fixed":null,"featured_tournament":false,"next_step_satellite":false,"observer_show_cards":false,"seven_deuce_enabled":false,"synchronized_breaks":true,"tournament_schedule":false,"agent_downline_limit":null,"bomb_pot_board_count":1,"bomb_pot_min_players":3,"bomb_pot_next_due_at":null,"bomb_pot_sched_state":null,"break_eligible_since":null,"buy_in_authorization":false,"maintain_percent_min":0,"run_it_twice_enabled":false,"bomb_pot_double_board":false,"bomb_pot_trigger_mode":"every_n_hands","dealing_halted_reason":null,"authorized_to_register":false,"big_blind_ante_enabled":false,"bomb_pot_button_policy":"regular","prefer_check_over_fold":true,"bomb_pot_manual_pending":false,"early_bird_registration":false,"late_registration_level":6,"pc_emulator_restriction":false,"bomb_pot_ante_multiplier":2,"dealing_halt_observed_at":null,"max_consecutive_timeouts":3,"restart_tournament_every":false,"bomb_pot_announce_seconds":null,"bomb_pot_interval_seconds":null,"custom_rebuy_reentry_cost":false,"disconnect_timeout_seconds":30,"number_of_rebuys_reentries":3,"add_on_break_length_minutes":1,"photo_rotation_verification":false}],"table_seats":[{"id":"3eaf38cc-08d0-4b7b-be7e-af3be36c1617","stack":0,"status":"active","club_id":"a0000000-0000-0000-0000-000000000001","is_away":false,"left_at":"2026-09-08T14:50:31.239+00:00","user_id":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","horse_id":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","joined_at":"2026-09-08T14:44:51.55749+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":2,"occupancy_id":"b449271a-faa6-41c0-bc10-a340562fd884","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"8b786212-a6e2-4fb2-934f-45cfdb2bb5f5","stack":0,"status":"active","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","is_away":false,"left_at":"2026-09-08T14:50:31.239+00:00","user_id":"036f0b55-c601-4d09-982a-5294cf4ea15d","horse_id":"036f0b55-c601-4d09-982a-5294cf4ea15d","table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","joined_at":"2026-09-08T14:45:08.753219+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":3,"occupancy_id":"dac26e3c-ec74-4c6a-abef-038249fae1a1","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"fd0e0c3a-1efa-4262-8122-4c05e328f9ac","stack":900,"status":"active","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","is_away":false,"left_at":null,"user_id":"aef849b8-2906-4dc0-b108-251710e76d3c","horse_id":"aef849b8-2906-4dc0-b108-251710e76d3c","table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","joined_at":"2026-09-08T14:44:51.55749+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":1,"occupancy_id":"fd840a1b-e483-4b9c-99e7-bd4ddb672cb0","leave_pending":false,"is_sitting_out":false,"active_game_scope":"table:6eaddeaf-1511-4265-bb38-37811ae82ad9","active_parent_key":"tournament:2aa4cba1-506f-426b-a1ba-d8e22e018533","entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2}],"tournament_escrow":[{"fee_out":0,"enforced":true,"gross_in":300,"bounty_in":0,"closed_at":null,"opened_at":"2026-09-08T14:44:51.55749+00:00","prize_out":0,"bounty_out":0,"close_note":null,"overlay_in":0,"refund_fee":0,"reserve_in":200,"updated_at":"2026-09-08T14:45:16.289264+00:00","fee_balance":24,"opened_from":"shadow at first sight (tournament_buyin)","reserve_out":276,"refund_prize":0,"satellite_in":0,"prize_balance":200,"refund_bounty":0,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","bounty_balance":0,"fee_entries_in":24,"satellite_fee_in":0,"terminal_closed_at":null}],"spin_reserve_ledger":[{"id":"0936892f-9964-4428-8ea5-befc64ccf306","kind":"jackpot_draw","note":"prize pool","seats":3,"amount":-200,"buy_in":100,"club_id":"fade0000-0000-0000-0000-000000000001","created_at":"2026-09-08T14:45:16.289264+00:00","house_rake":24,"multiplier":2,"balance_after":51909,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","terminal_closed_at":null},{"id":"aebfeae5-8e2c-451e-b977-bbe26f50803c","kind":"contribution","note":"buy-ins less fixed rake, booked when the last seat was paid","seats":3,"amount":276,"buy_in":100,"club_id":"fade0000-0000-0000-0000-000000000001","created_at":"2026-09-08T14:45:08.753219+00:00","house_rake":24,"multiplier":null,"balance_after":52100.72,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","terminal_closed_at":null}],"tournament_refund_entitlements":[{"id":"36ef28d8-48fc-47bd-889f-16b21cb938f6","gross":100,"user_id":"036f0b55-c601-4d09-982a-5294cf4ea15d","created_at":"2026-09-08T14:45:08.753219+00:00","refund_fee":0,"refund_prize":100,"escrow_bucket":"wallet_gross","evidence_kind":"cutover_wallet_charge","refund_bounty":0,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","charge_category":"tournament_buyin","registration_id":null,"entitlement_kind":"wallet_charge","source_ledger_id":"5df62b73-4be1-4bfe-8f15-f6cce478e5f4","source_ticket_id":null,"source_award_place":null,"source_satellite_id":null,"refund_wallet_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4"},{"id":"c83d6065-8f24-4b3e-9c7f-1ff6a4057264","gross":100,"user_id":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","created_at":"2026-09-08T14:44:51.55749+00:00","refund_fee":0,"refund_prize":100,"escrow_bucket":"wallet_gross","evidence_kind":"cutover_wallet_charge","refund_bounty":0,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","charge_category":"tournament_buyin","registration_id":null,"entitlement_kind":"wallet_charge","source_ledger_id":"58f5eefc-524e-471f-9932-6ca026231d35","source_ticket_id":null,"source_award_place":null,"source_satellite_id":null,"refund_wallet_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4"},{"id":"daebecf0-d844-4719-a56e-f26498170897","gross":100,"user_id":"aef849b8-2906-4dc0-b108-251710e76d3c","created_at":"2026-09-08T14:44:51.55749+00:00","refund_fee":0,"refund_prize":100,"escrow_bucket":"wallet_gross","evidence_kind":"cutover_wallet_charge","refund_bounty":0,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","charge_category":"tournament_buyin","registration_id":null,"entitlement_kind":"wallet_charge","source_ledger_id":"3d0f2790-9314-40ba-8b52-32be054daea6","source_ticket_id":null,"source_award_place":null,"source_satellite_id":null,"refund_wallet_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4"}],"chip_ledger":[{"id":"1a26ffb6-6646-4c77-b831-ea470ea3c11a","notes":null,"amount":200,"status":"posted","club_id":"fade0000-0000-0000-0000-000000000001","db_role":"postgres","hand_id":null,"to_type":"prize_liability","category":"spin_prize","epoch_id":2,"metadata":null,"row_hash":"a21fd74a31786bc44a20acc0172c738312d0ec05238056887e35b463cda83520","table_id":null,"to_label":null,"union_id":null,"chain_seq":2706220,"from_type":"spin_reserve","prev_hash":"469e3d198a0528063f1b5d50c6f50d16fe5e402e5a43354e9906d142b9238cd7","created_at":"2026-09-08T14:45:16.289264+00:00","from_label":"spin_bonus_pools.balance","description":"auto-ledgered spin_bonus_pools.balance delta -200.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"2d968239-acdd-4a2c-99f2-a369ff37ae31","pre_to_balance":null,"idempotency_key":null,"post_to_balance":null,"pre_from_balance":52109,"post_from_balance":51909},{"id":"3d0f2790-9314-40ba-8b52-32be054daea6","notes":null,"amount":100,"status":"posted","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","db_role":"postgres","hand_id":null,"to_type":"prize_liability","category":"tournament_buyin","epoch_id":2,"metadata":null,"row_hash":"35f3b5dc39fc72f832b1a64642e7dc25cb2d7d13f9155f33499744cf04d3a1bc","table_id":null,"to_label":null,"union_id":null,"chain_seq":2706054,"from_type":"player_wallet","prev_hash":"abb08f780a9cc27aad0127bb38ab0b687a53e8cbb2388fbc5bf886ab19a292a0","created_at":"2026-09-08T14:44:51.55749+00:00","from_label":null,"description":"auto-audited club_members.chip_balance delta -100.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"aef849b8-2906-4dc0-b108-251710e76d3c","pre_to_balance":null,"idempotency_key":null,"post_to_balance":null,"pre_from_balance":null,"post_from_balance":null},{"id":"40b79d23-cb09-4b1f-bc11-00100c87b411","notes":null,"amount":276,"status":"posted","club_id":"fade0000-0000-0000-0000-000000000001","db_role":"postgres","hand_id":null,"to_type":"spin_reserve","category":"spin_entry","epoch_id":2,"metadata":null,"row_hash":"24f652ee019f1d1911fdd2664d1bd9a0dc4bd6d5a600987f45bf3427633ccca1","table_id":null,"to_label":"spin_bonus_pools.balance","union_id":null,"chain_seq":2706159,"from_type":"prize_liability","prev_hash":"016769c30fe7a3b46439ab77eb79646c4f62bfd1c117f4be027c81d552b57c7f","created_at":"2026-09-08T14:45:08.753219+00:00","from_label":null,"description":"auto-ledgered spin_bonus_pools.balance delta 276.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2d968239-acdd-4a2c-99f2-a369ff37ae31","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","pre_to_balance":51824.72,"idempotency_key":null,"post_to_balance":52100.72,"pre_from_balance":null,"post_from_balance":null},{"id":"58f5eefc-524e-471f-9932-6ca026231d35","notes":null,"amount":100,"status":"posted","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","db_role":"postgres","hand_id":null,"to_type":"prize_liability","category":"tournament_buyin","epoch_id":2,"metadata":null,"row_hash":"0a9f34f772c203e58eec16b8da7e0d4e1ff8ed1bd5e2890892e9c6b26be10ed7","table_id":null,"to_label":null,"union_id":null,"chain_seq":2706055,"from_type":"player_wallet","prev_hash":"35f3b5dc39fc72f832b1a64642e7dc25cb2d7d13f9155f33499744cf04d3a1bc","created_at":"2026-09-08T14:44:51.55749+00:00","from_label":null,"description":"auto-audited club_members.chip_balance delta -100.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","pre_to_balance":null,"idempotency_key":null,"post_to_balance":null,"pre_from_balance":null,"post_from_balance":null},{"id":"5df62b73-4be1-4bfe-8f15-f6cce478e5f4","notes":null,"amount":100,"status":"posted","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","db_role":"postgres","hand_id":null,"to_type":"prize_liability","category":"tournament_buyin","epoch_id":2,"metadata":null,"row_hash":"dff329f08f5c4a4e81a39984fb758dc89b384224559f60648e49a5c11daa8883","table_id":null,"to_label":null,"union_id":null,"chain_seq":2706154,"from_type":"player_wallet","prev_hash":null,"created_at":"2026-09-08T14:45:08.753219+00:00","from_label":null,"description":"auto-audited club_members.chip_balance delta -100.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"036f0b55-c601-4d09-982a-5294cf4ea15d","pre_to_balance":null,"idempotency_key":null,"post_to_balance":null,"pre_from_balance":null,"post_from_balance":null}]},"reviewed_fee_proof":{"fee":24,"gross":300,"reserve":{"draw":{"id":"0936892f-9964-4428-8ea5-befc64ccf306","kind":"jackpot_draw","note":"prize pool","seats":3,"amount":-200,"buy_in":100,"club_id":"fade0000-0000-0000-0000-000000000001","created_at":"2026-09-08T14:45:16.289264+00:00","house_rake":24,"multiplier":2,"balance_after":51909,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533"},"draw_ledger":{"id":"1a26ffb6-6646-4c77-b831-ea470ea3c11a","notes":null,"amount":200,"status":"posted","club_id":"fade0000-0000-0000-0000-000000000001","db_role":"postgres","hand_id":null,"to_type":"prize_liability","category":"spin_prize","epoch_id":2,"metadata":null,"row_hash":"a21fd74a31786bc44a20acc0172c738312d0ec05238056887e35b463cda83520","table_id":null,"to_label":null,"union_id":null,"chain_seq":2706220,"from_type":"spin_reserve","prev_hash":"469e3d198a0528063f1b5d50c6f50d16fe5e402e5a43354e9906d142b9238cd7","created_at":"2026-09-08T14:45:16.289264+00:00","from_label":"spin_bonus_pools.balance","description":"auto-ledgered spin_bonus_pools.balance delta -200.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"2d968239-acdd-4a2c-99f2-a369ff37ae31","pre_to_balance":null,"idempotency_key":null,"post_to_balance":null,"pre_from_balance":52109,"post_from_balance":51909},"contribution":{"id":"aebfeae5-8e2c-451e-b977-bbe26f50803c","kind":"contribution","note":"buy-ins less fixed rake, booked when the last seat was paid","seats":3,"amount":276,"buy_in":100,"club_id":"fade0000-0000-0000-0000-000000000001","created_at":"2026-09-08T14:45:08.753219+00:00","house_rake":24,"multiplier":null,"balance_after":52100.72,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533"},"contribution_ledger":{"id":"40b79d23-cb09-4b1f-bc11-00100c87b411","notes":null,"amount":276,"status":"posted","club_id":"fade0000-0000-0000-0000-000000000001","db_role":"postgres","hand_id":null,"to_type":"spin_reserve","category":"spin_entry","epoch_id":2,"metadata":null,"row_hash":"24f652ee019f1d1911fdd2664d1bd9a0dc4bd6d5a600987f45bf3427633ccca1","table_id":null,"to_label":"spin_bonus_pools.balance","union_id":null,"chain_seq":2706159,"from_type":"prize_liability","prev_hash":"016769c30fe7a3b46439ab77eb79646c4f62bfd1c117f4be027c81d552b57c7f","created_at":"2026-09-08T14:45:08.753219+00:00","from_label":null,"description":"auto-ledgered spin_bonus_pools.balance delta 276.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2d968239-acdd-4a2c-99f2-a369ff37ae31","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","pre_to_balance":51824.72,"idempotency_key":null,"post_to_balance":52100.72,"pre_from_balance":null,"post_from_balance":null}},"contributors":[{"ledger":{"id":"5df62b73-4be1-4bfe-8f15-f6cce478e5f4","notes":null,"amount":100,"status":"posted","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","db_role":"postgres","hand_id":null,"to_type":"prize_liability","category":"tournament_buyin","epoch_id":2,"metadata":null,"row_hash":"dff329f08f5c4a4e81a39984fb758dc89b384224559f60648e49a5c11daa8883","table_id":null,"to_label":null,"union_id":null,"chain_seq":2706154,"from_type":"player_wallet","prev_hash":null,"created_at":"2026-09-08T14:45:08.753219+00:00","from_label":null,"description":"auto-audited club_members.chip_balance delta -100.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"036f0b55-c601-4d09-982a-5294cf4ea15d","pre_to_balance":null,"idempotency_key":null,"post_to_balance":null,"pre_from_balance":null,"post_from_balance":null},"club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","player_id":"036f0b55-c601-4d09-982a-5294cf4ea15d","entitlement":{"id":"36ef28d8-48fc-47bd-889f-16b21cb938f6","gross":100,"user_id":"036f0b55-c601-4d09-982a-5294cf4ea15d","created_at":"2026-09-08T14:45:08.753219+00:00","refund_fee":0,"refund_prize":100,"escrow_bucket":"wallet_gross","evidence_kind":"cutover_wallet_charge","refund_bounty":0,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","charge_category":"tournament_buyin","registration_id":null,"entitlement_kind":"wallet_charge","source_ledger_id":"5df62b73-4be1-4bfe-8f15-f6cce478e5f4","source_ticket_id":null,"source_award_place":null,"source_satellite_id":null,"refund_wallet_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4"},"registered_at":"2026-09-08T14:45:08.753219+00:00","registration_id":"bcab2749-47c7-4617-9d72-9e56de4eb616"},{"ledger":{"id":"58f5eefc-524e-471f-9932-6ca026231d35","notes":null,"amount":100,"status":"posted","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","db_role":"postgres","hand_id":null,"to_type":"prize_liability","category":"tournament_buyin","epoch_id":2,"metadata":null,"row_hash":"0a9f34f772c203e58eec16b8da7e0d4e1ff8ed1bd5e2890892e9c6b26be10ed7","table_id":null,"to_label":null,"union_id":null,"chain_seq":2706055,"from_type":"player_wallet","prev_hash":"35f3b5dc39fc72f832b1a64642e7dc25cb2d7d13f9155f33499744cf04d3a1bc","created_at":"2026-09-08T14:44:51.55749+00:00","from_label":null,"description":"auto-audited club_members.chip_balance delta -100.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","pre_to_balance":null,"idempotency_key":null,"post_to_balance":null,"pre_from_balance":null,"post_from_balance":null},"club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","player_id":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","entitlement":{"id":"c83d6065-8f24-4b3e-9c7f-1ff6a4057264","gross":100,"user_id":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","created_at":"2026-09-08T14:44:51.55749+00:00","refund_fee":0,"refund_prize":100,"escrow_bucket":"wallet_gross","evidence_kind":"cutover_wallet_charge","refund_bounty":0,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","charge_category":"tournament_buyin","registration_id":null,"entitlement_kind":"wallet_charge","source_ledger_id":"58f5eefc-524e-471f-9932-6ca026231d35","source_ticket_id":null,"source_award_place":null,"source_satellite_id":null,"refund_wallet_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4"},"registered_at":"2026-09-08T14:44:51.55749+00:00","registration_id":"1350d845-cdf8-41ad-86bf-abf2f2460cab"},{"ledger":{"id":"3d0f2790-9314-40ba-8b52-32be054daea6","notes":null,"amount":100,"status":"posted","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","db_role":"postgres","hand_id":null,"to_type":"prize_liability","category":"tournament_buyin","epoch_id":2,"metadata":null,"row_hash":"35f3b5dc39fc72f832b1a64642e7dc25cb2d7d13f9155f33499744cf04d3a1bc","table_id":null,"to_label":null,"union_id":null,"chain_seq":2706054,"from_type":"player_wallet","prev_hash":"abb08f780a9cc27aad0127bb38ab0b687a53e8cbb2388fbc5bf886ab19a292a0","created_at":"2026-09-08T14:44:51.55749+00:00","from_label":null,"description":"auto-audited club_members.chip_balance delta -100.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"aef849b8-2906-4dc0-b108-251710e76d3c","pre_to_balance":null,"idempotency_key":null,"post_to_balance":null,"pre_from_balance":null,"post_from_balance":null},"club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","player_id":"aef849b8-2906-4dc0-b108-251710e76d3c","entitlement":{"id":"daebecf0-d844-4719-a56e-f26498170897","gross":100,"user_id":"aef849b8-2906-4dc0-b108-251710e76d3c","created_at":"2026-09-08T14:44:51.55749+00:00","refund_fee":0,"refund_prize":100,"escrow_bucket":"wallet_gross","evidence_kind":"cutover_wallet_charge","refund_bounty":0,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","charge_category":"tournament_buyin","registration_id":null,"entitlement_kind":"wallet_charge","source_ledger_id":"3d0f2790-9314-40ba-8b52-32be054daea6","source_ticket_id":null,"source_award_place":null,"source_satellite_id":null,"refund_wallet_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4"},"registered_at":"2026-09-08T14:44:51.55749+00:00","registration_id":"06377b59-94e6-4663-9fc0-5dba12675b9d"}],"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","scope_versions":[{"id":485637,"club_id":"fade0000-0000-0000-0000-000000000001","game_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","version":1,"contract":{"id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","name":"100 Chip Spin PLO4","is_pko":false,"club_id":"fade0000-0000-0000-0000-000000000001","is_xmtt":false,"variant":"spin","ban_chat":false,"free_buy":false,"is_rebuy":false,"union_id":"fade0000-0000-0000-0000-000000000001","game_type":"PLO4","is_bounty":false,"is_pinned":false,"spin_type":"standard","addon_cost":0,"buy_in_fee":0,"is_private":false,"is_reentry":false,"max_rebuys":0,"rebuy_cost":0,"start_time":"2026-09-08T14:33:05.409+00:00","table_size":3,"total_days":1,"addon_chips":0,"is_vip_only":false,"max_players":3,"min_players":3,"rebuy_chips":0,"addon_levels":1,"is_multi_day":false,"label_as_new":false,"rebuy_levels":4,"bounty_amount":0,"buy_in_amount":100,"late_reg_mins":0,"max_reentries":0,"all_in_or_fold":false,"big_blind_ante":false,"hide_club_name":false,"payout_percent":10,"starting_chips":300,"accelerated_mtt":false,"blind_structure":"[{\"level\":1,\"smallBlind\":10,\"bigBlind\":20,\"ante\":0,\"duration\":180},{\"level\":2,\"smallBlind\":15,\"bigBlind\":30,\"ante\":0,\"duration\":180},{\"level\":3,\"smallBlind\":20,\"bigBlind\":40,\"ante\":0,\"duration\":180},{\"level\":4,\"smallBlind\":30,\"bigBlind\":60,\"ante\":0,\"duration\":180},{\"level\":5,\"smallBlind\":40,\"bigBlind\":80,\"ante\":0,\"duration\":180},{\"level\":6,\"smallBlind\":50,\"bigBlind\":100,\"ante\":0,\"duration\":180},{\"level\":7,\"smallBlind\":60,\"bigBlind\":120,\"ante\":0,\"duration\":180},{\"level\":8,\"smallBlind\":75,\"bigBlind\":150,\"ante\":0,\"duration\":180},{\"level\":9,\"smallBlind\":90,\"bigBlind\":180,\"ante\":0,\"duration\":180},{\"level\":10,\"smallBlind\":105,\"bigBlind\":210,\"ante\":0,\"duration\":180},{\"level\":11,\"smallBlind\":145,\"bigBlind\":290,\"ante\":0,\"duration\":180},{\"level\":12,\"smallBlind\":205,\"bigBlind\":410,\"ante\":0,\"duration\":180}]","late_reg_levels":0,"tournament_type":"SPIN","add_on_available":false,"addon_from_start":false,"early_bird_chips":0,"guaranteed_prize":0,"payout_structure":"[{\"place\":1,\"percentage\":100}]","bubble_protection":false,"is_mystery_bounty":false,"early_bird_enabled":false,"mystery_bounty_max":0,"mystery_bounty_min":0,"action_time_seconds":15,"addon_break_minutes":1,"synchronized_breaks":false,"authorized_to_register":false,"mystery_bounty_profile":"classic","final_table_deal_enabled":false,"mystery_bounty_activation":"at_the_money","mystery_bounty_top_percent":20,"mystery_bounty_pool_percent":50,"mystery_bounty_regular_pool_percent":50},"union_id":"fade0000-0000-0000-0000-000000000001","game_kind":"tournament","published_at":"2026-09-08T14:31:23.973275+00:00","published_by":null,"change_reason":"created","contract_hash":"f1b99b281968b29da5fa95b9ad7a0d306eb831dc57a400fb406ab94910e57370"},{"id":485859,"club_id":"fade0000-0000-0000-0000-000000000001","game_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","version":2,"contract":{"id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","name":"100 Chip Spin PLO4","is_pko":false,"club_id":"fade0000-0000-0000-0000-000000000001","is_xmtt":false,"variant":"spin","ban_chat":false,"free_buy":false,"is_rebuy":false,"union_id":"fade0000-0000-0000-0000-000000000001","game_type":"PLO4","is_bounty":false,"is_pinned":false,"spin_type":"standard","addon_cost":0,"buy_in_fee":0,"is_private":false,"is_reentry":false,"max_rebuys":0,"rebuy_cost":0,"start_time":"2026-09-08T14:48:48.55749+00:00","table_size":3,"total_days":1,"addon_chips":0,"is_vip_only":false,"max_players":3,"min_players":3,"rebuy_chips":0,"addon_levels":1,"is_multi_day":false,"label_as_new":false,"rebuy_levels":4,"bounty_amount":0,"buy_in_amount":100,"late_reg_mins":0,"max_reentries":0,"all_in_or_fold":false,"big_blind_ante":false,"hide_club_name":false,"payout_percent":10,"starting_chips":300,"accelerated_mtt":false,"blind_structure":"[{\"level\":1,\"smallBlind\":10,\"bigBlind\":20,\"ante\":0,\"duration\":180},{\"level\":2,\"smallBlind\":15,\"bigBlind\":30,\"ante\":0,\"duration\":180},{\"level\":3,\"smallBlind\":20,\"bigBlind\":40,\"ante\":0,\"duration\":180},{\"level\":4,\"smallBlind\":30,\"bigBlind\":60,\"ante\":0,\"duration\":180},{\"level\":5,\"smallBlind\":40,\"bigBlind\":80,\"ante\":0,\"duration\":180},{\"level\":6,\"smallBlind\":50,\"bigBlind\":100,\"ante\":0,\"duration\":180},{\"level\":7,\"smallBlind\":60,\"bigBlind\":120,\"ante\":0,\"duration\":180},{\"level\":8,\"smallBlind\":75,\"bigBlind\":150,\"ante\":0,\"duration\":180},{\"level\":9,\"smallBlind\":90,\"bigBlind\":180,\"ante\":0,\"duration\":180},{\"level\":10,\"smallBlind\":105,\"bigBlind\":210,\"ante\":0,\"duration\":180},{\"level\":11,\"smallBlind\":145,\"bigBlind\":290,\"ante\":0,\"duration\":180},{\"level\":12,\"smallBlind\":205,\"bigBlind\":410,\"ante\":0,\"duration\":180}]","late_reg_levels":0,"tournament_type":"SPIN","add_on_available":false,"addon_from_start":false,"early_bird_chips":0,"guaranteed_prize":0,"payout_structure":"[{\"place\":1,\"percentage\":100}]","bubble_protection":false,"is_mystery_bounty":false,"early_bird_enabled":false,"mystery_bounty_max":0,"mystery_bounty_min":0,"action_time_seconds":15,"addon_break_minutes":1,"synchronized_breaks":false,"authorized_to_register":false,"mystery_bounty_profile":"classic","final_table_deal_enabled":false,"mystery_bounty_activation":"at_the_money","mystery_bounty_top_percent":20,"mystery_bounty_pool_percent":50,"mystery_bounty_regular_pool_percent":50},"union_id":"fade0000-0000-0000-0000-000000000001","game_kind":"tournament","published_at":"2026-09-08T14:44:51.55749+00:00","published_by":null,"change_reason":"system_revision","contract_hash":"7c7e42911728c912f78129e3dedc9aef24ba0730fdfc5bb79b269f0782d531ae"}],"raw_source_count":1,"source_fingerprint":"bfb56dac635bc7a238383d785ea88f35","recognized_contributors":3},"fee_proof_observed_at":"2026-09-26 14:29:18.62487+00","fee_proof_capture_sha256":"a36d0be735a1d931c343351722c4a1163621402591585b1ca1fd7f7551d245f6"}$original$::jsonb;
$function$;
ALTER FUNCTION smarter_private.spin_archived_first_manifest() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.spin_archived_first_manifest() FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.spin_archived_first_manifest()

-- @@DOOR smarter_private.spin_archived_first_requires_terminal()
-- @@PIN md5=a3029d9daf225a881112d8c42105c8b8 len=746 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.spin_archived_first_requires_terminal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE cash jsonb;
BEGIN
 SELECT cash_receipt INTO cash FROM public.tournament_terminal_settlements WHERE tournament_id=NEW.tournament_id;
 IF cash IS NULL OR cash->'original_standings' IS DISTINCT FROM smarter_private.spin_archived_first_standings(
  NEW.tournament_id,'aef849b8-2906-4dc0-b108-251710e76d3c')
 OR NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=NEW.tournament_id AND status='COMPLETED') THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_ATOMIC_TERMINAL_REQUIRED' USING ERRCODE='P0404'; END IF;
 RETURN NULL;
END $function$;
ALTER FUNCTION smarter_private.spin_archived_first_requires_terminal() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.spin_archived_first_requires_terminal() FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.spin_archived_first_requires_terminal()

-- @@DOOR smarter_private.spin_archived_first_standings(p_tournament uuid, p_winner uuid)
-- @@PIN md5=268eb783e2ae723896acd222e80c57af len=3415 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.spin_archived_first_standings(p_tournament uuid, p_winner uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE admitted smarter_private.spin_archived_first_admission%ROWTYPE;
 original jsonb; original_player jsonb; actual_player jsonb; terminal_time timestamptz;
 original_busts jsonb; expected_prize numeric; player_count integer;
BEGIN
 SELECT * INTO admitted FROM smarter_private.spin_archived_first_admission WHERE tournament_id=p_tournament;
 IF NOT FOUND THEN RETURN NULL; END IF;
 original:=smarter_private.spin_archived_first_manifest();
 IF p_winner IS DISTINCT FROM 'aef849b8-2906-4dc0-b108-251710e76d3c'::uuid
 OR admitted.source_sha256 IS DISTINCT FROM original->>'source_sha256'
 OR (admitted.admitted_xid<>txid_current() AND NOT EXISTS(
  SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id=p_tournament)) THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_STANDINGS_IDENTITY' USING ERRCODE='P0404'; END IF;
 SELECT completed_at INTO terminal_time FROM public.tournament_terminal_settlements WHERE tournament_id=p_tournament;
 SELECT count(*) INTO player_count FROM public.tournament_players WHERE tournament_id=p_tournament;
 IF player_count<>3 THEN RAISE EXCEPTION 'ARCHIVED_SPIN_ROSTER_CHANGED' USING ERRCODE='40001'; END IF;
 expected_prize:=(original->'captured_preimage'->'tournaments'->0->>'prize_pool')::numeric;
 FOR original_player IN SELECT value FROM jsonb_array_elements(original->'captured_preimage'->'tournament_players') LOOP
  SELECT to_jsonb(p)-'username' INTO actual_player FROM public.tournament_players p
   WHERE p.tournament_id=p_tournament AND p.id=(original_player->>'id')::uuid;
  IF actual_player IS NULL OR (actual_player->>'terminal_closed_at')::timestamptz IS DISTINCT FROM terminal_time THEN
   RAISE EXCEPTION 'ARCHIVED_SPIN_ROSTER_CLOSURE_CHANGED' USING ERRCODE='40001'; END IF;
  IF original_player->>'user_id'=p_winner::text THEN
   IF (actual_player-ARRAY['status','position','prize','terminal_closed_at'])
       IS DISTINCT FROM (original_player-ARRAY['status','position','prize','terminal_closed_at'])
    OR actual_player->>'status' IS DISTINCT FROM 'winner'
    OR actual_player->'position' IS DISTINCT FROM '1'::jsonb
    OR actual_player->>'prize' IS NULL
    OR (actual_player->>'prize')::numeric NOT IN(0,expected_prize) THEN
    RAISE EXCEPTION 'ARCHIVED_SPIN_WINNER_CHANGED' USING ERRCODE='40001'; END IF;
  ELSIF actual_player-'terminal_closed_at' IS DISTINCT FROM original_player-'terminal_closed_at' THEN
   RAISE EXCEPTION 'ARCHIVED_SPIN_RECORDED_PLACE_CHANGED' USING ERRCODE='40001'; END IF;
 END LOOP;
 SELECT jsonb_agg(value ORDER BY value->>'id') INTO original_busts
 FROM jsonb_array_elements(original->'captured_preimage'->'tournament_players') WHERE value->>'user_id'<>p_winner::text;
 RETURN jsonb_build_object('evidence_kind','archived_database_projection','operation_id',admitted.operation_id,
  'source_sha256',admitted.source_sha256,'tournament_id',p_tournament,'winner_id',p_winner,
  'original_ranks',original_busts,'original_outcome','recorded_standings',
  'original_first_history',original->'original_first_history',
  'original_last_history',original->'original_last_history','original_atomic_commit',NULL,
  'admitted_at',admitted.admitted_at);
END $function$;
ALTER FUNCTION smarter_private.spin_archived_first_standings(p_tournament uuid, p_winner uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.spin_archived_first_standings(p_tournament uuid, p_winner uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.spin_archived_first_standings(p_tournament uuid, p_winner uuid)

-- @@DOOR smarter_private.spin_original_sorted(p_array jsonb, p_key text)
-- @@PIN md5=f02ae7a06e604940154a84ab2f539f68 len=347 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.spin_original_sorted(p_array jsonb, p_key text)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
 SELECT coalesce(jsonb_agg(v ORDER BY v->>p_key),'[]') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_array)='array' THEN p_array ELSE '[]'::jsonb END) v
$function$;
ALTER FUNCTION smarter_private.spin_original_sorted(p_array jsonb, p_key text) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.spin_original_sorted(p_array jsonb, p_key text) FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.spin_original_sorted(p_array jsonb, p_key text)

-- @@DOOR smarter_private.spin_original_standings_immutable()
-- @@PIN md5=fac843fef110b38751fb037e87368920 len=257 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.spin_original_standings_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN RAISE EXCEPTION 'SPIN_ORIGINAL_STANDINGS_IMMUTABLE' USING ERRCODE='55000'; END $function$;
ALTER FUNCTION smarter_private.spin_original_standings_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.spin_original_standings_immutable() FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.spin_original_standings_immutable()

-- @@DOOR smarter_private.spin_original_standings_requires_terminal()
-- @@PIN md5=642e80ef5bba363c8568d3335ed87635 len=727 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.spin_original_standings_requires_terminal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE cash jsonb;
BEGIN
 SELECT cash_receipt INTO cash FROM public.tournament_terminal_settlements WHERE tournament_id=NEW.tournament_id;
 IF cash IS NULL OR cash->'original_standings' IS DISTINCT FROM smarter_private.spin_original_standings_witness(NEW.tournament_id,NEW.winner_id)
 OR NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=NEW.tournament_id AND status='COMPLETED') THEN
  RAISE EXCEPTION 'SPIN_ORIGINAL_STANDINGS_TERMINAL_REQUIRED' USING ERRCODE='P0404'; END IF;
 RETURN NULL;
END $function$;
ALTER FUNCTION smarter_private.spin_original_standings_requires_terminal() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.spin_original_standings_requires_terminal() FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.spin_original_standings_requires_terminal()

-- @@DOOR smarter_private.spin_original_standings_witness(p_tournament uuid, p_winner uuid)
-- @@PIN md5=3ea4abb8295dbf2da9a01549d77803e7 len=4390 owner=postgres
CREATE OR REPLACE FUNCTION smarter_private.spin_original_standings_witness(p_tournament uuid, p_winner uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE r smarter_private.spin_original_standings%ROWTYPE; original jsonb; current_rows jsonb;
 original_busts jsonb; current_busts jsonb; winner jsonb; original_winner jsonb; candidate jsonb;
BEGIN
 SELECT * INTO r FROM smarter_private.spin_original_standings WHERE tournament_id=p_tournament;
 IF NOT FOUND THEN RETURN NULL; END IF;
 original:=r.expected->'snapshot';
 IF r.winner_id IS DISTINCT FROM p_winner OR r.expected_hash IS DISTINCT FROM md5(r.expected::text)
 OR original IS DISTINCT FROM smarter_private.spin_original_retained_case(p_tournament)
 OR (r.admitted_xid<>txid_current() AND NOT EXISTS(SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id=p_tournament)) THEN
  RAISE EXCEPTION 'SPIN_ORIGINAL_WITNESS_IDENTITY' USING ERRCODE='P0404'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]') INTO current_rows FROM public.tournament_players p WHERE tournament_id=p_tournament;
 SELECT jsonb_agg(v ORDER BY v->>'id') INTO original_busts FROM jsonb_array_elements(original->'roster') v WHERE v->>'user_id'<>p_winner::text;
 SELECT jsonb_agg(v-'terminal_closed_at' ORDER BY v->>'id') INTO current_busts FROM jsonb_array_elements(current_rows) v WHERE v->>'user_id'<>p_winner::text;
 SELECT v INTO original_winner FROM jsonb_array_elements(original->'roster') v WHERE v->>'user_id'=p_winner::text;
 SELECT v INTO winner FROM jsonb_array_elements(current_rows) v WHERE v->>'user_id'=p_winner::text;
 candidate:=original->'candidates'->0;
 IF jsonb_array_length(current_rows)<>3 OR jsonb_array_length(original_busts)<>2
 OR current_busts IS DISTINCT FROM (SELECT jsonb_agg(v-'terminal_closed_at' ORDER BY v->>'id') FROM jsonb_array_elements(original_busts) v)
 OR (winner-ARRAY['status','position','prize','terminal_closed_at']) IS DISTINCT FROM (original_winner-ARRAY['status','position','prize','terminal_closed_at'])
 OR EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=p_tournament
   AND p.terminal_closed_at IS DISTINCT FROM (SELECT completed_at FROM public.tournament_terminal_settlements WHERE tournament_id=p_tournament))
 OR winner->>'status' IS DISTINCT FROM 'winner' OR winner->'position' IS DISTINCT FROM '1'::jsonb
 OR winner->'chips' IS DISTINCT FROM '3000'::jsonb
 OR (winner->>'prize')::numeric NOT IN(0,(original->'tournament'->>'prize_pool')::numeric)
 OR (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM public.tournament_knockout_candidates c WHERE tournament_id=p_tournament) IS DISTINCT FROM original->'candidates'
 OR (CASE WHEN NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.hand_id=(candidate->>'hand_id')::uuid)
    AND NOT EXISTS(SELECT 1 FROM public.hand_history h WHERE h.id=(candidate->>'hand_id')::uuid)
    AND jsonb_array_length(original->'atomic')=1 AND jsonb_array_length(original->'history')=1
    AND original->'atomic'->0->>'hand_id' IS NOT DISTINCT FROM candidate->>'hand_id'
    AND original->'history'->0->>'id' IS NOT DISTINCT FROM candidate->>'hand_id'
    AND original->'history'->0->'has_human'='false'::jsonb
    AND (original->'history'->0->>'created_at')::timestamptz
        <= now()-make_interval(days=>(SELECT p.horse_retention_days FROM public.hand_history_retention_policy p WHERE p.id))
  -- Both rows retired by the owner's horse retention: the retained snapshot,
  -- already bound by expected_hash above, remains the witness.
  THEN false
  ELSE (SELECT to_jsonb(a) FROM public.hand_atomic_commits a WHERE hand_id=(candidate->>'hand_id')::uuid) IS DISTINCT FROM original->'atomic'->0
   OR (SELECT to_jsonb(h) FROM public.hand_history h WHERE id=(candidate->>'hand_id')::uuid) IS DISTINCT FROM original->'history'->0
  END) THEN
  RAISE EXCEPTION 'SPIN_ORIGINAL_STANDINGS_CHANGED' USING ERRCODE='P0404'; END IF;
 RETURN jsonb_build_object('operation_id',r.operation_id,'expected_hash',r.expected_hash,
  'tournament_id',p_tournament,'winner_id',p_winner,'original_ranks',original_busts,
  'accepted_candidate',candidate,'accepted_hand_id',candidate->'hand_id',
  'accepted_hand_number',candidate->'hand_number','original_outcome','recorded_standings',
  'admitted_at',r.admitted_at);
END $function$;
ALTER FUNCTION smarter_private.spin_original_standings_witness(p_tournament uuid, p_winner uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.spin_original_standings_witness(p_tournament uuid, p_winner uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END smarter_private.spin_original_standings_witness(p_tournament uuid, p_winner uuid)

-- @@DOOR trg_fn_close_session_when_seat_vacated()
-- @@PIN md5=7e27f560b34e0d3b3e5688195c1b9b3b len=1011 owner=postgres
CREATE OR REPLACE FUNCTION public.trg_fn_close_session_when_seat_vacated()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
  BEGIN
    IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
              WHERE t.id=NEW.table_id AND c.asset='diamonds') THEN RETURN NULL; END IF;
    /* A VACATED SEAT CLOSES ITS SESSION AT COMMIT (2026-09-10). Deferred: any
       proper close in this transaction has already run. Only a session that
       NOBODY closed is still open here, and that is the one this closes. */
    IF OLD.left_at IS NULL AND NEW.left_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.tables t WHERE t.id = NEW.table_id AND t.tournament_id IS NULL) THEN
      UPDATE public.cash_player_session
         SET closed_at = clock_timestamp(), closed_reason = 'seat_vacated'
       WHERE player_id = NEW.user_id AND scope_type = 'table'
         AND scope_id = NEW.table_id AND closed_at IS NULL;
    END IF;
    RETURN NULL;
  END $function$;
ALTER FUNCTION public.trg_fn_close_session_when_seat_vacated() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.trg_fn_close_session_when_seat_vacated() TO PUBLIC, anon, authenticated, service_role;
-- @@END trg_fn_close_session_when_seat_vacated()

-- @@DOOR trg_fn_close_sessions_when_table_closes()
-- @@PIN md5=5cff41ed8d0fc0c0aaa75661f6a28a2a len=784 owner=postgres
CREATE OR REPLACE FUNCTION public.trg_fn_close_sessions_when_table_closes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
  BEGIN
    /* A CLOSED TABLE CLOSES ITS SESSIONS (2026-09-10). See the migration of
       the same name. Fires on the transition INTO closed/deleted only, so a
       no-op status write on an already-closed table does nothing. */
    IF (NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed')
       OR (COALESCE(NEW.is_deleted,false) AND NOT COALESCE(OLD.is_deleted,false)) THEN
      UPDATE public.cash_player_session
         SET closed_at = clock_timestamp(), closed_reason = 'table_closed'
       WHERE scope_type = 'table' AND scope_id = NEW.id AND closed_at IS NULL;
    END IF;
    RETURN NEW;
  END $function$;
ALTER FUNCTION public.trg_fn_close_sessions_when_table_closes() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.trg_fn_close_sessions_when_table_closes() TO PUBLIC, anon, authenticated, service_role;
-- @@END trg_fn_close_sessions_when_table_closes()

-- @@DOOR trg_freeze_atomic_final_table_deal_obligation()
-- @@PIN md5=237168031dfb0fb80bdaa8ff15f25172 len=3239 owner=postgres
CREATE OR REPLACE FUNCTION public.trg_freeze_atomic_final_table_deal_obligation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_batched boolean := false;
  v_new_batched boolean := false;
  v_gate text := COALESCE(current_setting('app.atomic_final_table_deal_batch', true), '');
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND OLD.kind IN ('place', 'final_table_deal', 'bubble_protection') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tournament_final_table_deal_batches b
       WHERE b.tournament_id = OLD.tournament_id
    ) INTO v_old_batched;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE')
     AND NEW.kind IN ('place', 'final_table_deal', 'bubble_protection') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tournament_final_table_deal_batches b
       WHERE b.tournament_id = NEW.tournament_id
    ) INTO v_new_batched;
  END IF;

  IF NOT v_old_batched AND NOT v_new_batched THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id = OLD.tournament_id) THEN
    RETURN OLD;
  END IF;

  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'obligations frozen by an atomic final-table deal cannot be %', lower(TG_OP)
      USING ERRCODE = 'check_violation';
  END IF;
  IF ROW(NEW.id, NEW.tournament_id, NEW.kind, NEW.place, NEW.user_id,
         NEW.amount_owed, NEW.source, NEW.created_at, NEW.adjustment_id)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tournament_id, OLD.kind, OLD.place, OLD.user_id,
         OLD.amount_owed, OLD.source, OLD.created_at, OLD.adjustment_id) THEN
    RAISE EXCEPTION
      'a frozen final-table-deal obligation identity, recipient or entitlement cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Only the exact lifecycle marker may change after canonical v2 completion.
  IF OLD.terminal_closed_at IS NULL AND NEW.terminal_closed_at IS NOT NULL
    AND isfinite(NEW.terminal_closed_at)
    AND (to_jsonb(NEW)-'terminal_closed_at') IS NOT DISTINCT FROM
        (to_jsonb(OLD)-'terminal_closed_at')
    AND EXISTS(SELECT 1 FROM public.tournament_final_table_deal_batches b
      WHERE b.tournament_id=OLD.tournament_id AND b.contract_version=2 AND b.settled_at IS NOT NULL)
    AND EXISTS(SELECT 1 FROM public.tournaments t
      WHERE t.id=OLD.tournament_id AND upper(t.status::text)='COMPLETED'
       AND t.ended_at IS NOT DISTINCT FROM NEW.terminal_closed_at) THEN
    PERFORM public.fn_ca_verify_terminal_final_deal_batch(OLD.tournament_id,true);
    RETURN NEW;
  END IF;
  IF v_gate <> OLD.tournament_id::text THEN
    RAISE EXCEPTION
      'final-table-deal obligations for tournament % are frozen by their atomic batch',
      OLD.tournament_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_paid + 0.005 < OLD.amount_paid
     OR NEW.amount_paid > NEW.amount_owed + 0.005
     OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at) THEN
    RAISE EXCEPTION
      'a frozen final-table-deal payment record cannot move backwards or above its entitlement'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.trg_freeze_atomic_final_table_deal_obligation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trg_freeze_atomic_final_table_deal_obligation() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trg_freeze_atomic_final_table_deal_obligation() TO service_role;
-- @@END trg_freeze_atomic_final_table_deal_obligation()

-- @@DOOR trg_lock_and_validate_tournament_live_seat()
-- @@PIN md5=ddcd580bb32b2b953a5b45df5d29068e len=4028 owner=postgres
CREATE OR REPLACE FUNCTION public.trg_lock_and_validate_tournament_live_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_ids uuid[];
  v_is_live_acquisition boolean := false;
  v_proof_open boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.seat_number IS NOT DISTINCT FROM OLD.seat_number
     AND NEW.stack IS NOT DISTINCT FROM OLD.stack
     AND NEW.left_at IS NOT DISTINCT FROM OLD.left_at THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    SELECT t.tournament_id INTO v_old_tournament_id
      FROM public.tables t
     WHERE t.id = OLD.table_id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id THEN
    -- Same table on both sides: one lookup answers for both (2026-09-10).
    v_new_tournament_id := v_old_tournament_id;
  ELSIF TG_OP <> 'DELETE' THEN
    SELECT t.tournament_id INTO v_new_tournament_id
      FROM public.tables t
     WHERE t.id = NEW.table_id;
  END IF;

  -- A CASH SEAT HAS NO LAUNCH PROOF TO LOCK (2026-09-10). With both ids NULL
  -- the body below cannot lock, refuse or require anything: v_ids would be
  -- {NULL,NULL}, the proof-open test is false, the lock helper returns on an
  -- empty set, and the roster check needs a tournament. Measured 6.4 ms per
  -- seat write on a cash table for that no-op; see the migration header.
  IF v_old_tournament_id IS NULL AND v_new_tournament_id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_ids := CASE
    WHEN TG_OP = 'INSERT' THEN ARRAY[v_new_tournament_id]
    WHEN TG_OP = 'DELETE' THEN ARRAY[v_old_tournament_id]
    ELSE ARRAY[v_old_tournament_id, v_new_tournament_id]
  END;

  IF TG_OP = 'INSERT' THEN
    v_is_live_acquisition := NEW.left_at IS NULL AND NEW.user_id IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_is_live_acquisition := NEW.left_at IS NULL
      AND NEW.user_id IS NOT NULL
      AND (
        OLD.left_at IS NOT NULL
        OR OLD.user_id IS DISTINCT FROM NEW.user_id
        OR OLD.table_id IS DISTINCT FROM NEW.table_id
      );
  END IF;

  IF NOT v_is_live_acquisition THEN
    -- THE SAME ROWS AS `t.id = ANY(v_ids)`, WITHOUT A RE-PLAN PER CALL
    -- (2026-09-10). v_ids is {new} / {old} / {old,new} for INSERT / DELETE /
    -- UPDATE, and the side that is not assigned is NULL, which matches nothing
    -- in either form. With an array parameter PL/pgSQL keeps a custom plan and
    -- re-plans this statement on every seat write (0.83-0.99 ms measured);
    -- with two scalar parameters it adopts the generic plan (0.026 ms).
    SELECT EXISTS (
      SELECT 1
        FROM public.tournaments t
        LEFT JOIN public.tournament_launch_receipts r
          ON r.tournament_id = t.id
       WHERE (t.id = v_old_tournament_id OR t.id = v_new_tournament_id)
         AND (upper(t.status::text) = 'REGISTERING' OR r.completed_at IS NULL)
         AND (upper(t.status::text) = 'REGISTERING' OR r.tournament_id IS NOT NULL)
    ) INTO v_proof_open;
    IF NOT v_proof_open THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;

  PERFORM *
    FROM public.fn_lock_tournament_launch_proof_parents(v_ids);

  IF TG_OP <> 'DELETE'
     AND NEW.left_at IS NULL
     AND NEW.user_id IS NOT NULL
     AND v_new_tournament_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = v_new_tournament_id
          AND p.user_id = NEW.user_id
          AND p.status IN ('registered', 'playing')
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ROSTER_REQUIRED: live seat user % has no active roster in tournament %',
      NEW.user_id, v_new_tournament_id
      USING ERRCODE = '23514';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;
ALTER FUNCTION public.trg_lock_and_validate_tournament_live_seat() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trg_lock_and_validate_tournament_live_seat() FROM PUBLIC, anon, authenticated, service_role;
-- @@END trg_lock_and_validate_tournament_live_seat()

-- @@DOOR trg_seat_parent_keys_match()
-- @@PIN md5=9060bc3173c812e142d40612ad973f1a len=1853 owner=postgres
CREATE OR REPLACE FUNCTION public.trg_seat_parent_keys_match()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_scope text; v_key text; v_found boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id
     AND OLD.active_game_scope IS NOT DISTINCT FROM NEW.active_game_scope
     AND OLD.active_parent_key IS NOT DISTINCT FROM NEW.active_parent_key THEN
    RETURN NEW; -- an FK re-checks only when a referencing column changes
  END IF;
  IF NEW.table_id IS NULL OR (NEW.active_game_scope IS NULL AND NEW.active_parent_key IS NULL) THEN
    RETURN NEW; -- MATCH SIMPLE
  END IF;
  SELECT t.seat_game_scope, t.seat_admission_key, true INTO v_scope, v_key, v_found
    FROM public.tables t WHERE t.id = NEW.table_id FOR KEY SHARE;
  IF NEW.active_game_scope IS NOT NULL AND (v_found IS DISTINCT FROM true OR v_scope IS DISTINCT FROM NEW.active_game_scope) THEN
    RAISE EXCEPTION 'insert or update on table "table_seats" violates foreign key constraint "active_seat_game_scope_parent"'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'active_seat_game_scope_parent',
            DETAIL = format('Key (table_id, active_game_scope)=(%s, %s) is not present in table "tables".', NEW.table_id, NEW.active_game_scope);
  END IF;
  IF NEW.active_parent_key IS NOT NULL AND (v_found IS DISTINCT FROM true OR v_key IS DISTINCT FROM NEW.active_parent_key) THEN
    RAISE EXCEPTION 'insert or update on table "table_seats" violates foreign key constraint "live_seat_parent_cannot_close"'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'live_seat_parent_cannot_close',
            DETAIL = format('Key (table_id, active_parent_key)=(%s, %s) is not present in table "tables".', NEW.table_id, NEW.active_parent_key);
  END IF;
  RETURN NEW;
END $function$;
ALTER FUNCTION public.trg_seat_parent_keys_match() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.trg_seat_parent_keys_match() TO PUBLIC, anon, authenticated, service_role;
-- @@END trg_seat_parent_keys_match()

-- @@DOOR trg_table_parent_keys_guard()
-- @@PIN md5=903859ebc0b396942e7507e72b796ef9 len=860 owner=postgres
CREATE OR REPLACE FUNCTION public.trg_table_parent_keys_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.seat_admission_key IS NOT NULL AND NEW.seat_admission_key IS DISTINCT FROM OLD.seat_admission_key THEN
    IF EXISTS (SELECT 1 FROM public.table_seats s
                WHERE s.table_id = OLD.id AND s.active_parent_key = OLD.seat_admission_key) THEN
      RAISE EXCEPTION 'update or delete on table "tables" violates foreign key constraint "live_seat_parent_cannot_close" on table "table_seats"'
        USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'live_seat_parent_cannot_close',
              DETAIL = format('Key (id, seat_admission_key)=(%s, %s) is still referenced from table "table_seats".', OLD.id, OLD.seat_admission_key);
    END IF;
  END IF;
  RETURN NEW;
END $function$;
ALTER FUNCTION public.trg_table_parent_keys_guard() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.trg_table_parent_keys_guard() TO PUBLIC, anon, authenticated, service_role;
-- @@END trg_table_parent_keys_guard()

-- @@DOOR trg_table_scope_cascade()
-- @@PIN md5=20b1bb2cdc7a82c600050b68679b8706 len=452 owner=postgres
CREATE OR REPLACE FUNCTION public.trg_table_scope_cascade()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.seat_game_scope IS NOT NULL AND NEW.seat_game_scope IS DISTINCT FROM OLD.seat_game_scope THEN
    UPDATE public.table_seats s SET active_game_scope = NEW.seat_game_scope
     WHERE s.table_id = NEW.id AND s.active_game_scope = OLD.seat_game_scope;
  END IF;
  RETURN NULL;
END $function$;
ALTER FUNCTION public.trg_table_scope_cascade() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.trg_table_scope_cascade() TO PUBLIC, anon, authenticated, service_role;
-- @@END trg_table_scope_cascade()

-- ============================================================================
-- Every door above, read back out of the catalogue it was just loaded into.
-- ============================================================================
DO $capture$
DECLARE r record; v_oid oid; v_seen integer := 0; v_bad integer := 0;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('add_diamonds_to_balance(p_user_id uuid, p_amount integer, p_type text, p_description text, p_reference_id text, p_counterparty_id uuid)','5d356b15727558df9c498dbb05a745d0'),
    ('atomic_seat_cashout_locked(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_leave_mode text)','e1b0b9702e75378ecac634c3a879502e'),
    ('atomic_table_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean, p_club_id uuid, p_idempotency_key uuid)','2f8b47a714db3f297aff3f7a2e814c44'),
    ('deduct_diamonds(p_user_id uuid, p_amount integer, p_description text, p_transaction_type text, p_source text, p_metadata jsonb, p_reference_id text, p_cooldown_seconds integer)','bfd93c5a09301f87e8afca6da0240061'),
    ('fn_a_closed_account_cannot_rewrite_itself()','9552ec6c29dc58e1e34221c542ce4bc9'),
    ('fn_accounting_mixed_cutover_spin_proof_valid(p_rake_record_id uuid)','f660a8b47bf88a86f2e236a4794ed4e6'),
    ('fn_accounting_tournament_bank_proof(p_tournament_id uuid, p_recognized_at timestamp with time zone, p_bank_club_id uuid, p_union_id uuid, p_net_fee numeric, p_union_wallet_transaction_id uuid, p_bank_journal_id uuid)','e56aa8c8280c59e2f0406ea6c504dc4e'),
    ('fn_accounting_tournament_fee_fingerprint(p_row rake_records)','dd55cceba87b1578472171e1c80ba1fb'),
    ('fn_accounting_tournament_fee_net_plan(p_tournament_id uuid)','9b1147a5b373e2a01e3374b8dd2cc2fa'),
    ('fn_accounting_tournament_fee_owner_basis_is_append_only()','6122f7f6c814c1be411e67c1b916917d'),
    ('fn_accounting_tournament_fee_receipt_immutable()','bdc4ee4b75e3471cd33a5ed4b250ec0f'),
    ('fn_accounting_tournament_terminal_fee_receipt(p_tournament_id uuid)','b73bac5809d0e042837fcc32bacc0769'),
    ('fn_bounty_obligation_has_complete_marker(p_obligation_id uuid)','d51a53c3ad6d45edb5e431c43641dc57'),
    ('fn_ca_arena_diamonds()','86863a1208455e92803777829bc9a668'),
    ('fn_ca_assert_satellite_cohort_standings(p_tournament_id uuid)','12b83a02a4057025e153f07bad9d8919'),
    ('fn_ca_assert_tournament_chip_grant(p_tournament_id uuid, p_user_id uuid, p_seat_id uuid, p_new_stack numeric, p_source text)','c49fa16f6be47ed9ca2e72b2f2b9da07'),
    ('fn_ca_autoledger()','53f9d85b88cc86b807f7ea5b80d7bd4e'),
    ('fn_ca_capture_tournament_obligation_event()','d6e1f4f7b4a93df535d3b4d4bce925bf'),
    ('fn_ca_cash_buyin_receipt(p_idempotency_key uuid, p_table_id uuid)','82e0c070a873103964f597a1968745c7'),
    ('fn_ca_consume_purchase_lots(p_user_id uuid, p_amount bigint)','d8674a23766c140fa3e85834d540a4ac'),
    ('fn_ca_diamond_engine_of(p_type text, p_transaction_type text, p_source text, p_description text, p_reference_id text)','44a39c35cc96801b5aa22a6ac930ee17'),
    ('fn_ca_diamond_journal_origin(p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric)','373b32a1f7b88bd38277e808a5700256'),
    ('fn_ca_diamond_register_vs_supply()','4831173c57fc3d4e2bc0fa5eea346ee2'),
    ('fn_ca_diamond_transfer_names_its_counterparty()','ffd2026beded5edfde9726d4fde77cbf'),
    ('fn_ca_fee_cutover_stranded_by(p_starts_at timestamp with time zone)','aa8ef4fe6a1d23888ae955bdce26ab01'),
    ('fn_ca_guard_fee_cutover_is_drained()','00d1c66499077ca5947eb57bf62d1060'),
    ('fn_ca_guard_original_paid_stack_receipt()','06bbbafae6950b54fdb00297830a30a4'),
    ('fn_ca_guard_seat_creation()','b3e14f411d43b01e84fd614c87f8bf6a'),
    ('fn_ca_legacy_fee_custody_cohort(p_tournament_id uuid)','1a0321e70d38708ff96db5fd6ebe0067'),
    ('fn_ca_legacy_fee_custody_is_append_only()','4bc1c11e22a8ee54c63c36782b642831'),
    ('fn_ca_legacy_fee_custody_requires_terminal()','3f9a6541f8016270ba4faae97765e620'),
    ('fn_ca_legacy_fee_resolution_requires_recognition()','5cacfa2b62b7ecbea69725a8486ae635'),
    ('fn_ca_legacy_fee_resolution_write_is_exact(p_table text, p_operation text, p_old jsonb, p_new jsonb)','0a123d50d4bd6d9364fdceb81c5cce8a'),
    ('fn_ca_lock_tournament_seat_acquisition(p_tournament_id uuid, p_table_id uuid, p_user_id uuid)','367488e3f6ef4714b6c2bca3e8068065'),
    ('fn_ca_mint(p_asset text, p_destination text, p_target_id uuid, p_amount numeric, p_reason text, p_op_id text, p_class text)','da9429ce6483c47c7d536582433a1edd'),
    ('fn_ca_original_paid_stack_must_complete()','8e221724e453fe284280f1f72dedaa7d'),
    ('fn_ca_process_tournament_chip_purchase_money_v1(p_tournament_id uuid, p_user_id uuid, p_rebuy_type text, p_cost numeric, p_chips numeric, p_current_level integer, p_client_token text)','9ff346ac60f760311d884c6d63d9001d'),
    ('fn_ca_release_claim(p_fn text, p_op_id text, p_refusal jsonb)','e73b9eb40be251ea88e8be7ee8cf1985'),
    ('fn_ca_sep8_spin_original_fee_proof(p_tournament_id uuid)','3224402eb784a60fbbc129135df632fb'),
    ('fn_ca_tournament_accounting_evidence_immutable()','9bcc5b1f5fc9b9c036b617c36473d290'),
    ('fn_ca_tournament_bust_at(p_tournament_id uuid, p_user_id uuid)','e15bc842a96da68626db64b2b5dcbd9e'),
    ('fn_ca_tournament_chip_supply(p_tournament_id uuid)','c29dfa4a0ebef95fddeb8a0982ef07e1'),
    ('fn_ca_tournament_fee_custody_receipt(p_tournament_id uuid)','5bde7ab09e8fe7da8dd11cc9e581e504'),
    ('fn_ca_tournament_felt_may_not_exceed_supply()','81fda5e596905c96a07bebfcff7f32b3'),
    ('fn_ca_tournament_felt_total(p_tournament_id uuid)','a2698ca8bafd2a3b76c7ac156d654276'),
    ('fn_ca_verify_terminal_final_deal_batch(p_tournament_id uuid, p_require_terminal boolean)','bd50e5dfb791252dd1c5731fa6254d00'),
    ('fn_cancel_cash_seat_moves_on_table_close()','15c4186eb80013ea8907e73f80f4a096'),
    ('fn_capability_available(p_capability_id text)','43d415cfb6fbb9c289e98b12b5de925c'),
    ('fn_capture_owner_notification_destination()','765a320465a49f71c26c4b747d61f1fd'),
    ('fn_cash_cluster_epoch_follows_its_game()','4cc0609b0014eb7f3930e8f03f6c6049'),
    ('fn_cash_game_roster_track()','1ce40780d8a8b510b88549de225a9b25'),
    ('fn_cash_provenance_immutable()','77e5fcec76b8682e7648573fd60e0a71'),
    ('fn_cash_record_original_funding(p_kind text, p_key text, p_user uuid, p_table uuid, p_ledger uuid, p_wallet uuid, p_club uuid, p_amount numeric, p_after numeric, p_pending uuid)','7ee6659572a38ef014952b4559f6167a'),
    ('fn_cashout_seat_occupancy(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_occupancy_id uuid, p_leave_mode text)','2e60c4b66468b51061018a9058e9a395'),
    ('fn_clear_seats_on_game_end()','9660c076fa2d1739a01ed360933f3c26'),
    ('fn_clear_sitout_on_turnover()','0047b57eef2386cece21471486e8579c'),
    ('fn_concurrent_game_load(p_user_id uuid, p_exclude_seat_id uuid, p_exclude_table_id uuid, p_exclude_tournament_id uuid)','3c3cefbad667a51bd13caf5e1beaaf8b'),
    ('fn_diamond_bonus_spin_settled()','a9940a3b366ae705bd9178756c2f0b24'),
    ('fn_diamond_bonus_spin_ticket_guard()','6771d97906576f09e64b58bd86e53d9e'),
    ('fn_diamond_game_owner(p_host uuid, p_kind text)','5c456eac1cbb3ea5e34362fc672fdf61'),
    ('fn_diamond_game_reserved_cover_guard()','c7a4c4fa4763924d7f76d9f70656014e'),
    ('fn_diamond_spin_book(p_owner uuid, p_club uuid, p_host uuid, p_kind text, p_player uuid, p_movement text, p_amount integer, p_operation text, p_description text, p_day date)','38656616c6d45879f62632734ea452e0'),
    ('fn_diamond_spin_immutable()','b09270d05e3717a6cef16c4c58a94275'),
    ('fn_diamond_spin_profit_burn(p_net bigint, p_bps integer)','948e5f01e70562ecb4d47d64c20bbedd'),
    ('fn_diamond_spin_profit_burn_bps()','6ab8a99820e64de356f9d303927752ca'),
    ('fn_diamond_spin_settlement_receipt()','903adaa2b5861b5927223429fd300a14'),
    ('fn_diamond_spin_wallet_reserve()','f13ec6ac7915261efc4170ac3f16a655'),
    ('fn_enforce_four_table_limit()','817fb0550497afd5347b936a3cbb5bb9'),
    ('fn_enforce_tournament_capacity()','c89a358115c8cd06ff93cfffc2aab84f'),
    ('fn_get_seat_cashout_receipt(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_occupancy_id uuid)','49d452fa253d5ac059a199284f4ce806'),
    ('fn_guard_horse_profile_authority()','515acecbbd2af70b7d3384c83c468fad'),
    ('fn_guard_managed_game_lifecycle()','b90cc1cb27839211a82715c4741410c1'),
    ('fn_guard_profile_privileged_columns()','d40c547c47f3d0516dc24f22ab53da7e'),
    ('fn_is_owner_operational_notification(p_user uuid, p_type text, p_title text, p_data jsonb)','8c2c62359d92dcbd3b3621a762b981ca'),
    ('fn_kill_pot_configuration_refusal(p_kill_mode text, p_variant text, p_game_type text, p_tournament_id uuid, p_bomb_pot_enabled boolean, p_big_blind numeric, p_club_id uuid)','c5f1d7f6361676b0ed0780e8ca9394a2'),
    ('fn_lightning_anchor_is_live_eligible(p_seat_id uuid, p_cluster_id uuid, p_player_id uuid)','a121611dd69437875e82a06832715981'),
    ('fn_lightning_hand_is_immutable()','fd227015ee402f9d680dd1f45776a2bb'),
    ('fn_lightning_hand_player_is_immutable()','0566b91631683ff6c7448a75baf59ee7'),
    ('fn_lightning_instance_is_disciplined()','bcb27a1044e4e71846d0a9aa2805ae30'),
    ('fn_lightning_instance_releases_its_reservations()','5f870992841c2734f24109f4f9f799a9'),
    ('fn_lightning_player_in_hand(p_player_id uuid, p_cluster_id uuid)','36e38991a83968c97a8d69f5e7ee0549'),
    ('fn_lightning_pool_enter(p_seat_id uuid, p_now timestamp with time zone)','5a4547a38c09b1823a8f0d6e1d4ef13d'),
    ('fn_lightning_pool_slot_holds_its_history()','f4a88b83619bb67f2d7ca2ccc18e46df'),
    ('fn_lightning_pool_slot_idle_since_starts_at_open()','2612b685586f262126202063e25d02cb'),
    ('fn_lightning_pool_slot_open(p_pool_session_id uuid, p_now timestamp with time zone)','115bd4194acc7d337e13d6eb6e699a9a'),
    ('fn_lightning_refuses_truncate()','28d568ccc181e2e5389ed52d9855b16f'),
    ('fn_lightning_reservation_end_marks_the_slot_idle()','c583f2b677bcb99fa292346ee9543d5d'),
    ('fn_lightning_reservation_is_disciplined()','cdea144431df670a2ea87fd0d5ae35ee'),
    ('fn_log_seat_stack_exit()','9ef7dad056ad5b5e745200ca83170c04'),
    ('fn_mirror_notification_to_push_outbox()','37d724277900f53d00db14fb3c5cd04d'),
    ('fn_multi_day_stage_rows_are_rpc_owned()','18f1e1bdbb5eee5cf28b3b3729db3caf'),
    ('fn_multi_day_stage_rows_never_truncate()','ae146ca1b46595284d356662c12693f3'),
    ('fn_only_close_account_closes_an_account()','f8696524b52366d303d2f45f20d69e8e'),
    ('fn_player_needs_a_started_game()','b007e153e4bd41fb664255668c408831'),
    ('fn_poker_diamond_audit_tournament_created(p_result jsonb)','d18fe890c687f84edb61980a7d612e2d'),
    ('fn_poker_diamond_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean, p_club_id uuid, p_idempotency_key uuid)','2f76148f74df8766a958cdd403582e24'),
    ('fn_poker_diamond_cash_variant(p_variant text)','929c207a922004eb0e764011a2fe386c'),
    ('fn_poker_diamond_cashout(p_user_id uuid, p_table_id uuid, p_seat_number integer)','86a1c1ed0233ef041695241509514c32'),
    ('fn_poker_diamond_cashout_receipt(p_table_id uuid, p_occupancy_id uuid)','85993bfb0f425ebcd16416ec89b9a9cf'),
    ('fn_poker_diamond_create_tournament(p_config jsonb)','05e4ae642e1a3949da8bb34bc62f7f3d'),
    ('fn_poker_diamond_open_cash_table(p_name text, p_small_blind integer, p_big_blind integer, p_min_buy_in integer, p_max_buy_in integer, p_max_players integer, p_game_variant text)','116919d8ea2a3bd49d92e72837e0d3b4'),
    ('fn_poker_diamond_plain_cash_table(p_t tables)','94fb4dd7359850d388262de813c0caf1'),
    ('fn_poker_diamond_staff_audit(p_action text, p_target_type text, p_target_id uuid, p_before jsonb, p_after jsonb, p_details jsonb)','14bcef64645d1ca77f5243ca4bd1b428'),
    ('fn_poker_diamond_top_up(p_user_id uuid, p_table_id uuid, p_amount numeric, p_expected_stack numeric, p_request_id uuid)','f7659bddc424e9e4b6785228ee0eec6a'),
    ('fn_poker_guard_arena_structure()','d3ecf93c4ac0aced79031b4ce00df59b'),
    ('fn_poker_reject_diamond_chip_money()','7c61e72bf8bc26c15490b31bed7bc912'),
    ('fn_publish_profile_account_change()','84dcc945b3e6d19254a5b901d365eca6'),
    ('fn_publish_profile_appearance_change()','64cc449327fe6d17bc0ba9c51144196a'),
    ('fn_raise_server_financial_alert(p_severity text, p_source text, p_message text, p_context jsonb, p_dedupe_key text, p_entity_id text)','264d32bcba8f6430ea68b7ca9738fbc8'),
    ('fn_record_operational_alert(p_source text, p_event_key text, p_alertname text, p_status text, p_severity text, p_payload jsonb)','36601e205494e8768f5a1dce09f4a186'),
    ('fn_refuse_new_entries_while_frozen()','7d7bd629403539eb069ac20afc62b547'),
    ('fn_register_for_tournament(p_tournament_id uuid, p_seat_first_internal boolean)','0f3b104a1bf9431d70053c656fedc081'),
    ('fn_register_for_tournament_request(p_tournament_id uuid, p_request_id uuid)','9d174770c0de981532c2d35d58743397'),
    ('fn_reject_horse_name_on_human()','ff58f7bb658731e107393cd94bd594c7'),
    ('fn_release_seats_on_tournament_finish()','7e9ab84b48a96dda6029414f889ab39f'),
    ('fn_require_live_seat_parent()','799eb3f8788b5ee10e98da69cf52c12e'),
    ('fn_satellite_target_contract_is_immutable()','68f353273fb27d0eee5021481192e902'),
    ('fn_satellite_target_player_provenance_is_immutable()','68f98d4ec2cb186aae11787f1666cffc'),
    ('fn_seat_change_syncs_seat_first_count()','3d222458b40d5aec09f8f1e88bf60d53'),
    ('fn_seat_club_for_user(p_user_id uuid, p_table_id uuid, p_preferred_club uuid)','821ddcdf4478a6cc6355499fd15e2b32'),
    ('fn_seed_all_throwables_shop_item()','5de69e125c0bf0ce14e8bd6693adc90c'),
    ('fn_stamp_active_seat_game_scope()','d271007d2e1b1f4daa83bfc295d47c1e'),
    ('fn_stamp_seat_club()','467104f7e791b76328ce5e20b42ba81b'),
    ('fn_stamp_seat_occupancy()','4d2645a24bd3b88d7ffc51097b37d640'),
    ('fn_stamp_table_game_scope()','30cd14f9ff42850835c1f0bb624a0873'),
    ('fn_stamp_table_seat_admission()','9c5d3aee9f48697db3ea08807df46527'),
    ('fn_stamp_tournament_elimination_sequence()','1da72fa956566502be6d6c8d46ba6d2a'),
    ('fn_sync_tournament_current_players()','3fd8f2c2f0866754467266a6bc5b6d80'),
    ('fn_table_seats_lightning_anchor_guard()','fe1678bae7a7973b2a9bcaf6ade83156'),
    ('fn_table_seats_lightning_pool_follows_seat()','d1e10013c5a044a6dd82e9a99755e4f4'),
    ('fn_tables_kill_pot_guard()','837823de88843f8045bf37a120417585'),
    ('fn_tables_stakes_follows_its_own_blinds()','fb440f8eb09cdddfe941f5d3fbeef7f0'),
    ('fn_terminal_tournament_escrow_is_immutable()','f0c5a1b136edd9689816fda589d03434'),
    ('fn_terminal_tournament_evidence_is_immutable()','5eb12239ece45d08eb32dbaa9e3028dd'),
    ('fn_terminal_tournament_seat_is_immutable()','10a5d9082f7770127359f9eca7068ed6'),
    ('fn_tournament_elimination_has_a_place()','8995e4364a00e5bae077701c1185bf8b'),
    ('fn_tournament_live_seat_acquisition_requires_authority()','2039e26a8513bba99c057a28b79f44e5'),
    ('fn_tournament_payout_terms_committed_v1(p_tournament_id uuid)','918c62cbcc182d43a6a27edeb2c1c107'),
    ('fn_tournament_players_bagged_custody_fence()','7f2c2b24929ac233f1fa250a6f1911df'),
    ('fn_tournament_record_conclusion()','ff1dc28602058962abea8d8dbd3cdb9b'),
    ('fn_tournament_table_inherits_committed_blinds()','0386e9eb7f88d7e783c8cec1dbf5f5e8'),
    ('fn_try_record_owner_notification(p_id uuid)','bbc44eb76b74576906f55e9ae370a508'),
    ('fn_union_pnl_credit_touch()','3d52386d79eb9bc88107fb81f3c7da6e'),
    ('fn_union_pnl_inventory_immutable()','307d83a1ee3d912bade24c48144aa801'),
    ('fn_union_pnl_inventory_touch()','656eb1b8a853324b3276bcb1bfb95b23'),
    ('fn_union_pnl_receipt_frame()','dd4dbe3a58dc48bd67aab9ac818280d2'),
    ('fn_wheel_host(p_club_id uuid, OUT host_id uuid, OUT host_kind text)','704c11cdd7da184af55ecb312c2500ac'),
    ('generate_referral_code()','3ac2d5529de95863764ddca919ddfda3'),
    ('send_wallet_diamond_transfer(p_recipient_id uuid, p_amount integer, p_message text, p_reference_id text)','8d5b95d8ad2a74c1ba85339168349606'),
    ('smarter_private.breakfast_roster(p_tournament uuid)','4140be66012a9c16b19b61db8fd8d784'),
    ('smarter_private.breakfast_standings_witness(p_tournament uuid, p_winner uuid)','93a1e3e0f2677eebffc61ac7667d99e2'),
    ('smarter_private.breakfast_witness_immutable()','4198678f42ca289675b9a40bca17c525'),
    ('smarter_private.f06_abort_receipt_immutable()','811127b67caea34bd7d3e5bc6c41ed94'),
    ('smarter_private.f06_assert_movement(p_break uuid)','ad99e13122447e117d9769d28019cb7f'),
    ('smarter_private.f06_authority(t uuid, g uuid, take_lock boolean)','848b06c8e958ad739e0a60b388430f38'),
    ('smarter_private.f06_immutable_identity()','0fe40a0711ef6d196c6883d3b9e8b86f'),
    ('smarter_private.f06_manager_transfer_immutable()','d595b68fa3464e5d56b5bc5395b5eb08'),
    ('smarter_private.f06_mixed_current_admission(t uuid, g uuid, transfer uuid)','432f7c88639918e399e23d670639a246'),
    ('smarter_private.f06_mixed_movement_generation(p_break uuid)','2d096f6ee2a9eecd6895713be15cf365'),
    ('smarter_private.f06_mixed_preparation_guard()','bcbdb70741099a7806acd90e838cc03f'),
    ('smarter_private.f06_movement_immutable()','f7c8db440c9c3599ac70c32dae577c6b'),
    ('smarter_private.f06_movement_permits(p_tournament uuid, p_table uuid, p_boundary bigint)','f19826cbc5498bb58ed1463806ef7b52'),
    ('smarter_private.f06_movement_transition_guard()','1534f01f6efcb1aa16f9094dd8614f3a'),
    ('smarter_private.f06_new_lifecycle()','dca29a92ad46c6adb6e561f639e5a208'),
    ('smarter_private.f06_no_start_continuation_immutable()','2c87da2a00030dcc36ecb62bf51b2a89'),
    ('smarter_private.f06_retained_submission_guard()','8effe23bf967551f427628433dab6191'),
    ('smarter_private.f06_source_guard()','082cf45040f08f8ea533e0c21d7cd4e3'),
    ('smarter_private.f06_table_guard()','d8775467cf3f807b1992be752638d308'),
    ('smarter_private.f06_try_lane(t uuid)','78a3a191b9991b0a3a343db39de335aa'),
    ('smarter_private.hand_submission_immutable()','a22d5bdb6d4400dcf911e1bd28e3b354'),
    ('smarter_private.spin_archived_first_immutable()','a7a5d0d41cccfcee42e05b35eaf9f25d'),
    ('smarter_private.spin_archived_first_manifest()','8e1e270ca5dadbb043eda951df97ab53'),
    ('smarter_private.spin_archived_first_requires_terminal()','a3029d9daf225a881112d8c42105c8b8'),
    ('smarter_private.spin_archived_first_standings(p_tournament uuid, p_winner uuid)','268eb783e2ae723896acd222e80c57af'),
    ('smarter_private.spin_original_sorted(p_array jsonb, p_key text)','f02ae7a06e604940154a84ab2f539f68'),
    ('smarter_private.spin_original_standings_immutable()','fac843fef110b38751fb037e87368920'),
    ('smarter_private.spin_original_standings_requires_terminal()','642e80ef5bba363c8568d3335ed87635'),
    ('smarter_private.spin_original_standings_witness(p_tournament uuid, p_winner uuid)','3ea4abb8295dbf2da9a01549d77803e7'),
    ('trg_fn_close_session_when_seat_vacated()','7e27f560b34e0d3b3e5688195c1b9b3b'),
    ('trg_fn_close_sessions_when_table_closes()','5cff41ed8d0fc0c0aaa75661f6a28a2a'),
    ('trg_freeze_atomic_final_table_deal_obligation()','237168031dfb0fb80bdaa8ff15f25172'),
    ('trg_lock_and_validate_tournament_live_seat()','ddcd580bb32b2b953a5b45df5d29068e'),
    ('trg_seat_parent_keys_match()','9060bc3173c812e142d40612ad973f1a'),
    ('trg_table_parent_keys_guard()','903859ebc0b396942e7507e72b796ef9'),
    ('trg_table_scope_cascade()','20b1bb2cdc7a82c600050b68679b8706')
  ) AS t(ident, want)
  LOOP
    v_seen := v_seen + 1;
    SELECT p.oid INTO v_oid
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE CASE WHEN n.nspname = 'public' THEN '' ELSE n.nspname || '.' END
           || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = r.ident;
    IF v_oid IS NULL THEN
      RAISE WARNING 'captured concurrency door % is not installed', r.ident; v_bad := v_bad + 1;
    ELSIF md5(pg_get_functiondef(v_oid)) <> r.want THEN
      RAISE WARNING 'captured concurrency door % renders to % but its pin says %',
        r.ident, md5(pg_get_functiondef(v_oid)), r.want;
      v_bad := v_bad + 1;
    END IF;
    v_oid := NULL;
  END LOOP;
  IF v_seen <> 185 THEN
    RAISE EXCEPTION 'the concurrency capture declares %s doors but this file carries %', 185, v_seen;
  END IF;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% of % captured Diamond concurrency doors do not match their pins', v_bad, v_seen;
  END IF;
  RAISE NOTICE 'PASS: all % captured Diamond concurrency doors match their installed pins', v_seen;
END $capture$;
