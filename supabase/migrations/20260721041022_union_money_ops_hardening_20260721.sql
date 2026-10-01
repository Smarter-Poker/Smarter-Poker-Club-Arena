-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721041022 "union_money_ops_hardening_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4a8c19bc99f827b2629a8fd01c02645d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- UNION MONEY OPS HARDENING (see repo migration file for full commentary)

DROP INDEX IF EXISTS uq_union_wallet_tx_bbj_payout;
CREATE UNIQUE INDEX IF NOT EXISTS uq_union_wallet_tx_op
  ON public.union_wallet_transactions (union_id, tx_type, period_id)
  WHERE period_id IS NOT NULL
    AND tx_type IN ('bbj_payout', 'manual_transfer', 'rake_to_chips', 'owner_deposit', 'clawback', 'bbj_fund');

-- Drop old signatures so we don't leave ambiguous overloads.
DROP FUNCTION IF EXISTS public.fn_union_deposit_from_wallet(uuid, numeric, text);
DROP FUNCTION IF EXISTS public.fn_union_clawback_from_club(uuid, uuid, numeric, text);
DROP FUNCTION IF EXISTS public.fn_union_fund_bbj_pool(uuid, numeric, numeric, numeric, numeric, text, uuid);

CREATE OR REPLACE FUNCTION public.fn_union_send_to_club_atomic(
  p_union_id uuid,
  p_club_id uuid,
  p_amount numeric,
  p_notes text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL,
  p_op_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_balance numeric;
  v_after numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM union_clubs uc WHERE uc.union_id = p_union_id AND uc.club_id = p_club_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'club is not in this union');
  END IF;

  SELECT chip_balance INTO v_balance FROM union_wallets
   WHERE union_id = p_union_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union wallet not found');
  END IF;
  IF v_balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient union balance',
                              'balance', v_balance, 'requested', p_amount);
  END IF;

  UPDATE union_wallets
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE union_id = p_union_id
   RETURNING chip_balance INTO v_after;

  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) + p_amount
   WHERE id = p_club_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'club % not found', p_club_id;
  END IF;

  INSERT INTO union_wallet_transactions (
    union_id, wallet, direction, amount, balance_after, tx_type, club_id, period_id, notes, created_by
  ) VALUES (
    p_union_id, 'chip_balance', 'debit', p_amount, v_after, 'manual_transfer',
    p_club_id, p_op_id, COALESCE(NULLIF(p_notes, ''), 'Union transfer to club'), p_created_by
  );
  INSERT INTO chip_transactions (club_id, amount, transaction_type, notes)
  VALUES (p_club_id, p_amount, 'union_transfer',
          COALESCE(NULLIF(p_notes, ''), 'Union chip distribution'));

  RETURN jsonb_build_object('success', true, 'amount', p_amount, 'union_balance_after', v_after);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'duplicate', true,
                            'error', 'operation already processed');
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_union_move_rake_to_chips_atomic(
  p_union_id uuid,
  p_amount numeric,
  p_notes text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL,
  p_op_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_rake numeric;
  v_rake_after numeric;
  v_chip_after numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  SELECT rake_wallet INTO v_rake FROM union_wallets
   WHERE union_id = p_union_id FOR UPDATE;
  IF v_rake IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union wallet not found');
  END IF;
  IF v_rake < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient rake wallet balance',
                              'balance', v_rake, 'requested', p_amount);
  END IF;

  UPDATE union_wallets
     SET rake_wallet = rake_wallet - p_amount,
         chip_balance = COALESCE(chip_balance, 0) + p_amount,
         updated_at = NOW()
   WHERE union_id = p_union_id
   RETURNING rake_wallet, chip_balance INTO v_rake_after, v_chip_after;

  INSERT INTO union_wallet_transactions (
    union_id, wallet, direction, amount, balance_after, tx_type, period_id, notes, created_by
  ) VALUES (
    p_union_id, 'rake_wallet', 'debit', p_amount, v_rake_after, 'rake_to_chips',
    p_op_id, COALESCE(NULLIF(p_notes, ''), 'Rake wallet -> chip balance'), p_created_by
  );
  INSERT INTO union_wallet_transactions (
    union_id, wallet, direction, amount, balance_after, tx_type, notes, created_by
  ) VALUES (
    p_union_id, 'chip_balance', 'credit', p_amount, v_chip_after, 'rake_to_chips_credit',
    COALESCE(NULLIF(p_notes, ''), 'Rake wallet -> chip balance'), p_created_by
  );

  RETURN jsonb_build_object('success', true, 'amount', p_amount,
                            'rake_after', v_rake_after, 'chip_after', v_chip_after);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'duplicate', true,
                            'error', 'operation already processed');
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_union_deposit_from_wallet(
  p_union_id uuid,
  p_amount numeric,
  p_notes text DEFAULT NULL,
  p_op_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_lead boolean;
  v_balance numeric;
  v_after numeric;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authenticated');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM union_admins ua
     WHERE ua.union_id = p_union_id AND ua.user_id = v_uid AND ua.role = 'union_lead'
  ) OR EXISTS (
    SELECT 1 FROM unions u WHERE u.id = p_union_id AND u.owner_id = v_uid
  ) INTO v_is_lead;
  IF NOT v_is_lead THEN
    RETURN jsonb_build_object('success', false, 'error', 'union lead access required');
  END IF;

  SELECT balance INTO v_balance FROM wallets
   WHERE user_id = v_uid AND wallet_type = 'PLAYER' FOR UPDATE;
  IF v_balance IS NULL OR v_balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient wallet balance');
  END IF;
  UPDATE wallets SET balance = balance - p_amount, updated_at = NOW()
   WHERE user_id = v_uid AND wallet_type = 'PLAYER';

  INSERT INTO union_wallets (union_id, chip_balance)
  VALUES (p_union_id, p_amount)
  ON CONFLICT (union_id) DO UPDATE
    SET chip_balance = COALESCE(union_wallets.chip_balance, 0) + p_amount,
        updated_at = NOW()
  RETURNING chip_balance INTO v_after;

  INSERT INTO union_wallet_transactions (
    union_id, wallet, direction, amount, balance_after, tx_type, period_id, notes, created_by
  ) VALUES (
    p_union_id, 'chip_balance', 'credit', p_amount, v_after, 'owner_deposit',
    p_op_id, COALESCE(NULLIF(p_notes, ''), 'Union bank deposit from owner wallet'), v_uid
  );

  RETURN jsonb_build_object('success', true, 'amount', p_amount, 'union_balance', v_after);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'duplicate', true,
                            'error', 'operation already processed');
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_union_clawback_from_club(
  p_union_id uuid,
  p_club_id uuid,
  p_amount numeric,
  p_notes text DEFAULT NULL,
  p_op_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_lead boolean;
  v_treasury numeric;
  v_after numeric;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authenticated');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM union_admins ua
     WHERE ua.union_id = p_union_id AND ua.user_id = v_uid AND ua.role = 'union_lead'
  ) OR EXISTS (
    SELECT 1 FROM unions u WHERE u.id = p_union_id AND u.owner_id = v_uid
  ) INTO v_is_lead;
  IF NOT v_is_lead THEN
    RETURN jsonb_build_object('success', false, 'error', 'union lead access required');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM union_clubs uc WHERE uc.union_id = p_union_id AND uc.club_id = p_club_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'club is not in this union');
  END IF;

  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount
   WHERE id = p_club_id AND COALESCE(chip_treasury, 0) >= p_amount
  RETURNING chip_treasury INTO v_treasury;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient club treasury balance');
  END IF;

  INSERT INTO union_wallets (union_id, chip_balance)
  VALUES (p_union_id, p_amount)
  ON CONFLICT (union_id) DO UPDATE
    SET chip_balance = COALESCE(union_wallets.chip_balance, 0) + p_amount,
        updated_at = NOW()
  RETURNING chip_balance INTO v_after;

  INSERT INTO union_wallet_transactions (
    union_id, wallet, direction, amount, balance_after, tx_type, club_id, period_id, notes, created_by
  ) VALUES (
    p_union_id, 'chip_balance', 'credit', p_amount, v_after, 'clawback',
    p_club_id, p_op_id, COALESCE(NULLIF(p_notes, ''), 'Clawback from club treasury'), v_uid
  );

  INSERT INTO chip_transactions (club_id, amount, transaction_type, notes)
  VALUES (p_club_id, p_amount, 'union_clawback',
          COALESCE(NULLIF(p_notes, ''), 'Union clawback from club treasury'));

  RETURN jsonb_build_object(
    'success', true, 'amount', p_amount,
    'club_treasury', v_treasury, 'union_balance', v_after
  );
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'duplicate', true,
                            'error', 'operation already processed');
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_union_fund_bbj_pool(
  p_union_id uuid,
  p_amount numeric,
  p_main_pct numeric DEFAULT 50,
  p_backup_pct numeric DEFAULT 25,
  p_promo_pct numeric DEFAULT 25,
  p_notes text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL,
  p_op_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_balance numeric;
  v_after numeric;
  v_pool_id uuid;
  v_main numeric;
  v_backup numeric;
  v_promo numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;
  IF ROUND(COALESCE(p_main_pct,0) + COALESCE(p_backup_pct,0) + COALESCE(p_promo_pct,0)) <> 100 THEN
    RETURN jsonb_build_object('success', false, 'error', 'split percentages must total 100');
  END IF;

  SELECT chip_balance INTO v_balance FROM union_wallets
   WHERE union_id = p_union_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union wallet not found');
  END IF;
  IF v_balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient union chip balance',
                              'balance', v_balance, 'requested', p_amount);
  END IF;
  UPDATE union_wallets
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE union_id = p_union_id
   RETURNING chip_balance INTO v_after;

  v_main   := ROUND(p_amount * p_main_pct / 100.0, 2);
  v_backup := ROUND(p_amount * p_backup_pct / 100.0, 2);
  v_promo  := ROUND(p_amount - v_main - v_backup, 2);
  UPDATE bbj_pools
     SET main_balance      = COALESCE(main_balance, 0) + v_main,
         backup_balance    = COALESCE(backup_balance, 0) + v_backup,
         promo_balance     = COALESCE(promo_balance, 0) + v_promo,
         pool_amount       = COALESCE(pool_amount, 0) + p_amount,
         total_contributed = COALESCE(total_contributed, 0) + p_amount,
         updated_at        = NOW()
   WHERE union_id = p_union_id AND status = 'active'
   RETURNING id INTO v_pool_id;
  IF v_pool_id IS NULL THEN
    RAISE EXCEPTION 'no active BBJ pool for union %', p_union_id;
  END IF;

  INSERT INTO union_wallet_transactions (
    union_id, wallet, direction, amount, balance_after, tx_type, period_id, notes, created_by
  ) VALUES (
    p_union_id, 'chip_balance', 'debit', p_amount, v_after, 'bbj_fund',
    p_op_id, COALESCE(NULLIF(p_notes, ''), 'Union bank -> shared BBJ pool'), p_created_by
  );

  RETURN jsonb_build_object(
    'success', true, 'amount', p_amount, 'pool_id', v_pool_id,
    'main', v_main, 'backup', v_backup, 'promo', v_promo,
    'union_balance_after', v_after
  );
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'duplicate', true,
                            'error', 'operation already processed');
END;
$$;
