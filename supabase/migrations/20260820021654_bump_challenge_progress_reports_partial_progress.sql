-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260820021654 as "bump_challenge_progress_reports_partial_progress"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- bump_challenge_progress advanced progress correctly but reported ONLY the
-- rows that crossed into completion. Everything downstream keys off that
-- return, so:
--   * an open /challenges tab never ticked. Progress bars sat still through a
--     whole session and only jumped on remount, which reads as the feature
--     being broken rather than as the player being three hands away.
--   * the caller could not tell "nothing matched" from "moved but not done",
--     so there was no signal to refresh on.
-- The declared return type already had newly_completed; the final WHERE threw
-- away every row where it was false. Return them all and let the caller decide.
--
-- Callers must now filter on newly_completed before celebrating. The old
-- contract (every returned row is complete) is a strict subset of the new one,
-- so a client mid-rollout over-refreshes rather than mis-celebrating.

CREATE OR REPLACE FUNCTION public.bump_challenge_progress(
  p_user_id uuid, p_amounts jsonb, p_daily_key text, p_weekly_key text, p_monthly_key text
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
  -- Same trust rule as the rest of the challenge RPCs: an end-user JWT wins and
  -- p_user_id is ignored; only a server context (auth.uid() IS NULL) may name
  -- another user. `anon` holds no EXECUTE grant.
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
    RETURNING u.id, u.challenge_id, u.progress, u.completed, c.requirement, c.chip_reward
  )
  SELECT up.id, up.challenge_id, up.progress, up.requirement, up.chip_reward, up.completed
    FROM updated up;   -- every row it moved, completed or not
END;
$function$;

REVOKE ALL ON FUNCTION public.bump_challenge_progress(uuid, jsonb, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bump_challenge_progress(uuid, jsonb, text, text, text) TO authenticated, service_role;

-- Post-apply assertions. These run as `postgres`, so auth.uid() is NULL and the
-- p_user_id path is the one exercised -- which is also the path a server-side
-- caller uses.
DO $$
DECLARE
  v_user uuid;
  v_row  uuid;
  v_n    int;
  v_done boolean;
  v_prog int;
BEGIN
  SELECT id INTO v_user FROM public.profiles ORDER BY created_at LIMIT 1;
  IF v_user IS NULL THEN RAISE NOTICE 'no profiles; skipping assertions'; RETURN; END IF;

  DELETE FROM public.user_daily_challenges
   WHERE user_id = v_user AND assigned_date = '1970-01-01';

  -- hands_50 needs 50, so one bump of 1 is partial and must still be REPORTED.
  INSERT INTO public.user_daily_challenges (user_id, challenge_id, assigned_date, progress, completed)
  VALUES (v_user, 'hands_50', '1970-01-01', 0, false)
  RETURNING id INTO v_row;

  SELECT count(*), bool_or(newly_completed), max(progress) INTO v_n, v_done, v_prog
    FROM public.bump_challenge_progress(v_user, '{"hands_played":1}'::jsonb,
                                        '1970-01-01', 'W1970-01-01', 'M1970-01');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'ABORT: partial progress not reported (got % rows, expected 1). The live tick depends on this.', v_n;
  END IF;
  IF v_done THEN RAISE EXCEPTION 'ABORT: 1/50 reported as newly_completed'; END IF;
  IF v_prog <> 1 THEN RAISE EXCEPTION 'ABORT: progress is % after +1, expected 1', v_prog; END IF;

  -- Finishing it must flip newly_completed and clamp at the requirement.
  SELECT count(*), bool_or(newly_completed), max(progress) INTO v_n, v_done, v_prog
    FROM public.bump_challenge_progress(v_user, '{"hands_played":999}'::jsonb,
                                        '1970-01-01', 'W1970-01-01', 'M1970-01');
  IF NOT v_done THEN RAISE EXCEPTION 'ABORT: crossing the requirement did not set newly_completed'; END IF;
  IF v_prog <> 50 THEN RAISE EXCEPTION 'ABORT: progress % not clamped to 50', v_prog; END IF;

  -- An already-complete row must never be reported again: it would re-toast and
  -- re-offer a claim on every subsequent hand.
  SELECT count(*) INTO v_n
    FROM public.bump_challenge_progress(v_user, '{"hands_played":1}'::jsonb,
                                        '1970-01-01', 'W1970-01-01', 'M1970-01');
  IF v_n <> 0 THEN RAISE EXCEPTION 'ABORT: completed row reported again (% rows)', v_n; END IF;

  -- A non-matching type must not move anything.
  DELETE FROM public.user_daily_challenges WHERE id = v_row;
  INSERT INTO public.user_daily_challenges (user_id, challenge_id, assigned_date, progress, completed)
  VALUES (v_user, 'hands_50', '1970-01-01', 0, false) RETURNING id INTO v_row;
  SELECT count(*) INTO v_n
    FROM public.bump_challenge_progress(v_user, '{"showdowns":5}'::jsonb,
                                        '1970-01-01', 'W1970-01-01', 'M1970-01');
  IF v_n <> 0 THEN RAISE EXCEPTION 'ABORT: showdowns bump moved a hands_played challenge'; END IF;

  DELETE FROM public.user_daily_challenges WHERE id = v_row;
  RAISE NOTICE 'bump_challenge_progress assertions passed';
END $$;
