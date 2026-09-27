-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260416015817 "bug_025_union_wallet_real_impl"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b1d2a200f5f550d90eb1d5388b775cd6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG 025 J: fn_union_credit_wallet / fn_union_debit_wallet were silent-success
-- stubs. Called by union-rakeback cron, union-wallet API, union BBJ payouts.
-- Union wallet mutations have been no-op for weeks.

DROP FUNCTION IF EXISTS public.fn_union_credit_wallet(uuid, text, numeric);
CREATE OR REPLACE FUNCTION public.fn_union_credit_wallet(
  p_union_id uuid,
  p_wallet text,
  p_amount numeric,
  p_tx_type text DEFAULT NULL,
  p_club_id uuid DEFAULT NULL,
  p_period_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_wallet_column text;
  v_before numeric;
  v_after numeric;
  v_sql text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  v_wallet_column := CASE lower(p_wallet)
    WHEN 'chip' THEN 'chip_balance'
    WHEN 'chip_balance' THEN 'chip_balance'
    WHEN 'rake' THEN 'rake_wallet'
    WHEN 'rake_wallet' THEN 'rake_wallet'
    WHEN 'bbj' THEN 'bbj_wallet'
    WHEN 'bbj_wallet' THEN 'bbj_wallet'
    WHEN 'promo' THEN 'promo_wallet'
    WHEN 'promo_wallet' THEN 'promo_wallet'
    WHEN 'insurance' THEN 'insurance_wallet'
    WHEN 'insurance_wallet' THEN 'insurance_wallet'
    ELSE NULL
  END;

  IF v_wallet_column IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown wallet: ' || p_wallet);
  END IF;

  -- Ensure wallet row exists
  INSERT INTO union_wallets (union_id, created_at, updated_at)
  VALUES (p_union_id, NOW(), NOW())
  ON CONFLICT (union_id) DO NOTHING;

  -- Read + lock before
  v_sql := format('SELECT COALESCE(%I,0) FROM union_wallets WHERE union_id = $1 FOR UPDATE', v_wallet_column);
  EXECUTE v_sql INTO v_before USING p_union_id;

  -- Update
  v_sql := format('UPDATE union_wallets SET %I = COALESCE(%I,0) + $1, updated_at = NOW() WHERE union_id = $2 RETURNING %I',
                  v_wallet_column, v_wallet_column, v_wallet_column);
  EXECUTE v_sql INTO v_after USING p_amount, p_union_id;

  -- Audit
  INSERT INTO union_wallet_transactions (
    id, union_id, wallet, direction, amount, balance_after,
    tx_type, club_id, period_id, notes, created_by, created_at
  ) VALUES (
    gen_random_uuid(), p_union_id, v_wallet_column, 'credit', p_amount, v_after,
    COALESCE(p_tx_type, 'credit'), p_club_id, p_period_id, p_notes, p_created_by, NOW()
  );

  RETURN jsonb_build_object(
    'success', true, 'amount', p_amount,
    'wallet', v_wallet_column,
    'balance_before', v_before, 'balance_after', v_after
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_union_credit_wallet(uuid, text, numeric, text, uuid, uuid, text, uuid) TO authenticated, service_role;


DROP FUNCTION IF EXISTS public.fn_union_debit_wallet(uuid, text, numeric);
CREATE OR REPLACE FUNCTION public.fn_union_debit_wallet(
  p_union_id uuid,
  p_wallet text,
  p_amount numeric,
  p_tx_type text DEFAULT NULL,
  p_club_id uuid DEFAULT NULL,
  p_period_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_wallet_column text;
  v_before numeric;
  v_after numeric;
  v_sql text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  v_wallet_column := CASE lower(p_wallet)
    WHEN 'chip' THEN 'chip_balance'
    WHEN 'chip_balance' THEN 'chip_balance'
    WHEN 'rake' THEN 'rake_wallet'
    WHEN 'rake_wallet' THEN 'rake_wallet'
    WHEN 'bbj' THEN 'bbj_wallet'
    WHEN 'bbj_wallet' THEN 'bbj_wallet'
    WHEN 'promo' THEN 'promo_wallet'
    WHEN 'promo_wallet' THEN 'promo_wallet'
    WHEN 'insurance' THEN 'insurance_wallet'
    WHEN 'insurance_wallet' THEN 'insurance_wallet'
    ELSE NULL
  END;

  IF v_wallet_column IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown wallet: ' || p_wallet);
  END IF;

  v_sql := format('SELECT COALESCE(%I,0) FROM union_wallets WHERE union_id = $1 FOR UPDATE', v_wallet_column);
  EXECUTE v_sql INTO v_before USING p_union_id;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union wallet not found');
  END IF;

  IF v_before < p_amount THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'insufficient balance',
      'wallet', v_wallet_column, 'balance', v_before, 'requested', p_amount
    );
  END IF;

  v_sql := format('UPDATE union_wallets SET %I = %I - $1, updated_at = NOW() WHERE union_id = $2 RETURNING %I',
                  v_wallet_column, v_wallet_column, v_wallet_column);
  EXECUTE v_sql INTO v_after USING p_amount, p_union_id;

  INSERT INTO union_wallet_transactions (
    id, union_id, wallet, direction, amount, balance_after,
    tx_type, club_id, period_id, notes, created_by, created_at
  ) VALUES (
    gen_random_uuid(), p_union_id, v_wallet_column, 'debit', p_amount, v_after,
    COALESCE(p_tx_type, 'debit'), p_club_id, p_period_id, p_notes, p_created_by, NOW()
  );

  RETURN jsonb_build_object(
    'success', true, 'amount', p_amount,
    'wallet', v_wallet_column,
    'balance_before', v_before, 'balance_after', v_after
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_union_debit_wallet(uuid, text, numeric, text, uuid, uuid, text, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_union_credit_wallet IS 'BUG 025: real impl. Dispatches wallet column (chip/rake/bbj/promo/insurance), credits atomically, inserts union_wallet_transactions audit.';
COMMENT ON FUNCTION public.fn_union_debit_wallet  IS 'BUG 025: real impl. Dispatches wallet column, debits atomically with insufficient-balance check, inserts union_wallet_transactions audit.';

