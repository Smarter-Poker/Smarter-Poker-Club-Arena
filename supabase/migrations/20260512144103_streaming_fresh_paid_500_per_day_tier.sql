-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260512144103 "streaming_fresh_paid_500_per_day_tier"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 eb1c113fa4ec1aa1b3909bf13778bb98 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Refine GFT-5 trusted-sender bypass per Dan's instruction:
--   "USERS UNDER 30 DAYS ARE LIMITED TO 500 DIAMONDS PER DAY ONLY IF THEY ARE
--    'PAID FOR DIAMONDS'. 7 DAYS AFTER PURCHASED, HAVE NO LIMITS."
--
-- New tier ladder:
--   1. KINGFISH                    → unlimited
--   2. self-transfer / banned      → blocked
--   3. flagged                     → standard pair/user/burst caps
--   4. paid AND ≥7d since first
--      completed purchase          → unlimited (trusted_purchaser_7d_bypass)
--   5. ≥120d account age unflagged → unlimited (trusted_120d_unflagged_bypass)
--   6. <30d account age + paid
--      + <7d since first purchase  → 500 💎 / 24h (fresh_paid_24h_cap)
--   7. everyone else               → standard pair/user/burst caps
--
-- The 7d cooldown is per first completed non-refunded diamond_purchases row
-- (MIN(completed_at)). Provides chargeback protection: a fraudster who buys
-- diamonds with a stolen card and dumps to a confederate can't transfer more
-- than 500/day for the first week.
--
-- 500/day cap applies across ALL FIVE user→user diamond movement channels
-- (same aggregation as the standard caps): live_gift_sent + diamond_gift_sent
-- (transaction_type) and stream_gift + wallet_transfer + wallet_diamond_transfer
-- (source).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_check_anti_farming_gift_cap(
  p_sender_id    uuid,
  p_recipient_id uuid,
  p_amount       integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_kingfish              uuid := '47965354-0e56-43ef-931c-ddaab82af765';
  v_pair_24h              bigint;
  v_total_24h             bigint;
  v_burst_60s             bigint;
  v_fresh_paid_24h        bigint;
  v_active_ban            boolean;
  v_is_flagged            boolean;
  v_created_at            timestamptz;
  v_first_purchase_at     timestamptz;
  v_account_age_days      numeric;
  v_days_since_purchase   numeric;
  CAP_PER_PAIR_24H        constant integer := 5000;
  CAP_PER_USER_24H        constant integer := 50000;
  CAP_BURST_60S           constant integer := 2000;
  CAP_FRESH_PAID_24H      constant integer := 500;
  TRUST_AGE_DAYS          constant integer := 120;
  NEW_USER_DAYS           constant integer := 30;
  PURCHASE_COOLDOWN_DAYS  constant integer := 7;
BEGIN
  -- ── Argument validation ─────────────────────────────────────────────────
  IF p_sender_id IS NULL OR p_recipient_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'Invalid arguments', 'code', 'invalid_args');
  END IF;
  IF p_sender_id = p_recipient_id THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'Cannot send to self', 'code', 'self_transfer');
  END IF;

  -- ── KINGFISH bypass ─────────────────────────────────────────────────────
  IF p_sender_id = v_kingfish THEN
    RETURN jsonb_build_object('allowed', true, 'reason', 'kingfish_sender_bypass', 'code', 'ok');
  END IF;

  -- ── Banned-by-recipient (applies to everyone) ───────────────────────────
  SELECT EXISTS (
    SELECT 1 FROM live_bans lb
      JOIN live_streams ls ON ls.id = lb.stream_id
     WHERE lb.banned_user_id = p_sender_id
       AND ls.broadcaster_id = p_recipient_id
  ) INTO v_active_ban;
  IF v_active_ban THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'You are banned from this broadcaster', 'code', 'banned_by_recipient');
  END IF;

  -- ── Load sender state ───────────────────────────────────────────────────
  SELECT COALESCE(is_farming_flagged, false), created_at
    INTO v_is_flagged, v_created_at
    FROM profiles WHERE id = p_sender_id;

  -- ── Trust ladder (only for unflagged senders) ───────────────────────────
  IF v_is_flagged IS NOT TRUE THEN
    SELECT MIN(completed_at) INTO v_first_purchase_at
      FROM diamond_purchases
      WHERE user_id = p_sender_id
        AND status = 'completed'
        AND refunded_at IS NULL;

    v_account_age_days := CASE
      WHEN v_created_at IS NULL THEN 0
      ELSE EXTRACT(epoch FROM (now() - v_created_at)) / 86400
    END;

    v_days_since_purchase := CASE
      WHEN v_first_purchase_at IS NULL THEN NULL
      ELSE EXTRACT(epoch FROM (now() - v_first_purchase_at)) / 86400
    END;

    -- Tier 4: paid AND ≥7d since first completed purchase → unlimited
    IF v_first_purchase_at IS NOT NULL
       AND v_days_since_purchase >= PURCHASE_COOLDOWN_DAYS THEN
      RETURN jsonb_build_object(
        'allowed', true,
        'reason',  'trusted_purchaser_7d_bypass',
        'code',    'ok'
      );
    END IF;

    -- Tier 5: ≥120d account age + unflagged → unlimited
    IF v_account_age_days >= TRUST_AGE_DAYS THEN
      RETURN jsonb_build_object(
        'allowed', true,
        'reason',  'trusted_120d_unflagged_bypass',
        'code',    'ok'
      );
    END IF;

    -- Tier 6: <30d + paid + <7d since purchase → 500/24h cap (instead of block)
    IF v_account_age_days < NEW_USER_DAYS
       AND v_first_purchase_at IS NOT NULL THEN
      SELECT COALESCE(SUM(ABS(amount)), 0) INTO v_fresh_paid_24h
        FROM diamond_transactions
       WHERE user_id = p_sender_id
         AND amount  < 0
         AND created_at > now() - interval '24 hours'
         AND (transaction_type IN ('live_gift_sent','diamond_gift_sent')
           OR source IN ('stream_gift','wallet_transfer','wallet_diamond_transfer'));

      IF v_fresh_paid_24h + p_amount > CAP_FRESH_PAID_24H THEN
        RETURN jsonb_build_object(
          'allowed', false,
          'reason',  format('Fresh-paid users are capped at %s 💎 / 24h for the first 7 days after purchase', CAP_FRESH_PAID_24H),
          'code',    'fresh_paid_24h_cap'
        );
      END IF;

      RETURN jsonb_build_object(
        'allowed', true,
        'reason',  'fresh_paid_within_500_per_day',
        'code',    'ok'
      );
    END IF;
  END IF;

  -- ── Tier 7: standard pair/user/burst caps for everyone else ─────────────
  -- Channels aggregated: live_gift_sent + diamond_gift_sent (transaction_type)
  -- and stream_gift + wallet_transfer + wallet_diamond_transfer (source).

  SELECT COALESCE(SUM(ABS(amount)), 0) INTO v_pair_24h
    FROM diamond_transactions
   WHERE user_id = p_sender_id
     AND amount  < 0
     AND created_at > now() - interval '24 hours'
     AND metadata->>'recipient_id' = p_recipient_id::text
     AND (transaction_type IN ('live_gift_sent','diamond_gift_sent')
       OR source IN ('stream_gift','wallet_transfer','wallet_diamond_transfer'));
  IF v_pair_24h + p_amount > CAP_PER_PAIR_24H THEN
    RETURN jsonb_build_object('allowed', false, 'reason', format('Pair limit hit (%s 💎 / 24h to this user)', CAP_PER_PAIR_24H), 'code', 'pair_24h_cap');
  END IF;

  SELECT COALESCE(SUM(ABS(amount)), 0) INTO v_total_24h
    FROM diamond_transactions
   WHERE user_id = p_sender_id
     AND amount  < 0
     AND created_at > now() - interval '24 hours'
     AND (transaction_type IN ('live_gift_sent','diamond_gift_sent')
       OR source IN ('stream_gift','wallet_transfer','wallet_diamond_transfer'));
  IF v_total_24h + p_amount > CAP_PER_USER_24H THEN
    RETURN jsonb_build_object('allowed', false, 'reason', format('Daily limit hit (%s 💎 / 24h)', CAP_PER_USER_24H), 'code', 'user_24h_cap');
  END IF;

  SELECT COALESCE(SUM(ABS(amount)), 0) INTO v_burst_60s
    FROM diamond_transactions
   WHERE user_id = p_sender_id
     AND amount  < 0
     AND created_at > now() - interval '60 seconds'
     AND (transaction_type IN ('live_gift_sent','diamond_gift_sent')
       OR source IN ('stream_gift','wallet_transfer','wallet_diamond_transfer'));
  IF v_burst_60s + p_amount > CAP_BURST_60S THEN
    RETURN jsonb_build_object('allowed', false, 'reason', format('Slow down — %s 💎 in 60s is too fast', CAP_BURST_60S), 'code', 'burst_cap');
  END IF;

  RETURN jsonb_build_object('allowed', true, 'reason', 'within_caps', 'code', 'ok');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_check_anti_farming_gift_cap(uuid, uuid, integer)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_check_anti_farming_gift_cap(uuid, uuid, integer) IS
  'GFT-5 unified anti-farming cap check (refined for fresh-paid tier). '
  'Trust ladder: '
  '(1) KINGFISH = unlimited; '
  '(2) banned/self/null = blocked; '
  '(3) flagged → standard pair/user/burst caps; '
  '(4) paid + ≥7d since first completed purchase → unlimited (trusted_purchaser_7d_bypass); '
  '(5) ≥120d unflagged → unlimited (trusted_120d_unflagged_bypass); '
  '(6) <30d + paid + <7d since first purchase → 500/24h cap (fresh_paid_24h_cap); '
  '(7) everyone else → 5000 pair/24h, 50000 user/24h, 2000 burst/60s. '
  'All caps aggregate across the five user-to-user channels: live_gift_sent + '
  'diamond_gift_sent (transaction_type) and stream_gift + wallet_transfer + '
  'wallet_diamond_transfer (source).';
