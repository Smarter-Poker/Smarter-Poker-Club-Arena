-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260423235007 "20260421090000_bug15_atomic_table_buyin_uuid_cast_drift"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 84ec5e31d9a7350e873c0bf4b296c115 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG-15: atomic_table_buyin — uuid::text cast drift
--
-- table_seats.user_id is type UUID. The function still casts p_user_id
-- (already UUID) to ::text in two places:
--   1) The "player already seated" EXISTS SELECT (42883 uuid = text)
--   2) The INSERT INTO table_seats VALUES clause (42804 column is uuid
--      but expression is text)
--
-- Both are schema-drift bugs: someone changed table_seats.user_id from
-- text → uuid (likely the phase31_schema_drift_user_id_text_to_uuid
-- migration earlier in the arc) but didn't sweep this function.
--
-- Impact: EVERY buyin into a real-chip table 500s. This function is
-- called by pages/api/club-arena/buyin.js (per earlier grep in session).
-- High-severity — breaks all Club Arena cash-game buy-ins.
--
-- Fix: drop both ::text casts. Function is otherwise identical.
-- BUG-018 balance_after fix and auto_rebuy plumbing preserved.

CREATE OR REPLACE FUNCTION public.atomic_table_buyin(
  p_user_id     uuid,
  p_table_id    uuid,
  p_seat_number integer,
  p_amount      numeric,
  p_auto_rebuy  boolean DEFAULT false
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_new_balance NUMERIC;
BEGIN
  IF EXISTS (SELECT 1 FROM table_seats
              WHERE table_id = p_table_id
                AND user_id  = p_user_id           -- was p_user_id::text
                AND left_at IS NULL) THEN
    RAISE EXCEPTION 'Player already seated at this table';
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
  --                                      ^^^^^^^^^  was p_user_id::text

  -- BUG-018 fix preserved: balance_after populated
  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', -p_amount, 'buyin',
            'Cash game buy-in at table', p_table_id, v_new_balance);

  UPDATE tables
     SET current_players = (
       SELECT COUNT(*) FROM table_seats
        WHERE table_id = p_table_id AND left_at IS NULL
     )
   WHERE id = p_table_id;
END;
$function$;
