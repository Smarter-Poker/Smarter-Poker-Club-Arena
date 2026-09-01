-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830064413; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_achievement_record_progress(
  p_user_id uuid, p_achievement_id text, p_progress numeric, p_target numeric
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller       uuid := auth.uid();
  v_target       numeric := GREATEST(COALESCE(p_target, 1), 1);
  v_was_unlocked boolean;
  v_now_unlocked boolean;
BEGIN
  IF p_user_id IS NULL OR p_achievement_id IS NULL THEN
    RETURN false;
  END IF;

  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'fn_achievement_record_progress: a caller without a session cannot write achievements';
  END IF;

  IF v_caller <> p_user_id THEN
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
END $function$;

REVOKE ALL ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric) IS
  'Records achievement progress for the CALLING user. Requires a session: a NULL auth.uid() is refused, not exempted (the pre-2026-08-30 guard skipped itself for anon, so a logged-out caller could write any user''s achievements). anon has no EXECUTE. Called from src/services/AchievementService.ts.';

DO $$
DECLARE v_oid oid;
BEGIN
  v_oid := 'public.fn_achievement_record_progress(uuid,text,numeric,numeric)'::regprocedure;

  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'post-apply failed: anon can STILL execute the achievement writer';
  END IF;

  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'post-apply failed: the real signed-in caller lost EXECUTE';
  END IF;

  IF pg_get_functiondef(v_oid) NOT LIKE '%a caller without a session cannot write achievements%' THEN
    RAISE EXCEPTION 'post-apply failed: the null-caller guard is not in the live body';
  END IF;

  IF pg_get_functiondef(v_oid) LIKE '%v_caller IS NOT NULL AND v_caller <> p_user_id%' THEN
    RAISE EXCEPTION 'post-apply failed: the self-skipping guard is still there';
  END IF;
END $$;
