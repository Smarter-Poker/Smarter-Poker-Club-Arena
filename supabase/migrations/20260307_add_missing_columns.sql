-- =============================================
-- Add missing columns found during audit
-- DEPLOYED TO SUPABASE: 2026-03-07
-- =============================================

-- 1. profiles.is_online — used by ClubMembersPage, FriendsPage, PresenceIndicator, MessagingService
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_online BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ;

-- 2. profiles.is_vip — used by ThrowableService, VIPService
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_vip BOOLEAN NOT NULL DEFAULT false;

-- 3. profiles.diamonds — used by ThrowableService, VIPService, DiamondTopUpModal
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS diamonds INTEGER NOT NULL DEFAULT 0;

-- 4. agents.pending_commission — used by fn_request_agent_payout RPC
ALTER TABLE agents ADD COLUMN IF NOT EXISTS pending_commission DECIMAL(15,2) NOT NULL DEFAULT 0;

-- 5. Index for presence lookups
CREATE INDEX IF NOT EXISTS idx_profiles_is_online ON profiles(is_online) WHERE is_online = true;

-- 6. throw_usage table — used by ThrowableService for VIP monthly tracking
CREATE TABLE IF NOT EXISTS throw_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  throwable_id TEXT NOT NULL,
  paid_diamonds BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_throw_usage_user_month ON throw_usage(user_id, created_at);
