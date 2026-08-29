-- ═══════════════════════════════════════════════════════════════════════════
--  fn_achievement_record_progress — the only safe way to write an achievement
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The client used to do this in two round trips: SELECT the row, decide, then
-- UPDATE or INSERT. That shape has three failure modes, and this platform hit
-- all three:
--
--   1. NO ROW LOCK BETWEEN THE READ AND THE WRITE. Two tabs (or a tab and a
--      reconnect) read the same progress and both write it, so one increment
--      is lost — or, before the unique index landed alongside this function,
--      both INSERT and the table grows a duplicate.
--   2. THE UNLOCK DECISION WAS MADE ON THE CLIENT. Two concurrent writers can
--      both conclude "this just unlocked" and both call the reward path, and
--      `awardRewards` moves real chips through `add_to_promo_wallet`. The
--      transition has to be decided by whoever actually wrote the row, once.
--   3. PROGRESS COULD GO BACKWARDS. Any caller passing a smaller number — a
--      stale figure, a recomputed streak, a retry answering out of order —
--      could lower progress, and `setProgress` would then write
--      `unlocked_at = NULL` and REVOKE an achievement the player already had.
--
-- So: one statement, one round trip, and the database decides.
--
--   * progress only ever RISES (`GREATEST`), clamped to target.
--   * `unlocked_at` is set once and never cleared (`COALESCE` on the existing
--     value). An unlock is not revocable by a later, smaller number.
--   * `unlocked` is kept in step with `unlocked_at` — that column had never
--     been written by any code and read false on every row in the table.
--   * RETURNS true ONLY on the call that performed the transition, so the
--     caller pays the reward exactly once no matter how many tabs are open.
--
-- SECURITY DEFINER with a pinned search_path, and it writes only the caller's
-- own row: p_user_id is checked against auth.uid() so a browser cannot award
-- somebody else an achievement. The service role (auth.uid() IS NULL) is
-- allowed through for server-side callers.

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

  -- A browser may only write its own achievements. auth.uid() is NULL for the
  -- service role, which is trusted and must keep working for server callers.
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
         -- set once, never cleared
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

  -- true only for the call that flipped it
  RETURN COALESCE(v_now_unlocked, false) AND NOT COALESCE(v_was_unlocked, false);
END $$;

REVOKE ALL ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric) IS
  'Atomic, monotonic achievement progress. Returns true only on the call that unlocks it, so the reward is paid exactly once. Added 2026-08-29 after read-then-insert grew 33,309 duplicate rows.';
