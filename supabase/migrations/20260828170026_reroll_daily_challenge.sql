-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828170026; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- 2026-08-28 — reroll_daily_challenge: the Reroll button stops being theatre
-- ═══════════════════════════════════════════════════════════════════════════
--
-- DailyChallengesPage has shipped a "Reroll (10 Diamonds)" button whose
-- handler was pure client-side mockery: it decremented LOCAL React state,
-- toasted "Challenge swapped! (Mocked)", and then reloaded — which restored
-- the real diamond count and the SAME challenge 800ms later. The user
-- confirmed a purchase dialog, was charged nothing, and received nothing.
--
-- This RPC is the real thing, shaped exactly like buy_streak_freeze
-- (20260823): auth.uid() is the payer, refusals come back in the payload,
-- the candidate is validated BEFORE any diamond moves, and the whole thing
-- is one transaction so a failure after the charge rolls the charge back.

CREATE OR REPLACE FUNCTION public.reroll_daily_challenge(
  p_user_challenge_id uuid,
  p_cost integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_row   public.user_daily_challenges%ROWTYPE;
  v_tier  text;
  v_new   public.daily_challenge_catalog%ROWTYPE;
  v_deduct jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authenticated');
  END IF;
  IF p_cost IS NULL OR p_cost <= 0 OR p_cost > 1000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'cost out of range');
  END IF;

  SELECT * INTO v_row
    FROM public.user_daily_challenges
   WHERE id = p_user_challenge_id AND user_id = v_uid
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'challenge not found');
  END IF;
  IF COALESCE(v_row.claimed, false) OR COALESCE(v_row.completed, false) THEN
    RETURN jsonb_build_object('success', false,
      'error', 'a completed challenge cannot be swapped');
  END IF;

  SELECT c.tier INTO v_tier
    FROM public.daily_challenge_catalog c
   WHERE c.id = v_row.challenge_id;

  -- Pick the replacement BEFORE any diamond moves (buy_streak_freeze trap 1:
  -- refuse while the wallet is still untouched).
  SELECT c.* INTO v_new
    FROM public.daily_challenge_catalog c
   WHERE COALESCE(c.tier, 'daily') = COALESCE(v_tier, 'daily')
     AND c.id <> v_row.challenge_id
     AND c.id NOT IN (
       SELECT u.challenge_id FROM public.user_daily_challenges u
        WHERE u.user_id = v_uid AND u.assigned_date = v_row.assigned_date
     )
   ORDER BY random()
   LIMIT 1;
  IF v_new.id IS NULL THEN
    RETURN jsonb_build_object('success', false,
      'error', 'no other challenge is available to swap in');
  END IF;

  v_deduct := deduct_diamonds(
    v_uid, p_cost,
    'Challenge reroll', 'challenge_reroll', 'challenge_reroll',
    jsonb_build_object(
      'user_challenge_id', v_row.id,
      'old_challenge_id', v_row.challenge_id,
      'new_challenge_id', v_new.id,
      'period_key', v_row.assigned_date),
    NULL, 0);
  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object('success', false,
      'error', COALESCE(v_deduct->>'error', 'not enough diamonds'));
  END IF;

  UPDATE public.user_daily_challenges
     SET challenge_id = v_new.id,
         progress = 0,
         completed = false,
         completed_at = NULL
   WHERE id = v_row.id;

  RETURN jsonb_build_object(
    'success', true,
    'diamondsSpent', p_cost,
    'newChallenge', jsonb_build_object(
      'id', v_new.id,
      'name', v_new.name,
      'description', v_new.description,
      'challengeType', v_new.challenge_type,
      'requirement', v_new.requirement,
      'chipReward', COALESCE(v_new.chip_reward, 0),
      'diamondReward', COALESCE(v_new.diamond_reward, 0),
      'tier', v_new.tier));
END;
$function$;

REVOKE ALL ON FUNCTION public.reroll_daily_challenge(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reroll_daily_challenge(uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.reroll_daily_challenge(uuid, integer) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'reroll_daily_challenge'
  ) THEN
    RAISE EXCEPTION 'reroll_daily_challenge was not created';
  END IF;
  IF has_function_privilege('anon', 'public.reroll_daily_challenge(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not be able to execute reroll_daily_challenge';
  END IF;
END $$;
