-- ─────────────────────────────────────────────────────────────────────────────
-- A LOGGED-OUT CALLER CANNOT WRITE ANOTHER PERSON'S ACHIEVEMENTS
-- (found 2026-08-30 by the definer-exposure sweep, issue #1634)
--
-- `fn_achievement_record_progress` is SECURITY DEFINER, writes
-- `training_user_achievements`, takes `p_user_id` from the caller, and was
-- executable by `anon`. Its guard reads:
--
--     v_caller uuid := auth.uid();
--     IF v_caller IS NOT NULL AND v_caller <> p_user_id THEN
--       RAISE EXCEPTION 'refusing to write achievements for another user';
--     END IF;
--
-- `IF v_caller IS NOT NULL AND ...` is the whole bug. For a logged-out caller
-- `auth.uid()` is NULL, so the condition is false and THE GUARD SKIPS ITSELF —
-- the one case it exists to stop is the one case it waves through. A logged-out
-- request could set any achievement, to any progress, for any user id it cared
-- to name.
--
-- This is not a new class of mistake here. Issue #1634 describes it exactly:
-- "The rebuy hole of 2026-08-28 was a guard that read auth.uid() and skipped
-- itself when there was none, and the only thing between that and a live
-- exploit was this grant."
--
-- SECURITY DEFINER also means it runs as the owner with BYPASSRLS, so the
-- table's own policies were not standing behind it either.
--
-- BOTH HALVES ARE FIXED, and the order matters:
--
--   1. THE GRANT. `anon` loses EXECUTE. This is the defence that actually
--      holds, and issue #1634 is explicit that the live answer for
--      anon-executable definer writers is zero and stays zero.
--   2. THE GUARD. A NULL caller is now REFUSED rather than exempted, so a
--      future grant change — or any other path that reaches this function
--      without a JWT — cannot silently re-open the hole. Defence in depth:
--      the grant is the lock, this is the bolt.
--
-- WHAT IS DELIBERATELY NOT CHANGED: `authenticated` keeps EXECUTE. There is a
-- real caller — `src/services/AchievementService.ts` invokes this from a
-- signed-in browser — and revoking it would break achievement progress for
-- every player. The signed-in path is unaffected: `v_caller` is their own uid,
-- so the equality check behaves exactly as before.
--
-- The body is otherwise copied verbatim. Only the guard's first condition
-- changes, so this cannot alter progress maths, the unlock transition, or the
-- "newly unlocked" return value.
--
-- ROLLBACK: re-apply 20260829020100_fn_achievement_record_progress.sql, then
--   GRANT EXECUTE ON FUNCTION public.fn_achievement_record_progress(uuid,text,numeric,numeric) TO anon;
-- (Do not. It is the hole.)
-- ─────────────────────────────────────────────────────────────────────────────

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

  -- THE FIX. Was `IF v_caller IS NOT NULL AND v_caller <> p_user_id`, which
  -- exempted the anonymous caller instead of refusing it. A write on behalf of
  -- a named user now requires a caller, and requires it to BE that user.
  --
  -- service_role is unaffected and does not need an exception here: it does not
  -- go through PostgREST's auth.uid(), and nothing server-side calls this.
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

-- The lock. Issue #1634: "There is no allowlist for this one. The live answer
-- is zero and it stays zero."
REVOKE ALL ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric) IS
  'Records achievement progress for the CALLING user. Requires a session: a NULL auth.uid() is refused, not exempted (the pre-2026-08-30 guard skipped itself for anon, so a logged-out caller could write any user''s achievements). anon has no EXECUTE. Called from src/services/AchievementService.ts.';

-- Post-apply assertions.
DO $$
DECLARE v_oid oid;
BEGIN
  v_oid := 'public.fn_achievement_record_progress(uuid,text,numeric,numeric)'::regprocedure;

  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'post-apply failed: anon can STILL execute the achievement writer';
  END IF;

  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'post-apply failed: the real signed-in caller lost EXECUTE — AchievementService would break';
  END IF;

  IF pg_get_functiondef(v_oid) NOT LIKE '%a caller without a session cannot write achievements%' THEN
    RAISE EXCEPTION 'post-apply failed: the null-caller guard is not in the live body';
  END IF;

  IF pg_get_functiondef(v_oid) LIKE '%v_caller IS NOT NULL AND v_caller <> p_user_id%' THEN
    RAISE EXCEPTION 'post-apply failed: the self-skipping guard is still there';
  END IF;
END $$;
