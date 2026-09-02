-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826151027; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- CHIP DESTRUCTION, FOUND 2026-08-26 by reading fn_unaccounted_seat_exits().
--
-- Exit 7458: user a916c222 at 12:55 UTC.
--   12:55:23.452  debit  25.90  'Table add-on (club wallet)'
--   12:55:24.529  credit 19.10  'Cash-out from table'
--   12:55:25.419  seat vacated holding a stack of 45.00  (19.10 + 25.90)
-- The player paid 25.90 for an add-on and was refunded 19.10. The 25.90 is gone.
--
-- ROOT CAUSE, in atomic_table_addon:
--   1. It reads the seat WITHOUT `FOR UPDATE`, so it does not serialise against
--      atomic_table_cashout, which does take that lock. Add-on and cash-out
--      could interleave on the same seat row.
--   2. Its `UPDATE table_seats SET stack = stack + p_amount ... AND left_at IS
--      NULL` has NO ROW_COUNT check. When the seat is vacated between the read
--      and that update, the update matches zero rows -- and the function still
--      commits the club_members debit and writes the wallet_transaction. The
--      chips leave the wallet and land nowhere. That is the exact shape of the
--      2026-08-25 incident, from a different direction.
--
-- The engine already knew about this class of bug. The comment above the call
-- site in server/src/engine/ServerTableEngineSeating.ts reads "the chips while
-- the wallet stayed debited. The mid-hand branch has been covered by the
-- table_pending_addons ledger since the A2 fix; this branch had nothing."
-- p_apply_to_seat = true is "this branch". It now has something.
--
-- THREE CHANGES, and nothing else in the body is touched:
--   a. auth.uid() guard, matching atomic_table_cashout's. The only caller is
--      the Hetzner engine on the service role, where auth.uid() is NULL, so the
--      guard is inert for it and closes the function to a logged-in caller
--      passing somebody else's p_user_id.
--   b. FOR UPDATE on the seat read, so add-on and cash-out queue on one lock.
--   c. GET DIAGNOSTICS on the seat update. Zero rows now RAISES, which rolls
--      back the debit and the idempotency claim. A player sees an error instead
--      of silently losing chips. Loud beats lossy.
--
-- ROLLBACK: restore the definition captured at
-- 20260826_addon_prior_definition in this migration's header comment, or
-- re-apply the previous body from pg_get_functiondef output taken before this
-- migration (recorded in .agent/audits/2026-08-26-addon-debits-without-applying.md).

CREATE OR REPLACE FUNCTION public.atomic_table_addon(p_user_id uuid, p_table_id uuid, p_amount numeric, p_apply_to_seat boolean DEFAULT true, p_idempotency_key text DEFAULT NULL::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_new_balance numeric; v_claimed integer; v_seat_club uuid; v_seat_rows integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Add-on amount must be positive';
  END IF;

  -- (a) Added 2026-08-26. Inert for the service role, which is the only caller.
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Cannot add on for another user';
  END IF;

  -- (b) FOR UPDATE added 2026-08-26 so this serialises with atomic_table_cashout.
  SELECT ts.club_id INTO v_seat_club
    FROM table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not seated at this table'; END IF;

  IF v_seat_club IS NULL THEN
    v_seat_club := public.fn_seat_club_for_user(p_user_id, p_table_id, NULL);
  END IF;
  IF v_seat_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this add-on';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO table_addon_idempotency (key, user_id, table_id, amount, applied_to_seat)
    VALUES (p_idempotency_key, p_user_id, p_table_id, p_amount, p_apply_to_seat)
    ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    IF v_claimed = 0 THEN
      SELECT chip_balance INTO v_new_balance FROM club_members
       WHERE user_id = p_user_id AND club_id = v_seat_club;
      RETURN v_new_balance;
    END IF;
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_seat_club);

  UPDATE club_members
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_seat_club AND chip_balance >= p_amount
   RETURNING chip_balance INTO v_new_balance;
  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient club chips for add-on (club %)', v_seat_club;
  END IF;

  IF p_apply_to_seat THEN
    UPDATE table_seats SET stack = stack + p_amount
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
    -- (c) Added 2026-08-26. Without this the debit above stands alone.
    GET DIAGNOSTICS v_seat_rows = ROW_COUNT;
    IF v_seat_rows = 0 THEN
      RAISE EXCEPTION
        'Add-on of % could not be applied: seat vacated mid-add-on (table %, player %)',
        p_amount, p_table_id, p_user_id;
    END IF;
  ELSE
    INSERT INTO table_pending_addons (table_id, user_id, amount)
    VALUES (p_table_id, p_user_id, p_amount);
  END IF;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'addon',
            'Table add-on (club wallet)', p_table_id, v_new_balance);

  RETURN v_new_balance;
END;
$function$;

-- Seat-money functions the engine owns are closed to browser callers.
-- atomic_table_addon and resolve_pending_addon have exactly one call site each,
-- both in server/src/engine/ServerTableEngineSeating.ts on the service role.
-- atomic_table_cashout has no call site in either repo.
-- fn_leave_seat_and_refund IS called from the browser (src/pages/TablePage.tsx)
-- so `authenticated` keeps it; `anon` has no business leaving a seat.
REVOKE EXECUTE ON FUNCTION public.atomic_table_addon(uuid, uuid, numeric, boolean, text) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.resolve_pending_addon(uuid, numeric) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.atomic_table_cashout(uuid, uuid, integer) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_leave_seat_and_refund(uuid) FROM anon;

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef('public.atomic_table_addon(uuid,uuid,numeric,boolean,text)'::regprocedure) INTO v_def;

  IF v_def NOT ILIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'atomic_table_addon did not keep the FOR UPDATE lock';
  END IF;
  IF v_def NOT ILIKE '%v_seat_rows = ROW_COUNT%' THEN
    RAISE EXCEPTION 'atomic_table_addon did not keep the applied-rows assertion';
  END IF;
  IF v_def NOT ILIKE '%Cannot add on for another user%' THEN
    RAISE EXCEPTION 'atomic_table_addon did not keep the auth.uid() guard';
  END IF;

  IF has_function_privilege('authenticated',
       'public.atomic_table_addon(uuid,uuid,numeric,boolean,text)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'atomic_table_addon is still executable by authenticated';
  END IF;

  IF NOT has_function_privilege('authenticated',
       'public.fn_leave_seat_and_refund(uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'fn_leave_seat_and_refund lost EXECUTE for authenticated - the browser leave path would break';
  END IF;
END
$$;
