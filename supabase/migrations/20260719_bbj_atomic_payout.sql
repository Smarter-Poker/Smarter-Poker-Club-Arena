-- FIX-A4 2026-07-19 — Atomic, idempotent Bad Beat Jackpot payout.
--
-- Problem: services/supabase.ts processBBJPayout did a non-atomic
-- read-modify-write on bbj_pools.main_balance (read balance → compute payout →
-- write main_balance = balance - payout). Two qualifying bad beats on the same
-- (union) pool near-simultaneously both read the same balance and both credited
-- players, but the pool decremented only once (last-writer-wins) = minted chips.
-- There was also no idempotency key, so a retried postHandTasks could pay the
-- same hit twice.
--
-- Fix: a single-transaction RPC that (1) short-circuits if this hand already
-- paid, (2) locks the pool row FOR UPDATE, (3) computes the payout from the
-- LOCKED balance (no stale-read mint), (4) claims the hand via an idempotent
-- INSERT into bbj_payouts before decrementing, and (5) atomically decrements.
-- The pool row lock serializes concurrent hits on the same pool so decrements
-- are additive and exact; the unique key makes retries a no-op.

-- One BBJ payout per (pool, table, hand). Enforces idempotency + enables
-- ON CONFLICT below. (hand_id is NULL server-side; the natural key is the hand.)
CREATE UNIQUE INDEX IF NOT EXISTS bbj_payouts_pool_table_hand_uidx
  ON public.bbj_payouts (pool_id, table_id, hand_number);

CREATE OR REPLACE FUNCTION public.bbj_atomic_payout(
  p_pool_id             uuid,
  p_table_id            uuid,
  p_hand_number         bigint,
  p_payout_total_percent numeric,   -- e.g. 55 => 55% of the main pool balance
  p_loser_user_id       uuid,       -- bad-beat holder (BBJ "winner", 50% share)
  p_winner_user_id      uuid,       -- hand winner (BBJ "loser", 25% share)
  p_dealt_in_count      integer,
  p_metadata            jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  applied       boolean,
  already_paid  boolean,
  payout_id     uuid,
  total_payout  numeric,
  loser_share   numeric,
  winner_share  numeric,
  table_share   numeric,
  balance_after numeric
)
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_balance   numeric;
  v_total     numeric;
  v_loser     numeric;
  v_winner    numeric;
  v_table     numeric;
  v_payout_id uuid;
  v_existing  uuid;
BEGIN
  -- (1) Fast-path idempotency: already paid for this hand (e.g. task retry)?
  SELECT id INTO v_existing
    FROM bbj_payouts
   WHERE pool_id = p_pool_id AND table_id = p_table_id AND hand_number = p_hand_number
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN QUERY SELECT false, true, v_existing,
                        0::numeric, 0::numeric, 0::numeric, 0::numeric, NULL::numeric;
    RETURN;
  END IF;

  -- (2) Lock the pool row so concurrent hits on the same pool serialize.
  SELECT main_balance INTO v_balance FROM bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF v_balance IS NULL OR v_balance <= 0 THEN
    RETURN QUERY SELECT false, false, NULL::uuid,
                        0::numeric, 0::numeric, 0::numeric, 0::numeric, COALESCE(v_balance, 0);
    RETURN;
  END IF;

  -- (3) Compute the payout from the LOCKED balance (authoritative, no stale read).
  v_total  := ROUND(v_balance * (p_payout_total_percent / 100.0), 2);
  v_loser  := ROUND(v_total * 0.50, 2);
  v_winner := ROUND(v_total * 0.25, 2);
  v_table  := ROUND(v_total - v_loser - v_winner, 2);  -- residual keeps the split exact

  -- (4) Claim the hand BEFORE decrementing. If a concurrent txn already claimed
  --     it (same pool/table/hand), ON CONFLICT yields no row → do not decrement.
  INSERT INTO bbj_payouts (
    pool_id, hand_id, table_id, hand_number, winner_user_id, loser_user_id,
    total_amount, winner_share, loser_share, table_share, table_player_count, metadata
  ) VALUES (
    p_pool_id, NULL, p_table_id, p_hand_number, p_loser_user_id, p_winner_user_id,
    v_total, v_loser, v_winner, v_table, p_dealt_in_count, COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (pool_id, table_id, hand_number) DO NOTHING
  RETURNING id INTO v_payout_id;

  IF v_payout_id IS NULL THEN
    RETURN QUERY SELECT false, true, NULL::uuid,
                        0::numeric, 0::numeric, 0::numeric, 0::numeric, v_balance;
    RETURN;
  END IF;

  -- (5) Atomic decrement (row already locked) + stats.
  UPDATE bbj_pools
     SET main_balance    = GREATEST(0, main_balance - v_total),
         total_paid_out  = COALESCE(total_paid_out, 0) + v_total,
         hit_count       = COALESCE(hit_count, 0) + 1,
         last_hit_at     = now(),
         last_hit_amount = v_total,
         last_winner_id  = p_loser_user_id,
         last_loser_id   = p_winner_user_id,
         updated_at      = now()
   WHERE id = p_pool_id
   RETURNING main_balance INTO v_balance;

  RETURN QUERY SELECT true, false, v_payout_id, v_total, v_loser, v_winner, v_table, v_balance;
END;
$function$;
