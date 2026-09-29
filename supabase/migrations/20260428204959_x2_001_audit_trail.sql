-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260428204959 as "x2_001_audit_trail"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
CREATE TABLE IF NOT EXISTS public.audit_trail (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK (actor_role IN
    ('owner','co_owner','host','agent','sub_agent','union_admin','platform_admin','system')),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID,
  club_id     UUID REFERENCES public.clubs(id) ON DELETE SET NULL,
  agent_id    UUID,
  amount      NUMERIC(20,4),
  currency    TEXT DEFAULT 'CHIPS',
  before_state JSONB,
  after_state  JSONB,
  reason TEXT,
  ip_address INET,
  user_agent TEXT,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_trail_actor       ON public.audit_trail (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_trail_target      ON public.audit_trail (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_trail_club_action ON public.audit_trail (club_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_trail_created     ON public.audit_trail (created_at DESC);

ALTER TABLE public.audit_trail ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role full access" ON public.audit_trail;
CREATE POLICY "service_role full access"
  ON public.audit_trail FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "club owners read own club rows" ON public.audit_trail;
CREATE POLICY "club owners read own club rows"
  ON public.audit_trail FOR SELECT TO authenticated
  USING (
    club_id IN (SELECT id FROM public.clubs c WHERE c.owner_id = auth.uid())
  );

COMMENT ON TABLE public.audit_trail IS
  'Append-only privileged-action log. Closes P0-G1/F1/F2.';
