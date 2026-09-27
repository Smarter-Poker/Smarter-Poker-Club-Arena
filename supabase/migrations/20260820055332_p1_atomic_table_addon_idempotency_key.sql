-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820055332 "p1_atomic_table_addon_idempotency_key"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b0378d06c25e35b82546209af79ac3ff of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- P1: a between-hands add-on could be charged and then erased.
--
-- atomic_table_addon(p_apply_to_seat => true) debits the wallet AND bumps
-- table_seats.stack in one transaction. If that transaction COMMITS but the
-- response never reaches the engine, addChips reports failure and never does
-- `player.stack += applied` -- so the engine's in-memory stack does not know
-- about the chips. syncStacks then writes `stack` ABSOLUTELY from engine memory
-- at the end of the next hand, erasing them from table_seats while the wallet
-- stays debited. The player is charged and gets nothing.
--
-- The mid-hand branch was fixed earlier today by the table_pending_addons
-- ledger, but that ledger row is only written when p_apply_to_seat is false, so
-- the between-hands branch had no protection at all.
--
-- Fix: an optional idempotency key, following the same convention as
-- credit_player_wallet / atomic_credit_wallet_and_log. With a key, the caller
-- can safely RETRY: a first attempt that committed makes the retry a no-op that
-- returns the current balance, so the engine learns the chips landed and can
-- update its own view instead of silently dropping them.
--
-- The parameter is optional and appended last, so every existing call site and
-- the guard_wallet_balance_write whitelist entry keep working untouched.

CREATE TABLE IF NOT EXISTS public.table_addon_idempotency (
  key             text PRIMARY KEY,
  user_id         uuid NOT NULL,
  table_id        uuid NOT NULL,
  amount          numeric NOT NULL,
  applied_to_seat boolean NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.table_addon_idempotency IS
  'P1: claim ledger for atomic_table_addon. A key present here means that add-on was already charged, so a retry must not debit again.';

CREATE INDEX IF NOT EXISTS idx_table_addon_idem_created
  ON public.table_addon_idempotency (created_at);

ALTER TABLE public.table_addon_idempotency ENABLE ROW LEVEL SECURITY;
-- No policies: engine service role only.

CREATE OR REPLACE FUNCTION public.atomic_table_addon(
  p_user_id uuid,
  p_table_id uuid,
  p_amount numeric,
  p_apply_to_seat boolean DEFAULT true,
  p_idempotency_key text DEFAULT NULL
)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_balance numeric;
  v_claimed integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Add-on amount must be positive';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM table_seats
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
  ) THEN
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
      SELECT balance INTO v_new_balance
        FROM wallets
       WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
      RETURN v_new_balance;
    END IF;
  END IF;

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

  IF p_apply_to_seat THEN
    UPDATE table_seats
       SET stack = stack + p_amount
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
  ELSE
    -- A2 FIX: the chips are queued (mid-hand). Persist them durably in the same
    -- transaction as the debit so a crash can never destroy them.
    INSERT INTO table_pending_addons (table_id, user_id, amount)
    VALUES (p_table_id, p_user_id, p_amount);
  END IF;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', -p_amount, 'addon',
            'Table add-on (top-up)', p_table_id, v_new_balance);

  RETURN v_new_balance;
END;
$function$;
