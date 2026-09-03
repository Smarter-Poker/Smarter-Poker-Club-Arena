-- ═══════════════════════════════════════════════════════════════════════════════
-- 🎯 THROWABLES — Usage Tracking
-- ═══════════════════════════════════════════════════════════════════════════════
-- VIP: 500 free throws per month, then 2 Diamonds each
-- Non-VIP: 2 Diamonds per throw

-- Track throwable usage for VIP allowance
CREATE TABLE IF NOT EXISTS throw_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    throwable_id TEXT NOT NULL,
    paid_diamonds BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for monthly usage queries
CREATE INDEX IF NOT EXISTS idx_throw_usage_user_month 
ON throw_usage (user_id, created_at);

-- RLS policies
ALTER TABLE throw_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own throw usage"
ON throw_usage FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can record own throws"
ON throw_usage FOR INSERT
WITH CHECK (auth.uid() = user_id);
