-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260724062930 "bbj_atomic_payout_v2_recoverable"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 235fb5ef411d9ad9d5c7f4055af30b24 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- STREAM A / Fix 1 (P0): BBJ payout — atomic AND recoverable credit leg.
--
-- The old bbj_atomic_payout debited the pool atomically but left the WINNER
-- CREDIT to engine memory + syncStacks (a second, non-atomic step). A crash
-- between the two = pool debited, nobody paid, and a retry saw already_paid and
-- skipped crediting = permanent loss. A departed winner's table-share was also
-- dropped while the pool was debited in full.
--
-- v2 moves the crediting INSIDE the same transaction as the debit:
--   * seated recipients (present in p_seated_ids) -> table_seats.stack += share
--     (durable; the engine's later syncStacks writes the identical memory value)
--   * departed recipients (dealt-in but not seated) -> wallet credited directly
--   * every credit is claimed once via bbj_payout_recipients (payout_id,user_id)
-- On the already_paid branch it RE-DRIVES any recipient whose claim row is
-- missing (re-applying the credit WITHOUT re-debiting the pool), instead of
-- returning null. The table-share rounding remainder is folded into the loser
-- (bad-beat holder) share so Σcredits == total debited (chip-conserving even
-- when there are zero "table-only" players).
-- ═══════════════════════════════════════════════════════════════════════════

-- Idempotency claim key for per-recipient credit (enables ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX IF NOT EXISTS uq_bbj_payout_recipients_payout_user
  ON public.bbj_payout_recipients (payout_id, user_id);

-- Credit one recipient exactly once. Returns true if THIS call performed the
-- credit (claim won), false if it was already credited under this payout.
CREATE OR REPLACE FUNCTION public.bbj_credit_one_recipient(
  p_payout_id uuid,
  p_table_id  uuid,
  p_user_id   uuid,
  p_amount    numeric,
  p_seated    boolean
) RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_claimed integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN false;
  END IF;

  -- Claim: first writer for (payout_id,user_id) wins; later calls are no-ops.
  INSERT INTO bbj_payout_recipients (payout_id, user_id, amount)
  VALUES (p_payout_id, p_user_id, p_amount)
  ON CONFLICT (payout_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RETURN false;  -- already credited under this payout
  END IF;

  IF p_seated THEN
    UPDATE table_seats
       SET stack = COALESCE(stack, 0) + p_amount
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
    IF FOUND THEN
      RETURN true;  -- seat credited durably; engine syncStacks writes same value
    END IF;
    -- Seat vanished between the engine snapshot and now: fall through to wallet.
  END IF;

  -- Departed recipient (or seat gone): credit the real-money wallet directly.
  UPDATE wallets
     SET balance = COALESCE(balance, 0) + p_amount, updated_at = now()
   WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
    VALUES (p_user_id, 'PLAYER', p_amount, 0)
    ON CONFLICT (user_id, wallet_type) DO UPDATE
      SET balance = wallets.balance + p_amount, updated_at = now();
  END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.bbj_atomic_payout_v2(
  p_pool_id uuid,
  p_table_id uuid,
  p_hand_number bigint,
  p_payout_total_percent numeric,
  p_loser_user_id uuid,
  p_winner_user_id uuid,
  p_dealt_in_ids uuid[],
  p_seated_ids uuid[],
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE(
  applied boolean,
  already_paid boolean,
  recovered boolean,
  payout_id uuid,
  total_payout numeric,
  loser_share numeric,
  winner_share numeric,
  table_share numeric,
  per_player_share numeric,
  balance_after numeric
)
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_balance   numeric;
  v_total     numeric;
  v_loser     numeric;
  v_winner    numeric;
  v_table     numeric;
  v_per       numeric;
  v_remainder numeric;
  v_payout_id uuid;
  v_existing  uuid;
  v_club_id   uuid;
  v_pre_hit_balance numeric;
  v_winner_name text;
  v_loser_name  text;
  v_table_ids uuid[];
  v_n_table   integer;
  v_recovered boolean := false;
  v_uid       uuid;
BEGIN
  -- table-only recipients = dealt-in minus loser minus winner
  SELECT COALESCE(array_agg(x), ARRAY[]::uuid[])
    INTO v_table_ids
    FROM unnest(COALESCE(p_dealt_in_ids, ARRAY[]::uuid[])) AS x
   WHERE x <> p_loser_user_id AND x <> p_winner_user_id;
  v_n_table := COALESCE(array_length(v_table_ids, 1), 0);

  -- ── Already claimed: RE-DRIVE the credit leg (no re-debit) ────────────────
  SELECT id INTO v_existing
    FROM bbj_payouts
   WHERE pool_id = p_pool_id AND table_id = p_table_id AND hand_number = p_hand_number
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    SELECT bp.total_amount, bp.loser_share, bp.winner_share, bp.table_share
      INTO v_total, v_loser, v_winner, v_table
      FROM bbj_payouts bp WHERE bp.id = v_existing;

    IF v_n_table > 0 THEN
      v_per := ROUND(v_table / v_n_table, 2);
    ELSE
      v_per := 0;
    END IF;
    v_remainder := ROUND(v_table - (v_per * v_n_table), 2);

    -- Re-apply any missing recipient credits (crash/partial-recovery safety).
    IF bbj_credit_one_recipient(v_existing, p_table_id, p_loser_user_id,
         v_loser + v_remainder, p_loser_user_id = ANY(p_seated_ids)) THEN
      v_recovered := true;
    END IF;
    IF bbj_credit_one_recipient(v_existing, p_table_id, p_winner_user_id,
         v_winner, p_winner_user_id = ANY(p_seated_ids)) THEN
      v_recovered := true;
    END IF;
    FOREACH v_uid IN ARRAY v_table_ids LOOP
      IF bbj_credit_one_recipient(v_existing, p_table_id, v_uid,
           v_per, v_uid = ANY(p_seated_ids)) THEN
        v_recovered := true;
      END IF;
    END LOOP;

    RETURN QUERY SELECT false, true, v_recovered, v_existing,
                        v_total, v_loser, v_winner, v_table, v_per, NULL::numeric;
    RETURN;
  END IF;

  -- ── First claim: debit + credit atomically ────────────────────────────────
  SELECT main_balance INTO v_balance FROM bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF v_balance IS NULL OR v_balance <= 0 THEN
    RETURN QUERY SELECT false, false, false, NULL::uuid,
                        0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
                        COALESCE(v_balance, 0);
    RETURN;
  END IF;

  v_pre_hit_balance := v_balance;
  v_total  := ROUND(v_balance * (p_payout_total_percent / 100.0), 2);
  v_loser  := ROUND(v_total * 0.50, 2);
  v_winner := ROUND(v_total * 0.25, 2);
  v_table  := ROUND(v_total - v_loser - v_winner, 2);
  IF v_n_table > 0 THEN
    v_per := ROUND(v_table / v_n_table, 2);
  ELSE
    v_per := 0;
  END IF;
  -- Fold the rounding remainder (and the whole table share when nobody qualifies
  -- for it) into the loser so Σcredits == v_total exactly.
  v_remainder := ROUND(v_table - (v_per * v_n_table), 2);

  INSERT INTO bbj_payouts (
    pool_id, hand_id, table_id, hand_number, winner_user_id, loser_user_id,
    total_amount, winner_share, loser_share, table_share, table_player_count, metadata
  ) VALUES (
    p_pool_id, NULL, p_table_id, p_hand_number, p_loser_user_id, p_winner_user_id,
    v_total, v_winner, v_loser, v_table, v_n_table, COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (pool_id, table_id, hand_number) DO NOTHING
  RETURNING id INTO v_payout_id;

  IF v_payout_id IS NULL THEN
    -- Lost the claim race to a concurrent caller; treat as already_paid no-op.
    RETURN QUERY SELECT false, true, false, NULL::uuid,
                        0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, v_balance;
    RETURN;
  END IF;

  UPDATE bbj_pools
     SET main_balance    = GREATEST(0, main_balance - v_total) + COALESCE(backup_balance, 0),
         backup_balance  = 0,
         total_paid_out  = COALESCE(total_paid_out, 0) + v_total,
         hit_count       = COALESCE(hit_count, 0) + 1,
         last_hit_at     = now(),
         last_hit_amount = v_total,
         last_winner_id  = p_loser_user_id,
         last_loser_id   = p_winner_user_id,
         updated_at      = now()
   WHERE id = p_pool_id
   RETURNING main_balance, club_id INTO v_balance, v_club_id;

  -- Credit every recipient inside this same transaction.
  PERFORM bbj_credit_one_recipient(v_payout_id, p_table_id, p_loser_user_id,
            v_loser + v_remainder, p_loser_user_id = ANY(p_seated_ids));
  PERFORM bbj_credit_one_recipient(v_payout_id, p_table_id, p_winner_user_id,
            v_winner, p_winner_user_id = ANY(p_seated_ids));
  FOREACH v_uid IN ARRAY v_table_ids LOOP
    PERFORM bbj_credit_one_recipient(v_payout_id, p_table_id, v_uid,
              v_per, v_uid = ANY(p_seated_ids));
  END LOOP;

  SELECT COALESCE(NULLIF(display_name,''), NULLIF(username,''), 'Player')
    INTO v_winner_name FROM profiles WHERE id = p_loser_user_id;
  SELECT COALESCE(NULLIF(display_name,''), NULLIF(username,''), 'Player')
    INTO v_loser_name FROM profiles WHERE id = p_winner_user_id;

  INSERT INTO bbj_winners (
    pool_id, club_id, winner_id, loser_id,
    winner_display_name, loser_display_name,
    winner_hand, loser_hand,
    winner_payout, loser_payout, table_share_payout, total_payout,
    pool_amount_at_hit, table_id, hand_number, awarded_at
  ) VALUES (
    p_pool_id, v_club_id, p_loser_user_id, p_winner_user_id,
    v_winner_name, v_loser_name,
    COALESCE(p_metadata->>'winner_hand_name', 'Unknown'),
    COALESCE(p_metadata->>'loser_hand_name', 'Unknown'),
    v_loser, v_winner, v_table, v_total,
    v_pre_hit_balance, p_table_id, p_hand_number, now()
  )
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT true, false, false, v_payout_id,
                      v_total, v_loser, v_winner, v_table, v_per, v_balance;
END;
$function$;
