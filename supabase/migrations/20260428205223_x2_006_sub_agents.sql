-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260428205223 as "x2_006_sub_agents"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
CREATE TABLE IF NOT EXISTS public.sub_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  parent_agent_id UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  club_id         UUID NOT NULL REFERENCES public.clubs(id)  ON DELETE CASCADE,
  commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0
    CHECK (commission_pct BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','deleted')),
  suspended_reason TEXT,
  suspended_at TIMESTAMPTZ,
  total_players_recruited INT NOT NULL DEFAULT 0,
  total_rake_generated   NUMERIC(20,4) NOT NULL DEFAULT 0,
  total_commission_paid  NUMERIC(20,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sub_agents_parent ON public.sub_agents (parent_agent_id);
CREATE INDEX IF NOT EXISTS idx_sub_agents_club_status ON public.sub_agents (club_id, status);

CREATE OR REPLACE FUNCTION public.touch_sub_agents()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_sub_agents_updated ON public.sub_agents;
CREATE TRIGGER trg_sub_agents_updated
  BEFORE UPDATE ON public.sub_agents
  FOR EACH ROW EXECUTE FUNCTION public.touch_sub_agents();

ALTER TABLE public.sub_agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role full access" ON public.sub_agents;
CREATE POLICY "service_role full access"
  ON public.sub_agents FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "agents read own sub_agents" ON public.sub_agents;
CREATE POLICY "agents read own sub_agents"
  ON public.sub_agents FOR SELECT TO authenticated
  USING (
    parent_agent_id IN (SELECT id FROM public.agents a WHERE a.user_id = auth.uid())
    OR user_id = auth.uid()
  );

CREATE TABLE IF NOT EXISTS public.player_agent_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  club_id   UUID NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  agent_id     UUID REFERENCES public.agents(id)     ON DELETE SET NULL,
  sub_agent_id UUID REFERENCES public.sub_agents(id) ON DELETE SET NULL,
  CONSTRAINT player_assigned_exactly_one CHECK (
    (agent_id IS NOT NULL AND sub_agent_id IS NULL)
    OR (agent_id IS NULL AND sub_agent_id IS NOT NULL)
  ),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (player_id, club_id)
);

CREATE INDEX IF NOT EXISTS idx_player_agent_assignments_agent     ON public.player_agent_assignments (agent_id);
CREATE INDEX IF NOT EXISTS idx_player_agent_assignments_sub_agent ON public.player_agent_assignments (sub_agent_id);
CREATE INDEX IF NOT EXISTS idx_player_agent_assignments_club      ON public.player_agent_assignments (club_id);

ALTER TABLE public.player_agent_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role full access" ON public.player_agent_assignments;
CREATE POLICY "service_role full access"
  ON public.player_agent_assignments FOR ALL TO service_role
  USING (true) WITH CHECK (true);
