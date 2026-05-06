-- BUG 021 layer C — hand_history had ONLY a service_role RLS policy (no
-- authenticated-user SELECT). Client queries from authenticated users returned
-- 0 rows regardless of correctness. UI showed "No Hands Recorded Yet" forever.
--
-- Fix: add a SELECT policy that lets authenticated users see hands where their
-- user_id appears in the players JSONB array. This is the poker-industry-standard
-- rule: you can see any hand you were dealt into.

DROP POLICY IF EXISTS "hand_history_authenticated_select" ON public.hand_history;
CREATE POLICY "hand_history_authenticated_select" ON public.hand_history
  FOR SELECT TO authenticated
  USING (
    players @> jsonb_build_array(jsonb_build_object('userId', auth.uid()::text))
  );

ALTER TABLE public.hand_history ENABLE ROW LEVEL SECURITY;
