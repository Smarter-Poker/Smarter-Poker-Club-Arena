-- ═══════════════════════════════════════════════════════════════════════════════
--  USER NOTIFICATION PREFERENCES TABLE
--  Tracks per-user push notification opt-in/out by category
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    table_alerts BOOLEAN NOT NULL DEFAULT true,
    tournament_reminders BOOLEAN NOT NULL DEFAULT true,
    achievement_alerts BOOLEAN NOT NULL DEFAULT true,
    friend_alerts BOOLEAN NOT NULL DEFAULT true,
    club_announcements BOOLEAN NOT NULL DEFAULT true,
    settlement_alerts BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE user_notification_preferences ENABLE ROW LEVEL SECURITY;

-- Users can read/update their own preferences
CREATE POLICY "Users can read own notification preferences"
    ON user_notification_preferences FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own notification preferences"
    ON user_notification_preferences FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own notification preferences"
    ON user_notification_preferences FOR UPDATE
    USING (auth.uid() = user_id);

-- Service role can read all (for filtering push sends)
CREATE POLICY "Service role can read all notification preferences"
    ON user_notification_preferences FOR SELECT
    USING (auth.role() = 'service_role');

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_notification_prefs_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_notification_prefs_updated_at
    BEFORE UPDATE ON user_notification_preferences
    FOR EACH ROW
    EXECUTE FUNCTION update_notification_prefs_timestamp();
