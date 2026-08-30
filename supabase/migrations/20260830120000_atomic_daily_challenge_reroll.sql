-- Replace the Daily Challenges page's client-only reroll mock with one
-- server-authoritative operation. The previous button subtracted 10 from the
-- lifetime "diamonds earned" statistic, showed "(Mocked)", and reloaded the
-- exact same assignment. No wallet entry or challenge row changed.
--
-- Replay rule: the client sends the challenge id it saw. The row is locked
-- before any currency moves. If a committed response is lost and retried, the
-- row no longer contains that id, so the retry returns the current assignment
-- without charging a second time.

-- Production already has a two-argument prototype that trusts p_cost (so a
-- caller can pay 1 instead of the displayed 10) and has no replay key. Remove
-- it rather than leaving an unsafe overload callable beside the replacement.
DROP FUNCTION IF EXISTS public.reroll_daily_challenge(uuid, integer);

CREATE OR REPLACE FUNCTION public.reroll_daily_challenge(
  p_user_id uuid,
  p_challenge_row_id uuid,
  p_expected_challenge_id text,
  p_cost integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  REROLL_COST constant integer := 10;
  v_uid uuid := auth.uid();
  v_row public.user_daily_challenges%ROWTYPE;
  v_tier text;
  v_replacement text;
  v_deduct jsonb;
  v_balance integer;
BEGIN
  IF v_uid IS NULL THEN v_uid := p_user_id; END IF;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authenticated');
  END IF;
  IF auth.uid() IS NOT NULL AND p_user_id IS NOT NULL AND p_user_id <> v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot reroll another player''s challenge');
  END IF;
  -- Price is server-owned. Refuse a stale or manipulated client instead of
  -- silently charging a number different from the button label.
  IF p_cost IS DISTINCT FROM REROLL_COST THEN
    RETURN jsonb_build_object('success', false, 'error', 'reroll price changed; refresh and try again');
  END IF;

  SELECT * INTO v_row
    FROM public.user_daily_challenges
   WHERE id = p_challenge_row_id
     AND user_id = v_uid
   FOR UPDATE;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'challenge not found');
  END IF;

  -- A retry after a successful commit lands here before deduct_diamonds.
  IF v_row.challenge_id IS DISTINCT FROM p_expected_challenge_id THEN
    SELECT COALESCE(diamonds, 0)::integer INTO v_balance
      FROM public.profiles WHERE id = v_uid;
    RETURN jsonb_build_object(
      'success', true,
      'alreadyRerolled', true,
      'challengeId', v_row.challenge_id,
      'diamondBalance', COALESCE(v_balance, 0));
  END IF;

  IF COALESCE(v_row.completed, false) OR COALESCE(v_row.claimed, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'completed challenges cannot be rerolled');
  END IF;

  SELECT tier INTO v_tier
    FROM public.daily_challenge_catalog
   WHERE id = v_row.challenge_id;
  IF v_tier IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'challenge catalog entry not found');
  END IF;

  -- Keep the replacement in the same reset period and never deal a duplicate
  -- already active in this player's current set.
  SELECT c.id INTO v_replacement
    FROM public.daily_challenge_catalog c
   WHERE c.tier = v_tier
     AND c.id <> v_row.challenge_id
     AND NOT EXISTS (
       SELECT 1
         FROM public.user_daily_challenges active
        WHERE active.user_id = v_uid
          AND active.assigned_date = v_row.assigned_date
          AND active.challenge_id = c.id
     )
   ORDER BY random()
   LIMIT 1;

  IF v_replacement IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no replacement challenge is available');
  END IF;

  v_deduct := public.deduct_diamonds(
    p_user_id          := v_uid,
    p_amount           := REROLL_COST,
    p_description      := 'Daily challenge reroll',
    p_transaction_type := 'challenge_reroll',
    p_source           := 'daily_challenge_reroll',
    p_metadata         := jsonb_build_object(
                            'challenge_row_id', v_row.id,
                            'from_challenge_id', v_row.challenge_id,
                            'to_challenge_id', v_replacement,
                            'tier', v_tier),
    p_reference_id     := 'challenge_reroll:' || v_row.id::text || ':' || v_row.challenge_id
  );

  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', COALESCE(v_deduct->>'error', 'not enough diamonds'));
  END IF;

  UPDATE public.user_daily_challenges
     SET challenge_id = v_replacement,
         progress = 0,
         completed = false,
         claimed = false,
         completed_at = NULL
   WHERE id = v_row.id
     AND user_id = v_uid;

  SELECT COALESCE(diamonds, 0)::integer INTO v_balance
    FROM public.profiles WHERE id = v_uid;

  RETURN jsonb_build_object(
    'success', true,
    'alreadyRerolled', false,
    'challengeId', v_replacement,
    'diamondBalance', COALESCE(v_balance, 0),
    'diamondsSpent', REROLL_COST);
END;
$function$;

REVOKE ALL ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer) TO authenticated, service_role;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'reroll_daily_challenge'
  ) THEN
    RAISE EXCEPTION 'reroll_daily_challenge was not created';
  END IF;
END $do$;
