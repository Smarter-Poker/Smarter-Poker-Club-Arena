-- ═══════════════════════════════════════════════════════════════════════════════
-- Walkthrough Round 11 — 5 missing tables that frontend services
-- .insert() / .select() into but never existed in production.
--
-- Found by greppping every supabase.from('<name>')... call in club-arena/src/
-- (services + pages) and joining against information_schema.tables.
--
--   rake_attributions       — settlement chain: per-hand player rake breakdown
--   rake_rate_audit         — audit trail for club rake-rate changes
--   commission_rate_audit   — audit trail for agent commission-rate changes
--   tournament_waitlists    — tournament join queue (insert/select/delete from FE)
--   hand_actions            — per-action log inside a hand for replay UI
--
-- Without these the relevant code paths silently throw / 404, breaking
-- settlement audit trail + tournament waitlist join + hand history replay.
--
-- Applied to production via Supabase MCP migration
-- x13_create_5_missing_tables_2026_04_29.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── rake_attributions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rake_attributions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  hand_id     uuid        NOT NULL REFERENCES public.hand_history(id) ON DELETE CASCADE,
  player_id   uuid        NOT NULL REFERENCES public.users(id)        ON DELETE CASCADE,
  rake_amount numeric     NOT NULL CHECK (rake_amount >= 0),
  agent_id    uuid        REFERENCES public.agents(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rake_attributions_hand_id   ON public.rake_attributions (hand_id);
CREATE INDEX IF NOT EXISTS idx_rake_attributions_player_id ON public.rake_attributions (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rake_attributions_agent_id  ON public.rake_attributions (agent_id) WHERE agent_id IS NOT NULL;
ALTER TABLE public.rake_attributions ENABLE ROW LEVEL SECURITY;
CREATE POLICY rake_attributions_service_role_all ON public.rake_attributions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY rake_attributions_player_self_read ON public.rake_attributions
  FOR SELECT TO authenticated USING (player_id = (SELECT auth.uid()));

-- ─── rake_rate_audit ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rake_rate_audit (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id    uuid        NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  changed_by uuid        NOT NULL REFERENCES public.users(id),
  old_rate   numeric     NOT NULL,
  new_rate   numeric     NOT NULL,
  rate_type  text        NOT NULL CHECK (rate_type IN ('rake_pct','rake_cap','bbj_pct','promo_pct','vip_pct','agent_default','platform_default')),
  notes      text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rake_rate_audit_club_id ON public.rake_rate_audit (club_id, created_at DESC);
ALTER TABLE public.rake_rate_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY rake_rate_audit_service_role_all ON public.rake_rate_audit
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY rake_rate_audit_club_admin_read ON public.rake_rate_audit
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.club_members cm
             WHERE cm.club_id = rake_rate_audit.club_id
               AND cm.user_id = (SELECT auth.uid())
               AND cm.role IN ('owner','admin'))
  );

-- ─── commission_rate_audit ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.commission_rate_audit (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  changed_by uuid        NOT NULL REFERENCES public.users(id),
  old_rate   numeric     NOT NULL,
  new_rate   numeric     NOT NULL,
  rate_type  text        NOT NULL CHECK (rate_type IN ('rakeback','commission','sub_agent_split','bonus_pct')),
  club_id    uuid        REFERENCES public.clubs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_commission_rate_audit_agent_id ON public.commission_rate_audit (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commission_rate_audit_club_id  ON public.commission_rate_audit (club_id) WHERE club_id IS NOT NULL;
ALTER TABLE public.commission_rate_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY commission_rate_audit_service_role_all ON public.commission_rate_audit
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── tournament_waitlists ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tournament_waitlists (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid        NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES public.users(id)       ON DELETE CASCADE,
  position      integer     NOT NULL CHECK (position > 0),
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT tournament_waitlists_unique_user UNIQUE (tournament_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_tournament_waitlists_tournament_id ON public.tournament_waitlists (tournament_id, position);
CREATE INDEX IF NOT EXISTS idx_tournament_waitlists_user_id       ON public.tournament_waitlists (user_id);
ALTER TABLE public.tournament_waitlists ENABLE ROW LEVEL SECURITY;
CREATE POLICY tournament_waitlists_service_role_all ON public.tournament_waitlists
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY tournament_waitlists_self_read ON public.tournament_waitlists
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY tournament_waitlists_self_insert ON public.tournament_waitlists
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY tournament_waitlists_self_delete ON public.tournament_waitlists
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

-- ─── hand_actions ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.hand_actions (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  hand_id    uuid        NOT NULL REFERENCES public.hand_history(id) ON DELETE CASCADE,
  player_id  uuid        NOT NULL REFERENCES public.users(id)        ON DELETE CASCADE,
  action     text        NOT NULL CHECK (action IN ('fold','check','call','bet','raise','all_in','sit_out','sit_in','post_sb','post_bb','post_ante','post_straddle','post_bb_to_enter','timeout','disconnect')),
  amount     numeric     CHECK (amount IS NULL OR amount >= 0),
  street     text        NOT NULL CHECK (street IN ('preflop','flop','turn','river','showdown','runout')),
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hand_actions_hand_id   ON public.hand_actions (hand_id, created_at);
CREATE INDEX IF NOT EXISTS idx_hand_actions_player_id ON public.hand_actions (player_id, created_at DESC);
ALTER TABLE public.hand_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY hand_actions_service_role_all ON public.hand_actions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY hand_actions_self_read ON public.hand_actions
  FOR SELECT TO authenticated USING (
    player_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.hand_players hp
       WHERE hp.hand_id = hand_actions.hand_id
         AND hp.user_id = (SELECT auth.uid())
    )
  );

-- ─── grants ────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rake_attributions     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rake_rate_audit       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commission_rate_audit TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tournament_waitlists  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hand_actions          TO service_role;
