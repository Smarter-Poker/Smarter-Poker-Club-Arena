-- ═══════════════════════════════════════════════════════════════════════════════
--  RATE LIMIT RPC — Server-side rate limiting for critical operations
-- ═══════════════════════════════════════════════════════════════════════════════

-- Rate limits table for server-side enforcement
CREATE TABLE IF NOT EXISTS rate_limits (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES auth.users(id),
    action      TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_user_action ON rate_limits(user_id, action, created_at DESC);

-- Auto-cleanup: delete entries older than 10 minutes
-- (Can be called by cron or triggered periodically)
CREATE OR REPLACE FUNCTION cleanup_rate_limits()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    DELETE FROM rate_limits WHERE created_at < NOW() - INTERVAL '10 minutes';
END;
$$;

-- Server-side rate limit check RPC
-- Returns TRUE if allowed, FALSE if rate limited
CREATE OR REPLACE FUNCTION check_rate_limit(
    p_user_id UUID,
    p_action TEXT,
    p_max_per_minute INTEGER DEFAULT 5
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    -- Count requests in last minute
    SELECT COUNT(*) INTO v_count
    FROM rate_limits
    WHERE user_id = p_user_id
      AND action = p_action
      AND created_at > NOW() - INTERVAL '1 minute';

    -- If over limit, deny
    IF v_count >= p_max_per_minute THEN
        RETURN FALSE;
    END IF;

    -- Record this request
    INSERT INTO rate_limits (user_id, action)
    VALUES (p_user_id, p_action);

    RETURN TRUE;
END;
$$;

-- RLS
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can see own rate limits"
    ON rate_limits FOR SELECT
    USING (user_id = auth.uid());

CREATE POLICY "Service can insert rate limit entries"
    ON rate_limits FOR INSERT
    WITH CHECK (TRUE);
