-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820015511 "challenge_diamond_rewards_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c72326d0e5161a920ebb1073f7eafda9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.
-- unqualified-write-ok: public.daily_challenge_catalog because it ran once, at migration top level, as postgres
--   when production applied 20260820015511; it is in no function body and cannot be reached
--   through PostgREST. This file records that SQL; it is not new work.

-- ============================================================================
-- DAILY CHALLENGES PAY DIAMONDS                                       Tier 3
-- ============================================================================
-- Challenges paid chips only. Chips are table stakes -- they are what you play
-- WITH, so paying them for a challenge just tops up the thing the player is
-- already spending. Diamonds are the premium currency the store, VIP and
-- marketplace run on, so a diamond reward is the one that feels like a prize
-- and gives the daily loop a reason to exist.
--
-- Chips are KEPT alongside diamonds -- dropping them would be a silent
-- downgrade for anyone already grinding the existing challenges.
--
-- SOURCE OF TRUTH: profiles.diamonds is what DiamondService.getBalance() reads
-- and what the header displays. profiles.diamond_balance is a mirror column
-- every existing credit path keeps in step, so both are written.
--
-- IDEMPOTENCY: none of the existing diamond helpers (fn_add_diamonds,
-- fn_credit_diamonds) are idempotent -- a retry double-credits. Tolerable
-- behind a payment flow; NOT tolerable on a "Claim" tap over a flaky
-- connection. The claim path's own `claimed` flag under FOR UPDATE is the
-- guard: the row is marked claimed in the SAME transaction as the credit.
--
-- AUTH RULE (matches the other challenge RPCs): an end-user JWT wins and
-- p_user_id is ignored; only a server context (auth.uid() IS NULL --
-- service_role or postgres) may name another user. `anon` holds no grant.
-- ============================================================================

ALTER TABLE public.daily_challenge_catalog
  ADD COLUMN IF NOT EXISTS diamond_reward INTEGER NOT NULL DEFAULT 0
    CHECK (diamond_reward >= 0);

-- Modest on purpose: diamonds are premium. A daily should feel worth doing,
-- not like a faucet.
UPDATE public.daily_challenge_catalog SET diamond_reward = CASE
  WHEN id = 'hands_10'      THEN 1
  WHEN id = 'hands_15'      THEN 1
  WHEN id = 'hands_25'      THEN 2
  WHEN id = 'hands_40'      THEN 3
  WHEN id = 'hands_50'      THEN 3
  WHEN id = 'hands_75'      THEN 4
  WHEN id = 'hands_100'     THEN 5
  WHEN id = 'wins_3'        THEN 2
  WHEN id = 'wins_5'        THEN 3
  WHEN id = 'wins_7'        THEN 3
  WHEN id = 'wins_10'       THEN 4
  WHEN id = 'wins_15'       THEN 5
  WHEN id = 'showdown_3'    THEN 2
  WHEN id = 'showdown_5'    THEN 2
  WHEN id = 'showdown_8'    THEN 3
  WHEN id = 'showdown_10'   THEN 4
  WHEN id = 'tourney_1'     THEN 2
  WHEN id = 'tourney_2'     THEN 3
  WHEN id = 'tourney_3'     THEN 4
  WHEN id = 'friend_1'      THEN 2
  -- Skill challenges pay more: they cannot be ground out by volume.
  WHEN id = 'big_pot_1'     THEN 3
  WHEN id = 'big_pot_3'     THEN 6
  WHEN id = 'strong_hand_1' THEN 3
  WHEN id = 'strong_hand_3' THEN 7
  WHEN id = 'weekly_hands_250'      THEN 12
  WHEN id = 'weekly_wins_50'        THEN 15
  WHEN id = 'weekly_showdowns_20'   THEN 10
  WHEN id = 'weekly_tourneys_10'    THEN 18
  WHEN id = 'weekly_big_pots_10'    THEN 15
  WHEN id = 'weekly_strong_hands_8' THEN 14
  WHEN id = 'monthly_hands_1000'   THEN 45
  WHEN id = 'monthly_wins_250'     THEN 55
  WHEN id = 'monthly_tourneys_50'  THEN 60
  WHEN id = 'monthly_big_pots_50'  THEN 50
  ELSE diamond_reward
END;

-- Return type changes boolean -> jsonb so the client can tell the player
-- exactly what they won. Must DROP: a return type cannot be changed in place.
DROP FUNCTION IF EXISTS public.claim_daily_challenge(uuid, uuid, numeric);

CREATE OR REPLACE FUNCTION public.claim_daily_challenge(
  p_user_id uuid,
  p_challenge_row_id uuid,
  p_reward_amount numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid          uuid;
  v_row          public.user_daily_challenges%ROWTYPE;
  v_cat          public.daily_challenge_catalog%ROWTYPE;
  v_new_diamonds integer;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    v_uid := p_user_id;              -- trusted server context only
  ELSIF p_user_id IS NOT NULL AND p_user_id <> v_uid THEN
    RAISE EXCEPTION 'Cannot claim a challenge for another user';
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  -- FOR UPDATE + the claimed flag IS the idempotency guard. The credit below
  -- shares this transaction, so a retried or concurrent claim blocks here,
  -- then sees claimed = true and pays nothing.
  SELECT * INTO v_row FROM public.user_daily_challenges
   WHERE id = p_challenge_row_id AND user_id = v_uid
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Challenge not found'; END IF;

  IF v_row.claimed THEN
    RETURN jsonb_build_object(
      'claimed', false, 'alreadyClaimed', true, 'chips', 0, 'diamonds', 0,
      'diamondBalance', (SELECT COALESCE(diamonds,0) FROM public.profiles WHERE id = v_uid));
  END IF;
  IF NOT v_row.completed THEN RAISE EXCEPTION 'Challenge not completed yet'; END IF;

  SELECT * INTO v_cat FROM public.daily_challenge_catalog WHERE id = v_row.challenge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown challenge % - not in the server catalog', v_row.challenge_id;
  END IF;

  IF COALESCE(v_row.progress, 0) < v_cat.requirement THEN
    RAISE EXCEPTION 'Challenge progress %/% does not meet the requirement',
      COALESCE(v_row.progress, 0), v_cat.requirement;
  END IF;

  UPDATE public.user_daily_challenges
     SET claimed = true, claimed_at = now()
   WHERE id = p_challenge_row_id;

  IF COALESCE(v_cat.chip_reward, 0) > 0 THEN
    IF NOT public.atomic_credit_wallet_and_log(
         v_uid, v_cat.chip_reward, 'bonus',
         'Challenge reward: ' || v_row.challenge_id,
         NULL, NULL, NULL,
         'challenge_claim:' || p_challenge_row_id::text) THEN
      RAISE EXCEPTION 'Challenge chip reward credit failed';
    END IF;
  END IF;

  -- Diamonds are written inline rather than via fn_add_diamonds so the credit
  -- shares this transaction with the claimed flag.
  IF COALESCE(v_cat.diamond_reward, 0) > 0 THEN
    UPDATE public.profiles
       SET diamonds        = COALESCE(diamonds, 0) + v_cat.diamond_reward,
           diamond_balance = COALESCE(diamond_balance, 0) + v_cat.diamond_reward,
           updated_at      = now()
     WHERE id = v_uid
    RETURNING diamonds INTO v_new_diamonds;

    IF v_new_diamonds IS NULL THEN
      RAISE EXCEPTION 'Profile not found for user % -- diamond credit failed', v_uid;
    END IF;

    BEGIN
      INSERT INTO public.diamond_transactions (user_id, amount, type, description, created_at)
      VALUES (v_uid, v_cat.diamond_reward, 'credit',
              'Challenge reward: ' || v_row.challenge_id, now());
    EXCEPTION WHEN OTHERS THEN
      -- The ledger is for reporting. Losing a row must not roll back a credit
      -- the player has already been shown.
      RAISE WARNING 'diamond_transactions insert failed for %: %', v_uid, SQLERRM;
    END;
  ELSE
    SELECT COALESCE(diamonds, 0) INTO v_new_diamonds FROM public.profiles WHERE id = v_uid;
  END IF;

  RETURN jsonb_build_object(
    'claimed', true, 'alreadyClaimed', false,
    'challengeId', v_row.challenge_id,
    'chips', COALESCE(v_cat.chip_reward, 0),
    'diamonds', COALESCE(v_cat.diamond_reward, 0),
    'diamondBalance', COALESCE(v_new_diamonds, 0));
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_daily_challenge(uuid, uuid, numeric) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.claim_daily_challenge(uuid, uuid, numeric) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- POST-APPLY ASSERTIONS -- prove diamonds move, exactly once.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_uid uuid; v_row_id uuid; v_before integer; v_after integer;
  v_res jsonb; v_key text := 'ASSERT-0000-00-00';
BEGIN
  IF EXISTS (SELECT 1 FROM public.daily_challenge_catalog WHERE diamond_reward = 0) THEN
    RAISE EXCEPTION 'some catalog rows still pay 0 diamonds';
  END IF;

  SELECT id INTO v_uid FROM public.profiles ORDER BY created_at LIMIT 1;
  IF v_uid IS NULL THEN RETURN; END IF;

  SELECT COALESCE(diamonds,0) INTO v_before FROM public.profiles WHERE id = v_uid;

  DELETE FROM public.user_daily_challenges WHERE user_id = v_uid AND assigned_date = v_key;
  INSERT INTO public.user_daily_challenges
    (user_id, challenge_id, assigned_date, progress, completed, completed_at)
  VALUES (v_uid, 'hands_10', v_key, 10, true, now())
  RETURNING id INTO v_row_id;

  v_res := public.claim_daily_challenge(v_uid, v_row_id, NULL);

  IF (v_res->>'claimed')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'claim did not succeed: %', v_res;
  END IF;
  IF (v_res->>'diamonds')::int <> 1 THEN
    RAISE EXCEPTION 'expected 1 diamond, got %', v_res;
  END IF;

  SELECT COALESCE(diamonds,0) INTO v_after FROM public.profiles WHERE id = v_uid;
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION 'diamonds did not land: before=% after=%', v_before, v_after;
  END IF;
  IF (v_res->>'diamondBalance')::int <> v_after THEN
    RAISE EXCEPTION 'returned balance % <> stored %', v_res->>'diamondBalance', v_after;
  END IF;

  -- A second claim must pay NOTHING.
  v_res := public.claim_daily_challenge(v_uid, v_row_id, NULL);
  IF (v_res->>'alreadyClaimed')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'second claim was not rejected: %', v_res;
  END IF;
  SELECT COALESCE(diamonds,0) INTO v_after FROM public.profiles WHERE id = v_uid;
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION 'DOUBLE CREDIT: before=% after=%', v_before, v_after;
  END IF;

  -- Restore the test user exactly as found.
  UPDATE public.profiles
     SET diamonds = v_before,
         diamond_balance = GREATEST(COALESCE(diamond_balance,0) - 1, 0)
   WHERE id = v_uid;
  DELETE FROM public.diamond_transactions
   WHERE user_id = v_uid AND description = 'Challenge reward: hands_10'
     AND created_at > now() - interval '2 minutes';
  DELETE FROM public.user_daily_challenges WHERE id = v_row_id;
END $$;

-- ROLLBACK
-- DROP FUNCTION IF EXISTS public.claim_daily_challenge(uuid, uuid, numeric);
-- (restore the boolean body from 20260820010000_challenge_rpcs_current_state.sql)
-- ALTER TABLE public.daily_challenge_catalog DROP COLUMN IF EXISTS diamond_reward;
