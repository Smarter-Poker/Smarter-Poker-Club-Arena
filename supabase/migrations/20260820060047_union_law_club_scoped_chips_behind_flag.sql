-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820060047 "union_law_club_scoped_chips_behind_flag"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4f6a852b1a548951a372f4af3007f901 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- UNION LAW — CLUB-SCOPED CHIPS (2026-08-20)
--
-- Dan: "They have to physically get chips from that club, sit in games inside
-- that club to earn rake inside that club. Each wallet for each club is 100%
-- separate and never commingled."
--
-- Implements true per-club chip custody:
--   BUY-IN   debits club_members.chip_balance for the club the player entered
--            under, and stamps table_seats.club_id with it.
--   CASH-OUT credits the SAME club's chip_balance, routed by the seat's own
--            stamp.
--   RAKE     already follows table_seats.club_id (previous migration).
--
-- TRANSITION SAFETY — this is why it is safe to flip while 588 seats are live:
--   Cash-out routes by the SEAT, not by the flag. A seat bought in under the
--   old global wallet carries club_id = NULL and always cashes back out to the
--   global wallet. A seat bought in under club custody carries a club and
--   returns there. Chips can therefore never be stranded or double-credited,
--   even if the flag is switched mid-session.
--
-- ROLLOUT: gated by platform_policies key 'union.club_scoped_chips'.
--   'off' (default) -> byte-for-byte the current behaviour.
--   'on'            -> club custody enforced.
-- Flip on with:
--   UPDATE platform_policies SET value='on', updated_at=now()
--    WHERE key='union.club_scoped_chips';
-- Flip back instantly with value='off'. No deploy required either way.
-- ============================================================================

INSERT INTO public.platform_policies (key, value, description) VALUES
  ('union.club_scoped_chips', 'off',
   'LAW (Dan 2026-08-20): when ON, table buy-ins debit club_members.chip_balance '
   'for the club the player entered under and stamp table_seats.club_id; cash-outs '
   'return chips to that same club. Club wallets are then 100% separate and never '
   'commingled, and rake is earned for the club the player actually played under. '
   'When OFF, the legacy single global player wallet is used. Cash-out always '
   'routes by the seat stamp, so flipping this is safe mid-session.')
ON CONFLICT (key) DO UPDATE
  SET description = EXCLUDED.description, updated_at = now();

CREATE OR REPLACE FUNCTION public.fn_club_scoped_chips_enabled()
 RETURNS boolean
 LANGUAGE sql STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((SELECT lower(value) = 'on' FROM platform_policies
                    WHERE key = 'union.club_scoped_chips'), false);
$function$;

-- BUY-IN ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.atomic_table_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean DEFAULT false, p_club_id uuid DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_new_balance NUMERIC;
  v_club_id UUID;
  v_union_id UUID;
  v_ban_id UUID;
  v_min_buy_in NUMERIC;
  v_max_buy_in NUMERIC;
  v_active_tables INT;
  v_seat_club UUID := NULL;
  v_scoped BOOLEAN := public.fn_club_scoped_chips_enabled();
  v_max_tables CONSTANT INT := 4;  -- must equal client MAX_TABLES and MAX_TABLES_PER_HORSE
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Cannot buy in for another user';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));

  SELECT t.club_id, c.union_id, t.min_buy_in, t.max_buy_in
    INTO v_club_id, v_union_id, v_min_buy_in, v_max_buy_in
    FROM tables t
    LEFT JOIN clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id
   LIMIT 1;

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

  IF EXISTS (SELECT 1 FROM table_seats
              WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL) THEN
    RAISE EXCEPTION 'Player already seated at this table';
  END IF;

  SELECT COUNT(*) INTO v_active_tables
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
   WHERE ts.user_id = p_user_id
     AND ts.left_at IS NULL
     AND t.tournament_id IS NULL
     AND t.status NOT IN ('closed', 'deleted');
  IF v_active_tables >= v_max_tables THEN
    RAISE EXCEPTION 'TABLE_CAP_REACHED: already seated at % cash tables (max %)', v_active_tables, v_max_tables;
  END IF;

  IF v_scoped THEN
    -- UNION LAW: chips come OUT OF the club the player is entering under.
    v_seat_club := public.fn_seat_club_for_user(p_user_id, p_table_id, p_club_id);
    IF v_seat_club IS NULL THEN
      RAISE EXCEPTION 'No club membership resolves for this player at this table';
    END IF;

    UPDATE club_members
       SET chip_balance = chip_balance - p_amount,
           updated_at   = NOW()
     WHERE user_id = p_user_id
       AND club_id = v_seat_club
       AND chip_balance >= p_amount
     RETURNING chip_balance INTO v_new_balance;

    IF v_new_balance IS NULL THEN
      RAISE EXCEPTION 'Insufficient club chips for buy-in (club %)', v_seat_club;
    END IF;
  ELSE
    UPDATE wallets
       SET balance    = balance - p_amount,
           updated_at = NOW()
     WHERE user_id     = p_user_id
       AND wallet_type = 'PLAYER'
       AND balance    >= p_amount
     RETURNING balance INTO v_new_balance;
    IF v_new_balance IS NULL THEN
      RAISE EXCEPTION 'Insufficient balance for buy-in';
    END IF;
  END IF;

  DELETE FROM table_seats
   WHERE table_id = p_table_id AND seat_number = p_seat_number AND left_at IS NOT NULL;

  INSERT INTO table_seats (table_id, seat_number, user_id, stack, status, auto_rebuy, club_id)
       VALUES (p_table_id, p_seat_number, p_user_id, p_amount, 'active', p_auto_rebuy, v_seat_club);

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'buyin',
            CASE WHEN v_scoped
                 THEN 'Cash game buy-in (club chips)'
                 ELSE 'Cash game buy-in at table' END,
            p_table_id, v_new_balance);

  UPDATE tables
     SET current_players = (SELECT COUNT(*) FROM table_seats
                             WHERE table_id = p_table_id AND left_at IS NULL)
   WHERE id = p_table_id;
END;
$function$;

-- CASH-OUT -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.atomic_table_cashout(p_user_id uuid, p_table_id uuid, p_seat_number integer DEFAULT NULL::integer)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_stack NUMERIC; v_new_balance NUMERIC; v_seat_club UUID;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Cannot cash out for another user';
  END IF;

  IF p_seat_number IS NOT NULL THEN
    SELECT stack, club_id INTO v_stack, v_seat_club FROM table_seats
      WHERE table_id = p_table_id AND user_id = p_user_id AND seat_number = p_seat_number AND left_at IS NULL
      FOR UPDATE;
  ELSE
    SELECT stack, club_id INTO v_stack, v_seat_club FROM table_seats
      WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
      FOR UPDATE;
  END IF;

  IF NOT FOUND THEN RAISE EXCEPTION 'Active seat not found for cash-out'; END IF;

  IF v_stack > 0 THEN
    -- UNION LAW: chips go back to WHERE THEY CAME FROM. Routed by the seat's
    -- own stamp, never by the current flag — so a legacy seat (club_id NULL)
    -- always returns to the global wallet and can never be stranded.
    IF v_seat_club IS NOT NULL THEN
      UPDATE club_members
         SET chip_balance = COALESCE(chip_balance, 0) + v_stack,
             updated_at   = NOW()
       WHERE user_id = p_user_id AND club_id = v_seat_club
       RETURNING chip_balance INTO v_new_balance;

      IF v_new_balance IS NULL THEN
        -- Membership vanished mid-session: fall back rather than burn chips.
        INSERT INTO wallets (user_id, wallet_type, balance) VALUES (p_user_id, 'PLAYER', v_stack)
          ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + v_stack, updated_at = NOW()
          RETURNING balance INTO v_new_balance;
        INSERT INTO financial_alerts (severity, source, message, context)
        VALUES ('warning', 'atomic_table_cashout',
                'Seat club membership missing at cash-out; chips returned to the global wallet',
                jsonb_build_object('user_id', p_user_id, 'table_id', p_table_id,
                                   'club_id', v_seat_club, 'amount', v_stack));
      END IF;
    ELSE
      INSERT INTO wallets (user_id, wallet_type, balance) VALUES (p_user_id, 'PLAYER', v_stack)
        ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + v_stack, updated_at = NOW()
        RETURNING balance INTO v_new_balance;
    END IF;

    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
      VALUES (p_user_id, 'PLAYER', 'credit', v_stack, 'cashout',
              CASE WHEN v_seat_club IS NOT NULL
                   THEN 'Cash-out to club chips' ELSE 'Cash-out from table' END,
              p_table_id, v_new_balance);
  END IF;

  UPDATE table_seats SET left_at = NOW(), leave_pending = false
    WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
  UPDATE tables SET current_players = (
    SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL
  ) WHERE id = p_table_id;

  RETURN v_stack;
END;
$function$;

