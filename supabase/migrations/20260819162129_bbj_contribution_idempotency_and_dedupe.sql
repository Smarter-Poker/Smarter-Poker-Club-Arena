-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819162129 "bbj_contribution_idempotency_and_dedupe"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a812f686fbbd280638e9811250e6820f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- LINE-BY-LINE AUDIT 2026-08-19 (rake/BBJ pass 2), DEFECT #1:
-- bbj_record_contribution had NO idempotency gate — a client retry after a
-- transient error that actually committed, or a FeeReconciler re-drive, banked
-- the same hand's BBJ fee TWICE (pool UPDATE + duplicate ledger row). The
-- FeeReconciler header even claimed the RPC was "keyed per (table, hand)" — it
-- was not. Verified live: 5 duplicate (pool_id, hand_id) pairs, all created
-- 2026-08-15, 2.60 chips over-banked.
--
-- This migration:
--   1. Deletes the later duplicate row of each pair and reverses its portions
--      out of the pools. All affected balances now live in the UNION pool
--      (the JAQK club pool was merged into it earlier today), and the promo
--      portions were swept into union_wallets.promo_wallet — so the reversal
--      debits the union pool main/backup, the union promo wallet, and the
--      lifetime counters.
--   2. Adds the missing partial unique index on (pool_id, hand_id).
--   3. Rewrites bbj_record_contribution to be idempotent: insert-first with
--      ON CONFLICT DO NOTHING; the pool balance UPDATE only runs when the
--      ledger row actually landed. A duplicate call returns the existing row.

DO $$
DECLARE
  v_removed record;
  v_union_pool uuid := 'f9806a7f-e7a2-47d2-a676-36336e3a5337';
  v_union_id uuid := 'fade0000-0000-0000-0000-000000000001';
  v_new_promo numeric;
BEGIN
  -- 1. Remove the later duplicate of each (pool_id, hand_id) pair.
  WITH ranked AS (
    SELECT id, pool_id, hand_id, amount, main_portion, backup_portion, promo_portion,
           row_number() OVER (PARTITION BY pool_id, hand_id ORDER BY created_at, id) rn
      FROM bbj_contributions WHERE hand_id IS NOT NULL
  ), doomed AS (
    DELETE FROM bbj_contributions
     WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
     RETURNING amount, main_portion, backup_portion, promo_portion
  )
  SELECT COALESCE(SUM(amount),0) amt, COALESCE(SUM(main_portion),0) main_p,
         COALESCE(SUM(backup_portion),0) backup_p, COALESCE(SUM(promo_portion),0) promo_p,
         COUNT(*) n
    INTO v_removed FROM doomed;

  IF v_removed.n > 0 THEN
    -- Balances of BOTH original pools now live in the union pool (post-merge).
    UPDATE bbj_pools
       SET main_balance      = main_balance      - v_removed.main_p,
           backup_balance    = backup_balance    - v_removed.backup_p,
           total_contributed = total_contributed - v_removed.amt,
           hands_contributed = hands_contributed - v_removed.n,
           updated_at        = now()
     WHERE id = v_union_pool;

    -- Promo portions were swept to the union promo wallet.
    UPDATE union_wallets
       SET promo_wallet = promo_wallet - v_removed.promo_p, updated_at = now()
     WHERE union_id = v_union_id
     RETURNING promo_wallet INTO v_new_promo;

    INSERT INTO union_wallet_transactions
      (union_id, amount, tx_type, wallet, direction, balance_after, notes)
    VALUES
      (v_union_id, v_removed.promo_p, 'bbj_dedupe_reversal', 'promo_wallet', 'debit', v_new_promo,
       'Reversal of double-banked BBJ promo portions (5 duplicate hands, 2026-08-15)');

    RAISE NOTICE 'BBJ dedupe: removed % rows, reversed amt=% main=% backup=% promo=%',
      v_removed.n, v_removed.amt, v_removed.main_p, v_removed.backup_p, v_removed.promo_p;
  END IF;
END $$;

-- 2. The gate that makes double-banking impossible from now on.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bbj_contributions_pool_hand
  ON public.bbj_contributions (pool_id, hand_id) WHERE hand_id IS NOT NULL;

-- 3. Idempotent RPC: ledger row is the claim; pool update only on first claim.
CREATE OR REPLACE FUNCTION public.bbj_record_contribution(
  p_pool_id uuid,
  p_hand_id uuid DEFAULT NULL::uuid,
  p_table_id uuid DEFAULT NULL::uuid,
  p_amount numeric DEFAULT 0,
  p_main_portion numeric DEFAULT 0,
  p_backup_portion numeric DEFAULT 0,
  p_promo_portion numeric DEFAULT 0,
  p_big_blind numeric DEFAULT 2.00,
  p_hand_number integer DEFAULT NULL::integer,
  p_club_id uuid DEFAULT NULL::uuid
) RETURNS bbj_contributions
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
    v_contribution bbj_contributions;
BEGIN
    INSERT INTO bbj_contributions (
        pool_id, hand_id, table_id, club_id, amount,
        main_portion, backup_portion, promo_portion, big_blind, hand_number
    ) VALUES (
        p_pool_id, p_hand_id, p_table_id, p_club_id, p_amount,
        p_main_portion, p_backup_portion, p_promo_portion, p_big_blind, p_hand_number
    )
    ON CONFLICT (pool_id, hand_id) WHERE hand_id IS NOT NULL DO NOTHING
    RETURNING * INTO v_contribution;

    IF v_contribution.id IS NULL THEN
        -- Already banked for this hand (retry / re-drive): idempotent no-op.
        SELECT * INTO v_contribution FROM bbj_contributions
         WHERE pool_id = p_pool_id AND hand_id = p_hand_id
         LIMIT 1;
        RETURN v_contribution;
    END IF;

    UPDATE bbj_pools
    SET
        main_balance = main_balance + p_main_portion,
        backup_balance = backup_balance + p_backup_portion,
        promo_balance = promo_balance + p_promo_portion,
        total_contributed = total_contributed + p_amount,
        hands_contributed = COALESCE(hands_contributed, 0) + 1,
        updated_at = now()
    WHERE id = p_pool_id;

    RETURN v_contribution;
END;
$function$;
