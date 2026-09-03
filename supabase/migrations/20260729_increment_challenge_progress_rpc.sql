-- Atomic daily/weekly/monthly challenge progress increment. DailyChallengeService
-- calls this first and falls back to a racy client read-then-write UPDATE when it
-- is absent (the RPC was never created). Creating it removes the race. Clamps to
-- the requirement and stamps completed_at once on first completion.
-- Applied to prod via Supabase MCP 2026-07-29.
CREATE OR REPLACE FUNCTION public.increment_challenge_progress(
  p_user_id uuid,
  p_challenge_row_id uuid,
  p_amount integer,
  p_requirement integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_progress integer;
  v_completed boolean;
BEGIN
  IF (SELECT auth.uid()) IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('updated', false, 'error', 'not authorized');
  END IF;

  UPDATE user_daily_challenges
     SET progress = LEAST(progress + GREATEST(p_amount, 0), p_requirement),
         completed = (progress + GREATEST(p_amount, 0)) >= p_requirement,
         completed_at = CASE
           WHEN (progress + GREATEST(p_amount, 0)) >= p_requirement AND completed_at IS NULL
           THEN now() ELSE completed_at END
   WHERE id = p_challenge_row_id AND user_id = p_user_id
   RETURNING progress, completed INTO v_progress, v_completed;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('updated', false);
  END IF;
  RETURN jsonb_build_object('updated', true, 'progress', v_progress, 'completed', v_completed);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.increment_challenge_progress(uuid,uuid,integer,integer) TO authenticated;
