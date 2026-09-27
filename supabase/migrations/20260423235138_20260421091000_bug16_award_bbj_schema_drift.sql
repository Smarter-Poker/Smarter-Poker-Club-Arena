-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260423235138 "20260421091000_bug16_award_bbj_schema_drift"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 234e51d0fe3ddcf8a8a4e68cc2a23cc1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG-16: award_bbj INSERT into bbj_winners references 8 columns that
-- don't exist on the table.
--
-- Schema drift map (function → actual column):
--   loser_user_id       → loser_id
--   winner_user_id      → winner_id
--   pool_before         → pool_amount_at_hit
--   loser_display_name  → (dropped — not in schema)
--   loser_cards         → (dropped — not in schema)
--   winner_display_name → (dropped)
--   winner_cards        → (dropped)
--   pool_after          → (dropped)
--   game_variant        → (dropped)
--   big_blind           → (dropped)
--
-- Impact: EVERY bad-beat jackpot hit fails 42703 — the pool deducts via
-- UPDATE but never persists the winner record. Winners don't appear in
-- the hall-of-fame; payouts happen but have no audit trail in
-- bbj_winners. Money-impacting bug.
--
-- Fix: rewrite INSERT to match the actual schema. Preserve the function
-- signature (app callers on pages/api/club-arena/buyin.js or wherever
-- aren't changed). The parameters that can't be persisted are
-- intentionally not stored — the caller doesn't check for their presence
-- in the return value, and bbj_winners never had those columns. If Dan
-- wants display_name + cards + game_variant + big_blind persisted, that
-- needs a separate schema migration adding those columns.

CREATE OR REPLACE FUNCTION public.award_bbj(
  p_club_id             uuid,
  p_table_id            uuid,
  p_hand_number         bigint,
  p_loser_user_id       uuid,
  p_loser_display_name  text,
  p_loser_hand          text,
  p_loser_cards         text,
  p_winner_user_id      uuid,
  p_winner_display_name text,
  p_winner_hand         text,
  p_winner_cards        text,
  p_payout_total_pct    numeric,
  p_payout_loser_pct    numeric,
  p_payout_winner_pct   numeric,
  p_payout_table_pct    numeric,
  p_stakes_tier         text DEFAULT 'small'::text,
  p_game_variant        text DEFAULT 'nlh'::text,
  p_big_blind           numeric DEFAULT 2
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_pool          bbj_pools%ROWTYPE;
  v_total_payout  numeric;
  v_loser_payout  numeric;
  v_winner_payout numeric;
  v_table_payout  numeric;
  v_seed_amount   numeric;
BEGIN
  SELECT * INTO v_pool FROM bbj_pools WHERE club_id = p_club_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'No BBJ pool for this club');
  END IF;

  -- Payout comes from MAIN BALANCE only (not backup or promo)
  v_total_payout  := ROUND(v_pool.main_balance * p_payout_total_pct  / 100, 2);
  v_loser_payout  := ROUND(v_pool.main_balance * p_payout_loser_pct  / 100, 2);
  v_winner_payout := ROUND(v_pool.main_balance * p_payout_winner_pct / 100, 2);
  v_table_payout  := ROUND(v_pool.main_balance * p_payout_table_pct  / 100, 2);

  -- Record the win — columns mapped to actual bbj_winners schema.
  -- Intentionally dropped (no target column): display_name, cards,
  -- pool_after, game_variant, big_blind.
  INSERT INTO bbj_winners (
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
  );

  -- After hit:
  --   1. Deduct payout from main_balance
  --   2. Move backup_balance → main_balance (seed next jackpot)
  --   3. Reset backup_balance to 0
  --   4. Keep promo_balance untouched (for union to use)
  v_seed_amount := v_pool.backup_balance;

  UPDATE bbj_pools SET
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
END;
$function$;
