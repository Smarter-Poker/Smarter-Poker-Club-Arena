-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260724063209 "bbj_credit_recipient_via_whitelisted_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d9ffa7c7cfbe8a8c4aa0bc4dc01abd76 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: the Phase 4.1.6a wallet guard forbids direct UPDATE wallets unless a
-- whitelisted RPC is on the call stack. Route the departed/seat-gone wallet
-- credit through credit_player_wallet (whitelisted). Idempotency is owned solely
-- by the bbj_payout_recipients claim row so the redrive path can genuinely
-- re-credit a recipient whose claim was lost (no idempotency key on the wallet
-- RPC, which would otherwise block the recovery re-credit).
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
    -- Seat vanished since the engine snapshot: fall through to wallet credit.
  END IF;

  -- Departed recipient (or seat gone): credit the real-money wallet via the
  -- whitelisted RPC so the Phase 4.1.6a guard permits the write.
  PERFORM credit_player_wallet(p_user_id, p_amount);
  RETURN true;
END;
$function$;
