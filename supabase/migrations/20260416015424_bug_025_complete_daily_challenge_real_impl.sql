-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260416015424 "bug_025_complete_daily_challenge_real_impl"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c70afcbbc225434a06df1a2c76d9d9a4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG 025 H: complete_daily_challenge was a silent-success stub. Players completing
-- memory challenges got "success" without writing completion rows or diamond rewards.
-- Real implementation inserts into memory_challenge_completions (with 5-param
-- signature matching DailyChallengeService call site), awards diamonds, marks the
-- daily_challenges row complete if user has one.

DROP FUNCTION IF EXISTS public.complete_daily_challenge(uuid, text);
DROP FUNCTION IF EXISTS public.complete_daily_challenge(uuid, uuid, integer, numeric, integer);

CREATE OR REPLACE FUNCTION public.complete_daily_challenge(
  p_user_id uuid,
  p_challenge_id uuid,
  p_score integer DEFAULT 0,
  p_accuracy numeric DEFAULT 0,
  p_time_taken integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_existing_id uuid;
  v_perfect boolean;
  v_diamonds integer;
  v_completion_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_challenge_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing user_id or challenge_id');
  END IF;

  -- Idempotent: only one completion per user per challenge
  SELECT id INTO v_existing_id
  FROM memory_challenge_completions
  WHERE user_id = p_user_id AND challenge_id = p_challenge_id;

  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_completed', true,
      'completion_id', v_existing_id
    );
  END IF;

  v_perfect := (p_accuracy IS NOT NULL AND p_accuracy >= 1.0);
  v_diamonds := CASE
    WHEN v_perfect THEN 20
    WHEN p_accuracy >= 0.9 THEN 10
    WHEN p_accuracy >= 0.75 THEN 5
    ELSE 2
  END;

  INSERT INTO memory_challenge_completions (
    id, user_id, challenge_id, score, accuracy, time_taken,
    perfect_completion, diamonds_earned, completed_at
  ) VALUES (
    gen_random_uuid(), p_user_id, p_challenge_id,
    COALESCE(p_score, 0), COALESCE(p_accuracy, 0), COALESCE(p_time_taken, 0),
    v_perfect, v_diamonds, NOW()
  ) RETURNING id INTO v_completion_id;

  -- Mark any matching daily_challenges row (date-based match) as completed
  UPDATE daily_challenges
  SET completed = true, completed_at = NOW()
  WHERE user_id = p_user_id
    AND completed = false
    AND challenge_date = CURRENT_DATE;

  -- Credit diamonds on the profile
  UPDATE profiles
  SET diamonds = COALESCE(diamonds, 0) + v_diamonds
  WHERE id = p_user_id;

  -- Audit trail in diamond_ledger if the table is present
  BEGIN
    INSERT INTO diamond_ledger (user_id, delta, type, balance_after, created_at)
    SELECT p_user_id, v_diamonds, 'daily_challenge_reward', COALESCE(diamonds, 0), NOW()
    FROM profiles WHERE id = p_user_id;
  EXCEPTION WHEN OTHERS THEN NULL;  -- ledger insert is audit-only, don't block reward
  END;

  RETURN jsonb_build_object(
    'success', true,
    'completion_id', v_completion_id,
    'diamonds_earned', v_diamonds,
    'perfect', v_perfect
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.complete_daily_challenge(uuid, uuid, integer, numeric, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.complete_daily_challenge IS
'BUG 025: real impl. Idempotent insert into memory_challenge_completions + diamond reward (2-20 based on accuracy) + daily_challenges row update + diamond_ledger audit.';

