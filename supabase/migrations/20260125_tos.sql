-- ══════════════════════════════════════════════════════════════════════════════
-- TOS ACCEPTANCE
-- Tracks when users accepted Club Arena terms of service
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS 
    club_arena_tos_accepted_at TIMESTAMPTZ;

-- Index for TOS checks
CREATE INDEX IF NOT EXISTS idx_profiles_club_arena_tos 
    ON profiles(club_arena_tos_accepted_at) 
    WHERE club_arena_tos_accepted_at IS NOT NULL;
