-- ════════════════════════════════════════════════════════════════════════════════
--  Migration: Missing tables for Admin, Agent, Union & Player dashboards
--  Created: 2026-03-13 — Phase 5 consolidation audit
-- ════════════════════════════════════════════════════════════════════════════════

-- ── agent_commissions ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_commissions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount numeric DEFAULT 0,
  commission_rate numeric DEFAULT 0.1,
  source_type text DEFAULT 'rake',
  source_id uuid,
  notes text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_commissions_club ON public.agent_commissions(club_id);
CREATE INDEX IF NOT EXISTS idx_agent_commissions_user ON public.agent_commissions(user_id);
ALTER TABLE public.agent_commissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agent_commissions_select" ON public.agent_commissions FOR SELECT USING (true);
CREATE POLICY "agent_commissions_insert" ON public.agent_commissions FOR INSERT WITH CHECK (true);

-- ── audit_logs ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  club_id uuid REFERENCES public.clubs(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text,
  target_id uuid,
  details jsonb DEFAULT '{}',
  ip_address text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_club ON public.audit_logs(club_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON public.audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON public.audit_logs(created_at DESC);
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_logs_select" ON public.audit_logs FOR SELECT USING (true);
CREATE POLICY "audit_logs_insert" ON public.audit_logs FOR INSERT WITH CHECK (true);

-- ── player_sessions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.player_sessions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  table_id uuid REFERENCES public.tables(id) ON DELETE SET NULL,
  buy_in numeric DEFAULT 0,
  cash_out numeric DEFAULT 0,
  profit numeric DEFAULT 0,
  hands_played integer DEFAULT 0,
  duration_minutes integer DEFAULT 0,
  started_at timestamptz DEFAULT now(),
  ended_at timestamptz,
  status text DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_player_sessions_club ON public.player_sessions(club_id);
CREATE INDEX IF NOT EXISTS idx_player_sessions_user ON public.player_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_player_sessions_started ON public.player_sessions(started_at DESC);
ALTER TABLE public.player_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "player_sessions_select" ON public.player_sessions FOR SELECT USING (true);
CREATE POLICY "player_sessions_insert" ON public.player_sessions FOR INSERT WITH CHECK (true);

-- ── union_announcements ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.union_announcements (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  union_id uuid NOT NULL REFERENCES public.unions(id) ON DELETE CASCADE,
  club_id uuid REFERENCES public.clubs(id) ON DELETE SET NULL,
  message text NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_union_announcements_union ON public.union_announcements(union_id);
ALTER TABLE public.union_announcements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "union_announcements_select" ON public.union_announcements FOR SELECT USING (true);
CREATE POLICY "union_announcements_insert" ON public.union_announcements FOR INSERT WITH CHECK (true);

-- ── union_applications ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.union_applications (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  union_id uuid NOT NULL REFERENCES public.unions(id) ON DELETE CASCADE,
  club_id uuid REFERENCES public.clubs(id) ON DELETE SET NULL,
  applicant_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  club_name text,
  status text DEFAULT 'pending',
  notes text,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_union_applications_union ON public.union_applications(union_id);
CREATE INDEX IF NOT EXISTS idx_union_applications_status ON public.union_applications(status);
ALTER TABLE public.union_applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "union_applications_select" ON public.union_applications FOR SELECT USING (true);
CREATE POLICY "union_applications_insert" ON public.union_applications FOR INSERT WITH CHECK (true);
CREATE POLICY "union_applications_update" ON public.union_applications FOR UPDATE USING (true);

-- ── union_leave_requests ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.union_leave_requests (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  union_id uuid NOT NULL REFERENCES public.unions(id) ON DELETE CASCADE,
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason text,
  status text DEFAULT 'pending',
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_union_leave_requests_union ON public.union_leave_requests(union_id);
ALTER TABLE public.union_leave_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "union_leave_requests_select" ON public.union_leave_requests FOR SELECT USING (true);
CREATE POLICY "union_leave_requests_insert" ON public.union_leave_requests FOR INSERT WITH CHECK (true);
CREATE POLICY "union_leave_requests_update" ON public.union_leave_requests FOR UPDATE USING (true);

-- ── union_transactions ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.union_transactions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  union_id uuid NOT NULL REFERENCES public.unions(id) ON DELETE CASCADE,
  club_id uuid REFERENCES public.clubs(id) ON DELETE SET NULL,
  type text NOT NULL,
  amount numeric DEFAULT 0,
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_union_transactions_union ON public.union_transactions(union_id);
CREATE INDEX IF NOT EXISTS idx_union_transactions_club ON public.union_transactions(club_id);
ALTER TABLE public.union_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "union_transactions_select" ON public.union_transactions FOR SELECT USING (true);
CREATE POLICY "union_transactions_insert" ON public.union_transactions FOR INSERT WITH CHECK (true);

-- ── union_wallets ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.union_wallets (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  union_id uuid NOT NULL REFERENCES public.unions(id) ON DELETE CASCADE UNIQUE,
  chip_balance numeric DEFAULT 0,
  rake_wallet numeric DEFAULT 0,
  bbj_wallet numeric DEFAULT 0,
  promo_wallet numeric DEFAULT 0,
  insurance_wallet numeric DEFAULT 0,
  total_rake_collected numeric DEFAULT 0,
  total_settlements numeric DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_union_wallets_union ON public.union_wallets(union_id);
ALTER TABLE public.union_wallets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "union_wallets_select" ON public.union_wallets FOR SELECT USING (true);
CREATE POLICY "union_wallets_update" ON public.union_wallets FOR UPDATE USING (true);

-- ════════════════════════════════════════════════════════════════════════════════
--  Enable Supabase Realtime for tables used with postgres_changes
-- ════════════════════════════════════════════════════════════════════════════════
ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_commissions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.audit_logs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.player_sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.union_announcements;
ALTER PUBLICATION supabase_realtime ADD TABLE public.union_applications;
ALTER PUBLICATION supabase_realtime ADD TABLE public.union_leave_requests;
ALTER PUBLICATION supabase_realtime ADD TABLE public.union_transactions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.union_wallets;
