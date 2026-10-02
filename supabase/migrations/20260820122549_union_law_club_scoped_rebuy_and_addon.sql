-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820122549 "union_law_club_scoped_rebuy_and_addon"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e7ff24a1a5fd373023a0e12f1222d2d4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- UNION LAW — CLUB-SCOPED REBUY AND ADD-ON (2026-08-20, pass 3)
--
-- GAP FOUND: buy-in and cash-out now use club chips, but atomic_table_rebuy and
-- atomic_table_addon still debited the single global player wallet. Because
-- cash-out returns the WHOLE stack to the seat's club, a player who bought in
-- with club chips and then rebought from the global wallet silently moved money
-- out of the global wallet into a club wallet — a direct breach of "each wallet
-- for each club is 100% separate and never commingled". It also meant a player
-- with club chips but an empty global wallet could not top up at all.
--
-- Both now route by the SEAT'S OWN STAMP, exactly like cash-out: chips added to
-- a seat come from the same wallet the seat was bought from. Legacy seats
-- (club_id NULL) keep using the global wallet, so nothing in flight breaks and
-- every seat stays internally consistent from buy-in through cash-out.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.atomic_table_rebuy(p_user_id uuid, p_table_id uuid, p_amount numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_balance numeric;
  v_club_id uuid;
  v_union_id uuid;
  v_ban_id uuid;
  v_seat_club uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Rebuy amount must be positive';
  END IF;

  SELECT ts.club_id INTO v_seat_club
    FROM table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not seated at this table (cannot rebuy a vacated seat)';
  END IF;

  SELECT t.club_id, c.union_id INTO v_club_id, v_union_id
    FROM tables t LEFT JOIN clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id LIMIT 1;
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

  -- UNION LAW: top up from the SAME wallet the seat was bought from.
  IF v_seat_club IS NOT NULL THEN
    UPDATE club_members
       SET chip_balance = chip_balance - p_amount, updated_at = NOW()
     WHERE user_id = p_user_id AND club_id = v_seat_club AND chip_balance >= p_amount
     RETURNING chip_balance INTO v_new_balance;
    IF v_new_balance IS NULL THEN
      RAISE EXCEPTION 'Insufficient club chips for rebuy (club %)', v_seat_club;
    END IF;
  ELSE
    UPDATE wallets
       SET balance = balance - p_amount, updated_at = NOW()
     WHERE user_id = p_user_id AND wallet_type = 'PLAYER' AND balance >= p_amount
     RETURNING balance INTO v_new_balance;
    IF v_new_balance IS NULL THEN
      RAISE EXCEPTION 'Insufficient balance for rebuy';
    END IF;
  END IF;

  UPDATE table_seats
     SET stack = stack + p_amount
   WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'rebuy',
            CASE WHEN v_seat_club IS NOT NULL
                 THEN 'Cash game rebuy (club chips)'
                 ELSE 'Cash game rebuy at table' END,
            p_table_id, v_new_balance);

  RETURN v_new_balance;
END;
$function$;

CREATE OR REPLACE FUNCTION public.atomic_table_addon(p_user_id uuid, p_table_id uuid, p_amount numeric, p_apply_to_seat boolean DEFAULT true, p_idempotency_key text DEFAULT NULL::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_balance numeric;
  v_claimed integer;
  v_seat_club uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Add-on amount must be positive';
  END IF;

  SELECT ts.club_id INTO v_seat_club
    FROM table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not seated at this table';
  END IF;

  -- Claim the attempt. A key already present means a previous attempt committed
  -- (possibly one whose response the caller never saw), so this call must move
  -- no money at all and simply report the balance as it stands.
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO table_addon_idempotency (key, user_id, table_id, amount, applied_to_seat)
    VALUES (p_idempotency_key, p_user_id, p_table_id, p_amount, p_apply_to_seat)
    ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    IF v_claimed = 0 THEN
      IF v_seat_club IS NOT NULL THEN
        SELECT chip_balance INTO v_new_balance FROM club_members
         WHERE user_id = p_user_id AND club_id = v_seat_club;
      ELSE
        SELECT balance INTO v_new_balance FROM wallets
         WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
      END IF;
      RETURN v_new_balance;
    END IF;
  END IF;

  -- UNION LAW: top up from the SAME wallet the seat was bought from.
  IF v_seat_club IS NOT NULL THEN
    UPDATE club_members
       SET chip_balance = chip_balance - p_amount, updated_at = NOW()
     WHERE user_id = p_user_id AND club_id = v_seat_club AND chip_balance >= p_amount
     RETURNING chip_balance INTO v_new_balance;
    IF v_new_balance IS NULL THEN
      RAISE EXCEPTION 'Insufficient club chips for add-on (club %)', v_seat_club;
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
      RAISE EXCEPTION 'Insufficient balance for add-on';
    END IF;
  END IF;

  IF p_apply_to_seat THEN
    UPDATE table_seats
       SET stack = stack + p_amount
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
  ELSE
    INSERT INTO table_pending_addons (table_id, user_id, amount)
    VALUES (p_table_id, p_user_id, p_amount);
  END IF;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'addon',
            CASE WHEN v_seat_club IS NOT NULL
                 THEN 'Table add-on (club chips)'
                 ELSE 'Table add-on (top-up)' END,
            p_table_id, v_new_balance);

  RETURN v_new_balance;
END;
$function$;

