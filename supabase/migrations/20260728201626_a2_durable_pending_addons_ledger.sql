-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260728201626 "a2_durable_pending_addons_ledger"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cd2f151c106615c3f68884cc3fdce241 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- A2 [P1] Mid-hand add-on crash loss.
-- atomic_table_addon(p_apply_to_seat => false) durably debits the wallet, but the
-- chips were held ONLY in the engine's in-memory `pendingAddOns` Map. A crash
-- between the debit and the next hand's processPendingAddOns() = wallet debited,
-- chips never delivered and never refunded (permanent chip loss for the player).
--
-- Fix: a durable ledger row written in the SAME transaction as the wallet debit,
-- plus a resolver RPC that applies/refunds it exactly once.

CREATE TABLE IF NOT EXISTS public.table_pending_addons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id         uuid NOT NULL,
  user_id          uuid NOT NULL,
  amount           numeric NOT NULL CHECK (amount > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  applied_to_stack numeric,
  refunded         numeric
);

-- Deliberately NO foreign key to `tables`: if a table row is deleted while an
-- add-on is unresolved, the money must still be refundable.
COMMENT ON TABLE public.table_pending_addons IS
  'Durable ledger of mid-hand add-ons: wallet already debited, chips not yet delivered. Resolved by resolve_pending_addon(). Intentionally has no FK to tables so the money survives a table delete.';

CREATE INDEX IF NOT EXISTS idx_table_pending_addons_unresolved
  ON public.table_pending_addons (table_id)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_table_pending_addons_unresolved_all
  ON public.table_pending_addons (created_at)
  WHERE resolved_at IS NULL;

ALTER TABLE public.table_pending_addons ENABLE ROW LEVEL SECURITY;
-- No policies: only the engine's service role (which bypasses RLS) may touch it.

-- ---------------------------------------------------------------------------
-- atomic_table_addon: identical name / signature / SECURITY INVOKER (so the
-- guard_wallet_balance_write whitelist entry and every call site keep working).
-- Only change: when the chips are NOT applied to the seat immediately, record a
-- durable pending row in the same transaction as the debit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.atomic_table_addon(p_user_id uuid, p_table_id uuid, p_amount numeric, p_apply_to_seat boolean DEFAULT true)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_balance numeric;
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

-- ---------------------------------------------------------------------------
-- resolve_pending_addon: apply a pending add-on to the seat (capped at the
-- table max buy-in) and refund any excess, exactly once.
--
-- was_resolved = true  -> THIS call performed the resolution
-- was_resolved = false -> the row was already resolved; applied/refunded echo
--                         the values recorded by the call that did resolve it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_pending_addon(p_pending_id uuid, p_max_buy_in numeric DEFAULT NULL)
 RETURNS TABLE(applied numeric, refunded numeric, was_resolved boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row        table_pending_addons%ROWTYPE;
  v_stack      numeric;
  v_headroom   numeric;
  v_applied    numeric := 0;
  v_refunded   numeric := 0;
BEGIN
  SELECT * INTO v_row
    FROM table_pending_addons
   WHERE id = p_pending_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending add-on % not found', p_pending_id;
  END IF;

  IF v_row.resolved_at IS NOT NULL THEN
    -- Idempotent no-op: someone (a retry, a concurrent engine, the recovery
    -- sweep) already resolved this row.
    applied      := COALESCE(v_row.applied_to_stack, 0);
    refunded     := COALESCE(v_row.refunded, 0);
    was_resolved := false;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Lock the seat so a concurrent stack write cannot race the headroom math.
  SELECT stack INTO v_stack
    FROM table_seats
   WHERE table_id = v_row.table_id
     AND user_id  = v_row.user_id
     AND left_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Player is no longer seated: the whole add-on goes back to the wallet.
    v_applied  := 0;
    v_refunded := v_row.amount;
  ELSE
    IF p_max_buy_in IS NULL THEN
      -- NULL max buy-in means "unlimited", NOT "refund everything".
      v_applied := v_row.amount;
    ELSE
      v_headroom := GREATEST(p_max_buy_in - COALESCE(v_stack, 0), 0);
      v_applied  := LEAST(v_row.amount, v_headroom);
    END IF;
    v_refunded := ROUND(v_row.amount - v_applied, 2);
    v_applied  := ROUND(v_applied, 2);

    IF v_applied > 0 THEN
      UPDATE table_seats
         SET stack = COALESCE(stack, 0) + v_applied
       WHERE table_id = v_row.table_id
         AND user_id  = v_row.user_id
         AND left_at IS NULL;
    END IF;
  END IF;

  IF v_refunded > 0 THEN
    -- Delegate the wallet write to atomic_credit_wallet_and_log so the
    -- guard_wallet_balance_write PG_CONTEXT check sees a whitelisted frame,
    -- and so the refund is itself idempotent under retry.
    PERFORM atomic_credit_wallet_and_log(
      v_row.user_id,
      v_refunded,
      'addon_refund',
      'Add-on refund (exceeds max buy-in or seat vacated)',
      v_row.table_id,
      NULL::uuid,
      NULL::uuid,
      'addon_refund:' || v_row.id::text
    );
  END IF;

  UPDATE table_pending_addons
     SET resolved_at      = now(),
         applied_to_stack = v_applied,
         refunded         = v_refunded
   WHERE id = v_row.id;

  applied      := v_applied;
  refunded     := v_refunded;
  was_resolved := true;
  RETURN NEXT;
END;
$function$;
