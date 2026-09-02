-- Daily Missions economy contracts must be owned by the server.
--
-- 1. buy_streak_freeze used the caller's p_cost after checking only p_cost > 0.
--    An authenticated caller could therefore buy the 5,000-diamond item for 1.
-- 2. production's catalog-authoritative claim_daily_challenge was never
--    recorded in migration history. A rebuilt database installed the obsolete
--    boolean function that trusted the caller's reward amount.
-- 3. the production claim function allowed the balance credit to commit even
--    when its diamond ledger insert failed.

DROP FUNCTION IF EXISTS public.buy_streak_freeze(uuid, integer, uuid);
DROP FUNCTION IF EXISTS public.buy_streak_freeze(uuid, integer);

CREATE FUNCTION public.buy_streak_freeze(
  p_user_id uuid,
  p_cost integer,
  p_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  FREEZE_COST constant integer := 5000;
  MAX_FREEZES constant integer := 3;
  v_uid uuid := auth.uid();
  v_state public.challenge_streak_state%ROWTYPE;
  v_deduct jsonb;
  v_after integer;
  v_reference_id text;
  v_balance integer;
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authenticated');
  END IF;
  IF p_user_id IS NULL OR p_user_id <> v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot buy a freeze for another player');
  END IF;

  -- The argument remains temporarily for old deployed clients, but it is never
  -- used as the amount. A stale or manipulated client is refused explicitly.
  IF p_cost IS DISTINCT FROM FREEZE_COST THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'streak freeze price changed; refresh and try again',
      'expectedCost', FREEZE_COST);
  END IF;

  INSERT INTO public.challenge_streak_state (user_id)
  VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO v_state
  FROM public.challenge_streak_state
  WHERE user_id = v_uid
  FOR UPDATE;

  IF v_state.freezes_available >= MAX_FREEZES THEN
    SELECT COALESCE(diamonds, 0)::integer INTO v_balance
    FROM public.profiles WHERE id = v_uid;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'You already hold the maximum of ' || MAX_FREEZES || ' streak freezes',
      'freezesAvailable', v_state.freezes_available,
      'diamondBalance', COALESCE(v_balance, 0));
  END IF;

  v_reference_id := CASE
    WHEN p_request_id IS NULL THEN NULL
    ELSE 'streak_freeze:' || v_uid::text || ':' || p_request_id::text
  END;

  v_deduct := public.deduct_diamonds(
    p_user_id          := v_uid,
    p_amount           := FREEZE_COST,
    p_description      := 'Streak freeze',
    p_transaction_type := 'streak_freeze',
    p_source           := 'streak_freeze',
    p_metadata         := jsonb_build_object('freezes_before', v_state.freezes_available),
    p_reference_id     := v_reference_id,
    p_cooldown_seconds := 0
  );

  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', COALESCE(v_deduct->>'error', 'not enough diamonds'),
      'diamondBalance', COALESCE((v_deduct->>'balance')::integer, 0));
  END IF;

  -- A retry with the same request UUID observes the first ledger row. The
  -- freeze was already added by that committed transaction, so do not add it a
  -- second time.
  IF COALESCE((v_deduct->>'idempotent')::boolean, false) THEN
    RETURN jsonb_build_object(
      'success', true,
      'alreadyPurchased', true,
      'freezesAvailable', v_state.freezes_available,
      'diamondsSpent', 0,
      'diamondBalance', COALESCE((v_deduct->>'balance')::integer, 0));
  END IF;

  UPDATE public.challenge_streak_state
  SET freezes_available = freezes_available + 1,
      updated_at = now()
  WHERE user_id = v_uid
  RETURNING freezes_available INTO v_after;

  RETURN jsonb_build_object(
    'success', true,
    'alreadyPurchased', false,
    'freezesAvailable', v_after,
    'diamondsSpent', FREEZE_COST,
    'diamondBalance', COALESCE((v_deduct->>'balance')::integer, 0));
END;
$function$;

REVOKE ALL ON FUNCTION public.buy_streak_freeze(uuid, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buy_streak_freeze(uuid, integer, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.claim_daily_challenge(
  p_user_id uuid,
  p_challenge_row_id uuid,
  p_reward_amount numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.user_daily_challenges%ROWTYPE;
  v_cat public.daily_challenge_catalog%ROWTYPE;
  v_new_diamonds integer;
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_user_id IS NULL OR p_user_id <> v_uid THEN
    RAISE EXCEPTION 'Cannot claim a challenge for another user' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
  FROM public.user_daily_challenges
  WHERE id = p_challenge_row_id AND user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Challenge not found'; END IF;

  IF v_row.claimed THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'alreadyClaimed', true,
      'chips', 0,
      'diamonds', 0,
      'diamondBalance', (
        SELECT COALESCE(diamonds, 0) FROM public.profiles WHERE id = v_uid
      ));
  END IF;

  IF NOT v_row.completed THEN
    RAISE EXCEPTION 'Challenge not completed yet';
  END IF;

  SELECT * INTO v_cat
  FROM public.daily_challenge_catalog
  WHERE id = v_row.challenge_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown challenge % - not in the server catalog', v_row.challenge_id;
  END IF;

  IF COALESCE(v_row.progress, 0) < v_cat.requirement THEN
    RAISE EXCEPTION 'Challenge progress %/% does not meet the requirement',
      COALESCE(v_row.progress, 0), v_cat.requirement;
  END IF;

  -- Kept only for deployed-client compatibility. The server catalog owns the
  -- reward and a mismatch is a stale/tampered contract, never a new price.
  IF p_reward_amount IS NOT NULL AND p_reward_amount IS DISTINCT FROM v_cat.chip_reward THEN
    RAISE EXCEPTION 'Challenge reward changed; refresh and try again';
  END IF;

  UPDATE public.user_daily_challenges
  SET claimed = true, claimed_at = now()
  WHERE id = p_challenge_row_id;

  IF COALESCE(v_cat.chip_reward, 0) > 0 THEN
    IF NOT public.atomic_credit_wallet_and_log(
      v_uid,
      v_cat.chip_reward,
      'bonus',
      'Challenge reward: ' || v_row.challenge_id,
      NULL,
      NULL,
      NULL,
      'challenge_claim:' || p_challenge_row_id::text
    ) THEN
      RAISE EXCEPTION 'Challenge chip reward credit failed';
    END IF;
  END IF;

  IF COALESCE(v_cat.diamond_reward, 0) > 0 THEN
    UPDATE public.profiles
    SET diamonds = COALESCE(diamonds, 0) + v_cat.diamond_reward,
        diamond_balance = COALESCE(diamonds, 0) + v_cat.diamond_reward,
        updated_at = now()
    WHERE id = v_uid
    RETURNING diamonds INTO v_new_diamonds;

    IF v_new_diamonds IS NULL THEN
      RAISE EXCEPTION 'Profile not found for user % - diamond credit failed', v_uid;
    END IF;

    -- This insert is intentionally not wrapped in an exception handler. The
    -- claimed flag, balance credit, and ledger receipt either all commit or all
    -- roll back.
    INSERT INTO public.diamond_transactions (
      user_id,
      amount,
      transaction_type,
      type,
      description,
      balance_after,
      metadata,
      reference_id,
      created_at
    ) VALUES (
      v_uid,
      v_cat.diamond_reward,
      'daily_challenge_claim',
      'daily_challenge_claim',
      'Challenge reward: ' || v_row.challenge_id,
      v_new_diamonds,
      jsonb_build_object(
        'challenge_row_id', p_challenge_row_id,
        'challenge_id', v_row.challenge_id
      ),
      'challenge_claim:' || p_challenge_row_id::text || ':diamonds',
      now()
    );
  ELSE
    SELECT COALESCE(diamonds, 0) INTO v_new_diamonds
    FROM public.profiles WHERE id = v_uid;
  END IF;

  RETURN jsonb_build_object(
    'claimed', true,
    'alreadyClaimed', false,
    'challengeId', v_row.challenge_id,
    'chips', COALESCE(v_cat.chip_reward, 0),
    'diamonds', COALESCE(v_cat.diamond_reward, 0),
    'diamondBalance', COALESCE(v_new_diamonds, 0));
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_daily_challenge(uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_daily_challenge(uuid, uuid, numeric) TO authenticated, service_role;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'buy_streak_freeze'
      AND p.proargtypes = '2950 23 2950'::oidvector
  ) THEN
    RAISE EXCEPTION 'buy_streak_freeze(uuid, integer, uuid) was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'claim_daily_challenge'
      AND p.proargtypes = '2950 2950 1700'::oidvector
  ) THEN
    RAISE EXCEPTION 'claim_daily_challenge(uuid, uuid, numeric) was not created';
  END IF;
END;
$verify$;
