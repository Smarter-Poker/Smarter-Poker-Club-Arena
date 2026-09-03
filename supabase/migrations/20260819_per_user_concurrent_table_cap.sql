-- 20260819_per_user_concurrent_table_cap.sql
-- APPLIED TO PRODUCTION 2026-08-19 via Supabase MCP (migration name:
-- per_user_concurrent_table_cap). This file mirrors EXACTLY what was applied.
--
-- DRIFT WARNING (why this file was rewritten before applying): the first
-- draft was written against the stale 20260415 body and would have REVERTED
-- three later production changes (the auth.uid() identity guard, the Round 78
-- club/union blacklist gate, and the P1-2 min/max buy-in enforcement) and
-- would not even have run: table_seats.user_id is uuid, and the draft
-- compared it to p_user_id::text (operator uuid = text does not exist).
-- Lesson repeated all audit long: verify against the LIVE definition
-- (pg_get_functiondef), never against the last migration file.
--
-- WHAT THIS ADDS (only these two things; everything else is the live body,
-- byte-identical):
--   1. pg_advisory_xact_lock keyed on the user serializes that user's
--      sit-downs, so count-then-insert cannot race with itself.
--   2. Per-user cap: active seats (left_at IS NULL) at open tables,
--      tournament and cash alike; the 5th sit-down raises
--      'TABLE_CAP_REACHED: ...' before any money moves.
-- Deliberate bypass: tournament balancing INSERTs seats directly with
-- service_role (server-driven placement of a paid entrant); those seats still
-- COUNT toward the player's next cash sit-down.
--
-- LIVE-TESTED 2026-08-19 in a rolled-back transaction against production:
-- seatless funded user seated at 4 open tables, 5th rejected with
-- TABLE_CAP_REACHED, identity/blacklist/minmax gates all still present.

CREATE OR REPLACE FUNCTION public.atomic_table_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean DEFAULT false)
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
  v_max_tables CONSTANT INT := 4;  -- must equal client MAX_TABLES and MAX_TABLES_PER_HORSE
BEGIN
  -- SECURITY DEFINER identity guard: a JWT caller may only act as themselves.
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Cannot buy in for another user';
  END IF;

  -- MULTI-TABLE CAP: serialize this user's sit-downs for the transaction so
  -- the count below cannot race with a concurrent buy-in by the same user.
  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));

  -- Round 78: blacklist gate. Resolve table's club + optional union, then
  -- check for an active ban on either scope.
  SELECT t.club_id, c.union_id, t.min_buy_in, t.max_buy_in
    INTO v_club_id, v_union_id, v_min_buy_in, v_max_buy_in
    FROM tables t
    LEFT JOIN clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id
   LIMIT 1;

  -- AUDIT P1-2 (buy-in) FIX: server-side buy-in min/max enforcement.
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
              WHERE table_id = p_table_id
                AND user_id  = p_user_id
                AND left_at IS NULL) THEN
    RAISE EXCEPTION 'Player already seated at this table';
  END IF;

  -- MULTI-TABLE CAP: active seats at open tables, tournament and cash alike.
  -- Seats at closed/deleted tables are stale bookkeeping, not live play.
  SELECT COUNT(*) INTO v_active_tables
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
   WHERE ts.user_id = p_user_id
     AND ts.left_at IS NULL
     AND t.status NOT IN ('closed', 'deleted');
  IF v_active_tables >= v_max_tables THEN
    RAISE EXCEPTION 'TABLE_CAP_REACHED: already seated at % tables (max %)', v_active_tables, v_max_tables;
  END IF;

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

  DELETE FROM table_seats
   WHERE table_id    = p_table_id
     AND seat_number = p_seat_number
     AND left_at IS NOT NULL;

  INSERT INTO table_seats (table_id, seat_number, user_id, stack, status, auto_rebuy)
       VALUES (p_table_id, p_seat_number, p_user_id, p_amount, 'active', p_auto_rebuy);

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'buyin',
            'Cash game buy-in at table', p_table_id, v_new_balance);

  UPDATE tables
     SET current_players = (
       SELECT COUNT(*) FROM table_seats
        WHERE table_id = p_table_id AND left_at IS NULL
     )
   WHERE id = p_table_id;
END;
$function$;

COMMENT ON FUNCTION public.atomic_table_buyin(uuid, uuid, integer, numeric, boolean) IS
  'MULTI-TABLE CAP 2026-08-19: per-user 4-table cap (TABLE_CAP_REACHED), advisory-xact-lock serialized. Retains identity guard, Round 78 blacklist gate, P1-2 min/max enforcement, BUG 018 balance_after.';
