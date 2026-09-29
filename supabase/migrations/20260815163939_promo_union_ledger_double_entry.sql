-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815163939 "promo_union_ledger_double_entry"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 83c7f651c2c10b0500cf5aee890dc6ae of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Union-level promo movements belong in union_wallet_transactions (the live union
-- ledger, 313k rows), NOT chip_transactions -- whose club_id is NOT NULL and which
-- is club-scoped by design. `wallet` carries the column name ('promo_wallet',
-- 'chip_balance') and `direction` is credit/debit, matching existing rows.

CREATE OR REPLACE FUNCTION public.fn_union_fund_promo_from_bank(
  p_union_id uuid,
  p_amount numeric,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_actor        uuid;
  v_bank_before  numeric;
  v_promo_before numeric;
BEGIN
  v_actor := auth.uid();

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM unions WHERE id = p_union_id AND owner_id = v_actor
    ) THEN
      RETURN jsonb_build_object('success', false,
        'error', 'only the union owner may fund the promo wallet');
    END IF;
  END IF;

  SELECT COALESCE(chip_balance, 0), COALESCE(promo_wallet, 0)
    INTO v_bank_before, v_promo_before
    FROM unions WHERE id = p_union_id FOR UPDATE;

  IF v_bank_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union not found');
  END IF;
  IF v_bank_before < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient union bank balance',
                              'bank_balance', v_bank_before, 'requested', p_amount);
  END IF;

  UPDATE unions
     SET chip_balance           = chip_balance - p_amount,
         promo_wallet           = COALESCE(promo_wallet, 0) + p_amount,
         promo_funded_from_bank = COALESCE(promo_funded_from_bank, 0) + p_amount,
         updated_at             = NOW()
   WHERE id = p_union_id;

  -- Double entry: the bank is debited, the promo wallet credited.
  INSERT INTO union_wallet_transactions
    (id, union_id, wallet, direction, amount, balance_after, tx_type, notes, created_by, created_at)
  VALUES
    (gen_random_uuid(), p_union_id, 'chip_balance', 'debit',  p_amount,
     v_bank_before - p_amount, 'promo_bank_topup',
     COALESCE(p_note, 'Owner funded promo wallet from main bank'), v_actor, NOW()),
    (gen_random_uuid(), p_union_id, 'promo_wallet', 'credit', p_amount,
     v_promo_before + p_amount, 'promo_bank_topup',
     COALESCE(p_note, 'Owner funded promo wallet from main bank'), v_actor, NOW());

  RETURN jsonb_build_object('success', true, 'amount', p_amount,
                            'bank_after', v_bank_before - p_amount,
                            'promo_after', v_promo_before + p_amount);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_sweep_bbj_promo(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_promo    numeric;
  v_pool_id  uuid;
  v_union_id uuid;
  v_dest     text;
  v_after    numeric;
BEGIN
  SELECT id, COALESCE(promo_balance, 0) INTO v_pool_id, v_promo
    FROM bbj_pools WHERE club_id = p_club_id FOR UPDATE;

  IF v_pool_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no bbj pool for club');
  END IF;
  IF v_promo <= 0 THEN
    RETURN jsonb_build_object('success', true, 'swept', 0, 'note', 'nothing to sweep');
  END IF;

  SELECT union_id INTO v_union_id FROM clubs WHERE id = p_club_id;

  UPDATE bbj_pools SET promo_balance = 0, updated_at = NOW() WHERE id = v_pool_id;

  IF v_union_id IS NOT NULL THEN
    UPDATE unions
       SET promo_wallet          = COALESCE(promo_wallet, 0) + v_promo,
           promo_funded_from_bbj = COALESCE(promo_funded_from_bbj, 0) + v_promo,
           updated_at            = NOW()
     WHERE id = v_union_id
    RETURNING promo_wallet INTO v_after;

    IF v_after IS NULL THEN
      RAISE EXCEPTION 'club % references missing union %', p_club_id, v_union_id;
    END IF;
    v_dest := 'union';

    INSERT INTO union_wallet_transactions
      (id, union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes, created_at)
    VALUES
      (gen_random_uuid(), v_union_id, 'promo_wallet', 'credit', v_promo, v_after,
       'bbj_promo_sweep', p_club_id,
       'BBJ promo slice (25% of contribution) swept from club pool', NOW());
  ELSE
    UPDATE clubs
       SET promo_balance = COALESCE(promo_balance, 0) + v_promo, updated_at = NOW()
     WHERE id = p_club_id
    RETURNING promo_balance INTO v_after;
    v_dest := 'club';

    -- Unionless club: club-scoped movement, so the club ledger is correct here.
    INSERT INTO chip_transactions (
      id, club_id, from_user_id, to_user_id, amount,
      transaction_type, notes, balance_after, created_at
    ) VALUES (
      gen_random_uuid(), p_club_id, NULL, NULL, v_promo,
      'bbj_promo_sweep',
      'BBJ promo slice swept to club promo wallet (club has no union)',
      v_after, NOW()
    );
  END IF;

  RETURN jsonb_build_object('success', true, 'swept', v_promo,
                            'destination', v_dest, 'balance_after', v_after);
END;
$function$;
