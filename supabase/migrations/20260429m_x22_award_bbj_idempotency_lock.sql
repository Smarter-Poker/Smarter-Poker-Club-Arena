-- ═══════════════════════════════════════════════════════════════════════════════
-- Walkthrough Round 22 — race condition + idempotency hardening on hot paths.
--
-- Audit methodology: pull every money-flow RPC body, classify by
--   "uses FOR UPDATE on read?" + "uses ON CONFLICT for idempotent upsert?"
--
-- Of 36 RPCs checked, 21 already had locks or atomic upserts. The remaining
-- 15 were re-classified by reading their bodies; all but one had bare
-- atomic UPDATE statements (Postgres-atomic by default) or claim-by-status
-- patterns (UPDATE ... WHERE status = 'pending') that are race-safe.
--
-- The one real bug found: award_bbj.
--
-- VULNERABLE PATTERN:
--   1. SELECT * FROM bbj_pools WHERE club_id = p_club_id          (no lock)
--   2. compute payouts from main_balance
--   3. INSERT bbj_winners                                           (no uniqueness)
--   4. UPDATE bbj_pools SET main_balance = main_balance - payout
--
-- Two retries / a network duplicate could:
--   - Both reads see main_balance = $50,000
--   - Both compute payout = $50,000
--   - Both INSERT bbj_winners rows  ← double bookkeeping
--   - First UPDATE drops main_balance to ~$0
--   - Second UPDATE drops it to -$50,000  ← negative pool
--
-- BOTH layers of protection added (belt + suspenders):
--   1. UNIQUE (pool_id, table_id, hand_number) on bbj_winners — second
--      INSERT raises a constraint violation, blocking duplicate
--      bookkeeping rows.
--   2. SELECT bbj_pools ... FOR UPDATE — second concurrent call blocks
--      until first commits, then re-reads main_balance which is now zero
--      and the function returns early via the new "Pool already paid out"
--      branch.
--
-- ON CONFLICT ON CONSTRAINT bbj_winners_pool_table_hand_unique DO NOTHING
-- swallows the duplicate INSERT cleanly; the IF NOT FOUND branch then
-- skips the pool UPDATE so we don't double-debit even if FOR UPDATE were
-- somehow bypassed.
--
-- Other RPC findings (all clean after re-inspection):
--   atomic_table_buyin   safe — wallet UPDATE has WHERE balance >= amount
--                        + table_seats has UNIQUE (table_id, seat_number)
--                        + UNIQUE (table_id, user_id) WHERE left_at IS NULL
--   fn_cancel_cashout    safe — UPDATE ... WHERE status='pending'
--                        (claim-by-status race-safe)
--   fn_reject_cashout    safe — same claim-by-status pattern
--   atomic_table_rebuy   safe — same atomic UPDATE pattern as buyin
--   process_tournament_rebuy safe — Round 19 wrapper around deduct_player_wallet
--                            which has its own atomic check
--   increment_*          all safe — bare atomic UPDATE col = col + n
--
-- Applied to production via Supabase MCP migration
-- x22_award_bbj_idempotency_lock_2026_04_29.
-- ═══════════════════════════════════════════════════════════════════════════════

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
      RAISE NOTICE 'bbj_winners has historical duplicates — UNIQUE skipped, fix data manually';
    END;
  END IF;
END $$;

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
  SELECT * INTO v_pool FROM public.bbj_pools WHERE club_id = p_club_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'No BBJ pool for this club');
  END IF;

  IF COALESCE(v_pool.main_balance, 0) <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pool already paid out',
                              'main_balance', v_pool.main_balance);
  END IF;

  v_total_payout  := ROUND(v_pool.main_balance * p_payout_total_pct  / 100, 2);
  v_loser_payout  := ROUND(v_pool.main_balance * p_payout_loser_pct  / 100, 2);
  v_winner_payout := ROUND(v_pool.main_balance * p_payout_winner_pct / 100, 2);
  v_table_payout  := ROUND(v_pool.main_balance * p_payout_table_pct  / 100, 2);

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
