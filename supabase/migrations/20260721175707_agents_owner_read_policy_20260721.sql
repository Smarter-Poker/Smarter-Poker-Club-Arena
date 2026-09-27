-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721175707 "agents_owner_read_policy_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 38f6fdaf1a12b7e6b5d0c674ab55ee47 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The only browser SELECT policy on agents was "own row" (auth.uid()=user_id),
-- so a club owner/admin could not read (hence not list or manage) their club's
-- agents at all — getAgents/getAgent returned nothing for them. Add a scoped
-- SELECT policy: a club owner (clubs.owner_id) or a club_members owner/co_owner
-- /admin may read the agents of THAT club. Regular members/agents still only see
-- their own row (peer financials stay private).
DROP POLICY IF EXISTS agents_club_owner_read ON public.agents;
CREATE POLICY agents_club_owner_read ON public.agents
  FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM clubs c
      WHERE c.id = agents.club_id
        AND (
          c.owner_id = (SELECT auth.uid())
          OR EXISTS (
            SELECT 1 FROM club_members cm
            WHERE cm.club_id = agents.club_id
              AND cm.user_id = (SELECT auth.uid())
              AND cm.role IN ('owner', 'co_owner', 'admin')
          )
        )
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='agents' AND policyname='agents_club_owner_read') THEN
    RAISE EXCEPTION 'agents_club_owner_read policy not created';
  END IF;
END $$;
