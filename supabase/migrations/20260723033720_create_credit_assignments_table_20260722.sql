-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260723033720 "create_credit_assignments_table_20260722"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 52df71dd625d0c2a2029c64a9c2fd94f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- P0: fn_admin_update_agent INSERTs a credit_assignments audit row on every credit-limit
-- change, but the table never existed — so ANY credit-limit change threw
-- "relation credit_assignments does not exist" and rolled back the whole update. This
-- creates the audit table the RPC expects. Writes come only from the SECURITY DEFINER
-- RPC (which bypasses RLS); reads are allowed for the agent and their club's owners/admins.
CREATE TABLE IF NOT EXISTS public.credit_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  assigned_by uuid,
  old_limit numeric,
  new_limit numeric,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_assignments_agent ON public.credit_assignments (agent_id, created_at DESC);

ALTER TABLE public.credit_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS credit_assignments_svc ON public.credit_assignments;
CREATE POLICY credit_assignments_svc ON public.credit_assignments
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS credit_assignments_read ON public.credit_assignments;
CREATE POLICY credit_assignments_read ON public.credit_assignments FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.agents a WHERE a.id = credit_assignments.agent_id AND (
      a.user_id = (SELECT auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.clubs c WHERE c.id = a.club_id AND (
          c.owner_id = (SELECT auth.uid())
          OR EXISTS (SELECT 1 FROM public.club_members cm
                     WHERE cm.club_id = a.club_id AND cm.user_id = (SELECT auth.uid())
                       AND cm.role IN ('owner','co_owner','admin'))
        )
      )
    )
  )
);
