-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260511165415 "training_hand_replay_20260511180200"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b7adb07fd4a740e92406a79407ad8bae of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- TRAIN-DATA-ROLLUPS-1 part 3: hand-replay table + RLS + recent() RPC
CREATE TABLE IF NOT EXISTS public.training_hand_replay (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id      text,
  question_id     uuid REFERENCES public.training_questions(id) ON DELETE SET NULL,
  game_id         text,
  hero_position   text,
  hero_hand       text,
  board_cards     jsonb,
  actions         jsonb NOT NULL DEFAULT '[]'::jsonb,
  user_action     text,
  solver_action   text,
  ev_loss_bb      numeric(8,3),
  was_correct     boolean,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS training_hand_replay_user_idx
  ON public.training_hand_replay (user_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS training_hand_replay_session_idx
  ON public.training_hand_replay (session_id);
CREATE INDEX IF NOT EXISTS training_hand_replay_question_idx
  ON public.training_hand_replay (question_id);

ALTER TABLE public.training_hand_replay ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS thr_self_read   ON public.training_hand_replay;
DROP POLICY IF EXISTS thr_self_insert ON public.training_hand_replay;
DROP POLICY IF EXISTS thr_self_delete ON public.training_hand_replay;
CREATE POLICY thr_self_read   ON public.training_hand_replay FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY thr_self_insert ON public.training_hand_replay FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY thr_self_delete ON public.training_hand_replay FOR DELETE USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.training_hand_replay_recent(p_limit integer DEFAULT 25)
RETURNS SETOF public.training_hand_replay
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  RETURN QUERY
    SELECT * FROM public.training_hand_replay
    WHERE user_id = v_user
    ORDER BY recorded_at DESC
    LIMIT GREATEST(1, LEAST(p_limit, 200));
END;
$$;

GRANT EXECUTE ON FUNCTION public.training_hand_replay_recent(integer) TO authenticated;

COMMENT ON TABLE public.training_user_progress IS
  'TRAIN-DATA-ROLLUPS-1: per-user training rollup. Updated by trigger on jarvis_training_sessions.';
COMMENT ON MATERIALIZED VIEW public.training_leaderboard_top IS
  'TRAIN-DATA-ROLLUPS-1: top-500 leaderboard view. Refreshable via training_leaderboard_refresh().';
COMMENT ON TABLE public.training_hand_replay IS
  'TRAIN-DATA-ROLLUPS-1: per-hand replay events for future hand-history replay UI.';
