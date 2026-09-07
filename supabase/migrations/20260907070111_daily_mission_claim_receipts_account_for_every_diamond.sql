-- A Daily Missions claim can unlock two Diamond credits in one transaction:
-- the selected mission contracts and a streak-circuit milestone fired by the
-- claimed-row trigger. The pre-v2 receipt reported only the first component,
-- even though diamondBalance already reflected both. That made the UI, wallet
-- event, and analytics disagree with the ledger.
--
-- Keep `diamonds` as the compatibility alias for the mission-contract reward,
-- and add an exact, replay-safe settlement breakdown:
--   challengeDiamonds  mission contract reward
--   milestoneDiamonds  streak circuit reward unlocked by this claim
--   diamondsCredited   exact sum of both components

BEGIN;

SET LOCAL lock_timeout = '4s';

LOCK TABLE public.daily_challenge_claim_batches
  IN SHARE ROW EXCLUSIVE MODE;
-- Match the awarder's catalog-then-claim-ledger lock order and acquire the
-- exact DDL lock up front, so a live milestone award cannot deadlock an
-- in-place lock upgrade during this bounded migration.
LOCK TABLE public.daily_challenge_milestones
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.daily_challenge_milestone_claims
  IN ACCESS EXCLUSIVE MODE;

-- The milestone awarder credits `reward_diamonds::integer`, while receipts
-- and the claim ledger preserve the numeric source value. Fractional catalog
-- data would therefore make the wallet and receipt disagree. Refuse existing
-- unsafe data before installing validated whole-Diamond constraints on both
-- the catalog and its immutable claim ledger.
DO $whole_diamond_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.daily_challenge_milestones
    WHERE reward_diamonds <> trunc(reward_diamonds)
       OR reward_diamonds > 2147483647
  ) OR EXISTS (
    SELECT 1
    FROM public.daily_challenge_milestone_claims
    WHERE reward_diamonds <> trunc(reward_diamonds)
       OR reward_diamonds > 2147483647
  ) THEN
    RAISE EXCEPTION 'Daily Missions milestone rewards must be whole 32-bit Diamonds';
  END IF;
END;
$whole_diamond_preflight$;

ALTER TABLE public.daily_challenge_milestones
  ADD CONSTRAINT daily_challenge_milestones_reward_diamonds_whole
  CHECK (
    reward_diamonds = trunc(reward_diamonds)
    AND reward_diamonds <= 2147483647
  );

ALTER TABLE public.daily_challenge_milestone_claims
  ADD CONSTRAINT daily_challenge_milestone_claims_reward_diamonds_whole
  CHECK (
    reward_diamonds = trunc(reward_diamonds)
    AND reward_diamonds <= 2147483647
  );

-- A mission card promises an exact configured reward. Contract rewards are
-- already credited directly at face value, but streak milestones passed
-- through the shared credit function as a boostable generic earning. Add the
-- milestone type to that function's exact-value allowlist so a profile
-- multiplier cannot make the wallet exceed its immutable mission receipt.
CREATE OR REPLACE FUNCTION public.add_diamonds_to_balance(
  p_user_id uuid,
  p_amount integer,
  p_type text DEFAULT 'bonus'::text,
  p_description text DEFAULT NULL::text,
  p_reference_id text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  -- Keep arithmetic wider than the legacy integer wallet columns. Explicit
  -- checks below turn overflow into a controlled result before any write.
  v_old_balance bigint;
  v_new_balance bigint;
  v_txn_id uuid;
  v_multiplier numeric(4,2) := 1.00;
  v_raw_amount integer := COALESCE(p_amount, 0);
  v_actual_amount bigint;
  v_exact_type boolean;
  v_type_key text := COALESCE(p_type, 'unknown');
  v_issuance_class text;
  v_counterparty text;
BEGIN
  v_exact_type := p_type IN (
    'trivia_entry', 'trivia_run', 'trivia_daily_bonus', 'trivia_prize_wheel',
    'pvp_stake', 'pvp_win', 'pvp_refund', 'pvp_tie_refund',
    'tournament_entry', 'tournament_entry_refund',
    'tournament_cancel_refund', 'tournament_prize',
    'daily_mission_milestone'
  );

  IF p_reference_id IS NULL AND v_exact_type THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'reference_id_required',
      'reference_required', true
    );
  END IF;

  IF p_reference_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.diamond_transactions
    WHERE user_id = p_user_id
      AND reference_id = p_reference_id
  ) THEN
    SELECT balance_after
    INTO v_new_balance
    FROM public.diamond_transactions
    WHERE user_id = p_user_id
      AND reference_id = p_reference_id
    LIMIT 1;

    RETURN jsonb_build_object(
      'success', false,
      'error', 'duplicate_reference',
      'duplicate', true,
      'new_balance', v_new_balance
    );
  END IF;

  SELECT COALESCE(diamonds, 0), COALESCE(diamond_multiplier, 1.00)
  INTO v_old_balance, v_multiplier
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'profile_not_found');
  END IF;

  IF v_raw_amount > 0
     AND NOT v_exact_type
     AND p_type NOT IN (
       'purchase', 'deduction', 'adjustment', 'refund', 'transfer',
       'diamond_gift_received', 'diamond_gift_sent', 'diamond_gift_refund',
       'diamond_received', 'live_gift_received', 'live_gift_sent',
       'vip_daily', 'vip_stipend'
     )
     AND v_multiplier > 1.00
  THEN
    v_actual_amount := round(v_raw_amount * v_multiplier);
  ELSE
    v_actual_amount := v_raw_amount;
    v_multiplier := 1.00;
  END IF;

  IF v_actual_amount < -2147483648 OR v_actual_amount > 2147483647 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'diamond_amount_out_of_range',
      'new_balance', v_old_balance
    );
  END IF;

  v_new_balance := v_old_balance + v_actual_amount;
  IF v_new_balance < 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient_diamonds',
      'new_balance', v_old_balance
    );
  END IF;
  IF v_new_balance > 2147483647 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'diamond_balance_limit',
      'new_balance', v_old_balance
    );
  END IF;

  IF v_type_key = 'purchase' THEN
    v_issuance_class := 'purchased';
    v_counterparty := 'purchase_clearing';
  ELSIF v_type_key = 'refund' OR right(v_type_key, 7) = '_refund' THEN
    v_issuance_class := 'refund';
    v_counterparty := 'revenue:' || v_type_key;
  ELSIF v_type_key IN (
    'transfer', 'diamond_gift_received', 'live_gift_received', 'diamond_received'
  ) THEN
    v_issuance_class := 'transferred';
    v_counterparty := 'player:unknown';
  ELSIF v_type_key = 'adjustment' THEN
    v_issuance_class := 'admin';
    v_counterparty := 'adjustment';
  ELSIF v_type_key IN ('union_grant', 'signup_bonus') THEN
    v_issuance_class := 'promotional';
    v_counterparty := 'promo_budget:' || v_type_key;
  ELSIF v_actual_amount < 0 THEN
    v_issuance_class := 'spend';
    v_counterparty := 'revenue:' || v_type_key;
  ELSE
    v_issuance_class := 'earned';
    v_counterparty := 'promo_budget:' || v_type_key;
  END IF;

  UPDATE public.profiles
  SET diamonds = v_new_balance,
      diamond_balance = v_new_balance,
      updated_at = now()
  WHERE id = p_user_id;

  INSERT INTO public.diamond_transactions (
    user_id,
    amount,
    transaction_type,
    type,
    description,
    balance_after,
    reference_id,
    metadata,
    counterparty,
    issuance_class
  ) VALUES (
    p_user_id,
    v_actual_amount,
    p_type,
    p_type,
    CASE
      WHEN v_actual_amount <> v_raw_amount
      THEN COALESCE(p_description, '') || format(' [%sx boost]', v_multiplier)
      ELSE p_description
    END,
    v_new_balance,
    p_reference_id,
    jsonb_build_object(
      'reference_id', p_reference_id,
      'raw_amount', v_raw_amount,
      'multiplier', v_multiplier,
      'exact_value', v_exact_type
    ),
    v_counterparty,
    v_issuance_class
  )
  RETURNING id INTO v_txn_id;

  IF COALESCE(p_amount, 0) > 0 AND p_reference_id IS NULL THEN
    BEGIN
      PERFORM public.fn_ca_diamond_incident(
        'DR4:credit_without_reference',
        'warning',
        p_user_id,
        p_amount,
        'add_diamonds_to_balance',
        jsonb_build_object('type', p_type, 'description', p_description)
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'old_balance', v_old_balance,
    'new_balance', v_new_balance,
    'amount', v_actual_amount,
    'multiplier', v_multiplier,
    'transaction_id', v_txn_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.add_diamonds_to_balance(uuid, integer, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_diamonds_to_balance(uuid, integer, text, text, text)
  TO service_role;

-- A long streak can make several configured milestones due in one pass. Guard
-- that aggregate before the integer wallet call, not merely each catalog row,
-- and fail the transaction if its exact credit cannot be written.
CREATE OR REPLACE FUNCTION public.fn_award_daily_mission_milestones(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_streak_receipt jsonb;
  v_streak integer;
  v_run_id uuid;
  v_started date;
  v_ended date;
  v_reward numeric := 0;
  v_max integer;
  v_max_reward numeric;
  v_reference text;
  v_credit jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'A Daily Missions milestone player is required';
  END IF;

  PERFORM public.fn_lock_daily_mission_user(p_user_id);
  v_streak_receipt := public.get_challenge_streak(p_user_id);
  v_streak := COALESCE((v_streak_receipt ->> 'streak')::integer, 0);
  v_run_id := NULLIF(v_streak_receipt ->> 'streakRunId', '')::uuid;
  v_started := NULLIF(v_streak_receipt ->> 'streakStartedOn', '')::date;
  v_ended := NULLIF(v_streak_receipt ->> 'streakEndedOn', '')::date;

  IF v_streak <= 0 OR v_run_id IS NULL OR v_started IS NULL OR v_ended IS NULL THEN
    RETURN 0;
  END IF;

  SELECT max(days) INTO v_max
  FROM public.daily_challenge_milestones;

  SELECT reward_diamonds INTO v_max_reward
  FROM public.daily_challenge_milestones
  WHERE days = v_max;

  WITH due AS (
    SELECT days, reward_diamonds
    FROM public.daily_challenge_milestones
    WHERE days <= v_streak
    UNION ALL
    SELECT day, v_max_reward
    FROM generate_series(
      v_max + 30,
      v_max + ((v_streak - v_max) / 30) * 30,
      30
    ) day
  ), inserted AS (
    INSERT INTO public.daily_challenge_milestone_claims (
      user_id,
      streak_run_id,
      streak_started_on,
      milestone_days,
      reward_diamonds
    )
    SELECT p_user_id, v_run_id, v_started, days, reward_diamonds
    FROM due
    ON CONFLICT DO NOTHING
    RETURNING reward_diamonds, milestone_days
  )
  SELECT COALESCE(sum(reward_diamonds), 0),
         'daily_mission_milestones:' || p_user_id::text || ':'
           || v_run_id::text || ':' || max(milestone_days)
  INTO v_reward, v_reference
  FROM inserted;

  IF v_reward > 0 THEN
    IF v_reward <> trunc(v_reward) OR v_reward > 2147483647 THEN
      RAISE EXCEPTION 'Daily Missions milestone aggregate is outside the whole-Diamond wallet range';
    END IF;

    v_credit := public.add_diamonds_to_balance(
      p_user_id,
      v_reward::integer,
      'daily_mission_milestone',
      'Daily Missions streak circuit',
      v_reference
    );

    IF COALESCE((v_credit ->> 'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Daily Missions streak milestone could not be credited: %',
        COALESCE(v_credit ->> 'error', 'unknown');
    END IF;
  END IF;

  RETURN v_reward;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_award_daily_mission_milestones(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_award_daily_mission_milestones(uuid)
  TO service_role;

-- A legacy receipt has no durable key connecting its batch row to milestone
-- rows. `now()` is transaction-stable, so several batches and one-card claims
-- in the same transaction can share one timestamp. Assigning that timestamp's
-- full milestone sum to every batch would fabricate credits. Preserve every
-- v1 receipt unchanged; only fresh settlements written below become v2.

-- The browser uses only the request-bound batch RPC, including for one card.
-- The three-argument legacy RPC cannot be replay-safe because it accepts no
-- request id. Keep its signature fail-closed for stale callers, and remove all
-- execution grants, so a lost response can never turn into a zero-value retry.
CREATE OR REPLACE FUNCTION public.claim_daily_challenge(
  p_user_id uuid,
  p_challenge_row_id uuid,
  p_reward_amount numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'Legacy claim RPC retired; use claim_daily_challenges with a request id';
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_daily_challenge(uuid, uuid, numeric)
  FROM PUBLIC, anon, authenticated, service_role;

-- Claim All keeps the existing normalized request binding and private proven
-- settlement body. The user advisory lock makes the before/after milestone
-- ledger delta exact, and the complete result is persisted back into the same
-- request row before this transaction can commit.
CREATE OR REPLACE FUNCTION public.claim_daily_challenges(
  p_user_id uuid,
  p_challenge_row_ids uuid[],
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_requested_ids uuid[];
  v_bound_ids uuid[];
  v_receipt_found boolean;
  v_stored_result jsonb;
  v_result jsonb;
  v_challenge_diamonds numeric := 0;
  v_milestone_diamonds numeric := 0;
  v_diamonds_credited numeric := 0;
  v_milestones_before numeric := 0;
  v_milestones_after numeric := 0;
  v_total_challenge_diamonds numeric := 0;
  v_total_diamonds_earned numeric := 0;
  v_opening_diamond_balance numeric;
  v_diamond_balance numeric;
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_user_id IS NULL OR p_user_id <> v_uid THEN
    RAISE EXCEPTION 'Cannot claim challenges for another user' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'A claim request id is required';
  END IF;
  IF p_challenge_row_ids IS NULL OR cardinality(p_challenge_row_ids) = 0 THEN
    RAISE EXCEPTION 'At least one challenge is required';
  END IF;
  IF cardinality(p_challenge_row_ids) > 100 THEN
    RAISE EXCEPTION 'At most 100 challenges can be claimed at once';
  END IF;
  IF array_position(p_challenge_row_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Challenge ids cannot be null';
  END IF;

  SELECT array_agg(id ORDER BY id)
  INTO v_requested_ids
  FROM (SELECT DISTINCT unnest(p_challenge_row_ids) AS id) requested;

  PERFORM public.fn_lock_daily_mission_user(v_uid);

  SELECT challenge_row_ids, result
  INTO v_bound_ids, v_stored_result
  FROM public.daily_challenge_claim_batches
  WHERE user_id = v_uid
    AND request_id = p_request_id
  FOR UPDATE;
  v_receipt_found := FOUND;

  IF v_receipt_found AND v_bound_ids IS DISTINCT FROM v_requested_ids THEN
    RAISE EXCEPTION 'Claim request id is already bound to another challenge set';
  END IF;

  IF v_receipt_found THEN
    IF v_stored_result IS NULL THEN
      RAISE EXCEPTION 'The prior claim request did not finish';
    END IF;

    IF (v_stored_result ->> 'settlementVersion') = '2'
       AND NOT (v_stored_result ?& ARRAY[
         'challengeDiamonds',
         'milestoneDiamonds',
         'diamondsCredited',
         'diamondBalance',
         'settlementDiamondBalance',
         'settlementVersion'
       ])
    THEN
      RAISE EXCEPTION 'The prior claim request has an incomplete v2 settlement receipt';
    END IF;

    SELECT COALESCE(diamonds, 0)
    INTO v_diamond_balance
    FROM public.profiles
    WHERE id = v_uid;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Profile not found - replay balance could not be reconciled';
    END IF;

    RETURN v_stored_result || jsonb_build_object(
      'replayed', true,
      'settlementDiamondBalance', COALESCE(
        (v_stored_result ->> 'settlementDiamondBalance')::numeric,
        (v_stored_result ->> 'diamondBalance')::numeric
      ),
      'diamondBalance', v_diamond_balance
    );
  END IF;

  SELECT COALESCE(diamonds, 0)
  INTO v_opening_diamond_balance
  FROM public.profiles
  WHERE id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found - opening claim balance could not be locked';
  END IF;

  SELECT COALESCE(sum(amount), 0)
  INTO v_milestones_before
  FROM public.diamond_transactions
  WHERE user_id = v_uid
    AND transaction_type = 'daily_mission_milestone';

  v_result := public.claim_daily_challenges_serialized_body(
    p_user_id,
    p_challenge_row_ids,
    p_request_id
  );

  SELECT COALESCE(diamonds, 0)
  INTO v_diamond_balance
  FROM public.profiles
  WHERE id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found - claim receipt could not be finalized';
  END IF;

  v_challenge_diamonds := COALESCE((v_result ->> 'diamonds')::numeric, 0);
  SELECT COALESCE(sum(amount), 0)
  INTO v_milestones_after
  FROM public.diamond_transactions
  WHERE user_id = v_uid
    AND transaction_type = 'daily_mission_milestone';
  v_milestone_diamonds := v_milestones_after - v_milestones_before;
  v_diamonds_credited := v_challenge_diamonds + v_milestone_diamonds;

  SELECT COALESCE(sum(diamond_reward_snapshot), 0)
  INTO v_total_challenge_diamonds
  FROM public.user_daily_challenges
  WHERE user_id = v_uid
    AND claimed = true;
  v_total_diamonds_earned := v_total_challenge_diamonds + v_milestones_after;

  IF v_challenge_diamonds < 0
     OR v_milestone_diamonds < 0
     OR v_diamonds_credited <> v_challenge_diamonds + v_milestone_diamonds
     OR v_diamond_balance - v_opening_diamond_balance <> v_diamonds_credited
  THEN
    RAISE EXCEPTION 'Claim Diamond settlement does not reconcile with the wallet';
  END IF;

  v_result := jsonb_set(
    v_result,
    '{stats,totalDiamondsEarned}',
    to_jsonb(v_total_diamonds_earned),
    true
  ) || jsonb_build_object(
    'challengeDiamonds', v_challenge_diamonds,
    'milestoneDiamonds', v_milestone_diamonds,
    'diamondsCredited', v_diamonds_credited,
    'diamondBalance', v_diamond_balance,
    'settlementDiamondBalance', v_diamond_balance,
    'settlementVersion', 2
  );

  UPDATE public.daily_challenge_claim_batches
  SET challenge_row_ids = COALESCE(challenge_row_ids, v_requested_ids),
      result = v_result
  WHERE user_id = v_uid
    AND request_id = p_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim request receipt was not persisted';
  END IF;

  SELECT challenge_row_ids, result
  INTO v_bound_ids, v_stored_result
  FROM public.daily_challenge_claim_batches
  WHERE user_id = v_uid
    AND request_id = p_request_id;

  IF NOT FOUND
     OR v_bound_ids IS DISTINCT FROM v_requested_ids
     OR v_stored_result IS DISTINCT FROM v_result
  THEN
    RAISE EXCEPTION 'Claim request receipt did not preserve its exact settlement';
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_daily_challenges(uuid, uuid[], uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_daily_challenges(uuid, uuid[], uuid)
  TO authenticated, service_role;

-- The legacy dashboard counts only contract rewards in totalDiamondsEarned.
-- Amend the public v3 aggregate with both claimed contract Diamonds and every
-- settled streak-circuit reward, using the same serialized user transaction.
CREATE OR REPLACE FUNCTION public.get_daily_challenge_dashboard_v3()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_now timestamptz := transaction_timestamp();
  v_daily_key text;
  v_weekly_key text;
  v_monthly_key text;
  v_dashboard jsonb;
  v_total_challenge_diamonds numeric := 0;
  v_total_milestone_diamonds numeric := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  v_daily_key := to_char((v_now AT TIME ZONE 'utc')::date, 'YYYY-MM-DD');
  v_weekly_key := 'W' || to_char(
    date_trunc('week', v_now AT TIME ZONE 'utc')::date,
    'YYYY-MM-DD'
  );
  v_monthly_key := 'M' || to_char(v_now AT TIME ZONE 'utc', 'YYYY-MM');

  v_dashboard := public.get_daily_challenge_dashboard_v2(
    v_daily_key,
    ARRAY[]::text[],
    v_weekly_key,
    ARRAY[]::text[],
    v_monthly_key,
    ARRAY[]::text[]
  );

  -- v2 already calculated the immutable challenge-only lifetime total in this
  -- same snapshot. Reuse it instead of rescanning the player's entire mission
  -- history on every dashboard load.
  v_total_challenge_diamonds := COALESCE(
    (v_dashboard #>> '{stats,totalDiamondsEarned}')::numeric,
    0
  );

  SELECT COALESCE(sum(amount), 0)
  INTO v_total_milestone_diamonds
  FROM public.diamond_transactions
  WHERE user_id = v_uid
    AND transaction_type = 'daily_mission_milestone';

  v_dashboard := jsonb_set(
    v_dashboard,
    '{stats,totalDiamondsEarned}',
    to_jsonb(v_total_challenge_diamonds + v_total_milestone_diamonds),
    true
  );

  RETURN v_dashboard || jsonb_build_object(
    'syncedAt', to_char(
      v_now AT TIME ZONE 'utc',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'periodKeys', jsonb_build_object(
      'daily', v_daily_key,
      'weekly', v_weekly_key,
      'monthly', v_monthly_key
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_daily_challenge_dashboard_v3()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_daily_challenge_dashboard_v3()
  TO authenticated, service_role;

COMMENT ON FUNCTION public.claim_daily_challenge(uuid, uuid, numeric) IS
'Retired fail-closed legacy entry point. All one-card and multi-card Daily Mission claims use claim_daily_challenges with an immutable request id and exact settlement receipt.';

COMMENT ON FUNCTION public.claim_daily_challenges(uuid, uuid[], uuid) IS
'Replay-safe Daily Missions batch claim. The immutable request receipt separates challengeDiamonds and milestoneDiamonds, reports their diamondsCredited sum, preserves settlementDiamondBalance, and refreshes diamondBalance to the current wallet projection on replay.';

COMMENT ON CONSTRAINT daily_challenge_milestones_reward_diamonds_whole
  ON public.daily_challenge_milestones IS
'Milestone configuration is restricted to whole Diamonds that the integer wallet credit contract can represent exactly.';

COMMENT ON CONSTRAINT daily_challenge_milestone_claims_reward_diamonds_whole
  ON public.daily_challenge_milestone_claims IS
'Immutable milestone claim receipts preserve a whole-Diamond value identical to the wallet credit.';

DO $verify$
DECLARE
  v_claim_definition text;
  v_legacy_definition text;
  v_dashboard_definition text;
  v_credit_definition text;
  v_awarder_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.claim_daily_challenges(uuid,uuid[],uuid)'::regprocedure
  ) INTO v_claim_definition;
  SELECT pg_get_functiondef(
    'public.claim_daily_challenge(uuid,uuid,numeric)'::regprocedure
  ) INTO v_legacy_definition;
  SELECT pg_get_functiondef(
    'public.get_daily_challenge_dashboard_v3()'::regprocedure
  ) INTO v_dashboard_definition;
  SELECT pg_get_functiondef(
    'public.add_diamonds_to_balance(uuid,integer,text,text,text)'::regprocedure
  ) INTO v_credit_definition;
  SELECT pg_get_functiondef(
    'public.fn_award_daily_mission_milestones(uuid)'::regprocedure
  ) INTO v_awarder_definition;

  IF v_claim_definition NOT LIKE '%challengeDiamonds%'
     OR v_claim_definition NOT LIKE '%milestoneDiamonds%'
     OR v_claim_definition NOT LIKE '%diamondsCredited%'
     OR v_claim_definition NOT LIKE '%settlementDiamondBalance%'
     OR v_claim_definition NOT LIKE '%transaction_type = ''daily_mission_milestone''%'
     OR v_claim_definition NOT LIKE '%v_total_challenge_diamonds + v_milestones_after%'
     OR position(
       'v_result := public.claim_daily_challenges_serialized_body'
       IN v_claim_definition
     ) = 0
     OR position('INTO v_total_challenge_diamonds' IN v_claim_definition)
        < position(
          'v_result := public.claim_daily_challenges_serialized_body'
          IN v_claim_definition
        )
     OR v_claim_definition NOT LIKE '%v_diamond_balance - v_opening_diamond_balance <> v_diamonds_credited%'
     OR v_claim_definition NOT LIKE '%''diamondBalance'', v_diamond_balance%'
  THEN
    RAISE EXCEPTION 'Daily Missions batch settlement receipt v2 is not installed';
  END IF;

  IF v_dashboard_definition NOT LIKE '%v_total_challenge_diamonds + v_total_milestone_diamonds%'
     OR v_dashboard_definition NOT LIKE '%{stats,totalDiamondsEarned}%'
     OR v_dashboard_definition NOT LIKE '%v_dashboard #>> ''{stats,totalDiamondsEarned}''%'
     OR v_dashboard_definition LIKE '%FROM public.user_daily_challenges%'
     OR v_dashboard_definition NOT LIKE '%transaction_type = ''daily_mission_milestone''%'
  THEN
    RAISE EXCEPTION 'Daily Missions dashboard omits milestone Diamonds from lifetime earnings';
  END IF;

  IF v_credit_definition NOT LIKE '%''daily_mission_milestone''%'
     OR v_credit_definition NOT LIKE '%v_exact_type := p_type IN%'
     OR v_credit_definition NOT LIKE '%diamond_amount_out_of_range%'
     OR v_credit_definition NOT LIKE '%diamond_balance_limit%'
  THEN
    RAISE EXCEPTION 'Daily Missions milestone credits remain multiplier-sensitive';
  END IF;

  IF v_awarder_definition NOT LIKE '%v_reward <> trunc(v_reward)%'
     OR v_awarder_definition NOT LIKE '%v_reward > 2147483647%'
  THEN
    RAISE EXCEPTION 'Daily Missions milestone aggregate is not range checked';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.daily_challenge_milestones'::regclass
      AND conname = 'daily_challenge_milestones_reward_diamonds_whole'
      AND convalidated
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.daily_challenge_milestone_claims'::regclass
      AND conname = 'daily_challenge_milestone_claims_reward_diamonds_whole'
      AND convalidated
  ) THEN
    RAISE EXCEPTION 'Daily Missions whole-Diamond milestone constraints are not validated';
  END IF;

  IF v_legacy_definition NOT LIKE '%Legacy claim RPC retired%'
     OR has_function_privilege(
       'authenticated',
       'public.claim_daily_challenge(uuid,uuid,numeric)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.claim_daily_challenge(uuid,uuid,numeric)',
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'The non-idempotent legacy Daily Missions claim entry point is executable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.daily_challenge_claim_batches batch
    WHERE batch.result ->> 'settlementVersion' = '2'
      AND (
        NOT (batch.result ?& ARRAY[
          'challengeDiamonds',
          'milestoneDiamonds',
          'diamondsCredited',
          'diamondBalance',
          'settlementDiamondBalance',
          'settlementVersion'
        ])
        OR (batch.result ->> 'diamonds')::numeric
             IS DISTINCT FROM (batch.result ->> 'challengeDiamonds')::numeric
        OR (batch.result ->> 'diamondsCredited')::numeric
             IS DISTINCT FROM (
               (batch.result ->> 'challengeDiamonds')::numeric
               + (batch.result ->> 'milestoneDiamonds')::numeric
             )
        OR (batch.result ->> 'settlementDiamondBalance')::numeric
             < (batch.result ->> 'diamondsCredited')::numeric
      )
  ) THEN
    RAISE EXCEPTION 'A Daily Missions claim receipt lacks an exact Diamond breakdown';
  END IF;
END;
$verify$;

COMMIT;
