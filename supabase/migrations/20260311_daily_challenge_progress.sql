-- ═══════════════════════════════════════════════════════════════════════════════
-- Daily Challenge Progress — Supabase Migration
-- Enhancement #8: Cross-device daily challenge progress sync
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS daily_challenge_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    day_key TEXT NOT NULL,           -- e.g. 'challenges_20260311'
    challenge_index SMALLINT NOT NULL, -- 0, 1, or 2
    progress INT NOT NULL DEFAULT 0,
    completed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, day_key, challenge_index)
);

-- Index for fast user+day lookups
CREATE INDEX IF NOT EXISTS idx_dcp_user_day ON daily_challenge_progress(user_id, day_key);

-- RLS: users can only see/edit their own progress
ALTER TABLE daily_challenge_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own challenge progress"
    ON daily_challenge_progress FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users insert own challenge progress"
    ON daily_challenge_progress FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own challenge progress"
    ON daily_challenge_progress FOR UPDATE
    USING (auth.uid() = user_id);

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION update_dcp_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_dcp_updated_at
    BEFORE UPDATE ON daily_challenge_progress
    FOR EACH ROW
    EXECUTE FUNCTION update_dcp_updated_at();
