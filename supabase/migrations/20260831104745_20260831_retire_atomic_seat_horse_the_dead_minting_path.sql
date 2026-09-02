-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831104745; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
-- RETIRE atomic_seat_horse — a dead seating path that funded from the WRONG POOL
-- ============================================================================
--
-- WHAT IT WAS. A horse-specific cash-seating RPC that debited `public.wallets`
-- and inserted a `table_seats` row. `public.wallets` is the pool CLAUDE.md 11.5
-- records as frozen since 2026-08-21 with 732,591,994.33 chips stranded in it
-- and nothing reading it. That section ends: "If you find a money path writing
-- to it, that path is broken." This is one.
--
-- WHY IT MATTERS TODAY. Horses are about to be reset to 10,000 chips, and the
-- reset lands on `club_members.chip_balance` — the live pool that
-- `atomic_table_buyin` debits and every cash-out credits. `atomic_seat_horse`
-- reads neither. The 584 horses hold an average of 1,229,703 chips EACH in the
-- legacy pool (718,146,564 in total), so anything that reached this function
-- would have seated a "10,000-chip" horse in any game on the board and the
-- reset would have been invisible to it.
--
-- WHY IT IS SAFE TO DROP, measured rather than assumed:
--   * no TypeScript caller — the fleet seats through `atomic_table_buyin`;
--   * no DB caller: the single reference is its own name inside the
--     `guard_wallet_balance_write` allowlist, which is a string, not a call;
--   * no anon or authenticated EXECUTE grant;
--   * zero rows in 30 days matching its audit signature
--     (`wallet_transactions.description LIKE 'Buy-in at %'`).
--
-- It is dead code that mints, which is worse than dead code: the cost of it
-- existing is zero until the day somebody wires it back up.
--
-- The allowlist entry is deliberately LEFT IN PLACE. Editing
-- `guard_wallet_balance_write` means touching the trigger that protects every
-- wallet write on the platform, and an allowlist naming a function that no
-- longer exists is inert. Risk without benefit is not a tidy-up.
-- ============================================================================

DO $$
DECLARE
  v_ts_callers integer;
  v_recent     integer;
BEGIN
  -- Re-assert the two facts this migration rests on, at apply time.
  SELECT count(*) INTO v_ts_callers
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND p.proname <> 'atomic_seat_horse'
     AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
     AND p.prosrc ILIKE '%atomic_seat_horse(%';
  IF v_ts_callers > 0 THEN
    RAISE EXCEPTION
      'ABORT: % database function(s) actually CALL atomic_seat_horse', v_ts_callers;
  END IF;

  SELECT count(*) INTO v_recent
    FROM wallet_transactions
   WHERE description LIKE 'Buy-in at %'
     AND created_at > now() - interval '30 days';
  IF v_recent > 0 THEN
    RAISE EXCEPTION
      'ABORT: atomic_seat_horse wrote % row(s) in the last 30 days; it is not dead', v_recent;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.atomic_seat_horse(uuid, uuid, integer, numeric, text, uuid);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'atomic_seat_horse'
  ) THEN
    RAISE EXCEPTION 'POST-APPLY: atomic_seat_horse still exists';
  END IF;
END $$;

-- ============================================================================
-- ROLLBACK (paste and run to restore the function exactly as it was)
-- ============================================================================
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

