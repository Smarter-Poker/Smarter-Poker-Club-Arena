-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828013323; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

DROP POLICY IF EXISTS "Users can view own hand audit decisions"
  ON public.hand_audit_decisions;
CREATE POLICY "Users can view own hand audit decisions"
  ON public.hand_audit_decisions FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Service role manages hand audit decisions"
  ON public.hand_audit_decisions;
CREATE POLICY "Service role manages hand audit decisions"
  ON public.hand_audit_decisions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
