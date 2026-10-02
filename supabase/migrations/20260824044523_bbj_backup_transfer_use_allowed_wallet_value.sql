-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260824044523 "bbj_backup_transfer_use_allowed_wallet_value"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 33fe20e819e9730e125da9eece96b274 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- 20260824_bbj_backup_transfer_use_allowed_wallet_value.sql  (TIER 2)
--
-- WHY:
--   fn_union_bbj_backup_transfer wrote its backup->main ledger row with
--   wallet = 'bbj_pool', which union_wallet_transactions_wallet_check does not
--   allow. Allowed values are chip_balance, rake_wallet, bbj_wallet,
--   promo_wallet, insurance_wallet, spin_reserve_wallet. Caught by a probe
--   before the function was ever used in anger; the transaction rolled back
--   and no balance moved.
--
--   Worth recording because the same mistake is LIVE elsewhere:
--   pages/api/club-arena/union-wallet.js's process_bbj_payout inserts
--   wallet: 'bbj_pool' in two places, so every manual BBJ payout through that
--   route throws 23514 on its claim insert and answers "BBJ payout claim
--   failed". union_wallet_transactions holds zero rows with tx_type
--   'bbj_payout' and zero with wallet 'bbj_pool', which is what you would
--   expect of a path that has never once succeeded. Fixed in the same PR.
--
-- HOW: use 'bbj_wallet' — the chips stay inside the BBJ system, they just
--      change bank within it.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_union_bbj_backup_transfer(
  p_union_id    uuid,
  p_amount      numeric,
  p_destination text,
  p_op_id       uuid,
  p_created_by  uuid DEFAULT NULL,
  p_notes       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_amt     numeric := round(COALESCE(p_amount, 0), 2);
  v_pool_id uuid;
  v_backup  numeric;
  v_main    numeric;
  v_promo_after numeric;
BEGIN
  IF v_amt <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;
  IF p_destination NOT IN ('main', 'promo') THEN
    RETURN jsonb_build_object('success', false, 'error', 'destination must be main or promo');
  END IF;
  IF p_op_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'op_id_required');
  END IF;

  SELECT id, COALESCE(backup_balance,0), COALESCE(main_balance,0)
    INTO v_pool_id, v_backup, v_main
    FROM bbj_pools
   WHERE union_id = p_union_id AND status = 'active'
   FOR UPDATE;

  IF v_pool_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no active BBJ pool for this union');
  END IF;
  IF v_backup < v_amt THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient backup balance',
                              'available', v_backup, 'requested', v_amt);
  END IF;

  IF p_destination = 'main' THEN
    UPDATE bbj_pools
       SET backup_balance = COALESCE(backup_balance,0) - v_amt,
           main_balance   = COALESCE(main_balance,0)   + v_amt,
           updated_at     = now()
     WHERE id = v_pool_id;

    -- 'bbj_wallet', not 'bbj_pool': the CHECK constraint on this table lists
    -- six wallet names and bbj_pool is not one of them. The chips never left
    -- the BBJ system, they changed bank inside it.
    INSERT INTO union_wallet_transactions
      (union_id, wallet, direction, amount, balance_after, tx_type, period_id, notes, created_by)
    VALUES
      (p_union_id, 'bbj_wallet', 'debit', v_amt, v_main + v_amt, 'bbj_backup_to_main', p_op_id,
       COALESCE(NULLIF(p_notes, ''), 'BBJ backup -> main jackpot'), p_created_by);

    RETURN jsonb_build_object('success', true, 'destination', 'main', 'amount', v_amt,
                              'pool_id', v_pool_id,
                              'backup_after', v_backup - v_amt,
                              'main_after', v_main + v_amt);
  END IF;

  UPDATE bbj_pools
     SET backup_balance = COALESCE(backup_balance,0) - v_amt, updated_at = now()
   WHERE id = v_pool_id;

  INSERT INTO union_wallets (union_id, promo_wallet)
  VALUES (p_union_id, v_amt)
  ON CONFLICT (union_id) DO UPDATE
    SET promo_wallet = COALESCE(union_wallets.promo_wallet, 0) + EXCLUDED.promo_wallet,
        updated_at = now()
  RETURNING promo_wallet INTO v_promo_after;

  IF v_promo_after IS NULL THEN
    RAISE EXCEPTION 'promo wallet credit failed for union %', p_union_id;
  END IF;

  INSERT INTO union_wallet_transactions
    (union_id, wallet, direction, amount, balance_after, tx_type, period_id, notes, created_by)
  VALUES
    (p_union_id, 'promo_wallet', 'credit', v_amt, v_promo_after, 'bbj_backup_to_promo', p_op_id,
     COALESCE(NULLIF(p_notes, ''), 'BBJ backup -> promo wallet'), p_created_by);

  RETURN jsonb_build_object('success', true, 'destination', 'promo', 'amount', v_amt,
                            'pool_id', v_pool_id,
                            'backup_after', v_backup - v_amt,
                            'promo_after', v_promo_after);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'duplicate', true,
                            'error', 'operation already processed');
END;
$fn$ SET search_path = public, extensions;

REVOKE EXECUTE ON FUNCTION public.fn_union_bbj_backup_transfer(uuid,numeric,text,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_union_bbj_backup_transfer(uuid,numeric,text,uuid,uuid,text)
  TO service_role;

COMMIT;
