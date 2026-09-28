-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260415203604 as "bug_018_log_wallet_transaction_balance_after"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- BUG 018 FIX — wallet_transactions.balance_after was NULL on ALL 1.95M rows ever written
-- Cause: log_wallet_transaction (two overloads) omits balance_after from INSERT.
-- Fix: both overloads now read the current wallet balance AFTER the prior mutation
--      (caller is expected to have already applied the credit/debit) and record it.
-- NOTE: if caller has not yet mutated the wallet, balance_after reflects pre-state — acceptable audit trail,
--       better than NULL which gives no reconciliation signal at all.

CREATE OR REPLACE FUNCTION public.log_wallet_transaction(
  p_user_id uuid, p_wallet_type text, p_amount numeric, p_type text, p_category text, p_description text DEFAULT NULL::text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE v_id UUID; v_bal NUMERIC;
BEGIN
  SELECT balance INTO v_bal FROM wallets WHERE user_id = p_user_id AND wallet_type = p_wallet_type;
  INSERT INTO wallet_transactions (user_id, wallet_type, amount, type, category, description, balance_after)
  VALUES (p_user_id, p_wallet_type, p_amount, p_type, p_category, p_description, COALESCE(v_bal, 0))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_wallet_transaction(
  p_user_id uuid, p_wallet_type text, p_amount numeric, p_type text, p_category text, p_description text,
  p_table_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_related_entity_id uuid DEFAULT NULL::uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE v_bal NUMERIC;
BEGIN
  SELECT balance INTO v_bal FROM wallets WHERE user_id = p_user_id AND wallet_type = p_wallet_type;
  INSERT INTO wallet_transactions (user_id, wallet_type, amount, type, category, description, table_id, hand_id, related_entity_id, balance_after, created_at)
  VALUES (p_user_id, p_wallet_type, p_amount, p_type, p_category, p_description, p_table_id, p_hand_id, p_related_entity_id, COALESCE(v_bal, 0), NOW());
END;
$$;

COMMENT ON FUNCTION public.log_wallet_transaction(uuid, text, numeric, text, text, text) IS
  'BUG 018 FIX 2026-04-15 — now reads wallets.balance and writes balance_after so audit rows are reconcilable. Caller should mutate wallets BEFORE calling this.';
COMMENT ON FUNCTION public.log_wallet_transaction(uuid, text, numeric, text, text, text, uuid, uuid, uuid) IS
  'BUG 018 FIX 2026-04-15 — now reads wallets.balance and writes balance_after so audit rows are reconcilable. Caller should mutate wallets BEFORE calling this.';
