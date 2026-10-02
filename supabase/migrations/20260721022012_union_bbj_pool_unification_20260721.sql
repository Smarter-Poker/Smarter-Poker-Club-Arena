-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721022012 "union_bbj_pool_unification_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7b644e769a1257b6259939fe4d52b89b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_union_bbj_pool_payout(
  p_union_id uuid,
  p_pool_id uuid,
  p_club_id uuid,
  p_loser_id uuid,
  p_winner_id uuid,
  p_loser_share numeric,
  p_winner_share numeric,
  p_table_share numeric
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_total numeric := COALESCE(p_loser_share, 0) + COALESCE(p_winner_share, 0) + COALESCE(p_table_share, 0);
  v_balance numeric;
BEGIN
  IF v_total <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'payout must be > 0');
  END IF;

  SELECT main_balance INTO v_balance
    FROM bbj_pools
   WHERE id = p_pool_id AND union_id = p_union_id
   FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union BBJ pool not found');
  END IF;
  IF v_balance < v_total THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient BBJ pool balance',
                              'balance', v_balance, 'requested', v_total);
  END IF;

  UPDATE bbj_pools
     SET main_balance    = main_balance - v_total,
         total_paid_out  = COALESCE(total_paid_out, 0) + v_total,
         hit_count       = COALESCE(hit_count, 0) + 1,
         last_hit_at     = NOW(),
         last_hit_amount = v_total,
         last_winner_id  = p_winner_id,
         last_loser_id   = p_loser_id,
         updated_at      = NOW()
   WHERE id = p_pool_id
   RETURNING main_balance INTO v_balance;

  IF COALESCE(p_loser_share, 0) > 0 THEN
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance, 0) + p_loser_share
     WHERE club_id = p_club_id AND user_id = p_loser_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'loser % is not a member of club %', p_loser_id, p_club_id;
    END IF;
  END IF;
  IF COALESCE(p_winner_share, 0) > 0 THEN
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance, 0) + p_winner_share
     WHERE club_id = p_club_id AND user_id = p_winner_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'winner % is not a member of club %', p_winner_id, p_club_id;
    END IF;
  END IF;

  IF COALESCE(p_table_share, 0) > 0 THEN
    UPDATE clubs
       SET chip_treasury = COALESCE(chip_treasury, 0) + p_table_share
     WHERE id = p_club_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'total', v_total,
    'loser_share', p_loser_share, 'winner_share', p_winner_share,
    'table_share', p_table_share, 'pool_balance_after', v_balance
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_union_fund_bbj_pool(
  p_union_id uuid,
  p_amount numeric,
  p_main_pct numeric DEFAULT 50,
  p_backup_pct numeric DEFAULT 25,
  p_promo_pct numeric DEFAULT 25,
  p_notes text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL
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
    union_id, wallet, direction, amount, balance_after, tx_type, notes, created_by
  ) VALUES (
    p_union_id, 'chip_balance', 'debit', p_amount, v_after, 'bbj_fund',
    COALESCE(NULLIF(p_notes, ''), 'Union bank -> shared BBJ pool'), p_created_by
  );

  RETURN jsonb_build_object(
    'success', true, 'amount', p_amount, 'pool_id', v_pool_id,
    'main', v_main, 'backup', v_backup, 'promo', v_promo,
    'union_balance_after', v_after
  );
END;
$$;
