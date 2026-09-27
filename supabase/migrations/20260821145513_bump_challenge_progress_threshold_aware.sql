-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821145513 "bump_challenge_progress_threshold_aware"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 67c3d9551585821f2223886505bde0d3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- DROP then CREATE, not CREATE OR REPLACE: replace cannot change an argument
-- list, so it would leave a SECOND overload behind and PostgREST would resolve
-- the call by named-argument match. Two live definitions of the function that
-- pays players is exactly the ambiguity the migration-safety rules call out.
DROP FUNCTION IF EXISTS public.bump_challenge_progress(uuid, jsonb, text, text, text);
DROP FUNCTION IF EXISTS public.bump_challenge_progress(uuid, jsonb, jsonb, text, text, text);

CREATE FUNCTION public.bump_challenge_progress(
  p_user_id uuid,
  p_amounts jsonb,
  p_magnitudes jsonb,
  p_daily_key text,
  p_weekly_key text,
  p_monthly_key text
)
RETURNS TABLE(id uuid, challenge_id text, progress integer, requirement integer,
              chip_reward numeric, newly_completed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN v_uid := p_user_id; END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_amounts IS NULL OR jsonb_typeof(p_amounts) <> 'object' THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH bumps AS (
    SELECT key AS ctype, GREATEST(COALESCE((value #>> '{}')::int, 0), 0) AS amount
      FROM jsonb_each(p_amounts)
  ),
  updated AS (
    UPDATE public.user_daily_challenges u
       SET progress = LEAST(u.progress + b.amount, c.requirement),
           completed = (u.progress + b.amount) >= c.requirement,
           completed_at = CASE
             WHEN (u.progress + b.amount) >= c.requirement AND u.completed_at IS NULL
             THEN now() ELSE u.completed_at END
      FROM public.daily_challenge_catalog c, bumps b
     WHERE u.user_id = v_uid
       AND u.challenge_id = c.id
       AND c.challenge_type = b.ctype
       AND b.amount > 0
       AND u.completed = false
       AND u.assigned_date IN (p_daily_key, p_weekly_key, p_monthly_key)
       -- THE THRESHOLD GATE. A row with no threshold counts every event, which
       -- is the right reading for a pure counter like hands_played. A row that
       -- HAS one only advances when this event measured up, so a 600-chip pot
       -- moves "500 Or More" and leaves "5,000 Or More" alone. A missing
       -- magnitude reads as 0 and clears nothing: an unmeasured event cannot be
       -- shown to have passed any bar, and crediting it would let a folded hand
       -- complete "Win A Pot Worth 5,000 Chips Or More".
       AND (
         c.threshold IS NULL
         OR COALESCE((p_magnitudes -> b.ctype) #>> '{}', '0')::numeric >= c.threshold
       )
    RETURNING u.id, u.challenge_id, u.progress, u.completed, c.requirement, c.chip_reward
  )
  SELECT up.id, up.challenge_id, up.progress, up.requirement, up.chip_reward, up.completed
    FROM updated up;
END;
$function$;

REVOKE ALL ON FUNCTION public.bump_challenge_progress(uuid, jsonb, jsonb, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bump_challenge_progress(uuid, jsonb, jsonb, text, text, text) TO authenticated, service_role;
