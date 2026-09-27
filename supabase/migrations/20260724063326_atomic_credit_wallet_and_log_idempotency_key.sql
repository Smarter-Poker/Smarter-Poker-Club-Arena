-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260724063326 "atomic_credit_wallet_and_log_idempotency_key"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cac02d54f63172c137efdbe5bdc77f6f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- STREAM A / Fix 2 (P1): markSeatAsLeft used the non-idempotent
-- atomic_credit_wallet_and_log — a committed-but-timed-out credit preserved the
-- seat and got re-credited on the next leave pass (double-credit / chip mint),
-- the same shape already fixed in atomicCashout. Add an optional idempotency key
-- (same wallet_credit_idempotency gate credit_player_wallet uses). The key is
-- keyed on table_seats.id (cashout:<seat.id>), IDENTICAL to the atomicCashout
-- fix, so a seat cashed out by either path dedupes against the other.
DROP FUNCTION IF EXISTS public.atomic_credit_wallet_and_log(uuid, numeric, text, text, uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.atomic_credit_wallet_and_log(
  p_user_id uuid,
  p_amount numeric,
  p_category text DEFAULT 'credit'::text,
  p_description text DEFAULT ''::text,
  p_table_id uuid DEFAULT NULL::uuid,
  p_hand_id uuid DEFAULT NULL::uuid,
  p_related_entity_id uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_inserted integer;
BEGIN
  -- Idempotency gate (only when a key is supplied). First caller for a key wins;
  -- a committed-but-timed-out retry finds ROW_COUNT=0 and no-ops, so the credit
  -- + log below never runs twice. If the credit fails the whole function txn
  -- (incl. this INSERT) rolls back, so a genuine retry is still allowed.
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO wallet_credit_idempotency (key, user_id, amount)
    VALUES (p_idempotency_key, p_user_id, p_amount)
    ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN
      RETURN true;  -- already credited under this key: idempotent no-op
    END IF;
  END IF;

  UPDATE wallets SET balance = COALESCE(balance, 0) + p_amount, updated_at = now()
  WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
    VALUES (p_user_id, 'PLAYER', p_amount, 0)
    ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + p_amount, updated_at = now();
  END IF;
  IF p_table_id IS NOT NULL THEN SELECT club_id INTO v_club_id FROM tables WHERE id = p_table_id; END IF;
  IF v_club_id IS NULL THEN SELECT club_id INTO v_club_id FROM club_members WHERE user_id = p_user_id LIMIT 1; END IF;
  IF v_club_id IS NULL THEN v_club_id := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid; END IF;
  INSERT INTO chip_transactions (club_id, to_user_id, amount, transaction_type, notes)
  VALUES (v_club_id, p_user_id, p_amount, p_category, COALESCE(NULLIF(p_description, ''), 'Wallet credit'));
  RETURN true;
END; $function$;
