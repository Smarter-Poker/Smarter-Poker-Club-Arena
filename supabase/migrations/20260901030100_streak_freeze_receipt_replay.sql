-- A committed 2 -> 3 freeze purchase whose response was lost used to fail its
-- same-request retry at the mutable inventory cap. Resolve the immutable
-- receipt before evaluating that cap.

CREATE OR REPLACE FUNCTION public.buy_streak_freeze(
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
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN v_uid := p_user_id; END IF;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authenticated');
  END IF;
  IF p_user_id IS NULL OR p_user_id <> v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot buy a freeze for another player');
  END IF;
  IF p_cost IS DISTINCT FROM FREEZE_COST THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'streak freeze price changed; refresh and try again',
      'expectedCost', FREEZE_COST);
  END IF;

  v_reference_id := CASE WHEN p_request_id IS NULL THEN NULL
    ELSE 'streak_freeze:' || v_uid::text || ':' || p_request_id::text END;

  INSERT INTO public.challenge_streak_state (user_id) VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_state FROM public.challenge_streak_state
   WHERE user_id = v_uid FOR UPDATE;

  -- The diamond receipt is committed atomically with the inventory increment.
  -- A retry must observe it before any mutable refusal, especially at 3/3.
  IF v_reference_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.diamond_transactions
     WHERE user_id = v_uid AND reference_id = v_reference_id
  ) THEN
    SELECT COALESCE(diamonds, 0)::integer INTO v_balance FROM public.profiles WHERE id = v_uid;
    RETURN jsonb_build_object(
      'success', true, 'alreadyPurchased', true,
      'freezesAvailable', v_state.freezes_available,
      'diamondsSpent', 0, 'diamondBalance', COALESCE(v_balance, 0));
  END IF;

  IF v_state.freezes_available >= MAX_FREEZES THEN
    SELECT COALESCE(diamonds, 0)::integer INTO v_balance FROM public.profiles WHERE id = v_uid;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'You already hold the maximum of ' || MAX_FREEZES || ' streak freezes',
      'freezesAvailable', v_state.freezes_available,
      'diamondBalance', COALESCE(v_balance, 0));
  END IF;

  v_deduct := public.deduct_diamonds(
    p_user_id := v_uid, p_amount := FREEZE_COST,
    p_description := 'Streak freeze', p_transaction_type := 'streak_freeze',
    p_source := 'streak_freeze',
    p_metadata := jsonb_build_object('freezes_before', v_state.freezes_available),
    p_reference_id := v_reference_id, p_cooldown_seconds := 0
  );
  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object(
      'success', false, 'error', COALESCE(v_deduct->>'error', 'not enough diamonds'),
      'diamondBalance', COALESCE((v_deduct->>'balance')::integer, 0));
  END IF;
  IF COALESCE((v_deduct->>'idempotent')::boolean, false) THEN
    RETURN jsonb_build_object(
      'success', true, 'alreadyPurchased', true,
      'freezesAvailable', v_state.freezes_available,
      'diamondsSpent', 0,
      'diamondBalance', COALESCE((v_deduct->>'balance')::integer, 0));
  END IF;

  UPDATE public.challenge_streak_state
     SET freezes_available = freezes_available + 1, updated_at = now()
   WHERE user_id = v_uid RETURNING freezes_available INTO v_after;
  RETURN jsonb_build_object(
    'success', true, 'alreadyPurchased', false,
    'freezesAvailable', v_after, 'diamondsSpent', FREEZE_COST,
    'diamondBalance', COALESCE((v_deduct->>'balance')::integer, 0));
END;
$function$;

REVOKE ALL ON FUNCTION public.buy_streak_freeze(uuid, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buy_streak_freeze(uuid, integer, uuid)
  TO authenticated, service_role;
