-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX BUGs #40-42: Deploy missing tables and columns found during live DB audit
-- ═══════════════════════════════════════════════════════════════════════════════

-- BUG #40: agent_commissions table missing from live DB
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

-- BUG #41: disputes table missing from live DB
CREATE TABLE IF NOT EXISTS disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    submitted_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    submitter_name TEXT NOT NULL DEFAULT 'Unknown',
    target_type TEXT NOT NULL CHECK (target_type IN (
        'agent_settlement', 'cashout_request', 'credit_invoice', 'commission_payout'
    )),
    target_id TEXT NOT NULL,
    club_id UUID NOT NULL,
    amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
        'open', 'under_review', 'resolved', 'escalated', 'withdrawn'
    )),
    assigned_to UUID REFERENCES auth.users(id),
    resolution TEXT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_disputes_club ON disputes(club_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "disputes_select" ON disputes FOR SELECT USING (true);
CREATE POLICY "disputes_insert" ON disputes FOR INSERT WITH CHECK (true);

-- BUG #40b: union_wallets table missing from live DB
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

-- BUG #40c: union_announcements table missing from live DB
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

-- BUG #42: clubs.active_tables column missing
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS active_tables INTEGER DEFAULT 0;
