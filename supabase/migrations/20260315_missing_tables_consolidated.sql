-- ═══════════════════════════════════════════════════════════════════════════════
-- CONSOLIDATED: Create missing tables discovered during E2E audit
-- Tables: commission_rate_audit, rake_rate_audit, time_bank
-- Safe to re-run (uses IF NOT EXISTS throughout)
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. commission_rate_audit
-- Used by: RateAuditPage.tsx, FinancialCronService
CREATE TABLE IF NOT EXISTS commission_rate_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES profiles(id),
  changed_by UUID REFERENCES profiles(id),
  old_rate DECIMAL(5,2),
  new_rate DECIMAL(5,2),
  rate_type TEXT NOT NULL DEFAULT 'agent_commission',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commission_rate_audit_agent ON commission_rate_audit(agent_id);
CREATE INDEX IF NOT EXISTS idx_commission_rate_audit_created ON commission_rate_audit(created_at DESC);
ALTER TABLE commission_rate_audit ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Admins can view commission rate changes"
    ON commission_rate_audit FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. rake_rate_audit
-- Used by: RateAuditPage.tsx, RakeService
CREATE TABLE IF NOT EXISTS rake_rate_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID REFERENCES clubs(id),
  changed_by UUID REFERENCES profiles(id),
  old_rate DECIMAL(5,2),
  new_rate DECIMAL(5,2),
  rate_type TEXT NOT NULL DEFAULT 'club_rake',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rake_rate_audit_club ON rake_rate_audit(club_id);
CREATE INDEX IF NOT EXISTS idx_rake_rate_audit_created ON rake_rate_audit(created_at DESC);
ALTER TABLE rake_rate_audit ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Club admins can view rake rate changes"
    ON rake_rate_audit FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. time_bank
-- Used by: TimeBankService, TablePage time bank UI
CREATE TABLE IF NOT EXISTS time_bank (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id),
  table_id UUID,
  seconds_remaining INTEGER NOT NULL DEFAULT 30,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_time_bank_user ON time_bank(user_id);
CREATE INDEX IF NOT EXISTS idx_time_bank_table_user ON time_bank(table_id, user_id);
ALTER TABLE time_bank ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Users can manage own time bank"
    ON time_bank FOR ALL USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4. Add tables to Realtime publication
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'commission_rate_audit'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE commission_rate_audit;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'rake_rate_audit'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE rake_rate_audit;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'time_bank'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE time_bank;
  END IF;
END $$;
