-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829020832; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_achievement_record_progress(
  p_user_id        uuid,
  p_achievement_id text,
  p_progress       numeric,
  p_target         numeric
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller       uuid := auth.uid();
  v_target       numeric := GREATEST(COALESCE(p_target, 1), 1);
  v_was_unlocked boolean;
  v_now_unlocked boolean;
BEGIN
  IF p_user_id IS NULL OR p_achievement_id IS NULL THEN
    RETURN false;
  END IF;

  IF v_caller IS NOT NULL AND v_caller <> p_user_id THEN
    RAISE EXCEPTION 'fn_achievement_record_progress: refusing to write achievements for another user';
  END IF;

  SELECT (unlocked_at IS NOT NULL) INTO v_was_unlocked
    FROM public.training_user_achievements
   WHERE user_id = p_user_id AND achievement_id = p_achievement_id;

  INSERT INTO public.training_user_achievements
              (user_id, achievement_id, progress, target, unlocked_at, unlocked)
       VALUES (p_user_id, p_achievement_id,
               LEAST(GREATEST(COALESCE(p_progress, 0), 0), v_target),
               v_target,
               CASE WHEN COALESCE(p_progress, 0) >= v_target THEN now() ELSE NULL END,
               COALESCE(p_progress, 0) >= v_target)
  ON CONFLICT (user_id, achievement_id) DO UPDATE
     SET progress    = LEAST(GREATEST(public.training_user_achievements.progress,
                                      COALESCE(EXCLUDED.progress, 0)), v_target),
         target      = v_target,
         unlocked_at = COALESCE(
                         public.training_user_achievements.unlocked_at,
                         CASE WHEN LEAST(GREATEST(public.training_user_achievements.progress,
                                                  COALESCE(EXCLUDED.progress, 0)), v_target) >= v_target
                              THEN now() END),
         unlocked    = COALESCE(
                         public.training_user_achievements.unlocked_at,
                         CASE WHEN LEAST(GREATEST(public.training_user_achievements.progress,
                                                  COALESCE(EXCLUDED.progress, 0)), v_target) >= v_target
                              THEN now() END) IS NOT NULL
  RETURNING unlocked INTO v_now_unlocked;

  RETURN COALESCE(v_now_unlocked, false) AND NOT COALESCE(v_was_unlocked, false);
END $$;

REVOKE ALL ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric) IS
  'Atomic, monotonic achievement progress. Returns true only on the call that unlocks it, so the reward is paid exactly once. Added 2026-08-29 after read-then-insert grew 33,309 duplicate rows.';
