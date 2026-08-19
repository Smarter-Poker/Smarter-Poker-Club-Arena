-- 20260819_per_user_concurrent_table_cap.sql
--
-- MULTI-TABLE SERVER AUDIT (2026-08-19): per-USER concurrent-table cap,
-- enforced where seats are actually taken.
--
-- THE HOLE: the 4-table limit existed only in the client (MultiTablePage
-- MAX_TABLES=4) and in HorseFleetManager's in-memory candidate filter. The
-- engine server has NO join route at all — a human sits down by calling this
-- RPC straight from the browser (TablePage.tsx → rpc('atomic_table_buyin')).
-- A modified client, or anyone with the publishable key and a JWT, could
-- therefore sit at UNLIMITED tables: the engines rebuild seating from
-- table_seats every hand, so every extra seat is dealt in. For horses, the
-- fleet cap is advisory (an in-memory map, raceable across the two-container
-- deploys that motivated table leases in 20260816_engine_table_leases.sql).
--
-- THE FIX, at the root (this function IS the seat-taking path for humans AND
-- horses):
--   1. pg_advisory_xact_lock on the user id serializes THIS USER's buy-ins,
--      so the count-then-insert below cannot race with itself. Two concurrent
--      5th-table attempts queue on the lock; the second sees the first's
--      committed seat and is rejected. No window. (An advisory count in the
--      Node layer was rejected precisely because it races; a unique/partial
--      index cannot express a COUNT, so the transactional lock is the guard.)
--   2. Active seats are counted across OPEN tables only (status not
--      closed/deleted), tournament and cash alike — matching what the client
--      rebuilds its tiles from (table_seats WHERE left_at IS NULL).
--   3. The 5th sit-down fails with 'TABLE_CAP_REACHED: ...' BEFORE any money
--      moves. Clients can match on the TABLE_CAP_REACHED prefix.
--
-- KNOWN BYPASSES (deliberate, documented):
--   * Tournament seating (TournamentManagerBase/TournamentManager) INSERTs
--     table_seats directly with service_role. That path is server-driven
--     placement of an already-paid entrant — failing it would strand a paid
--     seat mid-shuffle (table balancing re-seats players constantly), so the
--     cap does NOT gate it. Those seats still COUNT toward the cap for the
--     player's next cash sit-down.
--   * fn_admin_kick / admin tooling operate on existing seats only.
--
-- ALSO CLOSED HERE: p_user_id was fully caller-controlled. Any authenticated
-- browser could debit ANOTHER user's wallet and seat them (SECURITY DEFINER
-- bypasses RLS; EXECUTE is granted to authenticated). A JWT caller may now
-- only buy THEMSELF in; service_role calls (horse fleet — no auth.uid()) are
-- unaffected.
--
-- Body is otherwise the 20260415_bug_018_balance_after.sql version, verbatim.

CREATE OR REPLACE FUNCTION public.atomic_table_buyin(
  p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_new_balance NUMERIC;
  v_active_tables INT;
  v_max_tables CONSTANT INT := 4;  -- must equal client MAX_TABLES (MultiTablePage) and MAX_TABLES_PER_HORSE
BEGIN
  -- Identity guard: a JWT caller may only seat themself. service_role /
  -- postgres sessions have auth.uid() IS NULL and pass (horse fleet path).
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'FORBIDDEN: cannot buy in another user';
  END IF;

  -- Serialize this user's sit-downs for the duration of the transaction.
  -- Key derived from the uuid text; hashtextextended gives a bigint key.
  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));

  IF EXISTS (SELECT 1 FROM table_seats WHERE table_id = p_table_id AND user_id = p_user_id::text AND left_at IS NULL) THEN
    RAISE EXCEPTION 'Player already seated at this table';
  END IF;

  -- Per-user concurrent-table cap. Seats at closed/deleted tables are stale
  -- bookkeeping, not live play — they do not count.
  SELECT COUNT(*) INTO v_active_tables
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
   WHERE ts.user_id = p_user_id::text
     AND ts.left_at IS NULL
     AND t.status NOT IN ('closed', 'deleted');
  IF v_active_tables >= v_max_tables THEN
    RAISE EXCEPTION 'TABLE_CAP_REACHED: already seated at % tables (max %)', v_active_tables, v_max_tables;
  END IF;

  UPDATE wallets SET balance = balance - p_amount, updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = 'PLAYER' AND balance >= p_amount
    RETURNING balance INTO v_new_balance;
  IF v_new_balance IS NULL THEN RAISE EXCEPTION 'Insufficient balance for buy-in'; END IF;

  DELETE FROM table_seats WHERE table_id = p_table_id AND seat_number = p_seat_number AND left_at IS NOT NULL;
  INSERT INTO table_seats (table_id, seat_number, user_id, stack, status, auto_rebuy)
    VALUES (p_table_id, p_seat_number, p_user_id::text, p_amount, 'active', p_auto_rebuy);

  INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', -p_amount, 'buyin', 'Cash game buy-in at table', p_table_id, v_new_balance);

  UPDATE tables SET current_players = (
    SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL
  ) WHERE id = p_table_id;
END;
$$;

COMMENT ON FUNCTION public.atomic_table_buyin(uuid, uuid, integer, numeric, boolean) IS
  'MULTI-TABLE AUDIT 2026-08-19 — per-user 4-table cap (TABLE_CAP_REACHED), advisory-xact-lock serialized; JWT callers may only seat themselves. Previous: BUG 018 balance_after fix.';
