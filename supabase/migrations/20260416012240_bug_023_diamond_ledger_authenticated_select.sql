-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260416012240 "bug_023_diamond_ledger_authenticated_select"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 bb48a69bab200b4a892012b00e74cfb7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG 023 — diamond_ledger had RLS enabled but no authenticated SELECT policy.
-- VIPPage.tsx queries .from('diamond_ledger').eq('user_id', user.id) and always got [].
-- Same pattern as BUG 021 Layer C (hand_history). Fix: per-user SELECT policy.

DROP POLICY IF EXISTS "diamond_ledger_authenticated_own_select" ON public.diamond_ledger;
CREATE POLICY "diamond_ledger_authenticated_own_select" ON public.diamond_ledger
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

ALTER TABLE public.diamond_ledger ENABLE ROW LEVEL SECURITY;
