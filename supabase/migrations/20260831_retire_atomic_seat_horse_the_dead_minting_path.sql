-- Applied to production 2026-08-31 via Supabase MCP apply_migration.
-- See docs/changelog/2026-08-31-bankroll-the-loop-that-closes.md section 1.
--
-- atomic_seat_horse debited public.wallets - the pool CLAUDE.md 11.5 records as
-- frozen since 2026-08-21 with nothing reading it, and whose section ends "if
-- you find a money path writing to it, that path is broken". Horses hold an
-- average of 1,229,703 chips EACH in that pool (718,146,564 total), so anything
-- reaching this function would have seated a "10,000-chip" horse in any game on
-- the board and made today's reset invisible to it.
--
-- Dead, measured rather than assumed: no TypeScript caller (the fleet seats
-- through atomic_table_buyin), no DB caller (its only mention is its own name
-- inside the guard_wallet_balance_write allowlist, a string not a call), no
-- anon/authenticated EXECUTE, and zero rows in 30 days matching its audit
-- signature. Both facts are re-asserted below at apply time.

DO $$
DECLARE
  v_ts_callers integer;
  v_recent     integer;
BEGIN
  SELECT count(*) INTO v_ts_callers
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND p.proname <> 'atomic_seat_horse'
     AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
     AND p.prosrc ILIKE '%atomic_seat_horse(%';
  IF v_ts_callers > 0 THEN
    RAISE EXCEPTION 'ABORT: % database function(s) actually CALL atomic_seat_horse', v_ts_callers;
  END IF;

  SELECT count(*) INTO v_recent
    FROM wallet_transactions
   WHERE description LIKE 'Buy-in at %' AND created_at > now() - interval '30 days';
  IF v_recent > 0 THEN
    RAISE EXCEPTION 'ABORT: atomic_seat_horse wrote % row(s) in the last 30 days; it is not dead', v_recent;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.atomic_seat_horse(uuid, uuid, integer, numeric, text, uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'atomic_seat_horse') THEN
    RAISE EXCEPTION 'POST-APPLY: atomic_seat_horse still exists';
  END IF;
END $$;

-- ROLLBACK (paste and run to restore it exactly as it was)
-- CREATE OR REPLACE FUNCTION public.atomic_seat_horse(p_horse_id uuid, p_table_id uuid,
--   p_seat_number integer, p_buy_in numeric, p_table_name text DEFAULT ''::text,
--   p_club_id uuid DEFAULT NULL::uuid)
--  RETURNS boolean LANGUAGE plpgsql SET search_path TO 'public'
-- AS $function$
-- DECLARE v_balance NUMERIC;
-- BEGIN
--     SELECT balance INTO v_balance FROM wallets
--     WHERE user_id = p_horse_id AND wallet_type = 'PLAYER' FOR UPDATE;
--     IF v_balance IS NULL OR v_balance < p_buy_in THEN RETURN FALSE; END IF;
--     UPDATE wallets SET balance = balance - p_buy_in, updated_at = NOW()
--     WHERE user_id = p_horse_id AND wallet_type = 'PLAYER';
--     INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description)
--     VALUES (p_horse_id, 'PLAYER', 'debit', p_buy_in, 'buyin',
--             'Buy-in at ' || COALESCE(p_table_name, 'table') || ': ' || p_buy_in || ' chips');
--     INSERT INTO table_seats (table_id, user_id, seat_number, stack, status, joined_at)
--     VALUES (p_table_id, p_horse_id, p_seat_number, p_buy_in, 'active', NOW());
--     UPDATE tables SET current_players = (
--         SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL
--     ) WHERE id = p_table_id;
--     RETURN TRUE;
-- EXCEPTION WHEN unique_violation THEN
--     UPDATE wallets SET balance = balance + p_buy_in, updated_at = NOW()
--     WHERE user_id = p_horse_id AND wallet_type = 'PLAYER';
--     RETURN FALSE;
-- END;
-- $function$;
