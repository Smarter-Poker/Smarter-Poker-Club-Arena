-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429121323 "x22_award_bbj_idempotency_lock_2026_04_29"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7f142e3559d71aa43912f8b3581c41dd of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 22 — race condition / idempotency hardening
--
-- Finding: award_bbj was vulnerable to concurrent execution:
--   - read bbj_pools (no FOR UPDATE)
--   - compute payouts from main_balance
--   - INSERT bbj_winners (no uniqueness)
--   - UPDATE bbj_pools (atomic but second caller debits already-zeroed pool)
--
-- Two retries / a network duplicate could double-pay the BBJ jackpot,
-- and the second UPDATE could leave bbj_pools.main_balance negative.
--
-- Fix in two layers:
--   1. UNIQUE constraint on bbj_winners (pool_id, table_id, hand_number)
--      — second INSERT raises a constraint violation, blocking duplicate
--      bookkeeping rows even if the deduction did happen.
--   2. SELECT bbj_pools ... FOR UPDATE — second concurrent call blocks
--      until first commits, then re-reads main_balance which is now zero
--      and the function returns the insufficient_balance branch.
--
-- This double-protects: even if FOR UPDATE is bypassed (e.g. someone
-- disables the function and runs the SQL by hand), the unique
-- constraint catches the duplicate row.

-- First the constraint (DEFERRABLE not used — we want it enforced
-- immediately so the race fails fast).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bbj_winners_pool_table_hand_unique'
  ) THEN
    BEGIN
      ALTER TABLE public.bbj_winners
        ADD CONSTRAINT bbj_winners_pool_table_hand_unique
        UNIQUE (pool_id, table_id, hand_number);
    EXCEPTION WHEN unique_violation THEN
      -- pre-existing duplicates would block; surface and skip
      RAISE NOTICE 'bbj_winners has historical duplicates — UNIQUE skipped, fix data manually';
    END;
  END IF;
END $$;

-- Re-create award_bbj with FOR UPDATE on the pool read
CREATE OR REPLACE FUNCTION public.award_bbj(
  p_club_id uuid, p_table_id uuid, p_hand_number bigint,
  p_loser_user_id uuid, p_loser_display_name text, p_loser_hand text,
  p_loser_cards text, p_winner_user_id uuid, p_winner_display_name text,
  p_winner_hand text, p_winner_cards text, p_payout_total_pct numeric,
  p_payout_loser_pct numeric, p_payout_winner_pct numeric,
  p_payout_table_pct numeric, p_stakes_tier text DEFAULT 'small',
  p_game_variant text DEFAULT 'nlh', p_big_blind numeric DEFAULT 2
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_pool          bbj_pools%ROWTYPE;
  v_total_payout  numeric;
  v_loser_payout  numeric;
  v_winner_payout numeric;
  v_table_payout  numeric;
  v_seed_amount   numeric;
BEGIN
  -- ROUND 22 FIX: FOR UPDATE serializes concurrent BBJ awards on the same pool.
  SELECT * INTO v_pool FROM public.bbj_pools WHERE club_id = p_club_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'No BBJ pool for this club');
  END IF;

  -- ROUND 22 FIX: bail if main_balance is zero/negative (second concurrent
  -- caller after first has already drained the pool).
  IF COALESCE(v_pool.main_balance, 0) <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pool already paid out',
                              'main_balance', v_pool.main_balance);
  END IF;

  v_total_payout  := ROUND(v_pool.main_balance * p_payout_total_pct  / 100, 2);
  v_loser_payout  := ROUND(v_pool.main_balance * p_payout_loser_pct  / 100, 2);
  v_winner_payout := ROUND(v_pool.main_balance * p_payout_winner_pct / 100, 2);
  v_table_payout  := ROUND(v_pool.main_balance * p_payout_table_pct  / 100, 2);

  -- ROUND 22 FIX: ON CONFLICT swallows duplicate award attempts cleanly.
  -- Combined with the FOR UPDATE above this is belt + suspenders.
  INSERT INTO public.bbj_winners (
    pool_id, club_id, table_id, hand_number,
    loser_id,  loser_hand,  loser_payout,
    winner_id, winner_hand, winner_payout,
    table_share_payout, total_payout,
    pool_amount_at_hit,
    stakes_tier
  ) VALUES (
    v_pool.id, p_club_id, p_table_id, p_hand_number,
    p_loser_user_id,  p_loser_hand,  v_loser_payout,
    p_winner_user_id, p_winner_hand, v_winner_payout,
    v_table_payout, v_total_payout,
    v_pool.main_balance,
    p_stakes_tier
  )
  ON CONFLICT ON CONSTRAINT bbj_winners_pool_table_hand_unique DO NOTHING;

  -- If the INSERT was a no-op (duplicate), don't double-debit the pool.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true,
                              'note', 'BBJ already awarded for this hand');
  END IF;

  v_seed_amount := v_pool.backup_balance;

  UPDATE public.bbj_pools SET
    pool_amount     = pool_amount - v_total_payout,
    main_balance    = (main_balance - v_total_payout) + v_seed_amount,
    backup_balance  = 0,
    last_hit_at     = NOW(),
    last_hit_amount = v_total_payout,
    last_winner_id  = p_winner_user_id,
    last_loser_id   = p_loser_user_id,
    hit_count       = COALESCE(hit_count, 0) + 1,
    total_paid_out  = COALESCE(total_paid_out, 0) + v_total_payout,
    updated_at      = NOW()
  WHERE id = v_pool.id;

  RETURN jsonb_build_object(
    'success',                 true,
    'total_payout',            v_total_payout,
    'loser_payout',            v_loser_payout,
    'winner_payout',           v_winner_payout,
    'table_payout',            v_table_payout,
    'pool_before',             v_pool.main_balance,
    'pool_after',              (v_pool.main_balance - v_total_payout) + v_seed_amount,
    'seed_from_backup',        v_seed_amount,
    'promo_balance_preserved', v_pool.promo_balance
  );
END $function$;

REVOKE EXECUTE ON FUNCTION public.award_bbj(uuid, uuid, bigint, uuid, text, text, text, uuid, text, text, text, numeric, numeric, numeric, numeric, text, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.award_bbj(uuid, uuid, bigint, uuid, text, text, text, uuid, text, text, text, numeric, numeric, numeric, numeric, text, text, numeric)
  TO service_role;
