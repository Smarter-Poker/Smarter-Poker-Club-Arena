-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260719163954 "bbj_atomic_payout_20260719"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fbf7ae8c5ffb059dafb03c7b4b2b751b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- FIX-A4 2026-07-19 — Atomic, idempotent Bad Beat Jackpot payout.
-- Replaces the non-atomic read-modify-write in processBBJPayout that could
-- double-pay (mint chips) on simultaneous hits or task retries.

CREATE UNIQUE INDEX IF NOT EXISTS bbj_payouts_pool_table_hand_uidx
  ON public.bbj_payouts (pool_id, table_id, hand_number);

CREATE OR REPLACE FUNCTION public.bbj_atomic_payout(
  p_pool_id             uuid,
  p_table_id            uuid,
  p_hand_number         bigint,
  p_payout_total_percent numeric,
  p_loser_user_id       uuid,
  p_winner_user_id      uuid,
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
  SELECT id INTO v_existing
    FROM bbj_payouts
   WHERE pool_id = p_pool_id AND table_id = p_table_id AND hand_number = p_hand_number
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN QUERY SELECT false, true, v_existing,
                        0::numeric, 0::numeric, 0::numeric, 0::numeric, NULL::numeric;
    RETURN;
  END IF;

  SELECT main_balance INTO v_balance FROM bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF v_balance IS NULL OR v_balance <= 0 THEN
    RETURN QUERY SELECT false, false, NULL::uuid,
                        0::numeric, 0::numeric, 0::numeric, 0::numeric, COALESCE(v_balance, 0);
    RETURN;
  END IF;

  v_total  := ROUND(v_balance * (p_payout_total_percent / 100.0), 2);
  v_loser  := ROUND(v_total * 0.50, 2);
  v_winner := ROUND(v_total * 0.25, 2);
  v_table  := ROUND(v_total - v_loser - v_winner, 2);

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
