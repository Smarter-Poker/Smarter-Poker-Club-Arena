-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260416001954 as "bug_021_hand_history_rls_authenticated_select"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- BUG 021 fix layer C: hand_history had only a service_role policy, so client-side
-- queries from authenticated users returned 0 rows regardless of query correctness.
-- Add a SELECT policy that lets an authenticated user read hands where their user_id
-- is in the players JSONB array. This is the poker-industry-standard rule: you can
-- see any hand you were dealt into.
--
-- JSONB operator @> tests containment. We match by userId (camelCase) because that's
-- what the engine writes. Index on players will be used automatically.

DROP POLICY IF EXISTS "hand_history_authenticated_select" ON public.hand_history;
CREATE POLICY "hand_history_authenticated_select" ON public.hand_history
  FOR SELECT TO authenticated
  USING (
    players @> jsonb_build_array(jsonb_build_object('userId', auth.uid()::text))
  );

-- Also ensure RLS is enabled (should already be, but enforce for safety)
ALTER TABLE public.hand_history ENABLE ROW LEVEL SECURITY;

-- Verify: the new policy should be listed alongside the service_role one
SELECT policyname, cmd, roles::text
FROM pg_policies
WHERE schemaname='public' AND tablename='hand_history'
ORDER BY policyname;
