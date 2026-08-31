-- Daily Missions mutations must finish as one authoritative action receipt.
--
-- Before this migration, Claim All issued up to 100 wallet mutations in a
-- client loop, then reloaded the whole dashboard. Reroll charged atomically but
-- changed only challenge_id, leaving the immutable contract snapshots from the
-- OLD mission on the row. The page then needed a second request and could show
-- the replacement id with the old name, requirement, and payout.
--
-- This migration makes one batch claim one transaction, persists its receipt
-- for replay after a lost response, and makes a reroll an explicit replacement
-- contract whose complete server row is returned immediately.

CREATE TABLE IF NOT EXISTS public.daily_challenge_claim_batches (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);

ALTER TABLE public.daily_challenge_claim_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.daily_challenge_claim_batches FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.daily_challenge_claim_batches TO service_role;

CREATE INDEX IF NOT EXISTS idx_daily_challenge_claim_batches_created_at
  ON public.daily_challenge_claim_batches (created_at);

-- A reroll is the only legal way to replace an assigned contract. The RPC sets
-- a transaction-local capability immediately before its guarded UPDATE. A
-- direct client update can never opt into this branch.
CREATE OR REPLACE FUNCTION public.fn_snapshot_daily_challenge_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_replacement_tier text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT c.name,
           c.description,
           c.challenge_type,
           c.tier,
           c.requirement,
           c.chip_reward,
           c.diamond_reward
      INTO NEW.challenge_name_snapshot,
           NEW.challenge_description_snapshot,
           NEW.challenge_type_snapshot,
           NEW.tier_snapshot,
           NEW.requirement_snapshot,
           NEW.chip_reward_snapshot,
           NEW.diamond_reward_snapshot
      FROM public.daily_challenge_catalog c
     WHERE c.id = NEW.challenge_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown challenge % - cannot snapshot its contract', NEW.challenge_id;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.challenge_id IS DISTINCT FROM OLD.challenge_id THEN
    IF current_setting('app.daily_challenge_reroll', true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'Assigned daily challenges can only be replaced by the reroll contract';
    END IF;
    IF OLD.completed OR OLD.claimed THEN
      RAISE EXCEPTION 'Completed daily challenge contracts cannot be replaced';
    END IF;
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.assigned_date IS DISTINCT FROM OLD.assigned_date
       OR NEW.id IS DISTINCT FROM OLD.id
    THEN
      RAISE EXCEPTION 'A reroll cannot move a daily challenge contract';
    END IF;

    SELECT c.name,
           c.description,
           c.challenge_type,
           c.tier,
           c.requirement,
           c.chip_reward,
           c.diamond_reward
      INTO NEW.challenge_name_snapshot,
           NEW.challenge_description_snapshot,
           NEW.challenge_type_snapshot,
           v_replacement_tier,
           NEW.requirement_snapshot,
           NEW.chip_reward_snapshot,
           NEW.diamond_reward_snapshot
      FROM public.daily_challenge_catalog c
     WHERE c.id = NEW.challenge_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown replacement challenge %', NEW.challenge_id;
    END IF;
    IF v_replacement_tier IS DISTINCT FROM OLD.tier_snapshot THEN
      RAISE EXCEPTION 'A reroll cannot change mission cycle';
    END IF;
    NEW.tier_snapshot := v_replacement_tier;
    RETURN NEW;
  END IF;

  IF NEW.challenge_name_snapshot IS DISTINCT FROM OLD.challenge_name_snapshot
     OR NEW.challenge_description_snapshot IS DISTINCT FROM OLD.challenge_description_snapshot
     OR NEW.challenge_type_snapshot IS DISTINCT FROM OLD.challenge_type_snapshot
     OR NEW.tier_snapshot IS DISTINCT FROM OLD.tier_snapshot
     OR NEW.requirement_snapshot IS DISTINCT FROM OLD.requirement_snapshot
     OR NEW.chip_reward_snapshot IS DISTINCT FROM OLD.chip_reward_snapshot
     OR NEW.diamond_reward_snapshot IS DISTINCT FROM OLD.diamond_reward_snapshot
  THEN
    RAISE EXCEPTION 'Assigned daily challenge contracts are immutable';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_snapshot_daily_challenge_contract_update
  ON public.user_daily_challenges;
CREATE TRIGGER trg_snapshot_daily_challenge_contract_update
BEFORE UPDATE OF challenge_id,
                 challenge_name_snapshot,
                 challenge_description_snapshot,
                 challenge_type_snapshot,
                 tier_snapshot,
                 requirement_snapshot,
                 chip_reward_snapshot,
                 diamond_reward_snapshot
ON public.user_daily_challenges
FOR EACH ROW
EXECUTE FUNCTION public.fn_snapshot_daily_challenge_contract();

-- A later privileged-profile guard only retained diamond SPEND and union-send
-- stack frames. That silently regressed the already-live single challenge
-- claim: its authoritative diamond credit now raised 42501. Both challenge
-- claim functions derive rewards from immutable server snapshots, update the
-- claimed row first, and ledger the exact balance in the same transaction, so
-- they are sanctioned grant paths and belong in the guard's explicit list.
CREATE OR REPLACE FUNCTION public.fn_guard_profile_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_changed text;
  v_stack text;
BEGIN
  IF public.fn_is_service_context() THEN
    RETURN NEW;
  END IF;

  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  IF v_stack ~ 'function (public\.)?deduct_diamonds\('
     OR v_stack ~ 'function (public\.)?fn_union_send_to_member\('
     OR v_stack ~ 'function (public\.)?claim_daily_challenge\('
     OR v_stack ~ 'function (public\.)?claim_daily_challenges\('
  THEN
    RETURN NEW;
  END IF;

  IF NEW.diamonds IS DISTINCT FROM OLD.diamonds THEN v_changed := 'diamonds';
  ELSIF NEW.diamond_balance IS DISTINCT FROM OLD.diamond_balance THEN v_changed := 'diamond_balance';
  ELSIF NEW.diamond_multiplier IS DISTINCT FROM OLD.diamond_multiplier THEN v_changed := 'diamond_multiplier';
  ELSIF NEW.is_vip IS DISTINCT FROM OLD.is_vip THEN v_changed := 'is_vip';
  ELSIF NEW.vip_tier IS DISTINCT FROM OLD.vip_tier THEN v_changed := 'vip_tier';
  ELSIF NEW.vip_expires_at IS DISTINCT FROM OLD.vip_expires_at THEN v_changed := 'vip_expires_at';
  END IF;

  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION
      'profiles.% is server-managed and cannot be modified by role %',
      v_changed, current_user
      USING ERRCODE = '42501',
            HINT = 'Use a server-authoritative, ledgered money RPC.';
  END IF;

  RETURN NEW;
END;
$function$;

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
  v_owned_ids uuid[] := ARRAY[]::uuid[];
  v_claimed_ids uuid[] := ARRAY[]::uuid[];
  v_already_claimed_ids uuid[] := ARRAY[]::uuid[];
  v_inserted integer := 0;
  v_existing jsonb;
  v_chips numeric := 0;
  v_diamonds integer := 0;
  v_diamond_balance integer := 0;
  v_vault_count bigint := 0;
  v_vault_chips numeric := 0;
  v_vault_diamonds bigint := 0;
  v_vault_items jsonb := '[]'::jsonb;
  v_total_claimed bigint := 0;
  v_total_chips numeric := 0;
  v_total_diamonds bigint := 0;
  v_result jsonb;
  VAULT_PAGE_SIZE constant integer := 100;
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
  IF cardinality(p_challenge_row_ids) > VAULT_PAGE_SIZE THEN
    RAISE EXCEPTION 'At most % challenges can be claimed at once', VAULT_PAGE_SIZE;
  END IF;
  IF array_position(p_challenge_row_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Challenge ids cannot be null';
  END IF;

  SELECT array_agg(id ORDER BY id)
    INTO v_requested_ids
    FROM (SELECT DISTINCT unnest(p_challenge_row_ids) AS id) requested;

  INSERT INTO public.daily_challenge_claim_batches (user_id, request_id)
  VALUES (v_uid, p_request_id)
  ON CONFLICT (user_id, request_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    SELECT result INTO v_existing
      FROM public.daily_challenge_claim_batches
     WHERE user_id = v_uid AND request_id = p_request_id
     FOR UPDATE;
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'The prior claim request did not finish';
    END IF;
    RETURN v_existing || jsonb_build_object('replayed', true);
  END IF;

  SELECT COALESCE(array_agg(locked.id ORDER BY locked.id), ARRAY[]::uuid[])
    INTO v_owned_ids
    FROM (
      SELECT id
        FROM public.user_daily_challenges
       WHERE user_id = v_uid
         AND id = ANY(v_requested_ids)
       ORDER BY id
       FOR UPDATE
    ) locked;

  IF cardinality(v_owned_ids) <> cardinality(v_requested_ids) THEN
    RAISE EXCEPTION 'One or more challenges do not belong to this player' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.user_daily_challenges
     WHERE id = ANY(v_owned_ids)
       AND (NOT completed OR progress < requirement_snapshot)
  ) THEN
    RAISE EXCEPTION 'One or more challenges are not complete';
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY id) FILTER (WHERE NOT claimed), ARRAY[]::uuid[]),
         COALESCE(array_agg(id ORDER BY id) FILTER (WHERE claimed), ARRAY[]::uuid[]),
         COALESCE(sum(chip_reward_snapshot) FILTER (WHERE NOT claimed), 0),
         COALESCE(sum(diamond_reward_snapshot) FILTER (WHERE NOT claimed), 0)
    INTO v_claimed_ids, v_already_claimed_ids, v_chips, v_diamonds
    FROM public.user_daily_challenges
   WHERE id = ANY(v_owned_ids);

  IF cardinality(v_claimed_ids) > 0 THEN
    UPDATE public.user_daily_challenges
       SET claimed = true,
           claimed_at = now()
     WHERE id = ANY(v_claimed_ids)
       AND user_id = v_uid
       AND claimed = false;

    IF v_chips > 0 AND NOT public.atomic_credit_wallet_and_log(
      v_uid,
      v_chips,
      'bonus',
      'Daily Missions batch reward',
      NULL,
      NULL,
      NULL,
      'challenge_claim_batch:' || p_request_id::text
    ) THEN
      RAISE EXCEPTION 'Challenge chip rewards could not be credited';
    END IF;

    IF v_diamonds > 0 THEN
      UPDATE public.profiles
         SET diamonds = COALESCE(diamonds, 0) + v_diamonds,
             diamond_balance = COALESCE(diamonds, 0) + v_diamonds,
             updated_at = now()
       WHERE id = v_uid
       RETURNING diamonds INTO v_diamond_balance;

      IF v_diamond_balance IS NULL THEN
        RAISE EXCEPTION 'Profile not found - diamond rewards could not be credited';
      END IF;

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
        v_diamonds,
        'daily_challenge_claim',
        'daily_challenge_claim',
        'Daily Missions batch reward',
        v_diamond_balance,
        jsonb_build_object(
          'challenge_row_ids', to_jsonb(v_claimed_ids),
          'request_id', p_request_id,
          'assigned_chip_reward', v_chips,
          'assigned_diamond_reward', v_diamonds
        ),
        'challenge_claim_batch:' || p_request_id::text || ':diamonds',
        now()
      );
    END IF;
  END IF;

  IF v_diamond_balance IS NULL OR v_diamond_balance = 0 THEN
    SELECT COALESCE(diamonds, 0)::integer INTO v_diamond_balance
      FROM public.profiles
     WHERE id = v_uid;
  END IF;

  SELECT count(*),
         COALESCE(sum(chip_reward_snapshot), 0),
         COALESCE(sum(diamond_reward_snapshot), 0)
    INTO v_vault_count, v_vault_chips, v_vault_diamonds
    FROM public.user_daily_challenges
   WHERE user_id = v_uid
     AND completed = true
     AND claimed = false;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'id', vault.id,
             'challenge_id', vault.challenge_id,
             'assigned_date', vault.assigned_date,
             'progress', vault.progress,
             'completed', vault.completed,
             'claimed', vault.claimed,
             'completed_at', vault.completed_at,
             'name', vault.challenge_name_snapshot,
             'description', vault.challenge_description_snapshot,
             'challenge_type', vault.challenge_type_snapshot,
             'requirement', vault.requirement_snapshot,
             'chip_reward', vault.chip_reward_snapshot,
             'diamond_reward', vault.diamond_reward_snapshot,
             'tier', vault.tier_snapshot
           )
           ORDER BY vault.completed_at DESC NULLS LAST, vault.id
         ), '[]'::jsonb)
    INTO v_vault_items
    FROM (
      SELECT *
        FROM public.user_daily_challenges
       WHERE user_id = v_uid
         AND completed = true
         AND claimed = false
       ORDER BY completed_at DESC NULLS LAST, created_at DESC, id
       LIMIT VAULT_PAGE_SIZE
    ) vault;

  SELECT count(*),
         COALESCE(sum(chip_reward_snapshot), 0),
         COALESCE(sum(diamond_reward_snapshot), 0)
    INTO v_total_claimed, v_total_chips, v_total_diamonds
    FROM public.user_daily_challenges
   WHERE user_id = v_uid
     AND claimed = true;

  v_result := jsonb_build_object(
    'success', true,
    'replayed', false,
    'claimedIds', to_jsonb(v_claimed_ids),
    'alreadyClaimedIds', to_jsonb(v_already_claimed_ids),
    'chips', v_chips,
    'diamonds', v_diamonds,
    'diamondBalance', COALESCE(v_diamond_balance, 0),
    'stats', jsonb_build_object(
      'totalClaimed', v_total_claimed,
      'totalChipsEarned', v_total_chips,
      'totalDiamondsEarned', v_total_diamonds
    ),
    'vault', jsonb_build_object(
      'count', v_vault_count,
      'chips', v_vault_chips,
      'diamonds', v_vault_diamonds,
      'items', v_vault_items,
      'pageSize', VAULT_PAGE_SIZE,
      'hasMore', v_vault_count > VAULT_PAGE_SIZE
    )
  );

  UPDATE public.daily_challenge_claim_batches
     SET result = v_result
   WHERE user_id = v_uid AND request_id = p_request_id;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_daily_challenges(uuid, uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_daily_challenges(uuid, uuid[], uuid)
  TO authenticated, service_role;

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
  v_replacement text;
  v_deduct jsonb;
  v_balance integer;
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authenticated');
  END IF;
  IF p_user_id IS NULL OR p_user_id <> v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot reroll another player''s challenge');
  END IF;
  IF p_cost IS DISTINCT FROM REROLL_COST THEN
    RETURN jsonb_build_object('success', false, 'error', 'reroll price changed; refresh and try again');
  END IF;

  SELECT * INTO v_row
    FROM public.user_daily_challenges
   WHERE id = p_challenge_row_id
     AND user_id = v_uid
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'challenge not found');
  END IF;

  IF v_row.challenge_id IS DISTINCT FROM p_expected_challenge_id THEN
    SELECT COALESCE(diamonds, 0)::integer INTO v_balance
      FROM public.profiles WHERE id = v_uid;
    RETURN jsonb_build_object(
      'success', true,
      'alreadyRerolled', true,
      'challengeId', v_row.challenge_id,
      'diamondBalance', COALESCE(v_balance, 0),
      'challenge', jsonb_build_object(
        'id', v_row.id,
        'challenge_id', v_row.challenge_id,
        'assigned_date', v_row.assigned_date,
        'progress', v_row.progress,
        'completed', v_row.completed,
        'claimed', v_row.claimed,
        'completed_at', v_row.completed_at,
        'name', v_row.challenge_name_snapshot,
        'description', v_row.challenge_description_snapshot,
        'challenge_type', v_row.challenge_type_snapshot,
        'requirement', v_row.requirement_snapshot,
        'chip_reward', v_row.chip_reward_snapshot,
        'diamond_reward', v_row.diamond_reward_snapshot,
        'tier', v_row.tier_snapshot
      )
    );
  END IF;

  IF v_row.completed OR v_row.claimed THEN
    RETURN jsonb_build_object('success', false, 'error', 'completed challenges cannot be rerolled');
  END IF;

  SELECT c.id INTO v_replacement
    FROM public.daily_challenge_catalog c
   WHERE c.tier = v_row.tier_snapshot
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
                            'tier', v_row.tier_snapshot),
    p_reference_id     := 'challenge_reroll:' || v_row.id::text || ':' || v_row.challenge_id
  );

  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', COALESCE(v_deduct->>'error', 'not enough diamonds'));
  END IF;

  PERFORM set_config('app.daily_challenge_reroll', '1', true);
  UPDATE public.user_daily_challenges
     SET challenge_id = v_replacement,
         progress = 0,
         completed = false,
         claimed = false,
         completed_at = NULL,
         claimed_at = NULL
   WHERE id = v_row.id
     AND user_id = v_uid
  RETURNING * INTO v_row;

  SELECT COALESCE(diamonds, 0)::integer INTO v_balance
    FROM public.profiles WHERE id = v_uid;

  RETURN jsonb_build_object(
    'success', true,
    'alreadyRerolled', false,
    'challengeId', v_row.challenge_id,
    'diamondBalance', COALESCE(v_balance, 0),
    'diamondsSpent', REROLL_COST,
    'challenge', jsonb_build_object(
      'id', v_row.id,
      'challenge_id', v_row.challenge_id,
      'assigned_date', v_row.assigned_date,
      'progress', v_row.progress,
      'completed', v_row.completed,
      'claimed', v_row.claimed,
      'completed_at', v_row.completed_at,
      'name', v_row.challenge_name_snapshot,
      'description', v_row.challenge_description_snapshot,
      'challenge_type', v_row.challenge_type_snapshot,
      'requirement', v_row.requirement_snapshot,
      'chip_reward', v_row.chip_reward_snapshot,
      'diamond_reward', v_row.diamond_reward_snapshot,
      'tier', v_row.tier_snapshot
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.claim_daily_challenges(uuid, uuid[], uuid)
IS 'Claims up to 100 completed Daily Missions in one replay-safe wallet transaction and returns exact next-page vault and career totals.';

COMMENT ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer)
IS 'Atomically spends the server-owned reroll price, replaces every immutable assignment snapshot, and returns the complete replacement contract.';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'claim_daily_challenges'
       AND p.proargtypes = '2950 2951 2950'::oidvector
  ) THEN
    RAISE EXCEPTION 'claim_daily_challenges(uuid, uuid[], uuid) was not created';
  END IF;
END;
$verify$;

NOTIFY pgrst, 'reload schema';
